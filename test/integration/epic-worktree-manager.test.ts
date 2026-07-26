import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  checkpointEpicAttemptWorktree,
  cleanupIntegratedEpicAttemptWorktree,
  createEpicReviewPatch,
  createEpicAttemptWorktree,
  deriveEpicWorktreeIdentity,
  inspectEpicAttemptWorktree,
  parseEpicWorktreeEvidence,
} from '../../lib/epic-worktree-manager.js'

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
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-worktree-'))
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

function installCleanupBranchRace(
  root: string,
  parent: string,
  branch: string,
  expectedHead: string,
): { competingCommit: string; restore: () => void } {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const competingCommit = git(root, [
    'commit-tree', `${expectedHead}^{tree}`, '-p', expectedHead, '-m', 'concurrent branch advance',
  ])
  const shimDirectory = path.join(parent, 'git-shim')
  const shimPath = path.join(shimDirectory, 'git')
  fs.mkdirSync(shimDirectory)
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const result = spawnSync(process.env.REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)
if (args[0] === 'worktree' && args[1] === 'remove') {
  const advanced = spawnSync(process.env.REAL_GIT, ['update-ref', process.env.RACE_BRANCH, process.env.RACE_COMMIT, process.env.RACE_EXPECTED], { cwd: process.cwd(), stdio: 'inherit' })
  if (advanced.status !== 0) process.exit(advanced.status || 1)
}
process.exit(0)
`)
  fs.chmodSync(shimPath, 0o700)
  const previousPath = process.env.PATH
  process.env.PATH = `${shimDirectory}${path.delimiter}${previousPath ?? ''}`
  process.env.REAL_GIT = realGit
  process.env.RACE_BRANCH = `refs/heads/${branch}`
  process.env.RACE_COMMIT = competingCommit
  process.env.RACE_EXPECTED = expectedHead
  return {
    competingCommit,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      for (const name of ['REAL_GIT', 'RACE_BRANCH', 'RACE_COMMIT', 'RACE_EXPECTED']) delete process.env[name]
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('epic worktree isolation and provenance', { concurrency: false }, () => {
  it('checkpoints tracked and untracked work, returns exact tree evidence, and reuses a clean checkpoint', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    const injectedName = '-literal;not-a-command.txt'
    const marker = path.join(parent, 'injected')
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'checkpointed\n')
    fs.writeFileSync(path.join(created.path, injectedName), 'new file\n')

    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    assert.equal(checkpoint.created_commit, true)
    assert.deepEqual(checkpoint.changed_files.sort(), [injectedName, 'tracked.txt'])
    assert.match(checkpoint.checkpoint_commit, /^[a-f0-9]{40,64}$/)
    assert.equal(checkpoint.checkpoint_tree_oid, git(created.path, ['rev-parse', 'HEAD^{tree}']))
    assert.match(checkpoint.checkpoint_tree_sha256, /^[a-f0-9]{64}$/)
    assert.match(checkpoint.diff_stat, /tracked\.txt/)
    assert.equal(checkpoint.diff_stat_truncated, false)
    assert.equal(git(created.path, ['status', '--porcelain']), '')
    assert.equal(fs.existsSync(marker), false)

    const noOp = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    assert.equal(noOp.created_commit, false)
    assert.equal(noOp.checkpoint_commit, checkpoint.checkpoint_commit)
    assert.equal(noOp.checkpoint_tree_sha256, checkpoint.checkpoint_tree_sha256)
    assert.deepEqual(noOp.changed_files, [])
  })

  it('does not execute repository hooks during epic checkpoint commits', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    const hook = path.join(root, '.git', 'hooks', 'pre-commit')
    const marker = path.join(parent, 'hook-ran')
    fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > "${marker}"\n`)
    fs.chmodSync(hook, 0o700)
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'hooked checkpoint\n')
    checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    assert.equal(fs.existsSync(marker), false, 'repository hook must not execute during checkpoint')
  })

  it('creates an exact bounded review patch and refuses post-checkpoint mutations', () => {
    const { root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'reviewed\n')
    fs.writeFileSync(path.join(created.path, 'new file.txt'), 'new\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)

    const patch = createEpicReviewPatch(root, created.path, created.evidence, checkpoint.checkpoint_commit)
    assert.equal(patch.base_commit, created.evidence.base_commit)
    assert.equal(patch.checkpoint_commit, checkpoint.checkpoint_commit)
    assert.deepEqual(patch.changed_files.sort(), ['new file.txt', 'tracked.txt'])
    assert.equal(Buffer.byteLength(patch.patch_content), patch.patch_bytes)
    assert.match(patch.patch_content, /diff --git a\/tracked\.txt b\/tracked\.txt/)
    assert.match(patch.patch_sha256, /^[a-f0-9]{64}$/)
    assert.throws(
      () => createEpicReviewPatch(root, created.path, created.evidence, checkpoint.checkpoint_commit, { max_patch_bytes: 8 }),
      /exceeds the 8-byte limit/,
    )

    fs.writeFileSync(path.join(created.path, 'late.txt'), 'not reviewed\n')
    assert.throws(
      () => createEpicReviewPatch(root, created.path, created.evidence, checkpoint.checkpoint_commit),
      /clean worktree/,
    )
  })

  it('refuses to checkpoint an unresolved source conflict', () => {
    const { root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'source\n')
    git(created.path, ['add', 'tracked.txt'])
    git(created.path, ['commit', '-m', 'source change'])
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'target\n')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-m', 'target change'])
    assert.throws(() => git(created.path, ['merge', 'main']))

    assert.throws(
      () => checkpointEpicAttemptWorktree(root, created.path, created.evidence),
      /unresolved conflicts/,
    )
    assert.match(git(created.path, ['status', '--porcelain']), /UU tracked\.txt/)
  })

  it('derives canonical identities and cleans up only a reviewed integrated checkpoint', () => {
    const { root } = repository()
    const identity = deriveEpicWorktreeIdentity('epic-1', 'item-1', 'attempt-1')
    assert.match(identity.worktree_name, /^epic-[a-f0-9]{24}$/)
    assert.equal(identity.branch_name, 'epic/epic-1/item-1/attempt-1')

    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    assert.deepEqual(created.evidence, inspectEpicAttemptWorktree(root, created.path, created.evidence).evidence)
    assert.equal(created.head_commit, created.evidence.base_commit)
    assert.equal(cleanupIntegratedEpicAttemptWorktree(root, created.path, created.evidence, null, null), false)
    assert.equal(fs.existsSync(created.path), true)

    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'reviewed change\n')
    assert.equal(cleanupIntegratedEpicAttemptWorktree(root, created.path, created.evidence, created.head_commit, created.head_commit), false)
    git(created.path, ['add', 'tracked.txt'])
    git(created.path, ['commit', '-m', 'reviewed checkpoint'])
    const checkpoint = git(created.path, ['rev-parse', 'HEAD'])
    git(root, ['tag', created.evidence.branch_name, checkpoint])
    assert.equal(cleanupIntegratedEpicAttemptWorktree(root, created.path, created.evidence, checkpoint, checkpoint), false)
    assert.equal(fs.existsSync(created.path), true)
    git(root, ['merge', '--no-ff', '-m', 'integrate epic item', created.evidence.branch_name])
    const integrationCommit = git(root, ['rev-parse', 'HEAD'])

    assert.equal(cleanupIntegratedEpicAttemptWorktree(root, created.path, created.evidence, checkpoint, integrationCommit), true)
    assert.equal(fs.existsSync(created.path), false)
    assert.throws(() => git(root, ['show-ref', '--verify', `refs/heads/${created.evidence.branch_name}`]))
  })

  it('retains a concurrently advanced attempt branch during cleanup', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'reviewed change\n')
    const checkpoint = checkpointEpicAttemptWorktree(root, created.path, created.evidence)
    git(root, ['merge', '--no-ff', '-m', 'integrate fixture', checkpoint.checkpoint_commit])
    const integrationCommit = git(root, ['rev-parse', 'HEAD'])
    const race = installCleanupBranchRace(
      root,
      parent,
      created.evidence.branch_name,
      checkpoint.checkpoint_commit,
    )
    try {
      assert.equal(cleanupIntegratedEpicAttemptWorktree(
        root,
        created.path,
        created.evidence,
        checkpoint.checkpoint_commit,
        integrationCommit,
      ), false)
    } finally {
      race.restore()
    }
    assert.equal(fs.existsSync(created.path), false)
    assert.equal(git(root, ['rev-parse', `refs/heads/${created.evidence.branch_name}`]), race.competingCommit)
  })

  it('rejects identifier injection before creating work and preserves existing files', () => {
    const { parent, root } = repository()
    const marker = path.join(parent, 'injected')
    assert.throws(() => createEpicAttemptWorktree(root, 'refs/heads/main', 'epic;touch', 'item-1', 'attempt-1'), /safe identifier/)
    assert.throws(() => createEpicAttemptWorktree(root, 'main', 'epic-1', 'item-1', 'attempt-1'), /full local branch ref/)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'base\n')
  })

  it('fails closed on evidence tampering, inode rebinding, and symlink escape', () => {
    const { parent, root } = repository()
    const created = createEpicAttemptWorktree(root, 'refs/heads/main', 'epic-1', 'item-1', 'attempt-1')
    assert.throws(() => inspectEpicAttemptWorktree(root, created.path, {
      ...created.evidence,
      worktree_directory_ino: '0',
    }), /inode identity changed/)
    assert.throws(() => parseEpicWorktreeEvidence({ ...created.evidence, unknown: true }))
    assert.throws(() => parseEpicWorktreeEvidence({ ...created.evidence, branch_name: 'epic/other/item/attempt' }), /canonical identity/)
    assert.throws(() => inspectEpicAttemptWorktree(root, created.path, {
      ...created.evidence,
      base_commit: '0'.repeat(40),
    }), /not descended from its bound base commit/)

    const moved = path.join(parent, 'moved-worktree')
    fs.renameSync(created.path, moved)
    fs.symlinkSync(moved, created.path, 'dir')
    assert.throws(() => inspectEpicAttemptWorktree(root, created.path, created.evidence), /outside the managed worktree directory/)
    assert.equal(cleanupIntegratedEpicAttemptWorktree(root, created.path, created.evidence, created.head_commit, created.head_commit), false)
    assert.equal(fs.existsSync(path.join(moved, 'tracked.txt')), true)
  })
})
