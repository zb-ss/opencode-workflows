import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { PublicationGitSnapshot } from './publication-git-snapshot.ts'
import type {
  PublicationFinding,
  PublicationFindingCategory,
  PublicationSourceKind,
} from './publication-scanner.ts'
import {
  isFullPublicationGitRef,
  isPublicationSourceBranchRef,
  MAX_PUBLICATION_PROTOCOL_STRING_LENGTH,
  MAX_PUBLICATION_REMOTE_URL_LENGTH,
  normalizePublicationRemoteUrl,
  PUBLICATION_FULL_GIT_REF_PATTERN,
  PUBLICATION_SCHEMA_VERSION,
  PUBLICATION_SOURCE_BRANCH_REF_PATTERN,
} from './publication-policy.ts'
import {
  MAX_SAFE_IDENTIFIER_LENGTH,
  SAFE_IDENTIFIER_PATTERN,
} from './workflow-config.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const PUBLICATION_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_TEXT_LENGTH = 4096

const SafeIdentifierSchema = z.string()
  .min(1)
  .max(MAX_SAFE_IDENTIFIER_LENGTH)
  .regex(SAFE_IDENTIFIER_PATTERN)
const BoundedTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH).regex(/^[^\0]+$/)
const Sha256Schema = z.string().regex(SHA256_PATTERN)
export const PublicationUuidSchema = z.string().regex(PUBLICATION_UUID_PATTERN)
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const DateTimeSchema = z.iso.datetime({ offset: true })

const FullGitRefSchema = z.string()
  .min(1)
  .max(MAX_PUBLICATION_PROTOCOL_STRING_LENGTH)
  .regex(PUBLICATION_FULL_GIT_REF_PATTERN)
  .refine(isFullPublicationGitRef, { message: 'invalid full Git ref' })

const SourceBranchRefSchema = z.string()
  .min(1)
  .max(MAX_PUBLICATION_PROTOCOL_STRING_LENGTH)
  .regex(PUBLICATION_SOURCE_BRANCH_REF_PATTERN)
  .refine(isPublicationSourceBranchRef, { message: 'source ref must be a full branch ref' })

const FINDING_CATEGORIES = [
  'credential',
  'high_entropy',
  'internal_marker',
  'private_key',
  'prohibited_path',
  'token',
  'unsupported_content',
] as const satisfies readonly PublicationFindingCategory[]

const SOURCE_KINDS = [
  'bytes',
  'git_blob',
  'git_commit',
  'git_object',
  'git_path',
  'path',
  'text',
] as const satisfies readonly PublicationSourceKind[]

export function stableCanonicalJson(value: unknown): string {
  const active = new Set<object>()

  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('canonical JSON requires finite numbers')
      return candidate
    }
    if (typeof candidate !== 'object') throw new Error('canonical JSON contains an unsupported value')
    if (active.has(candidate)) throw new Error('canonical JSON must not contain cycles')

    active.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        if (Object.keys(candidate).some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key))) {
          throw new Error('canonical JSON arrays must not have named properties')
        }
        return Array.from({ length: candidate.length }, (_, index) => {
          if (!(index in candidate)) throw new Error('canonical JSON arrays must not be sparse')
          return canonicalize(candidate[index])
        })
      }

      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('canonical JSON objects must be plain objects')
      }
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => compareOrdinal(left, right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      )
    } finally {
      active.delete(candidate)
    }
  }

  return JSON.stringify(canonicalize(value))
}

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(stableCanonicalJson(value))
}

export const PublicationFindingSchema: z.ZodType<PublicationFinding> = z.object({
  rule_id: z.string().min(1).max(128).regex(SAFE_IDENTIFIER_PATTERN),
  category: z.enum(FINDING_CATEGORIES),
  source_kind: z.enum(SOURCE_KINDS),
  location_identity: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/),
  fingerprint: Sha256Schema,
}).strict()

const PublicationGitSnapshotLimitsSchema = z.object({
  max_commits: PositiveSafeIntegerSchema,
  max_objects: PositiveSafeIntegerSchema,
  max_blob_bytes: PositiveSafeIntegerSchema,
  max_total_scan_bytes: PositiveSafeIntegerSchema,
  max_findings: PositiveSafeIntegerSchema,
}).strict()

const PublicationGitSnapshotShapeSchema = z.object({
  schema_version: z.literal(PUBLICATION_SCHEMA_VERSION),
  source: z.object({
    git_executable_identity_sha256: Sha256Schema,
    repository_identity_sha256: Sha256Schema,
    git_common_dir_sha256: Sha256Schema,
    object_format: z.enum(['sha1', 'sha256']),
    base_ref: SourceBranchRefSchema,
    base_oid: z.string().regex(GIT_OID_PATTERN),
    head_ref: SourceBranchRefSchema,
    head_oid: z.string().regex(GIT_OID_PATTERN),
    tree_oid: z.string().regex(GIT_OID_PATTERN),
    remote: SafeIdentifierSchema,
    remote_url: z.string().max(MAX_PUBLICATION_REMOTE_URL_LENGTH)
      .regex(/^(?:https|ssh):\/\/[^\s\0]+$/)
      .refine((value) => normalizePublicationRemoteUrl(value) !== null, {
        message: 'remote URL is not a safe publication URL',
      }),
  }).strict(),
  target: z.object({
    destination_ref: FullGitRefSchema,
  }).strict(),
  scan_policy: z.object({
    version: SafeIdentifierSchema,
    limits: PublicationGitSnapshotLimitsSchema,
    internal_markers_sha256: Sha256Schema,
  }).strict(),
  scan_counts: z.object({
    commits: NonNegativeSafeIntegerSchema,
    objects: NonNegativeSafeIntegerSchema,
    blobs: NonNegativeSafeIntegerSchema,
    paths: NonNegativeSafeIntegerSchema,
    bytes: NonNegativeSafeIntegerSchema,
    findings: NonNegativeSafeIntegerSchema,
  }).strict(),
  findings: z.array(PublicationFindingSchema),
  snapshot_sha256: Sha256Schema,
}).strict()

export const PublicationGitSnapshotSchema: z.ZodType<PublicationGitSnapshot> = PublicationGitSnapshotShapeSchema
  .superRefine((snapshot, context) => {
    const oidPattern = snapshot.source.object_format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/
    for (const [field, oid] of [
      ['base_oid', snapshot.source.base_oid],
      ['head_oid', snapshot.source.head_oid],
      ['tree_oid', snapshot.source.tree_oid],
    ] as const) {
      if (!oidPattern.test(oid)) {
        context.addIssue({ code: 'custom', path: ['source', field], message: 'OID does not match object format' })
      }
    }
    if (snapshot.scan_counts.findings !== snapshot.findings.length) {
      context.addIssue({ code: 'custom', path: ['scan_counts', 'findings'], message: 'finding count does not match findings' })
    }
    if (snapshot.findings.length > snapshot.scan_policy.limits.max_findings) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'finding limit exceeded' })
    }
    const { snapshot_sha256: _digest, ...withoutDigest } = snapshot
    if (canonicalJsonSha256(withoutDigest) !== snapshot.snapshot_sha256) {
      context.addIssue({ code: 'custom', path: ['snapshot_sha256'], message: 'snapshot digest does not match content' })
    }
  })

const PublicationGateSchema = z.object({
  id: SafeIdentifierSchema,
  status: z.enum(['passed', 'failed']),
  reason_code: SafeIdentifierSchema.optional(),
}).strict()

const PublicationPublisherIdentitySchema = z.object({
  argv_sha256: Sha256Schema,
  environment_sha256: Sha256Schema,
  executable_identity_sha256: Sha256Schema,
  working_directory_identity_sha256: Sha256Schema,
  descriptor_sha256: Sha256Schema,
}).strict()

const PublicationArtifactShapeSchema = z.object({
  schema_version: z.literal(PUBLICATION_SCHEMA_VERSION),
  artifact_id: PublicationUuidSchema,
  status: z.enum(['ready', 'blocked']),
  created_at: DateTimeSchema,
  expires_at: DateTimeSchema,
  workflow: z.object({
    workflow_id: BoundedTextSchema,
    root_session_id: BoundedTextSchema,
  }).strict(),
  target: z.object({
    id: SafeIdentifierSchema,
    display_name: BoundedTextSchema,
    protection: z.enum(['deny', 'approval_required', 'unprotected']),
  }).strict(),
  config_sha256: Sha256Schema,
  gates: z.array(PublicationGateSchema),
  publisher: PublicationPublisherIdentitySchema.nullable(),
  snapshot: PublicationGitSnapshotSchema.nullable(),
}).strict()

export const PublicationArtifactSchema = PublicationArtifactShapeSchema.superRefine((artifact, context) => {
  if (Date.parse(artifact.expires_at) <= Date.parse(artifact.created_at)) {
    context.addIssue({ code: 'custom', path: ['expires_at'], message: 'expiry must follow creation' })
  }
  const gateIds = new Set(artifact.gates.map((gate) => gate.id))
  if (gateIds.size !== artifact.gates.length) {
    context.addIssue({ code: 'custom', path: ['gates'], message: 'gate IDs must be unique' })
  }
  const hasFailedGate = artifact.gates.some((gate) => gate.status === 'failed')
  const hasFinding = (artifact.snapshot?.findings.length ?? 0) > 0
  if (artifact.status === 'ready') {
    if (artifact.snapshot === null) {
      context.addIssue({ code: 'custom', path: ['snapshot'], message: 'ready artifacts require a snapshot' })
    }
    if (artifact.publisher === null) {
      context.addIssue({ code: 'custom', path: ['publisher'], message: 'ready artifacts require a publisher identity' })
    }
    if (hasFailedGate) {
      context.addIssue({ code: 'custom', path: ['gates'], message: 'ready artifacts must not have failed gates' })
    }
    if (hasFinding) {
      context.addIssue({ code: 'custom', path: ['snapshot', 'findings'], message: 'ready artifacts must not have findings' })
    }
  } else if (!hasFailedGate && !hasFinding) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'blocked artifacts require a failed gate or finding',
    })
  }
})

const PublicationExecutionDetailSchema = z.object({
  exit_code: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  signal: z.string().min(1).max(128).regex(/^[^\0\r\n]+$/).nullable(),
  duration_ms: NonNegativeSafeIntegerSchema,
  stdout_bytes: NonNegativeSafeIntegerSchema,
  stderr_bytes: NonNegativeSafeIntegerSchema,
  stdout_sha256: Sha256Schema.nullable(),
  stderr_sha256: Sha256Schema.nullable(),
  output_truncated: z.boolean(),
  output_redacted: z.boolean(),
  request_acknowledged: z.boolean(),
  forced_status: z.enum(['timed_out', 'cancelled', 'output_limit']).nullable(),
  invocation_attempted: z.boolean(),
  spawn_uncertain: z.boolean(),
  termination_uncertain: z.boolean(),
}).strict()

const PublicationExecutionEventShapeSchema = z.object({
  schema_version: z.literal(PUBLICATION_SCHEMA_VERSION),
  execution_id: PublicationUuidSchema,
  artifact_id: PublicationUuidSchema,
  sequence: PositiveSafeIntegerSchema,
  previous_event_sha256: Sha256Schema.nullable(),
  event_sha256: Sha256Schema,
  occurred_at: DateTimeSchema,
  status: z.enum(['dispatching', 'succeeded', 'ambiguous']),
  detail: PublicationExecutionDetailSchema,
}).strict()

function executionEventDigest(event: Record<string, unknown>): string {
  const { event_sha256: _digest, ...withoutDigest } = event
  return canonicalJsonSha256(withoutDigest)
}

export const PublicationExecutionEventSchema = PublicationExecutionEventShapeSchema
  .superRefine((event, context) => {
    const hasExpectedPrevious = event.sequence === 1
      ? event.previous_event_sha256 === null
      : event.previous_event_sha256 !== null
    if (!hasExpectedPrevious) {
      context.addIssue({
        code: 'custom',
        path: ['previous_event_sha256'],
        message: 'previous event digest does not match sequence',
      })
    }
    if (executionEventDigest(event) !== event.event_sha256) {
      context.addIssue({ code: 'custom', path: ['event_sha256'], message: 'event digest does not match content' })
    }
    if (event.status === 'dispatching') {
      const detail = event.detail
      if (event.sequence !== 1
        || detail.exit_code !== null || detail.signal !== null || detail.duration_ms !== 0
        || detail.stdout_bytes !== 0 || detail.stderr_bytes !== 0
        || detail.stdout_sha256 !== null || detail.stderr_sha256 !== null
        || detail.output_truncated || detail.output_redacted || detail.request_acknowledged
        || detail.forced_status !== null
        || detail.invocation_attempted || detail.spawn_uncertain || detail.termination_uncertain) {
        context.addIssue({ code: 'custom', path: ['detail'], message: 'dispatching event detail must be empty' })
      }
    } else if (event.sequence < 2) {
      context.addIssue({ code: 'custom', path: ['sequence'], message: 'terminal events must follow dispatch' })
    }
    if (event.status === 'succeeded') {
      const detail = event.detail
      if (detail.exit_code !== 0 || detail.signal !== null || detail.forced_status !== null
        || detail.stdout_sha256 === null || detail.stderr_sha256 === null
        || detail.output_truncated || !detail.invocation_attempted
        || !detail.request_acknowledged
        || detail.spawn_uncertain || detail.termination_uncertain) {
        context.addIssue({ code: 'custom', path: ['detail'], message: 'succeeded event detail is contradictory' })
      }
    }
  })

export type PublicationArtifact = z.infer<typeof PublicationArtifactSchema>
export type PublicationExecutionEvent = z.infer<typeof PublicationExecutionEventSchema>
export type PublicationExecutionEventInput = Omit<PublicationExecutionEvent, 'event_sha256'>
export type PublicationFindingContract = z.infer<typeof PublicationFindingSchema>
export type PublicationGitSnapshotContract = z.infer<typeof PublicationGitSnapshotSchema>

export function publicationExecutionEventSha256(
  event: PublicationExecutionEventInput | PublicationExecutionEvent,
): string {
  return executionEventDigest(event as unknown as Record<string, unknown>)
}

function publicSchema(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    ...generated,
  }
}

export function publicationArtifactJsonSchema(): Record<string, unknown> {
  const generated = publicSchema(
    PublicationArtifactSchema,
    'https://opencode-workflows.example/schema/publication-artifact.schema.json',
    'Publication Artifact',
  )
  const properties = generated.properties as Record<string, Record<string, unknown>>
  const snapshot = properties.snapshot
  const snapshotVariants = snapshot.anyOf as Array<Record<string, unknown>>
  const snapshotDefinition = snapshotVariants[0]
  snapshotVariants[0] = { $ref: '#/$defs/publicationGitSnapshot' }
  generated.$defs = { publicationGitSnapshot: snapshotDefinition }
  snapshotDefinition.allOf = [
    {
      if: {
        properties: {
          source: {
            type: 'object',
            properties: { object_format: { const: 'sha1' } },
            required: ['object_format'],
          },
        },
        required: ['source'],
      },
      then: {
        properties: {
          source: {
            type: 'object',
            properties: {
              base_oid: { type: 'string', pattern: '^[a-f0-9]{40}$' },
              head_oid: { type: 'string', pattern: '^[a-f0-9]{40}$' },
              tree_oid: { type: 'string', pattern: '^[a-f0-9]{40}$' },
            },
          },
        },
      },
      else: {
        properties: {
          source: {
            type: 'object',
            properties: {
              base_oid: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              head_oid: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              tree_oid: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
      },
    },
  ]
  generated.allOf = [{
    if: {
      type: 'object',
      properties: { status: { const: 'ready' } },
      required: ['status'],
    },
    then: {
      type: 'object',
      properties: {
        gates: {
          type: 'array',
          not: {
            contains: {
              type: 'object',
              properties: { status: { const: 'failed' } },
              required: ['status'],
            },
          },
        },
        snapshot: {
          type: 'object',
          properties: { findings: { type: 'array', maxItems: 0 } },
          required: ['findings'],
        },
        publisher: { type: 'object' },
      },
    },
    else: {
      anyOf: [
        {
          type: 'object',
          properties: {
            gates: {
              type: 'array',
              contains: {
                type: 'object',
                properties: { status: { const: 'failed' } },
                required: ['status'],
              },
            },
          },
          required: ['gates'],
        },
        {
          type: 'object',
          properties: {
            snapshot: {
              type: 'object',
              properties: { findings: { type: 'array', minItems: 1 } },
              required: ['findings'],
            },
          },
          required: ['snapshot'],
        },
      ],
    },
  }]
  return generated
}

export function publicationExecutionEventJsonSchema(): Record<string, unknown> {
  const generated = publicSchema(
    PublicationExecutionEventSchema,
    'https://opencode-workflows.example/schema/publication-execution-event.schema.json',
    'Publication Execution Event',
  )
  const properties = generated.properties as Record<string, Record<string, unknown>>
  const detailDefinition = properties.detail
  properties.detail = { $ref: '#/$defs/executionDetail' }
  generated.$defs = { executionDetail: detailDefinition }
  generated.allOf = [
    {
      anyOf: [
        {
          type: 'object',
          properties: {
            sequence: { const: 1 },
            previous_event_sha256: { type: 'null' },
          },
          required: ['sequence', 'previous_event_sha256'],
        },
        {
          type: 'object',
          properties: {
            sequence: { type: 'integer', minimum: 2 },
            previous_event_sha256: { type: 'string', pattern: SHA256_PATTERN.source },
          },
          required: ['sequence', 'previous_event_sha256'],
        },
      ],
    },
    {
      if: {
        type: 'object',
        properties: { status: { const: 'dispatching' } },
        required: ['status'],
      },
      then: {
        type: 'object',
        properties: {
          sequence: { const: 1 },
          detail: {
            type: 'object',
            properties: {
              exit_code: { const: null },
              signal: { const: null },
              duration_ms: { const: 0 },
              stdout_bytes: { const: 0 },
              stderr_bytes: { const: 0 },
              stdout_sha256: { const: null },
              stderr_sha256: { const: null },
              output_truncated: { const: false },
              output_redacted: { const: false },
              request_acknowledged: { const: false },
              forced_status: { const: null },
              invocation_attempted: { const: false },
              spawn_uncertain: { const: false },
              termination_uncertain: { const: false },
            },
          },
        },
        required: ['sequence', 'detail'],
      },
      else: {
        type: 'object',
        properties: { sequence: { type: 'integer', minimum: 2 } },
        required: ['sequence'],
      },
    },
    {
      if: {
        type: 'object',
        properties: { status: { const: 'succeeded' } },
        required: ['status'],
      },
      then: {
        type: 'object',
        properties: {
          detail: {
            type: 'object',
            properties: {
              exit_code: { const: 0 },
              signal: { const: null },
              stdout_sha256: { type: 'string', pattern: SHA256_PATTERN.source },
              stderr_sha256: { type: 'string', pattern: SHA256_PATTERN.source },
              output_truncated: { const: false },
              request_acknowledged: { const: true },
              forced_status: { const: null },
              invocation_attempted: { const: true },
              spawn_uncertain: { const: false },
              termination_uncertain: { const: false },
            },
          },
        },
        required: ['detail'],
      },
    },
  ]
  return generated
}
