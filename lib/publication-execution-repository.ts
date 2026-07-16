import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { z } from 'zod'

import {
  canonicalJsonSha256,
  compareOrdinal,
  type PublicationExecutionEvent,
  PublicationExecutionEventSchema,
  PublicationUuidSchema,
} from './publication-contracts.ts'
import {
  type PublicationArtifactCatalog,
  PublicationArtifactRepository,
  type StoredPublicationArtifact,
} from './publication-artifact-repository.ts'
import {
  assertPublicationUuid,
  ExclusiveRecordExistsError,
  ExclusiveRecordWriteError,
  isMissingPublicationRecord,
  type PublicationStoreLayout,
  PublicationPrivateRecords,
  publicationRecordBytes,
  publicationStoreError,
} from './publication-private-record.ts'
import { PUBLICATION_SCHEMA_VERSION } from './publication-policy.ts'

const MAX_EVENT_BYTES = 64 * 1024
const MAX_CLAIM_BYTES = 16 * 1024
const MAX_EVENT_SEQUENCE = 999_999

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const DateTimeSchema = z.iso.datetime({ offset: true })

const PublicationExecutionClaimSchema = z.object({
  artifact_id: PublicationUuidSchema,
  artifact_sha256: Sha256Schema,
  execution_id: PublicationUuidSchema,
  claimed_at: DateTimeSchema,
}).strict()

const InitialDispatchEventDataSchema = z.object({
  occurred_at: DateTimeSchema,
  detail: z.unknown(),
}).strict()

export type PublicationExecutionClaim = z.infer<typeof PublicationExecutionClaimSchema>

export interface StoredPublicationArtifactState {
  stored: StoredPublicationArtifact
  execution_id: string | null
  events: PublicationExecutionEvent[]
}

export interface PublicationExecutionClaimResult {
  execution_id: string
  created: boolean
}

export interface PublicationInitialDispatchEventData {
  occurred_at: string
  detail: PublicationExecutionEvent['detail']
}

export class PublicationExecutionRepository {
  constructor(
    private readonly records: PublicationPrivateRecords,
    private readonly artifacts: PublicationArtifactRepository,
    private readonly now: () => Date,
  ) {}

  async listArtifactStates(catalog: PublicationArtifactCatalog): Promise<StoredPublicationArtifactState[]> {
    const states: StoredPublicationArtifactState[] = []
    for (const stored of catalog.artifacts) {
      try {
        const claim = await this.readClaim(
          stored.artifact.artifact_id,
          catalog.layout,
          catalog.reservations.byArtifactId,
        )
        states.push({
          stored,
          execution_id: claim.execution_id,
          events: await this.readExecutionEventChain(claim.execution_id, claim, catalog.layout),
        })
      } catch (error) {
        if (isMissingPublicationRecord(error)) {
          states.push({ stored, execution_id: null, events: [] })
          continue
        }
        throw error
      }
    }
    return states
  }

  async claimExecutionForDispatch(
    artifactId: string,
    expectedArtifactSha256: string,
    initialDispatchEventData: PublicationInitialDispatchEventData,
  ): Promise<PublicationExecutionClaimResult> {
    const layout = this.records.ensureLayout()
    const storedArtifact = await this.artifacts.readArtifact(artifactId, expectedArtifactSha256)
    const claimedAt = this.now()
    if (Date.parse(storedArtifact.artifact.expires_at) <= claimedAt.getTime()) {
      throw publicationStoreError('publication artifact has expired before dispatch claim')
    }
    const executionId = randomUUID()
    const parsedClaim = PublicationExecutionClaimSchema.safeParse({
      artifact_id: storedArtifact.artifact.artifact_id,
      artifact_sha256: storedArtifact.artifact_sha256,
      execution_id: executionId,
      claimed_at: claimedAt.toISOString(),
    })
    if (!parsedClaim.success) {
      throw publicationStoreError('publication execution claim could not be constructed')
    }
    const initialEvent = this.initialDispatchEvent(
      executionId,
      storedArtifact.artifact.artifact_id,
      initialDispatchEventData,
    )
    const eventBytes = publicationRecordBytes(initialEvent)
    if (eventBytes.length > MAX_EVENT_BYTES) {
      throw publicationStoreError('publication execution event exceeds its byte limit')
    }

    const executionDirectory = path.join(layout.executions, executionId)
    this.records.createPrivateDirectory(executionDirectory, 'publication execution directory')
    const eventPath = path.join(executionDirectory, '000001.json')
    try {
      this.records.writeExclusive(executionDirectory, eventPath, eventBytes, 'publication execution event')
    } catch (error) {
      try {
        if (this.records.recordExists(eventPath)) this.records.removeRecord(eventPath)
        this.records.removeDirectory(executionDirectory)
        this.records.synchronizeDirectory(layout.executions)
      } catch (cleanupError) {
        throw publicationStoreError(`unclaimed publication execution cleanup failed after: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`)
      }
      throw error
    }

    try {
      this.records.writeExclusive(
        layout.claims,
        this.claimPath(artifactId, layout),
        publicationRecordBytes(parsedClaim.data),
        'publication execution claim',
      )
    } catch (error) {
      if (error instanceof ExclusiveRecordExistsError) {
        this.removePreparedExecution(executionDirectory, eventPath, layout)
        const winner = await this.readSettledWinningClaim(artifactId, layout)
        return { execution_id: winner.execution_id, created: false }
      }
      if (error instanceof ExclusiveRecordWriteError && !error.targetCreated) {
        this.removePreparedExecution(executionDirectory, eventPath, layout)
      }
      throw error
    }
    return { execution_id: parsedClaim.data.execution_id, created: true }
  }

  async executionForArtifact(artifactId: string): Promise<string | null> {
    const layout = this.records.ensureLayout()
    try {
      const claim = await this.readClaim(artifactId, layout)
      await this.readExecutionEventChain(claim.execution_id, claim, layout)
      return claim.execution_id
    } catch (error) {
      if (isMissingPublicationRecord(error)) return null
      throw error
    }
  }

  async appendExecutionEvent(eventInput: unknown): Promise<PublicationExecutionEvent> {
    let candidate = eventInput
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && !Object.hasOwn(candidate, 'event_sha256')) {
      const withoutDigest = candidate as Record<string, unknown>
      candidate = { ...withoutDigest, event_sha256: canonicalJsonSha256(withoutDigest) }
    }
    const parsed = PublicationExecutionEventSchema.safeParse(candidate)
    if (!parsed.success) {
      throw publicationStoreError('publication execution event does not match its strict contract')
    }
    if (parsed.data.sequence > MAX_EVENT_SEQUENCE) {
      throw publicationStoreError('publication execution event sequence exceeds storage capacity')
    }

    const layout = this.records.ensureLayout()
    const claim = await this.claimForExecution(parsed.data.execution_id, layout)
    if (claim.artifact_id !== parsed.data.artifact_id) {
      throw publicationStoreError('publication execution event artifact does not match its claim')
    }
    const existing = await this.readExecutionEventChain(parsed.data.execution_id, claim, layout)
    const previous = existing.at(-1)
    if (existing.length !== 1
      || previous?.status !== 'dispatching'
      || parsed.data.sequence !== 2
      || parsed.data.previous_event_sha256 !== previous.event_sha256) {
      throw publicationStoreError('publication execution event does not extend the current hash chain')
    }
    if (parsed.data.status !== 'succeeded' && parsed.data.status !== 'ambiguous') {
      throw publicationStoreError('publication execution event transition is invalid or terminal')
    }

    const bytes = publicationRecordBytes(parsed.data)
    if (bytes.length > MAX_EVENT_BYTES) {
      throw publicationStoreError('publication execution event exceeds its byte limit')
    }
    const directory = this.existingExecutionDirectory(parsed.data.execution_id, layout)
    const target = path.join(directory, '000002.json')
    try {
      this.records.writeExclusive(directory, target, bytes, 'publication execution event')
    } catch (error) {
      if (error instanceof ExclusiveRecordExistsError) {
        throw publicationStoreError('publication execution event transition is invalid or terminal')
      }
      throw error
    }
    return parsed.data
  }

  async readExecutionEvents(executionId: string): Promise<PublicationExecutionEvent[]> {
    const layout = this.records.ensureLayout()
    const claim = await this.claimForExecution(executionId, layout)
    return await this.readExecutionEventChain(executionId, claim, layout)
  }

  private claimPath(artifactId: string, layout: PublicationStoreLayout): string {
    return path.join(layout.claims, `${assertPublicationUuid(artifactId, 'artifact ID')}.json`)
  }

  private existingExecutionDirectory(executionId: string, layout: PublicationStoreLayout): string {
    const directory = path.join(layout.executions, assertPublicationUuid(executionId, 'execution ID'))
    return this.records.existingPrivateDirectory(directory)
  }

  private async readClaim(
    artifactId: string,
    layout = this.records.ensureLayout(),
    reservations?: ReadonlyMap<string, import('./publication-artifact-repository.ts').PublicationArtifactSlot>,
  ): Promise<PublicationExecutionClaim> {
    const claim = await this.records.readSettledState(() => (
      this.records.readPotentiallyIncompleteJsonRecord(
        this.claimPath(artifactId, layout),
        PublicationExecutionClaimSchema,
        'publication execution claim',
        MAX_CLAIM_BYTES,
      )
    ))
    const resolvedReservations = reservations ?? (
      await this.artifacts.readReservations(layout)
    ).byArtifactId
    if (claim.artifact_id !== artifactId) {
      throw publicationStoreError('publication execution claim identity does not match its record')
    }
    await this.artifacts.readArtifactWithReservation(
      artifactId,
      claim.artifact_sha256,
      layout,
      resolvedReservations,
    )
    return claim
  }

  private async readSettledWinningClaim(
    artifactId: string,
    layout: PublicationStoreLayout,
  ): Promise<PublicationExecutionClaim> {
    const reservations = (await this.artifacts.readReservations(layout)).byArtifactId
    const claim = await this.readClaim(artifactId, layout, reservations)
    await this.readExecutionEventChain(claim.execution_id, claim, layout)
    return claim
  }

  private initialDispatchEvent(
    executionId: string,
    artifactId: string,
    eventInput: unknown,
  ): PublicationExecutionEvent {
    const initial = InitialDispatchEventDataSchema.safeParse(eventInput)
    if (!initial.success) {
      throw publicationStoreError('initial publication dispatch event data is invalid')
    }
    const withoutDigest = {
      schema_version: PUBLICATION_SCHEMA_VERSION,
      execution_id: executionId,
      artifact_id: artifactId,
      sequence: 1,
      previous_event_sha256: null,
      occurred_at: initial.data.occurred_at,
      status: 'dispatching' as const,
      detail: initial.data.detail,
    }
    const candidate = { ...withoutDigest, event_sha256: canonicalJsonSha256(withoutDigest) }
    const parsed = PublicationExecutionEventSchema.safeParse(candidate)
    if (!parsed.success) {
      throw publicationStoreError('initial publication dispatch event does not match its strict contract')
    }
    return parsed.data
  }

  private removePreparedExecution(
    directory: string,
    eventPath: string,
    layout: PublicationStoreLayout,
  ): void {
    const names = this.records.listNames(directory)
    if (names.length !== 1 || names[0] !== path.basename(eventPath)) {
      throw publicationStoreError('unclaimed publication execution directory is not safe to remove')
    }
    this.records.removeRecord(eventPath)
    this.records.synchronizeDirectory(directory)
    this.records.removeDirectory(directory)
    this.records.synchronizeDirectory(layout.executions)
  }

  private async claimForExecution(
    executionId: string,
    layout = this.records.ensureLayout(),
  ): Promise<PublicationExecutionClaim> {
    assertPublicationUuid(executionId, 'execution ID')
    const names = this.records.listNames(layout.claims).sort(compareOrdinal)
    const reservations = (await this.artifacts.readReservations(layout)).byArtifactId
    let found: PublicationExecutionClaim | null = null
    for (const name of names) {
      const match = /^([a-fA-F0-9-]{36})\.json$/.exec(name)
      if (!match || !PublicationUuidSchema.safeParse(match[1]).success) {
        throw publicationStoreError('publication claim directory contains an invalid record')
      }
      const claim = await this.readClaim(match[1], layout, reservations)
      if (claim.execution_id !== executionId) continue
      if (found) throw publicationStoreError('publication execution has more than one claim')
      found = claim
    }
    if (!found) throw publicationStoreError('publication execution is not claimed')
    return found
  }

  private async readExecutionEventChain(
    executionId: string,
    claim: PublicationExecutionClaim,
    layout: PublicationStoreLayout,
  ): Promise<PublicationExecutionEvent[]> {
    const directory = this.existingExecutionDirectory(executionId, layout)
    const names = this.records.listNames(directory).sort(compareOrdinal)
    if (names.length === 0 || names.length > 2) {
      throw publicationStoreError(
        'publication execution event chain is missing its dispatch or extends a terminal event',
      )
    }

    const events: PublicationExecutionEvent[] = []
    let previous: string | null = null
    for (const [index, name] of names.entries()) {
      const match = /^([0-9]{6})\.json$/.exec(name)
      const expectedSequence = index + 1
      if (!match || Number(match[1]) !== expectedSequence) {
        throw publicationStoreError('publication execution event chain contains a gap or invalid record')
      }
      const event = await this.records.readSettledState(() => (
        this.records.readPotentiallyIncompleteJsonRecord(
          path.join(directory, name),
          PublicationExecutionEventSchema,
          'publication execution event',
          MAX_EVENT_BYTES,
        )
      ))
      if (event.sequence !== expectedSequence
        || event.execution_id !== executionId
        || event.artifact_id !== claim.artifact_id
        || event.previous_event_sha256 !== previous) {
        throw publicationStoreError('publication execution event chain is inconsistent')
      }
      const transitionIsValid = index === 0
        ? event.status === 'dispatching'
        : event.status === 'succeeded' || event.status === 'ambiguous'
      if (!transitionIsValid) {
        throw publicationStoreError('publication execution event transition is invalid or terminal')
      }
      events.push(event)
      previous = event.event_sha256
    }
    return events
  }
}
