import { z } from 'zod'

import { validateBudgetsAndUsage, validatePolicyHistory } from './epic-budget-usage.ts'
import {
  EPIC_SCHEMA_VERSION,
  type EpicItem,
  type EpicItemStatus,
  type EpicState,
  EpicSchemaVersionError,
  EpicStateStructuralSchema,
  type EpicStatus,
  EpicValidationError,
} from './epic-contract-schemas.ts'
import { validateIntegrationLog } from './epic-integration-digests.ts'

const TERMINAL_ITEM_STATUSES = new Set<EpicItemStatus>(['passed', 'failed', 'blocked', 'conflicted', 'integrated', 'cancelled'])

export const EpicStateSchema = EpicStateStructuralSchema.superRefine((state, context) => {
  addStateIssues(state as EpicState, context)
})

function addStateIssues(state: EpicState, context: z.core.$RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message })
  if (state.base_branch === state.integration_branch) issue(['integration_branch'], 'integration branch must differ from base branch')
  if (Date.parse(state.updated_at) < Date.parse(state.created_at)) issue(['updated_at'], 'updated_at must not precede created_at')
  if ((state.status === 'paused') !== (state.pause_reason !== null)) issue(['pause_reason'], 'pause_reason is required only while the epic is paused')
  if (state.status !== 'paused' && state.pause_code != null) issue(['pause_code'], 'pause_code is allowed only while the epic is paused')
  const item_ids = Object.keys(state.items)
  if (item_ids.length === 0) issue(['items'], 'epic must contain at least one item')
  if (item_ids.length > state.operational_limits.max_epic_items) issue(['items'], 'item count exceeds frozen operational limit')
  const aggregate_budget_records = (state.budgets?.length ?? 0) + state.budget_updates.length
    + (state.budgets ?? []).reduce((count, budget) => count + budget.extensions.length, 0)
  if (aggregate_budget_records > state.operational_limits.max_budget_records) issue(['budgets'], 'aggregate budget record count exceeds frozen operational limit')
  const maximum_integration_events = item_ids.length * state.operational_limits.max_attempts_per_item
  if (state.integration_log.length > maximum_integration_events) issue(['integration_log'], 'integration event count exceeds frozen attempt capacity')
  const attempt_ids = new Set<string>()
  for (const [key, item] of Object.entries(state.items)) {
    if (item.item_id !== key) issue(['items', key], `item record key ${key} does not match item_id ${item.item_id}`)
    if (item.dependencies.length > state.operational_limits.max_item_dependencies) issue(['items', key, 'dependencies'], 'dependency count exceeds frozen operational limit')
    if (item.attempts.length > state.operational_limits.max_attempts_per_item) issue(['items', key, 'attempts'], 'attempt count exceeds frozen operational limit')
    let previous_completed_at: number | null = null
    let running_attempts = 0
    for (const [index, attempt] of item.attempts.entries()) {
      if (attempt_ids.has(attempt.attempt_id)) issue(['items', key, 'attempts', index, 'attempt_id'], `duplicate attempt ID: ${attempt.attempt_id}`)
      attempt_ids.add(attempt.attempt_id)
      if (attempt.status === 'running') running_attempts += 1
      if (attempt.worktree_evidence.epic_id !== state.epic_id) issue(['items', key, 'attempts', index, 'worktree_evidence', 'epic_id'], 'attempt worktree evidence must match the containing epic')
      if (attempt.worktree_evidence.item_id !== item.item_id) issue(['items', key, 'attempts', index, 'worktree_evidence', 'item_id'], 'attempt worktree evidence must match the containing item')
      if (attempt.worktree_evidence.attempt_id !== attempt.attempt_id) issue(['items', key, 'attempts', index, 'worktree_evidence', 'attempt_id'], 'attempt worktree evidence must match the containing attempt')
      if (index > 0 && previous_completed_at === null) issue(['items', key, 'attempts', index], 'a running attempt must be the final attempt')
      if (previous_completed_at !== null && Date.parse(attempt.started_at) < previous_completed_at) issue(['items', key, 'attempts', index, 'started_at'], 'attempt history timestamps must be ordered')
      if (Date.parse(attempt.started_at) > Date.parse(state.updated_at)) issue(['items', key, 'attempts', index, 'started_at'], 'attempt cannot start after state updated_at')
      if (attempt.completed_at !== null && Date.parse(attempt.completed_at) > Date.parse(state.updated_at)) issue(['items', key, 'attempts', index, 'completed_at'], 'attempt cannot complete after state updated_at')
      previous_completed_at = attempt.completed_at === null ? null : Date.parse(attempt.completed_at)
    }
    if (running_attempts > 1) issue(['items', key, 'attempts'], 'item may have at most one running attempt')
    if (running_attempts === 1 && item.attempts.at(-1)?.status !== 'running') issue(['items', key, 'attempts'], 'running attempt must be the final attempt')
  }
  validateBudgetsAndUsage(state, issue)
  validatePolicyHistory(state, issue)
  validateIntegrationLog(state, issue)
  try { validateEpicDag(state.items) } catch (error) { issue(['items'], error instanceof Error ? error.message : 'invalid epic DAG') }
  try { validateEpicTransitions(state) } catch (error) { issue([], error instanceof Error ? error.message : 'invalid state transitions') }
}

export function validateEpicState(input: unknown): EpicState {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input as Record<string, unknown>).schema_version !== EPIC_SCHEMA_VERSION) {
    throw new EpicSchemaVersionError(input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).schema_version : undefined)
  }
  const parsed = EpicStateSchema.safeParse(input)
  if (!parsed.success) throw new EpicValidationError(`invalid epic state: ${parsed.error.message}`)
  return parsed.data as EpicState
}

export function validateEpicGenesisState(input: unknown): EpicState {
  const state = validateEpicState(input)
  if (state.state_revision !== 1 || state.status !== 'pending') {
    throw new EpicValidationError('epic genesis must be revision 1 with pending status')
  }
  for (const item of Object.values(state.items)) {
    if (item.status !== 'pending' || item.attempts.length !== 0) {
      throw new EpicValidationError(`epic genesis item ${item.item_id} must be pending without attempt history`)
    }
  }
  if (state.integration_log.length !== 0) throw new EpicValidationError('epic genesis must not contain integration history')
  if (state.budget_updates.length !== 0 || (state.budgets ?? []).some(budget => budget.extensions.length !== 0)) {
    throw new EpicValidationError('epic genesis must not contain budget policy history')
  }
  for (const scoped of state.usage) {
    const usage = scoped.usage
    const counters = [
      usage.sessions,
      usage.attempts,
      usage.input_tokens,
      usage.output_tokens,
      usage.bounded_read_bytes,
      usage.bounded_write_bytes,
      usage.validation_runs,
      usage.active_time_ms,
    ]
    if (counters.some(value => value !== 0)
      || (usage.cost_evidence.kind === 'known' && usage.cost_evidence.cost_usd !== 0)
      || usage.active_interval_started_at !== null
      || usage.last_active_checkpoint_at !== null) {
      throw new EpicValidationError('epic genesis usage must be zero with closed active intervals')
    }
  }
  return state
}

export function validateEpicDag(items: Record<string, EpicItem>): string[] {
  const item_ids = Object.keys(items)
  if (item_ids.length === 0) throw new EpicValidationError('epic must contain at least one item')
  const indegree = new Map(item_ids.map(id => [id, 0]))
  const dependents = new Map(item_ids.map(id => [id, [] as string[]]))
  for (const item of Object.values(items)) {
    if (new Set(item.dependencies).size !== item.dependencies.length) throw new EpicValidationError(`item ${item.item_id} has duplicate dependencies`)
    for (const dependency of item.dependencies) {
      if (!Object.hasOwn(items, dependency)) throw new EpicValidationError(`item ${item.item_id} depends on unknown item ${dependency}`)
      if (dependency === item.item_id) throw new EpicValidationError(`item ${item.item_id} cannot depend on itself`)
      indegree.set(item.item_id, (indegree.get(item.item_id) ?? 0) + 1)
      dependents.get(dependency)!.push(item.item_id)
    }
  }
  const declaration_order = new Map(item_ids.map((id, index) => [id, index]))
  const ready = item_ids.filter(id => indegree.get(id) === 0)
  const result: string[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => declaration_order.get(left)! - declaration_order.get(right)!)
    const current = ready.shift()!
    result.push(current)
    for (const dependent of dependents.get(current)!) {
      const next = indegree.get(dependent)! - 1
      indegree.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (result.length !== item_ids.length) throw new EpicValidationError(`epic contains a dependency cycle involving: ${item_ids.filter(id => !result.includes(id)).join(', ')}`)
  return result
}

export function deterministicEpicOrder(items: Record<string, EpicItem>): string[] { return validateEpicDag(items) }

export function validateEpicTransitions(state: EpicState): void {
  const itemStatuses = Object.values(state.items).map(item => item.status)
  const allowedTerminalItems: Partial<Record<EpicStatus, ReadonlySet<EpicItemStatus>>> = {
    completed: new Set(['integrated']),
    failed: new Set(['passed', 'failed', 'blocked', 'conflicted', 'integrated', 'cancelled']),
    cancelled: new Set(['pending', 'queued', 'passed', 'failed', 'blocked', 'conflicted', 'integrated', 'cancelled']),
  }
  const allowed = allowedTerminalItems[state.status]
  if (allowed && itemStatuses.some(status => !allowed.has(status))) throw new EpicValidationError(`terminal epic status ${state.status} has an inappropriate item disposition`)
  for (const item of Object.values(state.items)) {
    const running_attempts = item.attempts.filter(attempt => attempt.status === 'running').length
    if (item.status === 'running' && running_attempts !== 1) throw new EpicValidationError(`running item ${item.item_id} must have exactly one running attempt`)
    if (item.status !== 'running' && running_attempts !== 0) throw new EpicValidationError(`non-running item ${item.item_id} must not have a running attempt`)
    const isCurrentTerminal = TERMINAL_ITEM_STATUSES.has(item.status)
    if (isCurrentTerminal !== (item.completed_at !== null)) throw new EpicValidationError(`item ${item.item_id} completed_at must match terminal status`)
    if (item.completed_at !== null
      && (Date.parse(item.completed_at) < Date.parse(state.created_at)
        || Date.parse(item.completed_at) > Date.parse(state.updated_at))) {
      throw new EpicValidationError(`item ${item.item_id} completed_at must fall within the epic chronology`)
    }
    if (item.status === 'pending' && item.attempts.length > 0) throw new EpicValidationError(`pending item ${item.item_id} must not have attempts`)
    if (item.completed_at !== null && item.attempts.some(attempt => attempt.completed_at !== null && Date.parse(attempt.completed_at) > Date.parse(item.completed_at!))) throw new EpicValidationError(`item ${item.item_id} completed_at precedes attempt completion`)
    if (item.review_evidence_digest !== null && item.checkpoint_commit === null) throw new EpicValidationError(`item ${item.item_id} cannot have review evidence without a checkpoint commit`)
    const requiresSelection = item.status === 'passed' || item.status === 'integrated' || item.status === 'conflicted'
    const selectedAttempts = item.attempts.filter(attempt => attempt.attempt_id === item.selected_attempt_id)
    if (requiresSelection) {
      if (item.attempts.length === 0 || item.selected_attempt_id === null || selectedAttempts.length !== 1 || selectedAttempts[0]!.status !== 'passed') throw new EpicValidationError(`${item.status} item ${item.item_id} requires exactly one selected passed attempt`)
      const selected = selectedAttempts[0]!
      if (selected.checkpoint_commit !== item.checkpoint_commit || selected.review_evidence_digest !== item.review_evidence_digest || item.checkpoint_commit === null || item.review_evidence_digest === null) throw new EpicValidationError(`${item.status} item ${item.item_id} checkpoint and review evidence must match its selected passed attempt`)
      if (item.worktree_name !== selected.worktree_evidence.worktree_name || item.branch_name !== selected.worktree_evidence.branch_name) throw new EpicValidationError(`${item.status} item ${item.item_id} worktree selection must match its selected passed attempt`)
    } else if (item.selected_attempt_id !== null || item.checkpoint_commit !== null || item.review_evidence_digest !== null) {
      throw new EpicValidationError(`${item.status} item ${item.item_id} must not retain current selected checkpoint or review fields`)
    }
    if (item.status === 'running') {
      const running = item.attempts.at(-1)!
      if (item.worktree_name !== running.worktree_evidence.worktree_name || item.branch_name !== running.worktree_evidence.branch_name) throw new EpicValidationError(`running item ${item.item_id} worktree selection must match its running attempt`)
    } else if (['pending', 'queued'].includes(item.status)) {
      if (item.worktree_name !== null || item.branch_name !== null) throw new EpicValidationError(`${item.status} item ${item.item_id} must not have current worktree selection`)
    } else if (!requiresSelection) {
      const has_worktree = item.worktree_name !== null || item.branch_name !== null
      if (has_worktree && (item.worktree_name === null || item.branch_name === null)) throw new EpicValidationError(`${item.status} item ${item.item_id} must retain both worktree fields or neither`)
      const final_attempt = item.attempts.at(-1)
      if (has_worktree && (!final_attempt || item.worktree_name !== final_attempt.worktree_evidence.worktree_name || item.branch_name !== final_attempt.worktree_evidence.branch_name)) throw new EpicValidationError(`${item.status} item ${item.item_id} retained worktree selection must match its final attempt`)
    }
    if ((item.status === 'conflicted') !== (item.conflict_paths.length > 0)) throw new EpicValidationError(`${item.status === 'conflicted' ? 'conflicted' : 'non-conflicted'} item ${item.item_id} ${item.status === 'conflicted' ? 'must record' : 'must not have'} conflict paths`)
    if (item.status !== 'integrated' && item.integration_commit !== null) throw new EpicValidationError(`non-integrated item ${item.item_id} must not have an integration commit`)
    if (item.status === 'integrated') {
      if (!item.integration_commit || !item.worktree_name || !item.branch_name || !item.checkpoint_commit || !item.review_evidence_digest) throw new EpicValidationError(`integrated item ${item.item_id} requires retained worktree, branch, checkpoint, review evidence, and integration commit`)
      if (!state.integration_log.some(event => event.item_id === item.item_id && event.result === 'success')) throw new EpicValidationError(`integrated item ${item.item_id} requires a successful integration event`)
    }
    for (const dependency of item.dependencies) {
      if (item.status === 'integrated' && state.items[dependency]?.status !== 'integrated') throw new EpicValidationError(`integrated item ${item.item_id} depends on non-integrated item ${dependency}`)
    }
  }
}
