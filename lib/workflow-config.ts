import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  normalizeModelCandidate,
  uniqueModelCandidates,
  type ConfiguredModelCandidate,
  type ModelCandidate,
} from './model-registry.ts'
import { getConfigDir } from './paths.ts'

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const ModelCandidateSchema = z.union([
  z.string().regex(MODEL_ID_PATTERN),
  z.object({
    model: z.string().regex(MODEL_ID_PATTERN),
    variant: z.string().regex(VARIANT_PATTERN).optional(),
  }).strict(),
])

const CapabilityModeSchema = z.enum(['disabled', 'auto', 'required'])

export const WorkflowConfigSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  default_mode: z.string().default('standard'),
  model_tiers: z.object({
    low: z.array(ModelCandidateSchema).default([]),
    mid: z.array(ModelCandidateSchema).default([]),
    high: z.array(ModelCandidateSchema).default([]),
  }).default({ low: [], mid: [], high: [] }),
  agent_models: z.record(
    z.string(),
    z.union([ModelCandidateSchema, z.array(ModelCandidateSchema)]),
  ).default({}),
  fallback_order: z.array(ModelCandidateSchema).default([]),
  agent_variants: z.record(z.string(), z.string().regex(VARIANT_PATTERN)).default({}),
  swarm_config: z.record(z.string(), z.unknown()).default({}),
  automation: z.object({
    enabled: z.boolean().default(false),
    max_parallel_sessions: z.number().int().positive().optional(),
    max_sessions: z.number().int().positive().optional(),
    max_attempts_per_stage: z.number().int().positive().optional(),
    max_wall_time_ms: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    max_cost_usd: z.number().nonnegative().nullable().optional(),
  }).superRefine((automation, context) => {
    if (!automation.enabled) return
    for (const field of [
      'max_parallel_sessions',
      'max_sessions',
      'max_attempts_per_stage',
      'max_wall_time_ms',
      'max_input_tokens',
      'max_output_tokens',
      'max_cost_usd',
    ] as const) {
      if (automation[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required when automation is enabled`,
        })
      }
    }
  }).default({ enabled: false }),
  experimental_capabilities: z.object({
    background_subagents: CapabilityModeSchema.default('disabled'),
    native_workspaces: CapabilityModeSchema.default('disabled'),
    plugin_v2: CapabilityModeSchema.default('disabled'),
    mcp_code_mode: CapabilityModeSchema.default('disabled'),
    references: CapabilityModeSchema.default('disabled'),
  }).default({
    background_subagents: 'disabled',
    native_workspaces: 'disabled',
    plugin_v2: 'disabled',
    mcp_code_mode: 'disabled',
    references: 'disabled',
  }),
}).passthrough()

export type RawWorkflowConfig = z.input<typeof WorkflowConfigSchema>
export type WorkflowConfig = z.output<typeof WorkflowConfigSchema>
export type { ConfiguredModelCandidate, ModelCandidate }

export function loadWorkflowConfig(configDir = getConfigDir()): WorkflowConfig {
  const filePath = path.join(configDir, 'workflows.json')
  if (!fs.existsSync(filePath)) return WorkflowConfigSchema.parse({})
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return WorkflowConfigSchema.parse(stripDocumentationKeys(parsed))
}

export function modelCandidatesForAgent(
  config: WorkflowConfig,
  agent: string,
  tier: 'low' | 'mid' | 'high',
): ModelCandidate[] {
  const override = config.agent_models[agent]
  const primary = override === undefined
    ? config.model_tiers[tier]
    : Array.isArray(override) ? override : [override]
  const agentVariant = config.agent_variants[agent]
  const candidates = [...primary, ...config.fallback_order]
    .map(normalizeModelCandidate)
    .map((candidate) => agentVariant && !candidate.variant
      ? { ...candidate, variant: agentVariant }
      : candidate)
  return uniqueModelCandidates(candidates)
}

function stripDocumentationKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDocumentationKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, child]) => [key, stripDocumentationKeys(child)]),
  )
}
