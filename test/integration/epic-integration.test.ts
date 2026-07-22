import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { sha256Hex } from '../../lib/canonical-json.ts'
import {
  EpicIntegrationAmbiguousError,
  integrateEpicCheckpoint,
  type EpicIntegrationInput,
} from '../../lib/epic-integration.ts'
import {
  checkpointEpicAttemptWorktree,
  createEpicAttemptWorktree,
} from '../../lib/epic-worktree-manager.ts'

const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repository(): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-integration-'))
  const root = path.join(parent, 'repository')
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, 'opencode-config')
  temporaryDirectories.add(parent)
  fs.mkdirSync(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Integration Test'])
  git(root, ['config', 'user.email', 'integration@example.com'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n')
  git(root, ['add', 'tracked.txt'])
  git(root, ['commit', '-m', 'initial'])
  return { parent, root }
}

function input(
  root: string,
  created: ReturnType<typeof createEpicAttemptWorktree>,
  sourceCommit: string,
  overrides: Partial<EpicIntegrationInput> = {},
): EpicIntegrationInput {
  return {
    project_root: root,
    project_identity_sha256: sha256Hex(fs.realpathSync(root)),
    integration_branch: 'refs/heads/main',
    expected_target_commit: git(root, ['rev-parse', 'HEAD']),
    source_checkpoint_commit: sourceCommit,
    source_worktree_path: created.path,
    worktree_evidence: created.evidence,
    dependency_snapshot_sha256: 'a'.repeat(64),
    review_evidence_digest: 'b'.repeat(64),
    ...overrides,
  }
}

function assertNoIntegrationState(root: string): void {
  for (const revision of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', revision], { cwd: root, stdio: 'ignore' })
    assert.notEqual(result.status, 0, `${revision} must not remain`)
  }
  assert.equal(fs.existsSync(path.join(root, '.git', 'rebase-merge')), false)
  assert.equal(fs.existsSync(path.join(root, '.git', 'rebase-apply')), false)
  assert.equal(fs.existsSync(path.join(root, '.git', 'sequencer')), false)
  assert.equal(fs.existsSync(path.join(root, '.git', 'BISECT_LOG')), false)
}

function installUpdateRefRace(root: string, parent: string, expectedTarget: string): {
  competingCommit: string
  restore: () => void
} {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const competingCommit = git(root, [
    'commit-tree', `${expectedTarget}^{tree}`, '-p', expectedTarget, '-m', 'competing target update',
  ])
  const shimDirectory = path.join(parent, 'git-shim')
  const shimPath = path.join(shimDirectory, 'git')
  const marker = path.join(parent, 'cas-injected')
  fs.mkdirSync(shimDirectory)
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'update-ref' && args[1] === process.env.CAS_BRANCH && !fs.existsSync(process.env.CAS_MARKER)) {
  fs.writeFileSync(process.env.CAS_MARKER, 'injected')
  const raced = spawnSync(process.env.REAL_GIT, ['update-ref', process.env.CAS_BRANCH, process.env.CAS_COMMIT, process.env.CAS_EXPECTED], { cwd: process.cwd(), stdio: 'inherit' })
  if (raced.status !== 0) process.exit(raced.status || 1)
}
const result = spawnSync(process.env.REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
process.exit(result.status === null ? 1 : result.status)
`)
  fs.chmodSync(shimPath, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ''}`
  process.env.REAL_GIT = realGit
  process.env.CAS_BRANCH = 'refs/heads/main'
  process.env.CAS_MARKER = marker
  process.env.CAS_COMMIT = competingCommit
  process.env.CAS_EXPECTED = expectedTarget
  return {
    competingCommit,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      for (const name of ['REAL_GIT', 'CAS_BRANCH', 'CAS_MARKER', 'CAS_COMMIT', 'CAS_EXPECTED']) delete process.env[name]
    },
  }
}

function installPostCasEdit(parent: string, editedFile: string): { restore: () => void } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const shimDirectory = path.join(parent, 'post-cas-git-shim')
  const shimPath = path.join(shimDirectory, 'git')
  fs.mkdirSync(shimDirectory)
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const result = spawnSync(process.env.REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)
if (args[0] === 'update-ref' && args[1] === process.env.CAS_BRANCH) {
  fs.writeFileSync(process.env.POST_CAS_EDIT, 'retained post-CAS edit\\n')
}
process.exit(0)
`)
  fs.chmodSync(shimPath, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ''}`
  process.env.REAL_GIT = realGit
  process.env.CAS_BRANCH = 'refs/heads/main'
  process.env.POST_CAS_EDIT = editedFile
  return {
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      for (const name of ['REAL_GIT', 'CAS_BRANCH', 'POST_CAS_EDIT']) delete process.env[name]
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('guarded epic integration', { concurrency: false }, () => {
  it('merges the exact checkpoint and verifies both parents while retaining audit bindings', () => {
    const { root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'source.txt'), 'reviewed source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    const request = input(root, created, checkpoint.checkpoint_commit)

    const result = integrateEpicCheckpoint(request)
    assert.equal(result.success, true)
    assert.equal(result.result, 'success')
    assert.equal(result.source_commit, checkpoint.checkpoint_commit)
    assert.equal(result.target_commit, request.expected_target_commit)
    assert.equal(result.dependency_snapshot_sha256, request.dependency_snapshot_sha256)
    assert.equal(result.review_evidence_digest, request.review_evidence_digest)
    assert.deepEqual(
      git(root, ['rev-list', '--parents', '-n', '1', result.result_commit]).split(/\s+/).slice(1),
      [request.expected_target_commit, checkpoint.checkpoint_commit],
    )
    assert.equal(git(root, ['status', '--porcelain']), '')
    assert.equal(git(created.path, ['rev-parse', 'HEAD']), checkpoint.checkpoint_commit)
    assert.equal(fs.existsSync(created.path), true)
  })

  it('refuses target advance and source worktree rebind before publication', () => {
    const first = repository()
    const firstCreated = createEpicAttemptWorktree(first.root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(firstCreated.path, 'source.txt'), 'source\n')
    const firstCheckpoint = checkpointEpicAttemptWorktree(first.root, firstCreated.path, firstCreated.evidence)
    const firstRequest = input(first.root, firstCreated, firstCheckpoint.checkpoint_commit)
    fs.writeFileSync(path.join(first.root, 'advance.txt'), 'advance\n')
    git(first.root, ['add', 'advance.txt'])
    git(first.root, ['commit', '-m', 'advance target'])
    assert.throws(() => integrateEpicCheckpoint(firstRequest), /target advanced/)
    assert.equal(git(first.root, ['rev-parse', 'HEAD^']), firstRequest.expected_target_commit)
    assert.notEqual(git(first.root, ['rev-parse', 'HEAD']), firstRequest.expected_target_commit)
    assertNoIntegrationState(first.root)

    const second = repository()
    const secondCreated = createEpicAttemptWorktree(second.root, 'refs/heads/main', 'epic-2', 'item-2', 'attempt-2')
    fs.writeFileSync(path.join(secondCreated.path, 'source.txt'), 'source\n')
    const secondCheckpoint = checkpointEpicAttemptWorktree(second.root, secondCreated.path, secondCreated.evidence)
    const secondRequest = input(second.root, secondCreated, secondCheckpoint.checkpoint_commit)
    git(secondCreated.path, ['reset', '--hard', secondCreated.evidence.base_commit])
    assert.throws(() => integrateEpicCheckpoint(secondRequest), /exact reviewed checkpoint|not descended/)
    assert.equal(git(second.root, ['rev-parse', 'HEAD']), secondRequest.expected_target_commit)
    assertNoIntegrationState(second.root)
  })

  it('detects conflicts before publication and retains a clean target and source worktree', () => {
    const { parent, root } = repository()
    const conflictName = '-literal;conflict.txt'
    const marker = path.join(parent, 'injected')
    fs.writeFileSync(path.join(root, conflictName), 'base\n')
    git(root, ['add', '--', conflictName])
    git(root, ['commit', '-m', 'add conflict fixture'])
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')

    fs.writeFileSync(path.join(created.path, conflictName), 'source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    fs.writeFileSync(path.join(root, conflictName), 'target\n')
    git(root, ['add', '--', conflictName])
    git(root, ['commit', '-m', 'target conflict'])
    const request = input(root, created, checkpoint.checkpoint_commit)

    const result = integrateEpicCheckpoint(request)
    assert.equal(result.success, false)
    assert.equal(result.result, 'conflict')
    assert.deepEqual(result.conflict_paths, [conflictName])
    assert.equal(result.result_commit, null)
    assert.equal(result.dependency_snapshot_sha256, request.dependency_snapshot_sha256)
    assert.equal(result.review_evidence_digest, request.review_evidence_digest)
    assert.equal(git(root, ['rev-parse', 'HEAD']), request.expected_target_commit)
    assert.equal(git(root, ['status', '--porcelain']), '')
    assertNoIntegrationState(root)
    assert.equal(git(created.path, ['rev-parse', 'HEAD']), checkpoint.checkpoint_commit)
    assert.equal(git(created.path, ['status', '--porcelain']), '')
    assert.equal(fs.existsSync(created.path), true)
    assert.equal(fs.existsSync(marker), false)
  })

  it('loses an atomic ref CAS without publishing the computed merge', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'source.txt'), 'source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    const request = input(root, created, checkpoint.checkpoint_commit)
    const race = installUpdateRefRace(root, parent, request.expected_target_commit)
    try {
      assert.throws(() => integrateEpicCheckpoint(request), /compare-and-swap failed/)
    } finally {
      race.restore()
    }
    assert.equal(git(root, ['rev-parse', 'refs/heads/main']), race.competingCommit)
    assert.deepEqual(
      git(root, ['rev-list', '--parents', '-n', '1', race.competingCommit]).split(/\s+/).slice(1),
      [request.expected_target_commit],
    )
    assert.equal(git(created.path, ['rev-parse', 'HEAD']), checkpoint.checkpoint_commit)
    assert.equal(fs.existsSync(created.path), true)
  })

  it('retains a local edit introduced after CAS and refuses destructive synchronization', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'source.txt'), 'source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    const request = input(root, created, checkpoint.checkpoint_commit)
    const editedFile = path.join(root, 'tracked.txt')
    const injection = installPostCasEdit(parent, editedFile)
    try {
      assert.throws(
        () => integrateEpicCheckpoint(request),
        error => error instanceof EpicIntegrationAmbiguousError && /synchronization is uncertain/.test(error.message),
      )
    } finally {
      injection.restore()
    }

    assert.equal(fs.readFileSync(editedFile, 'utf8'), 'retained post-CAS edit\n')
    assert.equal(fs.existsSync(path.join(root, 'source.txt')), false)
    const publishedMerge = git(root, ['rev-parse', 'refs/heads/main'])
    assert.deepEqual(
      git(root, ['rev-list', '--parents', '-n', '1', publishedMerge]).split(/\s+/).slice(1),
      [request.expected_target_commit, checkpoint.checkpoint_commit],
    )
    assert.equal(fs.existsSync(created.path), true)
  })

  it('rejects merge, rebase, cherry-pick, revert, sequencer, and bisect state', () => {
    const { root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'source.txt'), 'source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    const request = input(root, created, checkpoint.checkpoint_commit)
    const directoryStates = new Set(['rebase-merge', 'rebase-apply', 'sequencer'])
    const states = [
      'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
      'sequencer', 'BISECT_LOG', 'BISECT_START', 'BISECT_TERMS',
    ]
    for (const state of states) {
      const statePath = path.resolve(root, git(root, ['rev-parse', '--git-path', state]))
      if (directoryStates.has(state)) fs.mkdirSync(statePath)
      else fs.writeFileSync(statePath, 'operation state\n')
      assert.throws(() => integrateEpicCheckpoint(request), /incomplete Git operation/, state)
      fs.rmSync(statePath, { recursive: true, force: true })
      assert.equal(git(root, ['rev-parse', 'HEAD']), request.expected_target_commit)
    }
  })

  it('rejects identity and ref injection before invoking merge', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'source.txt'), 'source\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    const expectedTarget = git(root, ['rev-parse', 'HEAD'])
    const marker = path.join(parent, 'injected')

    assert.throws(() => integrateEpicCheckpoint(input(root, created, checkpoint.checkpoint_commit, {
      project_identity_sha256: '0'.repeat(64),
    })), /project identity/)
    assert.throws(() => integrateEpicCheckpoint(input(root, created, checkpoint.checkpoint_commit, {
      integration_branch: `refs/heads/main;touch-${marker}`,
    })), /full local branch ref/)
    assert.equal(git(root, ['rev-parse', 'HEAD']), expectedTarget)
    assert.equal(fs.existsSync(marker), false)
  })
})
