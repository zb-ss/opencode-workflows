import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  deriveEpicWorktreeIdentity,
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  projectIdentitySha256,
  reserveEpicAttempt,
  reserveEpicReviewSession,
  validateEpicTransition,
  type EpicState,
} from '../../lib/epic-contracts.ts'
import type { EpicCoordinatorRuntime, EpicSessionAdapter } from '../../lib/epic-coordinator.ts'
import { openEpicStore, type EpicLoadResult, type EpicStoreHandle } from '../../lib/epic-persistence.ts'
import { recoverEpic } from '../../lib/epic-recovery.ts'

const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)
const NOW = '2026-07-22T12:00:00.000Z'
const LATER = '2026-07-22T12:00:01.000Z'
const CONFIG = {
  enabled: true,
  max_epic_items: 8,
  max_item_dependencies: 4,
  max_attempts_per_item: 3,
  max_budget_records: 16,
  executor_agent: 'executor-example',
  executor_model_tier: 'mid',
  reviewer_agent: 'reviewer-example',
  reviewer_model_tier: 'mid',
  max_parallel_sessions: 2,
  max_attempt_duration_ms: 60_000,
  active_time_checkpoint_ms: 10_000,
  max_result_bytes: 65_536,
  retry_policy: {
    max_semantic_attempts: 3,
    max_contract_attempts: 3,
    max_transport_attempts: 3,
    max_no_progress_attempts: 2,
    transport_backoff: { strategy: 'exponential', initial_delay_ms: 100, maximum_delay_ms: 1_000, multiplier: 2 },
  },
} as const
const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

function worktreeEvidence() {
  return {
    ...deriveEpicWorktreeIdentity('epic-example', 'item-a', 'attempt-1'),
    base_commit: OID('0'),
    worktree_path_sha256: SHA('1'),
    worktree_directory_dev: '1',
    worktree_directory_ino: '2',
    git_common_directory_sha256: SHA('2'),
    git_common_directory_dev: '3',
    git_common_directory_ino: '4',
  }
}

function genesis(project: string): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: { max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 },
    epic_id: 'epic-example',
    root_session_id: 'root-example',
    project_identity_sha256: projectIdentitySha256(fs.realpathSync(project)),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/integration',
    status: 'pending',
    pause_reason: null,
    pause_code: null,
    created_at: NOW,
    updated_at: NOW,
    items: {
      'item-a': {
        item_id: 'item-a', dependencies: [], scope: 'Implement the item.', status: 'pending', attempts: [],
        selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null,
        review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null,
      },
    },
    integration_log: [],
    usage: [
      { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
      { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
    ],
    budget_updates: [],
    coordination_policy: {
      policy_version: 1,
      executor_agent: CONFIG.executor_agent,
      executor_candidates: [{ model: 'provider/executor' }],
      reviewer_agent: CONFIG.reviewer_agent,
      reviewer_candidates: [{ model: 'provider/reviewer' }],
      max_parallel_sessions: 2,
      provider_concurrency: { provider: 2 },
      retry_policy: CONFIG.retry_policy,
      max_attempt_duration_ms: CONFIG.max_attempt_duration_ms,
      active_time_checkpoint_ms: CONFIG.active_time_checkpoint_ms,
      max_result_bytes: CONFIG.max_result_bytes,
      provider_cost_reporting: { provider: { status: 'unknown' } },
    },
    integration_intent: null,
  }
}

function append(store: EpicStoreHandle, mutate: (state: EpicState) => EpicState): EpicLoadResult {
  const loaded = store.load()!
  const next = validateEpicTransition(loaded.state, mutate(structuredClone(loaded.state)))
  return store.append(next, loaded.revision, loaded.state_sha256, loaded.ownership_generation)!
}

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-recovery-'))
  const project = path.join(parent, 'project')
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, 'config')
  fs.mkdirSync(project)
  temporaryDirectories.add(parent)
  const store = openEpicStore({
    root_session_id: 'root-example', project_root: project, epic_id: 'epic-example', config: CONFIG,
    runtime_incarnation: 'runtime-before-restart', mode: 'read_write',
  })
  store.append(genesis(project), 0, null, 1)
  append(store, (state) => {
    state.state_revision++
    state.status = 'running'
    state.items['item-a']!.status = 'queued'
    return state
  })
  return { project, store }
}

function reserveExecution(store: EpicStoreHandle): EpicLoadResult {
  const loaded = store.load()!
  const next = reserveEpicAttempt(loaded.state, {
    item_id: 'item-a', attempt_id: 'attempt-1', launch_id: 'launch-1', agent: CONFIG.executor_agent,
    model: 'provider/executor', worktree_evidence: worktreeEvidence(), reserved_at: LATER,
  })
  return store.append(next, loaded.revision, loaded.state_sha256, loaded.ownership_generation)!
}

function checkpointExecution(store: EpicStoreHandle): EpicLoadResult {
  append(store, (state) => {
    const attempt = state.items['item-a']!.attempts[0]!
    state.state_revision++
    attempt.child_session_id = 'executor-child'
    attempt.launch_state = 'created'
    return state
  })
  append(store, (state) => {
    state.state_revision++
    state.items['item-a']!.attempts[0]!.launch_state = 'prompted'
    return state
  })
  append(store, (state) => {
    const attempt = state.items['item-a']!.attempts[0]!
    state.state_revision++
    attempt.progress_commit = OID('1')
    attempt.progress_tree_sha256 = SHA('3')
    return state
  })
  return append(store, (state) => {
    const attempt = state.items['item-a']!.attempts[0]!
    state.state_revision++
    attempt.status = 'checkpointed'
    attempt.checkpoint_commit = OID('1')
    attempt.checkpoint_tree_sha256 = SHA('3')
    return state
  })
}

const session: EpicSessionAdapter = {
  async create() { throw new Error('not used') },
  async prompt() { throw new Error('not used') },
  async abort() {},
  async inspect() { return { status: 'completed' } },
}

const runtime = (project: string): EpicCoordinatorRuntime => ({
  createWorktree() { throw new Error('not used') },
  worktreePath() { return project },
  inspectWorktree(_project, attempt) {
    return {
      path: project, evidence: attempt.worktree_evidence, head_commit: OID('1'), changed_files: [],
      diff_stat: '', has_changes: false, has_conflicts: false,
    }
  },
  checkpointWorktree() { throw new Error('not used') },
  reviewPatch() { throw new Error('not used') },
  cleanupUnused() { return false },
  cleanupIntegrated() { return false },
  integrationHead() { return OID('0') },
  integrate() { throw new Error('not used') },
  mergeParents() { return [] },
  verifyRecoveredIntegration() {},
})

async function recover(project: string, previous: EpicLoadResult) {
  const restarted = openEpicStore({
    root_session_id: 'root-example', project_root: project, epic_id: 'epic-example', config: CONFIG,
    runtime_incarnation: 'runtime-after-restart', mode: 'read_write',
  })
  return recoverEpic({
    store: restarted, project_root: project, session, runtime: runtime(project), now: () => Date.parse(LATER),
    expected_revision: previous.revision, expected_state_sha256: previous.state_sha256,
    expected_generation: previous.ownership_generation, former_runtime_terminated: true,
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('attended epic recovery', { concurrency: false }, () => {
  it('classifies a reserved execution as ambiguous and advances ownership generation', async () => {
    const test = fixture()
    const reserved = reserveExecution(test.store)

    const result = await recover(test.project, reserved)
    const attempt = result.loaded.state.items['item-a']!.attempts[0]!

    assert.equal(result.ambiguous, true)
    assert.equal(result.loaded.ownership_generation, 2)
    assert.equal(result.loaded.state.pause_code, 'ambiguous_execution_launch')
    assert.equal(result.loaded.state.items['item-a']!.status, 'failed')
    assert.equal(attempt.status, 'failed')
    assert.equal(attempt.launch_state, 'ambiguous')
  })

  it('classifies a reserved reviewer independently from a completed executor', async () => {
    const test = fixture()
    reserveExecution(test.store)
    checkpointExecution(test.store)
    const loaded = test.store.load()!
    const reservation = reserveEpicReviewSession(loaded.state, {
      item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1', agent: CONFIG.reviewer_agent,
      model: 'provider/reviewer', reserved_at: LATER,
    })
    const reviewing = test.store.append(reservation.state, loaded.revision, loaded.state_sha256, loaded.ownership_generation)!

    const result = await recover(test.project, reviewing)
    const attempt = result.loaded.state.items['item-a']!.attempts[0]!

    assert.equal(result.loaded.state.pause_code, 'ambiguous_reviewer_launch')
    assert.equal(attempt.launch_state, 'settled')
    assert.equal(attempt.review?.launch_state, 'ambiguous')
    assert.equal(attempt.status, 'failed')
  })

  it('cancels a conclusively terminated dispatched child and permits attended resume', async () => {
    const test = fixture()
    reserveExecution(test.store)
    append(test.store, (state) => {
      const attempt = state.items['item-a']!.attempts[0]!
      state.state_revision++
      attempt.child_session_id = 'executor-child'
      attempt.launch_state = 'created'
      return state
    })
    const prompted = append(test.store, (state) => {
      state.state_revision++
      state.items['item-a']!.attempts[0]!.launch_state = 'prompted'
      return state
    })

    const result = await recover(test.project, prompted)
    const attempt = result.loaded.state.items['item-a']!.attempts[0]!

    assert.equal(result.ambiguous, false)
    assert.equal(result.loaded.state.pause_code, 'operator_reconciled')
    assert.equal(result.loaded.state.items['item-a']!.status, 'cancelled')
    assert.equal(attempt.status, 'cancelled')
    assert.equal(attempt.launch_state, 'settled')
  })

  it('cancels an undispatched checkpoint without fabricating launch ambiguity', async () => {
    const test = fixture()
    reserveExecution(test.store)
    const checkpointed = checkpointExecution(test.store)

    const result = await recover(test.project, checkpointed)
    const attempt = result.loaded.state.items['item-a']!.attempts[0]!

    assert.equal(result.ambiguous, false)
    assert.equal(result.loaded.state.pause_code, 'operator_reconciled')
    assert.equal(result.loaded.state.items['item-a']!.status, 'cancelled')
    assert.equal(attempt.status, 'cancelled')
    assert.equal(attempt.launch_state, 'settled')
  })

  it('rejects stale evidence and missing former-runtime confirmation without mutation', async () => {
    const test = fixture()
    const queued = test.store.load()!
    const restarted = openEpicStore({
      root_session_id: 'root-example', project_root: test.project, epic_id: 'epic-example', config: CONFIG,
      runtime_incarnation: 'runtime-after-restart', mode: 'read_write',
    })
    const input = {
      store: restarted, project_root: test.project, session, runtime: runtime(test.project), now: () => Date.parse(LATER),
      expected_revision: queued.revision, expected_state_sha256: queued.state_sha256,
      expected_generation: queued.ownership_generation,
    }

    await assert.rejects(recoverEpic({ ...input, former_runtime_terminated: false }), /former runtime terminated/)
    await assert.rejects(recoverEpic({ ...input, expected_revision: queued.revision - 1, former_runtime_terminated: true }), /CAS evidence is stale/)
    assert.equal(restarted.load()!.ownership_generation, 1)
  })
})
