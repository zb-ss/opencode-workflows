import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'

import {
  canonicalJsonSha256,
  type PublicationArtifact,
  PublicationArtifactSchema,
  type PublicationExecutionEvent,
  type PublicationExecutionEventInput,
  PublicationExecutionEventSchema,
  publicationArtifactJsonSchema,
  publicationExecutionEventJsonSchema,
  publicationExecutionEventSha256,
  sha256Hex,
} from '../../lib/publication-contracts.ts'
import { getSessionRuntimeDir } from '../../lib/paths.ts'
import { PublicationStore, type PublicationStoreOptions } from '../../lib/publication-store.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)
const NOW = new Date('2026-07-15T12:00:00.000Z')
const WORKER = fileURLToPath(new URL('../fixtures/publication-claim-worker.ts', import.meta.url))
const PUBLISHER_IDENTITY = {
  argv_sha256: HASH_A,
  environment_sha256: HASH_A,
  executable_identity_sha256: HASH_A,
  working_directory_identity_sha256: HASH_A,
  descriptor_sha256: HASH_A,
} as const
const SETTLEMENT = { attempts: 200, delay_ms: 5, timeout_ms: 1000 }
const STORE_OPTIONS = { mode: 'read_write' as const, settlement: SETTLEMENT }

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

const SUCCESS_EVENT_DETAIL = {
  ...EMPTY_EVENT_DETAIL,
  exit_code: 0,
  stdout_sha256: HASH_A,
  stderr_sha256: HASH_A,
  invocation_attempted: true,
  request_acknowledged: true,
} as const

interface WorkerResult {
  ok: boolean
  result?: {
    execution_id?: string
    created?: boolean
    artifact?: PublicationArtifact
  }
  error?: string
}

function snapshot(findings: Array<{
  rule_id: string
  category: 'credential'
  source_kind: 'git_blob'
  location_identity: string
  fingerprint: string
}> = []) {
  const withoutDigest = {
    schema_version: 1 as const,
    source: {
      git_executable_identity_sha256: HASH_A,
      repository_identity_sha256: HASH_A,
      git_common_dir_sha256: HASH_B,
      object_format: 'sha1' as const,
      base_ref: 'refs/heads/main',
      base_oid: OID_A,
      head_ref: 'refs/heads/publication',
      head_oid: OID_B,
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

function artifact(overrides: Partial<PublicationArtifact> = {}): PublicationArtifact {
  return PublicationArtifactSchema.parse({
    schema_version: 1,
    artifact_id: randomUUID(),
    status: 'ready',
    created_at: '2026-07-15T12:00:00.000Z',
    expires_at: '2026-07-16T12:00:00.000Z',
    workflow: { workflow_id: 'wf-publication', root_session_id: 'root-session' },
    target: { id: 'public-origin', display_name: 'Public origin', protection: 'unprotected' },
    config_sha256: HASH_A,
    gates: [{ id: 'review', status: 'passed' }],
    publisher: PUBLISHER_IDENTITY,
    snapshot: snapshot(),
    ...overrides,
  })
}

function executionEvent(
  executionId: string,
  artifactId: string,
  sequence: number,
  previousEventSha256: string | null,
  status: PublicationExecutionEvent['status'] = 'dispatching',
): PublicationExecutionEvent {
  const input: PublicationExecutionEventInput = {
    schema_version: 1,
    execution_id: executionId,
    artifact_id: artifactId,
    sequence,
    previous_event_sha256: previousEventSha256,
    occurred_at: `2026-07-15T12:00:0${sequence}.000Z`,
    status,
    detail: status === 'succeeded' ? SUCCESS_EVENT_DETAIL : EMPTY_EVENT_DETAIL,
  }
  return { ...input, event_sha256: publicationExecutionEventSha256(input) }
}

function fixture(prefix: string, options: PublicationStoreOptions = STORE_OPTIONS) {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
  const store = new PublicationStore('root-session', env, () => NOW, options)
  return {
    configDirectory,
    env,
    store,
    cleanup: () => fs.rmSync(configDirectory, { recursive: true, force: true }),
  }
}

async function createClaimedArtifact(store: PublicationStore) {
  const created = await store.createArtifact(artifact(), 10)
  const claim = await store.claimExecutionForDispatch(
    created.artifact.artifact_id,
    created.artifact_sha256,
    { occurred_at: '2026-07-15T12:00:01.000Z', detail: EMPTY_EVENT_DETAIL },
  )
  assert.equal(claim.created, true)
  const dispatching = (await store.readExecutionEvents(claim.execution_id))[0]
  return { ...created, executionId: claim.execution_id, dispatching }
}

function recursiveNames(directory: string, prefix = ''): string[] {
  const names: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    names.push(relative)
    if (entry.isDirectory()) names.push(...recursiveNames(path.join(directory, entry.name), relative))
  }
  return names
}

function runWorker(arguments_: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, ...arguments_], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`publication worker exited ${String(code)}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult)
      } catch (error) {
        reject(new Error(`publication worker returned invalid JSON: ${stdout}`, { cause: error }))
      }
    })
  })
}

function replaceFsync(replacement: typeof fs.fsyncSync): () => void {
  const original = fs.fsyncSync
  Object.defineProperty(fs, 'fsyncSync', { configurable: true, value: replacement, writable: true })
  return () => Object.defineProperty(fs, 'fsyncSync', {
    configurable: true,
    value: original,
    writable: true,
  })
}

describe('publication contracts', () => {
  it('keeps structural schemas aligned and enforces semantic contracts at runtime', () => {
    const artifactSchema = JSON.parse(fs.readFileSync(path.resolve('schema/publication-artifact.schema.json'), 'utf8'))
    const eventSchema = JSON.parse(fs.readFileSync(path.resolve('schema/publication-execution-event.schema.json'), 'utf8'))
    assert.deepEqual(artifactSchema, publicationArtifactJsonSchema())
    assert.deepEqual(eventSchema, publicationExecutionEventJsonSchema())

    const AjvConstructor = Ajv2020 as unknown as new (options: object) => {
      compile(schema: object): (input: unknown) => boolean
    }
    const ajv = new AjvConstructor({ strict: true, formats: { 'date-time': true } })
    const validateArtifactStructure = ajv.compile(artifactSchema)
    const validateEventStructure = ajv.compile(eventSchema)
    assert.equal(validateArtifactStructure(artifact()), true)
    assert.equal(validateEventStructure(executionEvent(randomUUID(), randomUUID(), 1, null)), true)

    const wrongOidWidth = artifact()
    wrongOidWidth.snapshot!.source.base_oid = 'a'.repeat(64)
    assert.equal(validateArtifactStructure(wrongOidWidth), false)

    const pathlessRemote = artifact()
    const { snapshot_sha256: _snapshotDigest, ...snapshotWithoutDigest } = pathlessRemote.snapshot!
    const pathlessSnapshot = {
      ...snapshotWithoutDigest,
      source: { ...snapshotWithoutDigest.source, remote_url: 'ssh://example.invalid' },
    }
    pathlessRemote.snapshot = {
      ...pathlessSnapshot,
      snapshot_sha256: canonicalJsonSha256(pathlessSnapshot),
    }
    assert.equal(PublicationArtifactSchema.safeParse(pathlessRemote).success, false)

    const valid = artifact()
    assert.equal(PublicationArtifactSchema.safeParse({ ...valid, unexpected: true }).success, false)
    assert.equal(PublicationArtifactSchema.safeParse({ ...valid, snapshot: null }).success, false)
    assert.equal(PublicationArtifactSchema.safeParse({
      ...valid,
      gates: [{ id: 'review', status: 'failed' }],
    }).success, false)
    assert.equal(PublicationArtifactSchema.safeParse({
      ...valid,
      status: 'blocked',
      snapshot: null,
    }).success, false)
    assert.equal(PublicationArtifactSchema.safeParse({
      ...valid,
      status: 'blocked',
      gates: [{ id: 'review', status: 'failed', reason_code: 'review_failed' }],
      snapshot: null,
    }).success, true)

    const unsigned = executionEvent(randomUUID(), randomUUID(), 1, null)
    assert.equal(PublicationExecutionEventSchema.safeParse({ ...unsigned, sequence: 2 }).success, false)
    assert.equal(PublicationExecutionEventSchema.safeParse({
      ...unsigned,
      detail: { ...unsigned.detail, source_snippet: 'not permitted' },
    }).success, false)

    const wrongDigest = executionEvent(randomUUID(), randomUUID(), 1, null)
    assert.equal(PublicationExecutionEventSchema.safeParse({
      ...wrongDigest,
      event_sha256: HASH_A,
    }).success, false)

    const succeeded = executionEvent(randomUUID(), randomUUID(), 2, HASH_B, 'succeeded')
    assert.equal(PublicationExecutionEventSchema.safeParse(succeeded).success, true)
    const contradictorySuccessInput = {
      ...succeeded,
      detail: EMPTY_EVENT_DETAIL,
    }
    const contradictorySuccess = {
      ...contradictorySuccessInput,
      event_sha256: publicationExecutionEventSha256(contradictorySuccessInput),
    }
    assert.equal(PublicationExecutionEventSchema.safeParse(contradictorySuccess).success, false)
    assert.equal(validateEventStructure(contradictorySuccess), false)
    assert.equal(validateEventStructure({
      ...executionEvent(randomUUID(), randomUUID(), 1, null),
      detail: { ...EMPTY_EVENT_DETAIL, duration_ms: 1 },
    }), false)

    const resign = (event: PublicationExecutionEvent): PublicationExecutionEvent => {
      const { event_sha256: _digest, ...input } = event
      return { ...input, event_sha256: publicationExecutionEventSha256(input) }
    }
    const assertEventParity = (event: PublicationExecutionEvent, label: string) => {
      assert.equal(PublicationExecutionEventSchema.safeParse(event).success, false, `${label} runtime`)
      assert.equal(validateEventStructure(event), false, `${label} JSON Schema`)
    }

    const dispatching = executionEvent(randomUUID(), randomUUID(), 1, null)
    const dispatchMutations: Array<[string, Partial<PublicationExecutionEvent['detail']>]> = [
      ['exit code', { exit_code: 0 }],
      ['signal', { signal: 'SIGTERM' }],
      ['duration', { duration_ms: 1 }],
      ['stdout bytes', { stdout_bytes: 1 }],
      ['stderr bytes', { stderr_bytes: 1 }],
      ['stdout digest', { stdout_sha256: HASH_A }],
      ['stderr digest', { stderr_sha256: HASH_A }],
      ['truncation', { output_truncated: true }],
      ['redaction', { output_redacted: true }],
      ['acknowledgment', { request_acknowledged: true }],
      ['forced status', { forced_status: 'timed_out' }],
      ['invocation', { invocation_attempted: true }],
      ['spawn uncertainty', { spawn_uncertain: true }],
      ['termination uncertainty', { termination_uncertain: true }],
    ]
    for (const [label, detail] of dispatchMutations) {
      assertEventParity(resign({ ...dispatching, detail: { ...dispatching.detail, ...detail } }), `dispatch ${label}`)
    }

    const succeededEvent = executionEvent(randomUUID(), randomUUID(), 2, HASH_B, 'succeeded')
    const successMutations: Array<[string, Partial<PublicationExecutionEvent['detail']>]> = [
      ['exit code', { exit_code: 1 }],
      ['signal', { signal: 'SIGTERM' }],
      ['stdout digest', { stdout_sha256: null }],
      ['stderr digest', { stderr_sha256: null }],
      ['truncation', { output_truncated: true }],
      ['acknowledgment', { request_acknowledged: false }],
      ['forced status', { forced_status: 'timed_out' }],
      ['invocation', { invocation_attempted: false }],
      ['spawn uncertainty', { spawn_uncertain: true }],
      ['termination uncertainty', { termination_uncertain: true }],
    ]
    for (const [label, detail] of successMutations) {
      assertEventParity(resign({
        ...succeededEvent,
        detail: { ...succeededEvent.detail, ...detail },
      }), `success ${label}`)
    }
    const firstTerminal = resign({
      ...succeededEvent,
      sequence: 1,
      previous_event_sha256: null,
    })
    assertEventParity(firstTerminal, 'terminal sequence')

    const validArtifact = artifact()
    const artifactParityCases: Array<[string, PublicationArtifact]> = [
      ['ready publisher', { ...validArtifact, publisher: null }],
      ['ready snapshot', { ...validArtifact, snapshot: null }],
      ['ready failed gate', { ...validArtifact, gates: [{ id: 'review', status: 'failed', reason_code: 'failed' }] }],
      ['blocked reason', { ...validArtifact, status: 'blocked' }],
    ]
    for (const [label, candidate] of artifactParityCases) {
      assert.equal(PublicationArtifactSchema.safeParse(candidate).success, false, `${label} runtime`)
      assert.equal(validateArtifactStructure(candidate), false, `${label} JSON Schema`)
    }

    const runtimeOnlyExpiry = { ...validArtifact, expires_at: validArtifact.created_at }
    assert.equal(PublicationArtifactSchema.safeParse(runtimeOnlyExpiry).success, false)
    assert.equal(validateArtifactStructure(runtimeOnlyExpiry), true)
    const runtimeOnlyDigest = structuredClone(validArtifact)
    runtimeOnlyDigest.snapshot!.snapshot_sha256 = HASH_B
    assert.equal(PublicationArtifactSchema.safeParse(runtimeOnlyDigest).success, false)
    assert.equal(validateArtifactStructure(runtimeOnlyDigest), true)
  })
})

describe('PublicationStore artifacts and private layout', () => {
  it('rejects storage-invalid UUIDs before reserving capacity', async () => {
    const test = fixture('publication-artifact-uuid-')
    try {
      const invalid = { ...artifact(), artifact_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
      await assert.rejects(test.store.createArtifact(invalid, 10), /strict contract/)
      assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'artifact-slots')), [])
      assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'artifacts')), [])
    } finally {
      test.cleanup()
    }
  })

  it('writes direct private immutable artifacts without temporary or hard-link states', async () => {
    const test = fixture('publication-artifact-')
    try {
      const created = await test.store.createArtifact(artifact(), 10)
      const artifactPath = path.join(test.store.root, 'artifacts', `${created.artifact.artifact_id}.json`)
      const bytes = fs.readFileSync(artifactPath)
      assert.equal(created.artifact_sha256, sha256Hex(bytes))
      assert.deepEqual(await test.store.readArtifact(created.artifact.artifact_id, created.artifact_sha256), created)
      assert.deepEqual(await test.store.listArtifacts(), [created])
      await assert.rejects(test.store.createArtifact(created.artifact, 10), /immutable/)
      assert.equal(fs.statSync(artifactPath).nlink, 1)
      assert.equal(recursiveNames(test.store.root).some((name) => name.includes('.publication-') || name.endsWith('.tmp')), false)
      assert.equal(fs.existsSync(path.join(test.store.root, 'requests')), false)

      assert.equal(fs.statSync(test.store.root).mode & 0o777, 0o700)
      assert.equal(fs.statSync(path.join(test.store.root, 'artifact-slots')).mode & 0o777, 0o700)
      assert.equal(fs.statSync(artifactPath).mode & 0o777, 0o600)

      fs.writeFileSync(
        artifactPath,
        Buffer.concat([bytes.subarray(0, -1), Buffer.from(' \n')]),
      )
      await assert.rejects(
        test.store.readArtifact(created.artifact.artifact_id, created.artifact_sha256),
        /digest does not match/,
      )
      fs.writeFileSync(artifactPath, `${JSON.stringify({ ...created.artifact, unexpected: true })}\n`)
      await assert.rejects(test.store.readArtifact(created.artifact.artifact_id), /strict contract/)
      await assert.rejects(test.store.listArtifacts(), /strict contract/)
    } finally {
      test.cleanup()
    }
  })

  it('refuses to create a dispatch claim after the artifact expiry instant', async () => {
    const test = fixture('publication-store-expiry-')
    try {
      const created = await test.store.createArtifact(artifact(), 10)
      const expiredStore = new PublicationStore(
        'root-session',
        test.env,
        () => new Date('2026-07-17T12:00:00.000Z'),
        STORE_OPTIONS,
      )
      await assert.rejects(
        expiredStore.claimExecutionForDispatch(
          created.artifact.artifact_id,
          created.artifact_sha256,
          { occurred_at: '2026-07-17T12:00:00.000Z', detail: EMPTY_EVENT_DETAIL },
        ),
        /expired before dispatch claim/,
      )
      assert.equal(await expiredStore.executionForArtifact(created.artifact.artifact_id), null)
    } finally {
      test.cleanup()
    }
  })

  it('uses durable slots to enforce capacity across processes', async () => {
    const test = fixture('publication-capacity-race-')
    try {
      const candidates = Array.from({ length: 8 }, () => artifact())
      const startAt = String(Date.now() + 750)
      const results = await Promise.all(candidates.map((candidate) => runWorker([
        'artifact',
        test.configDirectory,
        'root-session',
        startAt,
        Buffer.from(JSON.stringify(candidate)).toString('base64url'),
        '1',
        String(NOW.getTime()),
      ])))
      assert.equal(results.filter((result) => result.ok).length, 1)
      assert.equal(results.filter((result) => !result.ok).every((result) => /maximum/.test(result.error ?? '')), true)
      assert.equal((await test.store.listArtifacts()).length, 1)
      assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'artifact-slots')), ['000001.json'])
      assert.equal(recursiveNames(test.store.root).some((name) => name.endsWith('.tmp')), false)
    } finally {
      test.cleanup()
    }
  })

  it('conservatively consumes a slot when durability fails and rejects malformed slot state', async () => {
    const failed = fixture('publication-capacity-fsync-')
    try {
      const original = fs.fsyncSync
      const restore = replaceFsync((descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) throw new Error('injected directory fsync failure')
        return original(descriptor)
      })
      try {
        await assert.rejects(failed.store.createArtifact(artifact(), 1), /durably/)
      } finally {
        restore()
      }
      assert.deepEqual(fs.readdirSync(path.join(failed.store.root, 'artifact-slots')), ['000001.json'])
      assert.deepEqual(fs.readdirSync(path.join(failed.store.root, 'artifacts')), [])
      await assert.rejects(failed.store.createArtifact(artifact(), 1), /maximum/)
      assert.equal(recursiveNames(failed.store.root).some((name) => name.endsWith('.tmp')), false)
    } finally {
      failed.cleanup()
    }

    const malformed = fixture('publication-capacity-malformed-')
    try {
      fs.writeFileSync(path.join(malformed.store.root, 'artifact-slots', 'unexpected.json'), '{}', { mode: 0o600 })
      await assert.rejects(malformed.store.createArtifact(artifact(), 10), /invalid record/)
      await assert.rejects(malformed.store.listArtifacts(), /invalid record/)
    } finally {
      malformed.cleanup()
    }
  })

  it('settles only incomplete records with bounded non-blocking retries', async () => {
    const malformed = fixture('publication-settle-malformed-', {
      mode: 'read_write',
      settlement: { attempts: 3, delay_ms: 500, timeout_ms: 1000 },
    })
    try {
      fs.writeFileSync(
        path.join(malformed.store.root, 'artifact-slots', '000001.json'),
        '{}\n',
        { mode: 0o600 },
      )
      const startedAt = performance.now()
      await assert.rejects(malformed.store.listArtifacts(), /strict contract/)
      assert.ok(performance.now() - startedAt < 400, 'complete malformed record was retried')
    } finally {
      malformed.cleanup()
    }

    const completing = fixture('publication-settle-completing-', {
      mode: 'read_write',
      settlement: { attempts: 20, delay_ms: 10, timeout_ms: 200 },
    })
    try {
      const slotPath = path.join(completing.store.root, 'artifact-slots', '000001.json')
      fs.writeFileSync(slotPath, '{', { mode: 0o600 })
      let timerRan = false
      setTimeout(() => {
        timerRan = true
        fs.writeFileSync(slotPath, `${JSON.stringify({
          slot: 1,
          artifact_id: randomUUID(),
          artifact_sha256: HASH_A,
          reserved_at: NOW.toISOString(),
        })}\n`)
      }, 20)
      assert.deepEqual(await completing.store.listArtifacts(), [])
      assert.equal(timerRan, true, 'settlement retry blocked the event loop')
    } finally {
      completing.cleanup()
    }

    const incomplete = fixture('publication-settle-timeout-', {
      mode: 'read_write',
      settlement: { attempts: 100, delay_ms: 10, timeout_ms: 30 },
    })
    try {
      fs.writeFileSync(
        path.join(incomplete.store.root, 'artifact-slots', '000001.json'),
        '{',
        { mode: 0o600 },
      )
      const startedAt = performance.now()
      await assert.rejects(incomplete.store.listArtifacts(), /incomplete/)
      assert.ok(performance.now() - startedAt < 200, 'settlement exceeded its total timeout')
    } finally {
      incomplete.cleanup()
    }

    const completingRecords = fixture('publication-settle-records-', {
      mode: 'read_write',
      settlement: { attempts: 20, delay_ms: 10, timeout_ms: 200 },
    })
    try {
      const created = await completingRecords.store.createArtifact(artifact(), 10)
      const artifactPath = path.join(
        completingRecords.store.root,
        'artifacts',
        `${created.artifact.artifact_id}.json`,
      )
      const artifactBytes = fs.readFileSync(artifactPath)
      fs.writeFileSync(artifactPath, '{')
      let artifactTimerRan = false
      setTimeout(() => {
        artifactTimerRan = true
        fs.writeFileSync(artifactPath, artifactBytes)
      }, 20)
      assert.deepEqual(await completingRecords.store.readArtifact(created.artifact.artifact_id), created)
      assert.equal(artifactTimerRan, true, 'artifact settlement blocked the event loop')

      const claim = await completingRecords.store.claimExecutionForDispatch(
        created.artifact.artifact_id,
        created.artifact_sha256,
        { occurred_at: NOW.toISOString(), detail: EMPTY_EVENT_DETAIL },
      )
      const dispatching = (await completingRecords.store.readExecutionEvents(claim.execution_id))[0]
      const terminal = executionEvent(
        claim.execution_id,
        created.artifact.artifact_id,
        2,
        dispatching.event_sha256,
        'succeeded',
      )
      await completingRecords.store.appendExecutionEvent(terminal)
      const eventPath = path.join(
        completingRecords.store.root,
        'executions',
        claim.execution_id,
        '000002.json',
      )
      const eventBytes = fs.readFileSync(eventPath)
      fs.writeFileSync(eventPath, '{')
      let eventTimerRan = false
      setTimeout(() => {
        eventTimerRan = true
        fs.writeFileSync(eventPath, eventBytes)
      }, 20)
      assert.deepEqual(
        await completingRecords.store.readExecutionEvents(claim.execution_id),
        [dispatching, terminal],
      )
      assert.equal(eventTimerRan, true, 'event settlement blocked the event loop')
    } finally {
      completingRecords.cleanup()
    }
  })

  it('fails closed when a newly created directory cannot be synchronized', () => {
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-layout-fsync-'))
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
    const original = fs.fsyncSync
    const restore = replaceFsync((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) throw new Error('injected directory fsync failure')
      return original(descriptor)
    })
    try {
      assert.throws(
        () => new PublicationStore('root-session', env, () => NOW, STORE_OPTIONS),
        /synchronized durably/,
      )
    } finally {
      restore()
      fs.rmSync(configDirectory, { recursive: true, force: true })
    }
  })

  it('rejects symlinked components and symlinked or hard-linked records', async () => {
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-component-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-outside-'))
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
    try {
      const publicationRoot = path.join(getSessionRuntimeDir('root-session', env), 'publication')
      fs.mkdirSync(path.dirname(publicationRoot), { recursive: true })
      fs.symlinkSync(outside, publicationRoot, 'dir')
      assert.throws(
        () => new PublicationStore('root-session', env, () => NOW, STORE_OPTIONS),
        /not a private directory/,
      )
    } finally {
      fs.rmSync(configDirectory, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }

    const parentConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-parent-component-'))
    const parentOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-parent-outside-'))
    const parentEnv = { ...process.env, OPENCODE_CONFIG_DIR: parentConfig }
    try {
      fs.mkdirSync(path.join(parentConfig, 'workflows'), { mode: 0o700 })
      fs.symlinkSync(parentOutside, path.join(parentConfig, 'workflows', 'runtime'), 'dir')
      assert.throws(
        () => new PublicationStore('root-session', parentEnv, () => NOW, STORE_OPTIONS),
        /not a private directory/,
      )
    } finally {
      fs.rmSync(parentConfig, { recursive: true, force: true })
      fs.rmSync(parentOutside, { recursive: true, force: true })
    }

    const linked = fixture('publication-record-link-')
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-record-external-'))
    try {
      const created = await linked.store.createArtifact(artifact(), 10)
      const artifactPath = path.join(linked.store.root, 'artifacts', `${created.artifact.artifact_id}.json`)
      fs.linkSync(artifactPath, path.join(external, 'linked-artifact.json'))
      await assert.rejects(linked.store.readArtifact(created.artifact.artifact_id), /one private regular file/)

      const symlinkId = randomUUID()
      const outsideRecord = path.join(external, 'outside.json')
      fs.writeFileSync(outsideRecord, JSON.stringify(artifact({ artifact_id: symlinkId })), { mode: 0o600 })
      fs.symlinkSync(outsideRecord, path.join(linked.store.root, 'artifacts', `${symlinkId}.json`))
      await assert.rejects(linked.store.readArtifact(symlinkId), /one private regular file/)
    } finally {
      linked.cleanup()
      fs.rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('PublicationStore claims and events', () => {
  it('creates exactly one durable dispatch claim in a multi-process race', async () => {
    const test = fixture('publication-claim-race-')
    try {
      const created = await test.store.createArtifact(artifact(), 10)
      const startAt = String(Date.now() + 750)
      const results = await Promise.all(Array.from({ length: 12 }, () => runWorker([
        'claim',
        test.configDirectory,
        'root-session',
        startAt,
        created.artifact.artifact_id,
        created.artifact_sha256,
        String(NOW.getTime()),
      ])))
      assert.equal(results.every((result) => result.ok), true, JSON.stringify(results))
      assert.equal(results.filter((result) => result.result?.created).length, 1)
      const executionIds = new Set(results.map((result) => result.result?.execution_id))
      assert.equal(executionIds.size, 1)
      const executionId = [...executionIds][0]
      assert.equal(typeof executionId, 'string')
      assert.equal(await test.store.executionForArtifact(created.artifact.artifact_id), executionId)
      const events = await test.store.readExecutionEvents(executionId as string)
      assert.equal(events.length, 1)
      assert.equal(events[0].status, 'dispatching')
      assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'executions')), [executionId])
      assert.deepEqual(fs.readdirSync(path.join(test.store.root, 'claims')), [`${created.artifact.artifact_id}.json`])
      assert.equal(fs.statSync(path.join(test.store.root, 'executions', executionId as string, '000001.json')).nlink, 1)
      assert.equal(recursiveNames(test.store.root).some((name) => name.endsWith('.tmp')), false)
    } finally {
      test.cleanup()
    }
  })

  it('returns only after the dispatching event and claim survive restart', async () => {
    const test = fixture('publication-dispatching-')
    try {
      const claimed = await createClaimedArtifact(test.store)
      const eventPath = path.join(test.store.root, 'executions', claimed.executionId, '000001.json')
      const claimPath = path.join(test.store.root, 'claims', `${claimed.artifact.artifact_id}.json`)
      assert.equal(fs.existsSync(eventPath), true)
      assert.equal(fs.existsSync(claimPath), true)

      const restarted = new PublicationStore('root-session', test.env, () => NOW, STORE_OPTIONS)
      assert.equal(await restarted.executionForArtifact(claimed.artifact.artifact_id), claimed.executionId)
      assert.deepEqual(await restarted.readExecutionEvents(claimed.executionId), [claimed.dispatching])
    } finally {
      test.cleanup()
    }
  })

  it('fails closed for missing or corrupt claimed execution state and never recreates it', async () => {
    const missing = fixture('publication-claim-missing-')
    try {
      const claimed = await createClaimedArtifact(missing.store)
      const executionDirectory = path.join(missing.store.root, 'executions', claimed.executionId)
      fs.rmSync(executionDirectory, { recursive: true })
      await assert.rejects(missing.store.executionForArtifact(claimed.artifact.artifact_id), /unavailable/)
      assert.equal(fs.existsSync(executionDirectory), false)
    } finally {
      missing.cleanup()
    }

    const corrupt = fixture('publication-claim-corrupt-')
    try {
      const claimed = await createClaimedArtifact(corrupt.store)
      const eventPath = path.join(corrupt.store.root, 'executions', claimed.executionId, '000001.json')
      fs.writeFileSync(eventPath, '{}\n')
      await assert.rejects(corrupt.store.executionForArtifact(claimed.artifact.artifact_id), /strict contract/)
    } finally {
      corrupt.cleanup()
    }
  })

  it('enforces one dispatching event followed by exactly one terminal event', async () => {
    const test = fixture('publication-events-')
    try {
      const claimed = await createClaimedArtifact(test.store)
      const first = executionEvent(claimed.executionId, claimed.artifact.artifact_id, 1, null)
      assert.deepEqual(claimed.dispatching, first)
      const second = executionEvent(
        claimed.executionId,
        claimed.artifact.artifact_id,
        2,
        first.event_sha256,
        'succeeded',
      )
      await test.store.appendExecutionEvent(second)
      assert.deepEqual(await test.store.readExecutionEvents(claimed.executionId), [first, second])

      const invalidThird = executionEvent(claimed.executionId, claimed.artifact.artifact_id, 3, second.event_sha256, 'ambiguous')
      await assert.rejects(test.store.appendExecutionEvent(invalidThird), /current hash chain/)

    } finally {
      test.cleanup()
    }
  })

  it('detects event hash tampering, reordering, and gaps', async () => {
    const test = fixture('publication-event-tamper-')
    try {
      const claimed = await createClaimedArtifact(test.store)
      const first = claimed.dispatching
      const second = executionEvent(
        claimed.executionId,
        claimed.artifact.artifact_id,
        2,
        first.event_sha256,
        'succeeded',
      )
      await test.store.appendExecutionEvent(second)
      const directory = path.join(test.store.root, 'executions', claimed.executionId)
      const firstPath = path.join(directory, '000001.json')
      const secondPath = path.join(directory, '000002.json')
      const firstBytes = fs.readFileSync(firstPath)
      const secondBytes = fs.readFileSync(secondPath)

      fs.writeFileSync(secondPath, `${JSON.stringify({ ...second, status: 'ambiguous' })}\n`)
      await assert.rejects(test.store.readExecutionEvents(claimed.executionId), /strict contract/)
      fs.writeFileSync(secondPath, secondBytes)

      fs.writeFileSync(firstPath, secondBytes)
      fs.writeFileSync(secondPath, firstBytes)
      await assert.rejects(test.store.readExecutionEvents(claimed.executionId), /inconsistent/)
      fs.writeFileSync(firstPath, firstBytes)
      fs.writeFileSync(secondPath, secondBytes)

      fs.renameSync(secondPath, path.join(directory, '000003.json'))
      await assert.rejects(test.store.readExecutionEvents(claimed.executionId), /gap/)
    } finally {
      test.cleanup()
    }
  })

  it('allows durable reads but rejects every mutation in read-only mode', async () => {
    const test = fixture('publication-read-only-')
    try {
      const claimed = await createClaimedArtifact(test.store)
      const terminal = executionEvent(
        claimed.executionId,
        claimed.artifact.artifact_id,
        2,
        claimed.dispatching.event_sha256,
        'succeeded',
      )
      await test.store.appendExecutionEvent(terminal)

      const readOnly = new PublicationStore(
        'root-session',
        test.env,
        () => NOW,
        { mode: 'read_only' },
      )
      assert.equal(
        (await readOnly.readArtifact(claimed.artifact.artifact_id)).artifact_sha256,
        claimed.artifact_sha256,
      )
      assert.equal((await readOnly.listArtifacts()).length, 1)
      assert.equal((await readOnly.listArtifactStates())[0].execution_id, claimed.executionId)
      assert.equal(await readOnly.executionForArtifact(claimed.artifact.artifact_id), claimed.executionId)
      assert.deepEqual(await readOnly.readExecutionEvents(claimed.executionId), [claimed.dispatching, terminal])

      await assert.rejects(readOnly.createArtifact(artifact(), 10), /status reads only/)
      await assert.rejects(readOnly.claimExecutionForDispatch(
        claimed.artifact.artifact_id,
        claimed.artifact_sha256,
        { occurred_at: NOW.toISOString(), detail: EMPTY_EVENT_DETAIL },
      ), /status reads only/)
      await assert.rejects(readOnly.appendExecutionEvent(terminal), /status reads only/)

      const executionDirectory = path.join(test.store.root, 'executions', claimed.executionId)
      fs.chmodSync(executionDirectory, 0o755)
      await assert.rejects(readOnly.readExecutionEvents(claimed.executionId), /permissions are not private/)
      assert.equal(fs.statSync(executionDirectory).mode & 0o777, 0o755)
    } finally {
      test.cleanup()
    }
  })

  it('does not create or repair publication storage in read-only mode', async () => {
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-read-only-empty-'))
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
    fs.chmodSync(configDirectory, 0o755)
    try {
      const readOnly = new PublicationStore('root-session', env, () => NOW, { mode: 'read_only' })
      assert.deepEqual(await readOnly.listArtifacts(), [])
      assert.deepEqual(await readOnly.listArtifactStates(), [])
      assert.equal(fs.existsSync(readOnly.root), false)
      assert.equal(fs.statSync(configDirectory).mode & 0o777, 0o755)
      assert.deepEqual(fs.readdirSync(configDirectory), [])
    } finally {
      fs.rmSync(configDirectory, { recursive: true, force: true })
    }

    const existing = fixture('publication-read-only-permissions-')
    try {
      const artifactsDirectory = path.join(existing.store.root, 'artifacts')
      fs.chmodSync(artifactsDirectory, 0o755)
      const readOnly = new PublicationStore('root-session', existing.env, () => NOW, { mode: 'read_only' })
      await assert.rejects(readOnly.listArtifacts(), /permissions are not private/)
      assert.equal(fs.statSync(artifactsDirectory).mode & 0o777, 0o755)
    } finally {
      existing.cleanup()
    }
  })

  it('has no request-storage API or layout', () => {
    const test = fixture('publication-no-requests-')
    try {
      const surface = test.store as unknown as Record<string, unknown>
      assert.equal(surface.createExecutionRequest, undefined)
      assert.equal(surface.removeExecutionRequest, undefined)
      assert.equal(surface.createRequest, undefined)
      assert.equal(surface.removeRequest, undefined)
      assert.equal(fs.existsSync(path.join(test.store.root, 'requests')), false)
    } finally {
      test.cleanup()
    }
  })
})
