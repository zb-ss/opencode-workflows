import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { FailureClassSchema } from '../../lib/automation-policy-contracts.ts'
import * as epicContracts from '../../lib/epic-contracts.ts'
import { epicStateJsonSchema } from '../../lib/epic-contracts-json-schema.ts'
import { EpicStateStructuralSchema } from '../../lib/epic-contract-schemas.ts'
import {
  EPIC_SCHEMA_VERSION,
  EpicBudgetExtension,
  EpicBudgetRecord,
  EpicBudgetUpdate,
  EpicAttempt,
  EpicConfigSchema,
  EpicItem,
  EpicSchemaVersionError,
  EpicState,
  EpicValidationError,
  computeDependencySnapshotDigest,
  computeEpicIdentityDigest,
  computeIntegrationEventDigest,
  deriveEpicWorktreeIdentity,
  deterministicEpicOrder,
  effectiveEpicItemLimit,
  emptyAutomationUsageTelemetry,
  parseEpicConfig,
  projectIdentitySha256,
  stableCanonicalJson,
  transitionEpicItemToConflicted,
  transitionEpicItemToIntegrated,
  validateEpicDag,
  validateEpicState,
  validateEpicTransition,
} from '../../lib/epic-contracts.ts'
import {
  epicStatusOnly,
  openEpicStore,
} from '../../lib/epic-persistence.ts'
import { epicStateDigest } from '../../lib/epic-persistence-codec.ts'

const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)
const NOW = '2026-07-18T12:00:00.000Z'
const LATER = '2026-07-18T12:05:00.000Z'
const AT = (minute: number) => `2026-07-18T12:${String(minute).padStart(2, '0')}:00.000Z`
const temporary_directories: string[] = []

afterEach(() => {
  for (const directory of temporary_directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  delete process.env.OPENCODE_CONFIG_DIR
})

function item(overrides: Partial<EpicItem> & { item_id: string }): EpicItem {
  const selected_attempt = overrides.attempts?.find(attempt => attempt.attempt_id === overrides.selected_attempt_id)
  const current_attempt = overrides.status === 'running' ? overrides.attempts?.at(-1) : selected_attempt
  return {
    item_id: overrides.item_id,
    dependencies: overrides.dependencies ?? [],
    scope: overrides.scope ?? 'Implement the declared item.',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? [],
    selected_attempt_id: overrides.selected_attempt_id ?? null,
    worktree_name: overrides.worktree_name === undefined ? current_attempt?.worktree_evidence.worktree_name ?? null : overrides.worktree_name,
    branch_name: overrides.branch_name === undefined ? current_attempt?.worktree_evidence.branch_name ?? null : overrides.branch_name,
    checkpoint_commit: overrides.checkpoint_commit ?? null,
    review_evidence_digest: overrides.review_evidence_digest ?? null,
    conflict_paths: overrides.conflict_paths ?? [],
    integration_commit: overrides.integration_commit ?? null,
    completed_at: overrides.completed_at ?? null,
  }
}

function worktreeEvidence(item_id = 'item-a', attempt_id = 'attempt-1') {
  return {
    ...deriveEpicWorktreeIdentity('epic-1', item_id, attempt_id),
    base_commit: OID('0'),
    worktree_path_sha256: SHA('1'),
    worktree_directory_dev: '1',
    worktree_directory_ino: '2',
    git_common_directory_sha256: SHA('2'),
    git_common_directory_dev: '3',
    git_common_directory_ino: '4',
  }
}

function baseState(overrides: Partial<EpicState> = {}): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: {
      max_epic_items: 8,
      max_item_dependencies: 4,
      max_attempts_per_item: 3,
      max_budget_records: 16,
    },
    epic_id: 'epic-1',
    root_session_id: 'session-1',
    project_identity_sha256: SHA('a'),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/epic-integration',
    status: 'pending',
    pause_reason: null,
    created_at: NOW,
    updated_at: LATER,
    items: {
      'item-a': item({ item_id: 'item-a' }),
      'item-b': item({ item_id: 'item-b', dependencies: ['item-a'] }),
    },
    integration_log: [],
    usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }],
    budget_updates: [],
    ...overrides,
  }
}

function budget(overrides: Partial<EpicBudgetRecord> = {}): EpicBudgetRecord {
  return {
    dimension: overrides.dimension ?? 'sessions',
    scope: overrides.scope ?? 'epic',
    item_id: overrides.item_id ?? null,
    limit: overrides.limit === undefined ? 5 : overrides.limit,
    extensions: overrides.extensions ?? [],
  }
}

function policyRecord(overrides: Partial<EpicBudgetUpdate> = {}): EpicBudgetUpdate {
  return {
    update_id: overrides.update_id ?? 'update-1',
    actor_session_id: overrides.actor_session_id ?? 'session-1',
    project_identity: overrides.project_identity ?? SHA('a'),
    dimension: overrides.dimension ?? 'sessions',
    scope: overrides.scope ?? 'epic',
    item_id: overrides.item_id ?? null,
    previous_limit: overrides.previous_limit === undefined ? 1 : overrides.previous_limit,
    new_limit: overrides.new_limit === undefined ? 2 : overrides.new_limit,
    reason: overrides.reason ?? 'Operator-approved policy change.',
    recorded_at: overrides.recorded_at ?? NOW,
    state_revision: overrides.state_revision ?? 1,
    fencing_generation: null,
  }
}

function reviewedAttempt(attempt_id = 'attempt-1', item_id = 'item-a'): EpicAttempt {
  return {
    attempt_id, worktree_evidence: worktreeEvidence(item_id, attempt_id), agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: LATER,
    checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), result_summary: 'Passed review.',
    failure_classification: null, status: 'passed' as const,
  }
}

function withConfigDir(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-contracts-'))
  temporary_directories.push(directory)
  process.env.OPENCODE_CONFIG_DIR = directory
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

function enabledEpicConfig() {
  return {
    enabled: true as const,
    max_epic_items: 12,
    max_item_dependencies: 4,
    max_attempts_per_item: 3,
    max_budget_records: 24,
    executor_agent: 'epic-executor',
    executor_model_tier: 'mid' as const,
    reviewer_agent: 'epic-reviewer',
    reviewer_model_tier: 'high' as const,
    max_parallel_sessions: 2,
    max_attempt_duration_ms: 300_000,
    active_time_checkpoint_ms: 30_000,
    max_result_bytes: 1_048_576,
    retry_policy: retryPolicy(),
  }
}

function coordinationPolicy() {
  return {
    policy_version: 1 as const,
    executor_agent: 'epic-executor',
    executor_candidates: [{ model: 'example/model-a' }],
    reviewer_agent: 'epic-reviewer',
    reviewer_candidates: [{ model: 'example/model-b' }],
    max_parallel_sessions: 2,
    provider_concurrency: { example: 2 },
    retry_policy: retryPolicy(),
    max_attempt_duration_ms: 300_000,
    active_time_checkpoint_ms: 30_000,
    max_result_bytes: 1_048_576,
    provider_cost_reporting: { example: { status: 'unknown' as const } },
  }
}

function coordinatedLifecycle() {
  const policy = coordinationPolicy()
  const queued = baseState({
    status: 'running',
    updated_at: NOW,
    coordination_policy: policy,
    items: { 'item-a': item({ item_id: 'item-a', status: 'queued' }) },
  })
  const reservedAttempt: EpicAttempt = {
    attempt_id: 'attempt-coordinated',
    worktree_evidence: worktreeEvidence('item-a', 'attempt-coordinated'),
    agent: policy.executor_agent,
    model: policy.executor_candidates[0]!.model,
    child_session_id: null,
    started_at: AT(1),
    completed_at: null,
    checkpoint_commit: null,
    review_evidence_digest: null,
    result_summary: null,
    failure_classification: null,
    status: 'running',
    launch_id: 'launch-1',
    launch_state: 'reserved',
    progress_commit: null,
    progress_tree_sha256: null,
    checkpoint_tree_sha256: null,
    review: null,
  }
  const reserved = validateEpicTransition(queued, {
    ...queued,
    state_revision: 2,
    updated_at: AT(1),
    items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [reservedAttempt] }) },
  })
  const createdAttempt: EpicAttempt = { ...reservedAttempt, child_session_id: 'child-1', launch_state: 'created' }
  const created = validateEpicTransition(reserved, {
    ...reserved,
    state_revision: 3,
    updated_at: AT(2),
    items: { 'item-a': { ...reserved.items['item-a']!, attempts: [createdAttempt] } },
  })
  const promptedAttempt: EpicAttempt = { ...createdAttempt, launch_state: 'prompted' }
  const prompted = validateEpicTransition(created, {
    ...created,
    state_revision: 4,
    updated_at: AT(3),
    items: { 'item-a': { ...created.items['item-a']!, attempts: [promptedAttempt] } },
  })
  const checkpointedAttempt: EpicAttempt = {
    ...promptedAttempt,
    status: 'checkpointed',
    checkpoint_commit: OID('1'),
    checkpoint_tree_sha256: SHA('1'),
  }
  const checkpointed = validateEpicTransition(prompted, {
    ...prompted,
    state_revision: 5,
    updated_at: AT(4),
    items: { 'item-a': { ...prompted.items['item-a']!, attempts: [checkpointedAttempt] } },
  })
  const review = {
    review_id: 'review-1',
    agent: policy.reviewer_agent,
    model: policy.reviewer_candidates[0]!.model,
    child_session_id: null,
    launch_state: 'reserved' as const,
    checkpoint_commit: OID('1'),
    checkpoint_tree_sha256: SHA('1'),
    started_at: AT(5),
    completed_at: null,
    verdict: null,
    evidence_digest: null,
    result_summary: null,
  }
  const reviewingAttempt: EpicAttempt = { ...checkpointedAttempt, status: 'reviewing', review }
  const reviewing = validateEpicTransition(checkpointed, {
    ...checkpointed,
    state_revision: 6,
    updated_at: AT(5),
    items: { 'item-a': { ...checkpointed.items['item-a']!, attempts: [reviewingAttempt] } },
  })
  const createdReview = { ...review, child_session_id: 'review-child-1', launch_state: 'created' as const }
  const reviewCreatedAttempt: EpicAttempt = { ...reviewingAttempt, review: createdReview }
  const reviewCreated = validateEpicTransition(reviewing, {
    ...reviewing,
    state_revision: 7,
    updated_at: AT(5),
    items: { 'item-a': { ...reviewing.items['item-a']!, attempts: [reviewCreatedAttempt] } },
  })
  const promptedReview = { ...createdReview, launch_state: 'prompted' as const }
  const reviewPromptedAttempt: EpicAttempt = { ...reviewCreatedAttempt, review: promptedReview }
  const reviewPrompted = validateEpicTransition(reviewCreated, {
    ...reviewCreated,
    state_revision: 8,
    updated_at: AT(5),
    items: { 'item-a': { ...reviewCreated.items['item-a']!, attempts: [reviewPromptedAttempt] } },
  })
  const completedReview = {
    ...promptedReview,
    launch_state: 'settled' as const,
    completed_at: AT(6),
    verdict: 'passed' as const,
    evidence_digest: SHA('b'),
    result_summary: 'Review passed.',
  }
  const reviewedAttempt: EpicAttempt = { ...reviewPromptedAttempt, review: completedReview, review_evidence_digest: SHA('b') }
  const reviewed = validateEpicTransition(reviewPrompted, {
    ...reviewPrompted,
    state_revision: 9,
    updated_at: AT(6),
    items: { 'item-a': { ...reviewPrompted.items['item-a']!, attempts: [reviewedAttempt] } },
  })
  const passedAttempt: EpicAttempt = {
    ...reviewedAttempt,
    status: 'passed',
    launch_state: 'settled',
    completed_at: AT(7),
    result_summary: 'Execution and review passed.',
  }
  const passed = validateEpicTransition(reviewed, {
    ...reviewed,
    state_revision: 10,
    updated_at: AT(7),
    items: { 'item-a': {
      ...reviewed.items['item-a']!,
      status: 'passed',
      attempts: [passedAttempt],
      selected_attempt_id: passedAttempt.attempt_id,
      checkpoint_commit: passedAttempt.checkpoint_commit,
      review_evidence_digest: passedAttempt.review_evidence_digest,
      completed_at: AT(7),
    } },
  })
  return { queued, reserved, created, prompted, checkpointed, reviewing, reviewCreated, reviewPrompted, reviewed, passed }
}

function coordinatedIntent(expected_target_commit: string, intent_id: string) {
  const passed = coordinatedLifecycle().passed
  const passedItem = passed.items['item-a']!
  const intent = {
    intent_id,
    operation: 'integrate' as const,
    item_id: 'item-a',
    attempt_id: passedItem.selected_attempt_id!,
    prior_state_revision: passed.state_revision,
    prior_state_sha256: epicStateDigest(passed),
    prior_generation: 7,
    expected_source_commit: passedItem.checkpoint_commit!,
    expected_target_commit,
    dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem),
    review_evidence_digest: passedItem.review_evidence_digest!,
  }
  const intended = validateEpicTransition(passed, {
    ...passed,
    state_revision: passed.state_revision + 1,
    updated_at: AT(8),
    integration_intent: intent,
  })
  return {
    intended,
    eventInput: {
      event_id: `${intent_id}-event`,
      dependency_snapshot_sha256: intent.dependency_snapshot_sha256,
      source_commit: intent.expected_source_commit,
      previous_target_commit: intent.expected_target_commit,
      target_commit: OID('4'),
      review_evidence_digest: intent.review_evidence_digest,
      recorded_at: AT(9),
    },
  }
}

describe('epic configuration', () => {
  it('defaults to exactly disabled and requires all limits to enable', () => {
    assert.deepEqual(EpicConfigSchema.parse(undefined), { enabled: false })
    assert.equal(EpicConfigSchema.safeParse({ enabled: true }).success, false)
    const enabled = EpicConfigSchema.parse(enabledEpicConfig())
    assert.equal(enabled.enabled && enabled.max_epic_items, 12)
    assert.throws(() => parseEpicConfig({ enabled: false, max_epic_items: 2 }), /invalid epic configuration/)
  })

  it('rejects unknown fields, maxima violations, and model or provider fields', () => {
    assert.equal(EpicConfigSchema.safeParse({ enabled: false, provider: 'example' }).success, false)
    assert.equal(EpicConfigSchema.safeParse({ ...enabledEpicConfig(), max_epic_items: 257 }).success, false)
  })
})

describe('epic state version and public schema', () => {
  it('accepts direct version 2 with omitted or empty budgets', () => {
    assert.equal(validateEpicState(baseState()).schema_version, 2)
    assert.deepEqual(validateEpicState({ ...baseState(), budgets: [] }).budgets, [])
  })

  it('rejects unsupported version 1 distinctly without migration', () => {
    assert.throws(
      () => validateEpicState({ ...baseState(), schema_version: 1 }),
      EpicSchemaVersionError,
    )
    assert.throws(() => validateEpicState({ ...baseState(), epic_id: 'not safe' }), EpicValidationError)
  })

  it('rejects prototype-like identifiers at the structural boundary', () => {
    const state = baseState()
    const malicious = JSON.parse(JSON.stringify(state)) as EpicState
    malicious.items = JSON.parse(`{"constructor":${JSON.stringify(item({ item_id: 'constructor' }))}}`) as Record<string, EpicItem>
    assert.throws(() => validateEpicState(malicious), /reserved object property/)
  })

  it('matches the generated structural public schema exactly', () => {
    const public_schema = JSON.parse(fs.readFileSync(path.resolve('schema/epic-state.schema.json'), 'utf8'))
    assert.deepEqual(public_schema, epicStateJsonSchema())
  })

  it('keeps stable barrel exports while structural schema internals stay module-scoped', () => {
    assert.equal(epicContracts.EpicStateSchema.safeParse(baseState()).success, true)
    assert.equal(EpicStateStructuralSchema.safeParse(baseState()).success, true)
    assert.equal('EpicStateStructuralSchema' in epicContracts, false)
    assert.equal('isValidDimensionLimit' in epicContracts, false)
    assert.equal(epicContracts.validateEpicTransition, validateEpicTransition)
    assert.equal(epicContracts.transitionEpicItemToIntegrated, transitionEpicItemToIntegrated)
  })
})

describe('typed budgets and independent usage', () => {
  it('round-trips usage without budgets, including unknown cost and active fields', () => {
    const telemetry = {
      ...emptyAutomationUsageTelemetry(),
      sessions: 2,
      active_time_ms: 100,
      active_interval_started_at: NOW,
      last_active_checkpoint_at: LATER,
    }
    const state = validateEpicState({
      ...baseState(),
      status: 'running',
      updated_at: LATER,
      usage: [
        { scope: 'epic', item_id: null, usage: telemetry },
        { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
      ],
    })
    assert.deepEqual(state.usage[0]!.usage, telemetry)
  })

  it('accepts zero and disabled null limits with dimension-aware numbers', () => {
    assert.doesNotThrow(() => validateEpicState({
      ...baseState(),
      budgets: [
        budget({ dimension: 'sessions', limit: 0 }),
        budget({ dimension: 'cost_usd', limit: 0.25 }),
        budget({ dimension: 'active_time_ms', limit: null }),
      ],
      usage: [
        baseState().usage[0]!,
        { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
      ],
    }))
  })

  it('rejects unknown dimensions, fractional integer dimensions, and non-finite cost', () => {
    for (const record of [
      { ...budget(), dimension: 'requests' },
      budget({ dimension: 'sessions', limit: 1.5 }),
      budget({ dimension: 'cost_usd', limit: Number.POSITIVE_INFINITY }),
    ]) assert.throws(() => validateEpicState({ ...baseState(), budgets: [record] }), EpicValidationError)
  })

  it('rejects consumed policy fields, duplicate targets, invalid item targets, and global records', () => {
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [{ ...budget(), consumed: 1 }] }), EpicValidationError)
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [budget(), budget()] }), /duplicate active budget/)
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [budget({ scope: 'item', item_id: 'ghost' })] }), /unknown item/)
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [budget({ scope: 'global' })] }), /global-owned/)
  })

  it('requires exactly one epic usage and unique valid item usage', () => {
    assert.throws(() => validateEpicState({ ...baseState(), usage: [] }), /exactly one epic usage/)
    const duplicate = { scope: 'item' as const, item_id: 'item-a', usage: emptyAutomationUsageTelemetry() }
    assert.throws(() => validateEpicState({ ...baseState(), usage: [baseState().usage[0]!, duplicate, duplicate] }), /duplicate scoped usage/)
    assert.throws(() => validateEpicState({ ...baseState(), usage: [{ scope: 'global', item_id: null, usage: emptyAutomationUsageTelemetry() }] }), /global-owned/)
  })

  it('resolves the minimum across item, epic, and optional global limits', () => {
    const state = validateEpicState({
      ...baseState(),
      budgets: [
        budget({ dimension: 'sessions', limit: 5 }),
        budget({ dimension: 'sessions', scope: 'item', item_id: 'item-a', limit: 8 }),
        budget({ dimension: 'input_tokens', scope: 'item', item_id: 'item-a', limit: 0 }),
      ],
      usage: [
        baseState().usage[0]!,
        { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
      ],
    })
    assert.equal(effectiveEpicItemLimit(state, 'item-a', 'sessions'), 5)
    assert.equal(effectiveEpicItemLimit(state, 'item-a', 'sessions', 3), 3)
    assert.equal(effectiveEpicItemLimit(state, 'item-b', 'sessions'), 5)
    assert.equal(effectiveEpicItemLimit(state, 'item-a', 'input_tokens'), 0)
    assert.equal(effectiveEpicItemLimit(state, 'item-b', 'output_tokens'), null)
    assert.equal(effectiveEpicItemLimit(state, 'item-b', 'output_tokens', 0), 0)
    assert.equal(effectiveEpicItemLimit(state, 'item-a', 'sessions', null), 5)
  })

  it('allows observed usage above a newly lowered limit', () => {
    const usage = { ...emptyAutomationUsageTelemetry(), input_tokens: 100 }
    assert.doesNotThrow(() => validateEpicState({
      ...baseState(),
      budgets: [budget({ dimension: 'input_tokens', limit: 10 })],
      usage: [{ scope: 'epic', item_id: null, usage }],
    }))
  })

  it('requires exhausted and unmeasurable budget scopes to stop running', () => {
    const exactUsage = { ...emptyAutomationUsageTelemetry(), sessions: 5 }
    const running = baseState({
      status: 'running',
      budgets: [budget({ limit: 5 })],
      usage: [{ scope: 'epic', item_id: null, usage: exactUsage }],
    })
    assert.throws(() => validateEpicState(running), /must not remain running/)
    assert.throws(() => validateEpicState({
      ...running,
      budgets: [budget({ dimension: 'input_tokens', limit: 4 })],
      usage: [{ scope: 'epic', item_id: null, usage: { ...exactUsage, input_tokens: 5 } }],
    }), /must not remain running/)
    assert.throws(() => validateEpicState({
      ...running,
      budgets: [budget({ dimension: 'cost_usd', limit: 1 })],
      usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }],
    }), /must not remain running/)
    assert.doesNotThrow(() => validateEpicState({
      ...running,
      status: 'paused',
      pause_reason: 'Budget exhausted.',
    }))
  })

  it('requires item budget telemetry and stops only the exhausted item scope', () => {
    const runningAttempt = {
      attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null,
      started_at: NOW, completed_at: null, checkpoint_commit: null, review_evidence_digest: null,
      result_summary: null, failure_classification: null, status: 'running' as const,
    }
    const itemBudget = budget({ scope: 'item', item_id: 'item-a', limit: 1 })
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [itemBudget] }), /matching scoped usage/)
    assert.throws(() => validateEpicState({
      ...baseState(),
      status: 'running',
      budgets: [itemBudget],
      items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [runningAttempt] }) },
      usage: [
        { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
        { scope: 'item', item_id: 'item-a', usage: { ...emptyAutomationUsageTelemetry(), sessions: 1 } },
      ],
    }), /must not remain running/)
  })
})

describe('budget update and extension evidence', () => {
  it('accepts root-owned add, remove, decrease, and strict extension records', () => {
    const extension = policyRecord({ update_id: 'extension-1', previous_limit: 2, new_limit: 3, state_revision: 3 }) as EpicBudgetExtension
    assert.doesNotThrow(() => validateEpicState({
      ...baseState(),
      state_revision: 4,
      budgets: [budget({ limit: null, extensions: [extension] })],
      budget_updates: [
        policyRecord({ update_id: 'add', previous_limit: null, new_limit: 5, state_revision: 1 }),
        policyRecord({ update_id: 'decrease', previous_limit: 5, new_limit: 2, state_revision: 2 }),
        policyRecord({ update_id: 'extension-root', previous_limit: 2, new_limit: 3, state_revision: 3 }),
        policyRecord({ update_id: 'remove', previous_limit: 3, new_limit: null, state_revision: 4 }),
      ],
    }))
  })

  it('rejects extension removals/decreases and unchanged updates', () => {
    for (const extension of [
      policyRecord({ previous_limit: 2, new_limit: null }),
      policyRecord({ previous_limit: 2, new_limit: 1 }),
    ]) assert.throws(() => validateEpicState({ ...baseState(), budgets: [budget({ extensions: [extension as EpicBudgetExtension] })] }), /strict increase/)
    assert.throws(() => validateEpicState({ ...baseState(), budget_updates: [policyRecord({ previous_limit: 2, new_limit: 2 })] }), /must differ/)
  })

  it('rejects duplicate IDs, wrong owner/project/target, future or unordered revisions, fencing, and globals', () => {
    const extension = policyRecord({ update_id: 'same' }) as EpicBudgetExtension
    const cases: unknown[] = [
      { ...baseState(), budgets: [budget({ extensions: [extension] })], budget_updates: [policyRecord({ update_id: 'same' })] },
      { ...baseState(), budget_updates: [policyRecord({ actor_session_id: 'child' })] },
      { ...baseState(), budget_updates: [policyRecord({ project_identity: SHA('b') })] },
      { ...baseState(), budget_updates: [policyRecord({ scope: 'item', item_id: 'ghost' })] },
      { ...baseState(), budget_updates: [policyRecord({ state_revision: 2 })] },
      { ...baseState(), state_revision: 3, budget_updates: [policyRecord({ update_id: 'later', state_revision: 2 }), policyRecord({ update_id: 'earlier', state_revision: 1 })] },
      { ...baseState(), budget_updates: [{ ...policyRecord(), fencing_generation: 1 }] },
      { ...baseState(), budget_updates: [policyRecord({ scope: 'global' })] },
      { ...baseState(), budgets: [budget({ dimension: 'sessions', extensions: [policyRecord({ dimension: 'input_tokens' }) as EpicBudgetExtension] })] },
    ]
    for (const state of cases) assert.throws(() => validateEpicState(state), EpicValidationError)
  })

  it('rejects orphan extensions on unchanged limits and fabricated history on new records', () => {
    const previous = baseState({ budgets: [budget({ limit: 2 })] })
    const extension = policyRecord({ update_id: 'extension', previous_limit: 1, new_limit: 2, state_revision: 2 }) as EpicBudgetExtension
    const root = policyRecord({ update_id: 'root', previous_limit: 1, new_limit: 2, state_revision: 2 })
    const unchanged = { ...previous, state_revision: 2, updated_at: LATER, budgets: [budget({ limit: 2, extensions: [extension] })], budget_updates: [root] }
    assert.throws(() => validateEpicTransition(previous, unchanged), /invalid extension evidence|policy change/)

    const withoutBudget = baseState()
    const fabricated = { ...withoutBudget, state_revision: 2, updated_at: LATER, budgets: [budget({ limit: 2, extensions: [extension] })], budget_updates: [root] }
    assert.throws(() => validateEpicTransition(withoutBudget, fabricated), /must start without extension history/)
  })

  it('requires root update continuity and the active limit to equal the latest update', () => {
    const first = policyRecord({ update_id: 'first', previous_limit: 1, new_limit: 2, state_revision: 1 }) as EpicBudgetExtension
    const discontinuous = policyRecord({ update_id: 'second', previous_limit: 3, new_limit: 4, state_revision: 2 }) as EpicBudgetExtension
    const updates = [
      policyRecord({ update_id: 'first-root', previous_limit: 1, new_limit: 2, state_revision: 1 }),
      policyRecord({ update_id: 'second-root', previous_limit: 3, new_limit: 4, state_revision: 2 }),
    ]
    assert.throws(() => validateEpicState({ ...baseState(), state_revision: 2, budgets: [budget({ limit: 4, extensions: [first, discontinuous] })], budget_updates: updates }), /continuity/)
    assert.throws(() => validateEpicState({ ...baseState(), budgets: [budget({ limit: 3, extensions: [first] })], budget_updates: [updates[0]!] }), /latest root policy update/)
  })
})

describe('shared failures, DAG, transitions, and identity invariants', () => {
  it('uses the shared closed failure classification and enforces status coupling', () => {
    assert.equal(FailureClassSchema.parse('semantic'), 'semantic')
    const failed = {
      attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: 'provider/model', child_session_id: null,
      started_at: NOW, completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null, result_summary: 'Failed.',
      failure_classification: 'semantic' as const, status: 'failed' as const,
    }
    assert.doesNotThrow(() => validateEpicState({
      ...baseState(),
      items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [failed] }) },
    }))
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...failed, failure_classification: 'timeout' as never }] }) } }), EpicValidationError)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'passed', completed_at: LATER, attempts: [{ ...failed, status: 'passed', failure_classification: 'semantic' }] }) } }), /require null classification/)

    for (const failure_classification of ['transport', 'contract', 'semantic', 'ambiguous_launch'] as const) {
      assert.doesNotThrow(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...failed, failure_classification }] }) } }))
    }
    assert.doesNotThrow(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'cancelled', completed_at: LATER, attempts: [{ ...failed, status: 'cancelled', failure_classification: 'cancelled' }] }) } }))
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...failed, failure_classification: 'cancelled' }] }) } }), /requires transport/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'cancelled', completed_at: LATER, attempts: [{ ...failed, status: 'cancelled', failure_classification: null }] }) } }), /requires cancelled/)
  })

  it('preserves the historical terminal review-evidence compatibility matrix', () => {
    const failed = {
      attempt_id: 'attempt-failed', worktree_evidence: worktreeEvidence('item-a', 'attempt-failed'), agent: 'executor', model: null, child_session_id: null,
      started_at: NOW, completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null,
      result_summary: 'Failed.', failure_classification: 'semantic' as const, status: 'failed' as const,
    }
    const cancelled = { ...failed, status: 'cancelled' as const, failure_classification: 'cancelled' as const, result_summary: 'Cancelled.' }
    for (const attempt of [failed, cancelled]) {
      assert.doesNotThrow(() => validateEpicState({
        ...baseState(),
        items: { 'item-a': item({ item_id: 'item-a', status: attempt.status, completed_at: LATER, attempts: [attempt] }) },
      }))
      assert.throws(() => validateEpicState({
        ...baseState(),
        items: { 'item-a': item({ item_id: 'item-a', status: attempt.status, completed_at: LATER, attempts: [{ ...attempt, review_evidence_digest: SHA('b') }] }) },
      }), /only passed historical attempts may carry review evidence/)
    }
  })

  it('allows one running-to-passed checkpoint binding and freezes reviewed attempt history', () => {
    const runningAttempt = { attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null, failure_classification: null, status: 'running' as const }
    const previous = baseState({ status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [runningAttempt] }), 'item-b': item({ item_id: 'item-b', dependencies: ['item-a'] }) } })
    const passedAttempt = { ...runningAttempt, status: 'passed' as const, completed_at: LATER, checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), result_summary: 'Passed review.' }
    const next = { ...previous, state_revision: 2, updated_at: LATER, items: { ...previous.items, 'item-a': { ...previous.items['item-a']!, status: 'passed' as const, attempts: [passedAttempt], selected_attempt_id: 'attempt-1', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER } } }
    assert.doesNotThrow(() => validateEpicTransition(previous, next))
    assert.throws(() => validateEpicTransition(previous, { ...next, items: { ...next.items, 'item-a': { ...next.items['item-a']!, checkpoint_commit: OID('2') } } }), /successful passed attempt|checkpoint/)
    assert.throws(() => validateEpicTransition(next, { ...next, state_revision: 3, items: { ...next.items, 'item-a': { ...next.items['item-a']!, attempts: [...next.items['item-a']!.attempts, { ...passedAttempt, attempt_id: 'attempt-2' }] } } }), /attempt history|successful passed attempt|terminal record/)
  })

  it('persists reservation before child creation and advances through prompt, checkpoint, review, and pass', () => {
    const lifecycle = coordinatedLifecycle()
    assert.equal(lifecycle.reserved.items['item-a']!.attempts[0]!.launch_state, 'reserved')
    assert.equal(lifecycle.reserved.items['item-a']!.attempts[0]!.child_session_id, null)
    assert.equal(lifecycle.created.items['item-a']!.attempts[0]!.child_session_id, 'child-1')
    assert.equal(lifecycle.prompted.items['item-a']!.attempts[0]!.launch_state, 'prompted')
    assert.equal(lifecycle.checkpointed.items['item-a']!.attempts[0]!.status, 'checkpointed')
    assert.equal(lifecycle.reviewing.items['item-a']!.attempts[0]!.review?.launch_state, 'reserved')
    assert.equal(lifecycle.reviewing.items['item-a']!.attempts[0]!.review?.child_session_id, null)
    assert.equal(lifecycle.reviewCreated.items['item-a']!.attempts[0]!.review?.launch_state, 'created')
    assert.equal(lifecycle.reviewPrompted.items['item-a']!.attempts[0]!.review?.launch_state, 'prompted')
    assert.equal(lifecycle.reviewing.items['item-a']!.attempts[0]!.review?.completed_at, null)
    assert.equal(lifecycle.reviewed.items['item-a']!.attempts[0]!.review?.evidence_digest, SHA('b'))
    assert.equal(lifecycle.reviewed.items['item-a']!.attempts[0]!.review?.launch_state, 'settled')
    assert.equal(lifecycle.passed.items['item-a']!.attempts[0]!.launch_state, 'settled')
  })

  it('freezes coordination policy and rejects malformed launch, checkpoint, and review progression', () => {
    const lifecycle = coordinatedLifecycle()
    assert.throws(() => validateEpicTransition(lifecycle.reserved, {
      ...lifecycle.reserved,
      state_revision: lifecycle.reserved.state_revision + 1,
      updated_at: AT(2),
      coordination_policy: { ...lifecycle.reserved.coordination_policy!, max_result_bytes: 8192 },
    }), /coordination_policy is immutable/)

    const reservedAttempt = lifecycle.reserved.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.reserved, {
      ...lifecycle.reserved,
      state_revision: lifecycle.reserved.state_revision + 1,
      updated_at: AT(2),
      items: { 'item-a': { ...lifecycle.reserved.items['item-a']!, attempts: [{ ...reservedAttempt, launch_state: 'prompted', child_session_id: 'child-1' }] } },
    }), /invalid launch state transition|reserved -> created/)

    const createdAttempt = lifecycle.created.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.created, {
      ...lifecycle.created,
      state_revision: lifecycle.created.state_revision + 1,
      updated_at: AT(3),
      items: { 'item-a': { ...lifecycle.created.items['item-a']!, attempts: [{ ...createdAttempt, child_session_id: 'child-forged' }] } },
    }), /child_session_id is immutable/)

    const promptedAttempt = lifecycle.prompted.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.prompted, {
      ...lifecycle.prompted,
      state_revision: lifecycle.prompted.state_revision + 1,
      updated_at: AT(4),
      items: { 'item-a': { ...lifecycle.prompted.items['item-a']!, attempts: [{ ...promptedAttempt, checkpoint_commit: OID('1'), checkpoint_tree_sha256: SHA('1') }] } },
    }), /running execution must not fabricate|checkpoint may be set only/)

    assert.throws(() => validateEpicTransition(lifecycle.created, {
      ...lifecycle.created,
      state_revision: lifecycle.created.state_revision + 1,
      updated_at: AT(3),
      items: { 'item-a': { ...lifecycle.created.items['item-a']!, attempts: [{
        ...createdAttempt,
        status: 'checkpointed',
        checkpoint_commit: OID('1'),
        checkpoint_tree_sha256: SHA('1'),
      }] } },
    }), /requires a prompted launch/)

    const checkpointedAttempt = lifecycle.checkpointed.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.checkpointed, {
      ...lifecycle.checkpointed,
      state_revision: lifecycle.checkpointed.state_revision + 1,
      updated_at: AT(5),
      items: { 'item-a': { ...lifecycle.checkpointed.items['item-a']!, attempts: [{
        ...checkpointedAttempt,
        status: 'reviewing',
        review: {
          review_id: 'review-bypass', agent: 'epic-reviewer', model: 'example/model-b', child_session_id: 'review-child-bypass',
          launch_state: 'created', checkpoint_commit: checkpointedAttempt.checkpoint_commit!, checkpoint_tree_sha256: checkpointedAttempt.checkpoint_tree_sha256!,
          started_at: AT(5), completed_at: null, verdict: null, evidence_digest: null, result_summary: null,
        },
      }] } },
    }), /durably reserve a no-child review launch/)

    const reviewedAttempt = lifecycle.reviewed.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.reviewed, {
      ...lifecycle.reviewed,
      state_revision: lifecycle.reviewed.state_revision + 1,
      updated_at: AT(7),
      items: { 'item-a': { ...lifecycle.reviewed.items['item-a']!, attempts: [{ ...reviewedAttempt, review: { ...reviewedAttempt.review!, evidence_digest: SHA('c') }, review_evidence_digest: SHA('c') }] } },
    }), /review is immutable/)

    const reviewCreatedAttempt = lifecycle.reviewCreated.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.reviewCreated, {
      ...lifecycle.reviewCreated,
      state_revision: lifecycle.reviewCreated.state_revision + 1,
      updated_at: AT(6),
      items: { 'item-a': { ...lifecycle.reviewCreated.items['item-a']!, attempts: [{
        ...reviewCreatedAttempt,
        review: { ...reviewCreatedAttempt.review!, child_session_id: 'forged-review-child' },
      }] } },
    }), /child_session_id is immutable/)

    const reviewPromptedAttempt = lifecycle.reviewPrompted.items['item-a']!.attempts[0]!
    assert.throws(() => validateEpicTransition(lifecycle.reviewPrompted, {
      ...lifecycle.reviewPrompted,
      state_revision: lifecycle.reviewPrompted.state_revision + 1,
      updated_at: AT(6),
      items: { 'item-a': { ...lifecycle.reviewPrompted.items['item-a']!, attempts: [{
        ...reviewPromptedAttempt,
        review: { ...reviewPromptedAttempt.review!, launch_state: 'settled' },
      }] } },
    }), /incomplete settled review/)
    assert.throws(() => validateEpicTransition(lifecycle.reviewPrompted, {
      ...lifecycle.reviewPrompted,
      state_revision: lifecycle.reviewPrompted.state_revision + 1,
      updated_at: AT(6),
      items: { 'item-a': { ...lifecycle.reviewPrompted.items['item-a']!, attempts: [{
        ...reviewPromptedAttempt,
        review: {
          ...reviewPromptedAttempt.review!, completed_at: AT(6), verdict: 'passed', evidence_digest: SHA('b'), result_summary: 'Passed.',
        },
      }] } },
    }), /completed review requires a settled launch/)
  })

  it('requires a fresh integration intent and clears it only on an exact settlement', () => {
    const passed = coordinatedLifecycle().passed
    const passedItem = passed.items['item-a']!
    const intent = {
      intent_id: 'intent-1',
      operation: 'integrate' as const,
      item_id: 'item-a',
      attempt_id: passedItem.selected_attempt_id!,
      prior_state_revision: passed.state_revision,
      prior_state_sha256: epicStateDigest(passed),
      prior_generation: 7,
      expected_source_commit: passedItem.checkpoint_commit!,
      expected_target_commit: OID('2'),
      dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem),
      review_evidence_digest: passedItem.review_evidence_digest!,
    }
    const intended = validateEpicTransition(passed, {
      ...passed,
      state_revision: passed.state_revision + 1,
      updated_at: AT(8),
      integration_intent: intent,
    })
    assert.equal(intended.integration_intent?.intent_id, 'intent-1')
    assert.throws(() => validateEpicTransition(passed, {
      ...passed,
      state_revision: passed.state_revision + 1,
      updated_at: AT(8),
      integration_intent: { ...intent, prior_state_revision: passed.state_revision - 1 },
    }), /prior revision is stale/)
    assert.throws(() => validateEpicTransition(passed, {
      ...passed,
      state_revision: passed.state_revision + 1,
      updated_at: AT(8),
      integration_intent: { ...intent, prior_state_sha256: SHA('9') },
    }), /prior state digest is stale/)

    const event = {
      event_id: 'event-intent-1',
      item_id: 'item-a',
      attempt_id: intent.attempt_id,
      dependency_snapshot_sha256: intent.dependency_snapshot_sha256,
      source_commit: intent.expected_source_commit,
      previous_target_commit: intent.expected_target_commit,
      target_commit: OID('3'),
      review_evidence_digest: intent.review_evidence_digest,
      result: 'success' as const,
      previous_event_digest: null,
      event_digest: '',
      recorded_at: AT(9),
    }
    event.event_digest = computeIntegrationEventDigest(event)
    const settledInput = {
      ...intended,
      state_revision: intended.state_revision + 1,
      updated_at: AT(9),
      items: { 'item-a': { ...passedItem, status: 'integrated' as const, integration_commit: event.target_commit } },
      integration_log: [event],
      integration_intent: null,
    }
    const settled = validateEpicTransition(intended, settledInput)
    assert.equal(settled.integration_intent, null)
    assert.equal(settled.items['item-a']!.integration_commit, OID('3'))

    const wrongEvent = { ...event, previous_target_commit: OID('3'), event_digest: '' }
    wrongEvent.event_digest = computeIntegrationEventDigest(wrongEvent)
    assert.throws(() => validateEpicTransition(intended, {
      ...settledInput,
      items: { 'item-a': { ...passedItem, status: 'integrated', integration_commit: wrongEvent.target_commit } },
      integration_log: [wrongEvent],
    }), /does not exactly match/)
    assert.throws(() => validateEpicTransition(intended, {
      ...intended,
      state_revision: intended.state_revision + 1,
      updated_at: AT(9),
      integration_intent: null,
    }), /only by one exact settlement/)
  })

  it('settles coordinated success and conflict intents through the public integration helpers', () => {
    const success = coordinatedIntent(OID('2'), 'intent-success')
    const integrated = transitionEpicItemToIntegrated(success.intended, 'item-a', success.eventInput)
    assert.equal(integrated.items['item-a']!.status, 'integrated')
    assert.equal(integrated.items['item-a']!.integration_commit, OID('4'))
    assert.equal(integrated.integration_intent, null)

    const failure = coordinatedIntent(OID('3'), 'intent-conflict')
    const conflicted = transitionEpicItemToConflicted(failure.intended, 'item-a', ['src/conflict.ts'], failure.eventInput)
    assert.equal(conflicted.items['item-a']!.status, 'conflicted')
    assert.deepEqual(conflicted.items['item-a']!.conflict_paths, ['src/conflict.ts'])
    assert.equal(conflicted.integration_intent, null)
  })

  it('rejects coordinated helper settlement without an intent or with mismatched intent input', () => {
    const passed = coordinatedLifecycle().passed
    const passedItem = passed.items['item-a']!
    const withoutIntentInput = {
      event_id: 'event-without-intent',
      dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem),
      source_commit: passedItem.checkpoint_commit!,
      target_commit: OID('2'),
      review_evidence_digest: passedItem.review_evidence_digest!,
      recorded_at: AT(9),
    }
    assert.throws(
      () => transitionEpicItemToIntegrated(passed, 'item-a', withoutIntentInput),
      /requires a persisted integration intent/,
    )

    const mismatch = coordinatedIntent(OID('2'), 'intent-mismatch')
    assert.throws(
      () => transitionEpicItemToIntegrated(mismatch.intended, 'item-a', { ...mismatch.eventInput, previous_target_commit: OID('3') }),
      /does not exactly match the persisted integration intent/,
    )
    assert.throws(
      () => transitionEpicItemToConflicted(mismatch.intended, 'item-a', ['src/conflict.ts'], { ...mismatch.eventInput, review_evidence_digest: SHA('c') }),
      /integration review evidence|does not exactly match the persisted integration intent/,
    )
  })

  it('retries failed items with fresh work while preserving prior attempt evidence', () => {
    const failedAttempt = {
      attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: 'child-1', started_at: NOW,
      completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null, result_summary: 'Contract failed.',
      failure_classification: 'contract' as const, status: 'failed' as const,
    }
    const failedItem = item({ item_id: 'item-a', status: 'failed', attempts: [failedAttempt], completed_at: LATER })
    const previous = baseState({ status: 'running', items: { 'item-a': failedItem } })
    const queued = { ...previous, state_revision: 2, updated_at: LATER, items: { 'item-a': { ...failedItem, status: 'queued' as const, completed_at: null } } }
    const validatedQueued = validateEpicTransition(previous, queued)
    assert.deepEqual(validatedQueued.items['item-a']!.attempts[0], failedAttempt)

    const freshAttempt = {
      attempt_id: 'attempt-2', worktree_evidence: worktreeEvidence('item-a', 'attempt-2'), agent: 'executor', model: null, child_session_id: 'child-2', started_at: LATER,
      completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null,
      failure_classification: null, status: 'running' as const,
    }
    const running = { ...previous, state_revision: 2, updated_at: LATER, items: { 'item-a': { ...failedItem, status: 'running' as const, attempts: [failedAttempt, freshAttempt], worktree_name: freshAttempt.worktree_evidence.worktree_name, branch_name: freshAttempt.worktree_evidence.branch_name, completed_at: null } } }
    const validatedRunning = validateEpicTransition(previous, running)
    assert.deepEqual(validatedRunning.items['item-a']!.attempts[0], failedAttempt)
    assert.equal(validatedRunning.items['item-a']!.attempts[1]!.status, 'running')
  })

  it('rejects fabricated attempt appends and requires settlement of the active attempt', () => {
    const fabricated = {
      attempt_id: 'attempt-fabricated', worktree_evidence: worktreeEvidence('item-a', 'attempt-fabricated'), agent: 'executor', model: null, child_session_id: null,
      started_at: NOW, completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null,
      result_summary: 'Fabricated.', failure_classification: 'contract' as const, status: 'failed' as const,
    }
    const previous = baseState()
    const queued = {
      ...previous,
      state_revision: 2,
      status: 'running' as const,
      updated_at: LATER,
      items: { ...previous.items, 'item-a': item({ item_id: 'item-a', status: 'queued', attempts: [fabricated] }) },
    }
    assert.throws(() => validateEpicTransition(previous, queued), /not append attempts/)

    const runningAttempt = { ...fabricated, completed_at: null, result_summary: null, failure_classification: null, status: 'running' as const }
    const running = baseState({ status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [runningAttempt] }) } })
    const passed = reviewedAttempt('attempt-fabricated')
    const extra = { ...reviewedAttempt('attempt-extra'), started_at: LATER }
    assert.throws(() => validateEpicTransition(running, {
      ...running,
      state_revision: 2,
      updated_at: LATER,
      items: { 'item-a': item({
        item_id: 'item-a', status: 'passed', attempts: [passed, extra], selected_attempt_id: passed.attempt_id,
        checkpoint_commit: passed.checkpoint_commit, review_evidence_digest: passed.review_evidence_digest, completed_at: LATER,
      }) },
    }), /not append attempts/)

    const failedPrevious = baseState({
      status: 'running',
      updated_at: '2026-07-18T12:10:00.000Z',
      items: { 'item-a': item({ item_id: 'item-a', status: 'failed', attempts: [fabricated], completed_at: LATER }) },
    })
    const backdatedRetry = {
      ...failedPrevious,
      state_revision: 2,
      items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [fabricated, { ...runningAttempt, attempt_id: 'attempt-retry', worktree_evidence: worktreeEvidence('item-a', 'attempt-retry'), started_at: LATER }] }) },
    }
    assert.throws(() => validateEpicTransition(failedPrevious, backdatedRetry), /start within the revision interval/)

    const backdatedSettlement = {
      ...running,
      state_revision: 2,
      items: { 'item-a': item({
        item_id: 'item-a', status: 'failed', attempts: [{ ...fabricated, completed_at: NOW }], completed_at: NOW,
      }) },
    }
    assert.throws(() => validateEpicTransition(running, backdatedSettlement), /complete within the revision interval/)
  })

  it('requires a sole running attempt to be final and chronologically ordered', () => {
    const failed = {
      attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null, started_at: NOW,
      completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null, result_summary: 'Failed.',
      failure_classification: 'semantic' as const, status: 'failed' as const,
    }
    const running = { ...failed, attempt_id: 'attempt-2', worktree_evidence: worktreeEvidence('item-a', 'attempt-2'), started_at: LATER, completed_at: null, result_summary: null, failure_classification: null, status: 'running' as const }
    assert.doesNotThrow(() => validateEpicState({ ...baseState(), status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [failed, running] }) } }))
    assert.throws(() => validateEpicState({ ...baseState(), status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [running, failed] }) } }), /final attempt/)
    assert.throws(() => validateEpicState({ ...baseState(), status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [failed, { ...running, started_at: NOW }] }) } }), /timestamps must be ordered/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...failed, started_at: '2026-07-18T12:06:00.000Z', completed_at: '2026-07-18T12:06:00.000Z' }] }) } }), /after state updated_at/)
  })

  it('rejects passed and integrated items without attempt evidence', () => {
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'passed', selected_attempt_id: 'missing', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER }) } }), /selected passed attempt/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'integrated', selected_attempt_id: 'missing', worktree_name: 'wt-a', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), integration_commit: OID('2'), completed_at: LATER }) } }), /selected passed attempt/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...reviewedAttempt(), checkpoint_commit: null }] }) } }), /passed attempt requires a checkpoint/)
  })

  it('enforces scoped usage interval accounting and conservative unknown cost evidence', () => {
    const runningAttempt = { attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null, failure_classification: null, status: 'running' as const }
    const active = { ...emptyAutomationUsageTelemetry(), active_interval_started_at: NOW, last_active_checkpoint_at: NOW }
    const previous = baseState({ status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [runningAttempt] }) }, usage: [{ scope: 'epic', item_id: null, usage: active }, { scope: 'item', item_id: 'item-a', usage: active }] })
    const cancelledAttempt = { ...runningAttempt, status: 'cancelled' as const, completed_at: LATER, result_summary: 'Cancelled.', failure_classification: 'cancelled' as const }
    const closedUsage = previous.usage.map(record => ({ ...record, usage: { ...record.usage, active_time_ms: 300_000, active_interval_started_at: null, last_active_checkpoint_at: null } }))
    const next = { ...previous, state_revision: 2, status: 'paused' as const, pause_reason: 'Paused after settling active work.', updated_at: LATER, items: { 'item-a': { ...previous.items['item-a']!, status: 'cancelled' as const, attempts: [cancelledAttempt], completed_at: LATER } }, usage: closedUsage }
    assert.doesNotThrow(() => validateEpicTransition(previous, next))
    assert.throws(() => validateEpicTransition(previous, { ...next, usage: next.usage.map(record => ({ ...record, usage: { ...record.usage, active_time_ms: 299_999 } })) }), /account for elapsed/)
    assert.throws(() => validateEpicTransition(baseState(), { ...baseState(), state_revision: 2, updated_at: LATER, usage: [{ scope: 'epic', item_id: null, usage: { ...emptyAutomationUsageTelemetry(), cost_evidence: { kind: 'known', cost_usd: 1 } } }] }), /separately validated evidence/)
  })

  it('requires exact budget change evidence and preserves embedded extension history', () => {
    const previous = baseState({ budgets: [budget({ limit: 2 })] })
    const update = policyRecord({ update_id: 'increase-update', previous_limit: 2, new_limit: 3, state_revision: 2, recorded_at: LATER })
    const extension = policyRecord({ update_id: 'increase-extension', previous_limit: 2, new_limit: 3, state_revision: 2, recorded_at: LATER }) as EpicBudgetExtension
    const next = { ...previous, state_revision: 2, updated_at: LATER, budgets: [budget({ limit: 3, extensions: [extension] })], budget_updates: [update] }
    assert.doesNotThrow(() => validateEpicTransition(previous, next))
    assert.throws(() => validateEpicTransition(previous, { ...next, budget_updates: [] }), /requires exactly one|lacks exactly one/)
    assert.throws(() => validateEpicTransition(previous, { ...next, budgets: [budget({ limit: 3 })] }), /invalid extension evidence|requires exactly one matching newly appended extension/)

    const historicalExtension = policyRecord({ update_id: 'old-extension', previous_limit: 1, new_limit: 2 }) as EpicBudgetExtension
    const historical = baseState({ budgets: [budget({ limit: 2, extensions: [historicalExtension] })], budget_updates: [policyRecord({ update_id: 'old-root', previous_limit: 1, new_limit: 2 })] })
    assert.throws(() => validateEpicTransition(historical, { ...historical, state_revision: 2, updated_at: LATER, budgets: [], budget_updates: [...historical.budget_updates, policyRecord({ update_id: 'remove-with-history', previous_limit: 2, new_limit: null, state_revision: 2, recorded_at: LATER })] }), /erase extension evidence/)
  })

  it('rejects duplicate attempt IDs, multiple running attempts, and timestamp inversions', () => {
    const running = { attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null, failure_classification: null, status: 'running' as const }
    assert.throws(() => validateEpicState({ ...baseState(), status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [running] }), 'item-b': item({ item_id: 'item-b', status: 'running', attempts: [running] }) } }), /duplicate attempt ID/)
    assert.throws(() => validateEpicState({ ...baseState(), status: 'running', items: { 'item-a': item({ item_id: 'item-a', status: 'running', attempts: [running, { ...running, attempt_id: 'attempt-2' }] }) } }), /at most one running/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'failed', completed_at: LATER, attempts: [{ ...running, completed_at: NOW, started_at: LATER, status: 'failed', result_summary: 'Failed', failure_classification: 'contract' }] }) } }), /must not precede/)
  })

  it('preserves deterministic declaration order and rejects missing, duplicate, and cyclic dependencies', () => {
    const items = {
      z: item({ item_id: 'z' }),
      a: item({ item_id: 'a' }),
      b: item({ item_id: 'b', dependencies: ['z', 'a'] }),
    }
    assert.deepEqual(deterministicEpicOrder(items), ['z', 'a', 'b'])
    assert.throws(() => validateEpicDag({ a: item({ item_id: 'a', dependencies: ['ghost'] }) }), /unknown item/)
    assert.throws(() => validateEpicDag({ a: item({ item_id: 'a' }), b: item({ item_id: 'b', dependencies: ['a', 'a'] }) }), /duplicate dependencies/)
    assert.throws(() => validateEpicDag({ a: item({ item_id: 'a', dependencies: ['b'] }), b: item({ item_id: 'b', dependencies: ['a'] }) }), /cycle/)
  })

  it('enforces pause, completion, Git ref, branch, relative conflict path, and frozen lower limits', () => {
    assert.throws(() => validateEpicState({ ...baseState(), status: 'paused', pause_reason: null }), /pause_reason/)
    assert.throws(() => validateEpicState({ ...baseState(), pause_reason: 'Not paused.' }), /pause_reason/)
    assert.throws(() => validateEpicState({ ...baseState(), base_branch: 'main' }), EpicValidationError)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', branch_name: '../escape' }) } }), EpicValidationError)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'conflicted', completed_at: LATER, conflict_paths: ['../outside'] }) } }), EpicValidationError)
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_epic_items: 1 } }), /frozen operational limit/)
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_item_dependencies: 1 }, items: { a: item({ item_id: 'a' }), b: item({ item_id: 'b' }), c: item({ item_id: 'c', dependencies: ['a', 'b'] }) } }), /dependency count exceeds/)
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_budget_records: 1 }, budgets: [budget(), budget({ dimension: 'input_tokens' })] }), /budget record count exceeds/)
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_budget_records: 1 }, budgets: [budget({ extensions: [policyRecord({ update_id: 'nested' }) as EpicBudgetExtension] })] }), /aggregate budget record count exceeds/)
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_budget_records: 1 }, budget_updates: [policyRecord()] , budgets: [budget()] }), /aggregate budget record count exceeds/)
    const completed_attempt = { attempt_id: 'attempt-1', worktree_evidence: worktreeEvidence(), agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: LATER, checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), result_summary: 'Done.', failure_classification: null, status: 'passed' as const }
    assert.throws(() => validateEpicState({ ...baseState(), operational_limits: { ...baseState().operational_limits, max_attempts_per_item: 1 }, items: { 'item-a': item({ item_id: 'item-a', status: 'passed', completed_at: LATER, attempts: [completed_attempt, { ...completed_attempt, attempt_id: 'attempt-2' }] }) } }), /attempt count exceeds/)
  })

  it('rejects incomplete item dispositions for completed epics and integration metadata on non-integrated items', () => {
    const failedAttempt = {
      attempt_id: 'attempt-failed', worktree_evidence: worktreeEvidence('item-a', 'attempt-failed'), agent: 'executor', model: null, child_session_id: null, started_at: NOW,
      completed_at: LATER, checkpoint_commit: null, review_evidence_digest: null, result_summary: 'Failed.',
      failure_classification: 'contract' as const, status: 'failed' as const,
    }
    const dispositions = [
      item({ item_id: 'item-a', status: 'pending' }),
      item({ item_id: 'item-a', status: 'failed', attempts: [failedAttempt], completed_at: LATER }),
      item({ item_id: 'item-a', status: 'passed', attempts: [reviewedAttempt()], selected_attempt_id: 'attempt-1', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER }),
    ]
    for (const disposition of dispositions) assert.throws(() => validateEpicState({ ...baseState(), status: 'completed', items: { 'item-a': disposition } }), /inappropriate item disposition/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', integration_commit: OID('2') }) } }), /non-integrated item/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'blocked', completed_at: '1999-01-01T00:00:00.000Z' }) } }), /within the epic chronology/)
    assert.throws(() => validateEpicState({ ...baseState(), items: { 'item-a': item({ item_id: 'item-a', status: 'blocked', completed_at: '2030-01-01T00:00:00.000Z' }) } }), /within the epic chronology/)
  })

  it('binds integration digest, dependency snapshot, review evidence, and checkpoint identity', () => {
    const integrated_item = item({
      item_id: 'item-a', status: 'integrated',
      attempts: [reviewedAttempt()], selected_attempt_id: 'attempt-1', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), integration_commit: OID('2'), completed_at: LATER,
    })
    const draft = baseState({ items: { 'item-a': integrated_item } })
    const event = {
      event_id: 'event-1', item_id: 'item-a', attempt_id: 'attempt-1', dependency_snapshot_sha256: computeDependencySnapshotDigest(draft, integrated_item),
      source_commit: OID('1'), target_commit: OID('2'), review_evidence_digest: SHA('b'), result: 'success' as const,
      previous_event_digest: null, event_digest: '', recorded_at: LATER,
    }
    event.event_digest = computeIntegrationEventDigest(event)
    const valid = validateEpicState({ ...draft, status: 'completed', updated_at: LATER, integration_log: [event] })
    assert.equal(valid.integration_log[0]!.event_digest, event.event_digest)
    assert.throws(() => validateEpicState({ ...valid, integration_log: [{ ...event, review_evidence_digest: SHA('c'), event_digest: computeIntegrationEventDigest({ ...event, review_evidence_digest: SHA('c') }) }] }), /review evidence|historical passed attempt/)
  })

  it('keeps identity and canonical JSON digests deterministic', () => {
    const identity = { epic_id: 'epic-1', root_session_id: 'session-1', project_identity_sha256: SHA('a'), base_branch: 'refs/heads/base', integration_branch: 'refs/heads/epic-integration', created_at: NOW }
    assert.equal(computeEpicIdentityDigest(identity), computeEpicIdentityDigest({ ...identity }))
    assert.equal(stableCanonicalJson({ b: 1, a: 2 }), stableCanonicalJson({ a: 2, b: 1 }))
  })

  it('validates real previous-to-next transition invariants and the atomic integration helper', () => {
    const previous = baseState()
    const next = { ...previous, state_revision: 2, status: 'running' as const, updated_at: LATER }
    assert.equal(validateEpicTransition(previous, next).state_revision, 2)
    assert.throws(() => validateEpicTransition(previous, { ...next, epic_id: 'other' }), /identity is immutable/)
    assert.throws(() => validateEpicTransition(previous, { ...next, items: { ...next.items, 'item-a': { ...next.items['item-a']!, scope: 'changed' } } }), /DAG identity/)

    const passedItem = item({ item_id: 'item-a', status: 'passed', attempts: [reviewedAttempt()], selected_attempt_id: 'attempt-1', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER })
    const passed = baseState({ state_revision: 2, status: 'running', updated_at: LATER, items: { 'item-a': passedItem } })
    const integrated = transitionEpicItemToIntegrated(passed, 'item-a', {
      event_id: 'event-1', dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem), source_commit: OID('1'), target_commit: OID('2'),
      review_evidence_digest: SHA('b'), recorded_at: LATER,
    })
    assert.equal(integrated.items['item-a']!.integration_commit, OID('2'))
    assert.equal(integrated.integration_log[0]!.source_commit, OID('1'))
    assert.throws(() => validateEpicTransition(passed, { ...integrated, items: { ...integrated.items, 'item-a': { ...integrated.items['item-a']!, completed_at: NOW } } }), /reviewed fields|precedes attempt completion/)
    assert.throws(() => validateEpicTransition(passed, { ...integrated, items: { ...integrated.items, 'item-a': { ...integrated.items['item-a']!, worktree_name: 'different-worktree' } } }), /worktree_name is immutable|reviewed fields|selected passed attempt/)
    assert.throws(() => validateEpicTransition(passed, { ...integrated, integration_log: [] }), /successful integration event|exactly one newly appended integration event/)

    const conflicted = transitionEpicItemToConflicted(passed, 'item-a', ['src/conflict.ts'], {
      event_id: 'event-failure', dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem), source_commit: OID('1'), target_commit: OID('3'),
      review_evidence_digest: SHA('b'), recorded_at: LATER,
    })
    assert.equal(conflicted.items['item-a']!.status, 'conflicted')
    assert.equal(conflicted.items['item-a']!.integration_commit, null)
    assert.equal(conflicted.integration_log[0]!.result, 'failure')
    assert.throws(() => transitionEpicItemToIntegrated(passed, 'item-a', {
      event_id: 'event-too-early', dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem),
      source_commit: OID('1'), target_commit: OID('2'), review_evidence_digest: SHA('b'), recorded_at: NOW,
    }), /audit chronology/)
  })

  it('requires integrated dependencies before either integration outcome', () => {
    const dependent = item({
      item_id: 'item-b', dependencies: ['item-a'], status: 'passed', attempts: [reviewedAttempt('attempt-1', 'item-b')],
      selected_attempt_id: 'attempt-1',
      checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER,
    })
    const state = baseState({ status: 'running', items: { 'item-a': item({ item_id: 'item-a' }), 'item-b': dependent } })
    const event = {
      event_id: 'event-blocked', dependency_snapshot_sha256: computeDependencySnapshotDigest(state, dependent),
      source_commit: OID('1'), target_commit: OID('2'), review_evidence_digest: SHA('b'), recorded_at: LATER,
    }
    assert.throws(() => transitionEpicItemToIntegrated(state, 'item-b', event), /before dependency item-a is integrated/)
    assert.throws(() => transitionEpicItemToConflicted(state, 'item-b', ['src/conflict.ts'], event), /before dependency item-a is integrated/)

    const directEvent = {
      ...event,
      item_id: 'item-b',
      attempt_id: 'attempt-1',
      result: 'failure' as const,
      previous_event_digest: null,
      event_digest: '',
    }
    directEvent.event_digest = computeIntegrationEventDigest(directEvent)
    assert.throws(() => validateEpicTransition(state, {
      ...state,
      state_revision: state.state_revision + 1,
      items: { ...state.items, 'item-b': { ...dependent, status: 'conflicted', conflict_paths: ['src/conflict.ts'] } },
      integration_log: [directEvent],
    }), /requires integrated dependency item-a/)
  })

  it('permits only one causally ordered integration outcome per revision', () => {
    const first = item({
      item_id: 'item-a', status: 'passed', attempts: [reviewedAttempt('attempt-1')], selected_attempt_id: 'attempt-1',
      checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER,
    })
    const secondAttempt = { ...reviewedAttempt('attempt-2', 'item-b'), checkpoint_commit: OID('3'), review_evidence_digest: SHA('c') }
    const second = item({
      item_id: 'item-b', status: 'passed', attempts: [secondAttempt], selected_attempt_id: 'attempt-2',
      checkpoint_commit: OID('3'), review_evidence_digest: SHA('c'), completed_at: LATER,
    })
    const previous = baseState({ status: 'running', items: { 'item-a': first, 'item-b': second } })
    const firstEvent = {
      event_id: 'event-a', item_id: 'item-a', attempt_id: 'attempt-1', dependency_snapshot_sha256: computeDependencySnapshotDigest(previous, first),
      source_commit: OID('1'), target_commit: OID('2'), review_evidence_digest: SHA('b'), result: 'success' as const,
      previous_event_digest: null, event_digest: '', recorded_at: LATER,
    }
    firstEvent.event_digest = computeIntegrationEventDigest(firstEvent)
    const secondEvent = {
      event_id: 'event-b', item_id: 'item-b', attempt_id: 'attempt-2', dependency_snapshot_sha256: computeDependencySnapshotDigest(previous, second),
      source_commit: OID('3'), target_commit: OID('4'), review_evidence_digest: SHA('c'), result: 'success' as const,
      previous_event_digest: firstEvent.event_digest, event_digest: '', recorded_at: LATER,
    }
    secondEvent.event_digest = computeIntegrationEventDigest(secondEvent)
    assert.throws(() => validateEpicTransition(previous, {
      ...previous,
      state_revision: previous.state_revision + 1,
      items: {
        'item-a': { ...first, status: 'integrated', integration_commit: OID('2') },
        'item-b': { ...second, status: 'integrated', integration_commit: OID('4') },
      },
      integration_log: [firstEvent, secondEvent],
    }), /at most one integration outcome/)
  })

  it('preserves a failed integration event through retry and successful integration', () => {
    const firstItem = item({
      item_id: 'item-a', status: 'passed', attempts: [reviewedAttempt('attempt-1')], selected_attempt_id: 'attempt-1',
      checkpoint_commit: OID('1'),
      review_evidence_digest: SHA('b'), completed_at: LATER,
    })
    const passed = baseState({ status: 'running', items: { 'item-a': firstItem } })
    const conflicted = transitionEpicItemToConflicted(passed, 'item-a', ['src/conflict.ts'], {
      event_id: 'event-failure', dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, firstItem),
      source_commit: OID('1'), target_commit: OID('3'), review_evidence_digest: SHA('b'), recorded_at: LATER,
    })
    const runningAttempt = {
      attempt_id: 'attempt-2', worktree_evidence: worktreeEvidence('item-a', 'attempt-2'), agent: 'executor', model: null, child_session_id: null, started_at: LATER,
      completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null,
      failure_classification: null, status: 'running' as const,
    }
    const running = validateEpicTransition(conflicted, {
      ...conflicted,
      state_revision: conflicted.state_revision + 1,
      items: { 'item-a': {
        ...conflicted.items['item-a']!, status: 'running', attempts: [...conflicted.items['item-a']!.attempts, runningAttempt],
        selected_attempt_id: null, worktree_name: runningAttempt.worktree_evidence.worktree_name, branch_name: runningAttempt.worktree_evidence.branch_name, checkpoint_commit: null,
        review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null,
      } },
    })
    const secondAttempt = {
      ...runningAttempt, status: 'passed' as const, completed_at: LATER, checkpoint_commit: OID('4'),
      review_evidence_digest: SHA('c'), result_summary: 'Passed retry review.',
    }
    const retried = validateEpicTransition(running, {
      ...running,
      state_revision: running.state_revision + 1,
      items: { 'item-a': {
        ...running.items['item-a']!, status: 'passed', attempts: [reviewedAttempt('attempt-1'), secondAttempt],
        selected_attempt_id: 'attempt-2', checkpoint_commit: OID('4'), review_evidence_digest: SHA('c'), completed_at: LATER,
      } },
    })
    const integrated = transitionEpicItemToIntegrated(retried, 'item-a', {
      event_id: 'event-success', dependency_snapshot_sha256: computeDependencySnapshotDigest(retried, retried.items['item-a']!),
      source_commit: OID('4'), target_commit: OID('5'), review_evidence_digest: SHA('c'), recorded_at: LATER,
    })
    assert.deepEqual(integrated.integration_log.map(event => [event.attempt_id, event.result]), [
      ['attempt-1', 'failure'],
      ['attempt-2', 'success'],
    ])
    const forgedEvent = {
      ...integrated.integration_log[1]!,
      attempt_id: 'attempt-1',
      source_commit: OID('1'),
      review_evidence_digest: SHA('b'),
      event_digest: '',
    }
    forgedEvent.event_digest = computeIntegrationEventDigest(forgedEvent)
    assert.throws(() => validateEpicTransition(retried, {
      ...integrated,
      integration_log: [integrated.integration_log[0]!, forgedEvent],
    }), /previously selected reviewed attempt/)
  })

  it('requeues conflicted work by clearing current selection while retaining failure history', () => {
    const passedItem = item({ item_id: 'item-a', status: 'passed', attempts: [reviewedAttempt()], selected_attempt_id: 'attempt-1', checkpoint_commit: OID('1'), review_evidence_digest: SHA('b'), completed_at: LATER })
    const passed = baseState({ status: 'running', items: { 'item-a': passedItem } })
    const conflicted = transitionEpicItemToConflicted(passed, 'item-a', ['src/conflict.ts'], {
      event_id: 'event-failure', dependency_snapshot_sha256: computeDependencySnapshotDigest(passed, passedItem), source_commit: OID('1'), target_commit: OID('3'),
      review_evidence_digest: SHA('b'), recorded_at: LATER,
    })
    const conflictedItem = conflicted.items['item-a']!
    const requeued = {
      ...conflicted,
      state_revision: conflicted.state_revision + 1,
      items: {
        'item-a': {
          ...conflictedItem,
          status: 'queued' as const,
          selected_attempt_id: null,
          worktree_name: null,
          branch_name: null,
          checkpoint_commit: null,
          review_evidence_digest: null,
          conflict_paths: [],
          completed_at: null,
        },
      },
    }
    const validated = validateEpicTransition(conflicted, requeued)
    assert.deepEqual(validated.items['item-a']!.attempts, conflictedItem.attempts)
    assert.deepEqual(validated.integration_log, conflicted.integration_log)
    assert.equal(validated.items['item-a']!.selected_attempt_id, null)
  })
})

describe('owner-bound epic persistence', () => {
  it('keeps disabled writes as no-ops and round-trips enabled version 2 state and usage', () => {
    withConfigDir()
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-project-'))
    temporary_directories.push(project)
    const disabled = openEpicStore({ root_session_id: 'session-1', project_root: project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1', mode: 'disabled', config: { enabled: false } })
    assert.equal(disabled.append({ invalid: true }, -1, 'invalid', -1), null)
    assert.equal(fs.existsSync(path.join(process.env.OPENCODE_CONFIG_DIR!, 'workflows')), false)

    const config = { ...enabledEpicConfig(), max_epic_items: 8, max_budget_records: 16 }
    const state = baseState({ project_identity_sha256: projectIdentitySha256(fs.realpathSync(project)) })
    const store = openEpicStore({ root_session_id: 'session-1', project_root: project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1', mode: 'read_write', config })
    const written = store.append(state, 0, null, 1)!
    assert.deepEqual(store.load()?.state.usage, state.usage)
    assert.equal(written.revision, 1)
    assert.throws(
      () => store.append({ ...state, state_revision: 2, operational_limits: { ...state.operational_limits, max_epic_items: 7 } }, 1, written.state_sha256, 1),
      /transition is invalid/,
    )
  })

  it('returns a status-only view without sensitive attempt or commit details', () => {
    const status = epicStatusOnly(baseState(), SHA('d'), SHA('e'))
    assert.equal(status.item_count, 2)
    assert.ok(!('attempts' in status) && !('checkpoint_commit' in status))
  })
})
