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

export const QUEUE_SCHEMA_VERSION = 1

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
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  usage: AutomationUsageTelemetrySchema,
}).strict()

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