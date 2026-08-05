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
export const MIN_QUEUE_LEASE_DURATION_MS = 5_000
export const MAX_QUEUE_LEASE_DURATION_MS = 60 * 60 * 1000
export const MAX_QUEUE_RENEWAL_INTERVAL_MS = 60 * 60 * 1000
export const MAX_QUEUE_RETRY_ATTEMPTS = 32
export const MAX_QUEUE_BACKOFF_DELAY_MS = 60 * 60 * 1000

const QueueModelTierSchema = z.enum(['low', 'mid', 'high'])

const QueueRetryPolicySchema = CheckedRetryPolicySchema.superRefine((policy, context) => {
  for (const field of [
    'max_semantic_attempts', 'max_contract_attempts', 'max_transport_attempts', 'max_no_progress_attempts',
  ] as const) {
    if (policy[field] > MAX_QUEUE_RETRY_ATTEMPTS) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must not exceed ${MAX_QUEUE_RETRY_ATTEMPTS}` })
    }
  }
  for (const field of ['initial_delay_ms', 'maximum_delay_ms'] as const) {
    if (policy.transport_backoff[field] > MAX_QUEUE_BACKOFF_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['transport_backoff', field],
        message: `${field} must not exceed ${MAX_QUEUE_BACKOFF_DELAY_MS}`,
      })
    }
  }
})

export const QueueRateWindowSchema = z.object({
  window_ms: safePositiveInteger.max(60 * 60 * 1000),
  max_requests: safePositiveInteger,
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
  retry_policy: QueueRetryPolicySchema,
}

const EnabledQueueConfigSchema = z.object({
  enabled: EnabledQueueConfigFields.enabled,
  max_concurrent_workflows: EnabledQueueConfigFields.max_concurrent_workflows,
  lease_duration_ms: EnabledQueueConfigFields.lease_duration_ms,
  renewal_interval_ms: EnabledQueueConfigFields.renewal_interval_ms,
  recovery_attempt_limit: EnabledQueueConfigFields.recovery_attempt_limit,
  retry_policy: EnabledQueueConfigFields.retry_policy,
  rate_windows: z.array(QueueRateWindowSchema).max(MAX_QUEUE_RATE_WINDOWS).optional(),
}).strict().superRefine((config, context) => {
  if (config.renewal_interval_ms >= config.lease_duration_ms) {
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

export function enabledQueue(config: QueueConfig): EnabledQueueConfig {
  if (!config.enabled) throw new Error('queue is not enabled')
  return EnabledQueueConfigSchema.parse(config)
}
