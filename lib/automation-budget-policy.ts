import {
  AccountingModeSchema,
  AutomationBudgetsSchema,
  CostEvidenceSchema,
  SelectedCostReportingCapabilitiesSchema,
  assertSafeNonNegativeInteger,
  finiteNonNegativeCost,
  safePositiveInteger,
  type AccountingMode,
  type AutomationBudgetsInput,
  type CostEvidence,
  type CostReportingCapability,
  type ResolvedAutomationLimits,
} from './automation-policy-contracts.ts'

export type CostBudgetDecision =
  | { decision: 'not_configured' }
  | { decision: 'blocked'; reason: 'unknown_cost' }
  | { decision: 'within_limit' }
  | { decision: 'exhausted' }

export type CostReportingPreflightDecision =
  | { decision: 'not_configured' }
  | { decision: 'allowed' }
  | { decision: 'blocked'; reason: 'unknown_cost' }

export function normalizeAutomationLimits(
  budgets: AutomationBudgetsInput | undefined,
): ResolvedAutomationLimits {
  const validated = AutomationBudgetsSchema.parse(budgets ?? {})
  return {
    max_sessions: validated.max_sessions ?? null,
    max_input_tokens: validated.max_input_tokens ?? null,
    max_output_tokens: validated.max_output_tokens ?? null,
    max_cost_usd: validated.max_cost_usd ?? null,
    max_active_time_ms: validated.max_active_time_ms ?? null,
    max_calendar_age_ms: validated.max_calendar_age_ms ?? null,
  }
}

export function hasConfiguredLimit(limit: number | null | undefined): limit is number {
  return limit !== null && limit !== undefined
}

export function isConfiguredIntegerLimitExceeded(
  usage: number,
  limit: number | null | undefined,
): boolean {
  assertSafeNonNegativeInteger(usage, 'usage')
  assertOptionalSafeNonNegativeInteger(limit, 'configured limit')
  return hasConfiguredLimit(limit) && usage > limit
}

export function wouldExceedConfiguredIntegerLimit(
  usage: number,
  additional_usage: number,
  limit: number | null | undefined,
): boolean {
  assertSafeNonNegativeInteger(usage, 'usage')
  assertSafeNonNegativeInteger(additional_usage, 'additional usage')
  assertOptionalSafeNonNegativeInteger(limit, 'configured limit')
  if (!hasConfiguredLimit(limit)) return false
  if (usage > limit) return true
  return additional_usage > limit - usage
}

export function evaluateCostBudget(
  limit: number | null | undefined,
  evidence: CostEvidence,
): CostBudgetDecision {
  const validated_evidence = CostEvidenceSchema.parse(evidence)
  if (!hasConfiguredLimit(limit)) return { decision: 'not_configured' }
  const validated_limit = finiteNonNegativeCost.parse(limit)
  if (validated_evidence.kind === 'unknown') {
    return { decision: 'blocked', reason: 'unknown_cost' }
  }
  return validated_evidence.cost_usd >= validated_limit
    ? { decision: 'exhausted' }
    : { decision: 'within_limit' }
}

export function evaluateCostReportingPreflight(
  accounting_mode: AccountingMode,
  limit: number | null | undefined,
  selected_candidate_capabilities: readonly CostReportingCapability[],
  max_selected_candidates: number,
): CostReportingPreflightDecision {
  const validated_accounting_mode = AccountingModeSchema.parse(accounting_mode)
  const validated_maximum = safePositiveInteger.parse(max_selected_candidates)
  if (!Array.isArray(selected_candidate_capabilities) || selected_candidate_capabilities.length === 0) {
    throw new Error('selected candidate capabilities must be a non-empty array')
  }
  if (selected_candidate_capabilities.length > validated_maximum) {
    throw new Error('selected candidate capabilities exceed the deployment safety ceiling')
  }
  const validated_capabilities = SelectedCostReportingCapabilitiesSchema.parse(selected_candidate_capabilities)

  const has_cost_limit = hasConfiguredLimit(limit)
  if (!has_cost_limit && validated_accounting_mode === 'telemetry_only') {
    return { decision: 'not_configured' }
  }
  if (has_cost_limit) finiteNonNegativeCost.parse(limit)

  if (!validated_capabilities.every(capability => capability.status === 'trustworthy')) {
    return { decision: 'blocked', reason: 'unknown_cost' }
  }
  return { decision: 'allowed' }
}

function assertOptionalSafeNonNegativeInteger(
  value: number | null | undefined,
  label: string,
): void {
  if (hasConfiguredLimit(value)) assertSafeNonNegativeInteger(value, label)
}
