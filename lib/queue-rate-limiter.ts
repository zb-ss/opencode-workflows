import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { QueueRateWindow } from './queue-policy.ts'
import { withLock, FencingLeaseError } from './fencing-lease.ts'

const FILE_MODE = 0o600
const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000
const RATE_STATE_SCHEMA_VERSION = 1
const RATE_STATE_FILE = 'rate-state.json'

export interface QueueRateLimiterOptions {
  rate_directory: string
  windows: QueueRateWindow[]
  now: () => number
}

interface RateWindowCounter {
  window_ms: number
  max_requests: number
  requests: number
  window_start: number
}

interface RateReservation {
  reservation_id: string
  reserved_at: number
}

interface RateLimiterState {
  schema_version: typeof RATE_STATE_SCHEMA_VERSION
  counters: RateWindowCounter[]
  reservations: RateReservation[]
}

class QueueRateLimiterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueRateLimiterError'
    this.code = code
  }
}

function isRateWindowCounter(value: unknown): value is RateWindowCounter {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.window_ms === 'number'
    && Number.isInteger(candidate.window_ms)
    && candidate.window_ms > 0
    && typeof candidate.max_requests === 'number'
    && Number.isInteger(candidate.max_requests)
    && candidate.max_requests > 0
    && typeof candidate.requests === 'number'
    && Number.isInteger(candidate.requests)
    && candidate.requests >= 0
    && typeof candidate.window_start === 'number'
    && Number.isInteger(candidate.window_start)
}

function isRateReservation(value: unknown): value is RateReservation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.reservation_id === 'string'
    && candidate.reservation_id.length > 0
    && candidate.reservation_id.length <= 256
    && typeof candidate.reserved_at === 'number'
    && Number.isInteger(candidate.reserved_at)
}

function isRateLimiterState(value: unknown): value is RateLimiterState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.schema_version !== RATE_STATE_SCHEMA_VERSION
    || !Array.isArray(candidate.counters)
    || !candidate.counters.every(isRateWindowCounter)
    || !Array.isArray(candidate.reservations)
    || !candidate.reservations.every(isRateReservation)) {
    return false
  }
  const reservationIds = new Set(candidate.reservations.map(reservation => reservation.reservation_id))
  return reservationIds.size === candidate.reservations.length
}

function readState(filePath: string): RateLimiterState | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (!isRateLimiterState(parsed)) {
      throw new QueueRateLimiterError('state_corrupt', `rate limiter state at ${filePath} is corrupt`)
    }
    return parsed
  } catch (error) {
    if (error instanceof QueueRateLimiterError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new QueueRateLimiterError('state_corrupt', `rate limiter state at ${filePath} is unreadable: ${(error as Error).message}`)
  }
}

function readLegacyCounter(filePath: string): RateWindowCounter | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    if (!isRateWindowCounter(parsed)) {
      throw new QueueRateLimiterError('state_corrupt', `legacy rate counter at ${filePath} is corrupt`)
    }
    return parsed
  } catch (error) {
    if (error instanceof QueueRateLimiterError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new QueueRateLimiterError('state_corrupt', `legacy rate counter at ${filePath} is unreadable: ${(error as Error).message}`)
  }
}

function readLegacyCounters(directory: string): RateWindowCounter[] {
  let files: string[]
  try {
    files = fs.readdirSync(directory)
  } catch (error) {
    throw new QueueRateLimiterError('state_corrupt', `legacy rate counter directory is unreadable: ${(error as Error).message}`)
  }
  return files
    .map(file => ({ file, match: /^rate-window-(0|[1-9][0-9]*)\.json$/.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(entry => readLegacyCounter(path.join(directory, entry.file)))
    .filter(counter => counter !== null)
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | O_NOFOLLOW)
    fs.fsyncSync(fd)
  } catch (error) {
    throw new QueueRateLimiterError('durability_failed', `unable to synchronize rate limiter directory: ${(error as Error).message}`)
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

function writeState(filePath: string, state: RateLimiterState): void {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(temp, filePath)
    fsyncDirectory(path.dirname(filePath))
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}

function resetCounter(window: QueueRateWindow, now: number): RateWindowCounter {
  return {
    window_ms: window.window_ms,
    max_requests: window.max_requests,
    requests: 0,
    window_start: now,
  }
}

function ensureCounter(existing: RateWindowCounter | undefined, window: QueueRateWindow, now: number): RateWindowCounter {
  if (existing === undefined) return resetCounter(window, now)
  if (existing.window_ms !== window.window_ms || existing.max_requests !== window.max_requests) {
    return resetCounter(window, now)
  }
  if (now - existing.window_start >= existing.window_ms) return resetCounter(window, now)
  return existing
}

function matchCounters(existing: readonly RateWindowCounter[], windows: readonly QueueRateWindow[], now: number): RateWindowCounter[] {
  const used = new Set<number>()
  return windows.map(window => {
    const match = existing.findIndex((counter, index) => !used.has(index)
      && counter.window_ms === window.window_ms
      && counter.max_requests === window.max_requests)
    if (match < 0) return resetCounter(window, now)
    used.add(match)
    return ensureCounter(existing[match], window, now)
  })
}

function prepareState(directory: string, filePath: string, windows: readonly QueueRateWindow[], now: number): RateLimiterState {
  const existing = readState(filePath)
  const legacyCounters = existing === null ? readLegacyCounters(directory) : []
  const maxWindowMs = Math.max(...windows.map(window => window.window_ms))
  return {
    schema_version: RATE_STATE_SCHEMA_VERSION,
    counters: matchCounters(existing?.counters ?? legacyCounters, windows, now),
    reservations: (existing?.reservations ?? []).filter(reservation => now - reservation.reserved_at < maxWindowMs),
  }
}

export class QueueRateLimiter {
  private readonly directory: string
  private readonly statePath: string
  private readonly windows: readonly QueueRateWindow[]
  private readonly now: () => number

  constructor(options: QueueRateLimiterOptions) {
    this.directory = path.resolve(options.rate_directory)
    this.statePath = path.join(this.directory, RATE_STATE_FILE)
    this.windows = options.windows
    this.now = options.now
    if (this.windows.length === 0) return
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    fsyncDirectory(path.dirname(this.directory))
  }

  tryAcquire(reservationId: string): boolean {
    if (this.windows.length === 0) return true
    if (reservationId.length === 0 || reservationId.length > 256 || reservationId.includes('\0')) {
      throw new QueueRateLimiterError('invalid_reservation_id', 'rate reservation ID must be between 1 and 256 safe characters')
    }
    try {
      return withLock(this.directory, () => {
        const now = this.now()
        const state = prepareState(this.directory, this.statePath, this.windows, now)
        if (state.reservations.some(reservation => reservation.reservation_id === reservationId)) {
          fsyncDirectory(this.directory)
          return true
        }
        if (state.counters.some(counter => counter.requests >= counter.max_requests)) return false
        state.counters = state.counters.map(counter => ({ ...counter, requests: counter.requests + 1 }))
        state.reservations.push({ reservation_id: reservationId, reserved_at: now })
        writeState(this.statePath, state)
        return true
      })
    } catch (error) {
      if (error instanceof FencingLeaseError) {
        throw new QueueRateLimiterError('lock_timeout', error.message)
      }
      throw error
    }
  }

  snapshot(): Array<{ window_ms: number; requests: number; max_requests: number }> {
    if (this.windows.length === 0) return []
    const now = this.now()
    const state = prepareState(this.directory, this.statePath, this.windows, now)
    return state.counters.map(counter => ({
        window_ms: counter.window_ms,
        requests: counter.requests,
        max_requests: counter.max_requests,
      }))
  }
}
