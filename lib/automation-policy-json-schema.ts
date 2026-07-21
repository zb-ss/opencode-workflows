import { z } from 'zod'

import {
  AUTOMATION_POLICY_SCHEMA_ID,
  RETRY_POLICY_SCHEMA_ID,
  AccountingSchema,
  AutomationBudgetsSchema,
  AutomationSafetySchema,
  AutomationUsageTelemetrySchema,
  CostEvidenceSchema,
  CostReportingCapabilitySchema,
  FailureClassSchema,
  ResolvedAutomationLimitsSchema,
  RetryAttemptCountersSchema,
  StructuralAutomationPolicyInputSchema,
  StructuralResolvedAutomationPolicySchema,
  StructuralRetryPolicySchema,
  finiteNonNegativeCost,
  nullableFiniteNonNegativeCost,
  nullableIsoDateTime,
  nullableSafeNonNegativeInteger,
  safeNonNegativeInteger,
  safePositiveInteger,
} from './automation-policy-contracts.ts'

function generatedJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>
}

function replaceSchemaReference(value: unknown, reference: string, replacement: string): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (record.$ref === reference) record.$ref = replacement
  for (const child of Object.values(record)) replaceSchemaReference(child, reference, replacement)
}

function inlineConstrainedReferenceSiblings(
  value: unknown,
  definitions: Record<string, Record<string, unknown>>,
): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const reference = typeof record.$ref === 'string' ? record.$ref : ''
  const definition_name = reference.startsWith('#/$defs/') ? reference.slice('#/$defs/'.length) : ''
  const has_constraint = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']
    .some(keyword => keyword in record)
  if (definition_name && has_constraint && definitions[definition_name]) {
    const siblings = { ...record }
    delete siblings.$ref
    for (const key of Object.keys(record)) delete record[key]
    Object.assign(record, definitions[definition_name], siblings)
  }
  for (const child of Object.values(record)) inlineConstrainedReferenceSiblings(child, definitions)
}

const AUTOMATION_POLICY_COMPONENT_SCHEMAS = {
  accounting: AccountingSchema,
  safety: AutomationSafetySchema,
  budgets: AutomationBudgetsSchema,
  resolvedLimits: ResolvedAutomationLimitsSchema,
  resolvedPolicy: StructuralResolvedAutomationPolicySchema,
  costEvidence: CostEvidenceSchema,
  costReportingCapability: CostReportingCapabilitySchema,
  failureClass: FailureClassSchema,
  retryAttemptCounters: RetryAttemptCountersSchema,
  usageTelemetry: AutomationUsageTelemetrySchema,
} satisfies Record<string, z.ZodType>

function generateAutomationPolicyBundle(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>()
  const registered_schemas = {
    ...AUTOMATION_POLICY_COMPONENT_SCHEMAS,
    retry: StructuralRetryPolicySchema,
    safePositiveInteger,
    safeNonNegativeInteger,
    nonNegativeCost: finiteNonNegativeCost,
    nullableSafeNonNegativeInteger,
    nullableNonNegativeCost: nullableFiniteNonNegativeCost,
    nullableTimestamp: nullableIsoDateTime,
  } satisfies Record<string, z.ZodType>
  for (const [id, schema] of Object.entries(registered_schemas)) registry.add(schema, { id })

  return z.toJSONSchema(z.object({
    automationPolicyInput: StructuralAutomationPolicyInputSchema,
    ...AUTOMATION_POLICY_COMPONENT_SCHEMAS,
  }), { target: 'draft-2020-12', metadata: registry }) as Record<string, unknown>
}

function rewriteExternalRetryPolicyReferences(
  generated: Record<string, unknown>,
  definitions: Record<string, Record<string, unknown>>,
): void {
  replaceSchemaReference(generated, '#/$defs/retry', RETRY_POLICY_SCHEMA_ID)
  replaceSchemaReference(definitions, '#/$defs/retry', RETRY_POLICY_SCHEMA_ID)
  delete definitions.retry
}

function annotateAutomationPolicyDefinitions(
  definitions: Record<string, Record<string, unknown>>,
): void {
  definitions.safety.description = 'Trusted deployment-resolved operational ceilings. This authority is not accepted from workflow policy input.'
  const safety_properties = definitions.safety.properties as Record<string, Record<string, unknown>>
  safety_properties.max_parallel_sessions.description = 'Trusted effective deployment ceiling for concurrent sessions.'
  safety_properties.max_attempt_duration_ms.description = "Trusted effective deployment ceiling for one attempt's duration."
  definitions.resolvedPolicy.description = 'Structural normalized policy with required trusted deployment-resolved safety. Authoritative runtime validation additionally enforces retry delay ordering and rejects retry attempts or transport delays above safety ceilings; structural JSON Schema cannot compare those properties.'
  definitions.costReportingCapability.description = 'Preflight capability evidence for one selected candidate, distinct from observed usage cost evidence.'
  definitions.nullableTimestamp.description = 'Structurally bounded RFC3339-like timestamp. The pattern is not calendar validation; authoritative state loading must retain semantic date-time validation.'
}

function makeDefaultedInputPropertyOptional(generated: Record<string, unknown>, property: string): void {
  const required = Array.isArray(generated.required)
    ? generated.required.filter(required_property => required_property !== property)
    : []
  if (required.length === 0) delete generated.required
  else generated.required = required
}

export function retryPolicyJsonSchema(): Record<string, unknown> {
  const generated = generatedJsonSchema(StructuralRetryPolicySchema)
  const properties = generated.properties as Record<string, Record<string, unknown>>
  properties.max_no_progress_attempts.description = 'Consecutive attempts permitted without progress before retries stop, independently of failure class.'
  properties.transport_backoff.description = 'Transport-only exponential backoff. Runtime validation additionally requires initial_delay_ms <= maximum_delay_ms.'
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: RETRY_POLICY_SCHEMA_ID,
    title: 'Automation Retry Policy',
    description: 'Additive future retry contract; it does not alter current workflow-engine behavior.',
    $comment: 'The semantic invariant initial_delay_ms <= maximum_delay_ms and resolved retry values against deployment-provided safety ceilings are intentionally checked at runtime, because standard JSON Schema cannot express those cross-property numeric comparisons.',
    ...generated,
  }
}

export function automationPolicyJsonSchema(): Record<string, unknown> {
  const bundle = generateAutomationPolicyBundle()
  const properties = bundle.properties as Record<string, Record<string, unknown>>
  const generated = properties.automationPolicyInput
  const definitions = bundle.$defs as Record<string, Record<string, unknown>>
  makeDefaultedInputPropertyOptional(generated, 'accounting')
  inlineConstrainedReferenceSiblings(definitions, definitions)
  rewriteExternalRetryPolicyReferences(generated, definitions)
  annotateAutomationPolicyDefinitions(definitions)

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: AUTOMATION_POLICY_SCHEMA_ID,
    title: 'Automation Policy Input',
    description: 'Structural additive future optional workflow policy/config input contract. Deployment-resolved safety authority is intentionally excluded. It does not alter current live configuration or workflow-engine behavior.',
    $comment: 'JSON Schema preserves structural parity. Authoritative runtime schemas layer cross-property semantic checks such as retry delay ordering and resolved retry values against trusted deployment safety ceilings.',
    ...generated,
    $defs: definitions,
  }
}
