import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { deriveEpicWorktreeIdentity, emptyAutomationUsageTelemetry, EPIC_SCHEMA_VERSION, projectIdentitySha256, type EpicState } from '../../lib/epic-contracts.ts'
import {
  EpicBoundsExceededError,
  EpicCorruptError,
  EpicIncompleteStateError,
  EpicInputError,
  EpicRecoveryRequiredError,
  EpicStaleRevisionError,
  EpicStoreError,
  EpicUnsafeStorageError,
  EpicUnsupportedVersionError,
  openEpicStore,
} from '../../lib/epic-persistence.ts'
import { getRuntimeDir, hashIdentifier } from '../../lib/paths.ts'

const NOW = '2026-07-18T12:00:00.000Z'
const LATER = '2026-07-18T12:05:00.000Z'
const OID = (character: string) => character.repeat(40)
const CONFIG = { enabled: true, max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 } as const
const temporaryDirectories: string[] = []
const supportsPosixStore = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number' && typeof fs.constants.O_DIRECTORY === 'number'

function worktreeEvidence() {
  return {
    ...deriveEpicWorktreeIdentity('epic-1', 'item', 'attempt-1'),
    base_commit: OID('0'), worktree_path_sha256: '1'.repeat(64), worktree_directory_dev: '1', worktree_directory_ino: '2',
    git_common_directory_sha256: '2'.repeat(64), git_common_directory_dev: '3', git_common_directory_ino: '4',
  }
}

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

function fixture(options: { max_revisions?: number, max_chain_bytes?: number, max_revision_bytes?: number, settlement_retries?: number } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-store-config-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-store-project-'))
  temporaryDirectories.push(configDir, project)
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir }
  const canonicalProject = fs.realpathSync(project)
  const root = path.join(getRuntimeDir(env), 'epics', hashIdentifier('session-1'), hashIdentifier(canonicalProject), hashIdentifier('epic-1'))
  const state: EpicState = {
    schema_version: EPIC_SCHEMA_VERSION, state_revision: 1,
    operational_limits: { max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 },
    epic_id: 'epic-1', root_session_id: 'session-1', project_identity_sha256: projectIdentitySha256(canonicalProject),
    base_branch: 'refs/heads/base', integration_branch: 'refs/heads/integration', status: 'pending', pause_reason: null,
    created_at: NOW, updated_at: NOW,
    items: { item: { item_id: 'item', dependencies: [], scope: 'Neutral persistence fixture.', status: 'pending', attempts: [], selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null, review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null } },
    integration_log: [], usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }], budget_updates: [],
  }
  const store = (runtime = 'runtime-1', mode: 'read_only' | 'read_write' = 'read_write', fsync?: (descriptor: number) => void) => openEpicStore({
    root_session_id: 'session-1', project_root: project, epic_id: 'epic-1', runtime_incarnation: runtime, mode, config: CONFIG, env, fsync,
    protocol_bounds: options.max_revisions || options.max_chain_bytes || options.max_revision_bytes ? {
      max_revisions: options.max_revisions ?? 10_000,
      max_chain_bytes: options.max_chain_bytes ?? 256 * 1024 * 1024,
      max_revision_bytes: options.max_revision_bytes,
    } : undefined,
    settlement_retries: options.settlement_retries,
  })
  return { configDir, project, env, root, state, store }
}

function rewrite(file: string, value: unknown): void { fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600) }

function runningState(state: EpicState): EpicState {
  const worktree_evidence = worktreeEvidence()
  return {
    ...state, status: 'running',
    items: { item: { ...state.items.item!, status: 'running', worktree_name: worktree_evidence.worktree_name, branch_name: worktree_evidence.branch_name, attempts: [{ attempt_id: 'attempt-1', worktree_evidence, agent: 'executor', model: null, child_session_id: null, started_at: NOW, completed_at: null, checkpoint_commit: null, review_evidence_digest: null, result_summary: null, failure_classification: null, status: 'running' }] } },
    usage: [
      { scope: 'epic', item_id: null, usage: { ...emptyAutomationUsageTelemetry(), active_interval_started_at: NOW, last_active_checkpoint_at: NOW } },
      { scope: 'item', item_id: 'item', usage: { ...emptyAutomationUsageTelemetry(), active_interval_started_at: NOW, last_active_checkpoint_at: NOW } },
    ],
  }
}

function recoveredState(state: EpicState): EpicState {
  const attempt = state.items.item!.attempts[0]!
  return {
    ...state, state_revision: state.state_revision + 1, status: 'paused', pause_code: 'operator_reconciled', pause_reason: 'Operator settled interrupted work.', updated_at: LATER,
    items: { item: { ...state.items.item!, status: 'cancelled', completed_at: LATER, attempts: [{ ...attempt, status: 'cancelled', completed_at: LATER, result_summary: 'Cancelled during attended recovery.', failure_classification: 'cancelled' }] } },
    usage: state.usage.map(record => ({ ...record, usage: { ...record.usage, active_time_ms: 300_000, active_interval_started_at: null, last_active_checkpoint_at: null } })),
  }
}

function raceProcess(configDir: string, project: string, stateFile: string, revision: number, sha: string, barrier: string, id: string): Promise<{ code: number | null, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/epic-race-writer.ts', configDir, project, stateFile, String(revision), sha, barrier, id], { cwd: path.resolve('.') })
    let output = ''; child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk }); child.on('close', code => resolve({ code, output }))
  })
}

describe('EpicStore secure append-only persistence', { skip: !supportsPosixStore }, () => {
  it('is a true no-op in disabled mode even with a missing project and malformed identifiers', () => {
    const disabled = openEpicStore({ root_session_id: '../bad', project_root: '/definitely/missing/project', epic_id: '../bad', runtime_incarnation: '', mode: 'disabled', config: { enabled: false } })
    assert.equal(disabled.append({ malformed: true }, -1, 'bad', -1), null)
    assert.equal(disabled.load(), null)
    assert.equal(disabled.statusOnly(), null)
  })

  it('restricts full state to read-write owners and exposes only status to read-only callers', () => {
    const { state, store } = fixture(); const first = store().append(state, 0, null, 1)!
    const readOnly = store('runtime-1', 'read_only')
    assert.throws(() => readOnly.load(), (error: unknown) => error instanceof EpicStoreError && error.code === 'unavailable')
    assert.equal(readOnly.statusOnly()?.state_sha256, first.state_sha256)
    assert.throws(() => readOnly.append(state, 1, first.state_sha256, 1), EpicStoreError)
  })

  it('creates, loads, appends and fences CAS by revision, hash, and generation', () => {
    const { root, state, store } = fixture(); const first = store().append(state, 0, null, 1)!
    const next = { ...state, state_revision: 2, status: 'running' as const, updated_at: LATER }
    const second = store().append(next, 1, first.state_sha256, 1)!
    assert.equal(store().load()?.ownership_generation, 1)
    assert.equal(fs.statSync(root).mode & 0o777, 0o700)
    assert.throws(() => store().append({ ...next, state_revision: 3 }, 2, second.state_sha256, 2), EpicStaleRevisionError)
  })

  it('keeps persisted state/hash consistent and requires explicit closure during attended recovery', () => {
    const { state, store } = fixture()
    const owner = store('runtime-a')
    const first = owner.append(state, 0, null, 1)!
    const queued = {
      ...state,
      state_revision: 2,
      status: 'running' as const,
      items: { item: { ...state.items.item!, status: 'queued' as const } },
    }
    const second = owner.append(queued, 1, first.state_sha256, 1)!
    const running = { ...runningState(state), state_revision: 3 }
    const third = owner.append(running, 2, second.state_sha256, 1)!
    const restarted = store('runtime-b'); const persisted = restarted.load()!; const status = restarted.statusOnly()!
    assert.equal(persisted.state.status, 'running'); assert.equal(persisted.state_sha256, third.state_sha256)
    assert.equal(status.status, 'paused'); assert.equal(status.state_sha256, third.state_sha256); assert.equal(status.recovery_required, true)
    assert.throws(() => restarted.append({ ...running, state_revision: 4 }, 3, third.state_sha256, 1), EpicRecoveryRequiredError)
    const reconciled = restarted.reconcile(recoveredState(running), 3, third.state_sha256, 1)!
    assert.equal(reconciled.ownership_generation, 2); assert.equal(reconciled.state.items.item!.attempts[0]!.status, 'cancelled')
    assert.deepEqual(reconciled.state.items.item!.attempts[0]!.worktree_evidence, running.items.item!.attempts[0]!.worktree_evidence)
    assert.throws(() => restarted.append({ ...reconciled.state, state_revision: 5 }, 4, reconciled.state_sha256, 1), EpicStaleRevisionError)
  })

  it('rejects fabricated non-genesis evidence before creating storage', () => {
    const { root, state, store } = fixture()
    const running = runningState(state)
    assert.throws(() => store().append(running, 0, null, 1), EpicInputError)
    assert.equal(fs.existsSync(root), false)
  })

  it('returns only the operational status whitelist with immutable identity digest semantics', () => {
    const { state, store } = fixture(); store().append(state, 0, null, 1); const status = store().statusOnly()!
    assert.deepEqual(Object.keys(status).sort(), ['budget_dimensions', 'conflicted_count', 'epic_id', 'failed_count', 'identity_digest', 'integrated_count', 'item_count', 'ownership_generation', 'pause_code', 'recovery_required', 'revision', 'running_count', 'state_sha256', 'status', 'updated_at'])
    for (const forbidden of ['root_session_id', 'attempts', 'model', 'child_session', 'checkpoint', 'commit', 'path', 'result']) assert.equal(JSON.stringify(status).includes(forbidden), false)
  })

  it('types incomplete identity-only and incomplete records without overwriting them', () => {
    const { root, state, store } = fixture({ settlement_retries: 0 }); store().append(state, 0, null, 1)
    const revision = path.join(root, 'revisions', '00000000000000000001.json'); fs.rmSync(revision)
    assert.throws(() => store().load(), EpicIncompleteStateError)
    fs.writeFileSync(revision, '{', { mode: 0o600 })
    assert.throws(() => store().load(), EpicIncompleteStateError)
    assert.throws(() => store().append(state, 0, null, 1), EpicIncompleteStateError)
  })

  it('enforces exact and over-limit revision count and aggregate chain bytes', () => {
    const count = fixture({ max_revisions: 1 }); const first = count.store().append(count.state, 0, null, 1)!
    assert.throws(() => count.store().append({ ...count.state, state_revision: 2, status: 'running', updated_at: LATER }, 1, first.state_sha256, 1), EpicBoundsExceededError)

    const bytesFixture = fixture(); bytesFixture.store().append(bytesFixture.state, 0, null, 1)
    const revisionSize = fs.statSync(path.join(bytesFixture.root, 'revisions', '00000000000000000001.json')).size
    const exact = openEpicStore({ root_session_id: 'session-1', project_root: bytesFixture.project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1', mode: 'read_write', config: CONFIG, env: bytesFixture.env, protocol_bounds: { max_revisions: 10, max_chain_bytes: revisionSize } })
    assert.equal(exact.load()?.revision, 1)
    const over = openEpicStore({ root_session_id: 'session-1', project_root: bytesFixture.project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1', mode: 'read_write', config: CONFIG, env: bytesFixture.env, protocol_bounds: { max_revisions: 10, max_chain_bytes: revisionSize - 1 } })
    assert.throws(() => over.load(), EpicBoundsExceededError)
  })

  it('enforces the same per-revision byte bound before write and during read', () => {
    const written = fixture()
    written.store().append(written.state, 0, null, 1)
    const revision = path.join(written.root, 'revisions', '00000000000000000001.json')
    const exactBytes = fs.statSync(revision).size
    const exact = openEpicStore({
      root_session_id: 'session-1', project_root: written.project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1',
      mode: 'read_write', config: CONFIG, env: written.env,
      protocol_bounds: { max_revisions: 10, max_chain_bytes: 256 * 1024 * 1024, max_revision_bytes: exactBytes },
    })
    assert.equal(exact.load()?.revision, 1)

    const rejected = fixture({ max_revision_bytes: 1 })
    assert.throws(() => rejected.store().append(rejected.state, 0, null, 1), EpicBoundsExceededError)
    assert.equal(fs.existsSync(rejected.root), false)
  })

  it('normalizes malformed state and storage failures without exposing absolute paths', () => {
    const { root, state, store } = fixture()
    assert.throws(() => store().append({ ...state, epic_id: 'bad id' }, 0, null, 1), (error: unknown) => error instanceof EpicInputError && !error.message.includes(root))
    store().append(state, 0, null, 1)
    const revision = path.join(root, 'revisions', '00000000000000000001.json'); rewrite(revision, { malformed: true })
    assert.throws(() => store().load(), (error: unknown) => error instanceof EpicCorruptError && !error.message.includes(root))
  })

  it('rejects unsafe modes, unsupported versions, tampering, and project inode replacement', () => {
    const modeFixture = fixture(); modeFixture.store().append(modeFixture.state, 0, null, 1); fs.chmodSync(path.join(modeFixture.root, 'identity.json'), 0o644)
    assert.throws(() => modeFixture.store().load(), EpicUnsafeStorageError)

    const versionFixture = fixture(); versionFixture.store().append(versionFixture.state, 0, null, 1)
    const identity = path.join(versionFixture.root, 'identity.json'); const value = JSON.parse(fs.readFileSync(identity, 'utf8')); value.identity_version = 99; rewrite(identity, value)
    assert.throws(() => versionFixture.store().load(), EpicUnsupportedVersionError)

    const inodeFixture = fixture(); const opened = inodeFixture.store(); opened.append(inodeFixture.state, 0, null, 1)
    const moved = `${inodeFixture.project}-moved`; fs.renameSync(inodeFixture.project, moved); temporaryDirectories.push(moved); fs.mkdirSync(inodeFixture.project)
    assert.throws(() => opened.statusOnly(), EpicUnsafeStorageError)
  })

  it('rejects symlinked and hard-linked immutable records', () => {
    const hardLinked = fixture()
    hardLinked.store().append(hardLinked.state, 0, null, 1)
    const revision = path.join(hardLinked.root, 'revisions', '00000000000000000001.json')
    const outside = path.join(hardLinked.configDir, 'linked-revision.json')
    fs.linkSync(revision, outside)
    assert.throws(() => hardLinked.store().load(), EpicUnsafeStorageError)

    const symlinked = fixture()
    symlinked.store().append(symlinked.state, 0, null, 1)
    const identity = path.join(symlinked.root, 'identity.json')
    const displaced = path.join(symlinked.configDir, 'identity.json')
    fs.renameSync(identity, displaced)
    fs.symlinkSync(displaced, identity)
    assert.throws(() => symlinked.store().load(), EpicUnsafeStorageError)
  })

  it('isolates persisted ownership by authoritative root session and epic identity', () => {
    const { env, project, state, store } = fixture()
    store().append(state, 0, null, 1)
    const wrongSession = openEpicStore({
      root_session_id: 'session-2', project_root: project, epic_id: 'epic-1', runtime_incarnation: 'runtime-1',
      mode: 'read_only', config: CONFIG, env,
    })
    const wrongEpic = openEpicStore({
      root_session_id: 'session-1', project_root: project, epic_id: 'epic-2', runtime_incarnation: 'runtime-1',
      mode: 'read_only', config: CONFIG, env,
    })
    assert.equal(wrongSession.statusOnly(), null)
    assert.equal(wrongEpic.statusOnly(), null)
  })

  it('fails closed on injected fsync failure', () => {
    const failed = fixture()
    assert.throws(() => failed.store('runtime-1', 'read_write', () => { throw new Error('injected') }).append(failed.state, 0, null, 1), (error: unknown) => error instanceof EpicStoreError && error.code === 'unavailable')
  })

  it('allows exactly one writer after a real multiprocess synchronization barrier', async () => {
    const { configDir, project, state, store } = fixture(); const first = store('race-runtime').append(state, 0, null, 1)!
    const next = { ...state, state_revision: 2, status: 'running' as const, updated_at: LATER }; const stateFile = path.join(configDir, 'race-state.json'); fs.writeFileSync(stateFile, JSON.stringify(next), { mode: 0o600 })
    const barrier = path.join(configDir, 'barrier'); fs.mkdirSync(barrier)
    const resultsPromise = Promise.all([raceProcess(configDir, project, stateFile, 1, first.state_sha256, barrier, 'a'), raceProcess(configDir, project, stateFile, 1, first.state_sha256, barrier, 'b')])
    while (!fs.existsSync(path.join(barrier, 'ready-a')) || !fs.existsSync(path.join(barrier, 'ready-b'))) await new Promise(resolve => setTimeout(resolve, 2))
    fs.writeFileSync(path.join(barrier, 'go'), '')
    const results = await resultsPromise
    assert.equal(results.filter(result => result.code === 0 && result.output === 'won').length, 1)
    assert.equal(results.filter(result => result.code !== 0 && result.output === 'stale_revision').length, 1)
  })
})
