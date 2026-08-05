import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanupStaleWorktrees,
  createWorktree,
  discardWorktree,
  getDelegationWorktreeName,
  getWorktreeDir,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
} from '../../lib/worktree-manager.js'

const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function createRepository(name = 'repository'): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-manager-'))
  const root = path.join(parent, name)
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

function assertNoMergeInProgress(repository: string): void {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
    cwd: repository,
    stdio: 'ignore',
  })
  assert.notEqual(result.status, 0, 'merge state should be aborted after failure')
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('worktree manager integration', { concurrency: false }, () => {
  it('checkpoints tracked edits, merges the committed branch, and safely cleans it up', () => {
    const { root } = createRepository()
    const worktree = createWorktree(root, 'task-1', 'main', 'workflow-1')
    assert.ok(worktree)
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false)
    assert.equal(worktree.path.startsWith(`${root}${path.sep}`), false)
    assert.match(worktree.path, /workflows[/\\]runtime[/\\]worktrees/)

    fs.writeFileSync(path.join(worktree.path, 'tracked.txt'), 'task change\n')
    const result = mergeWorktree(root, worktree.path, 'main')

    assert.equal(result.success, true)
    assert.match(result.merge_commit ?? '', /^[0-9a-f]{40,64}$/)
    assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'task change\n')
    assert.equal(git(worktree.path, ['status', '--porcelain']), '')
    assert.match(git(worktree.path, ['log', '-1', '--format=%s']), /^chore\(delegate\): checkpoint task-1$/)
    assert.equal(cleanupStaleWorktrees(root, 'workflow-1'), 1)
    assert.equal(fs.existsSync(worktree.path), false)
  })

  it('includes untracked files and handles repository and file paths containing spaces', () => {
    const { root } = createRepository('repository with spaces')
    const worktree = createWorktree(root, 'task-space', 'main', 'workflow-space')
    assert.ok(worktree)

    const fileName = 'new file with spaces.txt'
    fs.writeFileSync(path.join(worktree.path, fileName), 'untracked task output\n')
    const result = mergeWorktree(root, worktree.path, 'main')

    assert.equal(result.success, true)
    assert.equal(fs.readFileSync(path.join(root, fileName), 'utf8'), 'untracked task output\n')
    assert.equal(git(worktree.path, ['status', '--porcelain']), '')
    assert.match(git(worktree.path, ['show', '--format=', '--name-only', 'HEAD']), /new file with spaces\.txt/)
  })

  it('persists every generated object for a divergent nested-tree merge', () => {
    const { root } = createRepository()
    fs.mkdirSync(path.join(root, 'dir'))
    fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'base-a\n')
    fs.writeFileSync(path.join(root, 'dir', 'b.txt'), 'base-b\n')
    git(root, ['add', 'dir'])
    git(root, ['commit', '-m', 'nested base'])
    const worktree = createWorktree(root, 'task-nested', 'main', 'workflow-nested')
    assert.ok(worktree)
    fs.writeFileSync(path.join(worktree.path, 'dir', 'b.txt'), 'source-b\n')
    fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'target-a\n')
    git(root, ['commit', '-am', 'target nested change'])

    const result = mergeWorktree(root, worktree.path, 'main')

    assert.equal(result.success, true)
    assert.equal(fs.readFileSync(path.join(root, 'dir', 'a.txt'), 'utf8'), 'target-a\n')
    assert.equal(fs.readFileSync(path.join(root, 'dir', 'b.txt'), 'utf8'), 'source-b\n')
    assert.doesNotThrow(() => git(root, ['fsck', '--full', '--no-dangling']))
  })

  it('rejects slug and ref injection strings without executing them', () => {
    const { parent, root } = createRepository()
    const marker = path.join(parent, 'injected')
    const injection = `main;touch ${marker}`

    assert.equal(createWorktree(root, 'task;touch', 'main', 'workflow-1'), null)
    assert.equal(createWorktree(root, 'task-1', 'main', 'workflow/../../escape'), null)
    assert.equal(createWorktree(root, 'task-1', injection, 'workflow-1'), null)
    assert.equal(fs.existsSync(marker), false)

    const worktree = createWorktree(root, 'task-valid', 'main', 'workflow-1')
    assert.ok(worktree)
    fs.writeFileSync(path.join(worktree.path, 'source.txt'), 'preserved\n')

    assert.equal(mergeWorktree(root, worktree.path, injection).success, false)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.readFileSync(path.join(worktree.path, 'source.txt'), 'utf8'), 'preserved\n')
  })

  it('rejects a symlinked runtime path before materializing a managed worktree', () => {
    const { parent, root } = createRepository()
    const external = path.join(parent, 'external-runtime')
    const config = process.env.OPENCODE_CONFIG_DIR!
    fs.mkdirSync(external)
    fs.symlinkSync(external, config)

    assert.equal(createWorktree(root, 'task-symlink', 'main', 'workflow-symlink'), null)
    assert.equal(fs.existsSync(path.join(external, 'workflows')), false)
    assert.equal(git(root, ['branch', '--list', 'delegate/workflow-symlink/task-symlink']), '')
  })

  it('rejects a pre-existing symlinked worktree root', () => {
    const { parent, root } = createRepository()
    const external = path.join(parent, 'external-worktrees')
    const runtime = path.join(process.env.OPENCODE_CONFIG_DIR!, 'workflows', 'runtime')
    fs.mkdirSync(external)
    fs.mkdirSync(runtime, { recursive: true })
    fs.symlinkSync(external, path.join(runtime, 'worktrees'))

    assert.equal(createWorktree(root, 'task-root-link', 'main', 'workflow-root-link'), null)
    assert.deepEqual(fs.readdirSync(external), [])
  })

  it('ignores repository-configured filters and merge drivers', () => {
    const { parent, root } = createRepository()
    const filterMarker = path.join(parent, 'filter-ran')
    const mergeMarker = path.join(parent, 'merge-driver-ran')
    const filterScript = path.join(parent, 'filter.cjs')
    const mergeScript = path.join(parent, 'merge.cjs')
    fs.writeFileSync(filterScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(filterMarker)},'ran');process.stdin.pipe(process.stdout)\n`)
    fs.writeFileSync(mergeScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(mergeMarker)},'ran');fs.copyFileSync(process.argv[4],process.argv[3])\n`)
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=evil merge=evil\n')
    git(root, ['add', '.gitattributes'])
    git(root, ['commit', '-m', 'add hostile attributes'])
    git(root, ['config', 'filter.evil.clean', `node ${filterScript}`])
    git(root, ['config', 'filter.evil.smudge', `node ${filterScript}`])
    git(root, ['config', 'merge.evil.driver', `node ${mergeScript} %O %A %B`])

    const worktree = createWorktree(root, 'task-drivers', 'main', 'workflow-drivers')
    assert.ok(worktree)
    fs.writeFileSync(path.join(worktree.path, 'tracked.txt'), 'source change\n')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'target change\n')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-m', 'target change'])
    try { fs.unlinkSync(filterMarker) } catch {}

    mergeWorktree(root, worktree.path, 'main')
    assert.equal(fs.existsSync(filterMarker), false)
    assert.equal(fs.existsSync(mergeMarker), false)
  })

  it('refuses a target index symlink without mutating the external index', () => {
    const { parent, root } = createRepository()
    const worktree = createWorktree(root, 'task-index-link', 'main', 'workflow-index-link')
    assert.ok(worktree)
    fs.writeFileSync(path.join(worktree.path, 'tracked.txt'), 'source change\n')
    const targetHead = git(root, ['rev-parse', 'refs/heads/main'])
    const indexPath = path.join(root, '.git', 'index')
    const externalIndex = path.join(parent, 'external.index')
    fs.copyFileSync(indexPath, externalIndex)
    const expectedExternal = fs.readFileSync(externalIndex)
    fs.unlinkSync(indexPath)
    fs.symlinkSync(externalIndex, indexPath)

    assert.equal(mergeWorktree(root, worktree.path, 'main').success, false)
    assert.equal(git(root, ['rev-parse', 'refs/heads/main']), targetHead)
    assert.deepEqual(fs.readFileSync(externalIndex), expectedExternal)
    assert.equal(fs.lstatSync(indexPath).isSymbolicLink(), true)
  })

  it('refuses to checkpoint a tracked path rebound through an external symlink', () => {
    const { parent, root } = createRepository()
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'nested', 'value.txt'), 'inside\n')
    git(root, ['add', 'nested/value.txt'])
    git(root, ['commit', '-m', 'add nested file'])
    const worktree = createWorktree(root, 'task-symlink', 'main', 'workflow-symlink')
    assert.ok(worktree)

    const external = path.join(parent, 'external')
    fs.mkdirSync(external)
    fs.writeFileSync(path.join(external, 'value.txt'), 'outside\n')
    fs.rmSync(path.join(worktree.path, 'nested'), { recursive: true })
    fs.symlinkSync(external, path.join(worktree.path, 'nested'))

    assert.equal(mergeWorktree(root, worktree.path, 'main').success, false)
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'value.txt'), 'utf8'), 'inside\n')
  })

  it('refuses to checkpoint a tracked file hard-linked outside the managed worktree', () => {
    const { parent, root } = createRepository()
    const worktree = createWorktree(root, 'task-hardlink', 'main', 'workflow-hardlink')
    assert.ok(worktree)
    const external = path.join(parent, 'external.txt')
    fs.writeFileSync(external, 'outside\n')
    fs.rmSync(path.join(worktree.path, 'tracked.txt'))
    fs.linkSync(external, path.join(worktree.path, 'tracked.txt'))

    assert.equal(mergeWorktree(root, worktree.path, 'main').success, false)
    assert.equal(fs.readFileSync(external, 'utf8'), 'outside\n')
    assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'base\n')
  })

  it('refuses an empty merge unless the caller explicitly accepts a no-op', () => {
    const { root } = createRepository()
    const worktree = createWorktree(root, 'task-empty', 'main', 'workflow-empty')
    assert.ok(worktree)

    assert.equal(mergeWorktree(root, worktree.path, 'main').success, false)
    const noOpResult = mergeWorktree(root, worktree.path, 'main', { allowNoop: true })
    assert.deepEqual(noOpResult, { success: true, conflicts: [], merge_commit: null })
    assert.equal(fs.existsSync(worktree.path), true)
  })

  it('requires a clean target and leaves dirty task work untouched on refusal', () => {
    const { root } = createRepository()
    const worktree = createWorktree(root, 'task-target', 'main', 'workflow-target')
    assert.ok(worktree)

    const sourceFile = path.join(worktree.path, 'source.txt')
    const targetFile = path.join(root, 'target-dirty.txt')
    fs.writeFileSync(sourceFile, 'source work\n')
    fs.writeFileSync(targetFile, 'target work\n')

    assert.equal(mergeWorktree(root, worktree.path, 'main').success, false)
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'source work\n')
    assert.match(git(worktree.path, ['status', '--porcelain']), /source\.txt/)
    assert.equal(git(root, ['rev-list', '--count', `main..${worktree.branch}`]), '0')

    fs.rmSync(targetFile)
    assert.equal(mergeWorktree(root, worktree.path, 'main').success, true)
  })

  it('refuses cleanup of a dirty merged worktree until explicitly discarded', () => {
    const { root } = createRepository()
    const worktree = createWorktree(root, 'task-dirty', 'main', 'workflow-dirty')
    assert.ok(worktree)

    fs.writeFileSync(path.join(worktree.path, 'merged.txt'), 'merged\n')
    assert.equal(mergeWorktree(root, worktree.path, 'main').success, true)

    const lateFile = path.join(worktree.path, 'late-work.txt')
    fs.writeFileSync(lateFile, 'must not be silently removed\n')
    assert.equal(cleanupStaleWorktrees(root, 'workflow-dirty'), 0)
    assert.equal(removeWorktree(root, worktree.path), false)
    assert.equal(fs.readFileSync(lateFile, 'utf8'), 'must not be silently removed\n')

    assert.equal(discardWorktree(root, worktree.path), true)
    assert.equal(fs.existsSync(worktree.path), false)
  })

  it('rejects worktrees whose real path or branch escapes the managed identity', () => {
    const { parent, root } = createRepository()
    const worktreeDirectory = getWorktreeDir(root)
    const outsidePath = path.join(parent, 'outside-worktree')
    git(root, ['worktree', 'add', '-b', 'delegate/workflow-outside/task-outside', outsidePath, 'main'])

    const containedLink = path.join(worktreeDirectory, getDelegationWorktreeName('workflow-outside', 'task-outside'))
    fs.symlinkSync(outsidePath, containedLink, 'dir')

    assert.equal(removeWorktree(root, containedLink, { force: true }), false)
    assert.equal(mergeWorktree(root, containedLink, 'main').success, false)
    assert.equal(fs.existsSync(path.join(outsidePath, 'tracked.txt')), true)
    assert.equal(listWorktrees(root).some(worktree => worktree.path === outsidePath), false)

    const mismatchedPath = path.join(worktreeDirectory, getDelegationWorktreeName('workflow-branch', 'task-expected'))
    git(root, [
      'worktree', 'add', '-b',
      'delegate/workflow-branch/task-other',
      mismatchedPath,
      'main',
    ])
    assert.equal(removeWorktree(root, mismatchedPath, { force: true }), false)
    assert.equal(mergeWorktree(root, mismatchedPath, 'main').success, false)
    assert.equal(fs.existsSync(path.join(mismatchedPath, 'tracked.txt')), true)
    assert.equal(listWorktrees(root).some(worktree => worktree.path === mismatchedPath), false)
  })

  it('isolates reused task IDs by workflow identity', () => {
    const { root } = createRepository()
    const first = createWorktree(root, 'task-01', 'main', 'workflow-one')
    const second = createWorktree(root, 'task-01', 'main', 'workflow-two')

    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first.path, second.path)
    assert.notEqual(first.branch, second.branch)
    assert.equal(discardWorktree(root, first.path), true)
    assert.equal(discardWorktree(root, second.path), true)
  })

  it('preserves the checkpointed source branch and worktree after a merge conflict', () => {
    const { root } = createRepository()
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n')
    git(root, ['add', 'conflict.txt'])
    git(root, ['commit', '-m', 'add conflict fixture'])

    const worktree = createWorktree(root, 'task-conflict', 'main', 'workflow-conflict')
    assert.ok(worktree)
    fs.writeFileSync(path.join(worktree.path, 'conflict.txt'), 'source version\n')

    fs.writeFileSync(path.join(root, 'conflict.txt'), 'target version\n')
    git(root, ['add', 'conflict.txt'])
    git(root, ['commit', '-m', 'target change'])

    const result = mergeWorktree(root, worktree.path, 'main')
    assert.equal(result.success, false)
    assert.deepEqual(result.conflicts, ['conflict.txt'])
    assert.equal(fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8'), 'target version\n')
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']), '')
    assertNoMergeInProgress(root)

    assert.equal(fs.readFileSync(path.join(worktree.path, 'conflict.txt'), 'utf8'), 'source version\n')
    assert.equal(git(worktree.path, ['status', '--porcelain']), '')
    assert.equal(git(root, ['rev-list', '--count', `main..${worktree.branch}`]), '1')
    assert.equal(cleanupStaleWorktrees(root, 'workflow-conflict'), 0)
    assert.equal(fs.existsSync(worktree.path), true)
  })
})
