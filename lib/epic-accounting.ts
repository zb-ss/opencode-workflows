import { z } from 'zod'

import {
  finiteNonNegativeCost,
  safeNonNegativeInteger,
  type AutomationUsageTelemetry,
} from './automation-policy-contracts.ts'
import {
  EPIC_BUDGET_DIMENSIONS,
  type EpicBudgetDimension,
  type EpicBudgetRecord,
  type EpicScopedUsage,
  type EpicState,
  EpicValidationError,
} from './epic-contract-schemas.ts'
import { emptyAutomationUsageTelemetry } from './epic-budget-usage.ts'
import { validateEpicState } from './epic-dag-state-validation.ts'
import { validateEpicTransition } from './epic-transitions.ts'
import { EpicWorktreeEvidenceSchema, type EpicWorktreeEvidence } from './epic-worktree-contracts.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

const ACTIVE_ATTEMPT_STATUSES = new Set(['running', 'checkpointed', 'reviewing'])
const RETRYABLE_ITEM_STATUSES = new Set(['failed', 'blocked', 'conflicted', 'cancelled'])

export interface EpicAttemptReservationInput {
  item_id: string
  attempt_id: string
  launch_id: string
  agent: string
  model: string
  worktree_evidence: EpicWorktreeEvidence
  reserved_at: string
}

export interface EpicReviewSessionReservationInput {
  item_id: string
  attempt_id: string
  review_id: string
  agent: string
  model: string
  reserved_at: string
}

export interface EpicReviewSessionReservation {
  review_id: string
  epic_id: string
  item_id: string
  attempt_id: string
  agent: string
  model: string
  worktree_evidence: EpicWorktreeEvidence
  checkpoint_commit: string
  checkpoint_tree_sha256: string
  reserved_at: string
}

export interface EpicReviewSessionReservationResult {
  state: EpicState
  reservation: EpicReviewSessionReservation
}

export const EpicUsageDeltaSchema = z.object({
  input_tokens: safeNonNegativeInteger,
  output_tokens: safeNonNegativeInteger,
  cost_usd: finiteNonNegativeCost,
}).strict()

export const EpicUsageDeltaInputSchema = EpicUsageDeltaSchema.extend({
  item_id: SafeIdentifierSchema,
  observed_at: z.string().min(1).max(64),
}).strict()

export type EpicUsageDelta = z.infer<typeof EpicUsageDeltaSchema>
export type EpicUsageDeltaInput = z.infer<typeof EpicUsageDeltaInputSchema>

function checkedTimestamp(value: string, label: string, minimum: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new EpicValidationError(`${label} must be a valid timestamp`)
  if (timestamp < Date.parse(minimum)) throw new EpicValidationError(`${label} cannot precede the current state revision`)
  return timestamp
}

function checkedIntegerSum(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < left) throw new EpicValidationError(`${label} cannot be represented safely`)
  return result
}

function checkedCostSum(left: number, right: number): number {
  const result = left + right
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER || result < left) {
    throw new EpicValidationError('cost usage cannot be represented safely')
  }
  return result
}

function usageIndex(usage: EpicScopedUsage[], scope: 'epic' | 'item', itemId: string | null): number {
  return usage.findIndex(record => record.scope === scope && record.item_id === itemId)
}

function ensureItemUsage(state: EpicState, itemId: string): EpicScopedUsage[] {
  const usage = state.usage.map(record => ({ ...record, usage: { ...record.usage } }))
  if (usageIndex(usage, 'item', itemId) < 0) {
    usage.push({ scope: 'item', item_id: itemId, usage: emptyAutomationUsageTelemetry() })
  }
  return usage
}

function checkpointAndOpen(
  telemetry: AutomationUsageTelemetry,
  at: string,
  incrementAttempt: boolean,
): AutomationUsageTelemetry {
  let active_time_ms = telemetry.active_time_ms
  if (telemetry.last_active_checkpoint_at !== null) {
    const elapsed = Date.parse(at) - Date.parse(telemetry.last_active_checkpoint_at)
    if (elapsed < 0) throw new EpicValidationError('active usage checkpoint cannot move backwards')
    active_time_ms = checkedIntegerSum(active_time_ms, elapsed, 'active time usage')
  }
  return {
    ...telemetry,
    sessions: checkedIntegerSum(telemetry.sessions, 1, 'session usage'),
    attempts: incrementAttempt
      ? checkedIntegerSum(telemetry.attempts, 1, 'attempt usage')
      : telemetry.attempts,
    active_time_ms,
    active_interval_started_at: telemetry.active_interval_started_at ?? at,
    last_active_checkpoint_at: at,
  }
}

function reserveScopedUsage(state: EpicState, itemId: string, at: string, incrementAttempt: boolean): EpicScopedUsage[] {
  const usage = ensureItemUsage(state, itemId)
  for (const [scope, target] of [['epic', null], ['item', itemId]] as const) {
    const index = usageIndex(usage, scope, target)
    if (index < 0) throw new EpicValidationError(`missing ${scope} usage telemetry`)
    usage[index] = { ...usage[index]!, usage: checkpointAndOpen(usage[index]!.usage, at, incrementAttempt) }
  }
  return usage
}

function dimensionUsage(state: EpicState, usage: AutomationUsageTelemetry, dimension: EpicBudgetDimension, at: string): number | 'unknown' {
  if (dimension === 'calendar_age_ms') return Date.parse(at) - Date.parse(state.created_at)
  if (dimension === 'cost_usd') return usage.cost_evidence.kind === 'known' ? usage.cost_evidence.cost_usd : 'unknown'
  if (dimension === 'active_time_ms' && usage.last_active_checkpoint_at !== null) {
    return checkedIntegerSum(usage.active_time_ms, Date.parse(at) - Date.parse(usage.last_active_checkpoint_at), 'active time usage')
  }
  return usage[dimension]
}

function applicableBudgets(state: EpicState, itemId: string): EpicBudgetRecord[] {
  return (state.budgets ?? []).filter(budget => budget.limit !== null
    && (budget.scope === 'epic' || (budget.scope === 'item' && budget.item_id === itemId)))
}

function budgetLabel(budget: EpicBudgetRecord): string {
  return budget.scope === 'item'
    ? `item ${String(budget.item_id)} ${budget.dimension}`
    : `epic ${budget.dimension}`
}

/**
 * Check whether a budget is exhausted after consuming the proposed reservation.
 *
 * Semantics:
 * - sessions: exhausted only when consumed > limit (a limit of N allows N sessions)
 * - input_tokens, output_tokens, active_time_ms, calendar_age_ms: exhausted when consumed >= limit
 * - cost_usd: unknown cost is not exhausted here (handled by applyUsage), but known
 *   cost >= limit is exhausted
 *
 * This unified function is used by both execution and review reservations so
 * they enforce identical exact-limit semantics.
 */
function isReservationExhausted(budget: EpicBudgetRecord, consumed: number | 'unknown'): boolean {
  if (budget.limit === null) return false
  if (consumed === 'unknown') {
    // Cost budgets cannot be enforced without evidence; other dimensions
    // should always have a known value at reservation time.
    if (budget.dimension === 'cost_usd') return false
    // Non-cost unknown is unexpected and should fail closed.
    return true
  }
  if (budget.dimension === 'sessions') return consumed > budget.limit
  return consumed >= budget.limit
}

function assertReservationBudgetsUnified(state: EpicState, itemId: string, usage: EpicScopedUsage[], at: string): void {
  const applicable = applicableBudgets(state, itemId)
  for (const budget of applicable) {
    if (budget.limit === null) continue
    const index = usageIndex(usage, budget.scope as 'epic' | 'item', budget.item_id)
    if (index < 0) throw new EpicValidationError(`configured ${budgetLabel(budget)} budget lacks usage telemetry`)
    const consumed = dimensionUsage(state, usage[index]!.usage, budget.dimension, at)
    if (isReservationExhausted(budget, consumed)) {
      throw new EpicValidationError(`reservation blocked by configured ${budgetLabel(budget)} budget`)
    }
  }
}

/**
 * Find budgets that are exhausted after applying a usage delta. This uses
 * >= limit for ALL dimensions including sessions, because post-usage
 * exhaustion means no further work can be admitted.
 */
function postUsageExhaustedBudgets(state: EpicState, itemId: string, usage: EpicScopedUsage[], at: string): EpicBudgetRecord[] {
  return applicableBudgets(state, itemId).filter((budget) => {
    const index = usageIndex(usage, budget.scope as 'epic' | 'item', budget.item_id)
    if (index < 0) throw new EpicValidationError(`configured ${budgetLabel(budget)} budget lacks usage telemetry`)
    const consumed = dimensionUsage(state, usage[index]!.usage, budget.dimension, at)
    return consumed === 'unknown' || consumed >= budget.limit!
  }).sort((left, right) => budgetLabel(left).localeCompare(budgetLabel(right), 'en'))
}

function assertCoordinationEnabled(state: EpicState): NonNullable<EpicState['coordination_policy']> {
  if (!state.coordination_policy) throw new EpicValidationError('epic coordination is not enabled')
  return state.coordination_policy
}

function assertUniqueReservationIds(state: EpicState, attemptId: string, launchId: string): void {
  for (const item of Object.values(state.items)) {
    for (const attempt of item.attempts) {
      if (attempt.attempt_id === attemptId) throw new EpicValidationError(`attempt ID is already in use: ${attemptId}`)
      if (attempt.launch_id === launchId) throw new EpicValidationError(`launch ID is already in use: ${launchId}`)
    }
  }
}

/**
 * Produces the one durable reservation revision which must be persisted before
 * the coordinator creates a child session. This reducer owns no global/Phase 5
 * budget and performs no Git, session, or persistence operation.
 */
export function reserveEpicAttempt(stateInput: unknown, input: EpicAttemptReservationInput): EpicState {
  const state = validateEpicState(stateInput)
  const policy = assertCoordinationEnabled(state)
  if (state.status !== 'pending' && state.status !== 'running') {
    throw new EpicValidationError('epic must be pending or running before reserving an execution session')
  }
  const reservedAt = checkedTimestamp(input.reserved_at, 'reservation timestamp', state.updated_at)
  const item = state.items[input.item_id]
  if (!item) throw new EpicValidationError(`unknown epic item: ${input.item_id}`)
  if (item.status !== 'queued' && !RETRYABLE_ITEM_STATUSES.has(item.status)) {
    throw new EpicValidationError(`item ${input.item_id} is not ready for an execution reservation`)
  }
  for (const dependency of item.dependencies) {
    if (state.items[dependency]?.status !== 'integrated') {
      throw new EpicValidationError(`item ${input.item_id} requires integrated dependency ${dependency}`)
    }
  }
  if (item.retry_not_before != null && reservedAt < Date.parse(item.retry_not_before)) {
    throw new EpicValidationError(`item ${input.item_id} retry_not_before has not elapsed`)
  }
  if (item.attempts.length >= state.operational_limits.max_attempts_per_item) {
    throw new EpicValidationError(`item ${input.item_id} reached max_attempts_per_item`)
  }
  if (item.attempts.some(attempt => ACTIVE_ATTEMPT_STATUSES.has(attempt.status))) {
    throw new EpicValidationError(`item ${input.item_id} already has an active attempt`)
  }
  if (input.agent !== policy.executor_agent || !policy.executor_candidates.some(candidate => candidate.model === input.model)) {
    throw new EpicValidationError('execution reservation does not match the immutable executor policy')
  }
  assertUniqueReservationIds(state, input.attempt_id, input.launch_id)
  const evidence = EpicWorktreeEvidenceSchema.parse(input.worktree_evidence)
  if (evidence.epic_id !== state.epic_id || evidence.item_id !== item.item_id || evidence.attempt_id !== input.attempt_id) {
    throw new EpicValidationError('execution reservation worktree evidence does not match its epic, item, and attempt')
  }

  const usage = reserveScopedUsage(state, item.item_id, input.reserved_at, true)
  assertReservationBudgetsUnified(state, item.item_id, usage, input.reserved_at)
  const attempt = {
    attempt_id: input.attempt_id,
    worktree_evidence: evidence,
    agent: input.agent,
    model: input.model,
    child_session_id: null,
    started_at: input.reserved_at,
    completed_at: null,
    checkpoint_commit: null,
    review_evidence_digest: null,
    result_summary: null,
    failure_classification: null,
    status: 'running' as const,
    launch_id: input.launch_id,
    launch_state: 'reserved' as const,
    progress_commit: null,
    progress_tree_sha256: null,
    checkpoint_tree_sha256: null,
    review: null,
  }
  const next: EpicState = {
    ...state,
    state_revision: state.state_revision + 1,
    updated_at: input.reserved_at,
    status: 'running',
    pause_reason: null,
    pause_code: null,
    items: {
      ...state.items,
      [item.item_id]: {
        ...item,
        status: 'running',
        attempts: [...item.attempts, attempt],
        selected_attempt_id: null,
        worktree_name: evidence.worktree_name,
        branch_name: evidence.branch_name,
        checkpoint_commit: null,
        review_evidence_digest: null,
        conflict_paths: [],
        integration_commit: null,
        completed_at: null,
        retry_not_before: null,
      },
    },
    usage,
  }
  return validateEpicTransition(state, next)
}

/** Reserves review session usage without fabricating a review child ID. */
export function reserveEpicReviewSession(
  stateInput: unknown,
  input: EpicReviewSessionReservationInput,
): EpicReviewSessionReservationResult {
  const state = validateEpicState(stateInput)
  const policy = assertCoordinationEnabled(state)
  if (state.status !== 'running') throw new EpicValidationError('epic must be running before reserving a review session')
  checkedTimestamp(input.reserved_at, 'review reservation timestamp', state.updated_at)
  const item = state.items[input.item_id]
  if (!item || item.status !== 'running') throw new EpicValidationError(`item ${input.item_id} is not running`)
  const attempt = item.attempts.find(candidate => candidate.attempt_id === input.attempt_id)
  if (!attempt || attempt !== item.attempts.at(-1) || attempt.status !== 'checkpointed'
    || attempt.checkpoint_commit === null || attempt.checkpoint_tree_sha256 == null || attempt.review !== null) {
    throw new EpicValidationError('review reservation requires the exact final checkpointed attempt without an existing review')
  }
  if (input.agent !== policy.reviewer_agent || !policy.reviewer_candidates.some(candidate => candidate.model === input.model)) {
    throw new EpicValidationError('review reservation does not match the immutable reviewer policy')
  }
  for (const candidateItem of Object.values(state.items)) {
    if (candidateItem.attempts.some(candidate => candidate.review?.review_id === input.review_id)) {
      throw new EpicValidationError(`review ID is already in use: ${input.review_id}`)
    }
  }
  const usage = reserveScopedUsage(state, item.item_id, input.reserved_at, false)
  assertReservationBudgetsUnified(state, item.item_id, usage, input.reserved_at)
  const next = validateEpicTransition(state, {
    ...state,
    state_revision: state.state_revision + 1,
    updated_at: input.reserved_at,
    items: {
      ...state.items,
      [item.item_id]: {
        ...item,
        attempts: item.attempts.map(candidate => candidate.attempt_id === attempt.attempt_id
          ? {
              ...candidate,
              status: 'reviewing' as const,
              review: {
                review_id: input.review_id,
                agent: input.agent,
                model: input.model,
                child_session_id: null,
                launch_state: 'reserved' as const,
                checkpoint_commit: attempt.checkpoint_commit!,
                checkpoint_tree_sha256: attempt.checkpoint_tree_sha256!,
                started_at: input.reserved_at,
                completed_at: null,
                verdict: null,
                evidence_digest: null,
                result_summary: null,
              },
            }
          : candidate),
      },
    },
    usage,
  })
  return {
    state: next,
    reservation: {
      review_id: input.review_id,
      epic_id: state.epic_id,
      item_id: item.item_id,
      attempt_id: attempt.attempt_id,
      agent: input.agent,
      model: input.model,
      worktree_evidence: attempt.worktree_evidence,
      checkpoint_commit: attempt.checkpoint_commit,
      checkpoint_tree_sha256: attempt.checkpoint_tree_sha256,
      reserved_at: input.reserved_at,
    },
  }
}

function applyDelta(telemetry: AutomationUsageTelemetry, delta: EpicUsageDelta, observedAt: string): AutomationUsageTelemetry {
  const previousCheckpoint = telemetry.last_active_checkpoint_at
  let active_time_ms = telemetry.active_time_ms
  if (previousCheckpoint !== null) {
    const elapsed = Date.parse(observedAt) - Date.parse(previousCheckpoint)
    if (elapsed < 0) throw new EpicValidationError('usage observation cannot move an active checkpoint backwards')
    active_time_ms = checkedIntegerSum(active_time_ms, elapsed, 'active time usage')
  }
  return {
    ...telemetry,
    input_tokens: checkedIntegerSum(telemetry.input_tokens, delta.input_tokens, 'input token usage'),
    output_tokens: checkedIntegerSum(telemetry.output_tokens, delta.output_tokens, 'output token usage'),
    active_time_ms,
    cost_evidence: telemetry.cost_evidence.kind === 'known'
      ? { kind: 'known', cost_usd: checkedCostSum(telemetry.cost_evidence.cost_usd, delta.cost_usd) }
      : { kind: 'unknown' },
    last_active_checkpoint_at: previousCheckpoint === null ? null : observedAt,
  }
}

function settleActiveItemsForPause(
  state: EpicState,
  observedAt: string,
  reason: string,
): { items: EpicState['items']; hasAmbiguousReview: boolean; hasAmbiguousExecution: boolean } {
  const items = { ...state.items }
  let hasAmbiguousReview = false
  let hasAmbiguousExecution = false
  for (const item of Object.values(state.items)) {
    if (item.status !== 'running') continue
    const activeIndex = item.attempts.findIndex(attempt => ACTIVE_ATTEMPT_STATUSES.has(attempt.status))
    const active = activeIndex < 0 ? undefined : item.attempts[activeIndex]
    if (!active) throw new EpicValidationError(`running item ${item.item_id} lacks an active attempt`)

    let settled = { ...active }
    if (active.status === 'running' && active.launch_state !== undefined) {
      if (active.launch_state === 'reserved') {
        settled = { ...settled, status: 'cancelled', launch_state: 'settled', failure_classification: 'cancelled' }
      } else if (active.launch_state === 'created' || active.launch_state === 'prompted') {
        settled = { ...settled, status: 'failed', launch_state: 'ambiguous', failure_classification: 'ambiguous_launch' }
        hasAmbiguousExecution = true
      }
    } else {
      settled = { ...settled, status: 'cancelled', failure_classification: 'cancelled' }
      if (settled.launch_state !== undefined) settled.launch_state = 'settled'
    }

    if (active.review) {
      if (active.review.launch_state === 'reserved') {
        settled.review = { ...active.review, launch_state: 'settled' }
      } else if (active.review.launch_state === 'created' || active.review.launch_state === 'prompted') {
        settled.review = { ...active.review, launch_state: 'ambiguous' }
        hasAmbiguousReview = true
      } else if (active.review.launch_state === 'ambiguous') hasAmbiguousReview = true
    }
    settled.completed_at = observedAt
    settled.result_summary = reason
    const attempts = [...item.attempts]
    attempts[activeIndex] = settled
    items[item.item_id] = {
      ...item,
      status: settled.status === 'failed' ? 'failed' : 'cancelled',
      attempts,
      completed_at: observedAt,
      retry_not_before: null,
    }
  }
  return { items, hasAmbiguousReview, hasAmbiguousExecution }
}

function closeAllActiveIntervals(usage: EpicScopedUsage[], observedAt: string): EpicScopedUsage[] {
  return usage.map((record) => {
    if (record.usage.last_active_checkpoint_at === null) return record
    const elapsed = Date.parse(observedAt) - Date.parse(record.usage.last_active_checkpoint_at)
    if (elapsed < 0) throw new EpicValidationError('cannot close an active interval before its checkpoint')
    return {
      ...record,
      usage: {
        ...record.usage,
        active_time_ms: checkedIntegerSum(record.usage.active_time_ms, elapsed, 'active time usage'),
        active_interval_started_at: null,
        last_active_checkpoint_at: null,
      },
    }
  })
}

export function closeEpicUsageIntervals(usage: EpicScopedUsage[], observed_at: string): EpicScopedUsage[] {
  return closeAllActiveIntervals(usage, observed_at)
}

/**
 * Applies caller-supplied token/cost deltas exactly once at item and epic
 * scope. Wall-clock active time is coordinator-checkpoint-owned and advances
 * from the durable checkpoint, never from a caller claim. Idempotent
 * observation IDs and deduplication belong to the coordinator's durable
 * session ledger, not this pure reducer.
 */
export function applyEpicUsageDelta(stateInput: unknown, input: EpicUsageDeltaInput): EpicState {
  const state = validateEpicState(stateInput)
  const observation = EpicUsageDeltaInputSchema.parse(input)
  checkedTimestamp(observation.observed_at, 'usage observation timestamp', state.updated_at)
  if (!Object.hasOwn(state.items, observation.item_id)) throw new EpicValidationError(`unknown epic item: ${observation.item_id}`)
  const delta = EpicUsageDeltaSchema.parse({
    input_tokens: observation.input_tokens,
    output_tokens: observation.output_tokens,
    cost_usd: observation.cost_usd,
  })
  let usage = ensureItemUsage(state, observation.item_id)
  for (const [scope, target] of [['epic', null], ['item', observation.item_id]] as const) {
    const index = usageIndex(usage, scope, target)
    if (index < 0) throw new EpicValidationError(`missing ${scope} usage telemetry`)
    usage[index] = { ...usage[index]!, usage: applyDelta(usage[index]!.usage, delta, observation.observed_at) }
  }

  const exhausted = postUsageExhaustedBudgets(state, observation.item_id, usage, observation.observed_at)
  let status = state.status
  let pause_reason = state.pause_reason
  let pause_code = state.pause_code ?? null
  let items = state.items
  if (exhausted.length > 0) {
    if (state.status !== 'running' && state.status !== 'paused' && state.status !== 'pending') {
      throw new EpicValidationError('terminal epic cannot be paused for newly exhausted usage')
    }
    status = 'paused'
    pause_reason = `Budget exhausted or unmeasurable: ${budgetLabel(exhausted[0]!)}`
    const settlement = settleActiveItemsForPause(state, observation.observed_at, pause_reason)
    items = settlement.items
    pause_code = settlement.hasAmbiguousReview
      ? 'ambiguous_reviewer_launch'
      : settlement.hasAmbiguousExecution ? 'ambiguous_execution_launch' : 'budget_exhausted'
    usage = closeAllActiveIntervals(usage, observation.observed_at)
  }

  return validateEpicTransition(state, {
    ...state,
    state_revision: state.state_revision + 1,
    updated_at: observation.observed_at,
    status,
    pause_reason,
    pause_code,
    items,
    usage,
  })
}

export { EPIC_BUDGET_DIMENSIONS }
