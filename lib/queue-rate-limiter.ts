import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { QueueRateWindow } from './queue-policy.ts'

const FILE_MODE = 0o600
const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000
const LOCK_STALE_MS = 10_000
const LOCK_RETRY_LIMIT = 2000

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

class QueueRateLimiterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueRateLimiterError'
    this.code = code
  }
}

function counterPath(directory: string, index: number): string {
  return path.join(directory, `rate-window-${index}.json`)
}

function lockPath(directory: string): string {
  return path.join(directory, '.rate-lock')
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

function readCounter(filePath: string): RateWindowCounter {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (!isRateWindowCounter(parsed)) {
      throw new QueueRateLimiterError('counter_corrupt', `rate counter at ${filePath} is corrupt`)
    }
    return parsed
  } catch (error) {
    if (error instanceof QueueRateLimiterError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null as unknown as RateWindowCounter
    throw new QueueRateLimiterError('counter_corrupt', `rate counter at ${filePath} is unreadable: ${(error as Error).message}`)
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | O_NOFOLLOW)
    fs.fsyncSync(fd)
  } catch {
    // Best-effort.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

function writeCounter(filePath: string, counter: RateWindowCounter): void {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    fs.writeFileSync(fd, JSON.stringify(counter, null, 2) + '\n', { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(temp, filePath)
    fsyncDirectory(path.dirname(filePath))
    try { fs.chmodSync(filePath, FILE_MODE) } catch {}
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

function ensureCounter(directory: string, window: QueueRateWindow, index: number, now: number): RateWindowCounter {
  const filePath = counterPath(directory, index)
  let existing: RateWindowCounter | null = null
  if (fs.existsSync(filePath)) {
    existing = readCounter(filePath)
  }
  if (existing === null) return resetCounter(window, now)
  if (existing.window_ms !== window.window_ms || existing.max_requests !== window.max_requests) {
    return resetCounter(window, now)
  }
  if (now - existing.window_start >= existing.window_ms) return resetCounter(window, now)
  return existing
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
            throw new QueueRateLimiterError('lock_timeout', `could not acquire the rate limiter lock within ${LOCK_STALE_MS}ms`)
          }
          attempts += 1
          const sleepMs = Math.min(5 * attempts, 50)
          const end = Date.now() + sleepMs
          while (Date.now() < end) { /* busy wait */ }
          continue
        }
        throw error
      }
    }
    throw new QueueRateLimiterError('lock_timeout', `could not acquire the rate limiter lock after ${LOCK_RETRY_LIMIT} attempts`)
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

export class QueueRateLimiter {
  private readonly directory: string
  private readonly windows: readonly QueueRateWindow[]
  private readonly now: () => number

  constructor(options: QueueRateLimiterOptions) {
    this.directory = path.resolve(options.rate_directory)
    this.windows = options.windows
    this.now = options.now
    if (this.windows.length === 0) return
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  tryAcquire(): boolean {
    if (this.windows.length === 0) return true
    const lock = new CrossProcessLock(this.directory)
    lock.acquire()
    try {
      const now = this.now()
      const counters: RateWindowCounter[] = []
      for (let index = 0; index < this.windows.length; index += 1) {
        const window = this.windows[index]!
        const counter = ensureCounter(this.directory, window, index, now)
        if (counter.requests >= counter.max_requests) return false
        counters.push({ ...counter, requests: counter.requests + 1 })
      }
      for (let index = 0; index < counters.length; index += 1) {
        writeCounter(counterPath(this.directory, index), counters[index]!)
      }
      return true
    } finally {
      lock.release()
    }
  }

  snapshot(): Array<{ window_ms: number; requests: number; max_requests: number }> {
    if (this.windows.length === 0) return []
    const now = this.now()
    const result: Array<{ window_ms: number; requests: number; max_requests: number }> = []
    for (let index = 0; index < this.windows.length; index += 1) {
      const window = this.windows[index]!
      const counter = ensureCounter(this.directory, window, index, now)
      result.push({
        window_ms: counter.window_ms,
        requests: counter.requests,
        max_requests: counter.max_requests,
      })
    }
    return result
  }
}