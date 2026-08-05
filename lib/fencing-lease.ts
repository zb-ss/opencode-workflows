import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'

const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 5
const LOCK_RETRY_LIMIT = 2000
const LOCK_RELEASE_RETRY_LIMIT = 3

export interface FencingLeaseRecord {
  lease_id: string
  fencing_generation: number
  owner: string
  acquired_at: string
  expires_at: string
  renewal_count: number
}

export interface FencingLeaseOptions {
  lease_directory: string
  owner: string
  lease_duration_ms: number
  now: () => number
  /**
   * Optional shared lock directory. When provided, all lease operations
   * (acquire, renew, release, assertAuthority) serialize through the
   * cross-process lock at this directory's .fencing-lock path instead of
   * the lease directory's. This allows the lease and a co-located store
   * (e.g. QueueStore) to share one lock so that a stale scheduler cannot
   * commit a queue record after a newer generation takes over.
   *
   * If omitted, the lease directory's own .fencing-lock is used (legacy
   * behavior).
   */
  lock_directory?: string
}

export interface FencingLeaseHandle {
  lease: FencingLeaseRecord
  renew(extend_ms?: number): FencingLeaseRecord
  release(): void
  is_valid(): boolean
}

export class FencingLeaseError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FencingLeaseError'
    this.code = code
  }
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString()
}

function leasePath(directory: string): string {
  return path.join(directory, 'fencing-lease.json')
}

function lockDirectoryPath(directory: string): string {
  return path.join(directory, '.fencing-lock')
}

function stagingDirectoryPath(directory: string): string {
  return path.join(directory, '.fencing-staging')
}

function ensureStagingDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = fs.lstatSync(directory)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new FencingLeaseError('lock_corrupt', 'lock staging path is not a trusted directory')
  }
  fs.chmodSync(directory, DIR_MODE)
}

function lockTokenPath(lockDirectory: string): string {
  return path.join(lockDirectory, 'holder.token')
}

function takeoverTokenPath(lockDirectory: string): string {
  return path.join(lockDirectory, 'takeover.token')
}

interface LockToken {
  pid: number
  nonce: string
  start_time: number | null
}

function isLeaseRecord(value: unknown): value is FencingLeaseRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.lease_id === 'string' && r.lease_id.length > 0
    && typeof r.fencing_generation === 'number' && Number.isInteger(r.fencing_generation) && r.fencing_generation > 0
    && typeof r.owner === 'string'
    && typeof r.acquired_at === 'string'
    && typeof r.expires_at === 'string'
    && typeof r.renewal_count === 'number' && Number.isInteger(r.renewal_count) && r.renewal_count >= 0
}

function readLeaseFile(directory: string): FencingLeaseRecord {
  const leaseFile = leasePath(directory)
  let content: string
  try {
    content = fs.readFileSync(leaseFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null as unknown as FencingLeaseRecord
    throw new FencingLeaseError('lease_corrupt', `lease file is unreadable: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new FencingLeaseError('lease_corrupt', 'lease file contains invalid JSON')
  }
  if (!isLeaseRecord(parsed)) {
    throw new FencingLeaseError('lease_corrupt', 'lease file does not match the expected schema')
  }
  return parsed
}

function leaseExists(directory: string): boolean {
  try {
    fs.accessSync(leasePath(directory))
    return true
  } catch {
    return false
  }
}

function createLeaseFile(directory: string, record: FencingLeaseRecord): void {
  const leaseFile = leasePath(directory)
  let fd: number | null = null
  try {
    fd = fs.openSync(leaseFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fsyncDirectory(directory)
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FencingLeaseError('lease_held', 'a lease file already exists')
    }
    throw error
  }
}

function replaceLeaseFile(directory: string, record: FencingLeaseRecord): void {
  const leaseFile = leasePath(directory)
  const temp = `${leaseFile}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(temp, leaseFile)
    fsyncDirectory(directory)
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | O_NOFOLLOW)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

function isExpired(record: FencingLeaseRecord, now: () => number): boolean {
  return now() >= Date.parse(record.expires_at)
}

function processStartTime(): number | null {
  // Return a stable per-process-incarnation identifier from /proc/self/stat.
  // Field 22 (starttime) is the number of jiffies since system boot when the
  // process started. It is stable for the lifetime of a process and changes
  // when a PID is reused, which is exactly the property we need to detect
  // stale lock ownership without falsely declaring a live process dead.
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(' ')
    const starttimeJiffies = Number.parseInt(fields[19] ?? '', 10)
    if (!Number.isFinite(starttimeJiffies) || starttimeJiffies < 0) return null
    return starttimeJiffies
  } catch {
    return null
  }
}

function isProcessAlive(pid: number, startTime: number | null): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // If we cannot read /proc (non-Linux platforms), fall back to signal-only
  // liveness. This accepts a small PID-reuse risk on those platforms.
  if (startTime === null || pid <= 0) return true
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return false
    const fields = stat.slice(close + 2).split(' ')
    // man proc: field 22 (starttime) is the 20th field after comm (0-indexed [19]).
    const starttimeJiffies = Number.parseInt(fields[19] ?? '', 10)
    if (!Number.isFinite(starttimeJiffies)) return false
    // Compare raw jiffies directly — no wall-clock conversion needed.
    return starttimeJiffies === startTime
  } catch {
    // Unable to verify start time; fall back to signal-only liveness.
    return true
  }
}

function readTokenFile(tokenFile: string): LockToken | null {
  let content: string
  try {
    content = fs.readFileSync(tokenFile, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const pid = Number(record.pid)
    const nonce = String(record.nonce ?? '')
    const start_time = record.start_time === null || record.start_time === undefined ? null : Number(record.start_time)
    if (!Number.isInteger(pid) || pid <= 0 || nonce.length === 0) return null
    return { pid, nonce, start_time: Number.isFinite(start_time) ? start_time : null }
  } catch {
    return null
  }
}

function readLockToken(lockDirectory: string): LockToken | null {
  return readTokenFile(lockTokenPath(lockDirectory))
}

/**
 * Evaluate whether a canonical lock directory is safe to take over.
 *
 * Returns:
 * - 'stale' if the recorded owner is provably dead and the caller may try
 *   to quarantine and replace the lock.
 * - 'contended' if the lock is held by a live owner; the caller should
 *   keep retrying.
 * - 'corrupt' if the lock directory is in an unrecoverable state
 *   (tokenless, unreadable, or not a directory). The caller must fail
 *   immediately rather than retrying, because no amount of waiting will
 *   fix corruption.
 */
function evaluateLockState(lockDirectory: string): 'stale' | 'contended' | 'corrupt' {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(lockDirectory)
  } catch {
    // No lock present. The caller's rename will win or lose atomically;
    // treat as contended so the caller retries its own rename.
    return 'contended'
  }
  if (!stat.isDirectory()) {
    return 'corrupt'
  }

  const token = readLockToken(lockDirectory)
  if (token === null) {
    return 'corrupt'
  }

  if (isProcessAlive(token.pid, token.start_time)) {
    return 'contended'
  }

  const takeoverFile = takeoverTokenPath(lockDirectory)
  if (fs.existsSync(takeoverFile)) {
    const takeover = readTokenFile(takeoverFile)
    if (takeover === null) return 'corrupt'
    return isProcessAlive(takeover.pid, takeover.start_time) ? 'contended' : 'stale'
  }

  return 'stale'
}

/**
 * Cross-process lock built on atomic directory rename.
 *
 * Protocol:
 *
 * 1. Create a uniquely named private candidate directory.
 * 2. Write holder.token completely into the candidate and fsync it.
 * 3. Atomically rename the candidate onto the canonical .fencing-lock path.
 *    POSIX guarantees rename replaces the target atomically: the canonical
 *    path is either the old lock or our new lock, never empty and never two
 *    directories at once.
 *
 * A canonical lock path therefore always holds a valid token; a tokenless
 * canonical lock is treated as corruption and never auto-removed.
 *
 * Stale takeover:
 * - Prove the recorded owner is dead (isStaleLock).
 * - Atomically rename the canonical lock to a unique quarantine path.
 * - Delete only the quarantine path owned by this takeover attempt.
 * - The canonical lock path is never recursively rmSync'd directly.
 *
 * Release:
 * - Verify the exact nonce and inode identity.
 * - Atomically rename the canonical lock to a unique release path.
 * - Delete only that release path.
 * - Never remove a lock that no longer matches the holder.
 */
class CrossProcessLock {
  private readonly lockDirectory: string
  private readonly stagingDirectory: string
  private nonce: string | null = null
  private heldInode: { dev: number; ino: number } | null = null

  constructor(directory: string) {
    this.lockDirectory = lockDirectoryPath(directory)
    this.stagingDirectory = stagingDirectoryPath(directory)
  }

  get key(): string {
    return this.lockDirectory
  }

  acquire(): void {
    if (this.nonce !== null) return
    ensureStagingDirectory(this.stagingDirectory)
    fsyncDirectory(path.dirname(this.stagingDirectory))
    const deadline = Date.now() + LOCK_STALE_MS
    let attempts = 0
    while (attempts < LOCK_RETRY_LIMIT) {
      try {
        this.tryAcquireOnce()
        return
      } catch (error) {
        if (!(error instanceof FencingLeaseError) || (error.code !== 'lock_contended' && error.code !== 'lock_stale_retry')) {
          throw error
        }
      }
      if (Date.now() > deadline) {
        throw new FencingLeaseError('lock_timeout', `could not acquire the cross-process lock within ${LOCK_STALE_MS}ms`)
      }
      attempts += 1
      const sleepMs = Math.min(LOCK_RETRY_MS * attempts, 50)
      const end = Date.now() + sleepMs
      while (Date.now() < end) { /* busy wait — operations are sub-millisecond */ }
    }
    throw new FencingLeaseError('lock_timeout', `could not acquire the cross-process lock after ${LOCK_RETRY_LIMIT} attempts`)
  }

  private tryAcquireOnce(): void {
    // 0. Evaluate the current state of the canonical lock path. This prevents
    // rename from silently replacing an empty (tokenless) corrupt lock.
    if (fs.existsSync(this.lockDirectory)) {
      const lockState = evaluateLockState(this.lockDirectory)
      if (lockState === 'corrupt') {
        throw new FencingLeaseError('lock_corrupt', 'canonical lock is corrupt; manual intervention required')
      }
      if (lockState === 'contended') {
        throw new FencingLeaseError('lock_contended', 'lock is held by a live owner')
      }
      // lockState === 'stale': quarantine the dead lock, then try to install
      // our candidate below.
      if (lockState === 'stale') {
        this.quarantineStaleLock()
        // After quarantine, the canonical path should be absent; the rename
        // below will install our candidate. If a concurrent winner raced
        // us, the rename will fail with ENOTEMPTY and we'll retry.
      }
    }

    // 1. Build a fully initialized candidate directory with a unique name.
    const candidate = path.join(this.stagingDirectory, `candidate-${process.pid}-${randomUUID()}`)
    fs.mkdirSync(candidate, { recursive: false, mode: DIR_MODE })

    this.nonce = randomUUID()
    const token: LockToken = { pid: process.pid, nonce: this.nonce, start_time: processStartTime() }
    const tokenFile = lockTokenPath(candidate)
    let fd: number | null = null
    let candidateStat: fs.BigIntStats
    try {
      fd = fs.openSync(tokenFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify(token), { encoding: 'utf8' })
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fsyncDirectory(candidate)
      candidateStat = fs.lstatSync(candidate, { bigint: true })
    } catch (error) {
      if (fd !== null) { try { fs.closeSync(fd) } catch {} }
      this.nonce = null
      try { fs.rmSync(candidate, { recursive: true, force: true }) } catch {}
      throw error
    }

    // 2. Attempt atomic rename onto the canonical lock path.
    let installed = false
    try {
      fs.renameSync(candidate, this.lockDirectory)
      installed = true
      this.heldInode = { dev: Number(candidateStat.dev), ino: Number(candidateStat.ino) }
      fsyncDirectory(this.stagingDirectory)
      fsyncDirectory(path.dirname(this.lockDirectory))
    } catch (error) {
      if (installed) {
        // Keep ownership evidence intact. withLock() will release the exact
        // installed directory even though acquisition must fail closed.
        throw error
      }
      // Candidate cleanup is safe before rename: we own its unique path.
      this.nonce = null
      this.heldInode = null
      try { fs.rmSync(candidate, { recursive: true, force: true }) } catch {}
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        // A concurrent winner installed a fresh lock between our state check
        // and our rename. Re-evaluate and either retry or fail.
        const lockState = evaluateLockState(this.lockDirectory)
        if (lockState === 'corrupt') {
          throw new FencingLeaseError('lock_corrupt', 'canonical lock is corrupt; manual intervention required')
        }
        if (lockState === 'stale') {
          this.quarantineStaleLock()
          throw new FencingLeaseError('lock_stale_retry', 'stale lock quarantined; retry acquisition')
        }
        throw new FencingLeaseError('lock_contended', 'lock is held by a live owner')
      }
      if (code === 'ENOENT') {
        // The parent vanished between mkdir and rename; retry will recreate.
        throw new FencingLeaseError('lock_contended', 'staging directory vanished; retry')
      }
      throw error
    }

    // 3. Capture the inode identity of the lock we now own, so release can
    // prove it is removing the exact directory we created and not a later
    // owner's lock that reused the canonical path after we lost authority.
    try {
      const stat = fs.statSync(this.lockDirectory, { bigint: true })
      if (stat.dev !== candidateStat.dev || stat.ino !== candidateStat.ino) {
        throw new FencingLeaseError('lock_corrupt', 'acquired lock identity changed after installation')
      }
    } catch {
      // Ownership evidence remains intact so withLock() can release this exact
      // directory without ever recursively deleting the canonical path.
      throw new FencingLeaseError('lock_corrupt', 'could not stat the acquired lock')
    }
  }

  private abandonDeadTakeoverClaim(expectedStat: fs.BigIntStats, expectedToken: LockToken): void {
    const claimFile = takeoverTokenPath(this.lockDirectory)
    let claimStat: fs.BigIntStats
    let claimToken: LockToken
    try {
      claimStat = fs.lstatSync(claimFile, { bigint: true })
      const parsed = readTokenFile(claimFile)
      if (!claimStat.isFile() || parsed === null || isProcessAlive(parsed.pid, parsed.start_time)) return
      claimToken = parsed

      const currentStat = fs.lstatSync(this.lockDirectory, { bigint: true })
      const currentToken = readLockToken(this.lockDirectory)
      if (currentStat.dev !== expectedStat.dev || currentStat.ino !== expectedStat.ino
        || currentToken?.nonce !== expectedToken.nonce
        || isProcessAlive(currentToken.pid, currentToken.start_time)) return
    } catch {
      return
    }

    const abandoned = path.join(this.stagingDirectory, `abandoned-takeover-${process.pid}-${randomUUID()}`)
    try {
      fs.renameSync(claimFile, abandoned)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const movedStat = fs.lstatSync(abandoned, { bigint: true })
    const movedToken = readTokenFile(abandoned)
    if (movedStat.dev !== claimStat.dev || movedStat.ino !== claimStat.ino || movedToken?.nonce !== claimToken.nonce) {
      throw new FencingLeaseError('lock_corrupt', 'takeover claim identity changed during recovery')
    }
    fsyncDirectory(this.lockDirectory)
    fsyncDirectory(this.stagingDirectory)
    try { fs.unlinkSync(abandoned) } catch {}
  }

  /**
   * Quarantine a provably-stale canonical lock by renaming it to a unique
   * quarantine path owned by this takeover attempt, then deleting only that
   * quarantine path. The canonical lock path is never recursively rmSync'd
   * directly, so a concurrent winner's lock cannot be destroyed by mistake.
   */
  private quarantineStaleLock(): void {
    let expectedStat: fs.BigIntStats
    let expectedToken: LockToken
    try {
      expectedStat = fs.lstatSync(this.lockDirectory, { bigint: true })
      const token = readLockToken(this.lockDirectory)
      if (!expectedStat.isDirectory() || token === null || isProcessAlive(token.pid, token.start_time)) return
      expectedToken = token
    } catch {
      return
    }

    const existingClaim = readTokenFile(takeoverTokenPath(this.lockDirectory))
    if (existingClaim !== null) {
      if (isProcessAlive(existingClaim.pid, existingClaim.start_time)) return
      this.abandonDeadTakeoverClaim(expectedStat, expectedToken)
    }

    const claimFile = takeoverTokenPath(this.lockDirectory)
    const claim: LockToken = { pid: process.pid, nonce: randomUUID(), start_time: processStartTime() }
    let claimFd: number | null = null
    try {
      claimFd = fs.openSync(claimFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
      fs.writeFileSync(claimFd, JSON.stringify(claim), { encoding: 'utf8' })
      fs.fsyncSync(claimFd)
      fs.closeSync(claimFd)
      claimFd = null
      fsyncDirectory(this.lockDirectory)
    } catch (error) {
      if (claimFd !== null) { try { fs.closeSync(claimFd) } catch {} }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOENT') return
      throw error
    }

    const removeOwnClaim = (): void => {
      try {
        const current = fs.lstatSync(this.lockDirectory, { bigint: true })
        if (current.dev !== expectedStat.dev || current.ino !== expectedStat.ino) return
        if (readTokenFile(claimFile)?.nonce === claim.nonce) fs.unlinkSync(claimFile)
      } catch { /* uncertain claims remain fail-closed */ }
    }

    try {
      const currentStat = fs.lstatSync(this.lockDirectory, { bigint: true })
      const currentToken = readLockToken(this.lockDirectory)
      const currentClaim = readTokenFile(claimFile)
      if (currentStat.dev !== expectedStat.dev || currentStat.ino !== expectedStat.ino
        || currentToken?.nonce !== expectedToken.nonce
        || isProcessAlive(currentToken.pid, currentToken.start_time)
        || currentClaim?.nonce !== claim.nonce) {
        removeOwnClaim()
        return
      }
    } catch {
      removeOwnClaim()
      return
    }

    const quarantine = path.join(this.stagingDirectory, `quarantine-${process.pid}-${randomUUID()}`)
    try {
      fs.renameSync(this.lockDirectory, quarantine)
      fsyncDirectory(this.stagingDirectory)
      fsyncDirectory(path.dirname(this.lockDirectory))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Another takeover already removed it; nothing to quarantine.
        return
      }
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        // A concurrent winner renamed a fresh lock into place between our
        // isStaleLock check and this rename. The fresh lock belongs to a live
        // owner; do not touch it.
        return
      }
      throw error
    }
    const quarantinedStat = fs.lstatSync(quarantine, { bigint: true })
    if (quarantinedStat.dev !== expectedStat.dev || quarantinedStat.ino !== expectedStat.ino) {
      throw new FencingLeaseError('lock_corrupt', 'quarantined lock identity changed during stale takeover')
    }
    // Delete only the uniquely named quarantine directory we own.
    try { fs.rmSync(quarantine, { recursive: true, force: true }) } catch {}
  }

  release(): boolean {
    if (this.nonce === null || this.heldInode === null) return true
    const expectedNonce = this.nonce
    const expectedInode = this.heldInode
    const clearOwnership = (): void => {
      this.nonce = null
      this.heldInode = null
    }

    // Verify we still own the exact lock by nonce AND inode identity. If a
    // later owner took over (we timed out, crashed, or lost authority), the
    // canonical path now holds a different directory; we must not remove it.
    let currentStat: fs.Stats | fs.BigIntStats
    try {
      currentStat = fs.statSync(this.lockDirectory, { bigint: true })
    } catch {
      // Already gone — nothing to release.
      clearOwnership()
      return true
    }
    if (Number((currentStat as fs.BigIntStats).dev) !== expectedInode.dev || Number((currentStat as fs.BigIntStats).ino) !== expectedInode.ino) {
      clearOwnership()
      return true
    }
    const token = readLockToken(this.lockDirectory)
    if (token === null || token.nonce !== expectedNonce) {
      clearOwnership()
      return true
    }

    // Atomically rename our lock to a uniquely named release path, then
    // delete only that path. The canonical path is never recursively
    // rmSync'd directly.
    for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_LIMIT; attempt++) {
      const releaseDir = path.join(this.stagingDirectory, `release-${process.pid}-${randomUUID()}`)
      let renamed = false
      try {
        fs.renameSync(this.lockDirectory, releaseDir)
        renamed = true
        fsyncDirectory(this.stagingDirectory)
        fsyncDirectory(path.dirname(this.lockDirectory))
      } catch {
        // A post-rename fsync failure still removed the canonical lock. A
        // pre-rename failure retains ownership and is retried below.
        if (!renamed) continue
      }
      clearOwnership()
      try { fs.rmSync(releaseDir, { recursive: true, force: true }) } catch {}
      return true
    }
    return false
  }
}

const retainedCrossProcessLocks = new Map<string, CrossProcessLock>()
const asynchronousLockTails = new Map<string, Promise<void>>()
interface AsyncLockOwnership { active: boolean }
const asynchronousLockContext = new AsyncLocalStorage<ReadonlyMap<string, AsyncLockOwnership>>()
const synchronousLockKeys = new Set<string>()

function lockFor(directory: string): CrossProcessLock {
  const candidate = new CrossProcessLock(directory)
  const retained = retainedCrossProcessLocks.get(candidate.key)
  if (retained) {
    if (!retained.release()) {
      throw new FencingLeaseError('lock_release_failed', 'a prior cross-process lock release remains uncertain')
    }
    retainedCrossProcessLocks.delete(candidate.key)
  }
  return candidate
}

function releaseAfterOperation(lock: CrossProcessLock, operationError: unknown): void {
  if (lock.release()) {
    retainedCrossProcessLocks.delete(lock.key)
    if (operationError !== null) throw operationError
    return
  }
  retainedCrossProcessLocks.set(lock.key, lock)
  const releaseError = new FencingLeaseError('lock_release_failed', 'cross-process lock release remains uncertain')
  if (operationError !== null) throw new AggregateError([operationError, releaseError], 'operation failed and its cross-process lock could not be released')
  throw releaseError
}

export function withLock<T>(directory: string, fn: () => T): T {
  const key = new CrossProcessLock(directory).key
  if (asynchronousLockContext.getStore()?.get(key)?.active || synchronousLockKeys.has(key)) return fn()
  if (asynchronousLockTails.has(key)) {
    throw new FencingLeaseError('lock_contended_in_process', 'a synchronous operation cannot wait on an asynchronous lock held by this process')
  }
  const lock = lockFor(directory)
  let result: T | undefined
  let operationError: unknown = null
  try {
    lock.acquire()
    synchronousLockKeys.add(key)
    result = fn()
  } catch (error) {
    operationError = error
  } finally {
    synchronousLockKeys.delete(key)
  }
  releaseAfterOperation(lock, operationError)
  return result as T
}

export async function withLockAsync<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const key = new CrossProcessLock(directory).key
  if (asynchronousLockContext.getStore()?.get(key)?.active) return await fn()
  const predecessor = asynchronousLockTails.get(key) ?? Promise.resolve()
  let releaseTurn!: () => void
  const turn = new Promise<void>(resolve => { releaseTurn = resolve })
  const tail = predecessor.then(() => turn)
  asynchronousLockTails.set(key, tail)
  await predecessor
  try {
    const lock = lockFor(directory)
    let result: T | undefined
    let operationError: unknown = null
    const ownership: AsyncLockOwnership = { active: true }
    const context = new Map(asynchronousLockContext.getStore() ?? [])
    context.set(key, ownership)
    try {
      lock.acquire()
      result = await asynchronousLockContext.run(context, fn)
    } catch (error) {
      operationError = error
    } finally {
      ownership.active = false
    }
    releaseAfterOperation(lock, operationError)
    return result as T
  } finally {
    releaseTurn()
    if (asynchronousLockTails.get(key) === tail) asynchronousLockTails.delete(key)
  }
}

/**
 * Durable fencing lease for multiprocess scheduler authority.
 *
 * Guarantees:
 * - At most one authoritative scheduler per lease directory at any time.
 * - Fencing generations are monotonically increasing.
 * - A stale writer (old generation) cannot acquire, renew, or write after
 *   losing authority.
 * - Safe expiry and takeover: a new process can acquire a lease only after
 *   the previous lease has expired.
 * - Lease state is durable across process crashes.
 * - All transitions (acquire, renew, release) are serialized through a
 *   cross-process lock so that no two processes can simultaneously mutate
 *   the lease file.
 * - Corrupt lease files fail closed with an error rather than being
 *   treated as absent.
 *
 * Platform assumptions:
 * - POSIX filesystem with atomic rename on the same filesystem.
 * - Directory creation is atomic across processes (guaranteed by POSIX).
 * - fsync is honored by the underlying storage.
 * - The lease directory is on a local filesystem (not NFS).
 */
export class FencingLeaseStore {
  private readonly directory: string
  private readonly lockDirectory: string
  private readonly owner: string
  private readonly duration_ms: number
  private readonly now: () => number

  constructor(options: FencingLeaseOptions) {
    this.directory = path.resolve(options.lease_directory)
    this.lockDirectory = options.lock_directory
      ? path.resolve(options.lock_directory)
      : this.directory
    this.owner = options.owner
    this.duration_ms = options.lease_duration_ms
    this.now = options.now
    fs.mkdirSync(this.directory, { recursive: true, mode: DIR_MODE })
    fsyncDirectory(path.dirname(this.directory))
  }

  /**
   * Attempt to acquire a lease. If an existing lease is valid and not expired,
   * throws with code 'lease_held'. If an existing lease has expired, takes over
   * with a new fencing generation (previous generation + 1).
   *
   * The entire acquire operation is serialized through a cross-process lock
   * so that no two processes can simultaneously read, delete, and create
   * the lease file.
   */
  acquire(): FencingLeaseHandle {
    return withLock(this.lockDirectory, () => {
      let existing: FencingLeaseRecord | null = null
      if (leaseExists(this.directory)) {
        existing = readLeaseFile(this.directory)
        if (existing && !isExpired(existing, this.now)) {
          throw new FencingLeaseError(
            'lease_held',
            `a valid lease is held by ${existing.owner} (generation ${existing.fencing_generation}, expires ${existing.expires_at})`,
          )
        }
      }

      const generation = existing ? existing.fencing_generation + 1 : 1
      const record: FencingLeaseRecord = {
        lease_id: `lease-${randomUUID()}`,
        fencing_generation: generation,
        owner: this.owner,
        acquired_at: isoNow(this.now),
        expires_at: new Date(this.now() + this.duration_ms).toISOString(),
        renewal_count: 0,
      }

      if (existing) {
        // Expired lease exists — atomically replace it with the new one.
        // The rename is atomic, so the on-disk state is always either the
        // old expired lease or the new lease, never absent.
        replaceLeaseFile(this.directory, record)
      } else {
        // No lease file — use O_EXCL to atomically create it
        createLeaseFile(this.directory, record)
      }
      return this.createHandle(record)
    })
  }

  /**
   * Read the current lease without acquiring. Returns null if no lease file
   * exists. Throws on corrupt or unreadable lease files.
   */
  current(): FencingLeaseRecord | null {
    if (!leaseExists(this.directory)) return null
    return readLeaseFile(this.directory)
  }

  /**
   * Check whether the current lease is valid (not expired).
   */
  isHeld(): boolean {
    if (!leaseExists(this.directory)) return false
    try {
      const record = readLeaseFile(this.directory)
      return record !== null && !isExpired(record, this.now)
    } catch {
      return false
    }
  }

  /**
   * Get the current fencing generation, or 0 if no lease has ever been acquired.
   * Throws on corrupt lease files.
   */
  currentGeneration(): number {
    if (!leaseExists(this.directory)) return 0
    const record = readLeaseFile(this.directory)
    return record?.fencing_generation ?? 0
  }

  /**
   * Validate that the caller holds the exact current lease authority.
   * Throws if the lease is missing, expired, corrupt, or if the caller's
   * generation or lease_id does not match the on-disk record.
   */
  assertAuthority(generation: number, leaseId: string): void {
    if (!leaseExists(this.directory)) {
      throw new FencingLeaseError('no_lease', 'no lease exists; cannot authorize the operation')
    }
    const record = readLeaseFile(this.directory)
    if (isExpired(record, this.now)) {
      throw new FencingLeaseError('lease_expired', 'the current lease has expired')
    }
    if (record.fencing_generation !== generation) {
      throw new FencingLeaseError(
        'stale_generation',
        `fencing generation ${generation} does not match the current generation ${record.fencing_generation}`,
      )
    }
    if (record.lease_id !== leaseId) {
      throw new FencingLeaseError(
        'lease_mismatch',
        `lease ID ${leaseId} does not match the on-disk lease ${record.lease_id}`,
      )
    }
  }

  private createHandle(record: FencingLeaseRecord): FencingLeaseHandle {
    let current = record
    let released = false

    return {
      get lease() { return current },
      renew: (extendMs?: number): FencingLeaseRecord => {
        if (released) throw new FencingLeaseError('lease_released', 'lease has been released')
        return withLock(this.lockDirectory, () => {
          const onDisk = readLeaseFile(this.directory)
          if (!onDisk || onDisk.lease_id !== current.lease_id) {
            throw new FencingLeaseError('lease_lost', 'lease no longer matches the on-disk record')
          }
          if (isExpired(onDisk, this.now)) {
            throw new FencingLeaseError('lease_expired', 'lease has expired and cannot be renewed')
          }
          const duration = extendMs ?? this.duration_ms
          current = {
            ...onDisk,
            expires_at: new Date(this.now() + duration).toISOString(),
            renewal_count: onDisk.renewal_count + 1,
          }
          replaceLeaseFile(this.directory, current)
          return current
        })
      },
      release: (): void => {
        if (released) return
        released = true
        try {
          withLock(this.lockDirectory, () => {
            const onDisk = readLeaseFile(this.directory)
            if (onDisk && onDisk.lease_id === current.lease_id) {
              const expired = { ...onDisk, expires_at: new Date(this.now() - 1).toISOString() }
              replaceLeaseFile(this.directory, expired)
            }
          })
        } catch {
          // Best-effort release; the lease will expire naturally if this fails.
        }
      },
      is_valid: (): boolean => {
        if (released) return false
        if (!leaseExists(this.directory)) return false
        try {
          const onDisk = readLeaseFile(this.directory)
          return onDisk !== null
            && onDisk.lease_id === current.lease_id
            && !isExpired(onDisk, this.now)
        } catch {
          return false
        }
      },
    }
  }
}

/**
 * Guard function: reject an operation if the caller's fencing generation
 * is stale (less than the current on-disk generation).
 *
 * @deprecated Use FencingLeaseStore.assertAuthority() instead, which
 * validates the exact lease identity and expiry, not just the generation
 * number. This function is retained for backward compatibility with
 * callers that have not yet been updated.
 */
export function assertFencingGeneration(
  store: FencingLeaseStore,
  expectedGeneration: number,
): void {
  if (!store.isHeld()) {
    throw new FencingLeaseError('no_lease', 'no valid lease is held; cannot authorize the operation')
  }
  const current = store.currentGeneration()
  if (expectedGeneration !== current) {
    if (expectedGeneration < current) {
      throw new FencingLeaseError(
        'stale_generation',
        `fencing generation ${expectedGeneration} is stale; current generation is ${current}`,
      )
    }
    throw new FencingLeaseError(
      'future_generation',
      `fencing generation ${expectedGeneration} is ahead of the current generation ${current}`,
    )
  }
}
