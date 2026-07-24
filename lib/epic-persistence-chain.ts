import fs from 'node:fs'
import path from 'node:path'

import {
  EPIC_ENVELOPE_VERSION,
  epicEnvelopeDigest,
  type EpicIdentityRecord,
  epicRecordBytes,
  type EpicRevisionEnvelope,
  EpicRevisionEnvelopeSchema,
  epicRevisionName,
  epicStateDigest,
  isSupportedEpicEnvelope,
} from './epic-persistence-codec.ts'
import {
  EpicBoundsExceededError,
  EpicCorruptError,
  EpicIncompleteStateError,
  EpicUnsafeStorageError,
  EpicUnsupportedVersionError,
} from './epic-persistence-errors.ts'
import {
  listEpicDirectory,
  readEpicRecord,
  withStableEpicDirectory,
  writeExclusiveEpicRecord,
} from './epic-persistence-files.ts'
import {
  EPIC_SCHEMA_VERSION,
  EpicSchemaVersionError,
  type EpicState,
} from './epic-contract-schemas.ts'
import { validateEpicState } from './epic-dag-state-validation.ts'
import { validateEpicRecoveryTransition, validateEpicTransition } from './epic-transitions.ts'

export interface EpicRevisionChainContext {
  revisions: string
  maxRevisions: number
  maxChainBytes: number
  maxRevisionBytes: number
  settlementRetries: number
  sync: (descriptor: number) => void
  runtimeIncarnation: string
}

export interface EpicRevisionChainResult {
  state: EpicState
  stateSha256: string
  ownershipGeneration: number
  latestRuntimeIncarnation: string
  revisionEvidence: EpicRevisionEvidence[]
}

export interface EpicRevisionEvidence {
  revision: number
  ownership_generation: number
  previous_state_sha256: string | null
  state_sha256: string
}

export function encodeEpicRevision(
  state: EpicState,
  previousStateSha256: string | null,
  ownershipGeneration: number,
  runtimeIncarnation: string,
  maximumBytes: number,
): Buffer {
  const withoutDigest: Omit<EpicRevisionEnvelope, 'envelope_sha256'> = {
    envelope_version: EPIC_ENVELOPE_VERSION,
    schema_version: EPIC_SCHEMA_VERSION,
    revision: state.state_revision,
    ownership_generation: ownershipGeneration,
    previous_state_sha256: previousStateSha256,
    state_sha256: epicStateDigest(state),
    runtime_incarnation: runtimeIncarnation,
    state,
  }
  const envelope: EpicRevisionEnvelope = {
    ...withoutDigest,
    envelope_sha256: epicEnvelopeDigest(withoutDigest),
  }
  const bytes = epicRecordBytes(envelope)
  if (bytes.length > maximumBytes) throw new EpicBoundsExceededError('epic revision bytes exceed the protocol bound')
  return bytes
}

export function writeEpicRevision(context: EpicRevisionChainContext, state: EpicState, bytes: Buffer): void {
  if (state.state_revision > context.maxRevisions) throw new EpicBoundsExceededError('epic revision count exceeds the protocol bound')
  if (bytes.length > context.maxRevisionBytes) throw new EpicBoundsExceededError('epic revision bytes exceed the protocol bound')
  let existingBytes = 0
  if (fs.existsSync(context.revisions)) {
    for (const name of listEpicDirectory(context.revisions)) {
      if (!/^\d{20}\.json$/.test(name)) throw new EpicCorruptError('revision directory contains an unexpected record')
      const stat = fs.lstatSync(path.join(context.revisions, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new EpicUnsafeStorageError('revision entry is not one regular file')
      }
      const size = stat.size
      if (existingBytes > context.maxChainBytes - size) throw new EpicBoundsExceededError('epic aggregate chain bytes exceed the protocol bound')
      existingBytes += size
    }
  }
  if (existingBytes > context.maxChainBytes - bytes.length) throw new EpicBoundsExceededError('epic aggregate chain bytes exceed the protocol bound')
  writeExclusiveEpicRecord(
    context.revisions,
    path.join(context.revisions, epicRevisionName(state.state_revision)),
    bytes,
    context.sync,
  )
}

export function readEpicRevisionChain(
  context: EpicRevisionChainContext,
  identity: EpicIdentityRecord,
  assertStateOwner: (state: EpicState) => void,
): EpicRevisionChainResult {
  const names = boundedRevisionNames(context)
  let previous: EpicState | null = null
  let previousSha256: string | null = null
  let latestRuntimeIncarnation = ''
  let ownershipGeneration: number = identity.ownership_generation
  const revisionEvidence: EpicRevisionEvidence[] = []

  for (let index = 0; index < names.length; index += 1) {
    const expectedRevision = index + 1
    const envelope = readEnvelope(context, names[index]!, expectedRevision)
    const state = validateEnvelopeState(envelope, expectedRevision, previousSha256)
    validateGeneration(envelope, identity, index, ownershipGeneration)
    assertStateOwner(state)
    validateIdentityBinding(state, identity, expectedRevision)
    if (previous !== null) validateReplayTransition(previous, state, envelope.ownership_generation, ownershipGeneration, expectedRevision)
    previous = state
    previousSha256 = envelope.state_sha256
    latestRuntimeIncarnation = envelope.runtime_incarnation
    ownershipGeneration = envelope.ownership_generation
    revisionEvidence.push({
      revision: envelope.revision,
      ownership_generation: envelope.ownership_generation,
      previous_state_sha256: envelope.previous_state_sha256,
      state_sha256: envelope.state_sha256,
    })
  }

  return {
    state: previous!,
    stateSha256: previousSha256!,
    ownershipGeneration,
    latestRuntimeIncarnation,
    revisionEvidence,
  }
}

function boundedRevisionNames(context: EpicRevisionChainContext): string[] {
  const names: string[] = []
  let aggregateBytes = 0
  withStableEpicDirectory(context.revisions, () => {
    const handle = fs.opendirSync(context.revisions)
    try {
      for (;;) {
        const entry = handle.readSync()
        if (entry === null) break
        if (!/^\d{20}\.json$/.test(entry.name)) throw new EpicCorruptError('revision directory contains an unexpected record')
        names.push(entry.name)
        if (names.length > context.maxRevisions) throw new EpicBoundsExceededError('epic revision count exceeds the protocol bound')
        const stat = fs.lstatSync(path.join(context.revisions, entry.name), { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink()) throw new EpicUnsafeStorageError('revision entry is not a regular file')
        const size = Number(stat.size)
        if (!Number.isSafeInteger(size) || size < 0 || aggregateBytes > context.maxChainBytes - size) {
          throw new EpicBoundsExceededError('epic aggregate chain bytes exceed the protocol bound')
        }
        aggregateBytes += size
      }
    } finally {
      handle.closeSync()
    }
  })
  if (names.length === 0) throw new EpicIncompleteStateError('epic identity has no settled initial revision')
  names.sort()
  return names
}

function readEnvelope(context: EpicRevisionChainContext, name: string, expectedRevision: number): EpicRevisionEnvelope {
  if (name !== epicRevisionName(expectedRevision)) throw new EpicCorruptError('epic revision chain has a gap or non-canonical filename')
  const input = readEpicRecord(
    path.join(context.revisions, name),
    context.revisions,
    `epic revision ${expectedRevision}`,
    context.maxRevisionBytes,
    context.settlementRetries,
  )
  const parsed = EpicRevisionEnvelopeSchema.safeParse(input)
  if (!parsed.success) throw new EpicCorruptError(`epic revision ${expectedRevision} does not match its strict envelope`)
  const envelope = parsed.data as EpicRevisionEnvelope
  if (!isSupportedEpicEnvelope(envelope)) throw new EpicUnsupportedVersionError(`epic revision ${expectedRevision} version is unsupported`)
  const { envelope_sha256, ...withoutDigest } = envelope
  if (epicEnvelopeDigest(withoutDigest) !== envelope_sha256) throw new EpicCorruptError(`epic revision ${expectedRevision} envelope digest is invalid`)
  return envelope
}

function validateEnvelopeState(envelope: EpicRevisionEnvelope, expectedRevision: number, previousSha256: string | null): EpicState {
  let state: EpicState
  try {
    state = validateEpicState(envelope.state)
  } catch (error) {
    if (error instanceof EpicSchemaVersionError) throw new EpicUnsupportedVersionError(`epic revision ${expectedRevision} state version is unsupported`)
    throw new EpicCorruptError(`epic revision ${expectedRevision} state is invalid`)
  }
  if (state.state_revision !== expectedRevision
    || envelope.revision !== expectedRevision
    || envelope.previous_state_sha256 !== previousSha256
    || envelope.state_sha256 !== epicStateDigest(state)) {
    throw new EpicCorruptError(`epic revision ${expectedRevision} chain binding is invalid`)
  }
  return state
}

function validateGeneration(
  envelope: EpicRevisionEnvelope,
  identity: EpicIdentityRecord,
  index: number,
  previousGeneration: number,
): void {
  if (index === 0 && envelope.ownership_generation !== identity.ownership_generation) throw new EpicCorruptError('initial revision ownership generation is invalid')
  if (index > 0 && envelope.ownership_generation < previousGeneration) throw new EpicCorruptError(`epic revision ${index + 1} ownership generation moved backwards`)
  if (index > 0 && envelope.ownership_generation > previousGeneration + 1) throw new EpicCorruptError(`epic revision ${index + 1} ownership generation skipped a generation`)
}

function validateIdentityBinding(state: EpicState, identity: EpicIdentityRecord, expectedRevision: number): void {
  if (state.base_branch !== identity.base_branch
    || state.integration_branch !== identity.integration_branch
    || state.created_at !== identity.created_at) {
    throw new EpicCorruptError(`epic revision ${expectedRevision} does not match immutable identity`)
  }
}

function validateReplayTransition(
  previous: EpicState,
  state: EpicState,
  generation: number,
  previousGeneration: number,
  expectedRevision: number,
): void {
  try {
    if (generation === previousGeneration) validateEpicTransition(previous, state)
    else validateEpicRecoveryTransition(previous, state)
  } catch {
    throw new EpicCorruptError(`epic revision ${expectedRevision} violates transition invariants`)
  }
}
