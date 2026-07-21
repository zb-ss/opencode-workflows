import { validateBudgetTransition, validateUsageTransition } from './epic-budget-usage.ts'
import {
  type EpicAttempt,
  type EpicAttemptStatus,
  type EpicIntegrationEvent,
  type EpicItem,
  type EpicItemStatus,
  type EpicState,
  type EpicStatus,
  EpicValidationError,
} from './epic-contract-schemas.ts'
import { validateEpicState } from './epic-dag-state-validation.ts'
import { computeDependencySnapshotDigest, computeIntegrationEventDigest } from './epic-integration-digests.ts'
import { assertEpicEqual, assertEpicExactPrefix } from './epic-invariants.ts'

const TERMINAL_ITEM_STATUSES = new Set<EpicItemStatus>(['passed', 'failed', 'blocked', 'conflicted', 'integrated', 'cancelled'])
const EPIC_STATUS_ADJACENCY: Record<EpicStatus, ReadonlySet<EpicStatus>> = {
  pending: new Set(['pending', 'running', 'paused', 'failed', 'cancelled']),
  running: new Set(['running', 'paused', 'completed', 'failed', 'cancelled']),
  paused: new Set(['paused', 'running', 'failed', 'cancelled']),
  completed: new Set(['completed']), failed: new Set(['failed']), cancelled: new Set(['cancelled']),
}
const ITEM_STATUS_ADJACENCY: Record<EpicItemStatus, ReadonlySet<EpicItemStatus>> = {
  pending: new Set(['pending', 'queued', 'blocked', 'cancelled']), queued: new Set(['queued', 'running', 'blocked', 'cancelled']),
  running: new Set(['running', 'passed', 'failed', 'blocked', 'cancelled']), passed: new Set(['passed', 'integrated', 'conflicted']),
  failed: new Set(['failed', 'queued', 'running']), blocked: new Set(['blocked', 'queued', 'running']),
  conflicted: new Set(['conflicted', 'queued', 'running']), integrated: new Set(['integrated']), cancelled: new Set(['cancelled', 'queued', 'running']),
}
const ATTEMPT_STATUS_ADJACENCY: Record<EpicAttemptStatus, ReadonlySet<EpicAttemptStatus>> = {
  running: new Set(['running', 'passed', 'failed', 'cancelled']), passed: new Set(['passed']), failed: new Set(['failed']), cancelled: new Set(['cancelled']),
}

function validateAttemptTransition(previous: EpicAttempt, next: EpicAttempt, label: string): void {
  for (const field of ['attempt_id', 'agent', 'model', 'child_session_id', 'started_at'] as const) assertEpicEqual(`${label}.${field}`, previous[field], next[field])
  if (!ATTEMPT_STATUS_ADJACENCY[previous.status].has(next.status)) throw new EpicValidationError(`invalid attempt status transition ${previous.status} -> ${next.status}`)
  if (previous.status !== 'running') { assertEpicEqual(label, previous, next); return }
  if (next.status === 'running') assertEpicEqual(label, previous, next)
  if (previous.checkpoint_commit !== null) assertEpicEqual(`${label}.checkpoint_commit`, previous.checkpoint_commit, next.checkpoint_commit)
  if (next.status === 'passed' && next.checkpoint_commit === null) throw new EpicValidationError(`${label} passed transition requires a checkpoint commit`)
  if ((next.status === 'failed' || next.status === 'cancelled') && next.checkpoint_commit !== previous.checkpoint_commit) throw new EpicValidationError(`${label} may set a checkpoint only when passing`)
}

function expectedSettledAttemptStatus(itemStatus: EpicItemStatus): EpicAttemptStatus | null {
  if (itemStatus === 'passed') return 'passed'
  if (itemStatus === 'failed' || itemStatus === 'blocked') return 'failed'
  if (itemStatus === 'cancelled') return 'cancelled'
  return null
}

function validateAttemptHistoryTransition(
  previous: EpicItem,
  next: EpicItem,
  label: string,
  isRetry: boolean,
  previousUpdatedAt: string,
  nextUpdatedAt: string,
): void {
  const startsAttempt = (previous.status === 'queued' || isRetry) && next.status === 'running'
  const settlesAttempt = previous.status === 'running' && next.status !== 'running'
  const expectedLength = previous.attempts.length + (startsAttempt ? 1 : 0)
  if (next.attempts.length !== expectedLength) {
    throw new EpicValidationError(`${label} transition must ${startsAttempt ? 'append exactly one running attempt' : 'not append attempts'}`)
  }
  previous.attempts.forEach((attempt, index) => validateAttemptTransition(attempt, next.attempts[index]!, `${label}.attempts[${index}]`))
  if (startsAttempt) {
    const appended = next.attempts.at(-1)!
    if (appended.status !== 'running' || appended.checkpoint_commit !== null) {
      throw new EpicValidationError(`${label} must append one fresh running attempt without checkpoint evidence`)
    }
    if (Date.parse(appended.started_at) < Date.parse(previousUpdatedAt)
      || Date.parse(appended.started_at) > Date.parse(nextUpdatedAt)) {
      throw new EpicValidationError(`${label} new attempt must start within the revision interval`)
    }
  }
  if (!settlesAttempt) return
  const expectedStatus = expectedSettledAttemptStatus(next.status)
  if (expectedStatus === null || next.attempts.at(-1)?.status !== expectedStatus) {
    throw new EpicValidationError(`${label} must settle its running attempt consistently with item status ${next.status}`)
  }
  const completedAt = next.attempts.at(-1)!.completed_at!
  if (Date.parse(completedAt) < Date.parse(previousUpdatedAt) || Date.parse(completedAt) > Date.parse(nextUpdatedAt)) {
    throw new EpicValidationError(`${label} attempt must complete within the revision interval`)
  }
}

function validateItemTransition(previous: EpicItem, next: EpicItem, previousUpdatedAt: string, nextUpdatedAt: string): void {
  const label = `item ${previous.item_id}`
  assertEpicEqual(`${label} DAG identity`, { item_id: previous.item_id, dependencies: previous.dependencies, scope: previous.scope }, { item_id: next.item_id, dependencies: next.dependencies, scope: next.scope })
  if (!ITEM_STATUS_ADJACENCY[previous.status].has(next.status)) throw new EpicValidationError(`invalid item status transition ${previous.status} -> ${next.status} for ${previous.item_id}`)
  const isRetry = ['failed', 'blocked', 'conflicted', 'cancelled'].includes(previous.status) && (next.status === 'queued' || next.status === 'running')
  validateAttemptHistoryTransition(previous, next, label, isRetry, previousUpdatedAt, nextUpdatedAt)
  if (isRetry) {
    for (const field of ['selected_attempt_id', 'checkpoint_commit', 'review_evidence_digest', 'integration_commit', 'completed_at'] as const) {
      if (next[field] !== null) throw new EpicValidationError(`${label} retry must clear current ${field}`)
    }
    if (next.conflict_paths.length !== 0) throw new EpicValidationError(`${label} retry must clear current conflict paths`)
    if (next.status === 'queued' && (next.worktree_name !== null || next.branch_name !== null)) throw new EpicValidationError(`${label} queued retry must clear current worktree selection`)
    return
  }
  for (const field of ['worktree_name', 'branch_name', 'checkpoint_commit', 'review_evidence_digest', 'integration_commit'] as const) {
    if (previous[field] !== null) assertEpicEqual(`${label}.${field}`, previous[field], next[field])
  }
  if (previous.status === 'passed' && next.status === 'integrated') {
    const { status: _previousStatus, integration_commit: _previousCommit, ...previousFrozen } = previous
    const { status: _nextStatus, integration_commit: _nextCommit, ...nextFrozen } = next
    assertEpicEqual(`${label} reviewed fields`, previousFrozen, nextFrozen)
    if (previous.integration_commit !== null || next.integration_commit === null) throw new EpicValidationError(`${label} integration transition must set exactly one integration commit`)
    return
  }
  if (previous.status === 'passed' && next.status === 'conflicted') {
    const { status: _previousStatus, conflict_paths: _previousPaths, ...previousFrozen } = previous
    const { status: _nextStatus, conflict_paths: _nextPaths, ...nextFrozen } = next
    assertEpicEqual(`${label} reviewed fields`, previousFrozen, nextFrozen)
    if (next.conflict_paths.length === 0 || next.integration_commit !== null) throw new EpicValidationError(`${label} conflict transition requires paths and forbids an integration commit`)
    return
  }
  if (TERMINAL_ITEM_STATUSES.has(previous.status) && previous.status !== 'passed') assertEpicEqual(`${label} terminal record`, previous, next)
  if (previous.status === 'passed' && next.status === 'passed') assertEpicEqual(`${label} terminal record`, previous, next)
}

export function validateEpicTransition(previousInput: unknown, nextInput: unknown): EpicState {
  const previous = validateEpicState(previousInput)
  const next = validateEpicState(nextInput)
  if (next.state_revision !== previous.state_revision + 1) throw new EpicValidationError('state_revision must increase by exactly one')
  if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) throw new EpicValidationError('updated_at cannot move backwards')
  assertEpicEqual('epic identity', {
    schema_version: previous.schema_version, operational_limits: previous.operational_limits, epic_id: previous.epic_id,
    root_session_id: previous.root_session_id, project_identity_sha256: previous.project_identity_sha256,
    base_branch: previous.base_branch, integration_branch: previous.integration_branch, created_at: previous.created_at,
  }, {
    schema_version: next.schema_version, operational_limits: next.operational_limits, epic_id: next.epic_id,
    root_session_id: next.root_session_id, project_identity_sha256: next.project_identity_sha256,
    base_branch: next.base_branch, integration_branch: next.integration_branch, created_at: next.created_at,
  })
  if (!EPIC_STATUS_ADJACENCY[previous.status].has(next.status)) throw new EpicValidationError(`invalid epic status transition ${previous.status} -> ${next.status}`)
  assertEpicEqual('frozen epic item IDs', Object.keys(previous.items), Object.keys(next.items))
  for (const item_id of Object.keys(previous.items)) {
    validateItemTransition(previous.items[item_id]!, next.items[item_id]!, previous.updated_at, next.updated_at)
  }
  assertEpicExactPrefix('integration_log', previous.integration_log, next.integration_log)
  const outcomes: Array<{ item_id: string, result: 'success' | 'failure' }> = []
  for (const item_id of Object.keys(previous.items)) {
    const from = previous.items[item_id]!.status
    const to = next.items[item_id]!.status
    if (from === 'passed' && to === 'integrated') outcomes.push({ item_id, result: 'success' })
    if (from === 'passed' && to === 'conflicted') outcomes.push({ item_id, result: 'failure' })
  }
  if (outcomes.length > 1) throw new EpicValidationError('an epic revision may contain at most one integration outcome')
  const appendedEvents = next.integration_log.slice(previous.integration_log.length)
  if (appendedEvents.length !== outcomes.length) throw new EpicValidationError('each newly appended integration event must map exactly to one integration outcome')
  for (const outcome of outcomes) {
    const events = appendedEvents.filter(event => event.item_id === outcome.item_id && event.result === outcome.result)
    if (events.length !== 1) throw new EpicValidationError(`${outcome.result} integration outcome for ${outcome.item_id} requires exactly one bound event`)
    const event = events[0]!
    const selected = previous.items[outcome.item_id]!
    for (const dependency of selected.dependencies) {
      const dependencyItem = previous.items[dependency]
      if (dependencyItem?.status !== 'integrated' || dependencyItem.integration_commit === null) {
        throw new EpicValidationError(`integration outcome for ${outcome.item_id} requires integrated dependency ${dependency}`)
      }
    }
    if (event.attempt_id !== selected.selected_attempt_id
      || event.source_commit !== selected.checkpoint_commit
      || event.review_evidence_digest !== selected.review_evidence_digest) {
      throw new EpicValidationError(`integration outcome for ${outcome.item_id} must bind its previously selected reviewed attempt`)
    }
  }
  for (const [index, event] of appendedEvents.entries()) {
    const preceding = index === 0 ? previous.integration_log.at(-1)?.recorded_at : appendedEvents[index - 1]!.recorded_at
    if (Date.parse(event.recorded_at) < Date.parse(previous.updated_at)
      || Date.parse(event.recorded_at) > Date.parse(next.updated_at)
      || (preceding !== undefined && Date.parse(event.recorded_at) < Date.parse(preceding))) {
      throw new EpicValidationError(`new integration event ${event.event_id} has invalid audit chronology`)
    }
  }
  validateBudgetTransition(previous, next)
  validateUsageTransition(previous, next)
  return next
}

export function validateEpicRecoveryTransition(previousInput: unknown, nextInput: unknown): EpicState {
  const previous = validateEpicState(previousInput)
  const next = validateEpicTransition(previous, nextInput)
  if (next.status !== 'paused' || !next.pause_code || !next.pause_reason) throw new EpicValidationError('recovery transition must persist a paused recovery code and reason')
  for (const [item_id, oldItem] of Object.entries(previous.items)) {
    const newItem = next.items[item_id]!
    if (oldItem.status === 'running' && newItem.status !== 'cancelled') throw new EpicValidationError(`recovery must cancel running item ${item_id}`)
    oldItem.attempts.forEach((attempt, index) => {
      if (attempt.status !== 'running') return
      const settled = newItem.attempts[index]
      if (!settled || settled.status !== 'cancelled' || settled.failure_classification !== 'cancelled' || settled.completed_at === null) throw new EpicValidationError(`recovery must cancel running attempt ${attempt.attempt_id}`)
    })
  }
  for (const usage of next.usage) {
    if (usage.usage.active_interval_started_at !== null || usage.usage.last_active_checkpoint_at !== null) throw new EpicValidationError('recovery must close every active usage interval')
  }
  return next
}

type IntegrationEventInput = Omit<EpicIntegrationEvent, 'event_digest' | 'previous_event_digest' | 'item_id' | 'attempt_id' | 'result'>

function validatedIntegrationSource(stateInput: unknown, itemId: string, eventInput: IntegrationEventInput): { state: EpicState, item: EpicItem } {
  const state = validateEpicState(stateInput)
  const item = state.items[itemId]
  if (!item) throw new EpicValidationError(`cannot integrate unknown item ${itemId}`)
  if (item.status !== 'passed' || !item.checkpoint_commit || !item.review_evidence_digest || !item.selected_attempt_id) throw new EpicValidationError(`item ${itemId} must be passed with selected checkpoint and review evidence before integration`)
  for (const dependency of item.dependencies) {
    const dependencyItem = state.items[dependency]
    if (dependencyItem?.status !== 'integrated' || dependencyItem.integration_commit === null) {
      throw new EpicValidationError(`item ${itemId} cannot attempt integration before dependency ${dependency} is integrated`)
    }
  }
  if (eventInput.source_commit !== item.checkpoint_commit) throw new EpicValidationError('integration source must equal the reviewed checkpoint commit')
  if (eventInput.review_evidence_digest !== item.review_evidence_digest) throw new EpicValidationError('integration review evidence must equal the item review binding')
  if (eventInput.dependency_snapshot_sha256 !== computeDependencySnapshotDigest(state, item)) throw new EpicValidationError('integration dependency snapshot is stale')
  return { state, item }
}

function integrationEvent(state: EpicState, itemId: string, result: 'success' | 'failure', eventInput: IntegrationEventInput): EpicIntegrationEvent {
  const item = state.items[itemId]!
  const event: EpicIntegrationEvent = {
    ...eventInput,
    item_id: itemId,
    attempt_id: item.selected_attempt_id!,
    result,
    previous_event_digest: state.integration_log.at(-1)?.event_digest ?? null,
    event_digest: '',
  }
  event.event_digest = computeIntegrationEventDigest(event)
  return event
}

export function transitionEpicItemToIntegrated(stateInput: unknown, itemId: string, eventInput: IntegrationEventInput): EpicState {
  const { state, item } = validatedIntegrationSource(stateInput, itemId, eventInput)
  const event = integrationEvent(state, itemId, 'success', eventInput)
  const next: EpicState = {
    ...state, state_revision: state.state_revision + 1,
    updated_at: Date.parse(event.recorded_at) > Date.parse(state.updated_at) ? event.recorded_at : state.updated_at,
    items: { ...state.items, [itemId]: { ...item, status: 'integrated', integration_commit: event.target_commit } },
    integration_log: [...state.integration_log, event],
  }
  return validateEpicTransition(state, next)
}

export function transitionEpicItemToConflicted(stateInput: unknown, itemId: string, conflictPaths: string[], eventInput: IntegrationEventInput): EpicState {
  const { state, item } = validatedIntegrationSource(stateInput, itemId, eventInput)
  if (conflictPaths.length === 0) throw new EpicValidationError('failed integration requires at least one conflict path')
  const event = integrationEvent(state, itemId, 'failure', eventInput)
  const next: EpicState = {
    ...state, state_revision: state.state_revision + 1,
    updated_at: Date.parse(event.recorded_at) > Date.parse(state.updated_at) ? event.recorded_at : state.updated_at,
    items: { ...state.items, [itemId]: { ...item, status: 'conflicted', conflict_paths: [...conflictPaths] } },
    integration_log: [...state.integration_log, event],
  }
  return validateEpicTransition(state, next)
}
