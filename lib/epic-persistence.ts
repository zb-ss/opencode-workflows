import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { stableCanonicalJson } from './epic-canonical-json.ts'
import { projectEpicBudgetStatus, type EpicBudgetStatus } from './epic-budget-usage.ts'
import {
  EPIC_SCHEMA_VERSION,
  EpicSchemaVersionError,
  type EpicState,
  EpicValidationError,
} from './epic-contract-schemas.ts'
import { validateEpicGenesisState, validateEpicState } from './epic-dag-state-validation.ts'
import {
  epicConfigDigest,
  type EpicIdentityRecord,
  epicIdentityRecordDigest,
  EpicIdentityRecordSchema,
  EPIC_IDENTITY_VERSION,
  epicRecordBytes,
  EPIC_SHA256_PATTERN,
  epicStateDigest,
  isSupportedEpicIdentity,
  MAX_EPIC_IDENTITY_BYTES,
  MAX_EPIC_REVISION_BYTES,
} from './epic-persistence-codec.ts'
import {
  encodeEpicRevision,
  type EpicRevisionChainContext,
  readEpicRevisionChain,
  writeEpicRevision,
} from './epic-persistence-chain.ts'
import {
  EpicBoundsExceededError,
  EpicCorruptError,
  EpicIncompleteStateError,
  EpicInputError,
  EpicMissingError,
  EpicRecoveryRequiredError,
  EpicStaleRevisionError,
  EpicStoreError,
  EpicTransitionError,
  EpicUnavailableError,
  EpicUnsupportedVersionError,
} from './epic-persistence-errors.ts'
import {
  assertEpicPosixStorage,
  canonicalEpicProjectRoot,
  ensureEpicDirectoryTree,
  type EpicProjectIdentity,
  inspectEpicDirectory,
  inspectEpicDirectoryTree,
  listEpicDirectory,
  readEpicRecord,
  verifyEpicProjectIdentity,
  writeExclusiveEpicRecord,
} from './epic-persistence-files.ts'
import { type EpicConfig, EpicConfigSchema, type EpicOperationalLimits } from './epic-policy.ts'
import { validateEpicRecoveryTransition, validateEpicTransition } from './epic-transitions.ts'
import { MAX_EPIC_CHAIN_BYTES, MAX_EPIC_REVISIONS } from './epic-policy.ts'
import { getRuntimeDir, hashIdentifier } from './paths.ts'
import { isSafeIdentifier } from './safe-identifier.ts'

const DEFAULT_SETTLEMENT_RETRIES = 3

export type EpicStoreMode = 'disabled' | 'read_only' | 'read_write'
export {
  EpicBoundsExceededError,
  EpicCorruptError,
  EpicIncompleteStateError,
  EpicInputError,
  EpicMissingError,
  EpicRecoveryRequiredError,
  EpicStaleRevisionError,
  EpicStoreError,
  EpicTransitionError,
  EpicUnavailableError,
  EpicUnsafeStorageError,
  EpicUnsupportedVersionError,
} from './epic-persistence-errors.ts'

/**
 * Trusted in-process inputs resolved by the owning plugin from authoritative
 * session context. This object must never be constructed from agent/tool input.
 */
export interface EpicStoreOptions {
  root_session_id: string
  project_root: string
  epic_id: string
  config: EpicConfig
  runtime_incarnation: string
  mode: EpicStoreMode
  env?: NodeJS.ProcessEnv
  /** Test-only fault injection. Production callers must omit these. */
  fsync?: (descriptor: number) => void
  protocol_bounds?: { max_revisions: number, max_chain_bytes: number, max_revision_bytes?: number }
  settlement_retries?: number
}

export interface EpicLoadResult {
  state: EpicState
  state_sha256: string
  revision: number
  ownership_generation: number
  recovery_required: boolean
  identity_digest: string
}

export interface EpicStatusOnly {
  epic_id: string
  status: EpicState['status']
  pause_code: string | null
  recovery_required: boolean
  item_count: number
  integrated_count: number
  running_count: number
  failed_count: number
  conflicted_count: number
  budget_dimensions: EpicBudgetStatus
  revision: number
  ownership_generation: number
  updated_at: string
  state_sha256: string
  identity_digest: string
}

interface ActiveStoreContext {
  parsedConfig: Extract<EpicConfig, { enabled: true }>
  project: EpicProjectIdentity
  runtimeRoot: string
  root: string
  revisions: string
  identityPath: string
  sync: (descriptor: number) => void
  maxRevisions: number
  maxChainBytes: number
  maxRevisionBytes: number
  settlementRetries: number
}

function isTerminal(status: EpicState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function pauseRecoveryStatus(state: EpicState): Pick<EpicState, 'status' | 'pause_code'> {
  return isTerminal(state.status)
    ? { status: state.status, pause_code: state.pause_code }
    : { status: 'paused', pause_code: 'restart_recovery' }
}

function assertIdentifier(value: string, label: string): void {
  if (!isSafeIdentifier(value)) throw new EpicInputError(`${label} is invalid`)
}
export interface EpicStoreHandle {
  load(): EpicLoadResult | null
  append(nextInput: unknown, expected_revision: number, expected_state_sha256: string | null, expected_generation: number): EpicLoadResult | null
  reconcile(nextInput: unknown, expected_revision: number, expected_state_sha256: string, expected_generation: number): EpicLoadResult | null
  statusOnly(): EpicStatusOnly | null
}

class EpicStore implements EpicStoreHandle {
  private readonly active: ActiveStoreContext | null

  constructor(private readonly options: EpicStoreOptions) {
    // Disabled mode deliberately does not validate identifiers/configuration,
    // inspect POSIX capabilities, canonicalize the project, or resolve runtime paths.
    if (options.mode === 'disabled') {
      this.active = null
      return
    }
    assertEpicPosixStorage()
    assertIdentifier(options.root_session_id, 'root_session_id')
    assertIdentifier(options.epic_id, 'epic_id')
    assertIdentifier(options.runtime_incarnation, 'runtime_incarnation')
    const parsed = EpicConfigSchema.safeParse(options.config)
    if (!parsed.success || !parsed.data.enabled) throw new EpicInputError('active epic store requires a complete enabled configuration')
    const project = canonicalEpicProjectRoot(options.project_root)
    const runtimeRoot = getRuntimeDir(options.env)
    const root = path.join(runtimeRoot, 'epics', hashIdentifier(options.root_session_id), hashIdentifier(project.canonical_path), hashIdentifier(options.epic_id))
    const bounds = options.protocol_bounds ?? { max_revisions: MAX_EPIC_REVISIONS, max_chain_bytes: MAX_EPIC_CHAIN_BYTES }
    const maxRevisionBytes = bounds.max_revision_bytes ?? MAX_EPIC_REVISION_BYTES
    if (!Number.isSafeInteger(bounds.max_revisions) || bounds.max_revisions < 1 || bounds.max_revisions > MAX_EPIC_REVISIONS
      || !Number.isSafeInteger(bounds.max_chain_bytes) || bounds.max_chain_bytes < 1 || bounds.max_chain_bytes > MAX_EPIC_CHAIN_BYTES
      || !Number.isSafeInteger(maxRevisionBytes) || maxRevisionBytes < 1 || maxRevisionBytes > MAX_EPIC_REVISION_BYTES) {
      throw new EpicInputError('epic protocol bounds are invalid')
    }
    const settlementRetries = options.settlement_retries ?? DEFAULT_SETTLEMENT_RETRIES
    if (!Number.isSafeInteger(settlementRetries) || settlementRetries < 0 || settlementRetries > 100) {
      throw new EpicInputError('epic settlement retry bound is invalid')
    }
    this.active = {
      parsedConfig: parsed.data,
      project,
      runtimeRoot,
      root,
      revisions: path.join(root, 'revisions'),
      identityPath: path.join(root, 'identity.json'),
      sync: options.fsync ?? fs.fsyncSync,
      maxRevisions: bounds.max_revisions,
      maxChainBytes: bounds.max_chain_bytes,
      maxRevisionBytes,
      settlementRetries,
    }
  }

  load(): EpicLoadResult | null {
    if (this.active === null) return null
    this.assertReadWrite('load full epic state')
    return this.runStoreOperation(() => this.loadInternal())
  }

  append(nextInput: unknown, expected_revision: number, expected_state_sha256: string | null, expected_generation: number): EpicLoadResult | null {
    if (this.active === null) return null
    this.assertReadWrite('append epic state')
    return this.runStoreOperation(() => {
      const current = this.loadInternal()
      if (current?.recovery_required) throw new EpicRecoveryRequiredError('epic requires attended restart reconciliation before normal append')
      this.assertExpected(current, expected_revision, expected_state_sha256, expected_generation)
      let next: EpicState
      try {
        next = validateEpicState(nextInput)
      } catch (error) {
        throw this.mapValidation(error, 'input')
      }
      if (current === null) {
        try {
          next = validateEpicGenesisState(next)
        } catch (error) {
          throw this.mapValidation(error, 'input')
        }
        this.assertStateOwner(next)
      } else {
        try {
          validateEpicTransition(current.state, next)
        } catch (error) {
          throw this.mapValidation(error, 'transition')
        }
        this.assertStateOwner(next)
      }
      const generation = current?.ownership_generation ?? 1
      const bytes = encodeEpicRevision(next, expected_state_sha256, generation, this.options.runtime_incarnation, this.context().maxRevisionBytes)
      if (current === null) {
        this.ensureLayout()
        this.ensureIdentity(next)
      }
      writeEpicRevision(this.chainContext(), next, bytes)
      return this.result(next, generation, false, this.readIdentity().identity_digest)
    })
  }

  reconcile(nextInput: unknown, expected_revision: number, expected_state_sha256: string, expected_generation: number): EpicLoadResult | null {
    if (this.active === null) return null
    this.assertReadWrite('reconcile epic recovery')
    return this.runStoreOperation(() => {
      const current = this.loadInternal()
      if (current === null) throw new EpicMissingError()
      this.assertExpected(current, expected_revision, expected_state_sha256, expected_generation)
      if (!current.recovery_required) throw new EpicRecoveryRequiredError('epic does not require restart reconciliation')
      let next: EpicState
      try {
        next = validateEpicRecoveryTransition(current.state, nextInput)
      } catch (error) {
        throw this.mapValidation(error, 'transition')
      }
      this.assertStateOwner(next)
      const generation = current.ownership_generation + 1
      const bytes = encodeEpicRevision(next, current.state_sha256, generation, this.options.runtime_incarnation, this.context().maxRevisionBytes)
      writeEpicRevision(this.chainContext(), next, bytes)
      return this.result(next, generation, false, current.identity_digest)
    })
  }

  statusOnly(): EpicStatusOnly | null {
    if (this.active === null) return null
    return this.runStoreOperation(() => {
      const loaded = this.loadInternal()
      if (loaded === null) return null
      return projectEpicStatus(loaded.state, loaded)
    })
  }

  private context(): ActiveStoreContext {
    if (this.active === null) throw new EpicUnavailableError('epic store is disabled')
    return this.active
  }
  private assertReadWrite(operation: string): void {
    if (this.options.mode !== 'read_write') throw new EpicUnavailableError(`only the read-write owner may ${operation}`)
  }
  private runStoreOperation<T>(operation: () => T): T {
    try {
      verifyEpicProjectIdentity(this.context().project)
      return operation()
    } catch (error) {
      if (error instanceof EpicStoreError) throw error
      throw new EpicUnavailableError('epic store operation failed', error)
    }
  }
  private mapValidation(error: unknown, kind: 'input' | 'transition'): EpicStoreError {
    if (error instanceof EpicSchemaVersionError) return new EpicUnsupportedVersionError('epic state schema version is unsupported')
    if (error instanceof EpicValidationError || error instanceof z.ZodError) return kind === 'input' ? new EpicInputError('epic state input is invalid') : new EpicTransitionError('epic state transition is invalid')
    return kind === 'input' ? new EpicInputError('epic state input could not be validated') : new EpicTransitionError('epic state transition could not be validated')
  }
  private result(state: EpicState, generation: number, recovery_required: boolean, identity_digest: string): EpicLoadResult {
    return { state, state_sha256: epicStateDigest(state), revision: state.state_revision, ownership_generation: generation, recovery_required, identity_digest }
  }
  private chainContext(): EpicRevisionChainContext {
    const context = this.context()
    return {
      revisions: context.revisions,
      maxRevisions: context.maxRevisions,
      maxChainBytes: context.maxChainBytes,
      maxRevisionBytes: context.maxRevisionBytes,
      settlementRetries: context.settlementRetries,
      sync: context.sync,
      runtimeIncarnation: this.options.runtime_incarnation,
    }
  }
  private ensureLayout(): void {
    const context = this.context()
    ensureEpicDirectoryTree(context.revisions, context.runtimeRoot, context.sync)
  }
  private assertExpected(current: EpicLoadResult | null, revision: number, sha256: string | null, generation: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || (sha256 !== null && !EPIC_SHA256_PATTERN.test(sha256)) || !Number.isSafeInteger(generation) || generation < 1) throw new EpicStaleRevisionError('expected revision identity is invalid')
    if ((current?.revision ?? 0) !== revision || (current?.state_sha256 ?? null) !== sha256 || (current?.ownership_generation ?? 1) !== generation) throw new EpicStaleRevisionError('expected revision, state digest, or ownership generation is stale')
  }
  private expectedLimits(): EpicOperationalLimits {
    const { max_epic_items, max_item_dependencies, max_attempts_per_item, max_budget_records } = this.context().parsedConfig
    return { max_epic_items, max_item_dependencies, max_attempts_per_item, max_budget_records }
  }
  private assertStateOwner(state: EpicState): void {
    if (state.root_session_id !== this.options.root_session_id || state.epic_id !== this.options.epic_id || state.project_identity_sha256 !== this.context().project.canonical_path_sha256) throw new EpicInputError('epic state does not match the opened owner and project identity')
    if (stableCanonicalJson(state.operational_limits) !== stableCanonicalJson(this.expectedLimits())) throw new EpicInputError('epic state limits do not match frozen operator configuration')
  }
  private makeIdentity(state: EpicState): EpicIdentityRecord {
    const context = this.context()
    const withoutDigest: Omit<EpicIdentityRecord, 'identity_digest'> = {
      identity_version: EPIC_IDENTITY_VERSION, schema_version: EPIC_SCHEMA_VERSION, root_session_id: this.options.root_session_id,
      canonical_project_sha256: context.project.canonical_path_sha256, project_directory_dev: context.project.dev, project_directory_ino: context.project.ino,
      epic_id: this.options.epic_id, operational_limits: this.expectedLimits(), config_sha256: epicConfigDigest(context.parsedConfig), base_branch: state.base_branch,
      integration_branch: state.integration_branch, created_at: state.created_at, ownership_generation: 1,
    }
    return { ...withoutDigest, identity_digest: epicIdentityRecordDigest(withoutDigest) }
  }
  private ensureIdentity(state: EpicState): void {
    const expected = this.makeIdentity(state)
    const context = this.context()
    try {
      writeExclusiveEpicRecord(context.root, context.identityPath, epicRecordBytes(expected), context.sync)
    } catch (error) {
      if (!(error instanceof EpicStaleRevisionError)) throw error
      const actual = this.readIdentity()
      if (stableCanonicalJson(actual) !== stableCanonicalJson(expected)) throw new EpicStaleRevisionError('epic identity was claimed by another initial writer')
    }
  }
  private readIdentity(): EpicIdentityRecord {
    const context = this.context()
    const parsed = EpicIdentityRecordSchema.safeParse(readEpicRecord(context.identityPath, context.root, 'epic identity', MAX_EPIC_IDENTITY_BYTES, context.settlementRetries))
    if (!parsed.success) throw new EpicCorruptError('epic identity does not match its strict contract')
    const identity = parsed.data as EpicIdentityRecord
    if (!isSupportedEpicIdentity(identity)) throw new EpicUnsupportedVersionError('epic identity version is unsupported')
    const { identity_digest, ...withoutDigest } = identity
    if (epicIdentityRecordDigest(withoutDigest) !== identity_digest) throw new EpicCorruptError('epic identity digest does not match content')
    if (identity.root_session_id !== this.options.root_session_id || identity.canonical_project_sha256 !== context.project.canonical_path_sha256
      || identity.project_directory_dev !== context.project.dev || identity.project_directory_ino !== context.project.ino || identity.epic_id !== this.options.epic_id
      || identity.config_sha256 !== epicConfigDigest(context.parsedConfig) || stableCanonicalJson(identity.operational_limits) !== stableCanonicalJson(this.expectedLimits())) throw new EpicCorruptError('epic identity does not match the opened owner, project inode, epic, or configuration')
    return identity
  }
  private loadInternal(): EpicLoadResult | null {
    const context = this.context()
    if (!inspectEpicDirectoryTree(context.root, context.runtimeRoot)) return null
    const rootEntries = listEpicDirectory(context.root)
    if (rootEntries.some(entry => entry !== 'identity.json' && entry !== 'revisions')) throw new EpicCorruptError('epic root contains unexpected records')
    const hasIdentity = rootEntries.includes('identity.json')
    const hasRevisions = rootEntries.includes('revisions')
    if (!hasIdentity && !hasRevisions) throw new EpicIncompleteStateError('epic initialization directory is incomplete')
    if (!hasIdentity) throw new EpicIncompleteStateError('epic revisions exist without settled identity')
    const identity = this.readIdentity()
    if (!hasRevisions) throw new EpicIncompleteStateError('epic identity exists without revision storage')
    inspectEpicDirectory(context.revisions, false)
    const chain = readEpicRevisionChain(this.chainContext(), identity, state => this.assertStateOwner(state))
    const recoveryRequired = !isTerminal(chain.state.status)
      && chain.latestRuntimeIncarnation !== this.options.runtime_incarnation
    return {
      state: chain.state,
      state_sha256: chain.stateSha256,
      revision: chain.state.state_revision,
      ownership_generation: chain.ownershipGeneration,
      recovery_required: recoveryRequired,
      identity_digest: identity.identity_digest,
    }
  }
}

/**
 * Trusted persistence boundary. Production callers must derive every option
 * from authoritative plugin/session context before entering this module.
 */
export function openEpicStore(options: EpicStoreOptions): EpicStoreHandle {
  return new EpicStore(options)
}

/** Pure projection requires the caller to supply the persisted immutable identity digest. */
export function epicStatusOnly(state: EpicState, state_sha256: string, identity_digest: string, ownership_generation = 1): EpicStatusOnly {
  return projectEpicStatus(state, { state_sha256, identity_digest, ownership_generation, recovery_required: false })
}

/** Shared pure trusted-state projection. identity_digest must come from the immutable store identity record. */
export function projectEpicStatus(
  state: EpicState,
  evidence: Pick<EpicLoadResult, 'state_sha256' | 'identity_digest' | 'ownership_generation' | 'recovery_required'>,
): EpicStatusOnly {
  const items = Object.values(state.items)
  const recovery = evidence.recovery_required ? pauseRecoveryStatus(state) : { status: state.status, pause_code: state.pause_code }
  return {
    epic_id: state.epic_id,
    status: recovery.status,
    pause_code: recovery.pause_code ?? null,
    recovery_required: evidence.recovery_required,
    item_count: items.length,
    integrated_count: items.filter(item => item.status === 'integrated').length,
    running_count: items.filter(item => item.status === 'running').length,
    failed_count: items.filter(item => item.status === 'failed' || item.status === 'blocked').length,
    conflicted_count: items.filter(item => item.status === 'conflicted').length,
    budget_dimensions: projectEpicBudgetStatus(state),
    revision: state.state_revision,
    ownership_generation: evidence.ownership_generation,
    updated_at: state.updated_at,
    state_sha256: evidence.state_sha256,
    identity_digest: evidence.identity_digest,
  }
}
