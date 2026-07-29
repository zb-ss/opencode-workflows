import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EPIC_SCHEMA_VERSION,
  assessEpicRetry,
  applyEpicUsageDelta,
  deriveEpicWorktreeIdentity,
  emptyAutomationUsageTelemetry,
  reserveEpicAttempt,
  reserveEpicReviewSession,
  validateEpicTransition,
  type EpicAttempt,
  type EpicBudgetRecord,
  type EpicItem,
  type EpicState,
} from '../../lib/epic-contracts.ts'

const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)
const NOW = '2026-07-22T12:00:00.000Z'
const LATER = '2026-07-22T12:00:01.000Z'
const AT_TWO = '2026-07-22T12:00:02.000Z'
const AT_THREE = '2026-07-22T12:00:03.000Z'

function item(item_id: string, overrides: Partial<EpicItem> = {}): EpicItem {
  return {
    item_id,
    dependencies: [],
    scope: 'Implement the item.',
    status: 'queued',
    attempts: [],
    selected_attempt_id: null,
    worktree_name: null,
    branch_name: null,
    checkpoint_commit: null,
    review_evidence_digest: null,
    conflict_paths: [],
    integration_commit: null,
    completed_at: null,
    ...overrides,
  }
}

function retryPolicy() {
  return {
    max_semantic_attempts: 3,
    max_contract_attempts: 3,
    max_transport_attempts: 3,
    max_no_progress_attempts: 2,
    transport_backoff: { strategy: 'exponential' as const, initial_delay_ms: 100, maximum_delay_ms: 1000, multiplier: 2 },
  }
}

function baseState(overrides: Partial<EpicState> = {}): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: { max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 },
    epic_id: 'epic-example',
    root_session_id: 'root-example',
    project_identity_sha256: SHA('a'),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/integration',
    status: 'running',
    pause_reason: null,
    created_at: NOW,
    updated_at: NOW,
    items: { 'item-a': item('item-a') },
    integration_log: [],
    usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }],
    budget_updates: [],
    coordination_policy: {
      policy_version: 1,
      executor_agent: 'executor-example',
      executor_candidates: [{ model: 'example/executor' }],
      reviewer_agent: 'reviewer-example',
      reviewer_candidates: [{ model: 'example/reviewer' }],
      max_parallel_sessions: 2,
      provider_concurrency: { example: 2 },
      retry_policy: retryPolicy(),
      max_attempt_duration_ms: 60_000,
      active_time_checkpoint_ms: 10_000,
      max_result_bytes: 65_536,
      provider_cost_reporting: { example: { status: 'unknown' } },
    },
    ...overrides,
  }
}

function worktreeEvidence(item_id = 'item-a', attempt_id = 'attempt-1') {
  return {
    ...deriveEpicWorktreeIdentity('epic-example', item_id, attempt_id),
    base_commit: OID('0'),
    worktree_path_sha256: SHA('1'),
    worktree_directory_dev: '1',
    worktree_directory_ino: '2',
    git_common_directory_sha256: SHA('2'),
    git_common_directory_dev: '3',
    git_common_directory_ino: '4',
  }
}

function reservation(item_id = 'item-a', attempt_id = 'attempt-1') {
  return {
    item_id,
    attempt_id,
    launch_id: `launch-${attempt_id}`,
    agent: 'executor-example',
    model: 'example/executor',
    worktree_evidence: worktreeEvidence(item_id, attempt_id),
    reserved_at: LATER,
  }
}

function budget(scope: 'epic' | 'item', limit: number, item_id: string | null = null): EpicBudgetRecord {
  return { dimension: 'sessions', scope, item_id, limit, extensions: [] }
}

function checkpointedState(): EpicState {
  const evidence = worktreeEvidence()
  const attempt: EpicAttempt = {
    attempt_id: 'attempt-1',
    worktree_evidence: evidence,
    agent: 'executor-example',
    model: 'example/executor',
    child_session_id: 'child-example',
    started_at: NOW,
    completed_at: null,
    checkpoint_commit: OID('1'),
    review_evidence_digest: null,
    result_summary: null,
    failure_classification: null,
    status: 'checkpointed',
    launch_id: 'launch-attempt-1',
    launch_state: 'prompted',
    progress_commit: OID('1'),
    progress_tree_sha256: SHA('3'),
    checkpoint_tree_sha256: SHA('3'),
    review: null,
  }
  const active = { ...emptyAutomationUsageTelemetry(), sessions: 1, attempts: 1, active_interval_started_at: NOW, last_active_checkpoint_at: NOW }
  return baseState({
    items: { 'item-a': item('item-a', { status: 'running', attempts: [attempt], worktree_name: evidence.worktree_name, branch_name: evidence.branch_name }) },
    usage: [{ scope: 'epic', item_id: null, usage: active }, { scope: 'item', item_id: 'item-a', usage: active }],
  })
}

describe('epic execution accounting reservations', () => {
  it('admits without budgets and advances item and epic counters before child creation', () => {
    const previous = baseState()
    const next = reserveEpicAttempt(previous, reservation())
    assert.equal(next.state_revision, previous.state_revision + 1)
    assert.equal(next.items['item-a']!.attempts[0]!.launch_state, 'reserved')
    assert.equal(next.items['item-a']!.attempts[0]!.child_session_id, null)
    assert.equal(next.items['item-a']!.status, 'running')
    assert.deepEqual(next.usage.map(record => [record.scope, record.usage.sessions, record.usage.attempts]), [
      ['epic', 1, 1],
      ['item', 1, 1],
    ])
    assert.equal(next.usage[0]!.usage.active_interval_started_at, LATER)
  })

  it('fails closed for epic, item, and zero session limits', () => {
    for (const budgets of [
      [budget('epic', 0)],
      [budget('item', 0, 'item-a')],
      [budget('epic', 0)],
    ]) {
      const state = baseState({
        status: 'pending',
        budgets,
        usage: [
          { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
          ...(budgets[0]!.scope === 'item' ? [{ scope: 'item' as const, item_id: 'item-a', usage: emptyAutomationUsageTelemetry() }] : []),
        ],
      })
      assert.throws(() => reserveEpicAttempt(state, reservation()), /budget/)
    }
  })

  it('admits exactly N sessions for a limit of N', () => {
    const state = baseState({
      status: 'pending',
      budgets: [budget('epic', 1)],
      usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }],
      items: { 'item-a': item('item-a'), 'item-b': item('item-b') },
    })
    const first = reserveEpicAttempt(state, reservation('item-a', 'attempt-1'))
    assert.equal(first.usage[0]!.usage.sessions, 1)
    assert.throws(() => reserveEpicAttempt(first, reservation('item-b', 'attempt-2')), /budget/)
  })

  it('requires every dependency to be integrated and respects retry time and the hard attempt cap', () => {
    const dependencyState = baseState({
      items: {
        'item-a': item('item-a', { status: 'pending' }),
        'item-b': item('item-b', { dependencies: ['item-a'] }),
      },
    })
    assert.throws(() => reserveEpicAttempt(dependencyState, reservation('item-b')), /integrated dependency/)

    const failedAttempt: EpicAttempt = {
      attempt_id: 'attempt-old', worktree_evidence: worktreeEvidence('item-a', 'attempt-old'), agent: 'executor-example', model: 'example/executor',
      child_session_id: 'child-old', started_at: NOW, completed_at: NOW, checkpoint_commit: null, review_evidence_digest: null,
      result_summary: 'Failed.', failure_classification: 'semantic', status: 'failed', launch_id: 'launch-old', launch_state: 'settled',
      progress_commit: null, progress_tree_sha256: null, checkpoint_tree_sha256: null, review: null,
    }
    const delayed = baseState({ items: { 'item-a': item('item-a', { status: 'failed', attempts: [failedAttempt], completed_at: NOW, retry_not_before: '2026-07-22T12:00:02.000Z', worktree_name: failedAttempt.worktree_evidence.worktree_name, branch_name: failedAttempt.worktree_evidence.branch_name }) } })
    assert.throws(() => reserveEpicAttempt(delayed, reservation()), /retry_not_before/)
    const capped = {
      ...delayed,
      operational_limits: { ...delayed.operational_limits, max_attempts_per_item: 1 },
      coordination_policy: { ...delayed.coordination_policy!, retry_policy: retryPolicy() },
      items: { 'item-a': { ...delayed.items['item-a']!, retry_not_before: null } },
    }
    capped.coordination_policy.retry_policy.max_semantic_attempts = 1
    capped.coordination_policy.retry_policy.max_contract_attempts = 1
    capped.coordination_policy.retry_policy.max_transport_attempts = 1
    capped.coordination_policy.retry_policy.max_no_progress_attempts = 1
    assert.throws(() => reserveEpicAttempt(capped, reservation()), /max_attempts_per_item/)
  })
})

describe('review and observed usage accounting', () => {
  it('reserves review sessions against the exact checkpoint without incrementing attempts', () => {
    const previous = checkpointedState()
    const result = reserveEpicReviewSession(previous, {
      item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1', agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER,
    })
    assert.equal(result.state.usage[0]!.usage.sessions, 2)
    assert.equal(result.state.usage[0]!.usage.attempts, 1)
    assert.equal(result.state.usage[1]!.usage.sessions, 2)
    assert.equal(result.state.usage[1]!.usage.attempts, 1)
    assert.equal(result.reservation.checkpoint_commit, OID('1'))
    assert.equal(result.reservation.checkpoint_tree_sha256, SHA('3'))
    assert.equal(result.state.items['item-a']!.attempts[0]!.status, 'reviewing')
    assert.equal(result.state.items['item-a']!.attempts[0]!.review?.launch_state, 'reserved')
    assert.equal(result.state.items['item-a']!.attempts[0]!.review?.child_session_id, null)
    assert.equal(result.state.usage[0]!.usage.active_time_ms, 1000)
    const reloaded = JSON.parse(JSON.stringify(result.state)) as EpicState
    assert.throws(() => reserveEpicReviewSession(reloaded, {
      item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1', agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER,
    }), /exact final checkpointed/)
  })

  it('retains unknown cost and pauses with an explicit reason on usage exhaustion', () => {
    const previous = checkpointedState()
    previous.budgets = [{ dimension: 'input_tokens', scope: 'item', item_id: 'item-a', limit: 10, extensions: [] }]
    const next = applyEpicUsageDelta(previous, {
      item_id: 'item-a', observed_at: LATER, input_tokens: 10, output_tokens: 2, cost_usd: 1,
    })
    assert.equal(next.status, 'paused')
    assert.equal(next.items['item-a']!.status, 'cancelled')
    assert.equal(next.pause_code, 'budget_exhausted')
    assert.match(next.pause_reason!, /item item-a input_tokens/)
    assert.equal(next.usage[0]!.usage.input_tokens, 10)
    assert.equal(next.usage[1]!.usage.output_tokens, 2)
    assert.deepEqual(next.usage[0]!.usage.cost_evidence, { kind: 'unknown' })
    assert.equal(next.usage.every(record => record.usage.active_interval_started_at === null), true)
  })

  it('rejects negative deltas and requires exact checkpointed attempts for review', () => {
    const state = checkpointedState()
    assert.throws(() => applyEpicUsageDelta(state, { item_id: 'item-a', observed_at: LATER, input_tokens: -1, output_tokens: 0, cost_usd: 0 }))
    assert.throws(() => applyEpicUsageDelta(state, { item_id: 'item-a', observed_at: LATER, input_tokens: 0, output_tokens: 0, cost_usd: 0, active_time_ms: 1 } as never))
    assert.throws(() => reserveEpicReviewSession(state, { item_id: 'item-a', attempt_id: 'other', review_id: 'review-1', agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER }), /exact final checkpointed/)
  })

  it('checkpoints concurrent wall time once and settles every active item on epic exhaustion', () => {
    const initial = baseState({
      items: { 'item-a': item('item-a'), 'item-b': item('item-b') },
      budgets: [{ dimension: 'input_tokens', scope: 'epic', item_id: null, limit: 1, extensions: [] }],
    })
    const first = reserveEpicAttempt(initial, reservation('item-a', 'attempt-a'))
    const second = reserveEpicAttempt(first, { ...reservation('item-b', 'attempt-b'), reserved_at: AT_TWO })
    const paused = applyEpicUsageDelta(second, {
      item_id: 'item-a', observed_at: AT_THREE, input_tokens: 1, output_tokens: 0, cost_usd: 0,
    })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.items['item-a']!.status, 'cancelled')
    assert.equal(paused.items['item-b']!.status, 'cancelled')
    assert.equal(paused.items['item-a']!.attempts[0]!.launch_state, 'settled')
    assert.equal(paused.items['item-b']!.attempts[0]!.launch_state, 'settled')
    assert.deepEqual(paused.usage.map(record => [record.item_id, record.usage.active_time_ms]), [
      [null, 2000], ['item-a', 2000], ['item-b', 1000],
    ])
    assert.equal(paused.usage.every(record => record.usage.active_interval_started_at === null), true)
  })

  it('represents uncertain prompted execution and reviewer launches as attended ambiguity without automatic retry', () => {
    const initial = baseState({ budgets: [{ dimension: 'input_tokens', scope: 'epic', item_id: null, limit: 1, extensions: [] }] })
    const reserved = reserveEpicAttempt(initial, reservation())
    const reservedAttempt = reserved.items['item-a']!.attempts[0]!
    const created = validateEpicTransition(reserved, {
      ...reserved,
      state_revision: reserved.state_revision + 1,
      updated_at: AT_TWO,
      items: { 'item-a': { ...reserved.items['item-a']!, attempts: [{ ...reservedAttempt, child_session_id: 'child-created', launch_state: 'created' }] } },
    })
    const createdAttempt = created.items['item-a']!.attempts[0]!
    const prompted = validateEpicTransition(created, {
      ...created,
      state_revision: created.state_revision + 1,
      updated_at: AT_TWO,
      items: { 'item-a': { ...created.items['item-a']!, attempts: [{ ...createdAttempt, launch_state: 'prompted' }] } },
    })
    const executionPaused = applyEpicUsageDelta(prompted, {
      item_id: 'item-a', observed_at: AT_THREE, input_tokens: 1, output_tokens: 0, cost_usd: 0,
    })
    assert.equal(executionPaused.pause_code, 'ambiguous_execution_launch')
    assert.equal(executionPaused.items['item-a']!.attempts[0]!.launch_state, 'ambiguous')
    assert.equal(executionPaused.items['item-a']!.attempts[0]!.failure_classification, 'ambiguous_launch')
    const executionRetry = assessEpicRetry(executionPaused, 'item-a')
    assert.equal(executionRetry.retry, false)
    if (!executionRetry.retry) assert.equal(executionRetry.reason, 'ambiguous_launch')

    const checkpointed = checkpointedState()
    checkpointed.budgets = [{ dimension: 'input_tokens', scope: 'epic', item_id: null, limit: 1, extensions: [] }]
    const reviewReserved = reserveEpicReviewSession(checkpointed, {
      item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1', agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER,
    }).state
    const reviewing = reviewReserved.items['item-a']!.attempts[0]!
    const reviewCreated = validateEpicTransition(reviewReserved, {
      ...reviewReserved,
      state_revision: reviewReserved.state_revision + 1,
      updated_at: AT_TWO,
      items: { 'item-a': { ...reviewReserved.items['item-a']!, attempts: [{ ...reviewing, review: { ...reviewing.review!, child_session_id: 'review-child', launch_state: 'created' } }] } },
    })
    const createdReviewAttempt = reviewCreated.items['item-a']!.attempts[0]!
    const reviewPrompted = validateEpicTransition(reviewCreated, {
      ...reviewCreated,
      state_revision: reviewCreated.state_revision + 1,
      updated_at: AT_TWO,
      items: { 'item-a': { ...reviewCreated.items['item-a']!, attempts: [{
        ...createdReviewAttempt,
        review: { ...createdReviewAttempt.review!, launch_state: 'prompted' },
      }] } },
    })
    const reviewPaused = applyEpicUsageDelta(reviewPrompted, {
      item_id: 'item-a', observed_at: AT_THREE, input_tokens: 1, output_tokens: 0, cost_usd: 0,
    })
    assert.equal(reviewPaused.pause_code, 'ambiguous_reviewer_launch')
    assert.equal(reviewPaused.items['item-a']!.attempts[0]!.review?.launch_state, 'ambiguous')
    assert.equal(reviewPaused.items['item-a']!.status, 'cancelled')
    const reviewRetry = assessEpicRetry(reviewPaused, 'item-a')
    assert.equal(reviewRetry.retry, false)
    if (!reviewRetry.retry) assert.equal(reviewRetry.reason, 'cancelled')
  })

  it('fails closed on safe-integer counter overflow', () => {
    const saturated = baseState({
      usage: [
        { scope: 'epic', item_id: null, usage: { ...emptyAutomationUsageTelemetry(), sessions: Number.MAX_SAFE_INTEGER } },
        { scope: 'item', item_id: 'item-a', usage: { ...emptyAutomationUsageTelemetry(), sessions: Number.MAX_SAFE_INTEGER } },
      ],
    })
    assert.throws(() => reserveEpicAttempt(saturated, reservation()), /represented safely/)
    const active = checkpointedState()
    active.usage = active.usage.map(record => ({ ...record, usage: { ...record.usage, input_tokens: Number.MAX_SAFE_INTEGER } }))
    assert.throws(() => applyEpicUsageDelta(active, { item_id: 'item-a', observed_at: LATER, input_tokens: 1, output_tokens: 0, cost_usd: 0 }), /represented safely/)
  })

  it('enforces identical session budget semantics for execution and review reservations', () => {
    // Table-driven: for each limit, verify execution and review both use the
    // same > limit rule (not >= limit). A limit of N must allow exactly N
    // sessions total (execution + review).
    for (const limit of [0, 1, 2, 3]) {
      for (const scope of ['epic', 'item'] as const) {
        const state = baseState({
          status: 'pending',
          budgets: [budget(scope, limit, scope === 'item' ? 'item-a' : null)],
          usage: [
            { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
            ...(scope === 'item' ? [{ scope: 'item' as const, item_id: 'item-a', usage: emptyAutomationUsageTelemetry() }] : []),
          ],
        })

        // Attempt execution reservation: sessions go from 0 to 1.
        if (limit === 0) {
          // Limit 0: even the first session is rejected.
          assert.throws(() => reserveEpicAttempt(state, reservation()), /budget/, `limit ${limit} ${scope}: execution should be rejected`)
          continue
        }

        const afterExec = reserveEpicAttempt(state, reservation())
        assert.equal(afterExec.usage[0]!.usage.sessions, 1, `limit ${limit} ${scope}: execution reserved session 1`)

        // Checkpoint the execution so a review can be reserved.
        const evidence = worktreeEvidence()
        const execAttempt: EpicAttempt = {
          attempt_id: 'attempt-1',
          worktree_evidence: evidence,
          agent: 'executor-example',
          model: 'example/executor',
          child_session_id: 'child-1',
          started_at: NOW,
          completed_at: null,
          checkpoint_commit: OID('1'),
          review_evidence_digest: null,
          result_summary: null,
          failure_classification: null,
          status: 'checkpointed',
          launch_id: 'launch-1',
          launch_state: 'prompted',
          progress_commit: OID('1'),
          progress_tree_sha256: SHA('3'),
          checkpoint_tree_sha256: SHA('3'),
          review: null,
        }
        const active = { ...emptyAutomationUsageTelemetry(), sessions: 1, attempts: 1, active_interval_started_at: NOW, last_active_checkpoint_at: NOW }
        const checkpointed = {
          ...afterExec,
          items: {
            'item-a': {
              ...afterExec.items['item-a']!,
              status: 'running',
              attempts: [execAttempt],
              worktree_name: evidence.worktree_name,
              branch_name: evidence.branch_name,
            },
          },
          usage: [
            { scope: 'epic', item_id: null, usage: active },
            { scope: 'item', item_id: 'item-a', usage: active },
          ],
        }

        // Attempt review reservation: sessions go from 1 to 2.
        if (limit < 2) {
          // Limit 1: execution consumed 1, review should be rejected (1 > 1 is false but 1 >= 1 was the old bug).
          // With the fix, sessions use > limit, so consumed=1 > limit=1 is false, BUT after review
          // reservation increments to 2, and 2 > 1 is true. Wait — the check happens BEFORE
          // incrementing. The check is on the POST-increment value (consumed after reservation).
          // Actually, reserveScopedUsage increments first, then asserts. So for limit 1:
          // after exec, sessions=1. Review increments to 2, then checks 2 > 1 = true → rejected.
          assert.throws(
            () => reserveEpicReviewSession(checkpointed, {
              item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1',
              agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER,
            }),
            /budget/,
            `limit ${limit} ${scope}: review should be rejected`,
          )
          continue
        }

        const afterReview = reserveEpicReviewSession(checkpointed, {
          item_id: 'item-a', attempt_id: 'attempt-1', review_id: 'review-1',
          agent: 'reviewer-example', model: 'example/reviewer', reserved_at: LATER,
        })
        assert.equal(afterReview.state.usage[0]!.usage.sessions, 2, `limit ${limit} ${scope}: review reserved session 2`)

        // If limit is 2, a third session should be rejected.
        if (limit === 2) {
          const targetItem = scope === 'item' ? 'item-a' : 'item-b'
          const saturatedItems: Record<string, EpicItem> = scope === 'item'
            ? { 'item-a': item('item-a') }
            : { 'item-a': item('item-a'), 'item-b': item('item-b') }
          const saturated = baseState({
            status: 'pending',
            budgets: [budget(scope, limit, scope === 'item' ? 'item-a' : null)],
            usage: [
              { scope: 'epic', item_id: null, usage: { ...emptyAutomationUsageTelemetry(), sessions: 2 } },
              ...(scope === 'item' ? [{ scope: 'item' as const, item_id: 'item-a', usage: { ...emptyAutomationUsageTelemetry(), sessions: 2 } }] : []),
            ],
            items: saturatedItems,
          })
          assert.throws(
            () => reserveEpicAttempt(saturated, reservation(targetItem, `attempt-${targetItem}`)),
            /budget/,
            `limit ${limit} ${scope}: third session should be rejected`,
          )
        }
      }
    }
  })
})
