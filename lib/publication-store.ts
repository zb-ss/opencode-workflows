import {
  PublicationArtifactRepository,
  type StoredPublicationArtifact,
} from './publication-artifact-repository.ts'
import {
  PublicationExecutionRepository,
  type PublicationExecutionClaimResult,
  type PublicationInitialDispatchEventData,
  type StoredPublicationArtifactState,
} from './publication-execution-repository.ts'
import {
  PublicationPrivateRecords,
  type PublicationRecordSettlementPolicy,
  publicationStoreError,
} from './publication-private-record.ts'
import type { PublicationExecutionEvent } from './publication-contracts.ts'

export type { StoredPublicationArtifact } from './publication-artifact-repository.ts'
export type {
  PublicationExecutionClaim,
  PublicationExecutionClaimResult,
  PublicationInitialDispatchEventData,
  StoredPublicationArtifactState,
} from './publication-execution-repository.ts'
export { PublicationStoreError } from './publication-private-record.ts'

export type PublicationStoreOptions =
  | { mode: 'read_only' }
  | { mode: 'read_write'; settlement: PublicationRecordSettlementPolicy }

export class PublicationStore {
  readonly root: string
  private readonly artifacts: PublicationArtifactRepository
  private readonly executions: PublicationExecutionRepository
  private readonly isWritable: boolean

  constructor(
    readonly rootSessionId: string,
    env: NodeJS.ProcessEnv = process.env,
    now: () => Date = () => new Date(),
    options: PublicationStoreOptions,
  ) {
    const records = new PublicationPrivateRecords(
      rootSessionId,
      env,
      options.mode === 'read_write' ? options.settlement : null,
    )
    this.root = records.root
    this.isWritable = options.mode === 'read_write'
    this.artifacts = new PublicationArtifactRepository(records, now)
    this.executions = new PublicationExecutionRepository(records, this.artifacts, now)
  }

  async createArtifact(artifactInput: unknown, maxArtifacts: number): Promise<StoredPublicationArtifact> {
    this.assertWritable()
    return this.artifacts.createArtifact(artifactInput, maxArtifacts)
  }

  async readArtifact(artifactId: string, expectedSha256?: string): Promise<StoredPublicationArtifact> {
    return this.artifacts.readArtifact(artifactId, expectedSha256)
  }

  async listArtifacts(): Promise<StoredPublicationArtifact[]> {
    return this.artifacts.listArtifacts()
  }

  async listArtifactStates(): Promise<StoredPublicationArtifactState[]> {
    return this.executions.listArtifactStates(await this.artifacts.readCatalog())
  }

  async claimExecutionForDispatch(
    artifactId: string,
    expectedArtifactSha256: string,
    initialDispatchEventData: PublicationInitialDispatchEventData,
  ): Promise<PublicationExecutionClaimResult> {
    this.assertWritable()
    return this.executions.claimExecutionForDispatch(
      artifactId,
      expectedArtifactSha256,
      initialDispatchEventData,
    )
  }

  async executionForArtifact(artifactId: string): Promise<string | null> {
    return this.executions.executionForArtifact(artifactId)
  }

  async appendExecutionEvent(eventInput: unknown): Promise<PublicationExecutionEvent> {
    this.assertWritable()
    return this.executions.appendExecutionEvent(eventInput)
  }

  async readExecutionEvents(executionId: string): Promise<PublicationExecutionEvent[]> {
    return this.executions.readExecutionEvents(executionId)
  }

  private assertWritable(): void {
    if (!this.isWritable) throw publicationStoreError('publication store is open for status reads only')
  }
}
