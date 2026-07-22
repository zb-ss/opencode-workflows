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
import { epicStateDigest } from './epic-persistence-codec.ts'

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
  running: new Set(['running', 'checkpointed', 'passed', 'failed', 'cancelled']),
  checkpointed: new Set(['checkpointed', 'reviewing', 'failed', 'cancelled']),
  reviewing: new Set(['reviewing', 'passed', 'failed', 'cancelled']),
  passed: new Set(['passed']), failed: new Set(['failed']), cancelled: new Set(['cancelled']),
}
const LAUNCH_STATE_ADJACENCY = {
  reserved: new Set(['reserved', 'created', 'settled', 'ambiguous']),
  created: new Set(['created', 'prompted', 'ambiguous']),
  prompted: new Set(['prompted', 'settled', 'ambiguous']),
  settled: new Set(['settled']),
  ambiguous: new Set(['ambiguous']),
} as const
const ACTIVE_ATTEMPT_STATUSES = new Set<EpicAttemptStatus>(['running', 'checkpointed', 'reviewing'])

function hasCoordinatedLaunch(attempt: EpicAttempt): boolean {
  return attempt.launch_id !== undefined
}

function validateReviewTransition(previous: EpicAttempt, next: EpicAttempt, label: string): void {
  if (previous.review === undefined || next.review === undefined) return
  if (previous.review === null) return
  if (next.review === null) throw new EpicValidationError(`${label}.review cannot be removed`)
  for (const field of ['review_id', 'agent', 'model', 'checkpoint_commit', 'checkpoint_tree_sha256', 'started_at'] as const) {
    assertEpicEqual(`${label}.review.${field}`, previous.review[field], next.review[field])
  }
  if (!LAUNCH_STATE_ADJACENCY[previous.review.launch_state].has(next.review.launch_state)) {
    throw new EpicValidationError(`${label}.review has invalid launch state transition ${previous.review.launch_state} -> ${next.review.launch_state}`)
  }
  if (previous.review.child_session_id === null && next.review.child_session_id !== null) {
    if (previous.review.launch_state !== 'reserved' || next.review.launch_state !== 'created') {
      throw new EpicValidationError(`${label}.review child_session_id may be set only during reserved -> created`)
    }
  } else assertEpicEqual(`${label}.review.child_session_id`, previous.review.child_session_id, next.review.child_session_id)
  if (previous.review.completed_at !== null) assertEpicEqual(`${label}.review`, previous.review, next.review)
  if (previous.review.completed_at === null && next.review.completed_at === null
    && previous.review.launch_state === next.review.launch_state) assertEpicEqual(`${label}.review`, previous.review, next.review)
}

function validateAttemptTransition(previous: EpicAttempt, next: EpicAttempt, label: string): void {
  for (const field of ['attempt_id', 'worktree_evidence', 'agent', 'model', 'started_at'] as const) assertEpicEqual(`${label}.${field}`, previous[field], next[field])
  if (!ATTEMPT_STATUS_ADJACENCY[previous.status].has(next.status)) throw new EpicValidationError(`invalid attempt status transition ${previous.status} -> ${next.status}`)
  const coordinated = hasCoordinatedLaunch(previous) || hasCoordinatedLaunch(next)
  if (hasCoordinatedLaunch(previous) !== hasCoordinatedLaunch(next)) throw new EpicValidationError(`${label} coordination shape is immutable`)
  if (!coordinated) {
    assertEpicEqual(`${label}.child_session_id`, previous.child_session_id, next.child_session_id)
    if (previous.status !== 'running') { assertEpicEqual(label, previous, next); return }
    if (next.status === 'running') assertEpicEqual(label, previous, next)
    if (previous.checkpoint_commit !== null) assertEpicEqual(`${label}.checkpoint_commit`, previous.checkpoint_commit, next.checkpoint_commit)
    if (next.status === 'passed' && next.checkpoint_commit === null) throw new EpicValidationError(`${label} passed transition requires a checkpoint commit`)
    if ((next.status === 'failed' || next.status === 'cancelled') && next.checkpoint_commit !== previous.checkpoint_commit) throw new EpicValidationError(`${label} may set a checkpoint only when passing`)
    return
  }
  assertEpicEqual(`${label}.launch_id`, previous.launch_id, next.launch_id)
  if (!LAUNCH_STATE_ADJACENCY[previous.launch_state!].has(next.launch_state!)) throw new EpicValidationError(`${label} has invalid launch state transition ${previous.launch_state} -> ${next.launch_state}`)
  if (previous.child_session_id === null && next.child_session_id !== null) {
    if (previous.launch_state !== 'reserved' || next.launch_state !== 'created') throw new EpicValidationError(`${label} child_session_id may be set only during reserved -> created`)
  } else assertEpicEqual(`${label}.child_session_id`, previous.child_session_id, next.child_session_id)
  if (previous.launch_state === 'reserved' && next.launch_state === 'settled'
    && (next.status !== 'cancelled' || next.child_session_id !== null)) {
    throw new EpicValidationError(`${label} reserved launch may settle without creation only as a no-child cancellation`)
  }
  if (previous.checkpoint_commit !== null) assertEpicEqual(`${label}.checkpoint_commit`, previous.checkpoint_commit, next.checkpoint_commit)
  if (previous.checkpoint_tree_sha256 !== null) assertEpicEqual(`${label}.checkpoint_tree_sha256`, previous.checkpoint_tree_sha256, next.checkpoint_tree_sha256)
  if (previous.status === 'running' && next.status === 'checkpointed') {
    if (previous.checkpoint_commit !== null || previous.checkpoint_tree_sha256 !== null || next.checkpoint_commit === null || next.checkpoint_tree_sha256 === null) throw new EpicValidationError(`${label} checkpoint transition must set one exact commit and tree digest`)
    if (previous.launch_state !== 'prompted' || next.launch_state !== 'prompted') throw new EpicValidationError(`${label} checkpoint transition requires a prompted launch`)
  } else if (previous.checkpoint_commit === null && next.checkpoint_commit !== null) throw new EpicValidationError(`${label} checkpoint may be set only during running -> checkpointed`)
  if (previous.status === 'checkpointed' && next.status === 'reviewing') {
    if (previous.review !== null || next.review === null) throw new EpicValidationError(`${label} reviewing transition must create one checkpoint-bound review record`)
    const review = next.review
    if (review === undefined || review.launch_state !== 'reserved' || review.child_session_id !== null) {
      throw new EpicValidationError(`${label} reviewing transition must durably reserve a no-child review launch before creation`)
    }
  } else if (previous.review === null && next.review !== null) throw new EpicValidationError(`${label} review may be created only during checkpointed -> reviewing`)
  validateReviewTransition(previous, next, label)
  if (previous.progress_commit !== next.progress_commit || previous.progress_tree_sha256 !== next.progress_tree_sha256) {
    if (previous.status !== 'running' || next.status !== 'running' || !['created', 'prompted'].includes(next.launch_state!)) throw new EpicValidationError(`${label} progress checkpoint may change only during running execution`)
  }
  if (!ACTIVE_ATTEMPT_STATUSES.has(previous.status)) assertEpicEqual(label, previous, next)
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
    if (hasCoordinatedLaunch(appended) && (appended.launch_state !== 'reserved' || appended.child_session_id !== null)) {
      throw new EpicValidationError(`${label} coordinated attempt must be durably reserved before child creation`)
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
    if (next.retry_not_before != null) throw new EpicValidationError(`${label} retry must clear current retry_not_before`)
    if (next.conflict_paths.length !== 0) throw new EpicValidationError(`${label} retry must clear current conflict paths`)
    if (next.status === 'queued' && (next.worktree_name !== null || next.branch_name !== null)) throw new EpicValidationError(`${label} queued retry must clear current worktree selection`)
    return
  }
  const settles_item_attempt = previous.status === 'running' && next.status !== 'running'
  if (!settles_item_attempt && (previous.retry_not_before ?? null) !== (next.retry_not_before ?? null)) throw new EpicValidationError(`${label}.retry_not_before may change only on settlement or retry`)
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
  assertEpicEqual('coordination_policy', previous.coordination_policy ?? null, next.coordination_policy ?? null)
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
  validateIntegrationIntentTransition(previous, next, appendedEvents, outcomes)
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

function validateIntegrationIntentTransition(
  previous: EpicState,
  next: EpicState,
  appendedEvents: EpicIntegrationEvent[],
  outcomes: Array<{ item_id: string; result: 'success' | 'failure' }>,
): void {
  const old_intent = previous.integration_intent ?? null
  const new_intent = next.integration_intent ?? null
  if (old_intent === null && new_intent !== null) {
    if (!next.coordination_policy) throw new EpicValidationError('integration intent requires coordination policy')
    if (outcomes.length !== 0 || appendedEvents.length !== 0) throw new EpicValidationError('integration intent must be persisted before the integration operation')
    if (new_intent.prior_state_revision !== previous.state_revision) throw new EpicValidationError('integration intent prior revision is stale')
    if (new_intent.prior_state_sha256 !== epicStateDigest(previous)) throw new EpicValidationError('integration intent prior state digest is stale')
    const selected = previous.items[new_intent.item_id]
    if (!selected || selected.status !== 'passed' || selected.selected_attempt_id !== new_intent.attempt_id
      || selected.checkpoint_commit !== new_intent.expected_source_commit
      || selected.review_evidence_digest !== new_intent.review_evidence_digest
      || computeDependencySnapshotDigest(previous, selected) !== new_intent.dependency_snapshot_sha256) {
      throw new EpicValidationError('integration intent identity is stale or does not bind the selected reviewed attempt')
    }
    return
  }
  if (old_intent === null) {
    if (previous.coordination_policy && outcomes.length !== 0) throw new EpicValidationError('coordinated integration requires a previously persisted intent')
    return
  }
  if (new_intent !== null) {
    assertEpicEqual('integration_intent', old_intent, new_intent)
    if (outcomes.length !== 0) throw new EpicValidationError('integration outcome must exactly settle and clear its persisted intent')
    return
  }
  if (outcomes.length !== 1 || appendedEvents.length !== 1) throw new EpicValidationError('integration intent may be cleared only by one exact settlement')
  const outcome = outcomes[0]!
  const event = appendedEvents[0]!
  if (old_intent.operation !== 'integrate'
    || old_intent.item_id !== outcome.item_id
    || old_intent.attempt_id !== event.attempt_id
    || old_intent.expected_source_commit !== event.source_commit
    || old_intent.expected_target_commit !== event.target_commit
    || old_intent.dependency_snapshot_sha256 !== event.dependency_snapshot_sha256
    || old_intent.review_evidence_digest !== event.review_evidence_digest) {
    throw new EpicValidationError('integration intent settlement does not exactly match the integration outcome')
  }
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
  if (state.coordination_policy) {
    const intent = state.integration_intent
    if (!intent) throw new EpicValidationError('coordinated integration helper requires a persisted integration intent')
    if (intent.operation !== 'integrate'
      || intent.item_id !== itemId
      || intent.attempt_id !== item.selected_attempt_id
      || intent.expected_source_commit !== eventInput.source_commit
      || intent.expected_target_commit !== eventInput.target_commit
      || intent.dependency_snapshot_sha256 !== eventInput.dependency_snapshot_sha256
      || intent.review_evidence_digest !== eventInput.review_evidence_digest) {
      throw new EpicValidationError('integration helper input does not exactly match the persisted integration intent')
    }
  }
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
    ...(state.coordination_policy ? { integration_intent: null } : {}),
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
    ...(state.coordination_policy ? { integration_intent: null } : {}),
  }
  return validateEpicTransition(state, next)
}
