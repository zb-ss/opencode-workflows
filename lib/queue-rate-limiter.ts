import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { QueueRateWindow } from './queue-policy.ts'

const FILE_MODE = 0o600

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

function counterPath(directory: string, index: number): string {
  return path.join(directory, `rate-window-${index}.json`)
}

function readCounter(filePath: string): RateWindowCounter | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (!isRateWindowCounter(parsed)) return null
    return parsed
  } catch {
    return null
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

function writeCounter(filePath: string, counter: RateWindowCounter): void {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(counter, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
    fs.renameSync(temp, filePath)
    try { fs.chmodSync(filePath, FILE_MODE) } catch {}
  } catch (error) {
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
  const existing = readCounter(filePath)
  if (existing === null) return resetCounter(window, now)
  if (existing.window_ms !== window.window_ms || existing.max_requests !== window.max_requests) {
    return resetCounter(window, now)
  }
  if (now - existing.window_start >= existing.window_ms) return resetCounter(window, now)
  return existing
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
    fs.mkdirSync(this.directory, { recursive: true })
  }

  tryAcquire(): boolean {
    if (this.windows.length === 0) return true
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