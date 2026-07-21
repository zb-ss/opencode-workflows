import path from 'node:path'

import { z } from 'zod'

import {
  AutomationUsageTelemetrySchema,
  FailureClassSchema,
  finiteNonNegativeCost,
  safeNonNegativeInteger,
  type FailureClass,
} from './automation-policy-contracts.ts'
import {
  EpicOperationalLimitsSchema,
  MAX_ATTEMPTS_PER_ITEM,
  MAX_EPIC_BUDGET_RECORDS,
  MAX_EPIC_ITEMS,
  MAX_ITEM_DEPENDENCIES,
  type EpicOperationalLimits,
} from './epic-policy.ts'
import { EpicWorktreeEvidenceSchema, type EpicWorktreeEvidence } from './epic-worktree-contracts.ts'
import { validateModelCandidate } from './model-registry.ts'
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
export type EpicAttemptStatus = 'running' | 'passed' | 'failed' | 'cancelled'

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
}

export interface EpicIntegrationEvent {
  event_id: string
  item_id: string
  attempt_id: string
  dependency_snapshot_sha256: string
  source_commit: string
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
  status: z.enum(['running', 'passed', 'failed', 'cancelled']),
}).strict().superRefine((attempt, context) => {
  const is_running = attempt.status === 'running'
  if (is_running !== (attempt.completed_at === null)) context.addIssue({ code: 'custom', path: ['completed_at'], message: is_running ? 'running attempt must not have completed_at' : 'terminal attempt must have completed_at' })
  if (attempt.completed_at !== null && Date.parse(attempt.completed_at) < Date.parse(attempt.started_at)) context.addIssue({ code: 'custom', path: ['completed_at'], message: 'attempt completed_at must not precede started_at' })
  if (is_running && attempt.result_summary !== null) context.addIssue({ code: 'custom', path: ['result_summary'], message: 'running attempt must not have a result summary' })
  if (attempt.status === 'passed' && attempt.checkpoint_commit === null) context.addIssue({ code: 'custom', path: ['checkpoint_commit'], message: 'passed attempt requires a checkpoint commit' })
  if (attempt.status === 'passed' && attempt.review_evidence_digest === null) context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'passed attempt requires review evidence' })
  else if (attempt.status !== 'passed' && attempt.review_evidence_digest !== null) context.addIssue({ code: 'custom', path: ['review_evidence_digest'], message: 'only passed attempts may carry review evidence' })
  const failed_classes: FailureClass[] = ['transport', 'contract', 'semantic', 'ambiguous_launch']
  if (attempt.status === 'failed' && !failed_classes.includes(attempt.failure_classification as FailureClass)) context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'failed attempt requires transport, contract, semantic, or ambiguous_launch classification' })
  else if (attempt.status === 'cancelled' && attempt.failure_classification !== 'cancelled') context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'cancelled attempt requires cancelled classification' })
  else if ((attempt.status === 'running' || attempt.status === 'passed') && attempt.failure_classification !== null) context.addIssue({ code: 'custom', path: ['failure_classification'], message: 'running and passed attempts require null classification' })
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
}).strict()

export const EpicIntegrationEventSchema = z.object({
  event_id: SafeIdentifierSchema,
  item_id: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  dependency_snapshot_sha256: Sha256Schema,
  source_commit: GitOidSchema,
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
}).strict()
