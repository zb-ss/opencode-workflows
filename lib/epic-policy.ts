import { z } from 'zod'

import { safePositiveInteger } from './automation-policy-contracts.ts'

/** Hard protocol ceilings. Enabled deployments must select lower effective limits explicitly. */
export const MAX_EPIC_ITEMS = 256
export const MAX_ITEM_DEPENDENCIES = 64
export const MAX_ATTEMPTS_PER_ITEM = 32
export const MAX_EPIC_BUDGET_RECORDS = 4096
export const MAX_EPIC_REVISIONS = 10_000
export const MAX_EPIC_CHAIN_BYTES = 256 * 1024 * 1024

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

const EnabledEpicConfigSchema = z.object({
  enabled: z.literal(true),
  max_epic_items: EpicOperationalLimitsSchema.shape.max_epic_items,
  max_item_dependencies: EpicOperationalLimitsSchema.shape.max_item_dependencies,
  max_attempts_per_item: EpicOperationalLimitsSchema.shape.max_attempts_per_item,
  max_budget_records: EpicOperationalLimitsSchema.shape.max_budget_records,
}).strict()

export const EpicConfigSchema = z.discriminatedUnion('enabled', [
  DisabledEpicConfigSchema,
  EnabledEpicConfigSchema,
]).default({ enabled: false })

export type EpicOperationalLimits = z.infer<typeof EpicOperationalLimitsSchema>
export type EpicConfig = z.infer<typeof EpicConfigSchema>
export type EnabledEpicConfig = z.infer<typeof EnabledEpicConfigSchema>

export function parseEpicConfig(input: unknown): EpicConfig {
  const parsed = EpicConfigSchema.safeParse(input)
  if (!parsed.success) throw new Error(`invalid epic configuration: ${parsed.error.message}`)
  return parsed.data
}

export function enabledEpic(config: EpicConfig): EnabledEpicConfig {
  if (!config.enabled) throw new Error('epic requires a complete enabled configuration')
  return config
}
