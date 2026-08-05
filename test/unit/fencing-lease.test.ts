import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { FencingLeaseStore, FencingLeaseError, assertFencingGeneration, withLock, withLockAsync } from '../../lib/fencing-lease.ts'

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
    assert.ok(losers.every(r => r.code === 'lease_held'), `all losers got lease_held: ${JSON.stringify(parsed)}`)
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

describe('CrossProcessLock atomic protocol', { concurrency: false }, () => {
  it('serializes concurrent asynchronous users in the same process', async () => {
    const dir = tempDir('cross-process-lock-async-')
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })

    const first = withLockAsync(dir, async () => {
      events.push('first-enter')
      firstEntered()
      await firstGate
      events.push('first-exit')
    })
    await entered
    const second = withLockAsync(dir, async () => {
      events.push('second-enter')
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(events, ['first-enter'])

    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter'])
  })

  it('permits owned re-entry but rejects unrelated synchronous contention on an async lock', async () => {
    const dir = tempDir('cross-process-lock-mixed-')
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    let entered!: () => void
    const firstEntered = new Promise<void>(resolve => { entered = resolve })
    const first = withLockAsync(dir, async () => {
      assert.equal(withLock(dir, () => 'nested'), 'nested')
      entered()
      await gate
    })
    await firstEntered

    assert.throws(
      () => withLock(dir, () => undefined),
      (error: Error) => error instanceof FencingLeaseError && error.code === 'lock_contended_in_process',
    )
    releaseFirst()
    await first
    assert.doesNotThrow(() => withLock(dir, () => undefined))
  })

  function lockRaceWorker(
    lockDir: string,
    barrier: string,
    workerId: string,
    mode: string,
  ): Promise<{ code: number | null; stdout: string }> {
    return new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/fencing-lock-race-worker.ts', lockDir, barrier, workerId, mode], { cwd: path.resolve('.') })
      let output = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
      child.on('close', (code: number | null) => resolve({ code, stdout: output.trim() }))
    })
  }

  function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (fs.existsSync(filePath)) return resolve()
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${filePath}`))
        setTimeout(check, 5)
      }
      check()
    })
  }

  it('two processes never enter the protected callback simultaneously', async () => {
    const dir = tempDir('fencing-lock-overlap-')
    const barrier = path.join(dir, 'barrier')
    fs.mkdirSync(barrier)

    // Worker A signals ready, waits for go, acquires the lock and holds it.
    const workerA = lockRaceWorker(dir, barrier, 'a', 'race')
    await waitForFile(path.join(barrier, 'ready-a'))
    fs.writeFileSync(path.join(barrier, 'go'), '')
    await waitForFile(path.join(barrier, 'entered-a'))

    // While A holds the lock, B cannot enter.
    const workerB = lockRaceWorker(dir, barrier, 'b', 'race')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(fs.existsSync(path.join(barrier, 'entered-b')), false, 'B must not enter while A holds the lock')

    // Release A. Now B can enter.
    fs.writeFileSync(path.join(barrier, 'release-a'), '')
    await waitForFile(path.join(barrier, 'entered-b'))
    assert.equal(fs.existsSync(path.join(barrier, 'entered-a')), true)
    assert.equal(fs.existsSync(path.join(barrier, 'entered-b')), true)

    // But they were never inside simultaneously: B only entered after A released.
    fs.writeFileSync(path.join(barrier, 'release-b'), '')
    const [resultA, resultB] = await Promise.all([workerA, workerB])
    const parsedA = JSON.parse(resultA.stdout)
    const parsedB = JSON.parse(resultB.stdout)
    assert.equal(parsedA.won, true)
    assert.equal(parsedB.won, true)
  })

  it('a live holder is never stolen even under contention', async () => {
    const dir = tempDir('fencing-lock-live-')
    const barrier = path.join(dir, 'barrier')
    fs.mkdirSync(barrier)

    // A acquires and holds for a while.
    const workerA = lockRaceWorker(dir, barrier, 'a', 'race')
    await waitForFile(path.join(barrier, 'ready-a'))
    fs.writeFileSync(path.join(barrier, 'go'), '')
    await waitForFile(path.join(barrier, 'entered-a'))

    // B tries to acquire while A is alive. B must time out or fail, never enter.
    const workerB = lockRaceWorker(dir, barrier, 'b', 'race')
    await waitForFile(path.join(barrier, 'ready-b'))
    // Don't release A for a while; B should not enter.
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(fs.existsSync(path.join(barrier, 'entered-b')), false, 'B must not steal a live lock')

    // Release A; B can now enter.
    fs.writeFileSync(path.join(barrier, 'release-a'), '')
    await waitForFile(path.join(barrier, 'entered-b'))
    fs.writeFileSync(path.join(barrier, 'release-b'), '')
    await Promise.all([workerA, workerB])
  })

  it('one winner in 5 repeated four-process races', async () => {
    for (let i = 0; i < 5; i++) {
      const dir = tempDir(`fencing-lock-20x-${i}-`)
      const barrier = path.join(dir, 'barrier')
      fs.mkdirSync(barrier)

      const workers = [
        lockRaceWorker(dir, barrier, 'a', 'race'),
        lockRaceWorker(dir, barrier, 'b', 'race'),
        lockRaceWorker(dir, barrier, 'c', 'race'),
        lockRaceWorker(dir, barrier, 'd', 'race'),
      ]
      for (const id of ['a', 'b', 'c', 'd']) {
        await waitForFile(path.join(barrier, `ready-${id}`))
      }
      fs.writeFileSync(path.join(barrier, 'go'), '')

      // The first to enter wins. Release the winner so others can proceed.
      let winner: string | null = null
      for (const id of ['a', 'b', 'c', 'd']) {
        try {
          await waitForFile(path.join(barrier, `entered-${id}`), 3000)
          winner = id
          break
        } catch { /* check next */ }
      }
      assert.ok(winner, `race ${i}: at least one winner`)
      fs.writeFileSync(path.join(barrier, `release-${winner}`), '')

      // Release all remaining workers quickly.
      for (const id of ['a', 'b', 'c', 'd']) {
        if (id === winner) continue
        try { await waitForFile(path.join(barrier, `entered-${id}`), 500) } catch { /* timed out */ }
        fs.writeFileSync(path.join(barrier, `release-${id}`), '')
      }

      const results = await Promise.all(workers)
      const parsed = results.map(r => {
        try { return JSON.parse(r.stdout) } catch { return null }
      }).filter(Boolean) as Array<{ won: boolean; worker?: string }>
      const winners = parsed.filter(r => r.won)
      assert.ok(winners.length >= 1, `race ${i}: at least one winner`)
    }
  })

  it('a dead holder can be replaced', () => {
    const dir = tempDir('fencing-lock-dead-')
    const lockDir = path.join(dir, '.fencing-lock')
    const stagingDir = path.join(dir, '.fencing-staging')
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })

    // Simulate a dead process: create a lock directory with a token for a
    // PID that no longer exists.
    fs.mkdirSync(lockDir, { mode: 0o700 })
    const deadPid = 999999
    const token = { pid: deadPid, nonce: 'dead-token', start_time: null }
    fs.writeFileSync(path.join(lockDir, 'holder.token'), JSON.stringify(token), { mode: 0o600 })

    // A new process should be able to acquire the lock (quarantine the stale one).
    let acquired = false
    withLock(dir, () => {
      acquired = true
    })
    assert.equal(acquired, true)
    assert.equal(fs.existsSync(lockDir), false, 'stale lock must be removed after takeover')
  })

  it('retries when a holder releases between lock identity and token reads', () => {
    const dir = tempDir('fencing-lock-release-race-')
    const lockDir = path.join(dir, '.fencing-lock')
    fs.mkdirSync(lockDir, { mode: 0o700 })
    fs.writeFileSync(
      path.join(lockDir, 'holder.token'),
      JSON.stringify({ pid: process.pid, nonce: 'releasing-holder', start_time: null }),
      { mode: 0o600 },
    )

    const originalReadFile = fs.readFileSync
    let simulatedRelease = false
    try {
      fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
        if (!simulatedRelease && String(filePath) === path.join(lockDir, 'holder.token')) {
          simulatedRelease = true
          fs.rmSync(lockDir, { recursive: true })
          throw Object.assign(new Error('lock released during token read'), { code: 'ENOENT' })
        }
        return originalReadFile(filePath, options as never)
      }) as typeof fs.readFileSync

      let acquired = false
      assert.doesNotThrow(() => withLock(dir, () => { acquired = true }))
      assert.equal(acquired, true)
    } finally {
      fs.readFileSync = originalReadFile
    }
  })

  it('recovers when a stale-lock claimant dies after writing its takeover token', () => {
    const dir = tempDir('fencing-lock-dead-takeover-')
    const lockDir = path.join(dir, '.fencing-lock')
    fs.mkdirSync(path.join(dir, '.fencing-staging'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(lockDir, { mode: 0o700 })
    fs.writeFileSync(path.join(lockDir, 'holder.token'), JSON.stringify({ pid: 999998, nonce: 'dead-holder', start_time: null }), { mode: 0o600 })
    fs.writeFileSync(path.join(lockDir, 'takeover.token'), JSON.stringify({ pid: 999999, nonce: 'dead-claimant', start_time: null }), { mode: 0o600 })

    let acquired = false
    withLock(dir, () => { acquired = true })

    assert.equal(acquired, true)
    assert.equal(fs.existsSync(lockDir), false)
  })

  it('releases an installed lock when either post-rename directory fsync fails', () => {
    for (const failingCall of [4, 5]) {
      const dir = tempDir(`fencing-lock-post-rename-fsync-${failingCall}-`)
      const originalFsync = fs.fsyncSync
      let calls = 0
      try {
        fs.fsyncSync = ((fd: number) => {
          calls += 1
          if (calls === failingCall) throw Object.assign(new Error('simulated directory fsync failure'), { code: 'EIO' })
          return originalFsync(fd)
        }) as typeof fs.fsyncSync
        assert.throws(() => withLock(dir, () => {}), /simulated directory fsync failure/)
      } finally {
        fs.fsyncSync = originalFsync
      }

      assert.equal(fs.existsSync(path.join(dir, '.fencing-lock')), false, 'failed acquisition must not leak its canonical lock')
      assert.doesNotThrow(() => withLock(dir, () => {}))
    }
  })

  it('retries transient release failures and retains ownership for a later safe retry', () => {
    const dir = tempDir('fencing-lock-release-retry-')
    const originalRename = fs.renameSync
    let releaseFailures = 0
    try {
      fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
        if (String(source).endsWith('.fencing-lock') && String(destination).includes('release-') && releaseFailures < 3) {
          releaseFailures++
          throw Object.assign(new Error('simulated busy release'), { code: 'EBUSY' })
        }
        return originalRename(source, destination)
      }) as typeof fs.renameSync
      assert.throws(
        () => withLock(dir, () => {}),
        (error: Error) => error instanceof FencingLeaseError && error.code === 'lock_release_failed',
      )
    } finally {
      fs.renameSync = originalRename
    }

    assert.doesNotThrow(() => withLock(dir, () => {}))
    assert.equal(fs.existsSync(path.join(dir, '.fencing-lock')), false)
  })

  it('malformed or unreadable ownership evidence fails closed', () => {
    const dir = tempDir('fencing-lock-malformed-')
    const lockDir = path.join(dir, '.fencing-lock')
    const stagingDir = path.join(dir, '.fencing-staging')
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })

    // Case 1: tokenless canonical lock (should fail closed immediately, not auto-remove).
    fs.mkdirSync(lockDir, { mode: 0o700 })
    assert.throws(() => {
      withLock(dir, () => {})
    }, (err: Error) => err instanceof FencingLeaseError && err.code === 'lock_corrupt')
    assert.equal(fs.existsSync(lockDir), true, 'tokenless lock must not be auto-removed')

    // Case 2: corrupt token (invalid JSON).
    fs.rmSync(lockDir, { recursive: true, force: true })
    fs.mkdirSync(lockDir, { mode: 0o700 })
    fs.writeFileSync(path.join(lockDir, 'holder.token'), '{ invalid json', { mode: 0o600 })
    assert.throws(() => {
      withLock(dir, () => {})
    }, (err: Error) => err instanceof FencingLeaseError && err.code === 'lock_corrupt')
    assert.equal(fs.existsSync(lockDir), true, 'corrupt-token lock must not be auto-removed')

    // Case 3: a file where the lock directory should be.
    fs.rmSync(lockDir, { recursive: true, force: true })
    fs.writeFileSync(lockDir, 'not a directory', { mode: 0o600 })
    assert.throws(() => {
      withLock(dir, () => {})
    }, (err: Error) => err instanceof FencingLeaseError && err.code === 'lock_corrupt')
    assert.equal(fs.existsSync(lockDir), true, 'corrupted lock file must not be auto-removed')
  })
})
