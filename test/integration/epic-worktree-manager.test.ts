import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  cleanupIntegratedEpicAttemptWorktree,
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

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('epic worktree isolation and provenance', { concurrency: false }, () => {
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
