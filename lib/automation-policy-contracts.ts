import { z } from 'zod'

import { MAX_BOUNDED_IO_BYTES } from './workflow-limits.mjs'

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
export const safePositiveInteger = z.number().int().safe().positive()
export const safeNonNegativeInteger = z.number().int().safe().nonnegative()
export const finiteNonNegativeCost = z.number().finite().nonnegative().max(MAX_SAFE_INTEGER)
export const nullableSafeNonNegativeInteger = safeNonNegativeInteger.nullable()
export const nullableFiniteNonNegativeCost = finiteNonNegativeCost.nullable()

const MAX_TIMESTAMP_LENGTH = 64
const RFC3339_LIKE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const isoDateTime = z.string()
  .max(MAX_TIMESTAMP_LENGTH)
  .regex(RFC3339_LIKE_PATTERN)
  .check(z.iso.datetime({ offset: true }))

export const nullableIsoDateTime = isoDateTime.nullable()

export const RETRY_POLICY_SCHEMA_ID = 'https://opencode-workflows.example/schema/retry-policy.schema.json'
export const AUTOMATION_POLICY_SCHEMA_ID = 'https://opencode-workflows.example/schema/automation-policy.schema.json'

export const AccountingModeSchema = z.enum(['telemetry_only', 'metered'])
export const AccountingSchema = z.object({
  mode: AccountingModeSchema,
}).strict()

export const FailureClassSchema = z.enum([
  'transport',
  'contract',
  'semantic',
  'ambiguous_launch',
  'cancelled',
])

export const AutomationBudgetsSchema = z.object({
  max_sessions: safeNonNegativeInteger.optional(),
  max_input_tokens: safeNonNegativeInteger.optional(),
  max_output_tokens: safeNonNegativeInteger.optional(),
  max_cost_usd: finiteNonNegativeCost.optional(),
  max_active_time_ms: safeNonNegativeInteger.optional(),
  max_calendar_age_ms: safeNonNegativeInteger.optional(),
}).strict()

export const ResolvedAutomationLimitsSchema = z.object({
  max_sessions: nullableSafeNonNegativeInteger,
  max_input_tokens: nullableSafeNonNegativeInteger,
  max_output_tokens: nullableSafeNonNegativeInteger,
  max_cost_usd: nullableFiniteNonNegativeCost,
  max_active_time_ms: nullableSafeNonNegativeInteger,
  max_calendar_age_ms: nullableSafeNonNegativeInteger,
}).strict()

export const AutomationSafetySchema = z.object({
  // These values are trusted deployment-resolved ceilings, never workflow-owned input.
  max_parallel_sessions: safePositiveInteger,
  max_attempt_duration_ms: safePositiveInteger,
  max_selected_candidates: safePositiveInteger,
  max_retry_attempts_per_class: safePositiveInteger,
  max_consecutive_no_progress_attempts: safePositiveInteger,
  max_transport_backoff_delay_ms: safePositiveInteger,
  max_bounded_read_bytes: safeNonNegativeInteger.max(MAX_BOUNDED_IO_BYTES),
  max_bounded_write_bytes: safeNonNegativeInteger.max(MAX_BOUNDED_IO_BYTES),
}).strict()

export const TransportBackoffSchema = z.object({
  strategy: z.literal('exponential'),
  initial_delay_ms: safePositiveInteger,
  maximum_delay_ms: safePositiveInteger,
  multiplier: z.number().finite().gt(1).max(MAX_SAFE_INTEGER),
}).strict()

export const StructuralRetryPolicySchema = z.object({
  max_semantic_attempts: safePositiveInteger,
  max_contract_attempts: safePositiveInteger,
  max_transport_attempts: safePositiveInteger,
  max_no_progress_attempts: safePositiveInteger,
  transport_backoff: TransportBackoffSchema,
}).strict()

export type TransportBackoff = z.infer<typeof TransportBackoffSchema>

export function hasValidTransportBackoffDelayRange(backoff: TransportBackoff): boolean {
  return backoff.initial_delay_ms <= backoff.maximum_delay_ms
}

export const CheckedRetryPolicySchema = StructuralRetryPolicySchema.superRefine((retry_policy, context) => {
  addTransportBackoffDelayRangeIssue(retry_policy.transport_backoff, context)
})

export const RetryPolicySchema = CheckedRetryPolicySchema

export const StructuralAutomationPolicyInputSchema = z.object({
  accounting: AccountingSchema.default({ mode: 'telemetry_only' }),
  budgets: AutomationBudgetsSchema.optional(),
  retry_policy: StructuralRetryPolicySchema.optional(),
}).strict()

export const CheckedAutomationPolicyInputSchema = StructuralAutomationPolicyInputSchema.superRefine((policy, context) => {
  if (policy.retry_policy) {
    addTransportBackoffDelayRangeIssue(policy.retry_policy.transport_backoff, context, ['retry_policy'])
  }
})

export const AutomationPolicyInputSchema = CheckedAutomationPolicyInputSchema

export const StructuralResolvedAutomationPolicySchema = z.object({
  accounting: AccountingSchema,
  safety: AutomationSafetySchema,
  limits: ResolvedAutomationLimitsSchema,
  retry_policy: StructuralRetryPolicySchema,
}).strict()

export const CostEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('known'),
    cost_usd: finiteNonNegativeCost,
  }).strict(),
  z.object({
    kind: z.literal('unknown'),
  }).strict(),
])

export const CostReportingCapabilitySchema = z.object({
  status: z.enum(['trustworthy', 'untrustworthy', 'unknown']),
}).strict()

export const SelectedCostReportingCapabilitiesSchema = z.array(CostReportingCapabilitySchema).min(1)

export const AutomationUsageTelemetrySchema = z.object({
  sessions: safeNonNegativeInteger,
  attempts: safeNonNegativeInteger,
  input_tokens: safeNonNegativeInteger,
  output_tokens: safeNonNegativeInteger,
  bounded_read_bytes: safeNonNegativeInteger,
  bounded_write_bytes: safeNonNegativeInteger,
  validation_runs: safeNonNegativeInteger,
  active_time_ms: safeNonNegativeInteger,
  cost_evidence: CostEvidenceSchema,
  active_interval_started_at: nullableIsoDateTime,
  last_active_checkpoint_at: nullableIsoDateTime,
}).strict()

export const RetryAttemptCountersSchema = z.object({
  semantic_attempts: safeNonNegativeInteger,
  contract_attempts: safeNonNegativeInteger,
  transport_attempts: safeNonNegativeInteger,
  consecutive_no_progress_attempts: safeNonNegativeInteger,
}).strict()

export type AccountingMode = z.infer<typeof AccountingModeSchema>
export type Accounting = z.infer<typeof AccountingSchema>
export type FailureClass = z.infer<typeof FailureClassSchema>
export type AutomationBudgetsInput = z.infer<typeof AutomationBudgetsSchema>
export type ResolvedAutomationLimits = z.infer<typeof ResolvedAutomationLimitsSchema>
export type AutomationSafety = z.infer<typeof AutomationSafetySchema>
export type RetryPolicy = z.infer<typeof RetryPolicySchema>
export type AutomationPolicyInput = z.infer<typeof AutomationPolicyInputSchema>
export type StructuralResolvedAutomationPolicy = z.infer<typeof StructuralResolvedAutomationPolicySchema>
export type CostEvidence = z.infer<typeof CostEvidenceSchema>
export type CostReportingCapability = z.infer<typeof CostReportingCapabilitySchema>
export type AutomationUsageTelemetry = z.infer<typeof AutomationUsageTelemetrySchema>
export type RetryAttemptCounters = z.infer<typeof RetryAttemptCountersSchema>

export function addTransportBackoffDelayRangeIssue(
  backoff: TransportBackoff,
  context: z.core.$RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (hasValidTransportBackoffDelayRange(backoff)) return
  context.addIssue({
    code: 'custom',
    path: [...path, 'transport_backoff', 'maximum_delay_ms'],
    message: 'maximum_delay_ms must be greater than or equal to initial_delay_ms',
  })
}

export function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe non-negative integer`)
  }
}
