import { z } from 'zod'

import {
  AutomationUsageTelemetrySchema,
  FailureClassSchema,
  RetryAttemptCountersSchema,
  safeNonNegativeInteger,
  safePositiveInteger,
  nullableIsoDateTime,
  type FailureClass,
  type RetryAttemptCounters,
} from './automation-policy-contracts.ts'
import { CheckedRetryPolicySchema } from './automation-policy-contracts.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

const DateTimeSchema = z.string().min(1).max(64).check(z.iso.datetime({ offset: true }))

export const QUEUE_SCHEMA_VERSION = 2

export type QueueWorkflowStatus =
  | 'queued'
  | 'leased'
  | 'recovering'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const QueueWorkflowStatusSchema = z.enum([
  'queued', 'leased', 'recovering', 'running', 'paused', 'completed', 'failed', 'cancelled',
])

export type QueueLaunchState = 'reserved' | 'created' | 'prompted' | 'settled' | 'ambiguous'

export const QueueLaunchStateSchema = z.enum([
  'reserved', 'created', 'prompted', 'settled', 'ambiguous',
])

export interface QueueLaunchIntent {
  intent_id: string
  workflow_id: string
  fencing_generation: number
  session_id: string | null
  child_session_ids: string[]
  engine_instance_id: string | null
  agent: string
  model: string
  launch_state: QueueLaunchState
  reserved_at: string
  created_at: string | null
  prompted_at: string | null
  settled_at: string | null
}

export const QueueLaunchIntentSchema = z.object({
  intent_id: SafeIdentifierSchema,
  workflow_id: SafeIdentifierSchema,
  fencing_generation: safePositiveInteger,
  session_id: SafeIdentifierSchema.nullable(),
  child_session_ids: z.array(SafeIdentifierSchema).max(256),
  engine_instance_id: SafeIdentifierSchema.nullable(),
  agent: SafeIdentifierSchema,
  model: z.string().min(1).max(256),
  launch_state: QueueLaunchStateSchema,
  reserved_at: DateTimeSchema,
  created_at: DateTimeSchema.nullable(),
  prompted_at: DateTimeSchema.nullable(),
  settled_at: DateTimeSchema.nullable(),
}).strict()

export interface QueueWorkflowRecord {
  schema_version: typeof QUEUE_SCHEMA_VERSION
  workflow_id: string
  definition_id: string
  root_session_id: string
  directory: string
  worktree: string
  mode: string
  task: string
  status: QueueWorkflowStatus
  pause_reason: string | null
  fencing_generation: number
  state_revision: number
  launch_intent: QueueLaunchIntent | null
  failure_classification: FailureClass | null
  retry_counters: RetryAttemptCounters | null
  retry_not_before: string | null
  recovery_attempt_count: number
  created_at: string
  updated_at: string
  usage: z.infer<typeof AutomationUsageTelemetrySchema>
}

export const QueueWorkflowRecordSchema = z.object({
  schema_version: z.literal(QUEUE_SCHEMA_VERSION),
  workflow_id: SafeIdentifierSchema,
  definition_id: SafeIdentifierSchema,
  root_session_id: SafeIdentifierSchema,
  directory: z.string().min(1).max(4096),
  worktree: z.string().min(1).max(4096),
  mode: SafeIdentifierSchema,
  task: z.string().min(1).max(20000),
  status: QueueWorkflowStatusSchema,
  pause_reason: z.string().min(1).max(4096).nullable(),
  fencing_generation: safePositiveInteger,
  state_revision: safePositiveInteger,
  launch_intent: QueueLaunchIntentSchema.nullable(),
  failure_classification: FailureClassSchema.nullable(),
  retry_counters: RetryAttemptCountersSchema.nullable(),
  retry_not_before: DateTimeSchema.nullable(),
  recovery_attempt_count: safeNonNegativeInteger,
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  usage: AutomationUsageTelemetrySchema,
}).strict()

/**
 * Legacy v1 record schema (before recovery_attempt_count, child_session_ids,
 * and engine_instance_id were added). Used for one-way migration to v2.
 */
const LegacyV1LaunchIntentSchema = z.object({
  intent_id: SafeIdentifierSchema,
  workflow_id: SafeIdentifierSchema,
  fencing_generation: safePositiveInteger,
  session_id: SafeIdentifierSchema.nullable(),
  agent: SafeIdentifierSchema,
  model: z.string().min(1).max(256),
  launch_state: QueueLaunchStateSchema,
  reserved_at: DateTimeSchema,
  created_at: DateTimeSchema.nullable(),
  prompted_at: DateTimeSchema.nullable(),
  settled_at: DateTimeSchema.nullable(),
}).strict()

const LegacyV1RecordSchema = z.object({
  schema_version: z.literal(1),
  workflow_id: SafeIdentifierSchema,
  definition_id: SafeIdentifierSchema,
  root_session_id: SafeIdentifierSchema,
  directory: z.string().min(1).max(4096),
  worktree: z.string().min(1).max(4096),
  mode: SafeIdentifierSchema,
  task: z.string().min(1).max(20000),
  status: QueueWorkflowStatusSchema,
  pause_reason: z.string().min(1).max(4096).nullable(),
  fencing_generation: safePositiveInteger,
  state_revision: safePositiveInteger,
  launch_intent: LegacyV1LaunchIntentSchema.nullable(),
  failure_classification: FailureClassSchema.nullable(),
  retry_counters: RetryAttemptCountersSchema.nullable(),
  retry_not_before: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  usage: AutomationUsageTelemetrySchema,
}).strict()

/**
 * Parse a raw JSON value as a queue workflow record, migrating legacy v1
 * records to v2. v1 records lack recovery_attempt_count, child_session_ids,
 * and engine_instance_id; these are defaulted during migration.
 *
 * Malformed records (wrong schema version, missing required fields, or
 * structurally invalid) fail closed by throwing.
 */
export function parseQueueWorkflowRecord(raw: unknown): QueueWorkflowRecord {
  // Try v2 first.
  const v2Result = QueueWorkflowRecordSchema.safeParse(raw)
  if (v2Result.success) return v2Result.data

  // Try v1 migration.
  const v1Result = LegacyV1RecordSchema.safeParse(raw)
  if (!v1Result.success) {
    // Neither v1 nor v2 — re-throw the v2 error for the caller.
    throw v2Result.error
  }

  const v1 = v1Result.data
  const migrated: QueueWorkflowRecord = {
    ...v1,
    schema_version: QUEUE_SCHEMA_VERSION,
    recovery_attempt_count: 0,
    launch_intent: v1.launch_intent
      ? { ...v1.launch_intent, child_session_ids: [], engine_instance_id: null }
      : null,
  }
  // Validate the migrated record against the v2 schema.
  return QueueWorkflowRecordSchema.parse(migrated)
}

export const QueueIndexEntrySchema = z.object({
  workflow_id: SafeIdentifierSchema,
  status: QueueWorkflowStatusSchema,
  fencing_generation: safePositiveInteger,
  state_revision: safePositiveInteger,
  updated_at: DateTimeSchema,
}).strict()

export type QueueIndexEntry = z.infer<typeof QueueIndexEntrySchema>

const VALID_TRANSITIONS: Record<QueueWorkflowStatus, ReadonlySet<QueueWorkflowStatus>> = {
  queued: new Set(['queued', 'leased', 'paused', 'cancelled', 'failed']),
  leased: new Set(['leased', 'running', 'recovering', 'paused', 'cancelled', 'failed', 'queued', 'completed']),
  recovering: new Set(['recovering', 'running', 'paused', 'cancelled', 'failed', 'queued']),
  running: new Set(['running', 'paused', 'completed', 'failed', 'cancelled']),
  paused: new Set(['paused', 'queued', 'cancelled', 'failed']),
  completed: new Set(['completed']),
  failed: new Set(['failed', 'queued']),
  cancelled: new Set(['cancelled']),
}

export function isValidTransition(from: QueueWorkflowStatus, to: QueueWorkflowStatus): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false
}

export class QueueValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueValidationError'
    this.code = code
  }
}