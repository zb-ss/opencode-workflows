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
export const SAFE_IDENTIFIER_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]*$'
export const SAFE_IDENTIFIER_PATTERN = new RegExp(SAFE_IDENTIFIER_SOURCE)
export const MAX_SAFE_IDENTIFIER_LENGTH = 64
export const MAX_BOUNDED_IO_BYTES = 16 * 1024 * 1024
export const MAX_VALIDATION_TIMEOUT_MS = 60 * 60 * 1000
export const MAX_VALIDATION_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_VALIDATION_RUNS_PER_WORKFLOW = 100
export const MAX_VALIDATION_STRING_LENGTH = 1024
export const MAX_REVIEW_ITERATIONS = 10
export const MAX_REVIEW_RESULT_BYTES = 1024 * 1024

const SafeIdentifierSchema = z.string().min(1).max(MAX_SAFE_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER_PATTERN)

export const ModelCandidateSchema = z.union([
  z.string().regex(MODEL_ID_PATTERN),
  z.object({
    model: z.string().regex(MODEL_ID_PATTERN),
    variant: z.string().regex(VARIANT_PATTERN).optional(),
  }).strict(),
])

const CapabilityModeSchema = z.enum(['disabled', 'auto', 'required'])

const SwarmConfigSchema = z.object({
  default_concurrency: z.number().int().positive().optional(),
  stale_timeout_ms: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  progress_timeout_ms: z.number().int().positive().optional(),
  provider_concurrency: z.record(z.string(), z.number().int().positive()).optional(),
}).strict().default({})

export const ValidationOperationSchema = z.object({
  argv: z.array(z.string().min(1).max(MAX_VALIDATION_STRING_LENGTH)).min(1).max(64),
  working_directory: z.string().min(1).max(MAX_VALIDATION_STRING_LENGTH),
  permission_pattern: z.string().min(1).max(MAX_VALIDATION_STRING_LENGTH),
  environment: z.array(z.string().max(MAX_VALIDATION_STRING_LENGTH).regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
  timeout_ms: z.number().int().positive().max(MAX_VALIDATION_TIMEOUT_MS),
  max_output_bytes: z.number().int().positive().max(MAX_VALIDATION_OUTPUT_BYTES),
  success_exit_codes: z.array(z.number().int().min(0).max(255)).min(1).max(16),
}).strict().superRefine((operation, context) => {
  if (!path.isAbsolute(operation.argv[0])) {
    context.addIssue({
      code: 'custom',
      path: ['argv', 0],
      message: 'validation executable must be an operator-configured absolute path',
    })
  }
  if (path.posix.isAbsolute(operation.working_directory) || path.win32.isAbsolute(operation.working_directory)) {
    context.addIssue({
      code: 'custom',
      path: ['working_directory'],
      message: 'validation working_directory must be relative to the workflow worktree',
    })
  }
  if (operation.argv.some((argument) => argument.includes('\0'))
    || operation.working_directory.includes('\0')
    || operation.permission_pattern.includes('\0')) {
    context.addIssue({ code: 'custom', path: [], message: 'validation operation strings must not contain null bytes' })
  }
  if (new Set(operation.environment).size !== operation.environment.length) {
    context.addIssue({ code: 'custom', path: ['environment'], message: 'validation environment names must be unique' })
  }
  if (new Set(operation.success_exit_codes).size !== operation.success_exit_codes.length) {
    context.addIssue({
      code: 'custom',
      path: ['success_exit_codes'],
      message: 'validation success_exit_codes must be unique',
    })
  }
})

export const ReviewLoopReviewerSchema = z.object({
  id: SafeIdentifierSchema,
  agent: SafeIdentifierSchema,
  always: z.boolean(),
  risk_tags: z.array(SafeIdentifierSchema).max(32),
  focus: z.string().min(1).max(4000),
}).strict().superRefine((reviewer, context) => {
  if (new Set(reviewer.risk_tags).size !== reviewer.risk_tags.length) {
    context.addIssue({ code: 'custom', path: ['risk_tags'], message: 'reviewer risk_tags must be unique' })
  }
  if (!reviewer.always && reviewer.risk_tags.length === 0) {
    context.addIssue({ code: 'custom', path: ['risk_tags'], message: 'a conditional reviewer requires at least one risk tag' })
  }
})

const ValidationBrokerSchema = z.object({
  enabled: z.boolean().default(false),
  max_runs_per_workflow: z.number().int().positive().max(MAX_VALIDATION_RUNS_PER_WORKFLOW).optional(),
  operations: z.record(SafeIdentifierSchema, ValidationOperationSchema).default({}),
}).strict().superRefine((broker, context) => {
  if (!broker.enabled) return
  if (broker.max_runs_per_workflow === undefined) {
    context.addIssue({ code: 'custom', path: ['max_runs_per_workflow'], message: 'max_runs_per_workflow is required when validation_broker is enabled' })
  }
  if (Object.keys(broker.operations).length === 0) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'at least one operation is required when validation_broker is enabled' })
  }
}).default({ enabled: false, operations: {} })

export type ValidationBrokerConfig = z.infer<typeof ValidationBrokerSchema>
export type EnabledValidationBrokerConfig = ValidationBrokerConfig & {
  enabled: true
  max_runs_per_workflow: number
}

export function enabledValidationBroker(config: ValidationBrokerConfig): EnabledValidationBrokerConfig {
  if (!config.enabled || config.max_runs_per_workflow === undefined) {
    throw new Error('validation broker requires a complete enabled configuration')
  }
  return config as EnabledValidationBrokerConfig
}

const ReviewLoopSchema = z.object({
  enabled: z.boolean().default(false),
  max_iterations: z.number().int().positive().max(MAX_REVIEW_ITERATIONS).optional(),
  batch_timeout_ms: z.number().int().positive().max(MAX_VALIDATION_TIMEOUT_MS).optional(),
  max_result_bytes: z.number().int().positive().max(MAX_REVIEW_RESULT_BYTES).optional(),
  correction_agent: SafeIdentifierSchema.optional(),
  correction_focus: z.string().min(1).max(4000).optional(),
  reviewers: z.array(ReviewLoopReviewerSchema).max(16).default([]),
}).strict().superRefine((loop, context) => {
  const ids = new Set<string>()
  loop.reviewers.forEach((reviewer, index) => {
    if (ids.has(reviewer.id)) {
      context.addIssue({ code: 'custom', path: ['reviewers', index, 'id'], message: `duplicate reviewer ID: ${reviewer.id}` })
    }
    ids.add(reviewer.id)
  })
  if (!loop.enabled) return
  for (const field of [
    'max_iterations',
    'batch_timeout_ms',
    'max_result_bytes',
    'correction_agent',
    'correction_focus',
  ] as const) {
    if (loop[field] === undefined) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} is required when review_loop is enabled` })
    }
  }
  if (loop.reviewers.length === 0) {
    context.addIssue({ code: 'custom', path: ['reviewers'], message: 'at least one reviewer is required when review_loop is enabled' })
  }
  if (!loop.reviewers.some((reviewer) => reviewer.always)) {
    context.addIssue({ code: 'custom', path: ['reviewers'], message: 'at least one reviewer must always run' })
  }
}).default({ enabled: false, reviewers: [] })

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
  swarm_config: SwarmConfigSchema,
  validation_broker: ValidationBrokerSchema,
  review_loop: ReviewLoopSchema,
  automation: z.object({
    enabled: z.boolean().default(false),
    autonomy: z.enum(['interactive', 'bounded']).default('interactive'),
    max_parallel_sessions: z.number().int().positive().optional(),
    max_sessions: z.number().int().positive().optional(),
    max_attempts_per_stage: z.number().int().positive().optional(),
    max_wall_time_ms: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    max_bounded_read_bytes: z.number().int().nonnegative().max(MAX_BOUNDED_IO_BYTES).optional(),
    max_bounded_write_bytes: z.number().int().nonnegative().max(MAX_BOUNDED_IO_BYTES).optional(),
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
      'max_bounded_read_bytes',
      'max_bounded_write_bytes',
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
  }).default({ enabled: false, autonomy: 'interactive' }),
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
