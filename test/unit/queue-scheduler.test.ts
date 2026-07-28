import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { QueueScheduler, QueueSchedulerError } from '../../lib/queue-scheduler.ts'
import type { EnabledQueueConfig } from '../../lib/queue-policy.ts'
import { QueueStore } from '../../lib/queue-store.ts'
import type { QueueWorkflowRecord } from '../../lib/queue-contracts.ts'

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

function seedLeasedWorkflow(store: QueueStore, handle: import('../../lib/fencing-lease.ts').FencingLeaseHandle, id: string, launchState: 'reserved' | 'settled'): QueueWorkflowRecord {
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
      engine_instance_id: null,
      agent: 'standard',
      model: 'development',
      launch_state: launchState,
      reserved_at: new Date(clock).toISOString(),
      created_at: launchState === 'settled' ? new Date(clock).toISOString() : null,
      prompted_at: launchState === 'settled' ? new Date(clock).toISOString() : null,
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

  it('preserves leased workflows as paused when the lease expires and a new scheduler takes over', () => {
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
    assert.equal(record.status, 'leased')
    assert.equal(record.launch_intent!.launch_state, 'settled')

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

    advance(61_000)

    const schedulerB = new QueueScheduler({ store, config: queueConfig(2), now: clockNow })
    const handleB = schedulerB.start()
    await handleB.recover()

    const reservedRecord = store.load('wf-reserved')!
    assert.equal(reservedRecord.status, 'paused')
    assert.equal(reservedRecord.launch_intent!.launch_state, 'ambiguous')

    const settledRecord = store.load('wf-settled')!
    assert.equal(settledRecord.status, 'leased')
    assert.equal(settledRecord.launch_intent!.launch_state, 'settled')

    handleB.dispose()
  })
})