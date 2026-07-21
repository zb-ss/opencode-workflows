import crypto from 'node:crypto'

import { z } from 'zod'

import { stableCanonicalJson } from './epic-canonical-json.ts'
import { type EpicState, EPIC_SCHEMA_VERSION } from './epic-contract-schemas.ts'
import type { EpicConfig, EpicOperationalLimits } from './epic-policy.ts'

export const EPIC_IDENTITY_VERSION = 1
export const EPIC_ENVELOPE_VERSION = 1
export const MAX_EPIC_IDENTITY_BYTES = 64 * 1024
export const MAX_EPIC_REVISION_BYTES = 16 * 1024 * 1024
export const EPIC_SHA256_PATTERN = /^[a-f0-9]{64}$/

const REVISION_WIDTH = 20

export interface EpicIdentityRecord {
  identity_version: number
  schema_version: number
  root_session_id: string
  canonical_project_sha256: string
  project_directory_dev: string
  project_directory_ino: string
  epic_id: string
  operational_limits: EpicOperationalLimits
  config_sha256: string
  base_branch: string
  integration_branch: string
  created_at: string
  ownership_generation: 1
  identity_digest: string
}

export interface EpicRevisionEnvelope {
  envelope_version: number
  schema_version: number
  revision: number
  ownership_generation: number
  previous_state_sha256: string | null
  state_sha256: string
  runtime_incarnation: string
  state: EpicState
  envelope_sha256: string
}

const LimitsSchema = z.object({
  max_epic_items: z.number().int(),
  max_item_dependencies: z.number().int(),
  max_attempts_per_item: z.number().int(),
  max_budget_records: z.number().int(),
}).strict()

export const EpicIdentityRecordSchema = z.object({
  identity_version: z.number().int(),
  schema_version: z.number().int(),
  root_session_id: z.string(),
  canonical_project_sha256: z.string().regex(EPIC_SHA256_PATTERN),
  project_directory_dev: z.string().regex(/^\d+$/),
  project_directory_ino: z.string().regex(/^\d+$/),
  epic_id: z.string(),
  operational_limits: LimitsSchema,
  config_sha256: z.string().regex(EPIC_SHA256_PATTERN),
  base_branch: z.string(),
  integration_branch: z.string(),
  created_at: z.string(),
  ownership_generation: z.literal(1),
  identity_digest: z.string().regex(EPIC_SHA256_PATTERN),
}).strict()

export const EpicRevisionEnvelopeSchema = z.object({
  envelope_version: z.number().int(),
  schema_version: z.number().int(),
  revision: z.number().int().positive(),
  ownership_generation: z.number().int().positive(),
  previous_state_sha256: z.string().regex(EPIC_SHA256_PATTERN).nullable(),
  state_sha256: z.string().regex(EPIC_SHA256_PATTERN),
  runtime_incarnation: z.string(),
  state: z.unknown(),
  envelope_sha256: z.string().regex(EPIC_SHA256_PATTERN),
}).strict()

function digest(domain: string, value: unknown): string {
  // These hashes provide integrity and chain binding, not authentication
  // against a malicious process running as the same operating-system user.
  return crypto.createHash('sha256').update(`${domain}\0${stableCanonicalJson(value)}`).digest('hex')
}

export function epicStateDigest(state: EpicState): string {
  return digest('opencode.epic.state.v1', state)
}

export function epicEnvelopeDigest(envelope: Omit<EpicRevisionEnvelope, 'envelope_sha256'>): string {
  return digest('opencode.epic.envelope.v1', envelope)
}

export function epicConfigDigest(config: EpicConfig): string {
  return digest('opencode.epic.config.v1', config)
}

export function epicIdentityRecordDigest(identity: Omit<EpicIdentityRecord, 'identity_digest'>): string {
  return digest('opencode.epic.identity.v1', identity)
}

export function epicRecordBytes(value: unknown): Buffer {
  return Buffer.from(`${stableCanonicalJson(value)}\n`, 'utf8')
}

export function epicRevisionName(revision: number): string {
  return `${String(revision).padStart(REVISION_WIDTH, '0')}.json`
}

export function isSupportedEpicIdentity(record: EpicIdentityRecord): boolean {
  return record.identity_version === EPIC_IDENTITY_VERSION && record.schema_version === EPIC_SCHEMA_VERSION
}

export function isSupportedEpicEnvelope(envelope: EpicRevisionEnvelope): boolean {
  return envelope.envelope_version === EPIC_ENVELOPE_VERSION && envelope.schema_version === EPIC_SCHEMA_VERSION
}
