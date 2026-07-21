import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'

import * as automationPolicy from '../../lib/automation-policy.ts'
import {
  AutomationPolicyInputSchema,
  AutomationUsageTelemetrySchema,
  CheckedAutomationPolicyInputSchema,
  CheckedResolvedAutomationPolicySchema,
  CheckedRetryPolicySchema,
  CostEvidenceSchema,
  CostReportingCapabilitySchema,
  FailureClassSchema,
  MAX_BOUNDED_IO_BYTES,
  ResolvedAutomationLimitsSchema,
  ResolvedAutomationPolicySchema,
  RetryAttemptCountersSchema,
  RetryPolicySchema,
  StructuralAutomationPolicyInputSchema,
  StructuralResolvedAutomationPolicySchema,
  StructuralRetryPolicySchema,
  assessRetrySafety,
  automationPolicyJsonSchema,
  evaluateCostBudget,
  evaluateCostReportingPreflight,
  hasConfiguredLimit,
  hasRetryAttemptsWithinSafetyCeiling,
  hasTransportBackoffWithinSafetyCeiling,
  hasValidTransportBackoffDelayRange,
  isConfiguredIntegerLimitExceeded,
  isFailureRetryable,
  normalizeAutomationLimits,
  retrySafetyCeilingViolations,
  retryPolicyJsonSchema,
  transportBackoffDelayMs,
  wouldExceedConfiguredIntegerLimit,
  type AutomationBudgetsInput,
  type AutomationUsageTelemetry,
  type RetryAttemptCounters,
  type RetryPolicy,
} from '../../lib/automation-policy.ts'
import {
  MAX_BOUNDED_IO_BYTES as CONFIG_MAX_BOUNDED_IO_BYTES,
  MAX_VALIDATION_RUNS_PER_WORKFLOW,
} from '../../lib/workflow-config.ts'
import {
  MAX_BOUNDED_IO_BYTES as LEAF_MAX_BOUNDED_IO_BYTES,
  MAX_VALIDATION_RUNS_PER_WORKFLOW as LEAF_MAX_VALIDATION_RUNS,
} from '../../lib/workflow-limits.mjs'

const RETRY_SCHEMA_ID = 'https://opencode-workflows.example/schema/retry-policy.schema.json'
const AUTOMATION_SCHEMA_ID = 'https://opencode-workflows.example/schema/automation-policy.schema.json'
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

const retryPolicy = (): RetryPolicy => ({
  max_semantic_attempts: 2,
  max_contract_attempts: 3,
  max_transport_attempts: 4,
  max_no_progress_attempts: 3,
  transport_backoff: {
    strategy: 'exponential',
    initial_delay_ms: 100,
    maximum_delay_ms: 1_000,
    multiplier: 2,
  },
})

const safety = () => ({
  max_parallel_sessions: 2,
  max_attempt_duration_ms: 30_000,
  max_selected_candidates: 2,
  max_retry_attempts_per_class: 4,
  max_consecutive_no_progress_attempts: 3,
  max_transport_backoff_delay_ms: 1_000,
  max_bounded_read_bytes: 1_024,
  max_bounded_write_bytes: 2_048,
})

const usageTelemetry = (): AutomationUsageTelemetry => ({
  sessions: 1,
  attempts: 2,
  input_tokens: 3,
  output_tokens: 4,
  bounded_read_bytes: 5,
  bounded_write_bytes: 6,
  validation_runs: 7,
  active_time_ms: 8,
  cost_evidence: { kind: 'known', cost_usd: 0 },
  active_interval_started_at: '2026-07-18T10:00:00.000Z',
  last_active_checkpoint_at: null,
})

type Validator = ((input: unknown) => boolean) & { errors?: unknown }
type AjvInstance = {
  addFormat(name: string, format: object): AjvInstance
  addSchema(schema: object): AjvInstance
  getSchema(reference: string): Validator | undefined
  compile(schema: object): Validator
}

function newAjv(): AjvInstance {
  const AjvConstructor = Ajv2020 as unknown as new (options: object) => AjvInstance
  return new AjvConstructor({ strict: true })
}

function readJsonSchema(filename: string): object {
  const schema_url = new URL(`../../schema/${filename}`, import.meta.url)
  return JSON.parse(fs.readFileSync(fileURLToPath(schema_url), 'utf8')) as object
}

function configuredAjv(): {
  ajv: AjvInstance
  validateAutomation: Validator
  validateRetry: Validator
  validateResolvedLimits: Validator
  validateResolvedPolicy: Validator
  validateUsage: Validator
  validateFailureClass: Validator
  validateRetryCounters: Validator
  validateCostReportingCapability: Validator
} {
  const ajv = newAjv()
  const iso_date_time = z.iso.datetime({ offset: true })
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => iso_date_time.safeParse(value).success,
  })
  ajv.addSchema(readJsonSchema('retry-policy.schema.json'))
  ajv.addSchema(readJsonSchema('automation-policy.schema.json'))
  const get = (reference: string): Validator => {
    const validator = ajv.getSchema(reference)
    assert.ok(validator, `schema validator must exist for ${reference}`)
    return validator
  }
  return {
    ajv,
    validateAutomation: get(AUTOMATION_SCHEMA_ID),
    validateRetry: get(RETRY_SCHEMA_ID),
    validateResolvedLimits: get(`${AUTOMATION_SCHEMA_ID}#/$defs/resolvedLimits`),
    validateResolvedPolicy: get(`${AUTOMATION_SCHEMA_ID}#/$defs/resolvedPolicy`),
    validateUsage: get(`${AUTOMATION_SCHEMA_ID}#/$defs/usageTelemetry`),
    validateFailureClass: get(`${AUTOMATION_SCHEMA_ID}#/$defs/failureClass`),
    validateRetryCounters: get(`${AUTOMATION_SCHEMA_ID}#/$defs/retryAttemptCounters`),
    validateCostReportingCapability: get(`${AUTOMATION_SCHEMA_ID}#/$defs/costReportingCapability`),
  }
}

describe('additive future automation policy contracts (no live config or engine adoption)', () => {
  it('keeps checked-in public schemas exactly aligned with generated structural contracts', () => {
    assert.deepEqual(readJsonSchema('retry-policy.schema.json'), retryPolicyJsonSchema())
    assert.deepEqual(readJsonSchema('automation-policy.schema.json'), automationPolicyJsonSchema())
  })

  it('accepts an empty optional input and exactly six independently optional budget dimensions', () => {
    const { validateAutomation } = configuredAjv()
    const dimensions: Required<AutomationBudgetsInput> = {
      max_sessions: 1,
      max_input_tokens: 2,
      max_output_tokens: 3,
      max_cost_usd: 4,
      max_active_time_ms: 5,
      max_calendar_age_ms: 6,
    }
    for (const input of [
      {},
      { budgets: {} },
      ...Object.entries(dimensions).map(([key, value]) => ({ budgets: { [key]: value } })),
    ]) {
      assert.equal(AutomationPolicyInputSchema.safeParse(input).success, true)
      assert.equal(validateAutomation(input), true)
    }
    assert.deepEqual(AutomationPolicyInputSchema.parse({}), {
      accounting: { mode: 'telemetry_only' },
    })
    assert.deepEqual(AutomationPolicyInputSchema.parse({ budgets: {} }), {
      accounting: { mode: 'telemetry_only' },
      budgets: {},
    })
    for (const legacy of ['max_wall_time_ms', 'max_validation_runs']) {
      const input = { budgets: { [legacy]: 1 } }
      assert.equal(AutomationPolicyInputSchema.safeParse(input).success, false)
      assert.equal(validateAutomation(input), false)
    }
  })

  it('normalizes omitted input limits to persisted null, rejects input null, and preserves zero', () => {
    const empty = {
      max_sessions: null,
      max_input_tokens: null,
      max_output_tokens: null,
      max_cost_usd: null,
      max_active_time_ms: null,
      max_calendar_age_ms: null,
    }
    assert.deepEqual(normalizeAutomationLimits(undefined), empty)
    assert.deepEqual(normalizeAutomationLimits({}), empty)
    assert.throws(() => normalizeAutomationLimits({ max_sessions: null } as unknown as AutomationBudgetsInput))
    assert.equal(AutomationPolicyInputSchema.safeParse({ budgets: { max_sessions: null } }).success, false)
    assert.equal(configuredAjv().validateAutomation({ budgets: { max_sessions: null } }), false)
    assert.equal(ResolvedAutomationLimitsSchema.safeParse(empty).success, true)
    assert.deepEqual(normalizeAutomationLimits({
      max_sessions: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_cost_usd: 0,
      max_active_time_ms: 0,
      max_calendar_age_ms: 0,
    }), {
      max_sessions: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_cost_usd: 0,
      max_active_time_ms: 0,
      max_calendar_age_ms: 0,
    })
  })

  it('keeps optional input, resolved policy, and usage telemetry as distinct strict contracts', () => {
    const { validateResolvedLimits, validateResolvedPolicy } = configuredAjv()
    const limits = normalizeAutomationLimits({ max_sessions: 1 })
    const resolved = {
      accounting: { mode: 'telemetry_only' },
      safety: safety(),
      limits,
      retry_policy: retryPolicy(),
    }
    assert.equal(ResolvedAutomationLimitsSchema.safeParse(limits).success, true)
    assert.equal(validateResolvedLimits(limits), true)
    assert.equal(ResolvedAutomationPolicySchema.safeParse(resolved).success, true)
    assert.equal(validateResolvedPolicy(resolved), true)
    assert.equal(ResolvedAutomationLimitsSchema.safeParse({ ...limits, max_validation_runs: null }).success, false)
    assert.equal(AutomationPolicyInputSchema.safeParse({ usage: usageTelemetry() }).success, false)
  })

  it('uses active-time telemetry names and leaves calendar age derived rather than mutable', () => {
    const { validateUsage } = configuredAjv()
    const telemetry = usageTelemetry()
    assert.equal(AutomationUsageTelemetrySchema.safeParse(telemetry).success, true)
    assert.equal(AutomationUsageTelemetrySchema.safeParse({ ...telemetry, calendar_age_ms: 1 }).success, false)
    assert.equal(AutomationUsageTelemetrySchema.safeParse({
      ...telemetry,
      active_interval_started_at: 'not-a-date',
    }).success, false)
    for (const timestamp of [
      '2026-07-18 10:00:00Z',
      '2026-07-18T10:00:00',
      `${'2'.repeat(65)}T10:00:00Z`,
    ]) {
      const malformed = { ...telemetry, active_interval_started_at: timestamp }
      assert.equal(AutomationUsageTelemetrySchema.safeParse(malformed).success, false, timestamp)
      assert.equal(validateUsage(malformed), false, timestamp)
    }
    assert.equal(AutomationUsageTelemetrySchema.safeParse({
      ...telemetry,
      last_active_checkpoint_at: '2026-07-18 10:00:00',
    }).success, false)
  })

  it('requires every usage field and rejects unknown usage fields in Zod and JSON Schema', () => {
    const { validateUsage } = configuredAjv()
    const telemetry = usageTelemetry()
    assert.equal(validateUsage(telemetry), true)
    for (const field of Object.keys(telemetry)) {
      const missing = { ...telemetry } as Record<string, unknown>
      delete missing[field]
      assert.equal(AutomationUsageTelemetrySchema.safeParse(missing).success, false, field)
      assert.equal(validateUsage(missing), false, field)
    }
    const unknown = { ...telemetry, created_at: '2026-07-18T10:00:00Z' }
    assert.equal(AutomationUsageTelemetrySchema.safeParse(unknown).success, false)
    assert.equal(validateUsage(unknown), false)
  })

  it('rejects unsafe integers across policy, retry, and usage contracts', () => {
    const { validateAutomation, validateRetry, validateUsage } = configuredAjv()
    const unsafe = MAX_SAFE_INTEGER + 1
    const policy = { budgets: { max_sessions: unsafe } }
    assert.equal(AutomationPolicyInputSchema.safeParse(policy).success, false)
    assert.equal(validateAutomation(policy), false)
    const retry = { ...retryPolicy(), max_transport_attempts: unsafe }
    assert.equal(RetryPolicySchema.safeParse(retry).success, false)
    assert.equal(validateRetry(retry), false)
    const usage = { ...usageTelemetry(), active_time_ms: unsafe }
    assert.equal(AutomationUsageTelemetrySchema.safeParse(usage).success, false)
    assert.equal(validateUsage(usage), false)
    const valid_counters: RetryAttemptCounters = {
      semantic_attempts: 0,
      contract_attempts: 0,
      transport_attempts: 0,
      consecutive_no_progress_attempts: 0,
    }
    assert.equal(RetryAttemptCountersSchema.safeParse({
      ...valid_counters,
      transport_attempts: unsafe,
    }).success, false)
  })

  it('compares integer limits without overflowing an addition', () => {
    assert.equal(hasConfiguredLimit(undefined), false)
    assert.equal(hasConfiguredLimit(null), false)
    assert.equal(hasConfiguredLimit(0), true)
    assert.equal(isConfiguredIntegerLimitExceeded(1, 0), true)
    assert.equal(isConfiguredIntegerLimitExceeded(1, null), false)
    assert.equal(wouldExceedConfiguredIntegerLimit(MAX_SAFE_INTEGER - 5, 5, MAX_SAFE_INTEGER), false)
    assert.equal(wouldExceedConfiguredIntegerLimit(MAX_SAFE_INTEGER - 5, 6, MAX_SAFE_INTEGER), true)
    assert.equal(wouldExceedConfiguredIntegerLimit(MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, null), false)
    assert.throws(() => wouldExceedConfiguredIntegerLimit(MAX_SAFE_INTEGER + 1, 0, MAX_SAFE_INTEGER), /safe/)
  })

  it('distinguishes cost evidence and fails closed when a configured cost has unknown evidence', () => {
    assert.deepEqual(CostEvidenceSchema.parse({ kind: 'known', cost_usd: 0 }), { kind: 'known', cost_usd: 0 })
    assert.deepEqual(evaluateCostBudget(null, { kind: 'unknown' }), { decision: 'not_configured' })
    assert.deepEqual(evaluateCostBudget(10, { kind: 'unknown' }), {
      decision: 'blocked',
      reason: 'unknown_cost',
    })
    assert.deepEqual(evaluateCostBudget(10, { kind: 'known', cost_usd: 9 }), { decision: 'within_limit' })
    assert.deepEqual(evaluateCostBudget(10, { kind: 'known', cost_usd: 10 }), { decision: 'exhausted' })
    assert.deepEqual(evaluateCostBudget(0, { kind: 'known', cost_usd: 0 }), { decision: 'exhausted' })
    assert.equal(CostEvidenceSchema.safeParse({ kind: 'unknown', cost_usd: 0 }).success, false)
    assert.throws(() => evaluateCostBudget(null, { kind: 'invalid' } as never))
  })

  it('preflights cost-reporting capability for every selected candidate without provider assumptions', () => {
    const { validateCostReportingCapability } = configuredAjv()
    const max_selected_candidates = safety().max_selected_candidates
    for (const capability of [
      { status: 'trustworthy' },
      { status: 'untrustworthy' },
      { status: 'unknown' },
    ] as const) {
      assert.equal(CostReportingCapabilitySchema.safeParse(capability).success, true)
      assert.equal(validateCostReportingCapability(capability), true)
    }
    assert.throws(() => evaluateCostReportingPreflight('telemetry_only', null, [
      { unused_without_a_cost_limit: true } as never,
    ], max_selected_candidates))
    assert.throws(() => evaluateCostReportingPreflight(
      'telemetry_only',
      null,
      new Array(1) as never,
      max_selected_candidates,
    ))
    assert.deepEqual(evaluateCostReportingPreflight(
      'telemetry_only',
      null,
      [{ status: 'unknown' }],
      max_selected_candidates,
    ), { decision: 'not_configured' })
    assert.deepEqual(evaluateCostReportingPreflight(
      'metered',
      null,
      [{ status: 'trustworthy' }],
      max_selected_candidates,
    ), { decision: 'allowed' })
    assert.deepEqual(evaluateCostReportingPreflight(
      'metered',
      null,
      [{ status: 'unknown' }],
      max_selected_candidates,
    ), { decision: 'blocked', reason: 'unknown_cost' })
    assert.throws(() => evaluateCostReportingPreflight(
      'metered',
      null,
      new Array(1) as never,
      max_selected_candidates,
    ))
    assert.throws(() => evaluateCostReportingPreflight(
      'metered',
      null,
      [{ status: 'invalid' } as never],
      max_selected_candidates,
    ))
    assert.throws(() => evaluateCostReportingPreflight('telemetry_only', null, [{ status: 'unknown' }], 0))
    assert.throws(
      () => evaluateCostReportingPreflight('telemetry_only', null, null as never, max_selected_candidates),
      /non-empty array/,
    )
    assert.throws(
      () => evaluateCostReportingPreflight('telemetry_only', null, [], max_selected_candidates),
      /non-empty/,
    )
    assert.throws(() => evaluateCostReportingPreflight('telemetry_only', null, [
      { status: 'trustworthy' },
      { status: 'trustworthy' },
      { status: 'trustworthy' },
    ], max_selected_candidates), /safety ceiling/)
    assert.deepEqual(evaluateCostReportingPreflight('telemetry_only', 0, [
      { status: 'trustworthy' },
      { status: 'trustworthy' },
    ], max_selected_candidates), { decision: 'allowed' })
    for (const status of ['unknown', 'untrustworthy'] as const) {
      assert.deepEqual(evaluateCostReportingPreflight('telemetry_only', 1, [
        { status: 'trustworthy' },
        { status },
      ], max_selected_candidates), { decision: 'blocked', reason: 'unknown_cost' })
    }
    assert.throws(() => evaluateCostReportingPreflight('telemetry_only', 1, [], max_selected_candidates), /non-empty/)
    assert.throws(() => evaluateCostReportingPreflight('telemetry_only', 1, [
      { status: 'trustworthy' },
      { status: 'trustworthy' },
      { status: 'trustworthy' },
    ], max_selected_candidates), /safety ceiling/)
    assert.equal(validateCostReportingCapability({ status: 'trustworthy', provider: 'hardcoded' }), false)
  })

  it('keeps structural JSON/Zod parity and points authoritative runtime schemas at checked retry semantics', () => {
    const { validateAutomation, validateRetry } = configuredAjv()
    const reversed = {
      ...retryPolicy(),
      transport_backoff: {
        ...retryPolicy().transport_backoff,
        initial_delay_ms: 1_001,
        maximum_delay_ms: 1_000,
      },
    }
    assert.equal(StructuralRetryPolicySchema.safeParse(reversed).success, true)
    assert.equal(validateRetry(reversed), true)
    assert.equal(hasValidTransportBackoffDelayRange(reversed.transport_backoff), false)
    assert.equal(CheckedRetryPolicySchema.safeParse(reversed).success, false)
    assert.equal(RetryPolicySchema.safeParse(reversed).success, false)
    const structural_input = { retry_policy: reversed }
    assert.equal(StructuralAutomationPolicyInputSchema.safeParse(structural_input).success, true)
    assert.equal(validateAutomation(structural_input), true)
    assert.equal(CheckedAutomationPolicyInputSchema.safeParse(structural_input).success, false)
    assert.equal(AutomationPolicyInputSchema.safeParse(structural_input).success, false)
    const structural_resolved = {
      accounting: { mode: 'metered' },
      safety: safety(),
      limits: normalizeAutomationLimits(undefined),
      retry_policy: reversed,
    }
    assert.equal(StructuralResolvedAutomationPolicySchema.safeParse(structural_resolved).success, true)
    assert.equal(configuredAjv().validateResolvedPolicy(structural_resolved), true)
    assert.equal(CheckedResolvedAutomationPolicySchema.safeParse(structural_resolved).success, false)
    assert.equal(ResolvedAutomationPolicySchema.safeParse(structural_resolved).success, false)
    assert.equal(StructuralRetryPolicySchema.safeParse({
      ...retryPolicy(),
      transport_backoff: { ...retryPolicy().transport_backoff, strategy: 'linear' },
    }).success, false)
    assert.deepEqual(
      [0, 1, 2, 3, 4].map(index => transportBackoffDelayMs(retryPolicy(), index)),
      [100, 200, 400, 800, 1_000],
    )
    const decimal_backoff = {
      ...retryPolicy(),
      transport_backoff: {
        strategy: 'exponential' as const,
        initial_delay_ms: 101,
        maximum_delay_ms: 300,
        multiplier: 1.5,
      },
    }
    assert.deepEqual(
      [0, 1, 2, 3].map(index => transportBackoffDelayMs(decimal_backoff, index)),
      [101, 152, 228, 300],
    )
  })

  it('keeps deployment safety authoritative and checks resolved retry resource ceilings at runtime', () => {
    const { validateAutomation, validateResolvedPolicy } = configuredAjv()
    const constrained_safety = {
      ...safety(),
      max_retry_attempts_per_class: 2,
      max_consecutive_no_progress_attempts: 2,
      max_transport_backoff_delay_ms: 50,
    }
    const over_deployment_ceilings = {
      accounting: { mode: 'telemetry_only' as const },
      safety: constrained_safety,
      limits: normalizeAutomationLimits(undefined),
      retry_policy: retryPolicy(),
    }
    assert.equal(StructuralResolvedAutomationPolicySchema.safeParse(over_deployment_ceilings).success, true)
    assert.equal(validateResolvedPolicy(over_deployment_ceilings), true)
    const checked = CheckedResolvedAutomationPolicySchema.safeParse(over_deployment_ceilings)
    assert.equal(checked.success, false)
    if (!checked.success) {
      const violations = retrySafetyCeilingViolations(retryPolicy(), constrained_safety)
      const assessment = assessRetrySafety(retryPolicy(), constrained_safety)
      assert.deepEqual(assessment, {
        violations,
        has_retry_attempts_within_safety_ceiling: false,
        has_transport_backoff_within_safety_ceiling: false,
      })
      assert.deepEqual(
        checked.error.issues.map(issue => issue.path.join('.')),
        [
          'retry_policy.max_contract_attempts',
          'retry_policy.max_transport_attempts',
          'retry_policy.max_no_progress_attempts',
          'retry_policy.transport_backoff.initial_delay_ms',
          'retry_policy.transport_backoff.maximum_delay_ms',
        ],
      )
      assert.deepEqual(
        checked.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
        violations.map(({ path, message }) => ({ path, message })),
      )
      assert.equal(hasRetryAttemptsWithinSafetyCeiling(retryPolicy(), constrained_safety), false)
      assert.equal(hasTransportBackoffWithinSafetyCeiling(retryPolicy(), constrained_safety), false)
      assert.equal(
        hasRetryAttemptsWithinSafetyCeiling(retryPolicy(), safety()),
        !retrySafetyCeilingViolations(retryPolicy(), safety())
          .some(violation => violation.kind === 'retry_attempts'),
      )
      assert.equal(
        hasTransportBackoffWithinSafetyCeiling(retryPolicy(), safety()),
        !retrySafetyCeilingViolations(retryPolicy(), safety())
          .some(violation => violation.kind === 'transport_backoff'),
      )
    }
    assert.equal(ResolvedAutomationPolicySchema.safeParse(over_deployment_ceilings).success, false)
    assert.equal(StructuralAutomationPolicyInputSchema.safeParse({ retry_policy: retryPolicy() }).success, true)
    assert.equal(validateAutomation({ retry_policy: retryPolicy() }), true)
    assert.equal(StructuralAutomationPolicyInputSchema.safeParse({ safety: safety() }).success, false)
    assert.equal(validateAutomation({ safety: safety() }), false)
    assert.equal(hasRetryAttemptsWithinSafetyCeiling(
      { ...retryPolicy(), max_transport_attempts: Number.NaN },
      safety(),
    ), false)
    assert.equal(hasTransportBackoffWithinSafetyCeiling(
      retryPolicy(),
      { ...safety(), max_transport_backoff_delay_ms: Number.NaN },
    ), false)
    const reversed_retry_policy = {
      ...retryPolicy(),
      transport_backoff: {
        ...retryPolicy().transport_backoff,
        initial_delay_ms: 900,
        maximum_delay_ms: 800,
      },
    }
    assert.equal(hasRetryAttemptsWithinSafetyCeiling(reversed_retry_policy, safety()), false)
    assert.equal(hasTransportBackoffWithinSafetyCeiling(reversed_retry_policy, safety()), false)
    assert.throws(() => assessRetrySafety(reversed_retry_policy, safety()))
    assert.throws(() => retrySafetyCeilingViolations(
      { ...retryPolicy(), max_transport_attempts: Number.NaN },
      safety(),
    ))
  })

  it('keeps failure classes and counters in Zod/Ajv parity and applies class and no-progress ceilings', () => {
    const { validateFailureClass, validateRetryCounters } = configuredAjv()
    const attempts: RetryAttemptCounters = {
      semantic_attempts: 2,
      contract_attempts: 1,
      transport_attempts: 3,
      consecutive_no_progress_attempts: 2,
    }
    for (const failure_class of ['transport', 'contract', 'semantic', 'ambiguous_launch', 'cancelled']) {
      assert.equal(FailureClassSchema.safeParse(failure_class).success, true)
      assert.equal(validateFailureClass(failure_class), true)
    }
    for (const invalid of ['timeout', '', null, 1]) {
      assert.equal(FailureClassSchema.safeParse(invalid).success, false)
      assert.equal(validateFailureClass(invalid), false)
    }
    assert.equal(RetryAttemptCountersSchema.safeParse(attempts).success, true)
    assert.equal(validateRetryCounters(attempts), true)
    for (const invalid of [
      { ...attempts, transport_attempts: -1 },
      { ...attempts, consecutive_no_progress_attempts: MAX_SAFE_INTEGER + 1 },
      { semantic_attempts: 0, contract_attempts: 0, transport_attempts: 0 },
      { ...attempts, unknown_attempts: 0 },
    ]) {
      assert.equal(RetryAttemptCountersSchema.safeParse(invalid).success, false)
      assert.equal(validateRetryCounters(invalid), false)
    }
    const retryable_class_fields = {
      transport: ['transport_attempts', 'max_transport_attempts'],
      contract: ['contract_attempts', 'max_contract_attempts'],
      semantic: ['semantic_attempts', 'max_semantic_attempts'],
    } as const
    for (const [failure_class, [attempt_field, maximum_field]] of Object.entries(retryable_class_fields)) {
      const maximum = retryPolicy()[maximum_field]
      assert.equal(isFailureRetryable(
        failure_class as keyof typeof retryable_class_fields,
        { ...attempts, [attempt_field]: maximum - 1 },
        retryPolicy(),
      ), true, `${failure_class} should retry below its mapped maximum`)
      assert.equal(isFailureRetryable(
        failure_class as keyof typeof retryable_class_fields,
        { ...attempts, [attempt_field]: maximum },
        retryPolicy(),
      ), false, `${failure_class} should stop at its mapped maximum`)
    }
    assert.equal(isFailureRetryable('ambiguous_launch', attempts, retryPolicy()), false)
    assert.equal(isFailureRetryable('cancelled', attempts, retryPolicy()), false)
    const at_breaker = { ...attempts, consecutive_no_progress_attempts: 3 }
    assert.equal(isFailureRetryable('transport', at_breaker, retryPolicy()), false)
    assert.equal(isFailureRetryable('contract', at_breaker, retryPolicy()), false)
    assert.equal(isFailureRetryable('ambiguous_launch', { ...attempts, consecutive_no_progress_attempts: 0 }, retryPolicy()), false)
    assert.equal(isFailureRetryable('cancelled', { ...attempts, consecutive_no_progress_attempts: 0 }, retryPolicy()), false)
    assert.throws(() => isFailureRetryable(
      'transport',
      { ...attempts, unrelated_attempts: 0 } as RetryAttemptCounters,
      retryPolicy(),
    ))
  })

  it('rejects strict unknown fields and resolves the external retry schema reference', () => {
    const { validateAutomation } = configuredAjv()
    for (const input of [
      { unknown: true },
      { accounting: { mode: 'metered', unknown: true } },
      { safety: { ...safety(), unknown: true } },
      { retry_policy: { ...retryPolicy(), unknown: true } },
    ]) {
      assert.equal(AutomationPolicyInputSchema.safeParse(input).success, false)
      assert.equal(validateAutomation(input), false)
    }
    const unregistered = newAjv()
    assert.throws(
      () => unregistered.compile(readJsonSchema('automation-policy.schema.json')),
      /can't resolve reference/,
    )
    assert.equal(validateAutomation({ retry_policy: retryPolicy() }), true)
  })

  it('keeps bounded I/O and validation limits under one cycle-free repository authority', async () => {
    const installer = await import(new URL('../../install.mjs', import.meta.url).href) as {
      MAX_BOUNDED_IO_BYTES: number
    }
    assert.equal(MAX_BOUNDED_IO_BYTES, LEAF_MAX_BOUNDED_IO_BYTES)
    assert.equal(CONFIG_MAX_BOUNDED_IO_BYTES, LEAF_MAX_BOUNDED_IO_BYTES)
    assert.equal(installer.MAX_BOUNDED_IO_BYTES, LEAF_MAX_BOUNDED_IO_BYTES)
    assert.equal(MAX_VALIDATION_RUNS_PER_WORKFLOW, LEAF_MAX_VALIDATION_RUNS)
    const automation_schema = readJsonSchema('automation-policy.schema.json') as {
      $defs: { safety: { properties: Record<string, { maximum: number }> } }
    }
    assert.equal(
      automation_schema.$defs.safety.properties.max_bounded_read_bytes.maximum,
      MAX_BOUNDED_IO_BYTES,
    )
    assert.equal(
      automation_schema.$defs.safety.properties.max_bounded_write_bytes.maximum,
      MAX_BOUNDED_IO_BYTES,
    )
  })

  it('retains the supported runtime surface through the automation-policy barrel', async () => {
    assert.deepEqual(Object.keys(automationPolicy).sort(), [
      'AccountingModeSchema',
      'AccountingSchema',
      'AutomationBudgetsSchema',
      'AutomationPolicyInputSchema',
      'AutomationSafetySchema',
      'AutomationUsageTelemetrySchema',
      'CheckedAutomationPolicyInputSchema',
      'CheckedResolvedAutomationPolicySchema',
      'CheckedRetryPolicySchema',
      'CostEvidenceSchema',
      'CostReportingCapabilitySchema',
      'FailureClassSchema',
      'MAX_BOUNDED_IO_BYTES',
      'ResolvedAutomationLimitsSchema',
      'ResolvedAutomationPolicySchema',
      'RetryAttemptCountersSchema',
      'RetryPolicySchema',
      'StructuralAutomationPolicyInputSchema',
      'StructuralResolvedAutomationPolicySchema',
      'StructuralRetryPolicySchema',
      'TransportBackoffSchema',
      'assessRetrySafety',
      'automationPolicyJsonSchema',
      'evaluateCostBudget',
      'evaluateCostReportingPreflight',
      'hasConfiguredLimit',
      'hasRetryAttemptsWithinSafetyCeiling',
      'hasTransportBackoffWithinSafetyCeiling',
      'hasValidTransportBackoffDelayRange',
      'isConfiguredIntegerLimitExceeded',
      'isFailureRetryable',
      'normalizeAutomationLimits',
      'retryPolicyJsonSchema',
      'retrySafetyCeilingViolations',
      'transportBackoffDelayMs',
      'wouldExceedConfiguredIntegerLimit',
    ])

    const contracts = await import('../../lib/automation-policy-contracts.ts')
    const budgets = await import('../../lib/automation-budget-policy.ts')
    const retries = await import('../../lib/automation-retry-policy.ts')
    const json_schema = await import('../../lib/automation-policy-json-schema.ts')
    assert.equal(automationPolicy.AutomationPolicyInputSchema, contracts.AutomationPolicyInputSchema)
    assert.equal(automationPolicy.evaluateCostBudget, budgets.evaluateCostBudget)
    assert.equal(automationPolicy.assessRetrySafety, retries.assessRetrySafety)
    assert.equal(automationPolicy.automationPolicyJsonSchema, json_schema.automationPolicyJsonSchema)
  })
})
