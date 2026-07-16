import path from 'node:path'

import { z } from 'zod'

import {
  compareOrdinal,
  type PublicationArtifact,
  PublicationArtifactSchema,
  PublicationUuidSchema,
  sha256Hex,
} from './publication-contracts.ts'
import {
  assertPublicationSha256,
  assertPublicationUuid,
  ExclusiveRecordExistsError,
  type PublicationStoreLayout,
  PublicationPrivateRecords,
  publicationRecordBytes,
  publicationStoreError,
} from './publication-private-record.ts'

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_SLOT_BYTES = 16 * 1024
const MAX_ARTIFACT_SLOTS = 999_999

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const DateTimeSchema = z.iso.datetime({ offset: true })

const PublicationArtifactSlotSchema = z.object({
  slot: z.number().int().positive().max(MAX_ARTIFACT_SLOTS),
  artifact_id: PublicationUuidSchema,
  artifact_sha256: Sha256Schema,
  reserved_at: DateTimeSchema,
}).strict()

export type PublicationArtifactSlot = z.infer<typeof PublicationArtifactSlotSchema>

export interface StoredPublicationArtifact {
  artifact: PublicationArtifact
  artifact_sha256: string
}

export interface PublicationArtifactSlotIndex {
  bySlot: ReadonlyMap<number, PublicationArtifactSlot>
  byArtifactId: ReadonlyMap<string, PublicationArtifactSlot>
}

export interface PublicationArtifactCatalog {
  layout: PublicationStoreLayout
  reservations: PublicationArtifactSlotIndex
  artifacts: StoredPublicationArtifact[]
}

export class PublicationArtifactRepository {
  constructor(
    private readonly records: PublicationPrivateRecords,
    private readonly now: () => Date,
  ) {}

  async createArtifact(artifactInput: unknown, maxArtifacts: number): Promise<StoredPublicationArtifact> {
    if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts <= 0 || maxArtifacts > MAX_ARTIFACT_SLOTS) {
      throw publicationStoreError('maximum artifact count must be a supported positive safe integer')
    }
    const parsed = PublicationArtifactSchema.safeParse(artifactInput)
    if (!parsed.success) throw publicationStoreError('publication artifact does not match its strict contract')
    const bytes = publicationRecordBytes(parsed.data)
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw publicationStoreError('publication artifact exceeds its byte limit')
    }

    const layout = this.records.ensureLayout()
    const digest = sha256Hex(bytes)
    await this.reserveArtifactSlot(parsed.data, digest, maxArtifacts, layout)
    try {
      this.records.writeExclusive(
        layout.artifacts,
        this.artifactPath(parsed.data.artifact_id, layout),
        bytes,
        'publication artifact',
      )
    } catch (error) {
      if (error instanceof ExclusiveRecordExistsError) {
        throw publicationStoreError('publication artifact already exists and is immutable')
      }
      throw error
    }
    return { artifact: parsed.data, artifact_sha256: digest }
  }

  async readArtifact(artifactId: string, expectedSha256?: string): Promise<StoredPublicationArtifact> {
    const layout = this.records.ensureLayout()
    const stored = await this.readArtifactRecord(artifactId, layout, expectedSha256)
    const slot = (await this.readReservations(layout)).byArtifactId.get(artifactId)
    if (!slot || slot.artifact_sha256 !== stored.artifact_sha256) {
      throw publicationStoreError('publication artifact does not have one valid capacity reservation')
    }
    return stored
  }

  async listArtifacts(): Promise<StoredPublicationArtifact[]> {
    return (await this.readCatalog()).artifacts
  }

  async readCatalog(): Promise<PublicationArtifactCatalog> {
    const layout = this.records.existingLayout()
    if (layout === null) {
      return {
        layout: this.records.layoutPaths(),
        reservations: { bySlot: new Map(), byArtifactId: new Map() },
        artifacts: [],
      }
    }
    const reservations = await this.readReservations(layout)
    return {
      layout,
      reservations,
      artifacts: await this.readArtifactRecords(layout, reservations.byArtifactId),
    }
  }

  async readReservations(layout: PublicationStoreLayout): Promise<PublicationArtifactSlotIndex> {
    const names = this.records.listNames(layout.artifactSlots).sort(compareOrdinal)
    const bySlot = new Map<number, PublicationArtifactSlot>()
    const byArtifactId = new Map<string, PublicationArtifactSlot>()
    for (const name of names) {
      const match = /^([0-9]{6})\.json$/.exec(name)
      const slot = match ? Number(match[1]) : Number.NaN
      if (!match || !Number.isSafeInteger(slot) || slot <= 0 || slot > MAX_ARTIFACT_SLOTS) {
        throw publicationStoreError('publication artifact slot directory contains an invalid record')
      }
      const record = await this.readSettledArtifactSlot(slot, layout)
      if (bySlot.has(slot) || byArtifactId.has(record.artifact_id)) {
        throw publicationStoreError('publication artifact slot state contains a duplicate reservation')
      }
      bySlot.set(slot, record)
      byArtifactId.set(record.artifact_id, record)
    }
    return { bySlot, byArtifactId }
  }

  async readArtifactWithReservation(
    artifactId: string,
    expectedSha256: string,
    layout: PublicationStoreLayout,
    reservations: ReadonlyMap<string, PublicationArtifactSlot>,
  ): Promise<StoredPublicationArtifact> {
    const stored = await this.readArtifactRecord(artifactId, layout, expectedSha256)
    if (reservations.get(artifactId)?.artifact_sha256 !== stored.artifact_sha256) {
      throw publicationStoreError('publication artifact does not have one valid capacity reservation')
    }
    return stored
  }

  private artifactPath(artifactId: string, layout: PublicationStoreLayout): string {
    return path.join(layout.artifacts, `${assertPublicationUuid(artifactId, 'artifact ID')}.json`)
  }

  private artifactSlotPath(slot: number, layout: PublicationStoreLayout): string {
    return path.join(layout.artifactSlots, `${String(slot).padStart(6, '0')}.json`)
  }

  private async readArtifactRecord(
    artifactId: string,
    layout: PublicationStoreLayout,
    expectedSha256?: string,
  ): Promise<StoredPublicationArtifact> {
    const bytes = await this.records.readSettledState(() => (
      this.records.readPotentiallyIncompleteRecord(
        this.artifactPath(artifactId, layout),
        'publication artifact',
        MAX_ARTIFACT_BYTES,
      )
    ))
    const digest = sha256Hex(bytes)
    if (expectedSha256 !== undefined
      && digest !== assertPublicationSha256(expectedSha256, 'expected artifact digest')) {
      throw publicationStoreError('publication artifact digest does not match')
    }
    const artifact = this.records.parseJsonRecord(bytes, PublicationArtifactSchema, 'publication artifact')
    if (artifact.artifact_id !== artifactId) {
      throw publicationStoreError('publication artifact identity does not match its record')
    }
    return { artifact, artifact_sha256: digest }
  }

  private readArtifactSlot(slot: number, layout: PublicationStoreLayout): PublicationArtifactSlot {
    const record = this.records.readPotentiallyIncompleteJsonRecord(
      this.artifactSlotPath(slot, layout),
      PublicationArtifactSlotSchema,
      'publication artifact slot',
      MAX_SLOT_BYTES,
    )
    if (record.slot !== slot) {
      throw publicationStoreError('publication artifact slot identity does not match its record')
    }
    return record
  }

  private readSettledArtifactSlot(
    slot: number,
    layout: PublicationStoreLayout,
  ): Promise<PublicationArtifactSlot> {
    return this.records.readSettledState(() => this.readArtifactSlot(slot, layout))
  }

  private async reserveArtifactSlot(
    artifact: PublicationArtifact,
    artifactSha256: string,
    maxArtifacts: number,
    layout: PublicationStoreLayout,
  ): Promise<void> {
    const existing = await this.readReservations(layout)
    if (existing.byArtifactId.has(artifact.artifact_id)) {
      throw publicationStoreError('publication artifact already exists and is immutable')
    }
    if ([...existing.bySlot.keys()].some((slot) => slot > maxArtifacts)) {
      throw publicationStoreError('maximum publication artifact count reached')
    }

    for (let slot = 1; slot <= maxArtifacts; slot += 1) {
      if (existing.bySlot.has(slot)) continue
      const reservation: PublicationArtifactSlot = {
        slot,
        artifact_id: artifact.artifact_id,
        artifact_sha256: artifactSha256,
        reserved_at: this.now().toISOString(),
      }
      try {
        this.records.writeExclusive(
          layout.artifactSlots,
          this.artifactSlotPath(slot, layout),
          publicationRecordBytes(reservation),
          'publication artifact slot',
        )
        return
      } catch (error) {
        if (!(error instanceof ExclusiveRecordExistsError)) throw error
        const winner = await this.readSettledArtifactSlot(slot, layout)
        if (winner.artifact_id === artifact.artifact_id) {
          throw publicationStoreError('publication artifact already exists and is immutable')
        }
      }
    }
    throw publicationStoreError('maximum publication artifact count reached')
  }

  private async readArtifactRecords(
    layout: PublicationStoreLayout,
    slots: ReadonlyMap<string, PublicationArtifactSlot>,
  ): Promise<StoredPublicationArtifact[]> {
    const names = this.records.listNames(layout.artifacts).sort(compareOrdinal)
    const artifacts: StoredPublicationArtifact[] = []
    for (const name of names) {
      const match = /^([a-fA-F0-9-]{36})\.json$/.exec(name)
      if (!match || !PublicationUuidSchema.safeParse(match[1]).success) {
        throw publicationStoreError('publication artifact directory contains an invalid record')
      }
      const stored = await this.readArtifactRecord(match[1], layout)
      if (slots.get(match[1])?.artifact_sha256 !== stored.artifact_sha256) {
        throw publicationStoreError('publication artifact does not have one valid capacity reservation')
      }
      artifacts.push(stored)
    }
    return artifacts
  }
}
