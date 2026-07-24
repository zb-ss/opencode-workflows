import { z } from 'zod'

import {
  CheckedRetryPolicySchema,
  safePositiveInteger,
  type RetryPolicy,
} from './automation-policy-contracts.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

/** Hard protocol ceilings. Enabled deployments must select lower effective limits explicitly. */
export const MAX_EPIC_ITEMS = 256
export const MAX_ITEM_DEPENDENCIES = 64
export const MAX_ATTEMPTS_PER_ITEM = 32
export const MAX_EPIC_BUDGET_RECORDS = 4096
export const MAX_EPIC_REVISIONS = 10_000
export const MAX_EPIC_CHAIN_BYTES = 256 * 1024 * 1024
export const MAX_EPIC_PARALLEL_SESSIONS = MAX_EPIC_ITEMS
export const MAX_EPIC_ATTEMPT_DURATION_MS = 60 * 60 * 1000
export const MAX_EPIC_ACTIVE_TIME_CHECKPOINT_MS = 60 * 60 * 1000
export const MAX_EPIC_RESULT_BYTES = 16 * 1024 * 1024
export const MIN_EPIC_RESULT_BYTES = 8 * 1024
export const MAX_EPIC_MODEL_CANDIDATES = 64
export const MAX_EPIC_PROVIDER_POLICIES = 64
export const MAX_EPIC_TRANSPORT_BACKOFF_DELAY_MS = 60 * 60 * 1000

export const EpicModelTierSchema = z.enum(['low', 'mid', 'high'])

export const EpicRetryPolicySchema = CheckedRetryPolicySchema.superRefine((retry_policy, context) => {
  for (const field of ['max_semantic_attempts', 'max_contract_attempts', 'max_transport_attempts', 'max_no_progress_attempts'] as const) {
    if (retry_policy[field] > MAX_ATTEMPTS_PER_ITEM) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} exceeds the epic attempt ceiling` })
    }
  }
  if (retry_policy.transport_backoff.maximum_delay_ms > MAX_EPIC_TRANSPORT_BACKOFF_DELAY_MS) {
    context.addIssue({
      code: 'custom',
      path: ['transport_backoff', 'maximum_delay_ms'],
      message: 'transport backoff exceeds the epic delay ceiling',
    })
  }
})

export const EpicOperationalLimitsSchema = z.object({
  max_epic_items: safePositiveInteger.max(MAX_EPIC_ITEMS),
  max_item_dependencies: safePositiveInteger.max(MAX_ITEM_DEPENDENCIES),
  max_attempts_per_item: safePositiveInteger.max(MAX_ATTEMPTS_PER_ITEM),
  // Aggregate ceiling across active budgets, root budget updates, and every
  // extension embedded in a budget record.
  max_budget_records: safePositiveInteger.max(MAX_EPIC_BUDGET_RECORDS),
}).strict()

const DisabledEpicConfigSchema = z.object({
  enabled: z.literal(false),
}).strict()

const EnabledEpicConfigFields = {
  enabled: z.literal(true),
  max_epic_items: EpicOperationalLimitsSchema.shape.max_epic_items,
  max_item_dependencies: EpicOperationalLimitsSchema.shape.max_item_dependencies,
  max_attempts_per_item: EpicOperationalLimitsSchema.shape.max_attempts_per_item,
  max_budget_records: EpicOperationalLimitsSchema.shape.max_budget_records,
  executor_agent: SafeIdentifierSchema,
  executor_model_tier: EpicModelTierSchema,
  reviewer_agent: SafeIdentifierSchema,
  reviewer_model_tier: EpicModelTierSchema,
  max_parallel_sessions: safePositiveInteger.max(MAX_EPIC_PARALLEL_SESSIONS),
  max_attempt_duration_ms: safePositiveInteger.max(MAX_EPIC_ATTEMPT_DURATION_MS),
  active_time_checkpoint_ms: safePositiveInteger.max(MAX_EPIC_ACTIVE_TIME_CHECKPOINT_MS),
  max_result_bytes: safePositiveInteger.min(MIN_EPIC_RESULT_BYTES).max(MAX_EPIC_RESULT_BYTES),
  retry_policy: EpicRetryPolicySchema,
}

const REQUIRED_ENABLED_EPIC_FIELDS = Object.keys(EnabledEpicConfigFields)
  .filter(field => field !== 'enabled') as Array<Exclude<keyof typeof EnabledEpicConfigFields, 'enabled'>>

// Fields remain optional in the inferred input type so older callers get a
// runtime validation failure instead of a TypeScript-only compatibility break.
// The public enabled helper returns the fully required, checked shape.
const EnabledEpicConfigSchema = z.object({
  enabled: EnabledEpicConfigFields.enabled,
  max_epic_items: EnabledEpicConfigFields.max_epic_items,
  max_item_dependencies: EnabledEpicConfigFields.max_item_dependencies,
  max_attempts_per_item: EnabledEpicConfigFields.max_attempts_per_item,
  max_budget_records: EnabledEpicConfigFields.max_budget_records,
  executor_agent: EnabledEpicConfigFields.executor_agent.optional(),
  executor_model_tier: EnabledEpicConfigFields.executor_model_tier.optional(),
  reviewer_agent: EnabledEpicConfigFields.reviewer_agent.optional(),
  reviewer_model_tier: EnabledEpicConfigFields.reviewer_model_tier.optional(),
  max_parallel_sessions: EnabledEpicConfigFields.max_parallel_sessions.optional(),
  max_attempt_duration_ms: EnabledEpicConfigFields.max_attempt_duration_ms.optional(),
  active_time_checkpoint_ms: EnabledEpicConfigFields.active_time_checkpoint_ms.optional(),
  max_result_bytes: EnabledEpicConfigFields.max_result_bytes.optional(),
  retry_policy: EnabledEpicConfigFields.retry_policy.optional(),
}).strict().superRefine((config, context) => {
  for (const field of REQUIRED_ENABLED_EPIC_FIELDS) {
    if (config[field] === undefined) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} is required when epic coordination is enabled` })
    }
  }
  if (config.active_time_checkpoint_ms !== undefined
    && config.max_attempt_duration_ms !== undefined
    && config.active_time_checkpoint_ms > config.max_attempt_duration_ms) {
    context.addIssue({
      code: 'custom',
      path: ['active_time_checkpoint_ms'],
      message: 'active_time_checkpoint_ms must not exceed max_attempt_duration_ms',
    })
  }
  if (config.max_parallel_sessions !== undefined
    && config.max_epic_items !== undefined
    && config.max_parallel_sessions > config.max_epic_items) {
    context.addIssue({
      code: 'custom',
      path: ['max_parallel_sessions'],
      message: 'max_parallel_sessions must not exceed max_epic_items',
    })
  }
  if (config.retry_policy !== undefined && config.max_attempts_per_item !== undefined) {
    for (const field of ['max_semantic_attempts', 'max_contract_attempts', 'max_transport_attempts', 'max_no_progress_attempts'] as const) {
      if (config.retry_policy[field] > config.max_attempts_per_item) {
        context.addIssue({ code: 'custom', path: ['retry_policy', field], message: `${field} must not exceed max_attempts_per_item` })
      }
    }
  }
})

export const EpicConfigSchema = z.discriminatedUnion('enabled', [
  DisabledEpicConfigSchema,
  EnabledEpicConfigSchema,
]).default({ enabled: false })

export type EpicOperationalLimits = z.infer<typeof EpicOperationalLimitsSchema>
export type EpicConfig = z.infer<typeof EpicConfigSchema>
export type EpicModelTier = z.infer<typeof EpicModelTierSchema>
export type EpicRetryPolicy = RetryPolicy
export type EnabledEpicConfig = { enabled: true } & EpicOperationalLimits & {
  executor_agent: string
  executor_model_tier: EpicModelTier
  reviewer_agent: string
  reviewer_model_tier: EpicModelTier
  max_parallel_sessions: number
  max_attempt_duration_ms: number
  active_time_checkpoint_ms: number
  max_result_bytes: number
  retry_policy: EpicRetryPolicy
}

export function parseEpicConfig(input: unknown): EpicConfig {
  const parsed = EpicConfigSchema.safeParse(input)
  if (!parsed.success) throw new Error(`invalid epic configuration: ${parsed.error.message}`)
  return parsed.data
}

export function enabledEpic(config: EpicConfig): EnabledEpicConfig {
  const parsed = EpicConfigSchema.safeParse(config)
  if (!parsed.success || !parsed.data.enabled) throw new Error('epic requires a complete enabled configuration')
  return parsed.data as EnabledEpicConfig
}
