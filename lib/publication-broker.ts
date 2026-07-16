import type { ToolContext } from '@opencode-ai/plugin'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  canonicalJsonSha256,
  stableCanonicalJson,
  type PublicationArtifact,
  type PublicationExecutionEvent,
} from './publication-contracts.ts'
import {
  executePublication,
  type PreparedPublicationPublisher,
  type PublicationExecutionResult,
  publicationPublisherIdentity,
  type PublicationPublisherIdentity,
  validatePublisher,
} from './publication-executor.ts'
import {
  buildPublicationGitSnapshot,
  PublicationGitSnapshotError,
  type PublicationGitSnapshot,
  type PublicationGitSnapshotInput,
} from './publication-git-snapshot.ts'
import { acquireProjectPublicationLease } from './project-mutation-lease.ts'
import {
  PUBLICATION_REQUEST_PROTOCOL,
  PUBLICATION_SCHEMA_VERSION,
} from './publication-policy.ts'
import { PublicationStore, type StoredPublicationArtifact } from './publication-store.ts'
import { throwIfAborted } from './tool-context.ts'
import type { AutomaticWorkflowState } from './workflow-engine.ts'
import {
  enabledPublication,
  type EnabledPublicationConfig,
  type PublicationConfig,
} from './workflow-config.ts'

interface PublicationWorkflowOwner {
  snapshot(): AutomaticWorkflowState
}

interface PublicationPermissionPolicy {
  assertPermissionAction(
    agent: string,
    permission: string,
    patterns: string[],
    expected: 'allow' | 'ask' | 'deny',
  ): Promise<void>
}

type PublicationTarget = EnabledPublicationConfig['targets'][string]
type SnapshotBuilder = (input: PublicationGitSnapshotInput) => Promise<PublicationGitSnapshot>
type PublisherValidator = typeof validatePublisher
type PublisherExecutor = typeof executePublication

interface PublicationBrokerOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  platform?: NodeJS.Platform
  snapshotBuilder?: SnapshotBuilder
  publisherValidator?: PublisherValidator
  publisherExecutor?: PublisherExecutor
  storeFactory?: (rootSessionId: string) => PublicationStore
}

interface PublicationGate {
  id: string
  status: 'passed' | 'failed'
  reason_code?: string
}

interface ValidatedPublicationExecution {
  config: EnabledPublicationConfig
  state: AutomaticWorkflowState
  store: PublicationStore
  stored: StoredPublicationArtifact
  artifact: PublicationArtifact & {
    publisher: PublicationPublisherIdentity
    snapshot: PublicationGitSnapshot
  }
  target: PublicationTarget
}

const EMPTY_EVENT_DETAIL = {
  exit_code: null,
  signal: null,
  duration_ms: 0,
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_sha256: null,
  stderr_sha256: null,
  output_truncated: false,
  output_redacted: false,
  request_acknowledged: false,
  forced_status: null,
  invocation_attempted: false,
  spawn_uncertain: false,
  termination_uncertain: false,
} as const

function assertOwnerContext(state: AutomaticWorkflowState, context: ToolContext, requireCompleted: boolean): void {
  if (state.root_session_id !== context.sessionID) throw new Error('publication belongs to another root session')
  if (path.resolve(state.directory) !== path.resolve(context.directory)
    || path.resolve(state.worktree) !== path.resolve(context.worktree)) {
    throw new Error('publication belongs to a different directory or worktree')
  }
  if (path.resolve(context.directory) !== path.resolve(context.worktree)) {
    throw new Error('publication requires the exact workflow worktree root')
  }
  if (requireCompleted && state.status !== 'completed') {
    throw new Error('publication requires a completed automatic workflow')
  }
}

function snapshotInput(
  state: AutomaticWorkflowState,
  target: PublicationTarget,
  config: EnabledPublicationConfig,
  signal: AbortSignal,
): PublicationGitSnapshotInput {
  return {
    worktree: state.worktree,
    git_executable: target.git_executable,
    base_ref: target.base_ref,
    head_ref: target.head_ref,
    remote: target.remote,
    expected_remote_url: target.expected_remote_url,
    destination_ref: target.destination_ref,
    command_timeout_ms: config.git_timeout_ms,
    limits: {
      max_commits: config.max_commits,
      max_objects: config.max_objects,
      max_blob_bytes: config.max_blob_bytes,
      max_total_scan_bytes: config.max_total_scan_bytes,
      max_findings: config.max_findings,
    },
    internal_markers: config.internal_markers,
    signal,
  }
}

function artifactSummary(artifact: PublicationArtifact, artifactSha256: string) {
  return {
    artifact_id: artifact.artifact_id,
    artifact_sha256: artifactSha256,
    status: artifact.status,
    created_at: artifact.created_at,
    expires_at: artifact.expires_at,
    target: artifact.target,
    publisher: artifact.publisher,
    gates: artifact.gates,
    source: artifact.snapshot ? {
      git_executable_identity_sha256: artifact.snapshot.source.git_executable_identity_sha256,
      base_ref: artifact.snapshot.source.base_ref,
      base_oid: artifact.snapshot.source.base_oid,
      head_ref: artifact.snapshot.source.head_ref,
      head_oid: artifact.snapshot.source.head_oid,
      tree_oid: artifact.snapshot.source.tree_oid,
      remote: artifact.snapshot.source.remote,
      remote_url: artifact.snapshot.source.remote_url,
      destination_ref: artifact.snapshot.target.destination_ref,
    } : null,
    scan_counts: artifact.snapshot?.scan_counts ?? null,
    findings: artifact.snapshot?.findings ?? [],
    protected_target_approval_required: artifact.target.protection === 'approval_required',
  }
}

function executionSummary(executionId: string, events: PublicationExecutionEvent[]) {
  const latest = events.at(-1)
  if (!latest) {
    return {
      execution_id: executionId,
      status: 'pending' as const,
      reconciliation_required: false,
    }
  }
  const status = latest.status === 'dispatching' ? 'ambiguous' : latest.status
  return {
    execution_id: executionId,
    status,
    persisted_status: latest.status,
    reconciliation_required: latest.status === 'dispatching' || latest.status === 'ambiguous',
    occurred_at: latest.occurred_at,
    detail: latest.detail,
  }
}

function resultDetail(result: PublicationExecutionResult) {
  return {
    exit_code: result.exit_code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    stdout_bytes: result.stdout_bytes,
    stderr_bytes: result.stderr_bytes,
    stdout_sha256: result.stdout_sha256,
    stderr_sha256: result.stderr_sha256,
    output_truncated: result.output_truncated,
    output_redacted: result.output_redacted,
    request_acknowledged: result.request_acknowledged,
    forced_status: result.forced_status,
    invocation_attempted: result.invocation_attempted,
    spawn_uncertain: result.spawn_uncertain,
    termination_uncertain: result.termination_uncertain,
  }
}

export class PublicationBroker {
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly snapshotBuilder: SnapshotBuilder
  private readonly publisherValidator: PublisherValidator
  private readonly publisherExecutor: PublisherExecutor
  private readonly storeFactory: (rootSessionId: string) => PublicationStore

  constructor(
    private readonly config: PublicationConfig,
    private readonly ownerForRootSession: (sessionId: string) => PublicationWorkflowOwner | undefined,
    private readonly permissionPolicy: (context: ToolContext) => PublicationPermissionPolicy,
    options: PublicationBrokerOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.snapshotBuilder = options.snapshotBuilder ?? buildPublicationGitSnapshot
    this.publisherValidator = options.publisherValidator ?? validatePublisher
    this.publisherExecutor = options.publisherExecutor ?? executePublication
    this.storeFactory = options.storeFactory ?? ((rootSessionId) => {
      const storeOptions = this.config.enabled
        ? {
            mode: 'read_write' as const,
            settlement: {
              attempts: this.config.record_settle_attempts,
              delay_ms: this.config.record_settle_delay_ms,
              timeout_ms: this.config.record_settle_timeout_ms,
            },
          }
        : { mode: 'read_only' as const }
      return new PublicationStore(rootSessionId, this.env, () => new Date(this.now()), storeOptions)
    })
  }

  async preview(targetId: string, context: ToolContext): Promise<string> {
    throwIfAborted(context)
    if (!this.config.enabled) {
      return JSON.stringify({ status: 'disabled', reason: 'publication.enabled is false in workflows.json' })
    }
    if (this.platform === 'win32') throw new Error('guarded publication is unavailable on Windows')
    const config = enabledPublication(this.config)
    const target = config.targets[targetId]
    if (!target) throw new Error(`publication target is not configured: ${targetId}`)
    const state = this.workflowState(context, true)

    await context.ask({
      permission: 'workflow_publication_preview',
      patterns: [`target:${targetId}`],
      always: [],
      metadata: {
        target: targetId,
        workflow_id: state.workflow_id,
        root_session_id: state.root_session_id,
      },
    })
    throwIfAborted(context)

    const release = acquireProjectPublicationLease(state.worktree)
    try {
      const gates: PublicationGate[] = [
        { id: 'workflow_completed', status: 'passed' },
        target.protection === 'deny'
          ? { id: 'target_allowed', status: 'failed', reason_code: 'target_denied' }
          : { id: 'target_allowed', status: 'passed' },
      ]
      let snapshot: PublicationGitSnapshot | null = null
      let publisher: PublicationPublisherIdentity | null = null
      if (target.protection !== 'deny') {
        try {
          publisher = publicationPublisherIdentity(this.publisherValidator(
            target.publisher,
            state.worktree,
            this.env,
            this.platform,
          ))
          gates.push({ id: 'publisher_descriptor', status: 'passed' })
        } catch {
          gates.push({ id: 'publisher_descriptor', status: 'failed', reason_code: 'publisher_invalid' })
        }
        try {
          snapshot = await this.snapshotBuilder(snapshotInput(state, target, config, context.abort))
          gates.push({ id: 'repository_snapshot', status: 'passed' })
          gates.push(snapshot.findings.length === 0
            ? { id: 'content_scrub', status: 'passed' }
            : { id: 'content_scrub', status: 'failed', reason_code: 'findings_detected' })
        } catch (error) {
          if (!(error instanceof PublicationGitSnapshotError)) throw error
          if (error.code === 'cancelled') {
            throwIfAborted(context)
            throw error
          }
          gates.push({ id: 'repository_snapshot', status: 'failed', reason_code: error.code })
          gates.push({ id: 'content_scrub', status: 'failed', reason_code: 'not_scanned' })
        }
      } else {
        gates.push({ id: 'publisher_descriptor', status: 'failed', reason_code: 'target_denied' })
        gates.push({ id: 'repository_snapshot', status: 'failed', reason_code: 'target_denied' })
        gates.push({ id: 'content_scrub', status: 'failed', reason_code: 'not_scanned' })
      }

      throwIfAborted(context)
      const createdAt = this.now()
      const artifact: PublicationArtifact = {
        schema_version: PUBLICATION_SCHEMA_VERSION,
        artifact_id: randomUUID(),
        status: snapshot && snapshot.findings.length === 0 && gates.every((gate) => gate.status === 'passed')
          ? 'ready'
          : 'blocked',
        created_at: new Date(createdAt).toISOString(),
        expires_at: new Date(createdAt + config.artifact_ttl_ms).toISOString(),
        workflow: { workflow_id: state.workflow_id, root_session_id: state.root_session_id },
        target: {
          id: targetId,
          display_name: target.display_name,
          protection: target.protection,
        },
        config_sha256: canonicalJsonSha256(config),
        gates,
        publisher,
        snapshot,
      }
      const stored = await this.storeFactory(state.root_session_id)
        .createArtifact(artifact, config.max_artifacts_per_workflow)
      return JSON.stringify(artifactSummary(stored.artifact, stored.artifact_sha256))
    } finally {
      release()
    }
  }

  async execute(artifactId: string, artifactSha256: string, context: ToolContext): Promise<string> {
    throwIfAborted(context)
    if (!this.config.enabled) throw new Error('publication is disabled in workflows.json')
    if (this.platform === 'win32') throw new Error('guarded publication is unavailable on Windows')
    const execution = await this.validatedExecution(artifactId, artifactSha256, context)
    const existingExecution = await execution.store.executionForArtifact(execution.artifact.artifact_id)
    if (existingExecution) {
      return JSON.stringify(executionSummary(
        existingExecution,
        await execution.store.readExecutionEvents(existingExecution),
      ))
    }

    const release = acquireProjectPublicationLease(execution.state.worktree)
    try {
      await this.assertSnapshotUnchanged(
        execution.state,
        execution.target,
        execution.config,
        execution.artifact.snapshot,
        context.abort,
      )
      await this.requestPublicationApprovals(execution, context)
      await this.assertSnapshotUnchanged(
        execution.state,
        execution.target,
        execution.config,
        execution.artifact.snapshot,
        context.abort,
      )
      this.assertNotExpired(execution.artifact)
      return this.dispatchPublication(execution, context)
    } finally {
      release()
    }
  }

  private async validatedExecution(
    artifactId: string,
    artifactSha256: string,
    context: ToolContext,
  ): Promise<ValidatedPublicationExecution> {
    const config = enabledPublication(this.config)
    const state = this.workflowState(context, true)
    const store = this.storeFactory(state.root_session_id)
    const stored = await store.readArtifact(artifactId, artifactSha256)
    const artifact = stored.artifact
    if (artifact.workflow.workflow_id !== state.workflow_id
      || artifact.workflow.root_session_id !== state.root_session_id) {
      throw new Error('publication artifact belongs to another workflow')
    }
    if (artifact.config_sha256 !== canonicalJsonSha256(config)) {
      throw new Error('publication configuration changed after preview')
    }
    if (artifact.status !== 'ready' || !artifact.publisher || !artifact.snapshot) {
      throw new Error('blocked publication artifacts cannot execute')
    }
    this.assertNotExpired(artifact)
    const target = config.targets[artifact.target.id]
    if (!target || target.protection === 'deny'
      || target.display_name !== artifact.target.display_name
      || target.protection !== artifact.target.protection) {
      throw new Error('publication target changed after preview')
    }
    const validatedArtifact = artifact as ValidatedPublicationExecution['artifact']
    this.assertPublisherUnchanged(validatedArtifact, target, state)
    return { config, state, store, stored, artifact: validatedArtifact, target }
  }

  private async requestApproval(
    permission: 'workflow_publication_external' | 'workflow_publication_protected',
    pattern: string,
    execution: ValidatedPublicationExecution,
    context: ToolContext,
    policy: PublicationPermissionPolicy,
  ): Promise<void> {
    await policy.assertPermissionAction(
      context.agent,
      permission,
      [pattern],
      'ask',
    )
    await context.ask({
      permission,
      patterns: [pattern],
      always: [],
      metadata: this.approvalMetadata(
        execution.artifact,
        execution.stored.artifact_sha256,
        execution.state,
      ),
    })
    throwIfAborted(context)
    this.assertNotExpired(execution.artifact)
  }

  private async requestPublicationApprovals(
    execution: ValidatedPublicationExecution,
    context: ToolContext,
  ): Promise<void> {
    const pattern = `target:${execution.artifact.target.id}:artifact:${execution.stored.artifact_sha256}`
    const policy = this.permissionPolicy(context)
    if (execution.target.protection === 'approval_required') {
      await this.requestApproval('workflow_publication_protected', pattern, execution, context, policy)
    }
    await this.requestApproval('workflow_publication_external', pattern, execution, context, policy)
  }

  private async dispatchPublication(
    execution: ValidatedPublicationExecution,
    context: ToolContext,
  ): Promise<string> {
    const { artifact, state, store, stored, target } = execution
    const prepared = this.assertPublisherUnchanged(artifact, target, state)
    const requestBytes = Buffer.from(stableCanonicalJson(this.executionRequest(
      stored.artifact_sha256,
      artifact,
      state,
    )), 'utf8')
    this.assertNotExpired(artifact)
    const claim = await store.claimExecutionForDispatch(
      artifact.artifact_id,
      stored.artifact_sha256,
      {
        occurred_at: new Date(this.now()).toISOString(),
        detail: EMPTY_EVENT_DETAIL,
      },
    )
    if (!claim.created) {
      return JSON.stringify(executionSummary(
        claim.execution_id,
        await store.readExecutionEvents(claim.execution_id),
      ))
    }
    try {
      const result = await this.publisherExecutor(prepared, requestBytes, context.abort)
      const status = result.status === 'succeeded' ? 'succeeded' : 'ambiguous'
      await this.appendEvent(store, claim.execution_id, artifact.artifact_id, status, resultDetail(result))
      return JSON.stringify(executionSummary(
        claim.execution_id,
        await store.readExecutionEvents(claim.execution_id),
      ))
    } catch (error) {
      const uncertainDetail = {
        ...EMPTY_EVENT_DETAIL,
        invocation_attempted: true,
        spawn_uncertain: true,
      }
      try {
        await this.appendEvent(store, claim.execution_id, artifact.artifact_id, 'ambiguous', uncertainDetail)
      } catch {
        throw new Error('publication outcome could not be persisted; manual reconciliation is required', { cause: error })
      }
      return JSON.stringify({
        ...executionSummary(claim.execution_id, await store.readExecutionEvents(claim.execution_id)),
        error_code: 'dispatch_uncertain',
      })
    }
  }

  private assertPublisherUnchanged(
    artifact: ValidatedPublicationExecution['artifact'],
    target: PublicationTarget,
    state: AutomaticWorkflowState,
  ): PreparedPublicationPublisher {
    const prepared = this.publisherValidator(target.publisher, state.worktree, this.env, this.platform)
    if (stableCanonicalJson(publicationPublisherIdentity(prepared)) !== stableCanonicalJson(artifact.publisher)) {
      throw new Error('publication publisher identity changed after preview')
    }
    return prepared
  }

  async status(artifactId: string | undefined, context: ToolContext): Promise<string> {
    const state = this.workflowState(context, false)
    const store = this.storeFactory(state.root_session_id)
    let artifacts
    if (artifactId) {
      const stored = await store.readArtifact(artifactId)
      const executionId = await store.executionForArtifact(stored.artifact.artifact_id)
      artifacts = [{
        stored,
        execution_id: executionId,
        events: executionId ? await store.readExecutionEvents(executionId) : [],
      }]
    } else {
      artifacts = await store.listArtifactStates()
    }
    return JSON.stringify({
      workflow_id: state.workflow_id,
      artifacts: artifacts.map(({ stored, execution_id: executionId, events }) => {
        return {
          ...artifactSummary(stored.artifact, stored.artifact_sha256),
          expired: Date.parse(stored.artifact.expires_at) <= this.now(),
          execution: executionId
            ? executionSummary(executionId, events)
            : null,
        }
      }),
    })
  }

  private workflowState(context: ToolContext, requireCompleted: boolean): AutomaticWorkflowState {
    const owner = this.ownerForRootSession(context.sessionID)
    if (!owner) throw new Error('publication requires an automatic workflow owned by the current root session')
    const state = owner.snapshot()
    assertOwnerContext(state, context, requireCompleted)
    return state
  }

  private async assertSnapshotUnchanged(
    state: AutomaticWorkflowState,
    target: PublicationTarget,
    config: EnabledPublicationConfig,
    expected: PublicationGitSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.snapshotBuilder(snapshotInput(state, target, config, signal))
    if (current.findings.length > 0 || current.snapshot_sha256 !== expected.snapshot_sha256) {
      throw new Error('publication source or scrub result changed after preview')
    }
  }

  private approvalMetadata(
    artifact: PublicationArtifact,
    artifactSha256: string,
    state: AutomaticWorkflowState,
  ) {
    return {
      artifact_id: artifact.artifact_id,
      artifact_sha256: artifactSha256,
      target: artifact.target.id,
      destination_ref: artifact.snapshot?.target.destination_ref,
      source_head: artifact.snapshot?.source.head_oid,
      publisher_descriptor_sha256: artifact.publisher?.descriptor_sha256,
      workflow_id: state.workflow_id,
      root_session_id: state.root_session_id,
    }
  }

  private executionRequest(
    artifactSha256: string,
    artifact: PublicationArtifact,
    state: AutomaticWorkflowState,
  ) {
    return {
      protocol: PUBLICATION_REQUEST_PROTOCOL,
      idempotency_key: artifactSha256,
      artifact_id: artifact.artifact_id,
      artifact_sha256: artifactSha256,
      workflow_id: state.workflow_id,
      worktree: state.worktree,
      source: artifact.snapshot?.source,
      target: {
        id: artifact.target.id,
        protection: artifact.target.protection,
        destination_ref: artifact.snapshot?.target.destination_ref,
      },
      publisher: artifact.publisher,
    }
  }

  private assertNotExpired(artifact: PublicationArtifact): void {
    if (Date.parse(artifact.expires_at) <= this.now()) throw new Error('publication artifact has expired')
  }

  private async appendEvent(
    store: PublicationStore,
    executionId: string,
    artifactId: string,
    status: PublicationExecutionEvent['status'],
    detail: PublicationExecutionEvent['detail'],
  ): Promise<PublicationExecutionEvent> {
    const existing = await store.readExecutionEvents(executionId)
    return store.appendExecutionEvent({
      schema_version: PUBLICATION_SCHEMA_VERSION,
      execution_id: executionId,
      artifact_id: artifactId,
      sequence: existing.length + 1,
      previous_event_sha256: existing.at(-1)?.event_sha256 ?? null,
      occurred_at: new Date(this.now()).toISOString(),
      status,
      detail,
    })
  }
}
