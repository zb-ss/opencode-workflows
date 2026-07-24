import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EPIC_SCHEMA_VERSION,
  assessEpicRetry,
  calculateEpicTransportRetryNotBefore,
  deriveEpicRetryCounters,
  deriveEpicWorktreeIdentity,
  emptyAutomationUsageTelemetry,
  type EpicAttempt,
  type EpicRetryPolicy,
  type EpicState,
} from '../../lib/epic-contracts.ts'

const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)
const NOW = '2026-07-22T12:00:00.000Z'

function retryPolicy(overrides: Partial<EpicRetryPolicy> = {}): EpicRetryPolicy {
  return {
    max_semantic_attempts: 3,
    max_contract_attempts: 3,
    max_transport_attempts: 3,
    max_no_progress_attempts: 3,
    transport_backoff: { strategy: 'exponential', initial_delay_ms: 100, maximum_delay_ms: 250, multiplier: 2 },
    ...overrides,
  }
}

function failedAttempt(
  attempt_id: string,
  failure_classification: 'semantic' | 'contract' | 'transport' | 'ambiguous_launch' = 'semantic',
  progress_tree_sha256: string | null = SHA('1'),
): EpicAttempt {
  return {
    attempt_id,
    worktree_evidence: {
      ...deriveEpicWorktreeIdentity('epic-example', 'item-a', attempt_id),
      base_commit: OID('0'), worktree_path_sha256: SHA('2'), worktree_directory_dev: '1', worktree_directory_ino: '2',
      git_common_directory_sha256: SHA('3'), git_common_directory_dev: '3', git_common_directory_ino: '4',
    },
    agent: 'executor-example', model: 'example/executor', child_session_id: 'child-example', started_at: NOW, completed_at: NOW,
    checkpoint_commit: null, review_evidence_digest: null, result_summary: 'Failed.', failure_classification, status: 'failed',
    launch_id: `launch-${attempt_id}`, launch_state: failure_classification === 'ambiguous_launch' ? 'ambiguous' : 'settled',
    progress_commit: progress_tree_sha256 === null ? null : OID('1'), progress_tree_sha256, checkpoint_tree_sha256: null, review: null,
  }
}

function retryState(attempts: EpicAttempt[], policy = retryPolicy(), maximum = 3): EpicState {
  const latest = attempts.at(-1)
  const itemStatus = latest?.status === 'cancelled' ? 'cancelled' : 'failed'
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: { max_epic_items: 4, max_item_dependencies: 2, max_attempts_per_item: maximum, max_budget_records: 8 },
    epic_id: 'epic-example', root_session_id: 'root-example', project_identity_sha256: SHA('a'),
    base_branch: 'refs/heads/base', integration_branch: 'refs/heads/integration', status: 'running', pause_reason: null,
    created_at: NOW, updated_at: NOW,
    items: {
      'item-a': {
        item_id: 'item-a', dependencies: [], scope: 'Implement.', status: itemStatus, attempts, selected_attempt_id: null,
        worktree_name: latest?.worktree_evidence.worktree_name ?? null, branch_name: latest?.worktree_evidence.branch_name ?? null,
        checkpoint_commit: null, review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: NOW,
      },
    },
    integration_log: [], usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }], budget_updates: [],
    coordination_policy: {
      policy_version: 1, executor_agent: 'executor-example', executor_candidates: [{ model: 'example/executor' }],
      reviewer_agent: 'reviewer-example', reviewer_candidates: [{ model: 'example/reviewer' }], max_parallel_sessions: 1,
      provider_concurrency: { example: 1 }, retry_policy: policy, max_attempt_duration_ms: 60_000,
      active_time_checkpoint_ms: 10_000, max_result_bytes: 65_536, provider_cost_reporting: { example: { status: 'unknown' } },
    },
  }
}

describe('epic retry derivation', () => {
  it('derives every retry class from a validated state item history', () => {
    const attempts = [failedAttempt('attempt-1', 'semantic'), failedAttempt('attempt-2', 'contract'), failedAttempt('attempt-3', 'transport')]
    const state = retryState(attempts, retryPolicy(), 4)
    assert.deepEqual(deriveEpicRetryCounters(state, 'item-a'), {
      semantic_attempts: 1, contract_attempts: 1, transport_attempts: 1, consecutive_no_progress_attempts: 2,
    })
    assert.equal(assessEpicRetry(state, 'item-a').retry, true)
  })

  it('preserves class-specific ceilings before the generic hard ceiling', () => {
    const cases = [
      ['semantic', 'max_semantic_attempts', 'semantic_ceiling'],
      ['contract', 'max_contract_attempts', 'contract_ceiling'],
      ['transport', 'max_transport_attempts', 'transport_ceiling'],
    ] as const
    for (const [failure, field, reason] of cases) {
      const policy = retryPolicy({ [field]: 1 })
      const decision = assessEpicRetry(retryState([failedAttempt(`attempt-${failure}`, failure)], policy), 'item-a')
      assert.equal(decision.retry, false)
      if (!decision.retry) assert.equal(decision.reason, reason)
    }
    const attempts = [failedAttempt('attempt-1', 'semantic', SHA('1')), failedAttempt('attempt-2', 'contract', SHA('2')), failedAttempt('attempt-3', 'transport', SHA('3'))]
    const hard = assessEpicRetry(retryState(attempts), 'item-a')
    assert.equal(hard.retry, false)
    if (!hard.retry) assert.equal(hard.reason, 'max_attempts_per_item')
  })

  it('never automatically retries ambiguous launches or cancellation', () => {
    const ambiguous = assessEpicRetry(retryState([failedAttempt('attempt-ambiguous', 'ambiguous_launch')]), 'item-a')
    assert.equal(ambiguous.retry, false)
    if (!ambiguous.retry) assert.equal(ambiguous.reason, 'ambiguous_launch')
    const cancelled = { ...failedAttempt('attempt-cancelled'), status: 'cancelled' as const, failure_classification: 'cancelled' as const }
    const decision = assessEpicRetry(retryState([cancelled]), 'item-a')
    assert.equal(decision.retry, false)
    if (!decision.retry) assert.equal(decision.reason, 'cancelled')
  })

  it('uses bounded exponential transport backoff', () => {
    const first = failedAttempt('attempt-1', 'transport')
    assert.equal(calculateEpicTransportRetryNotBefore(retryState([first]), 'item-a'), '2026-07-22T12:00:00.100Z')
    const second = failedAttempt('attempt-2', 'transport')
    assert.equal(calculateEpicTransportRetryNotBefore(retryState([first, second]), 'item-a'), '2026-07-22T12:00:00.200Z')
    const third = failedAttempt('attempt-3', 'transport')
    assert.equal(calculateEpicTransportRetryNotBefore(retryState([first, second, third]), 'item-a'), '2026-07-22T12:00:00.250Z')
  })

  it('breaks repeated no-progress attempts by tree digest', () => {
    const unchanged = [failedAttempt('attempt-1', 'semantic', SHA('4')), failedAttempt('attempt-2', 'semantic', SHA('4'))]
    const blocked = assessEpicRetry(retryState(unchanged, retryPolicy({ max_no_progress_attempts: 1 })), 'item-a')
    assert.equal(blocked.retry, false)
    if (!blocked.retry) assert.equal(blocked.reason, 'no_progress_ceiling')
    const progressed = [...unchanged, failedAttempt('attempt-3', 'semantic', SHA('5'))]
    assert.equal(deriveEpicRetryCounters(retryState(progressed), 'item-a').consecutive_no_progress_attempts, 0)
  })

  it('rejects mixed identities, duplicate IDs, unordered attempts, and non-final active histories', () => {
    const first = failedAttempt('attempt-1')
    const mixed = retryState([{ ...first, worktree_evidence: { ...first.worktree_evidence, item_id: 'item-b' } }])
    assert.throws(() => deriveEpicRetryCounters(mixed, 'item-a'), /containing item/)
    assert.throws(() => deriveEpicRetryCounters(retryState([first, { ...first }]), 'item-a'), /duplicate attempt ID/)
    const earlier = { ...failedAttempt('attempt-2'), started_at: '2026-07-22T11:59:59.000Z' }
    assert.throws(() => deriveEpicRetryCounters(retryState([first, earlier]), 'item-a'), /ordered/)
    const active = { ...first, completed_at: null, result_summary: null, failure_classification: null, status: 'running' as const, launch_state: 'prompted' as const }
    assert.throws(() => deriveEpicRetryCounters(retryState([active, failedAttempt('attempt-2')]), 'item-a'), /final attempt/)
  })
})
