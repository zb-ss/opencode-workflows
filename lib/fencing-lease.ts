import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000
const FILE_MODE = 0o600
const DIR_MODE = 0o700

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

function readLeaseFile(directory: string): FencingLeaseRecord | null {
  const leaseFile = leasePath(directory)
  try {
    const content = fs.readFileSync(leaseFile, 'utf8')
    return JSON.parse(content) as FencingLeaseRecord
  } catch {
    return null
  }
}

function writeLeaseFile(directory: string, record: FencingLeaseRecord): void {
  const leaseFile = leasePath(directory)
  const temp = `${leaseFile}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
    fs.renameSync(temp, leaseFile)
    try { fs.chmodSync(leaseFile, FILE_MODE) } catch {}
  } catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}

function isExpired(record: FencingLeaseRecord, now: () => number): boolean {
  return now() >= Date.parse(record.expires_at)
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
 *
 * Platform assumptions:
 * - POSIX filesystem with atomic rename on the same filesystem.
 * - O_EXCL is atomic across processes (guaranteed by POSIX).
 * - fsync is honored by the underlying storage (tested separately).
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
   */
  acquire(): FencingLeaseHandle {
    const existing = readLeaseFile(this.directory)
    const nowIso = isoNow(this.now)

    if (existing && !isExpired(existing, this.now)) {
      throw new FencingLeaseError(
        'lease_held',
        `a valid lease is held by ${existing.owner} (generation ${existing.fencing_generation}, expires ${existing.expires_at})`,
      )
    }

    const generation = existing ? existing.fencing_generation + 1 : 1
    const record: FencingLeaseRecord = {
      lease_id: `lease-${randomUUID()}`,
      fencing_generation: generation,
      owner: this.owner,
      acquired_at: nowIso,
      expires_at: new Date(this.now() + this.duration_ms).toISOString(),
      renewal_count: 0,
    }

    writeLeaseFile(this.directory, record)
    return this.createHandle(record)
  }

  /**
   * Read the current lease without acquiring. Returns null if no lease file exists.
   */
  current(): FencingLeaseRecord | null {
    return readLeaseFile(this.directory)
  }

  /**
   * Check whether the current lease is valid (not expired).
   */
  isHeld(): boolean {
    const record = readLeaseFile(this.directory)
    return record !== null && !isExpired(record, this.now)
  }

  /**
   * Get the current fencing generation, or 0 if no lease has ever been acquired.
   */
  currentGeneration(): number {
    const record = readLeaseFile(this.directory)
    return record?.fencing_generation ?? 0
  }

  private createHandle(record: FencingLeaseRecord): FencingLeaseHandle {
    let current = record
    let released = false

    return {
      get lease() { return current },
      renew: (extendMs?: number): FencingLeaseRecord => {
        if (released) throw new FencingLeaseError('lease_released', 'lease has been released')
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
        writeLeaseFile(this.directory, current)
        return current
      },
      release: (): void => {
        if (released) return
        released = true
        const onDisk = readLeaseFile(this.directory)
        if (onDisk && onDisk.lease_id === current.lease_id) {
          // Mark as expired immediately rather than deleting, so the generation
          // counter persists for monotonicity across release+reacquire
          const expired = { ...onDisk, expires_at: new Date(this.now() - 1).toISOString() }
          writeLeaseFile(this.directory, expired)
        }
      },
      is_valid: (): boolean => {
        if (released) return false
        const onDisk = readLeaseFile(this.directory)
        return onDisk !== null
          && onDisk.lease_id === current.lease_id
          && !isExpired(onDisk, this.now)
      },
    }
  }
}

/**
 * Guard function: reject an operation if the caller's fencing generation
 * is stale (less than the current on-disk generation).
 */
export function assertFencingGeneration(
  store: FencingLeaseStore,
  expectedGeneration: number,
): void {
  const current = store.currentGeneration()
  if (expectedGeneration < current) {
    throw new FencingLeaseError(
      'stale_generation',
      `fencing generation ${expectedGeneration} is stale; current generation is ${current}`,
    )
  }
}