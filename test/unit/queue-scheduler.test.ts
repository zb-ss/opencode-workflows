import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QueueScheduler, QueueSchedulerError } from '../../lib/queue-scheduler.ts'
import type { EnabledQueueConfig } from '../../lib/queue-policy.ts'
import { QueueStore } from '../../lib/queue-store.ts'
import type { QueueWorkflowRecord } from '../../lib/queue-contracts.ts'
import { QueueRateLimiter } from '../../lib/queue-rate-limiter.ts'

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

function queueConfig(maxConcurrent: number, leaseDurationMs = 60_000, renewalIntervalMs = 20_000): EnabledQueueConfig {
  return {
    enabled: true,
    max_concurrent_workflows: maxConcurrent,
    lease_duration_ms: leaseDurationMs,
    renewal_interval_ms: renewalIntervalMs,
    recovery_attempt_limit: 3,
    retry_policy: {
      max_semantic_attempts: 3,
      max_contract_attempts: 3,
      max_transport_attempts: 3,
      max_no_progress_attempts: 2,
      transport_backoff: { strategy: 'exponential', initial_delay_ms: 100, maximum_delay_ms: 1000, multiplier: 2 },
    },
  }
}

function fixture(maxConcurrent = 2) {
  const dir = tempDir('queue-scheduler-')
  const store = new QueueStore({ config_directory: dir, owner: 'test-scheduler', now: clockNow })
  return { dir, store, config: queueConfig(maxConcurrent) }
}

function workflowInput(id: string) {
  return {
    workflow_id: id,
    definition_id: 'development',
    root_session_id: 'root-1',
    directory: '/project',
    worktree: '/project',
    mode: 'standard',
    task: 'Implement a feature.',
  }
}

function enqueueWith(store: QueueStore, handle: import('../../lib/fencing-lease.ts').FencingLeaseHandle, id: string): QueueWorkflowRecord {
  return store.enqueue(workflowInput(id), handle)
}

function seedLeasedWorkflow(store: QueueStore, handle: import('../../lib/fencing-lease.ts').FencingLeaseHandle, id: string, launchState: 'reserved' | 'created' | 'prompted' | 'settled' | 'ambiguous'): QueueWorkflowRecord {
  const generation = handle.lease.fencing_generation
  const initial = store.enqueue(workflowInput(id), handle)
  return store.update(id, initial.state_revision, handle, (record) => {
    record.status = 'leased'
    record.launch_intent = {
      intent_id: `intent-${id}`,
      workflow_id: id,
      fencing_generation: generation,
      session_id: null,
      child_session_ids: [],
      engine_instance_id: ['created', 'prompted', 'settled'].includes(launchState) ? `engine-${id}` : null,
      agent: 'standard',
      model: 'development',
      launch_state: launchState,
      reserved_at: new Date(clock).toISOString(),
      created_at: ['created', 'prompted', 'settled'].includes(launchState) ? new Date(clock).toISOString() : null,
      prompted_at: ['prompted', 'settled'].includes(launchState) ? new Date(clock).toISOString() : null,
      settled_at: launchState === 'settled' ? new Date(clock).toISOString() : null,
    }
    return record
  })
}

function loadStatus(store: QueueStore, workflowId: string): string {
  const record = store.load(workflowId)
  assert.notEqual(record, null)
  return record!.status
}

describe('QueueScheduler', () => {
  it('contains admission failures raised from the renewal timer and stops scheduling', () => {
    const test = fixture()
    let tick: (() => void) | null = null
    const scheduler = new QueueScheduler({
      store: test.store,
      config: test.config,
      now: clockNow,
      interval: callback => {
        tick = callback
        return Symbol('timer')
      },
      clearInterval: () => {},
    })
    const handle = scheduler.start({ schedule: false })
    enqueueWith(test.store, handle.lease, 'wf-timer')
    ;(scheduler as unknown as { rateLimiter: { tryAcquire(): boolean } }).rateLimiter = {
      tryAcquire() { throw new Error('corrupt rate state') },
    }

    assert.ok(tick)
    assert.doesNotThrow(() => tick!())
    assert.equal(scheduler.hasLease, false)
    assert.equal(loadStatus(test.store, 'wf-timer'), 'queued')
  })

  it('acquires a lease, enqueues a workflow, and transitions it to leased', () => {
    const test = fixture()
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    const handle = scheduler.start()
    const generation = handle.generation

    enqueueWith(test.store, handle.lease, 'wf-1')
    scheduler.start()

    assert.equal(loadStatus(test.store, 'wf-1'), 'leased')
    const record = test.store.load('wf-1')!
    assert.notEqual(record.launch_intent, null)
    assert.equal(record.launch_intent!.launch_state, 'reserved')
    assert.equal(record.launch_intent!.fencing_generation, generation)

    handle.dispose()
  })

  it('calls onWorkflowReady for each admitted workflow', () => {
    const test = fixture(2)
    const ready: string[] = []
    const scheduler = new QueueScheduler({
      store: test.store,
      config: test.config,
      now: clockNow,
      onWorkflowReady: (workflowId) => ready.push(workflowId),
    })
    const handle = scheduler.start()
    const generation = handle.generation

    enqueueWith(test.store, handle.lease, 'wf-a')
    enqueueWith(test.store, handle.lease, 'wf-b')
    scheduler.start()

    assert.deepEqual(ready.sort(), ['wf-a', 'wf-b'])
    handle.dispose()
  })

  it('reuses the durable rate reservation after CAS failure and attended recovery', async () => {
    const test = fixture(1)
    test.config.rate_windows = [{ window_ms: 60_000, max_requests: 1 }]
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    const handle = scheduler.start()
    enqueueWith(test.store, handle.lease, 'wf-1')

    const originalUpdate = test.store.update.bind(test.store)
    let failUpdate = true
    test.store.update = ((...args: Parameters<QueueStore['update']>) => {
      if (failUpdate) {
        failUpdate = false
        throw new Error('simulated queue CAS failure')
      }
      return originalUpdate(...args)
    }) as QueueStore['update']

    scheduler.schedule()
    assert.equal(loadStatus(test.store, 'wf-1'), 'queued')
    handle.dispose()

    const restartedStore = new QueueStore({ config_directory: test.dir, owner: 'restarted-scheduler', now: clockNow })
    const restartedScheduler = new QueueScheduler({ store: restartedStore, config: test.config, now: clockNow })
    const restartedHandle = restartedScheduler.start({ schedule: false })
    await restartedScheduler.recover()
    restartedScheduler.schedule()
    assert.equal(loadStatus(restartedStore, 'wf-1'), 'leased')

    const limiter = new QueueRateLimiter({
      rate_directory: path.join(test.dir, 'rate'),
      windows: test.config.rate_windows,
      now: clockNow,
    })
    assert.equal(limiter.snapshot()[0]!.requests, 1)
    restartedHandle.dispose()
  })

  it('does not exceed max_concurrent_workflows', () => {
    const test = fixture(2)
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    const handle = scheduler.start()
    const generation = handle.generation

    enqueueWith(test.store, handle.lease, 'wf-1')
    enqueueWith(test.store, handle.lease, 'wf-2')
    enqueueWith(test.store, handle.lease, 'wf-3')
    enqueueWith(test.store, handle.lease, 'wf-4')
    scheduler.start()

    const index = test.store.rebuildIndex()
    const leased = index.filter(entry => entry.status === 'leased').length
    const queued = index.filter(entry => entry.status === 'queued').length
    assert.equal(leased, 2)
    assert.equal(queued, 2)

    handle.dispose()
  })

  it('admits additional queued workflows when running workflows complete', () => {
    const test = fixture(2)
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    const handle = scheduler.start()
    const generation = handle.generation

    enqueueWith(test.store, handle.lease, 'wf-1')
    enqueueWith(test.store, handle.lease, 'wf-2')
    enqueueWith(test.store, handle.lease, 'wf-3')
    scheduler.start()

    assert.equal(loadStatus(test.store, 'wf-3'), 'queued')

    const leased1 = test.store.load('wf-1')!
    test.store.update('wf-1', leased1.state_revision, handle.lease, (record) => {
      record.status = 'completed'
      if (record.launch_intent) record.launch_intent = { ...record.launch_intent, launch_state: 'settled', settled_at: new Date(clock).toISOString() }
      return record
    })

    scheduler.start()
    assert.equal(loadStatus(test.store, 'wf-3'), 'leased')

    handle.dispose()
  })

  it('preserves leased workflows as paused during authoritative scheduler disposal', () => {
    const dir = tempDir('queue-scheduler-takeover-')
    const store = new QueueStore({ config_directory: dir, owner: 'test-scheduler', now: clockNow })

    const schedulerA = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleA = schedulerA.start()
    enqueueWith(store, handleA.lease, 'wf-1')
    schedulerA.start()
    assert.equal(loadStatus(store, 'wf-1'), 'leased')

    handleA.dispose()

    const afterDispose = store.load('wf-1')!
    assert.equal(afterDispose.status, 'paused')
    assert.notEqual(afterDispose.launch_intent, null)
    assert.equal(afterDispose.launch_intent!.launch_state, 'ambiguous')
  })

  it('recovers a crashed scheduler by reconciling reserved launch intents as paused', async () => {
    const dir = tempDir('queue-scheduler-crash-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    seedLeasedWorkflow(store, handleA, 'wf-1', 'reserved')

    advance(61_000)

    const schedulerB = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleB = schedulerB.start()
    assert.notEqual(handleB.generation, handleA.lease.fencing_generation)
    await handleB.recover()

    const record = store.load('wf-1')!
    assert.equal(record.status, 'paused')
    assert.equal(record.launch_intent!.launch_state, 'ambiguous')
    assert.equal(record.fencing_generation, handleB.generation)

    handleB.dispose()
  })

  it('never dispatches a takeover generation before attended recovery', async () => {
    const dir = tempDir('queue-scheduler-recovery-gate-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const firstLease = store.getLeaseStore().acquire()
    store.enqueue(workflowInput('wf-queued'), firstLease)
    firstLease.release()
    let dispatchCount = 0

    const scheduler = new QueueScheduler({
      store,
      config: queueConfig(1),
      now: clockNow,
      onWorkflowReady: () => { dispatchCount++ },
    })
    const handle = scheduler.start()
    scheduler.schedule()

    assert.equal(handle.generation > 1, true)
    assert.equal(scheduler.recoveryRequired, true)
    assert.equal(dispatchCount, 0)
    assert.equal(loadStatus(store, 'wf-queued'), 'queued')

    const recovered = await scheduler.recover()
    assert.equal(recovered.recovered, true)
    scheduler.schedule()
    assert.equal(dispatchCount, 1)
    handle.dispose()
  })

  it('skips workflows with settled launch intents during recovery', async () => {
    const dir = tempDir('queue-scheduler-settled-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    seedLeasedWorkflow(store, handleA, 'wf-1', 'settled')

    advance(61_000)

    const schedulerB = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleB = schedulerB.start()
    await handleB.recover()

    const record = store.load('wf-1')!
    assert.equal(record.status, 'paused')
    assert.equal(record.launch_intent!.launch_state, 'settled')

    handleB.dispose()
  })

  it('pauses capacity-consuming records that have no durable launch evidence', async () => {
    const dir = tempDir('queue-scheduler-missing-intent-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    const queued = store.enqueue(workflowInput('wf-missing-intent'), handleA)
    store.update(queued.workflow_id, queued.state_revision, handleA, record => {
      record.status = 'leased'
      return record
    })
    advance(61_000)

    const schedulerB = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleB = schedulerB.start({ schedule: false })
    await schedulerB.recover()

    const recovered = store.load(queued.workflow_id)!
    assert.equal(recovered.status, 'paused')
    assert.match(recovered.pause_reason!, /lacks durable launch evidence/)
    assert.equal(recovered.fencing_generation, handleB.generation)
    handleB.dispose()
  })

  it('renews the lease periodically via the interval callback', () => {
    const test = fixture(2)
    let renewalCalled = false
    const scheduler = new QueueScheduler({
      store: test.store,
      config: test.config,
      now: clockNow,
      interval: (callback) => { renewalCalled = true; callback(); return null },
      clearInterval: () => {},
    })
    const handle = scheduler.start()
    assert.ok(renewalCalled)
    assert.equal(test.store.getLeaseStore().isHeld(), true)
    handle.dispose()
  })

  it('rejects start when config is incomplete', () => {
    const test = fixture()
    const incomplete = { ...test.config, max_concurrent_workflows: undefined } as unknown as EnabledQueueConfig
    assert.throws(
      () => new QueueScheduler({ store: test.store, config: incomplete, now: clockNow }),
      (err: Error) => err instanceof QueueSchedulerError && err.code === 'config_incomplete',
    )
  })

  it('rejects start when renewal_interval_ms is not less than lease_duration_ms', () => {
    const test = fixture()
    const invalid = queueConfig(2, 30_000, 30_000)
    assert.throws(
      () => new QueueScheduler({ store: test.store, config: invalid, now: clockNow }),
      (err: Error) => err instanceof QueueSchedulerError && err.code === 'config_invalid',
    )
  })

  it('dispose releases the lease and stops scheduling', () => {
    const test = fixture(2)
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    const handle = scheduler.start()
    assert.equal(test.store.getLeaseStore().isHeld(), true)
    handle.dispose()
    assert.equal(test.store.getLeaseStore().isHeld(), false)
  })

  it('rejects recovery when no lease is held', async () => {
    const test = fixture(2)
    const scheduler = new QueueScheduler({ store: test.store, config: test.config, now: clockNow })
    await assert.rejects(scheduler.recover(), (err: Error) => err instanceof QueueSchedulerError && err.code === 'no_lease')
  })

  it('reconciles mixed recoverable and settled workflows in a single recovery pass', async () => {
    const dir = tempDir('queue-scheduler-mixed-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    seedLeasedWorkflow(store, handleA, 'wf-reserved', 'reserved')
    seedLeasedWorkflow(store, handleA, 'wf-settled', 'settled')
    seedLeasedWorkflow(store, handleA, 'wf-ambiguous', 'ambiguous')

    advance(61_000)

    const schedulerB = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleB = schedulerB.start()
    await handleB.recover()

    const reservedRecord = store.load('wf-reserved')!
    assert.equal(reservedRecord.status, 'paused')
    assert.equal(reservedRecord.launch_intent!.launch_state, 'ambiguous')

    const settledRecord = store.load('wf-settled')!
    assert.equal(settledRecord.status, 'paused')
    assert.equal(settledRecord.launch_intent!.launch_state, 'settled')

    const ambiguousRecord = store.load('wf-ambiguous')!
    assert.equal(ambiguousRecord.status, 'paused')
    assert.equal(ambiguousRecord.launch_intent!.launch_state, 'ambiguous')

    handleB.dispose()
  })

  it('does not schedule before recovery completes', () => {
    const { dir, store, config } = fixture(2)
    const scheduler = new QueueScheduler({ store, config, now: clockNow, onWorkflowReady: () => { /* should not be called */ } })

    // Enqueue a workflow before the scheduler starts.
    const leaseStore = store.getLeaseStore()
    const handle = leaseStore.acquire()
    store.enqueue(workflowInput('wf-queued'), handle)
    handle.release()

    // Start the scheduler in recovery mode (no scheduling).
    const recoverHandle = scheduler.start({ schedule: false })
    // The queued workflow must NOT be admitted during recovery.
    const record = store.load('wf-queued')
    assert.equal(record!.status, 'queued')

    // Run recovery — it should reconcile the record without dispatching.
    scheduler.recover().then((result) => {
      assert.equal(result.recovered, true)
      // After recovery, the record is re-stamped but not dispatched.
      const afterRecovery = store.load('wf-queued')
      assert.equal(afterRecovery!.status, 'queued')
    })

    recoverHandle.dispose()
  })

  it('one reconciliation failure prevents scheduling activation', async () => {
    const { store, config } = fixture(2)
    let dispatchCount = 0
    const scheduler = new QueueScheduler({
      store,
      config,
      now: clockNow,
      onWorkflowReady: () => { dispatchCount++ },
    })

    const leaseStore = store.getLeaseStore()
    const handle = leaseStore.acquire()
    store.enqueue(workflowInput('wf-normal'), handle)
    store.enqueue(workflowInput('wf-other'), handle)
    handle.release()

    const reconcile = store.reconcile.bind(store)
    store.reconcile = ((workflowId, ...args) => {
      if (workflowId === 'wf-normal') throw new Error('simulated reconciliation failure')
      return reconcile(workflowId, ...args)
    }) as typeof store.reconcile

    const recoverHandle = scheduler.start({ schedule: false })
    const result = await scheduler.recover()

    assert.equal(result.recovered, false)
    assert.equal(result.failed, 1)
    assert.equal(scheduler.recoveryRequired, true)
    scheduler.schedule()
    assert.equal(dispatchCount, 0)
    assert.equal(store.load('wf-normal')!.status, 'queued')
    assert.equal(store.load('wf-other')!.status, 'queued')

    recoverHandle.dispose()
  })

  it('reconciles persisted engine outcomes instead of stranding terminal workflows as paused', async () => {
    const dir = tempDir('queue-scheduler-terminal-recovery-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    for (const id of ['wf-paused', 'wf-completed', 'wf-failed', 'wf-cancelled']) {
      seedLeasedWorkflow(store, handleA, id, 'created')
    }
    advance(61_000)
    const outcomes = {
      'wf-paused': 'paused',
      'wf-completed': 'completed',
      'wf-failed': 'failed',
      'wf-cancelled': 'cancelled',
    } as const
    const scheduler = new QueueScheduler({
      store,
      config: queueConfig(4),
      now: clockNow,
      onRecoverLaunch: async record => ({
        status: outcomes[record.workflow_id as keyof typeof outcomes],
        pause_reason: record.workflow_id === 'wf-paused' ? 'Resume explicitly.' : null,
        child_session_ids: [`child-${record.workflow_id}`],
      }),
    })
    const handleB = scheduler.start({ schedule: false })

    assert.equal((await scheduler.recover()).recovered, true)
    for (const [id, status] of Object.entries(outcomes)) {
      const record = store.load(id)!
      assert.equal(record.status, status)
      assert.equal(record.launch_intent!.launch_state, 'settled')
      assert.deepEqual(record.launch_intent!.child_session_ids, [`child-${id}`])
    }
    handleB.dispose()
  })

  it('coalesces concurrent recovery calls into one reconciliation pass', async () => {
    const dir = tempDir('queue-scheduler-concurrent-recovery-')
    const store = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const handleA = store.getLeaseStore().acquire()
    seedLeasedWorkflow(store, handleA, 'wf-created', 'created')
    advance(61_000)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let callbacks = 0
    const scheduler = new QueueScheduler({
      store,
      config: queueConfig(1),
      now: clockNow,
      onRecoverLaunch: async () => {
        callbacks++
        await gate
        return { status: 'paused', pause_reason: 'Recovered.', child_session_ids: ['child-1'] }
      },
    })
    const handleB = scheduler.start({ schedule: false })

    const first = scheduler.recover()
    const second = scheduler.recover()
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    assert.deepEqual(firstResult, secondResult)
    assert.equal(callbacks, 1)
    assert.equal(scheduler.recoveryRequired, false)
    handleB.dispose()
  })

  it('consumes capacity when a synchronous dispatch callback fails after durable admission', () => {
    const { store, config } = fixture(1)
    const scheduler = new QueueScheduler({
      store,
      config,
      now: clockNow,
      onWorkflowReady: () => { throw new Error('simulated callback failure') },
    })
    const handle = scheduler.start({ schedule: false })
    store.enqueue(workflowInput('wf-first'), handle.lease)
    store.enqueue(workflowInput('wf-second'), handle.lease)

    scheduler.schedule()

    assert.equal(store.load('wf-first')!.status, 'paused')
    assert.equal(store.load('wf-first')!.failure_classification, 'transport')
    assert.equal(store.load('wf-first')!.launch_intent!.launch_state, 'settled')
    assert.equal(store.load('wf-second')!.status, 'queued')
    handle.dispose()
  })
})
