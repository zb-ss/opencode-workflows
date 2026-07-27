import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { FencingLeaseStore } from '../../lib/fencing-lease.ts'
import { QueueStore, QueueStoreError } from '../../lib/queue-store.ts'
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

function fixture() {
  const dir = tempDir('queue-store-')
  const leaseStore = new FencingLeaseStore({
    lease_directory: path.join(dir, 'lease'),
    lock_directory: dir,
    owner: 'test-scheduler',
    lease_duration_ms: 60_000,
    now: clockNow,
  })
  const handle = leaseStore.acquire()
  const store = new QueueStore({
    config_directory: dir,
    owner: 'test-scheduler',
    now: clockNow,
  })
  return { dir, leaseStore, handle, store, generation: handle.lease.fencing_generation }
}

function workflowInput(id = 'wf-1') {
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

describe('QueueStore', () => {
  it('enqueues a workflow with fencing generation and revision 1', () => {
    const test = fixture()
    const record = test.store.enqueue(workflowInput(), test.handle)

    assert.equal(record.status, 'queued')
    assert.equal(record.state_revision, 1)
    assert.equal(record.fencing_generation, test.generation)
    assert.equal(record.launch_intent, null)
  })

  it('loads an enqueued workflow by ID', () => {
    const test = fixture()
    test.store.enqueue(workflowInput(), test.handle)
    const loaded = test.store.load('wf-1')

    assert.notEqual(loaded, null)
    assert.equal(loaded!.workflow_id, 'wf-1')
    assert.equal(loaded!.status, 'queued')
  })

  it('returns null for unknown workflow ID', () => {
    const test = fixture()
    assert.equal(test.store.load('nonexistent'), null)
  })

  it('rejects duplicate enqueue with already_exists', () => {
    const test = fixture()
    test.store.enqueue(workflowInput(), test.handle)
    assert.throws(
      () => test.store.enqueue(workflowInput(), test.handle),
      (err: Error) => err instanceof QueueStoreError && err.code === 'already_exists',
    )
  })

  it('updates a workflow with CAS on revision and generation', () => {
    const test = fixture()
    const initial = test.store.enqueue(workflowInput(), test.handle)

    const updated = test.store.update('wf-1', initial.state_revision, test.handle, (record) => {
      record.status = 'leased'
      return record
    })

    assert.equal(updated.status, 'leased')
    assert.equal(updated.state_revision, 2)
  })

  it('rejects update with stale revision', () => {
    const test = fixture()
    const initial = test.store.enqueue(workflowInput(), test.handle)

    assert.throws(
      () => test.store.update('wf-1', initial.state_revision + 99, test.handle, () => initial),
      (err: Error) => err instanceof QueueStoreError && err.code === 'stale_revision',
    )
  })

  it('rejects update with stale fencing generation', () => {
    const test = fixture()
    const initial = test.store.enqueue(workflowInput(), test.handle)

    // Simulate this scheduler losing authority and a new scheduler taking over.
    // Expire the current lease and acquire a new, higher-generation lease in a
    // separate store; passing the original handle should be rejected.
    advance(61_000)
    const newLeaseStore = new FencingLeaseStore({
      lease_directory: path.join(test.dir, 'lease'),
      lock_directory: test.dir,
      owner: 'test-scheduler-next',
      lease_duration_ms: 60_000,
      now: clockNow,
    })
    const newHandle = newLeaseStore.acquire()
    assert.ok(newHandle.lease.fencing_generation > test.generation, 'new generation should exceed the original')

    assert.throws(
      () => test.store.update('wf-1', initial.state_revision, test.handle, () => initial),
      (err: Error) => err instanceof Error && /generation|lease/.test(err.message),
    )
  })

  it('rebuilds the index from persisted workflow records', () => {
    const test = fixture()
    test.store.enqueue(workflowInput('wf-a'), test.handle)
    advance(1000)
    test.store.enqueue(workflowInput('wf-b'), test.handle)
    advance(1000)
    test.store.enqueue(workflowInput('wf-c'), test.handle)

    const index = test.store.rebuildIndex()
    assert.equal(index.length, 3)
    assert.equal(index[0].workflow_id, 'wf-a')
    assert.equal(index[1].workflow_id, 'wf-b')
    assert.equal(index[2].workflow_id, 'wf-c')
    assert.equal(index.every(e => e.fencing_generation === test.generation), true)
  })

  it('skips corrupt records during index rebuild', () => {
    const test = fixture()
    test.store.enqueue(workflowInput('wf-a'), test.handle)
    test.store.enqueue(workflowInput('wf-b'), test.handle)

    const corruptPath = path.join(test.dir, 'workflows', 'wf-corrupt.json')
    fs.writeFileSync(corruptPath, '{ invalid json', { mode: 0o600 })

    assert.throws(
      () => test.store.rebuildIndex(),
      (err: Error) => err instanceof QueueStoreError && err.code === 'record_corrupt',
    )
  })

  it('returns empty index when no workflows exist', () => {
    const test = fixture()
    assert.deepEqual(test.store.rebuildIndex(), [])
  })

  it('persists launch intent through update', () => {
    const test = fixture()
    const initial = test.store.enqueue(workflowInput(), test.handle)

    const updated = test.store.update('wf-1', initial.state_revision, test.handle, (record) => {
      record.status = 'leased'
      record.launch_intent = {
        intent_id: 'intent-1',
        workflow_id: 'wf-1',
        fencing_generation: test.generation,
        session_id: null,
        agent: 'wf-executor',
        model: 'provider/model',
        launch_state: 'reserved',
        reserved_at: new Date(clock).toISOString(),
        created_at: null,
        prompted_at: null,
        settled_at: null,
      }
      return record
    })

    assert.equal(updated.status, 'leased')
    assert.notEqual(updated.launch_intent, null)
    assert.equal(updated.launch_intent!.launch_state, 'reserved')

    const reloaded = test.store.load('wf-1')
    assert.equal(reloaded!.launch_intent!.intent_id, 'intent-1')
  })

  it('survives a simulated crash and rebuilds from persisted records', () => {
    const dir = tempDir('queue-crash-')
    const leaseStore = new FencingLeaseStore({
      lease_directory: path.join(dir, 'lease'),
      lock_directory: dir,
      owner: 'proc-a',
      lease_duration_ms: 60_000,
      now: clockNow,
    })
    const handle = leaseStore.acquire()
    const gen = handle.lease.fencing_generation

    const store1 = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    store1.enqueue(workflowInput('wf-a'), handle)
    const initial = store1.enqueue(workflowInput('wf-b'), handle)
    store1.update('wf-b', initial.state_revision, handle, (r) => { r.status = 'leased'; return r })

    const store2 = new QueueStore({ config_directory: dir, owner: 'proc-b', now: clockNow })
    const index = store2.rebuildIndex()
    assert.equal(index.length, 2)
    assert.equal(index.find(e => e.workflow_id === 'wf-b')!.status, 'leased')

    const loaded = store2.load('wf-b')
    assert.equal(loaded!.status, 'leased')
    assert.equal(loaded!.state_revision, 2)
  })

  it('a stale generation cannot commit a queue record after a newer generation takes over', () => {
    const dir = tempDir('queue-fence-takeover-')

    // Process A acquires generation 1 and enqueues a workflow.
    const leaseStoreA = new FencingLeaseStore({
      lease_directory: path.join(dir, 'lease'),
      lock_directory: dir,
      owner: 'proc-a',
      lease_duration_ms: 60_000,
      now: clockNow,
    })
    const handleA = leaseStoreA.acquire()
    assert.equal(handleA.lease.fencing_generation, 1)
    const storeA = new QueueStore({ config_directory: dir, owner: 'proc-a', now: clockNow })
    const initial = storeA.enqueue(workflowInput(), handleA)

    // A's lease expires. Process B acquires generation 2.
    advance(61_000)
    const leaseStoreB = new FencingLeaseStore({
      lease_directory: path.join(dir, 'lease'),
      lock_directory: dir,
      owner: 'proc-b',
      lease_duration_ms: 60_000,
      now: clockNow,
    })
    const handleB = leaseStoreB.acquire()
    assert.equal(handleB.lease.fencing_generation, 2)

    // A (with its stale generation 1 handle) must NOT be able to update
    // the queue record. The shared lock guarantees that lease validation
    // and queue writes are atomic: B's takeover happened under the same
    // lock, so A's stale authority is detected before the write commits.
    assert.throws(
      () => storeA.update('wf-1', initial.state_revision, handleA, (record) => {
        record.status = 'paused'
        record.pause_reason = 'stale writer committed'
        return record
      }),
      (err: Error) => err instanceof Error && /generation|lease|stale/.test(err.message),
    )

    // The record must still be in its original state (queued, revision 1).
    const reloaded = storeA.load('wf-1')
    assert.equal(reloaded!.status, 'queued')
    assert.equal(reloaded!.state_revision, 1)
    assert.equal(reloaded!.fencing_generation, 1)

    // B (generation 2) can write successfully.
    const updated = storeA.update('wf-1', initial.state_revision, handleB, (record) => {
      record.status = 'leased'
      return record
    })
    assert.equal(updated.status, 'leased')
    assert.equal(updated.fencing_generation, 2)
  })
})