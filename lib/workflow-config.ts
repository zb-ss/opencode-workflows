import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  normalizeModelCandidate,
  uniqueModelCandidates,
  type ConfiguredModelCandidate,
  type ModelCandidate,
} from './model-registry.ts'
import { EpicConfigSchema } from './epic-policy.ts'
import { QueueConfigSchema } from './queue-policy.ts'
import { getConfigDir } from './paths.ts'
import {
  MAX_BOUNDED_IO_BYTES,
  MAX_VALIDATION_RUNS_PER_WORKFLOW,
} from './workflow-limits.mjs'
import {
  MAX_PUBLICATION_MARKER_LITERAL_LENGTH as MARKER_LITERAL_LENGTH_LIMIT,
  publicationMarkerIssues,
} from './publication-marker-policy.mjs'
import {
  isAbsolutePublicationPath,
  isFullPublicationGitRef,
  isPublicationEnvironmentAllowlist,
  isPublicationPublisherArgv,
  isPublicationSourceBranchRef,
  isPublicationSuccessExitCodes,
  isWorktreeRelativePublicationPath,
  MAX_PUBLICATION_ENVIRONMENT_NAMES,
  MAX_PUBLICATION_PROTOCOL_STRING_LENGTH,
  MAX_PUBLICATION_REMOTE_URL_LENGTH,
  normalizePublicationRemoteUrl,
  PUBLICATION_ENVIRONMENT_NAME_PATTERN,
  PUBLICATION_REQUEST_FILE_ARGUMENT,
} from './publication-policy.ts'
import {
  MAX_SAFE_IDENTIFIER_LENGTH,
  SAFE_IDENTIFIER_PATTERN,
  SAFE_IDENTIFIER_SOURCE,
  SafeIdentifierSchema,
} from './safe-identifier.ts'

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export { MAX_SAFE_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_PATTERN, SAFE_IDENTIFIER_SOURCE }
export const MAX_VALIDATION_TIMEOUT_MS = 60 * 60 * 1000
export const MAX_VALIDATION_OUTPUT_BYTES = 16 * 1024 * 1024
export { MAX_BOUNDED_IO_BYTES, MAX_VALIDATION_RUNS_PER_WORKFLOW }
export const MAX_VALIDATION_STRING_LENGTH = 1024
export const MAX_REVIEW_ITERATIONS = 10
export const MAX_REVIEW_RESULT_BYTES = 1024 * 1024
export const MAX_PUBLICATION_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_PUBLICATION_ARTIFACTS_PER_WORKFLOW = 100
export const MAX_PUBLICATION_COMMITS = 10_000
export const MAX_PUBLICATION_OBJECTS = 100_000
export const MAX_PUBLICATION_BLOB_BYTES = 16 * 1024 * 1024
export const MAX_PUBLICATION_TOTAL_SCAN_BYTES = 256 * 1024 * 1024
export const MAX_PUBLICATION_FINDINGS = 1_000
export const MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS = 10_000
export const MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS = 60_000
export const MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS = 60_000
export const MAX_PUBLICATION_MARKER_LITERAL_LENGTH = MARKER_LITERAL_LENGTH_LIMIT
export const MAX_PUBLICATION_DISPLAY_NAME_LENGTH = 200
export const MAX_PUBLICATION_STRING_LENGTH = MAX_PUBLICATION_PROTOCOL_STRING_LENGTH
export { MAX_PUBLICATION_REMOTE_URL_LENGTH }
export const MAX_PUBLICATION_TIMEOUT_MS = 60 * 60 * 1000
export const MAX_PUBLICATION_OUTPUT_BYTES = 16 * 1024 * 1024

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

export function validationOperationNames(config: ValidationBrokerConfig): string[] {
  if (!config.enabled) return []
  return Object.keys(enabledValidationBroker(config).operations).sort()
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

const PublicationMarkerSchema = z.object({
  id: SafeIdentifierSchema,
  literal: z.string().min(2).max(MAX_PUBLICATION_MARKER_LITERAL_LENGTH).refine(
    (literal) => !literal.includes('\0'),
    { message: 'publication marker literals must not contain null bytes' },
  ),
  case_sensitive: z.boolean(),
}).strict()

const PublicationGitRefSchema = z.string().min(1).max(MAX_PUBLICATION_STRING_LENGTH).refine(
  isFullPublicationGitRef,
  { message: 'publication refs must be valid full Git refs beginning with refs/' },
)

const PublicationSourceGitRefSchema = PublicationGitRefSchema.refine(
  isPublicationSourceBranchRef,
  { message: 'publication source refs must be full branch refs beginning with refs/heads/' },
)

const PublicationExecutableSchema = z.string().min(1).max(MAX_PUBLICATION_STRING_LENGTH)
  .refine((value) => !value.includes('\0'), { message: 'publication executables must not contain null bytes' })
  .refine(isAbsolutePublicationPath, { message: 'publication executables must be absolute paths' })

const PublicationArgumentSchema = z.string().min(1).max(MAX_PUBLICATION_STRING_LENGTH).refine(
  (argument) => !argument.includes('\0'),
  { message: 'publication argv must not contain null bytes' },
)

const PublicationPublisherFields = {
  argv: z.array(PublicationArgumentSchema).length(2),
  working_directory: z.string().min(1).max(MAX_PUBLICATION_STRING_LENGTH).refine(
    (value) => !value.includes('\0'),
    { message: 'publication working_directory must not contain null bytes' },
  ).refine(
    isWorktreeRelativePublicationPath,
    { message: 'publication working_directory must remain relative to the workflow worktree' },
  ),
  environment: z.array(z.string().regex(PUBLICATION_ENVIRONMENT_NAME_PATTERN))
    .max(MAX_PUBLICATION_ENVIRONMENT_NAMES),
  timeout_ms: z.number().int().positive().max(MAX_PUBLICATION_TIMEOUT_MS),
  max_output_bytes: z.number().int().positive().max(MAX_PUBLICATION_OUTPUT_BYTES),
  success_exit_codes: z.array(z.literal(0)).length(1),
}

function validatePublicationPublisher(
  publisher: { argv?: readonly string[]; environment?: readonly string[]; success_exit_codes?: readonly number[] },
  context: z.core.$RefinementCtx,
): void {
  if (publisher.argv !== undefined && !isPublicationPublisherArgv(publisher.argv)) {
    context.addIssue({
      code: 'custom',
      path: ['argv'],
      message: `publication argv must be exactly [absolute executable, ${PUBLICATION_REQUEST_FILE_ARGUMENT}]`,
    })
  }
  if (publisher.environment !== undefined && !isPublicationEnvironmentAllowlist(publisher.environment)) {
    context.addIssue({
      code: 'custom',
      path: ['environment'],
      message: 'publication environment must contain unique safe names without loader or interpreter controls',
    })
  }
  if (publisher.success_exit_codes !== undefined && !isPublicationSuccessExitCodes(publisher.success_exit_codes)) {
    context.addIssue({
      code: 'custom',
      path: ['success_exit_codes'],
      message: 'publication success_exit_codes must be exactly [0]',
    })
  }
}

const PublicationPublisherSchema = z.object({
  argv: PublicationPublisherFields.argv.optional(),
  working_directory: PublicationPublisherFields.working_directory.optional(),
  environment: PublicationPublisherFields.environment.optional(),
  timeout_ms: PublicationPublisherFields.timeout_ms.optional(),
  max_output_bytes: PublicationPublisherFields.max_output_bytes.optional(),
  success_exit_codes: PublicationPublisherFields.success_exit_codes.optional(),
}).strict().superRefine(validatePublicationPublisher)

const CompletePublicationPublisherSchema = z.object(PublicationPublisherFields)
  .strict()
  .superRefine(validatePublicationPublisher)

const PublicationTargetFields = {
  display_name: z.string().min(1).max(MAX_PUBLICATION_DISPLAY_NAME_LENGTH).refine(
    (value) => !value.includes('\0'),
    { message: 'publication display_name must not contain null bytes' },
  ),
  git_executable: PublicationExecutableSchema,
  base_ref: PublicationSourceGitRefSchema,
  head_ref: PublicationSourceGitRefSchema,
  remote: SafeIdentifierSchema,
  expected_remote_url: z.string().min(1).max(MAX_PUBLICATION_REMOTE_URL_LENGTH).refine(
    (value) => !value.includes('\0'),
    { message: 'publication expected_remote_url must not contain null bytes' },
  ).refine(
    (value) => normalizePublicationRemoteUrl(value) !== null,
    { message: 'publication expected_remote_url must be an absolute HTTPS or SSH URL without credentials, query, or fragment' },
  ),
  destination_ref: PublicationGitRefSchema,
  protection: z.enum(['deny', 'approval_required', 'unprotected']),
}

const PublicationTargetSchema = z.object({
  display_name: PublicationTargetFields.display_name.optional(),
  git_executable: PublicationTargetFields.git_executable.optional(),
  base_ref: PublicationTargetFields.base_ref.optional(),
  head_ref: PublicationTargetFields.head_ref.optional(),
  remote: PublicationTargetFields.remote.optional(),
  expected_remote_url: PublicationTargetFields.expected_remote_url.optional(),
  destination_ref: PublicationTargetFields.destination_ref.optional(),
  protection: PublicationTargetFields.protection.optional(),
  publisher: PublicationPublisherSchema.optional(),
}).strict()

const CompletePublicationTargetSchema = z.object({
  ...PublicationTargetFields,
  publisher: CompletePublicationPublisherSchema,
}).strict()

function validatePublicationMarkers(
  markers: readonly z.infer<typeof PublicationMarkerSchema>[],
  context: z.core.$RefinementCtx,
  requireNonEmpty = false,
): void {
  for (const issue of publicationMarkerIssues(markers, { requireNonEmpty })) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
  }
}

const PublicationLimitSchemas = {
  artifact_ttl_ms: z.number().int().positive().max(MAX_PUBLICATION_ARTIFACT_TTL_MS),
  git_timeout_ms: z.number().int().positive().max(MAX_PUBLICATION_TIMEOUT_MS),
  max_artifacts_per_workflow: z.number().int().positive().max(MAX_PUBLICATION_ARTIFACTS_PER_WORKFLOW),
  max_commits: z.number().int().positive().max(MAX_PUBLICATION_COMMITS),
  max_objects: z.number().int().positive().max(MAX_PUBLICATION_OBJECTS),
  max_blob_bytes: z.number().int().positive().max(MAX_PUBLICATION_BLOB_BYTES),
  max_total_scan_bytes: z.number().int().positive().max(MAX_PUBLICATION_TOTAL_SCAN_BYTES),
  max_findings: z.number().int().positive().max(MAX_PUBLICATION_FINDINGS),
  record_settle_attempts: z.number().int().positive().max(MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS),
  record_settle_delay_ms: z.number().int().positive().max(MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS),
  record_settle_timeout_ms: z.number().int().positive().max(MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS),
}

const PublicationMarkersSchema = z.array(PublicationMarkerSchema)
  .superRefine(validatePublicationMarkers)
const RequiredPublicationMarkersSchema = z.array(PublicationMarkerSchema)
  .superRefine((markers, context) => validatePublicationMarkers(markers, context, true))

const DisabledPublicationConfigSchema = z.object({
  enabled: z.literal(false),
  artifact_ttl_ms: PublicationLimitSchemas.artifact_ttl_ms.optional(),
  git_timeout_ms: PublicationLimitSchemas.git_timeout_ms.optional(),
  max_artifacts_per_workflow: PublicationLimitSchemas.max_artifacts_per_workflow.optional(),
  max_commits: PublicationLimitSchemas.max_commits.optional(),
  max_objects: PublicationLimitSchemas.max_objects.optional(),
  max_blob_bytes: PublicationLimitSchemas.max_blob_bytes.optional(),
  max_total_scan_bytes: PublicationLimitSchemas.max_total_scan_bytes.optional(),
  max_findings: PublicationLimitSchemas.max_findings.optional(),
  record_settle_attempts: PublicationLimitSchemas.record_settle_attempts.optional(),
  record_settle_delay_ms: PublicationLimitSchemas.record_settle_delay_ms.optional(),
  record_settle_timeout_ms: PublicationLimitSchemas.record_settle_timeout_ms.optional(),
  internal_markers: PublicationMarkersSchema.default([]),
  targets: z.record(SafeIdentifierSchema, PublicationTargetSchema).default({}),
}).strict()

const EnabledPublicationConfigSchema = z.object({
  enabled: z.literal(true),
  ...PublicationLimitSchemas,
  internal_markers: RequiredPublicationMarkersSchema,
  targets: z.record(SafeIdentifierSchema, CompletePublicationTargetSchema).refine(
    targets => Object.keys(targets).length > 0,
    { message: 'at least one target is required when publication is enabled' },
  ),
}).strict()

const PublicationConfigSchema = z.preprocess(
  (value) => value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'enabled')
    ? { ...value, enabled: false }
    : value,
  z.discriminatedUnion('enabled', [DisabledPublicationConfigSchema, EnabledPublicationConfigSchema]),
).default({ enabled: false, internal_markers: [], targets: {} })

export type PublicationConfig = z.infer<typeof PublicationConfigSchema>
export type EnabledPublicationConfig = z.infer<typeof EnabledPublicationConfigSchema>

export function enabledPublication(config: PublicationConfig): EnabledPublicationConfig {
  const result = PublicationConfigSchema.safeParse(config)
  if (!result.success || !result.data.enabled) {
    throw new Error('publication requires a complete enabled configuration')
  }
  return result.data
}

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
  publication: PublicationConfigSchema,
  epic: EpicConfigSchema,
  queue: QueueConfigSchema,
  automation: z.object({
    enabled: z.boolean().default(false),
    autonomy: z.enum(['interactive', 'bounded']).default('interactive'),
    max_parallel_sessions: z.number().int().positive().optional(),
    max_sessions: z.number().int().positive().optional(),
    max_attempts_per_stage: z.number().int().positive().optional(),
    max_active_time_ms: z.number().int().positive().optional(),
    max_calendar_age_ms: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    max_bounded_read_bytes: z.number().int().nonnegative().max(MAX_BOUNDED_IO_BYTES).optional(),
    max_bounded_write_bytes: z.number().int().nonnegative().max(MAX_BOUNDED_IO_BYTES).optional(),
    max_cost_usd: z.number().nonnegative().nullable().optional(),
  }).superRefine((automation, context) => {
    if (!automation.enabled) return
    if (automation.max_parallel_sessions === undefined) {
      context.addIssue({ code: 'custom', path: ['max_parallel_sessions'], message: 'max_parallel_sessions is required when automation is enabled' })
    }
    if (automation.max_attempts_per_stage === undefined) {
      context.addIssue({ code: 'custom', path: ['max_attempts_per_stage'], message: 'max_attempts_per_stage is required when automation is enabled' })
    }
    if (automation.max_sessions === undefined) {
      context.addIssue({ code: 'custom', path: ['max_sessions'], message: 'max_sessions is required when automation is enabled' })
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
