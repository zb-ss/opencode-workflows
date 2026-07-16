import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it } from 'node:test'

import {
  buildPublicationGitSnapshot,
  PublicationGitSnapshotError,
  type PublicationGitSnapshotInput,
  type PublicationGitSnapshotLimits,
} from '../../lib/publication-git-snapshot.ts'

const GIT = '/usr/bin/git'
const ROOT_SCRIPT = ['/usr/bin/ldd', '/bin/ldd'].find(candidate => fs.existsSync(candidate))
const HAS_GIT = fs.existsSync(GIT)
const REMOTE_URL = 'https://example.com/example/repository.git'
const temporaryDirectories = new Set<string>()
const LIMITS: PublicationGitSnapshotLimits = {
  max_commits: 20,
  max_objects: 200,
  max_blob_bytes: 1024 * 1024,
  max_total_scan_bytes: 4 * 1024 * 1024,
  max_findings: 20,
}

interface RepositoryFixture {
  root: string
  baseOid: string
}

function git(root: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(root: string, filename: string, content: string | Uint8Array): void {
  const target = path.join(root, filename)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function commit(root: string, filename: string, content: string | Uint8Array, message: string): string {
  write(root, filename, content)
  git(root, ['add', '--', filename])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function createRepository(): RepositoryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-snapshot-'))
  temporaryDirectories.add(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Integration Test'])
  git(root, ['config', 'user.email', 'integration@example.com'])
  git(root, ['remote', 'add', 'origin', REMOTE_URL])
  commit(root, 'README.md', 'base\n', 'initial')
  git(root, ['branch', 'publication-base'])
  return { root, baseOid: git(root, ['rev-parse', 'HEAD']) }
}

function input(
  root: string,
  overrides: Partial<PublicationGitSnapshotInput> = {},
): PublicationGitSnapshotInput {
  return {
    worktree: root,
    git_executable: GIT,
    base_ref: 'refs/heads/publication-base',
    head_ref: 'refs/heads/main',
    remote: 'origin',
    expected_remote_url: REMOTE_URL,
    destination_ref: 'refs/heads/main',
    command_timeout_ms: 1000,
    limits: LIMITS,
    internal_markers: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: PublicationGitSnapshotError['code']): Promise<void> {
  await assert.rejects(promise, error => (
    error instanceof PublicationGitSnapshotError && error.code === code
  ))
}

function fakeGitChild(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, {
    pid: 999_999_999,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null],
    kill: () => true,
    unref: () => child,
  })
  return child
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('publication Git snapshot integration', { concurrency: false, skip: !HAS_GIT }, () => {
  it('builds a deterministic all-history snapshot with pinned identities', async () => {
    const { root, baseOid } = createRepository()
    const headOid = commit(root, 'src/example.ts', 'export const value = 1\n', 'add example')

    const first = await buildPublicationGitSnapshot(input(root))
    const second = await buildPublicationGitSnapshot(input(root))

    assert.equal(first.source.base_oid, baseOid)
    assert.equal(first.source.head_oid, headOid)
    assert.equal(first.source.remote_url, REMOTE_URL)
    assert.match(first.source.git_common_dir_sha256, /^[0-9a-f]{64}$/)
    assert.match(first.source.git_executable_identity_sha256, /^[0-9a-f]{64}$/)
    assert.match(first.source.repository_identity_sha256, /^[0-9a-f]{64}$/)
    assert.match(first.snapshot_sha256, /^[0-9a-f]{64}$/)
    assert.equal(first.snapshot_sha256, second.snapshot_sha256)
    assert.deepEqual(first.findings, [])
    assert.equal(first.scan_counts.commits, 2)
    assert.equal(first.scan_counts.paths, 2)
  })

  it('scans sensitive content in base ancestry that a new destination could expose', async () => {
    const { root } = createRepository()
    commit(root, 'base-secret.txt', 'password=exampleCredential123\n', 'base history fixture')
    git(root, ['branch', '--force', 'publication-base', 'HEAD'])
    commit(root, 'safe-head.txt', 'reviewed content\n', 'safe head change')

    const snapshot = await buildPublicationGitSnapshot(input(root))
    assert.equal(snapshot.findings.some(finding => (
      finding.rule_id === 'credential.secret_assignment'
    )), true)
    assert.doesNotMatch(JSON.stringify(snapshot.findings), /exampleCredential123/)
  })

  it('rejects graft metadata that hides a raw commit parent from revision walking', async () => {
    const { root, baseOid } = createRepository()
    commit(root, 'hidden-secret.txt', 'password=exampleCredential123\n', 'hidden history fixture')
    const headOid = commit(root, 'safe-head.txt', 'reviewed content\n', 'safe head change')
    write(root, '.git/info/grafts', `${headOid} ${baseOid}\n`)

    await rejectsWithCode(buildPublicationGitSnapshot(input(root)), 'unsupported_repository')
  })

  it('rejects a dirty tree and a mismatched remote', async () => {
    const { root } = createRepository()
    commit(root, 'clean.txt', 'clean\n', 'clean change')
    write(root, 'untracked.txt', 'dirty\n')
    await rejectsWithCode(buildPublicationGitSnapshot(input(root)), 'dirty_worktree')

    fs.rmSync(path.join(root, 'untracked.txt'))
    await rejectsWithCode(buildPublicationGitSnapshot(input(root, {
      expected_remote_url: 'https://example.com/other/repository.git',
    })), 'remote_mismatch')
  })

  it('scans blobs that were added and later deleted', async () => {
    const { root } = createRepository()
    commit(root, 'temporary.txt', 'password=exampleCredential123\n', 'add temporary value')
    fs.rmSync(path.join(root, 'temporary.txt'))
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'remove temporary value'])

    const snapshot = await buildPublicationGitSnapshot(input(root))
    assert.equal(snapshot.findings.some(finding => finding.rule_id === 'credential.secret_assignment'), true)
    assert.doesNotMatch(JSON.stringify(snapshot.findings), /exampleCredential123/)
  })

  it('finds internal markers and prohibited changed paths', async () => {
    const { root } = createRepository()
    commit(root, '.env.production', 'ordinary=true\n', 'add deployment file')
    commit(root, 'notes.txt', 'Synthetic Internal Project\n', 'add internal note')

    const snapshot = await buildPublicationGitSnapshot(input(root, {
      internal_markers: [{
        id: 'project-name',
        literal: 'Synthetic Internal Project',
        case_sensitive: true,
      }],
    }))
    assert.equal(snapshot.findings.some(finding => finding.category === 'prohibited_path'), true)
    assert.equal(snapshot.findings.some(finding => finding.category === 'internal_marker'), true)
    assert.doesNotMatch(JSON.stringify(snapshot.findings), /Synthetic Internal Project/)
  })

  it('rejects control characters in decoded Git paths', async () => {
    const { root } = createRepository()
    commit(root, `src/escape-${String.fromCodePoint(0x1b)}[31m.ts`, 'ordinary\n', 'add control path')

    const snapshot = await buildPublicationGitSnapshot(input(root))
    assert.equal(snapshot.findings.some(finding => (
      finding.rule_id === 'unsupported_content.malformed_path'
    )), true)
  })

  it('flags binary and Git LFS blob content as unsupported', async () => {
    const binaryRepository = createRepository()
    commit(binaryRepository.root, 'opaque.bin', Buffer.from([0x41, 0x00, 0x42]), 'add opaque blob')
    const binary = await buildPublicationGitSnapshot(input(binaryRepository.root))
    assert.equal(binary.findings.some(finding => finding.rule_id === 'unsupported_content.nul'), true)

    const lfsRepository = createRepository()
    commit(lfsRepository.root, 'large.dat', [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'0'.repeat(64)}`,
      'size 100',
      '',
    ].join('\n'), 'add LFS pointer')
    const lfs = await buildPublicationGitSnapshot(input(lfsRepository.root))
    assert.equal(lfs.findings.some(finding => finding.rule_id === 'unsupported_content.git_lfs_pointer'), true)
  })

  it('rejects Git submodule entries', async () => {
    const { root } = createRepository()
    const submodule = createRepository()
    git(root, [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', submodule.root, 'vendor/example',
    ])
    git(root, ['commit', '-m', 'add gitlink fixture'])

    await rejectsWithCode(buildPublicationGitSnapshot(input(root)), 'unsupported_repository')
  })

  it('rejects replace refs, cancellation, and configured bounds', async () => {
    const replaceRepository = createRepository()
    const replaceHead = commit(replaceRepository.root, 'replace.txt', 'replace\n', 'replace fixture')
    git(replaceRepository.root, ['update-ref', `refs/replace/${replaceHead}`, replaceRepository.baseOid])
    await rejectsWithCode(buildPublicationGitSnapshot(input(replaceRepository.root)), 'unsupported_repository')

    const shallowSource = createRepository()
    commit(shallowSource.root, 'shallow.txt', 'shallow\n', 'shallow source')
    const shallowParent = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-shallow-'))
    temporaryDirectories.add(shallowParent)
    const shallowRoot = path.join(shallowParent, 'repository')
    execFileSync(GIT, ['clone', '--depth=1', '--no-local', shallowSource.root, shallowRoot], {
      cwd: shallowParent,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await rejectsWithCode(buildPublicationGitSnapshot(input(shallowRoot)), 'unsupported_repository')

    const cancelledRepository = createRepository()
    commit(cancelledRepository.root, 'cancelled.txt', 'cancelled\n', 'cancelled fixture')
    const controller = new AbortController()
    controller.abort()
    await rejectsWithCode(buildPublicationGitSnapshot(input(cancelledRepository.root, {
      signal: controller.signal,
    })), 'cancelled')

    const boundedRepository = createRepository()
    commit(boundedRepository.root, 'one.txt', 'one\n', 'one')
    commit(boundedRepository.root, 'two.txt', 'two\n', 'two')
    await rejectsWithCode(buildPublicationGitSnapshot(input(boundedRepository.root, {
      limits: { ...LIMITS, max_commits: 1 },
    })), 'limit_exceeded')
  })

  it('bounds a Git command that does not complete', async () => {
    const repository = createRepository()
    const child = fakeGitChild()
    setTimeout(() => child.emit('close', null, 'SIGKILL'), 30)

    await rejectsWithCode(buildPublicationGitSnapshot(input(repository.root, {
      command_timeout_ms: 20,
      spawnProcess: (() => child) as unknown as typeof spawn,
    })), 'command_timeout')
  })

  it('requires an operator-owned Git executable and normalizes synchronous spawn failures', async () => {
    const repository = createRepository()
    commit(repository.root, 'pinned.txt', 'pinned\n', 'pinned executable fixture')
    const trustedDirectory = fs.mkdtempSync(path.join(os.homedir(), '.publication-git-pinned-'))
    temporaryDirectories.add(trustedDirectory)
    const adapter = path.join(trustedDirectory, 'git')
    fs.copyFileSync(GIT, adapter)
    fs.chmodSync(adapter, 0o500)

    await rejectsWithCode(buildPublicationGitSnapshot(input(repository.root, {
      git_executable: adapter,
    })), 'invalid_configuration')
    if (ROOT_SCRIPT) {
      await rejectsWithCode(buildPublicationGitSnapshot(input(repository.root, {
        git_executable: ROOT_SCRIPT,
      })), 'invalid_configuration')
    }
    await rejectsWithCode(buildPublicationGitSnapshot(input(repository.root, {
      spawnProcess: (() => { throw new Error('simulated spawn failure') }) as typeof spawn,
    })), 'command_failed')
  })

  it('reports a Git process that never closes after termination', async () => {
    const repository = createRepository()
    const child = fakeGitChild()

    await rejectsWithCode(buildPublicationGitSnapshot(input(repository.root, {
      command_timeout_ms: 20,
      spawnProcess: (() => child) as unknown as typeof spawn,
    })), 'termination_uncertain')
  })
})
