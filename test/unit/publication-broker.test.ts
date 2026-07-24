import type { ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { PublicationBroker } from '../../lib/publication-broker.ts'
import { canonicalJsonSha256 } from '../../lib/publication-contracts.ts'
import type {
  PreparedPublicationPublisher,
  PublicationExecutionResult,
  PublicationPublisherIdentity,
} from '../../lib/publication-executor.ts'
import {
  PublicationGitSnapshotError,
  type PublicationGitSnapshot,
} from '../../lib/publication-git-snapshot.ts'
import { PublicationStore } from '../../lib/publication-store.ts'
import type { AutomaticWorkflowState } from '../../lib/workflow-engine.ts'
import { WorkflowConfigSchema, type PublicationConfig } from '../../lib/workflow-config.ts'

const NOW = Date.parse('2026-07-15T12:00:00.000Z')
const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const PUBLISHER_IDENTITY = {
  argv_sha256: HASH_A,
  environment_sha256: HASH_A,
  executable_identity_sha256: HASH_A,
  working_directory_identity_sha256: HASH_A,
  descriptor_sha256: HASH_A,
} as const
const SETTLEMENT = { attempts: 200, delay_ms: 5, timeout_ms: 1000 }
const STORE_OPTIONS = { mode: 'read_write' as const, settlement: SETTLEMENT }
const temporaryDirectories = new Set<string>()

function preparedPublisher(
  root: string,
  digests: PublicationPublisherIdentity,
): PreparedPublicationPublisher {
  return {
    schema_version: 1,
    platform: process.platform,
    worktree: root,
    configured_executable: '/usr/bin/node',
    executable: '/usr/bin/node',
    argv: ['/usr/bin/node', '{request_file}'],
    working_directory: root,
    environment: Object.freeze({ PATH: '/usr/bin' }),
    trusted_path: '/usr/bin',
    timeout_ms: 1000,
    max_output_bytes: 1024,
    success_exit_codes: [0],
    executable_identity: {
      device: '1',
      inode: '1',
      mode: 0o755,
      owner: '0',
      group: '0',
      size: '1',
      modified_ns: '1',
      changed_ns: '1',
    },
    working_directory_identity: {
      device: '1',
      inode: '2',
      mode: 0o700,
      owner: '1000',
      group: '1000',
    },
    digests,
  }
}

function publicationConfig(protection: 'deny' | 'approval_required' | 'unprotected' = 'unprotected'): PublicationConfig {
  return WorkflowConfigSchema.parse({
    publication: {
      enabled: true,
      artifact_ttl_ms: 60_000,
      git_timeout_ms: 1000,
      max_artifacts_per_workflow: 10,
      max_commits: 10,
      max_objects: 100,
      max_blob_bytes: 1024,
      max_total_scan_bytes: 10_000,
      max_findings: 10,
      record_settle_attempts: SETTLEMENT.attempts,
      record_settle_delay_ms: SETTLEMENT.delay_ms,
      record_settle_timeout_ms: SETTLEMENT.timeout_ms,
      internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
      targets: {
        public: {
          display_name: 'Public destination',
          git_executable: '/usr/bin/git',
          base_ref: 'refs/heads/base',
          head_ref: 'refs/heads/main',
          remote: 'origin',
          expected_remote_url: 'https://example.invalid/repository.git',
          destination_ref: 'refs/heads/main',
          protection,
          publisher: {
            argv: ['/usr/bin/node', '{request_file}'],
            working_directory: '.',
            environment: [],
            timeout_ms: 1000,
            max_output_bytes: 1024,
            success_exit_codes: [0],
          },
        },
      },
    },
  }).publication
}

function snapshot(findings: PublicationGitSnapshot['findings'] = [], headOid = OID_B): PublicationGitSnapshot {
  const withoutDigest = {
    schema_version: 1,
    source: {
      git_executable_identity_sha256: HASH_A,
      repository_identity_sha256: HASH_A,
      git_common_dir_sha256: HASH_B,
      object_format: 'sha1' as const,
      base_ref: 'refs/heads/base',
      base_oid: OID_A,
      head_ref: 'refs/heads/main',
      head_oid: headOid,
      tree_oid: OID_C,
      remote: 'origin',
      remote_url: 'https://example.invalid/repository.git',
    },
    target: { destination_ref: 'refs/heads/main' },
    scan_policy: {
      version: 'publication-scan-v1',
      limits: {
        max_commits: 10,
        max_objects: 100,
        max_blob_bytes: 1024,
        max_total_scan_bytes: 10_000,
        max_findings: 10,
      },
      internal_markers_sha256: HASH_A,
    },
    scan_counts: {
      commits: 1,
      objects: 3,
      blobs: 1,
      paths: 1,
      bytes: 100,
      findings: findings.length,
    },
    findings,
  }
  return { ...withoutDigest, snapshot_sha256: canonicalJsonSha256(withoutDigest) }
}

function workflowState(root: string, status: AutomaticWorkflowState['status'] = 'completed'): AutomaticWorkflowState {
  return {
    schema_version: 2,
    workflow_id: 'wf-publication',
    definition_id: 'development',
    definition_path: path.join(root, 'definition.json'),
    root_session_id: 'root-session',
    directory: root,
    worktree: root,
    mode: 'standard',
    autonomy: 'bounded',
    task: 'Prepare a public change',
    status,
    pause_reason: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    stages: {},
    budget: {
      limits: {
        max_sessions: 1,
        max_parallel_sessions: 1,
        max_attempts_per_stage: 1,
        max_calendar_age_ms: 1000,
        max_active_time_ms: null,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_bounded_read_bytes: 0,
        max_bounded_write_bytes: 0,
        max_validation_runs: 0,
        max_cost_usd: null,
      },
      usage: {
        sessions: 0,
        attempts: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        bounded_read_bytes: 0,
        bounded_write_bytes: 0,
        validation_runs: 0,
        active_time_ms: 0,
        active_interval_started_at: null,
        last_active_checkpoint_at: null,
        messages: {},
      },
    },
  }
}

const SUCCESS: PublicationExecutionResult = {
  status: 'succeeded',
  exit_code: 0,
  signal: null,
  forced_status: null,
  duration_ms: 5,
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_sha256: HASH_A,
  stderr_sha256: HASH_A,
  output_truncated: false,
  output_sensitive: false,
  stdout_sensitive: false,
  stderr_sensitive: false,
  output_redacted: false,
  request_acknowledged: true,
  invocation_attempted: true,
  spawn_uncertain: false,
  termination_uncertain: false,
}

function fixture(options: {
  config?: PublicationConfig
  stateStatus?: AutomaticWorkflowState['status']
  snapshots?: Array<PublicationGitSnapshot | Error>
  permissionAction?: 'allow' | 'ask' | 'deny'
  executionResult?: PublicationExecutionResult
  publisherValidationNow?: number
  publisherValidations?: Array<PublicationPublisherIdentity | Error>
  abortDuringSnapshot?: boolean
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-broker-'))
  temporaryDirectories.add(root)
  const configDirectory = path.join(root, 'config')
  fs.mkdirSync(configDirectory)
  const state = workflowState(root, options.stateStatus)
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
  let currentNow = NOW
  const store = new PublicationStore(state.root_session_id, env, () => new Date(currentNow), STORE_OPTIONS)
  const permissionRequests: Array<{ permission: string; patterns: string[]; always: string[] }> = []
  const permissionChecks: Array<{ permission: string; expected: string }> = []
  const configuredAction = options.permissionAction ?? 'ask'
  const snapshots = [...(options.snapshots ?? [snapshot()])]
  let snapshotCalls = 0
  let executionCalls = 0
  let publisherValidationCalls = 0
  const abortController = new AbortController()
  const broker = new PublicationBroker(
    options.config ?? publicationConfig(),
    sessionId => sessionId === state.root_session_id ? { snapshot: () => structuredClone(state) } : undefined,
    () => ({
      async assertPermissionAction(_agent, permission, _patterns, expected) {
        permissionChecks.push({ permission, expected })
        if (configuredAction !== expected) {
          throw new Error(`${permission} must resolve to ${expected}; resolved action is ${configuredAction}`)
        }
      },
    }),
    {
      env,
      now: () => currentNow,
      platform: process.platform,
      storeFactory: () => store,
      snapshotBuilder: async () => {
        const value = snapshots[Math.min(snapshotCalls++, snapshots.length - 1)]
        if (value instanceof Error) throw value
        if (options.abortDuringSnapshot) abortController.abort(new Error('preview cancelled after snapshot'))
        return structuredClone(value)
      },
      publisherValidator: () => {
        const validation = options.publisherValidations?.[
          Math.min(publisherValidationCalls, options.publisherValidations.length - 1)
        ] ?? PUBLISHER_IDENTITY
        publisherValidationCalls++
        if (options.publisherValidationNow !== undefined && publisherValidationCalls >= 3) {
          currentNow = options.publisherValidationNow
        }
        if (validation instanceof Error) throw validation
        return preparedPublisher(root, validation)
      },
      publisherExecutor: async () => {
        executionCalls++
        return options.executionResult ?? SUCCESS
      },
    },
  )
  const context: ToolContext = {
    sessionID: state.root_session_id,
    messageID: 'message',
    agent: 'supervisor',
    directory: root,
    worktree: root,
    abort: abortController.signal,
    metadata() {},
    async ask(request) { permissionRequests.push(request) },
  }
  return {
    broker,
    context,
    env,
    permissionChecks,
    permissionRequests,
    state,
    store,
    snapshotCalls: () => snapshotCalls,
    executionCalls: () => executionCalls,
    publisherValidationCalls: () => publisherValidationCalls,
    setNow: (value: number) => { currentNow = value },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('PublicationBroker', () => {
  it('previews, separately approves, executes once, and reports the durable result', async () => {
    const test = fixture({ snapshots: [snapshot(), snapshot(), snapshot()] })
    const preview = JSON.parse(await test.broker.preview('public', test.context))
    assert.equal(preview.status, 'ready')
    assert.equal(preview.source.head_oid, OID_B)
    assert.deepEqual(preview.publisher, PUBLISHER_IDENTITY)
    assert.deepEqual(test.permissionRequests.map(request => request.permission), ['workflow_publication_preview'])

    const execution = JSON.parse(await test.broker.execute(
      preview.artifact_id,
      preview.artifact_sha256,
      test.context,
    ))
    assert.equal(execution.status, 'succeeded')
    assert.equal(test.executionCalls(), 1)
    assert.equal(test.snapshotCalls(), 3)
    assert.deepEqual(test.permissionChecks, [{ permission: 'workflow_publication_external', expected: 'ask' }])
    assert.deepEqual(test.permissionRequests.map(request => request.permission), [
      'workflow_publication_preview',
      'workflow_publication_external',
    ])
    assert.deepEqual(test.permissionRequests[1].always, [])

    const repeated = JSON.parse(await test.broker.execute(
      preview.artifact_id,
      preview.artifact_sha256,
      test.context,
    ))
    assert.equal(repeated.execution_id, execution.execution_id)
    assert.equal(test.executionCalls(), 1)
    assert.equal(test.permissionRequests.length, 2)

    const status = JSON.parse(await test.broker.status(preview.artifact_id, test.context))
    assert.equal(status.artifacts[0].execution.status, 'succeeded')
    assert.equal(status.artifacts[0].artifact_sha256, preview.artifact_sha256)

    const disabled = new PublicationBroker(
      WorkflowConfigSchema.parse({ publication: { enabled: false } }).publication,
      sessionId => sessionId === test.state.root_session_id
        ? { snapshot: () => structuredClone(test.state) }
        : undefined,
      () => ({ async assertPermissionAction() {} }),
      { env: test.env, now: () => NOW },
    )
    const disabledStatus = JSON.parse(await disabled.status(preview.artifact_id, test.context))
    assert.equal(disabledStatus.artifacts[0].execution.status, 'succeeded')
    assert.equal(disabledStatus.artifacts[0].artifact_sha256, preview.artifact_sha256)
  })

  it('requires independent protected and external asks and invalidates changed source after approval', async () => {
    const changed = snapshot([], 'd'.repeat(40))
    const test = fixture({
      config: publicationConfig('approval_required'),
      snapshots: [snapshot(), snapshot(), changed],
    })
    const preview = JSON.parse(await test.broker.preview('public', test.context))
    await assert.rejects(
      test.broker.execute(preview.artifact_id, preview.artifact_sha256, test.context),
      /changed after preview/,
    )
    assert.deepEqual(test.permissionChecks.map(check => check.permission), [
      'workflow_publication_protected',
      'workflow_publication_external',
    ])
    assert.deepEqual(test.permissionRequests.map(request => request.permission), [
      'workflow_publication_preview',
      'workflow_publication_protected',
      'workflow_publication_external',
    ])
    assert.equal(await test.store.executionForArtifact(preview.artifact_id), null)
    assert.equal(test.executionCalls(), 0)
  })

  it('rejects silent external authority before claiming or dispatching', async () => {
    const test = fixture({ permissionAction: 'allow', snapshots: [snapshot(), snapshot()] })
    const preview = JSON.parse(await test.broker.preview('public', test.context))
    await assert.rejects(
      test.broker.execute(preview.artifact_id, preview.artifact_sha256, test.context),
      /resolved action is allow/,
    )
    assert.equal(await test.store.executionForArtifact(preview.artifact_id), null)
    assert.equal(test.executionCalls(), 0)
  })

  it('persists blocked previews for findings, unsafe repositories, and denied targets', async () => {
    const finding = {
      rule_id: 'credential.secret_assignment',
      category: 'credential' as const,
      source_kind: 'git_blob' as const,
      location_identity: 'blob:fixture',
      fingerprint: HASH_A,
    }
    const sensitive = fixture({ snapshots: [snapshot([finding])] })
    const sensitivePreview = JSON.parse(await sensitive.broker.preview('public', sensitive.context))
    assert.equal(sensitivePreview.status, 'blocked')
    assert.equal(sensitivePreview.findings.length, 1)
    await assert.rejects(
      sensitive.broker.execute(sensitivePreview.artifact_id, sensitivePreview.artifact_sha256, sensitive.context),
      /blocked publication artifacts/,
    )

    const dirty = fixture({
      snapshots: [new PublicationGitSnapshotError('dirty_worktree', 'private detail must not escape')],
    })
    const dirtyPreview = JSON.parse(await dirty.broker.preview('public', dirty.context))
    assert.equal(dirtyPreview.status, 'blocked')
    assert.equal(dirtyPreview.gates.some((gate: any) => gate.reason_code === 'dirty_worktree'), true)
    assert.doesNotMatch(JSON.stringify(dirtyPreview), /private detail/)

    const denied = fixture({ config: publicationConfig('deny') })
    const deniedPreview = JSON.parse(await denied.broker.preview('public', denied.context))
    assert.equal(deniedPreview.status, 'blocked')
    assert.equal(denied.snapshotCalls(), 0)

    const invalidPublisher = fixture({ publisherValidations: [new Error('private publisher failure')] })
    const invalidPreview = JSON.parse(await invalidPublisher.broker.preview('public', invalidPublisher.context))
    assert.equal(invalidPreview.status, 'blocked')
    assert.equal(invalidPreview.publisher, null)
    assert.equal(invalidPreview.gates.some((gate: any) => gate.reason_code === 'publisher_invalid'), true)
    assert.doesNotMatch(JSON.stringify(invalidPreview), /private publisher failure/)
  })

  it('does not persist or consume capacity when snapshot construction is cancelled', async () => {
    const test = fixture({
      snapshots: [new PublicationGitSnapshotError('cancelled', 'publication snapshot was cancelled')],
    })

    await assert.rejects(test.broker.preview('public', test.context), /cancelled/)
    assert.deepEqual(await test.store.listArtifacts(), [])
    assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'artifact-slots')), [])

    const abortedAfterSnapshot = fixture({ abortDuringSnapshot: true })
    await assert.rejects(
      abortedAfterSnapshot.broker.preview('public', abortedAfterSnapshot.context),
      /cancelled after snapshot/,
    )
    assert.deepEqual(await abortedAfterSnapshot.store.listArtifacts(), [])
    assert.deepEqual(
      fs.readdirSync(path.join(abortedAfterSnapshot.store.root, 'artifact-slots')),
      [],
    )
  })

  it('rejects publisher identity replacement after approval before claiming', async () => {
    const changedIdentity = { ...PUBLISHER_IDENTITY, descriptor_sha256: HASH_B }
    const test = fixture({
      snapshots: [snapshot(), snapshot(), snapshot()],
      publisherValidations: [PUBLISHER_IDENTITY, PUBLISHER_IDENTITY, changedIdentity],
    })
    const preview = JSON.parse(await test.broker.preview('public', test.context))

    await assert.rejects(
      test.broker.execute(preview.artifact_id, preview.artifact_sha256, test.context),
      /publisher identity changed after preview/,
    )
    assert.equal(test.publisherValidationCalls(), 3)
    assert.equal(await test.store.executionForArtifact(preview.artifact_id), null)
    assert.equal(test.executionCalls(), 0)
  })

  it('reports ambiguous dispatch and refuses workflows or contexts outside the completed root', async () => {
    const ambiguous = fixture({
      snapshots: [snapshot(), snapshot(), snapshot()],
      executionResult: { ...SUCCESS, status: 'ambiguous', forced_status: 'timed_out' },
    })
    const preview = JSON.parse(await ambiguous.broker.preview('public', ambiguous.context))
    const result = JSON.parse(await ambiguous.broker.execute(
      preview.artifact_id,
      preview.artifact_sha256,
      ambiguous.context,
    ))
    assert.equal(result.status, 'ambiguous')
    assert.equal(result.reconciliation_required, true)
    assert.equal(result.detail.forced_status, 'timed_out')
    assert.equal(result.detail.invocation_attempted, true)

    const running = fixture({ stateStatus: 'running' })
    await assert.rejects(running.broker.preview('public', running.context), /completed automatic workflow/)

    const wrongRoot = fixture()
    await assert.rejects(
      wrongRoot.broker.preview('public', { ...wrongRoot.context, sessionID: 'child-session' }),
      /owned by the current root session/,
    )
    await assert.rejects(
      wrongRoot.broker.preview('public', { ...wrongRoot.context, directory: path.join(wrongRoot.context.directory, 'subdir') }),
      /different directory or worktree/,
    )
  })

  it('rechecks artifact expiry after approval before creating a dispatch claim', async () => {
    const test = fixture({ snapshots: [snapshot(), snapshot()] })
    const preview = JSON.parse(await test.broker.preview('public', test.context))
    const originalAsk = test.context.ask.bind(test.context)
    test.context.ask = async (request) => {
      await originalAsk(request)
      if (request.permission === 'workflow_publication_external') test.setNow(NOW + 60_001)
    }

    await assert.rejects(
      test.broker.execute(preview.artifact_id, preview.artifact_sha256, test.context),
      /artifact has expired/,
    )
    assert.equal(await test.store.executionForArtifact(preview.artifact_id), null)
    assert.equal(test.executionCalls(), 0)
  })

  it('rechecks artifact expiry after final publisher validation and inside the claim', async () => {
    const test = fixture({
      snapshots: [snapshot(), snapshot()],
      publisherValidationNow: NOW + 60_001,
    })
    const preview = JSON.parse(await test.broker.preview('public', test.context))

    await assert.rejects(
      test.broker.execute(preview.artifact_id, preview.artifact_sha256, test.context),
      /artifact has expired/,
    )
    assert.equal(await test.store.executionForArtifact(preview.artifact_id), null)
    assert.equal(test.executionCalls(), 0)
  })
})
