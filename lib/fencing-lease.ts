import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 5
const LOCK_RETRY_LIMIT = 2000

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

function lockPath(directory: string): string {
  return path.join(directory, '.fencing-lock')
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
    try { fs.chmodSync(leaseFile, FILE_MODE) } catch {}
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
  } catch {
    // Best-effort directory fsync; some platforms don't support it.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

function isExpired(record: FencingLeaseRecord, now: () => number): boolean {
  return now() >= Date.parse(record.expires_at)
}

class CrossProcessLock {
  private readonly lockFile: string
  private readonly directory: string
  private held = false

  constructor(directory: string) {
    this.directory = directory
    this.lockFile = lockPath(directory)
  }

  acquire(): void {
    if (this.held) return
    const deadline = Date.now() + LOCK_STALE_MS
    let attempts = 0
    while (attempts < LOCK_RETRY_LIMIT) {
      let fd: number | null = null
      try {
        fd = fs.openSync(this.lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
        fs.writeFileSync(fd, String(process.pid), { encoding: 'utf8' })
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = null
        this.held = true
        return
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd) } catch {} }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (this.isStale()) {
            try { fs.unlinkSync(this.lockFile) } catch {}
            continue
          }
          if (Date.now() > deadline) {
            throw new FencingLeaseError('lock_timeout', `could not acquire the cross-process lock within ${LOCK_STALE_MS}ms`)
          }
          const elapsed = Date.now() - deadline + LOCK_STALE_MS
          if (elapsed > 0 && elapsed % 100 < LOCK_RETRY_MS) {
            // Log nothing; this is a tight retry loop.
          }
          attempts += 1
          const sleepMs = Math.min(LOCK_RETRY_MS * attempts, 50)
          const end = Date.now() + sleepMs
          while (Date.now() < end) { /* busy wait — operations are sub-millisecond */ }
          continue
        }
        throw error
      }
    }
    throw new FencingLeaseError('lock_timeout', `could not acquire the cross-process lock after ${LOCK_RETRY_LIMIT} attempts`)
  }

  private isStale(): boolean {
    try {
      const content = fs.readFileSync(this.lockFile, 'utf8').trim()
      const pid = parseInt(content, 10)
      if (!Number.isFinite(pid) || pid <= 0) return true
      try { process.kill(pid, 0) } catch { return true }
      return false
    } catch {
      return true
    }
  }

  release(): void {
    if (!this.held) return
    this.held = false
    try { fs.unlinkSync(this.lockFile) } catch {}
    fsyncDirectory(this.directory)
  }
}

function withLock<T>(directory: string, fn: () => T): T {
  const lock = new CrossProcessLock(directory)
  lock.acquire()
  try {
    return fn()
  } finally {
    lock.release()
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
 * - O_EXCL is atomic across processes (guaranteed by POSIX).
 * - fsync is honored by the underlying storage.
 * - The lease directory is on a local filesystem (not NFS).
 */
export class FencingLeaseStore {
  private readonly directory: string
  private readonly owner: string
  private readonly duration_ms: number
  private readonly now: () => number

  constructor(options: FencingLeaseOptions) {
    this.directory = path.resolve(options.lease_directory)
    this.owner = options.owner
    this.duration_ms = options.lease_duration_ms
    this.now = options.now
    fs.mkdirSync(this.directory, { recursive: true, mode: DIR_MODE })
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
    return withLock(this.directory, () => {
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
        return withLock(this.directory, () => {
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
          withLock(this.directory, () => {
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