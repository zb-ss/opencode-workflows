import type { AutomationUsageTelemetry } from './automation-policy-contracts.ts'
import { evaluateCostBudget, isConfiguredIntegerLimitExceeded, type CostBudgetDecision } from './automation-budget-policy.ts'
import {
  EPIC_BUDGET_DIMENSIONS,
  type EpicBudgetDimension,
  type EpicBudgetExtension,
  type EpicBudgetRecord,
  type EpicBudgetScope,
  type EpicBudgetUpdate,
  type EpicItem,
  type EpicState,
  EpicValidationError,
  isValidDimensionLimit,
} from './epic-contract-schemas.ts'
import { assertEpicEqual, assertEpicExactPrefix } from './epic-invariants.ts'
import type { EpicIssueReporter } from './epic-validation.ts'

function validateScopeTarget(scope: EpicBudgetScope, item_id: string | null, items: Record<string, EpicItem>): string | null {
  if (scope === 'global') return 'global-owned records are not valid in epic state'
  if (scope === 'epic') return item_id === null ? null : 'epic scope requires item_id null'
  if (item_id === null) return 'item scope requires item_id'
  return Object.hasOwn(items, item_id) ? null : `item scope references unknown item ${item_id}`
}

export function validateBudgetsAndUsage(state: EpicState, issue: EpicIssueReporter): void {
  const budget_keys = new Set<string>()
  for (const [index, budget] of (state.budgets ?? []).entries()) {
    const target_issue = validateScopeTarget(budget.scope, budget.item_id, state.items)
    if (target_issue) issue(['budgets', index], target_issue)
    const key = budgetKey(budget)
    if (budget_keys.has(key)) issue(['budgets', index], 'duplicate active budget record for scope, item, and dimension')
    budget_keys.add(key)
  }
  const usage_keys = new Set<string>()
  let epic_usage_count = 0
  for (const [index, usage] of state.usage.entries()) {
    const target_issue = validateScopeTarget(usage.scope, usage.item_id, state.items)
    if (target_issue) issue(['usage', index], target_issue)
    const key = `${usage.scope}\0${usage.item_id ?? ''}`
    if (usage_keys.has(key)) issue(['usage', index], 'duplicate scoped usage record')
    usage_keys.add(key)
    if (usage.scope === 'epic' && usage.item_id === null) epic_usage_count += 1
    const { active_interval_started_at: started, last_active_checkpoint_at: checkpoint } = usage.usage
    if ((started === null) !== (checkpoint === null)) issue(['usage', index], 'active interval start and checkpoint must both be set or both be null')
    if (started !== null && checkpoint !== null && Date.parse(checkpoint) < Date.parse(started)) issue(['usage', index, 'last_active_checkpoint_at'], 'active checkpoint must not precede interval start')
    if (checkpoint !== null && Date.parse(checkpoint) > Date.parse(state.updated_at)) issue(['usage', index, 'last_active_checkpoint_at'], 'active checkpoint must not exceed state updated_at')
    const is_running = state.status === 'running' && (usage.scope === 'epic' || state.items[usage.item_id!]?.status === 'running')
    if (started !== null && !is_running) issue(['usage', index], 'active interval requires its epic or item to be running')
  }
  if (epic_usage_count !== 1) issue(['usage'], 'usage must contain exactly one epic usage record')
  validateRunningBudgetScopes(state, issue)
}

function dimensionUsage(state: EpicState, usage: AutomationUsageTelemetry, dimension: EpicBudgetDimension): number | 'unknown' {
  if (dimension === 'calendar_age_ms') return Date.now() - Date.parse(state.created_at)
  if (dimension === 'cost_usd') return usage.cost_evidence.kind === 'known' ? usage.cost_evidence.cost_usd : 'unknown'
  if (dimension === 'active_time_ms' && usage.last_active_checkpoint_at !== null) {
    return usage.active_time_ms + Math.max(0, Date.now() - Date.parse(usage.last_active_checkpoint_at))
  }
  return usage[dimension]
}

function isBudgetExhausted(state: EpicState, budget: EpicBudgetRecord, usage: AutomationUsageTelemetry): boolean {
  if (budget.limit === null) return false
  const consumed = dimensionUsage(state, usage, budget.dimension)
  if (budget.dimension === 'cost_usd') {
    return consumed === 'unknown' || evaluateCostBudget(budget.limit, { kind: 'known', cost_usd: consumed }).decision === 'exhausted'
  }
  if (budget.dimension === 'sessions') {
    return consumed === 'unknown' || consumed > budget.limit
  }
  return consumed !== 'unknown' && (consumed === budget.limit || isConfiguredIntegerLimitExceeded(consumed, budget.limit))
}

export type EpicBudgetDecision = CostBudgetDecision
export type EpicBudgetDecisionCounts = Record<EpicBudgetDecision['decision'], number>
export interface EpicBudgetDimensionStatus {
  epic: EpicBudgetDecision
  item_decision_counts: EpicBudgetDecisionCounts
}
export type EpicBudgetStatus = Record<EpicBudgetDimension, EpicBudgetDimensionStatus>

export function epicBudgetDecision(
  state: EpicState,
  scope: 'epic' | 'item',
  item_id: string | null,
  dimension: EpicBudgetDimension,
): EpicBudgetDecision {
  if (scope === 'epic' && item_id !== null) throw new EpicValidationError('epic budget status requires item_id null')
  if (scope === 'item' && (item_id === null || !Object.hasOwn(state.items, item_id))) throw new EpicValidationError(`unknown epic item: ${String(item_id)}`)
  const budget = (state.budgets ?? []).find(record => record.scope === scope && record.item_id === item_id && record.dimension === dimension)
  if (!budget || budget.limit === null) return { decision: 'not_configured' }
  const scoped_usage = state.usage.find(record => record.scope === scope && record.item_id === item_id)
  if (!scoped_usage) throw new EpicValidationError(`configured ${scope} budget lacks matching usage telemetry`)
  const consumed = dimensionUsage(state, scoped_usage.usage, dimension)
  if (dimension === 'cost_usd') {
    return evaluateCostBudget(budget.limit, consumed === 'unknown' ? { kind: 'unknown' } : { kind: 'known', cost_usd: consumed })
  }
  if (dimension === 'sessions') {
    return consumed !== 'unknown' && consumed > budget.limit
      ? { decision: 'exhausted' }
      : { decision: 'within_limit' }
  }
  return consumed !== 'unknown' && (consumed === budget.limit || isConfiguredIntegerLimitExceeded(consumed, budget.limit))
    ? { decision: 'exhausted' }
    : { decision: 'within_limit' }
}

export function projectEpicBudgetStatus(state: EpicState): EpicBudgetStatus {
  return Object.fromEntries(EPIC_BUDGET_DIMENSIONS.map((dimension) => {
    const item_decision_counts: EpicBudgetDecisionCounts = { not_configured: 0, blocked: 0, within_limit: 0, exhausted: 0 }
    for (const item_id of Object.keys(state.items)) item_decision_counts[epicBudgetDecision(state, 'item', item_id, dimension).decision] += 1
    return [dimension, {
      epic: epicBudgetDecision(state, 'epic', null, dimension),
      item_decision_counts,
    }]
  })) as EpicBudgetStatus
}

function validateRunningBudgetScopes(state: EpicState, issue: EpicIssueReporter): void {
  for (const [budgetIndex, budget] of (state.budgets ?? []).entries()) {
    if (budget.limit === null) continue
    const usageIndex = state.usage.findIndex(record => record.scope === budget.scope && record.item_id === budget.item_id)
    if (usageIndex < 0) {
      issue(['budgets', budgetIndex], 'configured budget requires matching scoped usage telemetry')
      continue
    }
    const scopeRunning = budget.scope === 'epic'
      ? state.status === 'running'
      : state.items[budget.item_id!]?.status === 'running'
    if (scopeRunning && isBudgetExhausted(state, budget, state.usage[usageIndex]!.usage)) {
      issue(['budgets', budgetIndex, 'limit'], 'exhausted or unmeasurable budget scope must not remain running')
    }
  }
}

export function validatePolicyHistory(state: EpicState, issue: EpicIssueReporter): void {
  const update_ids = new Set<string>()
  const validate_record = (record: EpicBudgetUpdate | EpicBudgetExtension, record_path: (string | number)[]) => {
    if (update_ids.has(record.update_id)) issue([...record_path, 'update_id'], `duplicate budget update ID: ${record.update_id}`)
    update_ids.add(record.update_id)
    if (record.actor_session_id !== state.root_session_id) issue([...record_path, 'actor_session_id'], 'budget policy actor must own the epic root session')
    if (record.project_identity !== state.project_identity_sha256) issue([...record_path, 'project_identity'], 'budget policy project identity must match epic state')
    if (record.state_revision > state.state_revision) issue([...record_path, 'state_revision'], 'budget policy revision exceeds state revision')
    if (Date.parse(record.recorded_at) < Date.parse(state.created_at)) issue([...record_path, 'recorded_at'], 'budget policy record cannot predate the epic')
    if (Date.parse(record.recorded_at) > Date.parse(state.updated_at)) issue([...record_path, 'recorded_at'], 'budget policy record cannot exceed state updated_at')
    const target_issue = validateScopeTarget(record.scope, record.item_id, state.items)
    if (target_issue) issue(record_path, target_issue)
  }
  for (const [budget_index, budget] of (state.budgets ?? []).entries()) {
    let previous_revision = 0
    for (const [extension_index, extension] of budget.extensions.entries()) {
      const record_path = ['budgets', budget_index, 'extensions', extension_index]
      validate_record(extension, record_path)
      if (extension.dimension !== budget.dimension || extension.scope !== budget.scope || extension.item_id !== budget.item_id) issue(record_path, 'extension target and dimension must match its containing budget record')
      if (extension.state_revision <= previous_revision) issue([...record_path, 'state_revision'], 'extension revisions must be strictly increasing')
      if (extension_index > 0 && Date.parse(extension.recorded_at) < Date.parse(budget.extensions[extension_index - 1]!.recorded_at)) issue([...record_path, 'recorded_at'], 'extension timestamps must be monotonic')
      previous_revision = extension.state_revision
    }
  }
  let previous_revision = 0
  const update_evidence_counts = new Map<string, number>()
  const latest_limits = new Map<string, number | null>()
  for (const [index, update] of state.budget_updates.entries()) {
    validate_record(update, ['budget_updates', index])
    if (update.state_revision < previous_revision) issue(['budget_updates', index, 'state_revision'], 'budget update revisions must be monotonic')
    if (index > 0 && Date.parse(update.recorded_at) < Date.parse(state.budget_updates[index - 1]!.recorded_at)) issue(['budget_updates', index, 'recorded_at'], 'budget update timestamps must be monotonic')
    const evidence_key = budgetEvidenceKey(update)
    update_evidence_counts.set(evidence_key, (update_evidence_counts.get(evidence_key) ?? 0) + 1)
    const target_key = budgetKey(update)
    if (latest_limits.has(target_key) && update.previous_limit !== latest_limits.get(target_key)) {
      issue(['budget_updates', index, 'previous_limit'], 'budget update history must preserve previous/new limit continuity')
    }
    latest_limits.set(target_key, update.new_limit)
    previous_revision = update.state_revision
  }
  for (const [budget_index, budget] of (state.budgets ?? []).entries()) {
    for (const [extension_index, extension] of budget.extensions.entries()) {
      if (update_evidence_counts.get(budgetEvidenceKey(extension)) !== 1) issue(['budgets', budget_index, 'extensions', extension_index], 'extension requires exactly one matching root budget update')
    }
    const latest_limit = latest_limits.get(budgetKey(budget))
    if (latest_limit !== undefined && latest_limit !== budget.limit) {
      issue(['budgets', budget_index, 'limit'], 'active budget limit must equal the latest root policy update')
    }
  }
}

export function budgetKey(record: Pick<EpicBudgetRecord | EpicBudgetUpdate, 'scope' | 'item_id' | 'dimension'>): string {
  return `${record.scope}\0${record.item_id ?? ''}\0${record.dimension}`
}

function budgetEvidenceKey(record: EpicBudgetUpdate | EpicBudgetExtension): string {
  return `${budgetKey(record)}\0${String(record.previous_limit)}\0${String(record.new_limit)}\0${record.state_revision}`
}

export function validateBudgetTransition(previous: EpicState, next: EpicState): void {
  assertEpicExactPrefix('budget_updates', previous.budget_updates, next.budget_updates)
  const oldByKey = new Map((previous.budgets ?? []).map(record => [budgetKey(record), record]))
  const newByKey = new Map((next.budgets ?? []).map(record => [budgetKey(record), record]))
  const changes: Array<{ key: string, oldRecord?: EpicBudgetRecord, newRecord?: EpicBudgetRecord }> = []
  for (const key of new Set([...oldByKey.keys(), ...newByKey.keys()])) {
    const oldRecord = oldByKey.get(key)
    const newRecord = newByKey.get(key)
    if (!oldRecord || !newRecord || oldRecord.limit !== newRecord.limit) changes.push({ key, oldRecord, newRecord })
    if (oldRecord && newRecord) {
      assertEpicExactPrefix(`budget extensions ${key}`, oldRecord.extensions, newRecord.extensions)
      const appendedExtensionCount = newRecord.extensions.length - oldRecord.extensions.length
      const isIncrease = typeof oldRecord.limit === 'number' && typeof newRecord.limit === 'number' && newRecord.limit > oldRecord.limit
      if (appendedExtensionCount !== (isIncrease ? 1 : 0)) throw new EpicValidationError(`${isIncrease ? 'budget increase' : 'unchanged or non-increase budget'} ${key} has invalid extension evidence`)
      if (newRecord.extensions.slice(oldRecord.extensions.length).some(extension => Date.parse(extension.recorded_at) < Date.parse(previous.updated_at))) {
        throw new EpicValidationError(`new budget extensions for ${key} cannot predate the previous revision`)
      }
    }
    if (!oldRecord && newRecord && newRecord.extensions.length !== 0) throw new EpicValidationError(`new budget ${key} must start without extension history`)
    if (oldRecord && !newRecord && oldRecord.extensions.length > 0) throw new EpicValidationError(`budget ${key} cannot be deleted because deletion would erase extension evidence`)
  }
  const appendedUpdates = next.budget_updates.slice(previous.budget_updates.length)
  if (appendedUpdates.some(update => Date.parse(update.recorded_at) < Date.parse(previous.updated_at))) {
    throw new EpicValidationError('new budget policy updates cannot predate the previous revision')
  }
  if (appendedUpdates.length !== changes.length) throw new EpicValidationError('every budget policy change requires exactly one newly appended root budget update')
  for (const change of changes) {
    const previousLimit = change.oldRecord?.limit ?? null
    const newLimit = change.newRecord?.limit ?? null
    const matches = appendedUpdates.filter(update => budgetKey(update) === change.key && update.previous_limit === previousLimit
      && update.new_limit === newLimit && update.state_revision === next.state_revision)
    if (matches.length !== 1) throw new EpicValidationError(`budget change ${change.key} lacks exactly one matching update at the new revision`)
    if (typeof previousLimit === 'number' && typeof newLimit === 'number' && newLimit > previousLimit) {
      const oldLength = change.oldRecord?.extensions.length ?? 0
      const appended = change.newRecord?.extensions.slice(oldLength) ?? []
      if (appended.length !== 1 || appended[0]!.previous_limit !== previousLimit || appended[0]!.new_limit !== newLimit
        || appended[0]!.state_revision !== next.state_revision || budgetKey(appended[0]!) !== change.key) {
        throw new EpicValidationError(`budget increase ${change.key} requires exactly one matching newly appended extension`)
      }
    }
  }
}

export function validateUsageTransition(previous: EpicState, next: EpicState): void {
  if (next.usage.length < previous.usage.length) throw new EpicValidationError('usage records cannot be deleted')
  previous.usage.forEach((record, index) => {
    const following = next.usage[index]!
    assertEpicEqual(`usage[${index}] scope`, { scope: record.scope, item_id: record.item_id }, { scope: following.scope, item_id: following.item_id })
    for (const field of ['sessions', 'attempts', 'input_tokens', 'output_tokens', 'bounded_read_bytes', 'bounded_write_bytes', 'validation_runs', 'active_time_ms'] as const) {
      if (following.usage[field] < record.usage[field]) throw new EpicValidationError(`usage counter ${field} cannot decrease`)
    }
    const oldCost = record.usage.cost_evidence
    const newCost = following.usage.cost_evidence
    if (oldCost.kind === 'known' && (newCost.kind !== 'known' || newCost.cost_usd < oldCost.cost_usd)) throw new EpicValidationError('known cost evidence cannot become unknown or decrease')
    if (oldCost.kind === 'unknown' && newCost.kind === 'known') throw new EpicValidationError('unknown cost evidence cannot become known without a separately validated evidence contract')
    const oldStart = record.usage.active_interval_started_at
    const newStart = following.usage.active_interval_started_at
    const oldCheckpoint = record.usage.last_active_checkpoint_at
    const newCheckpoint = following.usage.last_active_checkpoint_at
    const targetRunning = next.status === 'running' && (record.scope === 'epic' || next.items[record.item_id!]?.status === 'running')
    if (newStart !== null && !targetRunning) throw new EpicValidationError('active usage intervals are allowed only while their epic or item is running')
    if ((newStart === null) !== (newCheckpoint === null)) throw new EpicValidationError('active interval start and checkpoint must both be set or both be null')
    if (newStart !== null && Date.parse(newCheckpoint!) < Date.parse(newStart)) throw new EpicValidationError('active usage checkpoint cannot precede interval start')
    if (newCheckpoint !== null && Date.parse(newCheckpoint) > Date.parse(next.updated_at)) throw new EpicValidationError('active usage checkpoint cannot exceed state updated_at')
    if (oldStart !== null) {
      if (newStart !== null && newStart !== oldStart) throw new EpicValidationError('active interval start is immutable until the interval closes')
      const priorPoint = oldCheckpoint ?? oldStart
      const closingPoint = newCheckpoint ?? next.updated_at
      if (Date.parse(closingPoint) < Date.parse(priorPoint)) throw new EpicValidationError('active usage checkpoint cannot move backwards')
      const elapsed = Date.parse(closingPoint) - Date.parse(priorPoint)
      if (following.usage.active_time_ms < record.usage.active_time_ms + elapsed) throw new EpicValidationError('active_time_ms must account for elapsed active interval time')
    } else if (newStart !== null && Date.parse(newStart) > Date.parse(next.updated_at)) throw new EpicValidationError('active interval cannot start after state updated_at')
  })
}

export function emptyAutomationUsageTelemetry(): AutomationUsageTelemetry {
  return {
    sessions: 0, attempts: 0, input_tokens: 0, output_tokens: 0, bounded_read_bytes: 0,
    bounded_write_bytes: 0, validation_runs: 0, active_time_ms: 0, cost_evidence: { kind: 'unknown' },
    active_interval_started_at: null, last_active_checkpoint_at: null,
  }
}

export function effectiveEpicItemLimit(state: EpicState, item: string | EpicItem, dimension: EpicBudgetDimension, global_limit?: number | null): number | null {
  const item_id = typeof item === 'string' ? item : item.item_id
  if (!Object.hasOwn(state.items, item_id)) throw new EpicValidationError(`unknown epic item: ${item_id}`)
  if (global_limit !== undefined && !isValidDimensionLimit(dimension, global_limit)) throw new EpicValidationError(`global limit is invalid for ${dimension}`)
  const candidates = (state.budgets ?? []).filter(record => record.dimension === dimension && record.limit !== null
    && (record.scope === 'epic' || (record.scope === 'item' && record.item_id === item_id))).map(record => record.limit as number)
  if (global_limit !== undefined && global_limit !== null) candidates.push(global_limit)
  return candidates.length === 0 ? null : Math.min(...candidates)
}
