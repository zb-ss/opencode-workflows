import { z } from 'zod'

import {
  AutomationSafetySchema,
  CheckedRetryPolicySchema,
  FailureClassSchema,
  RetryAttemptCountersSchema,
  StructuralResolvedAutomationPolicySchema,
  addTransportBackoffDelayRangeIssue,
  assertSafeNonNegativeInteger,
  type AutomationSafety,
  type FailureClass,
  type RetryAttemptCounters,
  type RetryPolicy,
  type StructuralResolvedAutomationPolicy,
} from './automation-policy-contracts.ts'

type RetryableFailureClass = Exclude<FailureClass, 'ambiguous_launch' | 'cancelled'>
type AttemptCounterField = Exclude<keyof RetryAttemptCounters, 'consecutive_no_progress_attempts'>
type RetryMaximumField = Exclude<keyof RetryPolicy, 'max_no_progress_attempts' | 'transport_backoff'>

const RETRYABLE_FAILURE_FIELDS = {
  transport: {
    attempt_counter: 'transport_attempts',
    retry_maximum: 'max_transport_attempts',
  },
  contract: {
    attempt_counter: 'contract_attempts',
    retry_maximum: 'max_contract_attempts',
  },
  semantic: {
    attempt_counter: 'semantic_attempts',
    retry_maximum: 'max_semantic_attempts',
  },
} as const satisfies Record<RetryableFailureClass, {
  attempt_counter: AttemptCounterField
  retry_maximum: RetryMaximumField
}>

export type RetrySafetyCeilingViolation = {
  kind: 'retry_attempts' | 'transport_backoff'
  path: string[]
  message: string
}

export type RetrySafetyAssessment = {
  violations: RetrySafetyCeilingViolation[]
  has_retry_attempts_within_safety_ceiling: boolean
  has_transport_backoff_within_safety_ceiling: boolean
}

export function assessRetrySafety(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): RetrySafetyAssessment {
  const validated_retry_policy = CheckedRetryPolicySchema.parse(retry_policy)
  const validated_safety = AutomationSafetySchema.parse(safety)
  return assessValidatedRetrySafety(validated_retry_policy, validated_safety)
}

export function retrySafetyCeilingViolations(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): RetrySafetyCeilingViolation[] {
  return assessRetrySafety(retry_policy, safety).violations
}

export function hasRetryAttemptsWithinSafetyCeiling(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): boolean {
  const assessment = safelyAssessRetrySafety(retry_policy, safety)
  return assessment?.has_retry_attempts_within_safety_ceiling ?? false
}

export function hasTransportBackoffWithinSafetyCeiling(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): boolean {
  const assessment = safelyAssessRetrySafety(retry_policy, safety)
  return assessment?.has_transport_backoff_within_safety_ceiling ?? false
}

export const CheckedResolvedAutomationPolicySchema = StructuralResolvedAutomationPolicySchema.superRefine(
  (policy, context) => {
    addTransportBackoffDelayRangeIssue(policy.retry_policy.transport_backoff, context, ['retry_policy'])
    addRetrySafetyCeilingIssues(policy, context)
  },
)

export const ResolvedAutomationPolicySchema = CheckedResolvedAutomationPolicySchema
export type ResolvedAutomationPolicy = z.infer<typeof ResolvedAutomationPolicySchema>

export function transportBackoffDelayMs(retry_policy: RetryPolicy, retry_index: number): number {
  assertSafeNonNegativeInteger(retry_index, 'transport retry index')
  const validated = CheckedRetryPolicySchema.parse(retry_policy)
  const backoff = validated.transport_backoff
  const delay = backoff.initial_delay_ms * (backoff.multiplier ** retry_index)
  return Math.min(Math.ceil(delay), backoff.maximum_delay_ms)
}

export function isFailureRetryable(
  failure_class: FailureClass,
  attempts: RetryAttemptCounters,
  retry_policy: RetryPolicy,
): boolean {
  const validated_class = FailureClassSchema.parse(failure_class)
  const validated_attempts = RetryAttemptCountersSchema.parse(attempts)
  const validated_policy = CheckedRetryPolicySchema.parse(retry_policy)
  if (!isRetryableFailureClass(validated_class)) return false
  if (validated_attempts.consecutive_no_progress_attempts >= validated_policy.max_no_progress_attempts) {
    return false
  }
  const fields = RETRYABLE_FAILURE_FIELDS[validated_class]
  return validated_attempts[fields.attempt_counter] < validated_policy[fields.retry_maximum]
}

function assessValidatedRetrySafety(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): RetrySafetyAssessment {
  const violations: RetrySafetyCeilingViolation[] = []
  const retry_attempt_rules = [
    ['max_semantic_attempts', 'max_retry_attempts_per_class'],
    ['max_contract_attempts', 'max_retry_attempts_per_class'],
    ['max_transport_attempts', 'max_retry_attempts_per_class'],
    ['max_no_progress_attempts', 'max_consecutive_no_progress_attempts'],
  ] as const
  for (const [retry_field, safety_field] of retry_attempt_rules) {
    if (retry_policy[retry_field] > safety[safety_field]) {
      violations.push({
        kind: 'retry_attempts',
        path: ['retry_policy', retry_field],
        message: `${retry_field} must not exceed safety.${safety_field}`,
      })
    }
  }

  for (const retry_field of ['initial_delay_ms', 'maximum_delay_ms'] as const) {
    const safety_field = 'max_transport_backoff_delay_ms'
    if (retry_policy.transport_backoff[retry_field] > safety[safety_field]) {
      violations.push({
        kind: 'transport_backoff',
        path: ['retry_policy', 'transport_backoff', retry_field],
        message: `${retry_field} must not exceed safety.${safety_field}`,
      })
    }
  }

  return {
    violations,
    has_retry_attempts_within_safety_ceiling: !violations.some(
      violation => violation.kind === 'retry_attempts',
    ),
    has_transport_backoff_within_safety_ceiling: !violations.some(
      violation => violation.kind === 'transport_backoff',
    ),
  }
}

function safelyAssessRetrySafety(
  retry_policy: RetryPolicy,
  safety: AutomationSafety,
): RetrySafetyAssessment | null {
  const validated_retry_policy = CheckedRetryPolicySchema.safeParse(retry_policy)
  const validated_safety = AutomationSafetySchema.safeParse(safety)
  if (!validated_retry_policy.success || !validated_safety.success) return null
  return assessValidatedRetrySafety(validated_retry_policy.data, validated_safety.data)
}

function addRetrySafetyCeilingIssues(
  policy: StructuralResolvedAutomationPolicy,
  context: z.core.$RefinementCtx,
): void {
  const assessment = assessValidatedRetrySafety(policy.retry_policy, policy.safety)
  for (const violation of assessment.violations) {
    context.addIssue({
      code: 'custom',
      path: violation.path,
      message: violation.message,
    })
  }
}

function isRetryableFailureClass(failure_class: FailureClass): failure_class is RetryableFailureClass {
  return failure_class in RETRYABLE_FAILURE_FIELDS
}
