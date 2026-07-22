import type { RetryAttemptCounters } from './automation-policy-contracts.ts'
import { transportBackoffDelayMs } from './automation-retry-policy.ts'
import {
  EpicValidationError,
  type EpicAttempt,
  type EpicItem,
  type EpicState,
} from './epic-contract-schemas.ts'
import { validateEpicState } from './epic-dag-state-validation.ts'

export type EpicRetryBlockReason =
  | 'no_attempts'
  | 'attempt_not_terminal'
  | 'attempt_passed'
  | 'ambiguous_launch'
  | 'cancelled'
  | 'semantic_ceiling'
  | 'contract_ceiling'
  | 'transport_ceiling'
  | 'no_progress_ceiling'
  | 'max_attempts_per_item'

export type EpicRetryDecision =
  | { retry: true; counters: RetryAttemptCounters; retry_not_before: string | null }
  | { retry: false; counters: RetryAttemptCounters; reason: EpicRetryBlockReason }

interface ValidatedRetrySource {
  state: EpicState
  item: EpicItem
  attempts: EpicAttempt[]
  policy: NonNullable<EpicState['coordination_policy']>['retry_policy']
}

function validatedRetrySource(stateInput: unknown, itemId: string): ValidatedRetrySource {
  const state = validateEpicState(stateInput)
  const item = state.items[itemId]
  if (!item) throw new EpicValidationError(`unknown epic item: ${itemId}`)
  if (!state.coordination_policy) throw new EpicValidationError('epic retry assessment requires coordination policy')
  return { state, item, attempts: item.attempts, policy: state.coordination_policy.retry_policy }
}

function countersFromAttempts(attempts: readonly EpicAttempt[]): RetryAttemptCounters {
  let consecutive_no_progress_attempts = 0
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1]!
    const current = attempts[index]!
    if (current.progress_tree_sha256 === previous.progress_tree_sha256) consecutive_no_progress_attempts += 1
    else consecutive_no_progress_attempts = 0
  }
  return {
    semantic_attempts: attempts.filter(attempt => attempt.failure_classification === 'semantic').length,
    contract_attempts: attempts.filter(attempt => attempt.failure_classification === 'contract').length,
    transport_attempts: attempts.filter(attempt => attempt.failure_classification === 'transport').length,
    consecutive_no_progress_attempts,
  }
}

/** Derives counters only after validating the complete state and item history. */
export function deriveEpicRetryCounters(stateInput: unknown, itemId: string): RetryAttemptCounters {
  return countersFromAttempts(validatedRetrySource(stateInput, itemId).attempts)
}

function transportRetryNotBefore(source: ValidatedRetrySource): string {
  const latest = source.attempts.at(-1)
  if (!latest || latest.status !== 'failed' || latest.failure_classification !== 'transport' || latest.completed_at === null) {
    throw new EpicValidationError('transport retry backoff requires a completed transport-failed attempt')
  }
  const transportAttemptCount = source.attempts.filter(attempt => attempt.failure_classification === 'transport').length
  const delay = transportBackoffDelayMs(source.policy, transportAttemptCount - 1)
  const notBefore = Date.parse(latest.completed_at) + delay
  if (!Number.isSafeInteger(notBefore)) throw new EpicValidationError('transport retry_not_before cannot be represented safely')
  try {
    return new Date(notBefore).toISOString()
  } catch {
    throw new EpicValidationError('transport retry_not_before is outside the supported timestamp range')
  }
}

export function calculateEpicTransportRetryNotBefore(stateInput: unknown, itemId: string): string {
  return transportRetryNotBefore(validatedRetrySource(stateInput, itemId))
}

/** Enforces class-specific ceilings before the generic frozen hard cap. */
export function assessEpicRetry(stateInput: unknown, itemId: string): EpicRetryDecision {
  const source = validatedRetrySource(stateInput, itemId)
  const { attempts, policy } = source
  const counters = countersFromAttempts(attempts)
  const latest = attempts.at(-1)
  if (!latest) return { retry: false, counters, reason: 'no_attempts' }
  if (latest.status === 'cancelled' || latest.failure_classification === 'cancelled') {
    return { retry: false, counters, reason: 'cancelled' }
  }
  if (latest.failure_classification === 'ambiguous_launch' || latest.launch_state === 'ambiguous') {
    return { retry: false, counters, reason: 'ambiguous_launch' }
  }
  if (latest.status === 'passed') return { retry: false, counters, reason: 'attempt_passed' }
  if (latest.status !== 'failed') return { retry: false, counters, reason: 'attempt_not_terminal' }
  if (latest.failure_classification === 'semantic' && counters.semantic_attempts >= policy.max_semantic_attempts) {
    return { retry: false, counters, reason: 'semantic_ceiling' }
  }
  if (latest.failure_classification === 'contract' && counters.contract_attempts >= policy.max_contract_attempts) {
    return { retry: false, counters, reason: 'contract_ceiling' }
  }
  if (latest.failure_classification === 'transport' && counters.transport_attempts >= policy.max_transport_attempts) {
    return { retry: false, counters, reason: 'transport_ceiling' }
  }
  if (counters.consecutive_no_progress_attempts >= policy.max_no_progress_attempts) {
    return { retry: false, counters, reason: 'no_progress_ceiling' }
  }
  if (attempts.length >= source.state.operational_limits.max_attempts_per_item) {
    return { retry: false, counters, reason: 'max_attempts_per_item' }
  }
  if (!['semantic', 'contract', 'transport'].includes(String(latest.failure_classification))) {
    return { retry: false, counters, reason: 'attempt_not_terminal' }
  }
  return {
    retry: true,
    counters,
    retry_not_before: latest.failure_classification === 'transport' ? transportRetryNotBefore(source) : null,
  }
}

export const deriveEpicRetryCounts = deriveEpicRetryCounters
export const epicTransportRetryNotBefore = calculateEpicTransportRetryNotBefore
