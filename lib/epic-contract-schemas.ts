import path from 'node:path'

import { z } from 'zod'

import {
  AutomationUsageTelemetrySchema,
  CostReportingCapabilitySchema,
  FailureClassSchema,
  finiteNonNegativeCost,
  safeNonNegativeInteger,
  type FailureClass,
} from './automation-policy-contracts.ts'
import { EpicReviewIssueSchema, MAX_EPIC_REVIEW_ISSUES, type EpicReviewIssue } from './epic-attempt-result.ts'
import {
  EpicOperationalLimitsSchema,
  EpicRetryPolicySchema,
  MAX_ATTEMPTS_PER_ITEM,
  MAX_EPIC_ACTIVE_TIME_CHECKPOINT_MS,
  MAX_EPIC_ATTEMPT_DURATION_MS,
  MAX_EPIC_BUDGET_RECORDS,
  MAX_EPIC_ITEMS,
  MAX_EPIC_MODEL_CANDIDATES,
  MAX_EPIC_PARALLEL_SESSIONS,
  MAX_EPIC_PROVIDER_POLICIES,
  MAX_EPIC_RESULT_BYTES,
  MIN_EPIC_RESULT_BYTES,
  MAX_ITEM_DEPENDENCIES,
  type EpicOperationalLimits,
} from './epic-policy.ts'
import { EpicWorktreeEvidenceSchema, type EpicWorktreeEvidence } from './epic-worktree-contracts.ts'
import { extractProvider, validateModelCandidate, type ModelCandidate } from './model-registry.ts'
import { isFullPublicationGitRef } from './publication-policy.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

export const EPIC_SCHEMA_VERSION = 2
export const EPIC_STATE_SCHEMA_ID = 'https://opencode-workflows.example/schema/epic-state.schema.json'

const MAX_TEXT_LENGTH = 4096
const MAX_TIMESTAMP_LENGTH = 64
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const BoundedTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH).refine(value => !value.includes('\0'))
const Sha256Schema = z.string().regex(SHA256_PATTERN)
const GitOidSchema = z.string().regex(GIT_OID_PATTERN)
const DateTimeSchema = z.string().max(MAX_TIMESTAMP_LENGTH).check(z.iso.datetime({ offset: true }))
const FullBranchRefSchema = z.string().min(1).max(MAX_TEXT_LENGTH).refine(
  value => value.startsWith('refs/heads/') && isFullPublicationGitRef(value),
  { message: 'must be a safe full Git branch ref beginning with refs/heads/' },
)
const GitBranchNameSchema = z.string().min(1).max(MAX_TEXT_LENGTH).refine((value) => {
  if (value.startsWith('refs/heads/')) return isFullPublicationGitRef(value)
  return !value.startsWith('refs/') && isFullPublicationGitRef(`refs/heads/${value}`)
}, { message: 'must be a safe Git branch name or full branch ref' })
const RelativeConflictPathSchema = z.string().min(1).max(MAX_TEXT_LENGTH).refine((value) => {
  if (value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  const segments = value.replaceAll('\\', '/').split('/')
  return !segments.includes('..') && segments.some(segment => segment !== '' && segment !== '.')
}, { message: 'must be a safe worktree-relative path' })
const ModelIdentifierSchema = z.string().max(MAX_TEXT_LENGTH).refine((model) => {
  try {
    validateModelCandidate(model)
    return true
  } catch {
    return false
  }
}, { message: 'must be a valid configured model identifier' })

const ModelCandidateContractSchema = z.object({
  model: ModelIdentifierSchema,
  variant: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
}).strict().superRefine((candidate, context) => {
  try {
    validateModelCandidate(candidate)
  } catch {
    context.addIssue({ code: 'custom', path: [], message: 'must be a valid configured model candidate' })
  }
})

const ModelCandidateListSchema = z.array(ModelCandidateContractSchema)
  .min(1)
  .max(MAX_EPIC_MODEL_CANDIDATES)
  .superRefine((candidates, context) => {
    const identities = new Set<string>()
    candidates.forEach((candidate, index) => {
      const identity = `${candidate.model}\0${candidate.variant ?? ''}`
      if (identities.has(identity)) context.addIssue({ code: 'custom', path: [index], message: 'model candidates must be unique' })
      identities.add(identity)
    })
  })

export const EpicCoordinationPolicySchema = z.object({
  policy_version: z.literal(1),
  executor_agent: SafeIdentifierSchema,
  executor_candidates: ModelCandidateListSchema,
  reviewer_agent: SafeIdentifierSchema,
  reviewer_candidates: ModelCandidateListSchema,
  max_parallel_sessions: safeNonNegativeInteger.positive().max(MAX_EPIC_PARALLEL_SESSIONS),
  provider_concurrency: z.record(
    SafeIdentifierSchema,
    safeNonNegativeInteger.positive().max(MAX_EPIC_PARALLEL_SESSIONS),
  ),
  retry_policy: EpicRetryPolicySchema,
  max_attempt_duration_ms: safeNonNegativeInteger.positive().max(MAX_EPIC_ATTEMPT_DURATION_MS),
  active_time_checkpoint_ms: safeNonNegativeInteger.positive().max(MAX_EPIC_ACTIVE_TIME_CHECKPOINT_MS),
  max_result_bytes: safeNonNegativeInteger.min(MIN_EPIC_RESULT_BYTES).max(MAX_EPIC_RESULT_BYTES),
  provider_cost_reporting: z.record(SafeIdentifierSchema, CostReportingCapabilitySchema),
}).strict().superRefine((policy, context) => {
  if (policy.active_time_checkpoint_ms > policy.max_attempt_duration_ms) {
    context.addIssue({ code: 'custom', path: ['active_time_checkpoint_ms'], message: 'active checkpoint interval must not exceed attempt duration' })
  }
  const providers = new Set([...policy.executor_candidates, ...policy.reviewer_candidates]
    .map(candidate => extractProvider(candidate.model))
    .filter((provider): provider is string => provider !== null))
  const concurrency_providers = Object.keys(policy.provider_concurrency)
  const reporting_providers = Object.keys(policy.provider_cost_reporting)
  if (concurrency_providers.length > MAX_EPIC_PROVIDER_POLICIES) {
    context.addIssue({ code: 'custom', path: ['provider_concurrency'], message: 'too many provider concurrency policies' })
  }
  if (reporting_providers.length > MAX_EPIC_PROVIDER_POLICIES) {
    context.addIssue({ code: 'custom', path: ['provider_cost_reporting'], message: 'too many provider cost-reporting policies' })
  }
  for (const provider of providers) {
    if (!Object.hasOwn(policy.provider_concurrency, provider)) {
      context.addIssue({ code: 'custom', path: ['provider_concurrency', provider], message: 'every selected provider requires an explicit concurrency limit' })
    }
    if (!Object.hasOwn(policy.provider_cost_reporting, provider)) {
      context.addIssue({ code: 'custom', path: ['provider_cost_reporting', provider], message: 'every selected provider requires an explicit cost-reporting status' })
    }
  }
  for (const [provider, limit] of Object.entries(policy.provider_concurrency)) {
    if (!providers.has(provider)) context.addIssue({ code: 'custom', path: ['provider_concurrency', provider], message: 'provider is not present in the resolved candidates' })
    if (limit > policy.max_parallel_sessions) context.addIssue({ code: 'custom', path: ['provider_concurrency', provider], message: 'provider concurrency must not exceed global concurrency' })
  }
  for (const provider of reporting_providers) {
    if (!providers.has(provider)) context.addIssue({ code: 'custom', path: ['provider_cost_reporting', provider], message: 'provider is not present in the resolved candidates' })
  }
})

export const EPIC_BUDGET_DIMENSIONS = ['sessions', 'input_tokens', 'output_tokens', 'cost_usd', 'active_time_ms', 'calendar_age_ms'] as const
export const EpicBudgetDimensionSchema = z.enum(EPIC_BUDGET_DIMENSIONS)
export const EpicBudgetScopeSchema = z.enum(['item', 'epic', 'global'])
export type EpicBudgetDimension = z.infer<typeof EpicBudgetDimensionSchema>
export type EpicBudgetScope = z.infer<typeof EpicBudgetScopeSchema>

export function isValidDimensionLimit(dimension: EpicBudgetDimension, value: number | null): boolean {
  if (value === null) return true
  return dimension === 'cost_usd'
    ? finiteNonNegativeCost.safeParse(value).success
    : safeNonNegativeInteger.safeParse(value).success
}

const PolicyRecordFields = {
  update_id: SafeIdentifierSchema,
  actor_session_id: SafeIdentifierSchema,
  project_identity: Sha256Schema,
  dimension: EpicBudgetDimensionSchema,
  scope: EpicBudgetScopeSchema,
  item_id: SafeIdentifierSchema.nullable(),
  previous_limit: z.number().nullable(),
  new_limit: z.number().nullable(),
  reason: BoundedTextSchema,
  recorded_at: DateTimeSchema,
  state_revision: safeNonNegativeInteger.positive(),
  fencing_generation: z.null(),
}

function validatePolicyRecord(record: z.infer<z.ZodObject<typeof PolicyRecordFields>>, context: z.core.$RefinementCtx): void {
  for (const field of ['previous_limit', 'new_limit'] as const) {
    if (!isValidDimensionLimit(record.dimension, record[field])) context.addIssue({ code: 'custom', path: [field], message: `${field} is invalid for ${record.dimension}` })
  }
  if (record.previous_limit === record.new_limit) context.addIssue({ code: 'custom', path: ['new_limit'], message: 'previous_limit and new_limit must differ' })
}

export const EpicBudgetUpdateSchema = z.object(PolicyRecordFields).strict().superRefine(validatePolicyRecord)
export const EpicBudgetExtensionSchema = z.object(PolicyRecordFields).strict().superRefine((record, context) => {
  validatePolicyRecord(record, context)
  if (record.previous_limit === null || record.new_limit === null || record.new_limit <= record.previous_limit) {
    context.addIssue({ code: 'custom', path: ['new_limit'], message: 'extension requires a non-null strict increase' })
  }
})
export const EpicBudgetRecordSchema = z.object({
  dimension: EpicBudgetDimensionSchema,
  scope: EpicBudgetScopeSchema,
  item_id: SafeIdentifierSchema.nullable(),
  limit: z.number().nullable(),
  extensions: z.array(EpicBudgetExtensionSchema).max(MAX_EPIC_BUDGET_RECORDS),
}).strict().superRefine((record, context) => {
  if (!isValidDimensionLimit(record.dimension, record.limit)) context.addIssue({ code: 'custom', path: ['limit'], message: `limit is invalid for ${record.dimension}` })
})
export const EpicScopedUsageSchema = z.object({
  scope: EpicBudgetScopeSchema,
  item_id: SafeIdentifierSchema.nullable(),
  usage: AutomationUsageTelemetrySchema,
}).strict()

export type EpicBudgetUpdate = z.infer<typeof EpicBudgetUpdateSchema>
export type EpicBudgetExtension = z.infer<typeof EpicBudgetExtensionSchema>
export type EpicBudgetRecord = z.infer<typeof EpicBudgetRecordSchema>
export type EpicScopedUsage = z.infer<typeof EpicScopedUsageSchema>
export type EpicStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type EpicItemStatus = 'pending' | 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'conflicted' | 'integrated' | 'cancelled'
export type EpicAttemptStatus = 'running' | 'checkpointed' | 'reviewing' | 'passed' | 'failed' | 'cancelled'
export type EpicLaunchState = 'reserved' | 'created' | 'prompted' | 'settled' | 'ambiguous'
export type EpicCoordinationPolicy = z.infer<typeof EpicCoordinationPolicySchema>

export interface EpicReviewRecord {
  review_id: string
  agent: string
  model: string
  child_session_id: string | null
  launch_state: EpicLaunchState
  checkpoint_commit: string
  checkpoint_tree_sha256: string
  started_at: string
  completed_at: string | null
  verdict: 'passed' | 'failed' | null
  evidence_digest: string | null
  result_summary: string | null
  issues?: EpicReviewIssue[]
}

export interface EpicIdentity {
  epic_id: string
  root_session_id: string
  project_identity_sha256: string
  base_branch: string
  integration_branch: string
  created_at: string
}

export interface EpicAttempt {
  attempt_id: string
  worktree_evidence: EpicWorktreeEvidence
  agent: string
  model: string | null
  child_session_id: string | null
  started_at: string
  completed_at: string | null
  checkpoint_commit: string | null
  review_evidence_digest: string | null
  result_summary: string | null
  failure_classification: FailureClass | null
  status: EpicAttemptStatus
  launch_id?: string
  launch_state?: EpicLaunchState
  progress_commit?: string | null
  progress_tree_sha256?: string | null
  checkpoint_tree_sha256?: string | null
  review?: EpicReviewRecord | null
}

export interface EpicItem {
  item_id: string
  dependencies: string[]
  scope: string
  status: EpicItemStatus
  attempts: EpicAttempt[]
  selected_attempt_id: string | null
  worktree_name: string | null
  branch_name: string | null
  checkpoint_commit: string | null
  review_evidence_digest: string | null
  conflict_paths: string[]
  integration_commit: string | null
  completed_at: string | null
  retry_not_before?: string | null
}

export interface EpicIntegrationIntent {
  intent_id: string
  operation: 'integrate'
  item_id: string
  attempt_id: string
  prior_state_revision: number
  prior_state_sha256: string
  prior_generation: number
  expected_source_commit: string
  expected_target_commit: string
  dependency_snapshot_sha256: string
  review_evidence_digest: string
}

export interface EpicIntegrationEvent {
  event_id: string
  item_id: string
  attempt_id: string
  dependency_snapshot_sha256: string
  source_commit: string
  previous_target_commit?: string
  target_commit: string
  review_evidence_digest: string
  result: 'success' | 'failure'
  previous_event_digest: string | null
  event_digest: string
  recorded_at: string
}

export interface EpicState {
  schema_version: typeof EPIC_SCHEMA_VERSION
  state_revision: number
  operational_limits: EpicOperationalLimits
  epic_id: string
  root_session_id: string
  project_identity_sha256: string
  base_branch: string
  integration_branch: string
  status: EpicStatus
  pause_reason: string | null
  pause_code?: string | null
  created_at: string
  updated_at: string
  items: Record<string, EpicItem>
  integration_log: EpicIntegrationEvent[]
  budgets?: EpicBudgetRecord[]
  usage: EpicScopedUsage[]
  budget_updates: EpicBudgetUpdate[]
  coordination_policy?: EpicCoordinationPolicy
  integration_intent?: EpicIntegrationIntent | null
}

export class EpicValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EpicValidationError'
  }
}

export class EpicSchemaVersionError extends EpicValidationError {
  readonly receivedVersion: unknown
  constructor(receivedVersion: unknown) {
    super(`unsupported epic schema version: ${String(receivedVersion)}; expected ${EPIC_SCHEMA_VERSION}`)
    this.name = 'EpicSchemaVersionError'
    this.receivedVersion = receivedVersion
  }
}

export const EpicReviewRecordSchema = z.object({
  review_id: SafeIdentifierSchema,
  agent: SafeIdentifierSchema,
  model: ModelIdentifierSchema,
  child_session_id: SafeIdentifierSchema.nullable(),
  launch_state: z.enum(['reserved', 'created', 'prompted', 'settled', 'ambiguous']),
  checkpoint_commit: GitOidSchema,
  checkpoint_tree_sha256: Sha256Schema,
  started_at: DateTimeSchema,
  completed_at: DateTimeSchema.nullable(),
  verdict: z.enum(['passed', 'failed']).nullable(),
  evidence_digest: Sha256Schema.nullable(),
  result_summary: BoundedTextSchema.nullable(),
  issues: z.array(EpicReviewIssueSchema).max(MAX_EPIC_REVIEW_ISSUES).optional(),
}).strict().superRefine((review, context) => {
  const is_complete = review.completed_at !== null
  for (const field of ['verdict', 'evidence_digest', 'result_summary'] as const) {
    if (is_complete !== (review[field] !== null)) {
      context.addIssue({ code: 'custom', path: [field], message: `review ${field} must be present exactly when the review is complete` })
    }
  }
  if (review.completed_at !== null && Date.parse(review.completed_at) < Date.parse(review.started_at)) {
    context.addIssue({ code: 'custom', path: ['completed_at'], message: 'review completion must not precede review start' })
  }
  if (review.launch_state === 'reserved' && review.child_session_id !== null) {
    context.addIssue({ code: 'custom', path: ['child_session_id'], message: 'reserved review launch must not have a child session ID' })
  }
  if (['created', 'prompted'].includes(review.launch_state) && review.child_session_id === null) {
    context.addIssue({ code: 'custom', path: ['child_session_id'], message: 'created or prompted review launch requires a child session ID' })
  }
  if (is_complete && (review.launch_state !== 'settled' || review.child_session_id === null)) {
    context.addIssue({ code: 'custom', path: ['launch_state'], message: 'completed review requires a settled launch with its exact child session ID' })
  }
  if (review.launch_state === 'ambiguous' && is_complete) {
    context.addIssue({ code: 'custom', path: ['launch_state'], message: 'ambiguous review launch cannot claim a completed review result' })
  }
  if (!is_complete && review.issues !== undefined) context.addIssue({ code: 'custom', path: ['issues'], message: 'review issues may be recorded only when the review is complete' })
  if (is_complete && review.issues !== undefined) {
    if (review.verdict === 'passed' && review.issues.length !== 0) context.addIssue({ code: 'custom', path: ['issues'], message: 'passed review must record zero issues' })
    if (review.verdict === 'failed' && review.issues.length === 0) context.addIssue({ code: 'custom', path: ['issues'], message: 'failed review must record at least one issue' })
  }
})

export const EpicAttemptSchema = z.object({
  attempt_id: SafeIdentifierSchema,
  worktree_evidence: EpicWorktreeEvidenceSchema,
  agent: SafeIdentifierSchema,
  model: ModelIdentifierSchema.nullable(),
  child_session_id: SafeIdentifierSchema.nullable(),
  started_at: DateTimeSchema,
  completed_at: DateTimeSchema.nullable(),
  checkpoint_commit: GitOidSchema.nullable(),
  review_evidence_digest: Sha256Schema.nullable(),
  result_summary: BoundedTextSchema.nullable(),
  failure_classification: FailureClassSchema.nullable(),
  status: z.enum(['running', 'checkpointed', 'reviewing', 'passed', 'failed', 'cancelled']),
  launch_id: SafeIdentifierSchema.optional(),
  launch_state: z.enum(['reserved', 'created', 'prompted', 'settled', 'ambiguous']).optional(),
  progress_commit: GitOidSchema.nullable().optional(),
  progress_tree_sha256: Sha256Schema.nullable().optional(),
  checkpoint_tree_sha256: Sha256Schema.nullable().optional(),
  review: EpicReviewRecordSchema.nullable().optional(),
}).strict().superRefine((attempt, context) => {
  const is_active = ['running', 'checkpointed', 'reviewing'].includes(attempt.status)
  if (is_active !== (attempt.completed_at === null)) context.addIssue({ code: 'custom', path: ['completed_at'], message: is_active ? 'active attempt must not have completed_at' : 'terminal attempt must have completed_at' })
  if (attempt.completed_at !== null && Date.parse(attempt.completed_at) < Date.parse(attempt.started_at)) context.addIssue({ code: 'custom', path: ['completed_at'], message: 'attempt completed_at must not precede started_at' })
  if (is_active && attempt.result_summary !== null) context.addIssue({ code: 'custom', path: ['result_summary'], message: 'active attempt must not have a result summary' })
  if (attempt.status === 'passed' && attempt.checkpoint_commit === null) context.addIssue({ code: 'custom', path: ['checkpoint_commit'], message: 'passed attempt requires a checkpoint commit' })
  if (attempt.status === 'passed' && attempt.review_evidence_digest === null) context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'passed attempt requires review evidence' })
  const has_coordination_fields = attempt.launch_id !== undefined
    || attempt.launch_state !== undefined
    || attempt.progress_commit !== undefined
    || attempt.progress_tree_sha256 !== undefined
    || attempt.checkpoint_tree_sha256 !== undefined
    || attempt.review !== undefined
  const coordination_fields = ['launch_id', 'launch_state', 'progress_commit', 'progress_tree_sha256', 'checkpoint_tree_sha256', 'review'] as const
  if (has_coordination_fields) {
    for (const field of coordination_fields) {
      if (attempt[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: 'coordinated attempts require every durable coordination field' })
    }
    if ((attempt.progress_commit === null) !== (attempt.progress_tree_sha256 === null)) {
      context.addIssue({ code: 'custom', path: ['progress_tree_sha256'], message: 'progress commit and tree digest must be recorded together' })
    }
    if (attempt.launch_state === 'reserved' && attempt.child_session_id !== null) context.addIssue({ code: 'custom', path: ['child_session_id'], message: 'reserved launch must not have a child session ID' })
    if (attempt.launch_state !== 'reserved' && attempt.launch_state !== 'ambiguous' && attempt.child_session_id === null
      && !(attempt.launch_state === 'settled'
        && ((attempt.status === 'cancelled' && attempt.failure_classification === 'cancelled')
          || (attempt.status === 'failed' && attempt.failure_classification === 'transport')))) context.addIssue({ code: 'custom', path: ['child_session_id'], message: 'created launch requires a child session ID unless a pre-dispatch launch was definitively rejected' })
    if (attempt.launch_state === 'ambiguous') {
      if (attempt.status !== 'failed' || attempt.failure_classification !== 'ambiguous_launch') context.addIssue({ code: 'custom', path: ['launch_state'], message: 'ambiguous launch must be a failed ambiguous_launch attempt' })
    } else if (is_active && attempt.launch_state === 'settled') {
      context.addIssue({ code: 'custom', path: ['launch_state'], message: 'active attempt launch must not be settled' })
    } else if (!is_active && attempt.launch_state !== 'settled') {
      context.addIssue({ code: 'custom', path: ['launch_state'], message: 'terminal coordinated attempt launch must be settled or ambiguous' })
    }
    if (attempt.status === 'running' && (attempt.checkpoint_commit !== null || attempt.checkpoint_tree_sha256 !== null || attempt.review !== null)) {
      context.addIssue({ code: 'custom', path: ['checkpoint_commit'], message: 'running execution must not fabricate checkpoint or review evidence' })
    }
    if (attempt.status === 'checkpointed' && (attempt.checkpoint_commit === null || attempt.checkpoint_tree_sha256 === null || attempt.review !== null)) {
      context.addIssue({ code: 'custom', path: ['checkpoint_commit'], message: 'checkpointed attempt requires an exact checkpoint and no review record' })
    }
    if (attempt.status === 'reviewing' && (attempt.checkpoint_commit === null || attempt.checkpoint_tree_sha256 === null || attempt.review === null)) {
      context.addIssue({ code: 'custom', path: ['review'], message: 'reviewing attempt requires checkpoint-bound review evidence' })
    }
    if (attempt.review !== null && attempt.review !== undefined) {
      if (attempt.review.checkpoint_commit !== attempt.checkpoint_commit || attempt.review.checkpoint_tree_sha256 !== attempt.checkpoint_tree_sha256) {
        context.addIssue({ code: 'custom', path: ['review'], message: 'review record must bind the exact attempt checkpoint and tree digest' })
      }
      if (Date.parse(attempt.review.started_at) < Date.parse(attempt.started_at)) context.addIssue({ code: 'custom', path: ['review', 'started_at'], message: 'review cannot start before the attempt' })
      if (attempt.review.completed_at !== null && attempt.completed_at !== null && Date.parse(attempt.review.completed_at) > Date.parse(attempt.completed_at)) context.addIssue({ code: 'custom', path: ['review', 'completed_at'], message: 'review cannot complete after the attempt' })
      if (attempt.review.launch_state === 'settled' && attempt.review.completed_at === null
        && !((attempt.status === 'cancelled' && attempt.failure_classification === 'cancelled')
          || (attempt.status === 'failed' && attempt.failure_classification === 'transport'))) {
        context.addIssue({ code: 'custom', path: ['review', 'launch_state'], message: 'incomplete settled review is allowed only after cancellation or definitive transport rejection' })
      }
    }
    if (attempt.status === 'passed') {
      if (attempt.checkpoint_tree_sha256 === null || attempt.review === null || attempt.review?.verdict !== 'passed'
        || attempt.review.evidence_digest !== attempt.review_evidence_digest) {
        context.addIssue({ code: 'custom', path: ['review'], message: 'passed coordinated attempt requires exact passed checkpoint review evidence' })
      }
    } else if (attempt.review?.completed_at !== null && attempt.review?.completed_at !== undefined) {
      if (attempt.review.evidence_digest !== attempt.review_evidence_digest) context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'attempt review digest must exactly match its completed review record' })
    } else if (attempt.review_evidence_digest !== null) {
      context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'review evidence requires a completed review record' })
    }
  } else if (attempt.status !== 'passed' && attempt.review_evidence_digest !== null) context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'only passed historical attempts may carry review evidence' })
  const failed_classes: FailureClass[] = ['transport', 'contract', 'semantic', 'ambiguous_launch']
  if (attempt.status === 'failed' && !failed_classes.includes(attempt.failure_classification as FailureClass)) context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'failed attempt requires transport, contract, semantic, or ambiguous_launch classification' })
  else if (attempt.status === 'cancelled' && attempt.failure_classification !== 'cancelled') context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'cancelled attempt requires cancelled classification' })
  else if ((is_active || attempt.status === 'passed') && attempt.failure_classification !== null) context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'active and passed attempts require null classification' })
})

export const EpicItemSchema = z.object({
  item_id: SafeIdentifierSchema,
  dependencies: z.array(SafeIdentifierSchema).max(MAX_ITEM_DEPENDENCIES),
  scope: BoundedTextSchema,
  status: z.enum(['pending', 'queued', 'running', 'passed', 'failed', 'blocked', 'conflicted', 'integrated', 'cancelled']),
  attempts: z.array(EpicAttemptSchema).max(MAX_ATTEMPTS_PER_ITEM),
  selected_attempt_id: SafeIdentifierSchema.nullable(),
  worktree_name: SafeIdentifierSchema.nullable(),
  branch_name: GitBranchNameSchema.nullable(),
  checkpoint_commit: GitOidSchema.nullable(),
  review_evidence_digest: Sha256Schema.nullable(),
  conflict_paths: z.array(RelativeConflictPathSchema).max(MAX_EPIC_ITEMS),
  integration_commit: GitOidSchema.nullable(),
  completed_at: DateTimeSchema.nullable(),
  retry_not_before: DateTimeSchema.nullable().optional(),
}).strict()

export const EpicIntegrationIntentSchema = z.object({
  intent_id: SafeIdentifierSchema,
  operation: z.literal('integrate'),
  item_id: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  prior_state_revision: safeNonNegativeInteger.positive(),
  prior_state_sha256: Sha256Schema,
  prior_generation: safeNonNegativeInteger.positive(),
  expected_source_commit: GitOidSchema,
  expected_target_commit: GitOidSchema,
  dependency_snapshot_sha256: Sha256Schema,
  review_evidence_digest: Sha256Schema,
}).strict()

export const EpicIntegrationEventSchema = z.object({
  event_id: SafeIdentifierSchema,
  item_id: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  dependency_snapshot_sha256: Sha256Schema,
  source_commit: GitOidSchema,
  previous_target_commit: GitOidSchema.optional(),
  target_commit: GitOidSchema,
  review_evidence_digest: Sha256Schema,
  result: z.enum(['success', 'failure']),
  previous_event_digest: Sha256Schema.nullable(),
  event_digest: Sha256Schema,
  recorded_at: DateTimeSchema,
}).strict()

export const EpicStateStructuralSchema = z.object({
  schema_version: z.literal(EPIC_SCHEMA_VERSION),
  state_revision: safeNonNegativeInteger.positive(),
  operational_limits: EpicOperationalLimitsSchema,
  epic_id: SafeIdentifierSchema,
  root_session_id: SafeIdentifierSchema,
  project_identity_sha256: Sha256Schema,
  base_branch: FullBranchRefSchema,
  integration_branch: FullBranchRefSchema,
  status: z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  pause_reason: BoundedTextSchema.nullable(),
  pause_code: SafeIdentifierSchema.nullable().optional(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  items: z.record(SafeIdentifierSchema, EpicItemSchema),
  integration_log: z.array(EpicIntegrationEventSchema).max(MAX_EPIC_ITEMS * MAX_ATTEMPTS_PER_ITEM),
  budgets: z.array(EpicBudgetRecordSchema).max(MAX_EPIC_BUDGET_RECORDS).optional(),
  usage: z.array(EpicScopedUsageSchema).max(MAX_EPIC_ITEMS + 1),
  budget_updates: z.array(EpicBudgetUpdateSchema).max(MAX_EPIC_BUDGET_RECORDS),
  coordination_policy: EpicCoordinationPolicySchema.optional(),
  integration_intent: EpicIntegrationIntentSchema.nullable().optional(),
}).strict().superRefine((state, context) => {
  const has_ambiguous_review = Object.values(state.items).some(item => item.attempts.some(attempt => {
    if (!attempt.review || attempt.review.launch_state !== 'ambiguous') return false
    return ['running', 'checkpointed', 'reviewing'].includes(attempt.status)
  }))
  if (has_ambiguous_review && (state.status !== 'paused' || state.pause_code !== 'ambiguous_reviewer_launch')) {
    context.addIssue({ code: 'custom', path: ['pause_code'], message: 'ambiguous reviewer launch requires an attended paused state' })
  }
})
