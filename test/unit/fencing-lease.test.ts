import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { FencingLeaseStore, FencingLeaseError, assertFencingGeneration } from '../../lib/fencing-lease.ts'

const temporaryDirectories = new Set<string>()

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.add(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true })
  temporaryDirectories.clear()
})

const FIXED_NOW = Date.parse('2026-07-24T12:00:00.000Z')
let clock = FIXED_NOW

function clockNow(): number { return clock }

function advance(ms: number): void { clock += ms }

describe('FencingLeaseStore', () => {
  it('acquires a lease with generation 1 when no prior lease exists', () => {
    const dir = tempDir('fencing-lease-init-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handle = store.acquire()
    assert.equal(handle.lease.fencing_generation, 1)
    assert.equal(handle.lease.owner, 'proc-a')
    assert.equal(handle.is_valid(), true)
    assert.equal(store.isHeld(), true)
    assert.equal(store.currentGeneration(), 1)
  })

  it('rejects acquisition while a valid lease is held', () => {
    const dir = tempDir('fencing-lease-held-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    store.acquire()
    assert.throws(() => store.acquire(), (err: Error) => err instanceof FencingLeaseError && err.code === 'lease_held')
  })

  it('takes over with generation + 1 after a lease expires', () => {
    const dir = tempDir('fencing-lease-expire-')
    const storeA = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handleA = storeA.acquire()
    assert.equal(handleA.lease.fencing_generation, 1)

    advance(61_000)

    const storeB = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-b', lease_duration_ms: 60_000, now: clockNow })
    const handleB = storeB.acquire()
    assert.equal(handleB.lease.fencing_generation, 2)
    assert.equal(handleB.lease.owner, 'proc-b')
    assert.equal(handleA.is_valid(), false)
  })

  it('renews a valid lease and increments renewal_count', () => {
    const dir = tempDir('fencing-lease-renew-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handle = store.acquire()
    advance(30_000)
    const renewed = handle.renew()
    assert.equal(renewed.renewal_count, 1)
    assert.equal(renewed.fencing_generation, 1)
    assert.ok(Date.parse(renewed.expires_at) > FIXED_NOW + 90_000)
    assert.equal(handle.is_valid(), true)
  })

  it('rejects renewal after expiry', () => {
    const dir = tempDir('fencing-lease-renew-expired-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handle = store.acquire()
    advance(61_000)
    assert.throws(() => handle.renew(), (err: Error) => err instanceof FencingLeaseError && err.code === 'lease_expired')
  })

  it('rejects renewal after a takeover replaced the lease file', () => {
    const dir = tempDir('fencing-lease-renew-takeover-')
    const storeA = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handleA = storeA.acquire()
    advance(61_000)

    const storeB = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-b', lease_duration_ms: 60_000, now: clockNow })
    storeB.acquire()

    assert.throws(() => handleA.renew(), (err: Error) => err instanceof FencingLeaseError && err.code === 'lease_lost')
  })

  it('releases a lease and allows immediate re-acquisition', () => {
    const dir = tempDir('fencing-lease-release-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handle = store.acquire()
    handle.release()
    assert.equal(handle.is_valid(), false)
    assert.equal(store.isHeld(), false)

    const handle2 = store.acquire()
    assert.equal(handle2.lease.fencing_generation, 2)
  })

  it('assertFencingGeneration rejects stale generations', () => {
    const dir = tempDir('fencing-lease-stale-gen-')
    const store = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    store.acquire()
    assert.throws(() => assertFencingGeneration(store, 0), (err: Error) => err instanceof FencingLeaseError && err.code === 'stale_generation')
    assertFencingGeneration(store, 1)
  })

  it('a stale worker with an old generation is rejected after takeover', () => {
    const dir = tempDir('fencing-lease-stale-worker-')
    const storeA = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 60_000, now: clockNow })

    const handleA = storeA.acquire()
    const genA = handleA.lease.fencing_generation

    advance(61_000)

    const storeB = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-b', lease_duration_ms: 60_000, now: clockNow })
    storeB.acquire()

    assert.throws(() => assertFencingGeneration(storeA, genA), (err: Error) => err instanceof FencingLeaseError && err.code === 'stale_generation')
  })

  it('generations are monotonically increasing across takeovers', () => {
    const dir = tempDir('fencing-lease-monotonic-')
    const now = { val: FIXED_NOW }
    const store = new FencingLeaseStore({
      lease_directory: dir,
      owner: 'rotating',
      lease_duration_ms: 10_000,
      now: () => now.val,
    })

    for (let i = 1; i <= 5; i++) {
      const handle = store.acquire()
      assert.equal(handle.lease.fencing_generation, i)
      now.val += 11_000
    }
  })
})

describe('FencingLeaseStore multiprocess', { concurrency: false }, () => {
  function raceWorker(leaseDir: string, barrier: string, workerId: string, durationMs: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/fencing-race-worker.ts', leaseDir, barrier, workerId, durationMs], { cwd: path.resolve('.') })
      let output = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
      child.on('close', (code: number | null) => resolve({ code, stdout: output.trim() }))
    })
  }

  it('exactly one process wins a real multiprocess acquisition race', async () => {
    const dir = tempDir('fencing-lease-race-')
    const barrier = path.join(dir, 'barrier')
    fs.mkdirSync(barrier)
    const duration = '60000'

    const resultsPromise = Promise.all([
      raceWorker(dir, barrier, 'a', duration),
      raceWorker(dir, barrier, 'b', duration),
      raceWorker(dir, barrier, 'c', duration),
      raceWorker(dir, barrier, 'd', duration),
    ])
    while (!fs.existsSync(path.join(barrier, 'ready-a'))
      || !fs.existsSync(path.join(barrier, 'ready-b'))
      || !fs.existsSync(path.join(barrier, 'ready-c'))
      || !fs.existsSync(path.join(barrier, 'ready-d'))) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    fs.writeFileSync(path.join(barrier, 'go'), '')
    const results = await resultsPromise

    const parsed = results.map(r => {
      try { return JSON.parse(r.stdout) } catch { return null }
    }).filter(Boolean) as Array<{ won: boolean; generation?: number; owner?: string; code?: string }>

    const winners = parsed.filter(r => r.won)
    const losers = parsed.filter(r => !r.won)

    assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${JSON.stringify(parsed)}`)
    assert.equal(winners[0].generation, 1)
    assert.ok(losers.length >= 1, 'at least one loser')
    assert.ok(losers.every(r => r.code === 'lease_held'), 'all losers got lease_held')
  })

  it('a second process takes over after the first lease expires', () => {
    const dir = tempDir('fencing-lease-takeover-')
    const now = { val: FIXED_NOW }

    const storeA = new FencingLeaseStore({
      lease_directory: dir,
      owner: 'proc-a',
      lease_duration_ms: 1000,
      now: () => now.val,
    })

    const handleA = storeA.acquire()
    assert.equal(handleA.lease.fencing_generation, 1)

    // Simulate proc-a crashing (no release) and time passing
    now.val += 1100

    const storeB = new FencingLeaseStore({
      lease_directory: dir,
      owner: 'proc-b',
      lease_duration_ms: 1000,
      now: () => now.val,
    })

    const handleB = storeB.acquire()
    assert.equal(handleB.lease.fencing_generation, 2)
    assert.equal(handleB.lease.owner, 'proc-b')
    assert.equal(handleA.is_valid(), false)

    // Stale proc-a writer is rejected
    assert.throws(() => assertFencingGeneration(storeA, 1), (err: Error) => err instanceof FencingLeaseError && err.code === 'stale_generation')
  })

  it('a stale process cannot renew after takeover', () => {
    const dir = tempDir('fencing-lease-stale-renew-')
    const now = { val: FIXED_NOW }

    const storeA = new FencingLeaseStore({
      lease_directory: dir,
      owner: 'proc-a',
      lease_duration_ms: 1000,
      now: () => now.val,
    })

    const handleA = storeA.acquire()

    // proc-a crashes, time passes, proc-b takes over
    now.val += 1100
    const storeB = new FencingLeaseStore({
      lease_directory: dir,
      owner: 'proc-b',
      lease_duration_ms: 1000,
      now: () => now.val,
    })
    storeB.acquire()

    // proc-a wakes up and tries to renew
    assert.throws(() => handleA.renew(), (err: Error) => err instanceof FencingLeaseError && err.code === 'lease_lost')
  })
})