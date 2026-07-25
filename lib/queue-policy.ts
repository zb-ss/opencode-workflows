import { z } from 'zod'

import {
  CheckedRetryPolicySchema,
  safeNonNegativeInteger,
  safePositiveInteger,
} from './automation-policy-contracts.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

export const MAX_QUEUE_WORKFLOWS = 256
export const MAX_QUEUE_CONCURRENCY = 256
export const MAX_QUEUE_PROVIDER_POLICIES = 64
export const MAX_QUEUE_RATE_WINDOWS = 8
export const MAX_QUEUE_BUDGET_RECORDS = 4096
export const MIN_QUEUE_LEASE_DURATION_MS = 5_000
export const MAX_QUEUE_LEASE_DURATION_MS = 60 * 60 * 1000
export const MAX_QUEUE_RENEWAL_INTERVAL_MS = 60 * 60 * 1000

const QueueModelTierSchema = z.enum(['low', 'mid', 'high'])

export const QueueRateWindowSchema = z.object({
  window_ms: safePositiveInteger.max(60 * 60 * 1000),
  max_requests: safePositiveInteger,
}).strict()

export const QueueBudgetSchema = z.object({
  dimension: z.enum(['sessions', 'input_tokens', 'output_tokens', 'cost_usd', 'active_time_ms', 'calendar_age_ms']),
  scope: z.enum(['global', 'workflow']),
  limit: z.number().nullable(),
}).strict()

const DisabledQueueConfigSchema = z.object({
  enabled: z.literal(false),
}).strict()

const EnabledQueueConfigFields = {
  enabled: z.literal(true),
  max_concurrent_workflows: safePositiveInteger.max(MAX_QUEUE_CONCURRENCY),
  lease_duration_ms: safePositiveInteger.min(MIN_QUEUE_LEASE_DURATION_MS).max(MAX_QUEUE_LEASE_DURATION_MS),
  renewal_interval_ms: safePositiveInteger.max(MAX_QUEUE_RENEWAL_INTERVAL_MS),
  recovery_attempt_limit: safePositiveInteger.max(10),
  retry_policy: CheckedRetryPolicySchema,
}

const REQUIRED_ENABLED_QUEUE_FIELDS = Object.keys(EnabledQueueConfigFields)
  .filter(field => field !== 'enabled') as Array<Exclude<keyof typeof EnabledQueueConfigFields, 'enabled'>>

const EnabledQueueConfigSchema = z.object({
  enabled: EnabledQueueConfigFields.enabled,
  max_concurrent_workflows: EnabledQueueConfigFields.max_concurrent_workflows.optional(),
  lease_duration_ms: EnabledQueueConfigFields.lease_duration_ms.optional(),
  renewal_interval_ms: EnabledQueueConfigFields.renewal_interval_ms.optional(),
  recovery_attempt_limit: EnabledQueueConfigFields.recovery_attempt_limit.optional(),
  retry_policy: EnabledQueueConfigFields.retry_policy.optional(),
  rate_windows: z.array(QueueRateWindowSchema).max(MAX_QUEUE_RATE_WINDOWS).optional(),
  budgets: z.array(QueueBudgetSchema).max(MAX_QUEUE_BUDGET_RECORDS).optional(),
}).strict().superRefine((config, context) => {
  for (const field of REQUIRED_ENABLED_QUEUE_FIELDS) {
    if (config[field] === undefined) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} is required when queue is enabled` })
    }
  }
  if (config.renewal_interval_ms !== undefined
    && config.lease_duration_ms !== undefined
    && config.renewal_interval_ms >= config.lease_duration_ms) {
    context.addIssue({
      code: 'custom',
      path: ['renewal_interval_ms'],
      message: 'renewal_interval_ms must be less than lease_duration_ms',
    })
  }
})

export const QueueConfigSchema = z.union([DisabledQueueConfigSchema, EnabledQueueConfigSchema])
  .default({ enabled: false })

export type QueueConfig = z.infer<typeof QueueConfigSchema>
export type EnabledQueueConfig = z.infer<typeof EnabledQueueConfigSchema>
export type QueueRateWindow = z.infer<typeof QueueRateWindowSchema>
export type QueueBudget = z.infer<typeof QueueBudgetSchema>

export function enabledQueue(config: QueueConfig): EnabledQueueConfig {
  if (!config.enabled) throw new Error('queue is not enabled')
  return config
}