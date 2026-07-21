/**
 * Git Worktree Manager for Delegation Orchestration
 *
 * Manages git worktree lifecycle: create, list, merge, discard, cleanup.
 * Used by the delegation orchestrator to isolate CLI task execution.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WorktreeState, DelegationProvider } from './types.js'
import { ensurePrivateDirectory, getRuntimeDir, hashIdentifier } from './paths.ts'

const WORKTREE_DIRECTORY = 'worktrees'
const WORKTREE_PREFIX = 'delegate-'
const BRANCH_PREFIX = 'delegate'
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
const WORKTREE_NAME_PATTERN = /^(?:delegate|epic)-[a-f0-9]{24}$/

export interface MergeWorktreeOptions {
  allowNoop?: boolean
}

export interface RemoveWorktreeOptions {
  force?: boolean
}

export interface ManagedWorktreeSnapshot {
  name: string
  path: string
  branch: string
  head_commit: string
  directory_dev: string
  directory_ino: string
  git_common_directory: string
  git_common_directory_dev: string
  git_common_directory_ino: string
  changed_files: string[]
  diff_stat: string
  has_changes: boolean
  has_conflicts: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitRaw(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function gitSucceeds(args: string[], cwd: string): boolean {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return !result.error && result.status === 0
}

function resolveGitPath(cwd: string, gitPath: string): string {
  return fs.realpathSync(path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath))
}

function directoryIdentity(directory: string, label: string): { dev: string; ino: string } {
  const stat = fs.statSync(directory, { bigint: true })
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`)
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new Error(`${label} is owned by another user`)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function resolveProjectRoot(projectRoot: string): string {
  const requestedRoot = fs.realpathSync(projectRoot)
  const repositoryRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel'], requestedRoot))

  if (requestedRoot !== repositoryRoot) {
    throw new Error(`project root must be the repository worktree root: ${projectRoot}`)
  }

  return repositoryRoot
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath)
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
}

function resolveWorktreeDirectory(projectRoot: string, create: boolean): string | null {
  const worktreeRoot = path.join(getRuntimeDir(), WORKTREE_DIRECTORY)
  const worktreeDirectory = path.join(worktreeRoot, hashIdentifier(projectRoot))

  if (!fs.existsSync(worktreeDirectory)) {
    if (!create) return null
    ensurePrivateDirectory(worktreeRoot)
    ensurePrivateDirectory(worktreeDirectory)
  }

  const realWorktreeRoot = fs.realpathSync(worktreeRoot)
  const realDirectory = fs.realpathSync(worktreeDirectory)
  if (!isContainedPath(realWorktreeRoot, realDirectory)) {
    throw new Error(`worktree directory resolves outside the private runtime: ${worktreeDirectory}`)
  }

  return realDirectory
}

function validateSlug(value: string, label: string): void {
  if (!SLUG_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`${label} must be a safe slug (letters, numbers, dot, underscore, or hyphen)`)
  }
}

export function getDelegationWorktreeName(workflowId: string, taskId: string): string {
  validateSlug(workflowId, 'workflow ID')
  validateSlug(taskId, 'task ID')
  return `${WORKTREE_PREFIX}${hashIdentifier(`${workflowId}\0${taskId}`)}`
}

function validateRefSyntax(projectRoot: string, ref: string, label: string): void {
  if (!ref || ref.startsWith('-') || !gitSucceeds(['check-ref-format', '--branch', ref], projectRoot)) {
    throw new Error(`${label} is not a valid branch name: ${ref}`)
  }
}

function validateLocalBranch(projectRoot: string, branch: string, label: string): void {
  validateRefSyntax(projectRoot, branch, label)

  const fullRef = `refs/heads/${branch}`
  if (!gitSucceeds(['show-ref', '--verify', '--quiet', fullRef], projectRoot)
    || !gitSucceeds(['rev-parse', '--verify', '--quiet', `${fullRef}^{commit}`], projectRoot)) {
    throw new Error(`${label} does not resolve to a local branch commit: ${branch}`)
  }
}

function parseDelegationBranch(branch: string): { workflowId: string; taskId: string } | null {
  const parts = branch.split('/')
  if (parts.length !== 3 || parts[0] !== BRANCH_PREFIX) return null

  try {
    validateSlug(parts[1], 'workflow ID')
    validateSlug(parts[2], 'task ID')
  } catch {
    return null
  }

  return { workflowId: parts[1], taskId: parts[2] }
}

function resolveManagedWorktree(projectRoot: string, worktreePath: string): string {
  const worktreeDirectory = resolveWorktreeDirectory(projectRoot, false)
  if (!worktreeDirectory) {
    throw new Error('delegation worktree directory does not exist')
  }

  const realWorktreePath = fs.realpathSync(worktreePath)
  const name = path.basename(realWorktreePath)

  if (path.dirname(realWorktreePath) !== worktreeDirectory
    || !isContainedPath(worktreeDirectory, realWorktreePath)
    || !WORKTREE_NAME_PATTERN.test(name)) {
    throw new Error(`worktree is outside the managed worktree directory: ${worktreePath}`)
  }

  return realWorktreePath
}

function readWorktreeBranch(worktreePath: string): string {
  try {
    const fullRef = git(['symbolic-ref', '--quiet', 'HEAD'], worktreePath)
    return fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : ''
  } catch {
    return ''
  }
}

function assertManagedBranch(projectRoot: string, worktreePath: string): string {
  const branch = readWorktreeBranch(worktreePath)
  const delegationBranch = parseDelegationBranch(branch)

  if (!delegationBranch
    || path.basename(worktreePath) !== getDelegationWorktreeName(delegationBranch.workflowId, delegationBranch.taskId)) {
    throw new Error(`worktree is not on its expected delegation branch: ${worktreePath}`)
  }

  validateLocalBranch(projectRoot, branch, 'delegation branch')
  return branch
}

function parseStatusPaths(rawStatus: string): string[] {
  const records = rawStatus.split('\0')
  const changedFiles: string[] = []

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue

    const status = record.slice(0, 2)
    const filePath = record.slice(3)
    if (filePath) changedFiles.push(filePath)

    if (status.includes('R') || status.includes('C')) {
      index++
    }
  }

  return changedFiles
}

function readStatus(worktreePath: string): { changed_files: string[]; diff_stat: string; has_changes: boolean } {
  const rawStatus = gitRaw(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
  )
  const changedFiles = parseStatusPaths(rawStatus)
  const diffStat = git(['diff', '--stat', 'HEAD', '--'], worktreePath)

  return {
    changed_files: changedFiles,
    diff_stat: diffStat,
    has_changes: changedFiles.length > 0,
  }
}

function isTargetWorktreeClean(projectRoot: string): boolean {
  return !readStatus(projectRoot).has_changes
}

function checkpointWorktree(worktreePath: string, taskId: string): void {
  if (!readStatus(worktreePath).has_changes) return

  git(['add', '-A', '--'], worktreePath)
  if (gitSucceeds(['diff', '--cached', '--quiet', '--exit-code'], worktreePath)) {
    throw new Error('worktree changes could not be staged for checkpoint')
  }

  git([
    '-c', 'commit.gpgSign=false',
    '-c', 'user.name=OpenCode Workflows',
    '-c', 'user.email=opencode-workflows@localhost',
    'commit', '--no-verify', '-m', `chore(delegate): checkpoint ${taskId}`,
  ], worktreePath)

  if (readStatus(worktreePath).has_changes) {
    throw new Error('worktree changed while its checkpoint commit was being created')
  }
}

function branchWasMerged(projectRoot: string, branch: string): boolean {
  const branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], projectRoot)
  const mergeHistory = git(['rev-list', '--merges', '--parents', 'HEAD'], projectRoot)

  return mergeHistory.split('\n').some(line => {
    const commits = line.trim().split(/\s+/)
    return commits.length > 2 && commits.slice(2).includes(branchHead)
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the worktrees base directory for a project without modifying the
 * repository's ignore rules. Worktrees live in the private workflow runtime,
 * grouped by a hash of the canonical repository path.
 */
export function getWorktreeDir(projectRoot: string): string {
  const realProjectRoot = resolveProjectRoot(projectRoot)
  const worktreeDirectory = resolveWorktreeDirectory(realProjectRoot, true)
  if (!worktreeDirectory) throw new Error('failed to create worktree directory')
  return worktreeDirectory
}

/** Create an isolated worktree with caller-derived, prevalidated identity. */
export function createManagedWorktree(
  projectRoot: string,
  baseBranch: string,
  branchName: string,
  worktreeName: string,
): ManagedWorktreeSnapshot {
  const realProjectRoot = resolveProjectRoot(projectRoot)
  validateLocalBranch(realProjectRoot, baseBranch, 'base branch')
  validateRefSyntax(realProjectRoot, branchName, 'managed branch')
  if (!WORKTREE_NAME_PATTERN.test(worktreeName)) throw new Error('managed worktree name is invalid')

  const worktreePath = path.join(getWorktreeDir(realProjectRoot), worktreeName)
  if (fs.existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`)
  git(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], realProjectRoot)
  try {
    return inspectManagedWorktree(realProjectRoot, worktreePath, worktreeName, branchName)
  } catch (error) {
    try {
      git(['worktree', 'remove', '--force', worktreePath], realProjectRoot)
    } catch {
      // Best-effort rollback retains the original inspection failure.
    }
    try {
      git(['branch', '-D', branchName], realProjectRoot)
    } catch {
      // Best-effort rollback retains the original inspection failure.
    }
    throw error
  }
}

/** Revalidate exact path, branch, HEAD, ownership, inode, status, and common Git directory. */
export function inspectManagedWorktree(
  projectRoot: string,
  worktreePath: string,
  expectedName: string,
  expectedBranch: string,
): ManagedWorktreeSnapshot {
  const realProjectRoot = resolveProjectRoot(projectRoot)
  if (!WORKTREE_NAME_PATTERN.test(expectedName)) throw new Error('managed worktree name is invalid')
  validateRefSyntax(realProjectRoot, expectedBranch, 'managed branch')
  const realWorktreePath = resolveManagedWorktree(realProjectRoot, worktreePath)
  if (path.basename(realWorktreePath) !== expectedName) throw new Error('managed worktree name does not match expected identity')
  const branch = readWorktreeBranch(realWorktreePath)
  if (branch !== expectedBranch) throw new Error('managed worktree branch does not match expected identity')
  validateLocalBranch(realProjectRoot, branch, 'managed branch')

  const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
  const branchCommit = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)
  if (headCommit !== branchCommit) throw new Error('managed worktree HEAD does not match its branch ref')

  const projectCommonDirectory = resolveGitPath(realProjectRoot, git(['rev-parse', '--git-common-dir'], realProjectRoot))
  const worktreeCommonDirectory = resolveGitPath(realWorktreePath, git(['rev-parse', '--git-common-dir'], realWorktreePath))
  if (projectCommonDirectory !== worktreeCommonDirectory) throw new Error('managed worktree belongs to a different Git common directory')

  const worktreeIdentity = directoryIdentity(realWorktreePath, 'managed worktree')
  const commonIdentity = directoryIdentity(worktreeCommonDirectory, 'Git common directory')
  const status = readStatus(realWorktreePath)
  const hasConflicts = gitRaw(['diff', '--name-only', '--diff-filter=U', '-z'], realWorktreePath)
    .split('\0')
    .some(Boolean)
  return {
    name: expectedName,
    path: realWorktreePath,
    branch,
    head_commit: headCommit,
    directory_dev: worktreeIdentity.dev,
    directory_ino: worktreeIdentity.ino,
    git_common_directory: worktreeCommonDirectory,
    git_common_directory_dev: commonIdentity.dev,
    git_common_directory_ino: commonIdentity.ino,
    changed_files: status.changed_files,
    diff_stat: status.diff_stat,
    has_changes: status.has_changes,
    has_conflicts: hasConflicts,
  }
}

/** Remove an exact clean managed worktree after its caller proves retention policy permits cleanup. */
export function removeManagedWorktree(
  projectRoot: string,
  worktreePath: string,
  expectedName: string,
  expectedBranch: string,
): void {
  const snapshot = inspectManagedWorktree(projectRoot, worktreePath, expectedName, expectedBranch)
  if (snapshot.has_changes || snapshot.has_conflicts) throw new Error('managed worktree with retained changes or conflicts cannot be removed')
  const realProjectRoot = resolveProjectRoot(projectRoot)
  git(['worktree', 'remove', snapshot.path], realProjectRoot)
  git(['branch', '-D', snapshot.branch], realProjectRoot)
}

/** Check exact object IDs without accepting revision-expression syntax. */
export function managedCommitIsAncestor(projectRoot: string, ancestorCommit: string, descendantCommit: string): boolean {
  const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
  if (!oidPattern.test(ancestorCommit) || !oidPattern.test(descendantCommit)) return false
  const realProjectRoot = resolveProjectRoot(projectRoot)
  if (!gitSucceeds(['cat-file', '-e', `${ancestorCommit}^{commit}`], realProjectRoot)
    || !gitSucceeds(['cat-file', '-e', `${descendantCommit}^{commit}`], realProjectRoot)) return false
  return gitSucceeds(['merge-base', '--is-ancestor', ancestorCommit, descendantCommit], realProjectRoot)
}

/** Require integration evidence to remain reachable outside the attempt branch. */
export function managedCommitIsRetainedByAnotherBranch(
  projectRoot: string,
  commit: string,
  excludedBranch: string,
): boolean {
  const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
  if (!oidPattern.test(commit)) return false
  const realProjectRoot = resolveProjectRoot(projectRoot)
  validateRefSyntax(realProjectRoot, excludedBranch, 'excluded managed branch')
  if (!gitSucceeds(['cat-file', '-e', `${commit}^{commit}`], realProjectRoot)) return false
  const containingBranches = gitRaw(
    ['for-each-ref', '--format=%(refname)', `--contains=${commit}`, 'refs/heads'],
    realProjectRoot,
  ).split('\n').filter(Boolean)
  return containingBranches.some(branch => branch !== `refs/heads/${excludedBranch}`)
}

/**
 * Create a new git worktree for a delegation task.
 *
 * Worktree path : <runtime>/worktrees/<project-hash>/delegate-<identity-hash>
 * Branch        : delegate/<workflowId>/<taskId>
 *
 * Returns a WorktreeState on success, null on failure.
 */
export function createWorktree(
  projectRoot: string,
  taskId: string,
  baseBranch: string,
  workflowId: string,
  provider: DelegationProvider = 'claude',
): WorktreeState | null {
  try {
    validateSlug(taskId, 'task ID')
    validateSlug(workflowId, 'workflow ID')

    const realProjectRoot = resolveProjectRoot(projectRoot)
    validateLocalBranch(realProjectRoot, baseBranch, 'base branch')

    const worktreeDirectory = getWorktreeDir(realProjectRoot)
    const worktreeName = getDelegationWorktreeName(workflowId, taskId)
    const worktreePath = path.join(worktreeDirectory, worktreeName)
    const branchName = `${BRANCH_PREFIX}/${workflowId}/${taskId}`
    validateRefSyntax(realProjectRoot, branchName, 'delegation branch')

    if (fs.existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`)
    }

    git(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], realProjectRoot)
    const realWorktreePath = resolveManagedWorktree(realProjectRoot, worktreePath)

    console.error(`[worktree-manager] created worktree: ${realWorktreePath} on branch ${branchName}`)
    return {
      name: worktreeName,
      path: realWorktreePath,
      branch: branchName,
      task_id: taskId,
      provider,
      status: 'active',
      created_at: new Date().toISOString(),
      merged_at: null,
    }
  } catch (err) {
    console.error(`[worktree-manager] failed to create worktree for task ${taskId}: ${err}`)
    return null
  }
}

/**
 * Remove a clean worktree whose exact branch tip was merged into the current
 * branch. Pass `{ force: true }` only for an explicit discard operation.
 */
export function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): boolean {
  try {
    const realProjectRoot = resolveProjectRoot(projectRoot)
    const realWorktreePath = resolveManagedWorktree(realProjectRoot, worktreePath)
    const branch = assertManagedBranch(realProjectRoot, realWorktreePath)

    if (!options.force) {
      if (readStatus(realWorktreePath).has_changes) {
        throw new Error('worktree has uncommitted changes')
      }
      if (!branchWasMerged(realProjectRoot, branch)) {
        throw new Error('worktree branch has not been merged into the current branch')
      }
    }

    const removeArgs = ['worktree', 'remove']
    if (options.force) removeArgs.push('--force')
    removeArgs.push(realWorktreePath)
    git(removeArgs, realProjectRoot)
    console.error(`[worktree-manager] removed worktree: ${realWorktreePath}`)

    try {
      git(['branch', options.force ? '-D' : '-d', branch], realProjectRoot)
      console.error(`[worktree-manager] deleted branch: ${branch}`)
    } catch (err) {
      console.error(`[worktree-manager] warning: could not delete branch ${branch}: ${err}`)
    }

    return true
  } catch (err) {
    console.error(`[worktree-manager] refused to remove worktree ${worktreePath}: ${err}`)
    return false
  }
}

/**
 * List all active delegation worktrees for a project.
 */
export function listWorktrees(projectRoot: string): WorktreeState[] {
  try {
    const realProjectRoot = resolveProjectRoot(projectRoot)
    const worktreeDirectory = resolveWorktreeDirectory(realProjectRoot, false)
    if (!worktreeDirectory) return []

    const raw = gitRaw(['worktree', 'list', '--porcelain', '-z'], realProjectRoot)
    const blocks = raw.split('\0\0').filter(Boolean)
    const result: WorktreeState[] = []

    for (const block of blocks) {
      const fields = block.split('\0').filter(Boolean)
      const worktreeField = fields.find(field => field.startsWith('worktree '))
      const branchField = fields.find(field => field.startsWith('branch refs/heads/'))
      if (!worktreeField || !branchField) continue

      const listedPath = worktreeField.slice('worktree '.length)
      let realWorktreePath: string
      try {
        realWorktreePath = resolveManagedWorktree(realProjectRoot, listedPath)
      } catch {
        continue
      }

      const name = path.basename(realWorktreePath)
      const branch = branchField.slice('branch refs/heads/'.length)
      const delegationBranch = parseDelegationBranch(branch)
      if (!delegationBranch
        || name !== getDelegationWorktreeName(delegationBranch.workflowId, delegationBranch.taskId)) continue

      result.push({
        name,
        path: realWorktreePath,
        branch,
        task_id: delegationBranch.taskId,
        provider: 'claude',
        status: 'active',
        created_at: '',
        merged_at: null,
      })
    }

    return result
  } catch (err) {
    console.error(`[worktree-manager] failed to list worktrees: ${err}`)
    return []
  }
}

/**
 * Checkpoint every task edit, then merge only the committed delegation branch
 * into the clean target worktree using --no-ff.
 */
export function mergeWorktree(
  projectRoot: string,
  worktreePath: string,
  targetBranch: string,
  options: MergeWorktreeOptions = {},
): { success: boolean; conflicts: string[]; merge_commit: string | null } {
  const failure = (conflicts: string[] = []) => ({ success: false, conflicts, merge_commit: null })

  let realProjectRoot: string
  let realWorktreePath: string
  let branch: string

  try {
    realProjectRoot = resolveProjectRoot(projectRoot)
    validateLocalBranch(realProjectRoot, targetBranch, 'target branch')
    realWorktreePath = resolveManagedWorktree(realProjectRoot, worktreePath)
    branch = assertManagedBranch(realProjectRoot, realWorktreePath)

    const checkedOutBranch = readWorktreeBranch(realProjectRoot)
    if (checkedOutBranch !== targetBranch) {
      throw new Error(`target branch ${targetBranch} is not checked out in the target worktree`)
    }
    if (!isTargetWorktreeClean(realProjectRoot)) {
      throw new Error('target worktree has uncommitted changes')
    }

    const taskId = parseDelegationBranch(branch)?.taskId
    if (!taskId) throw new Error(`invalid delegation branch: ${branch}`)
    checkpointWorktree(realWorktreePath, taskId)

    const branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)
    const worktreeHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
    if (branchHead !== worktreeHead || readStatus(realWorktreePath).has_changes) {
      throw new Error('delegation branch is not a clean, committed snapshot of the worktree')
    }

    const aheadCount = Number.parseInt(
      git(['rev-list', '--count', `${targetBranch}..${branch}`], realProjectRoot),
      10,
    )
    if (!Number.isFinite(aheadCount) || aheadCount === 0) {
      if (options.allowNoop) {
        console.error(`[worktree-manager] accepted explicit no-op for ${realWorktreePath}`)
        return { success: true, conflicts: [], merge_commit: null }
      }
      throw new Error('delegation branch has no changes to merge')
    }

    if (!isTargetWorktreeClean(realProjectRoot)) {
      throw new Error('target worktree changed before merge')
    }
  } catch (err) {
    console.error(`[worktree-manager] refused to merge worktree ${worktreePath}: ${err}`)
    return failure()
  }

  try {
    git(
      ['merge', '--no-ff', '-m', `merge: delegate/${parseDelegationBranch(branch)?.taskId}`, branch],
      realProjectRoot,
    )
  } catch (err) {
    console.error(`[worktree-manager] merge failed for branch ${branch}: ${err}`)

    let conflicts: string[] = []
    try {
      conflicts = gitRaw(['diff', '--name-only', '--diff-filter=U', '-z'], realProjectRoot)
        .split('\0')
        .filter(Boolean)
    } catch {
      // Best-effort conflict reporting.
    }

    try {
      git(['merge', '--abort'], realProjectRoot)
    } catch (abortError) {
      console.error(`[worktree-manager] warning: could not abort failed merge: ${abortError}`)
    }

    return failure(conflicts)
  }

  const mergeCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], realProjectRoot)
  console.error(`[worktree-manager] merged ${branch} into ${targetBranch}: ${mergeCommit}`)
  return { success: true, conflicts: [], merge_commit: mergeCommit }
}

/**
 * Explicitly discard a worktree and its branch, including dirty or unmerged
 * work. This is the destructive counterpart to safe removeWorktree.
 */
export function discardWorktree(projectRoot: string, worktreePath: string): boolean {
  console.error(`[worktree-manager] explicitly discarding worktree: ${worktreePath}`)
  return removeWorktree(projectRoot, worktreePath, { force: true })
}

/** Return the working status of a worktree. */
export function getWorktreeStatus(worktreePath: string): {
  changed_files: string[]
  diff_stat: string
  has_changes: boolean
} {
  try {
    return readStatus(fs.realpathSync(worktreePath))
  } catch (err) {
    console.error(`[worktree-manager] failed to get status for ${worktreePath}: ${err}`)
    return { changed_files: [], diff_stat: '', has_changes: false }
  }
}

/**
 * Remove delegation worktrees that are clean and demonstrably merged.
 * Dirty or unmerged worktrees are retained unless `{ force: true }` is passed.
 */
export function cleanupStaleWorktrees(
  projectRoot: string,
  workflowId?: string,
  options: RemoveWorktreeOptions = {},
): number {
  if (workflowId) {
    try {
      validateSlug(workflowId, 'workflow ID')
    } catch (err) {
      console.error(`[worktree-manager] refused cleanup: ${err}`)
      return 0
    }
  }

  const worktrees = listWorktrees(projectRoot)
  const branchPrefix = workflowId ? `${BRANCH_PREFIX}/${workflowId}/` : null
  let removed = 0

  for (const worktree of worktrees) {
    if (branchPrefix && !worktree.branch.startsWith(branchPrefix)) continue
    if (removeWorktree(projectRoot, worktree.path, options)) removed++
  }

  console.error(`[worktree-manager] cleanup complete: removed ${removed} worktree(s)`)
  return removed
}
