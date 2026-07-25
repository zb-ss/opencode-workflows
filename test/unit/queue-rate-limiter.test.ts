import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QueueRateLimiter } from '../../lib/queue-rate-limiter.ts'
import type { QueueRateWindow } from '../../lib/queue-policy.ts'

const temporaryDirectories = new Set<string>()
const FIXED_NOW = Date.parse('2026-07-24T12:00:00.000Z')
let clock = FIXED_NOW
function clockNow(): number { return clock }
function advance(ms: number): void { clock += ms }

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.add(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true })
  temporaryDirectories.clear()
  clock = FIXED_NOW
})

function window(windowMs: number, maxRequests: number): QueueRateWindow {
  return { window_ms: windowMs, max_requests: maxRequests }
}

describe('QueueRateLimiter', () => {
  it('always admits when there are no windows configured', () => {
    const dir = tempDir('rate-empty-')
    const limiter = new QueueRateLimiter({ rate_directory: dir, windows: [], now: clockNow })

    for (let i = 0; i < 10; i += 1) {
      assert.equal(limiter.tryAcquire(), true)
    }
    assert.deepEqual(limiter.snapshot(), [])
  })

  it('admits up to max_requests within a single window then blocks', () => {
    const dir = tempDir('rate-single-')
    const limiter = new QueueRateLimiter({ rate_directory: dir, windows: [window(60_000, 3)], now: clockNow })

    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)

    const snapshot = limiter.snapshot()
    assert.equal(snapshot.length, 1)
    assert.equal(snapshot[0]!.requests, 3)
    assert.equal(snapshot[0]!.max_requests, 3)
  })

  it('resets the counter after window_ms elapses', () => {
    const dir = tempDir('rate-reset-')
    const limiter = new QueueRateLimiter({ rate_directory: dir, windows: [window(10_000, 2)], now: clockNow })

    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)

    advance(10_001)

    assert.equal(limiter.tryAcquire(), true)
    const snapshot = limiter.snapshot()
    assert.equal(snapshot[0]!.requests, 1)
  })

  it('survives a process restart by reading the same counter files', () => {
    const dir = tempDir('rate-crash-')
    const first = new QueueRateLimiter({ rate_directory: dir, windows: [window(60_000, 3)], now: clockNow })

    assert.equal(first.tryAcquire(), true)
    assert.equal(first.tryAcquire(), true)

    const second = new QueueRateLimiter({ rate_directory: dir, windows: [window(60_000, 3)], now: clockNow })

    assert.equal(second.tryAcquire(), true)
    assert.equal(second.tryAcquire(), false)

    const snapshot = second.snapshot()
    assert.equal(snapshot[0]!.requests, 3)
  })

  it('resets when the configured window changes between instances', () => {
    const dir = tempDir('rate-reconfig-')
    const first = new QueueRateLimiter({ rate_directory: dir, windows: [window(60_000, 3)], now: clockNow })
    assert.equal(first.tryAcquire(), true)
    assert.equal(first.tryAcquire(), true)

    const second = new QueueRateLimiter({ rate_directory: dir, windows: [window(30_000, 5)], now: clockNow })
    assert.equal(second.tryAcquire(), true)
    assert.equal(second.tryAcquire(), true)
    assert.equal(second.tryAcquire(), true)

    const snapshot = second.snapshot()
    assert.equal(snapshot[0]!.requests, 3)
    assert.equal(snapshot[0]!.max_requests, 5)
  })

  it('enforces all configured windows and only persists when every window admits', () => {
    const dir = tempDir('rate-multi-')
    const limiter = new QueueRateLimiter({
      rate_directory: dir,
      windows: [window(60_000, 2), window(120_000, 4)],
      now: clockNow,
    })

    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)

    advance(60_001)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)

    const snapshot = limiter.snapshot()
    assert.equal(snapshot.length, 2)
    assert.equal(snapshot[0]!.requests, 2)
    assert.equal(snapshot[1]!.requests, 4)
  })
})