/**
 * Git Worktree Manager for Delegation Orchestration
 *
 * Manages git worktree lifecycle: create, list, merge, discard, cleanup.
 * Used by the delegation orchestrator to isolate CLI task execution.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sha256Hex } from './canonical-json.ts'
import type { WorktreeState, DelegationProvider } from './types.js'
import {
  assertPrivateDirectoryWithoutSymlinks,
  ensurePrivateDirectoryWithoutSymlinks,
  getRuntimeDir,
  hashIdentifier,
} from './paths.ts'
import { sandboxedGitArgs, sandboxedGitEnv, trustedGitExecutable } from './git-sandbox.ts'
import { withRepositoryOperationLock } from './repository-operation-lock.ts'
import { computeSandboxedMergeTree, updateWorktreeWithoutRepositoryDrivers } from './git-merge-sandbox.ts'

const WORKTREE_DIRECTORY = 'worktrees'
const WORKTREE_PREFIX = 'delegate-'
const BRANCH_PREFIX = 'delegate'
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
const WORKTREE_NAME_PATTERN = /^(?:delegate|epic)-[a-f0-9]{24}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_DIFF_METADATA_BYTES = 64 * 1024
const DEFAULT_MAX_PATCH_BYTES = 16 * 1024 * 1024

export interface MergeWorktreeOptions {
  allowNoop?: boolean
}

export interface RemoveWorktreeOptions {
  force?: boolean
}

export class WorktreeMergeAmbiguousError extends Error {
  readonly merge_commit: string
  constructor(message: string, mergeCommit: string) {
    super(message)
    this.name = 'WorktreeMergeAmbiguousError'
    this.merge_commit = mergeCommit
  }
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

export interface ManagedWorktreeCheckpoint {
  checkpoint_commit: string
  checkpoint_tree_oid: string
  checkpoint_tree_sha256: string
  changed_files: string[]
  diff_stat: string
  diff_stat_truncated: boolean
  created_commit: boolean
}

export interface ManagedReviewPatch {
  base_commit: string
  checkpoint_commit: string
  patch_sha256: string
  patch_content: string
  patch_bytes: number
  changed_files: string[]
}

export interface ManagedReviewPatchOptions {
  max_patch_bytes?: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd), {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sandboxedGitEnv(),
  }).trim()
}

function gitRaw(args: string[], cwd: string): string {
  return execFileSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd), {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sandboxedGitEnv(),
  })
}

function gitSucceeds(args: string[], cwd: string): boolean {
  const result = spawnSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd), {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sandboxedGitEnv(),
  })

  return !result.error && result.status === 0
}

function gitBuffer(args: string[], cwd: string, maxBytes: number): Buffer {
  const result = spawnSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd), {
    cwd,
    encoding: 'buffer',
    maxBuffer: maxBytes + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sandboxedGitEnv(),
  })
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOBUFS') {
      throw new Error(`Git output exceeds the ${maxBytes}-byte limit`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : ''
    throw new Error(`Git command failed${detail ? `: ${detail}` : ''}`)
  }
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0)
  if (output.byteLength > maxBytes) throw new Error(`Git output exceeds the ${maxBytes}-byte limit`)
  return output
}

function gitWithInput(args: string[], cwd: string, input: Buffer): string {
  const result = spawnSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd), {
    cwd,
    encoding: 'buffer',
    input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sandboxedGitEnv(),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : ''
    throw new Error(`Git command failed${detail ? `: ${detail}` : ''}`)
  }
  return (Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0)).toString('utf8').trim()
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

function safeGitIndexPath(worktreePath: string): string {
  const gitDirectory = fs.realpathSync(git(['rev-parse', '--absolute-git-dir'], worktreePath))
  const reported = git(['rev-parse', '--git-path', 'index'], worktreePath)
  const lexicalPath = path.resolve(worktreePath, reported)
  const parent = fs.realpathSync(path.dirname(lexicalPath))
  if (parent !== gitDirectory) throw new Error('Git index is outside the worktree metadata directory')
  const indexPath = path.join(parent, path.basename(lexicalPath))
  try {
    const stat = fs.lstatSync(indexPath)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error('Git index is not one regular unlinked file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return indexPath
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath)
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
}

interface WorktreeFileSnapshot {
  mode: string
  oid: string
}

function snapshotWorktreeFile(worktreePath: string, filePath: string, cachedMode: string | null): WorktreeFileSnapshot | null {
  const fullPath = path.join(worktreePath, assertSafeRelativePath(filePath))
  let stat: fs.Stats
  try { stat = fs.lstatSync(fullPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const realParent = fs.realpathSync(path.dirname(fullPath))
  if (realParent !== worktreePath && !isContainedPath(worktreePath, realParent)) {
    throw new Error(`worktree path parent resolves outside the managed worktree: ${filePath}`)
  }

  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(fullPath)
    const after = fs.lstatSync(fullPath)
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isSymbolicLink()) {
      throw new Error(`worktree symlink changed while being checkpointed: ${filePath}`)
    }
    const oid = gitWithInput(['hash-object', '-w', '--stdin'], worktreePath, Buffer.from(target, 'utf8'))
    validateOid(oid, 'staged symlink blob')
    return { mode: '120000', oid }
  }

  if (stat.isDirectory() && cachedMode === '160000') {
    throw new Error(`submodules cannot be checkpointed by the managed worktree boundary: ${filePath}`)
  }

  if (!stat.isFile()) throw new Error(`unsupported worktree file type cannot be checkpointed: ${filePath}`)
  let fd: number | null = null
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | (fs.constants?.O_NOFOLLOW ?? 0x20000))
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!opened.isFile() || Number(opened.dev) !== stat.dev || Number(opened.ino) !== stat.ino) {
      throw new Error(`worktree file changed while being checkpointed: ${filePath}`)
    }
    if (opened.nlink !== 1n) throw new Error(`hard-linked worktree file cannot be checkpointed safely: ${filePath}`)
    try {
      const descriptorPath = fs.realpathSync(`/proc/self/fd/${fd}`)
      if (!isContainedPath(worktreePath, descriptorPath)) {
        throw new Error(`worktree file descriptor resolves outside the managed worktree: ${filePath}`)
      }
    } catch (error) {
      if (process.platform === 'linux') throw error
      const resolved = fs.realpathSync(fullPath)
      if (!isContainedPath(worktreePath, resolved)) throw new Error(`worktree file resolves outside the managed worktree: ${filePath}`)
    }
    const content = fs.readFileSync(fd)
    const afterRead = fs.fstatSync(fd, { bigint: true })
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mode !== opened.mode
      || afterRead.mtimeNs !== opened.mtimeNs || afterRead.ctimeNs !== opened.ctimeNs
      || afterRead.nlink !== opened.nlink) {
      throw new Error(`worktree file changed while being checkpointed: ${filePath}`)
    }
    const oid = gitWithInput(['hash-object', '-w', '--stdin'], worktreePath, content)
    validateOid(oid, 'staged blob')
    return { mode: (opened.mode & 0o111n) !== 0n ? '100755' : '100644', oid }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function resolveWorktreeDirectory(projectRoot: string, create: boolean): string | null {
  const worktreeRoot = path.join(getRuntimeDir(), WORKTREE_DIRECTORY)
  const worktreeDirectory = path.join(worktreeRoot, hashIdentifier(projectRoot))

  if (create) {
    ensurePrivateDirectoryWithoutSymlinks(worktreeRoot)
    ensurePrivateDirectoryWithoutSymlinks(worktreeDirectory)
  } else {
    if (!fs.existsSync(worktreeDirectory)) return null
    assertPrivateDirectoryWithoutSymlinks(worktreeRoot)
    assertPrivateDirectoryWithoutSymlinks(worktreeDirectory)
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

function validateOid(value: string, label: string): void {
  if (!GIT_OID_PATTERN.test(value)) throw new Error(`${label} must be an exact Git object ID`)
}

function assertSafeRelativePath(filePath: string): string {
  if (!filePath || filePath.length > 4096 || filePath.includes('\0')
    || path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error('Git returned an unsafe worktree-relative path')
  }
  const segments = filePath.replaceAll('\\', '/').split('/')
  if (segments.includes('..') || !segments.some(segment => segment !== '' && segment !== '.')) {
    throw new Error('Git returned an unsafe worktree-relative path')
  }
  return filePath
}

function parseNulPaths(output: Buffer): string[] {
  if (output.length === 0) return []
  if (output.at(-1) !== 0) throw new Error('Git returned malformed path output')
  const paths: string[] = []
  let start = 0
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue
    const encoded = output.subarray(start, index)
    const filePath = encoded.toString('utf8')
    if (!Buffer.from(filePath, 'utf8').equals(encoded)) throw new Error('Git returned a path that is not valid UTF-8')
    paths.push(assertSafeRelativePath(filePath))
    start = index + 1
  }
  return paths
}

/**
 * Stage all changed files without invoking clean/smudge filters.
 *
 * Uses `git hash-object --no-filters -w` + `git update-index --cacheinfo`
 * instead of `git add -A` so that repository-defined filter drivers in
 * .gitattributes cannot execute arbitrary commands. Handles new, modified,
 * and deleted files.
 */
function stageAllWithoutFilters(worktreePath: string): void {
  // Use diff-files and ls-files --others instead of `git status --porcelain`
  // to avoid invoking clean/smudge filters.
  const statusOutput = gitRaw(['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--'], worktreePath)
  const unstagedFiles = statusOutput.split('\0').filter(Boolean)
  const untrackedOutput = gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath)
  const untrackedFiles = untrackedOutput.split('\0').filter(Boolean)

  for (const filePath of new Set([...unstagedFiles, ...untrackedFiles])) {
    if (!filePath) continue
    assertSafeRelativePath(filePath)
    const cachedMode = git(['ls-files', '--cached', '--format=%(objectmode)', '-z', '--', filePath], worktreePath).replace(/\0$/, '') || null
    const snapshot = snapshotWorktreeFile(worktreePath, filePath, cachedMode)
    if (snapshot === null) {
      git(['update-index', '--remove', '--', filePath], worktreePath)
      continue
    }
    git(['update-index', '--add', '--cacheinfo', `${snapshot.mode},${snapshot.oid},${filePath}`], worktreePath)
  }
}

function capUtf8(value: string, maxBytes: number): { content: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) return { content: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--
  return { content: encoded.subarray(0, end).toString('utf8'), truncated: true }
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

export function isWorktreeCleanAfterCommit(worktreePath: string, commitOid: string): boolean {
  if (!gitSucceeds(['diff-index', '--cached', '--quiet', '--ignore-submodules=none', commitOid, '--'], worktreePath)) return false
  const entries = gitRaw(['ls-files', '--stage', '-z'], worktreePath).split('\0').filter(Boolean)
  for (const entry of entries) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(entry)
    if (!match || match[3] !== '0') return false
    const snapshot = snapshotWorktreeFile(worktreePath, match[4]!, match[1]!)
    if (snapshot === null || snapshot.mode !== match[1] || snapshot.oid !== match[2]) return false
  }
  return git(['ls-files', '--others', '-z'], worktreePath) === ''
}

function readStatus(worktreePath: string): { changed_files: string[]; diff_stat: string; has_changes: boolean } {
  // Do NOT use `git status --porcelain` or `git diff --stat HEAD`: both
  // compare the working tree against the index/HEAD and invoke clean/smudge
  // filters defined in .gitattributes, which can execute arbitrary commands.
  // Instead, use plumbing that does not invoke filters:
  //   - diff-files: index vs working tree (stat-based, no clean filters)
  //   - diff-index --cached: index vs HEAD (no working tree, no filters)
  //   - ls-files --others: untracked files (no filters)
  const changedFiles: string[] = []
  const diffFiles = gitRaw(['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--'], worktreePath)
  for (const filePath of parseNulPaths(Buffer.from(diffFiles, 'utf8'))) {
    if (!changedFiles.includes(filePath)) changedFiles.push(filePath)
  }
  const diffIndex = gitRaw(['diff-index', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], worktreePath)
  for (const filePath of parseNulPaths(Buffer.from(diffIndex, 'utf8'))) {
    if (!changedFiles.includes(filePath)) changedFiles.push(filePath)
  }
  const untracked = gitRaw(['ls-files', '--others', '-z'], worktreePath)
  for (const filePath of parseNulPaths(Buffer.from(untracked, 'utf8'))) {
    if (!changedFiles.includes(filePath)) changedFiles.push(filePath)
  }
  return {
    changed_files: changedFiles,
    diff_stat: '',
    has_changes: changedFiles.length > 0,
  }
}

function isTargetWorktreeClean(projectRoot: string): boolean {
  return !readStatus(projectRoot).has_changes
}

function checkpointWorktree(worktreePath: string, taskId: string): void {
  if (!readStatus(worktreePath).has_changes) return

  stageAllWithoutFilters(worktreePath)
  if (gitSucceeds(['diff', '--cached', '--quiet', '--exit-code'], worktreePath)) {
    throw new Error('worktree changes could not be staged for checkpoint')
  }

  // Use commit-tree + update-ref to avoid invoking clean/smudge filters.
  const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath)
  const treeOid = git(['write-tree'], worktreePath)
  validateOid(treeOid, 'checkpoint tree')
  const commitOid = gitRaw(['commit-tree', treeOid, '-p', headCommit, '-m', `chore(delegate): checkpoint ${taskId}`], worktreePath).trim()
  validateOid(commitOid, 'checkpoint commit')
  git(['update-ref', 'HEAD', commitOid, headCommit], worktreePath)

  if (!isWorktreeCleanAfterCommit(worktreePath, commitOid)) {
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
  const baseCommit = git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`], realProjectRoot)
  git(['worktree', 'add', '--no-checkout', '-b', branchName, worktreePath, baseCommit], realProjectRoot)
  try {
    if (git(['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], realProjectRoot) !== baseCommit) {
      throw new Error('new managed worktree branch does not match its expected base commit')
    }
    const indexPath = safeGitIndexPath(worktreePath)
    updateWorktreeWithoutRepositoryDrivers(realProjectRoot, indexPath, worktreePath, ['read-tree', '--reset', '-u', baseCommit])
    return inspectManagedWorktree(realProjectRoot, worktreePath, worktreeName, branchName)
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      git(['worktree', 'remove', '--force', worktreePath], realProjectRoot)
    } catch (removeError) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true })
        git(['worktree', 'prune'], realProjectRoot)
      } catch (fallbackError) {
        cleanupErrors.push(removeError, fallbackError)
      }
    }
    try {
      git(['update-ref', '-d', `refs/heads/${branchName}`, baseCommit], realProjectRoot)
    } catch (branchError) {
      cleanupErrors.push(branchError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `managed worktree rollback was incomplete for ${worktreePath}`, { cause: error })
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
  const initialWorktreeIdentity = directoryIdentity(realWorktreePath, 'managed worktree')
  const projectCommonDirectory = resolveGitPath(realProjectRoot, git(['rev-parse', '--git-common-dir'], realProjectRoot))
  const initialCommonDirectory = resolveGitPath(realWorktreePath, git(['rev-parse', '--git-common-dir'], realWorktreePath))
  if (projectCommonDirectory !== initialCommonDirectory) throw new Error('managed worktree belongs to a different Git common directory')
  const initialCommonIdentity = directoryIdentity(initialCommonDirectory, 'Git common directory')

  const branch = readWorktreeBranch(realWorktreePath)
  if (branch !== expectedBranch) throw new Error('managed worktree branch does not match expected identity')
  validateLocalBranch(realProjectRoot, branch, 'managed branch')

  const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
  const branchCommit = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)
  if (headCommit !== branchCommit) throw new Error('managed worktree HEAD does not match its branch ref')
  const status = readStatus(realWorktreePath)
  const hasConflicts = gitRaw(['ls-files', '--unmerged', '-z'], realWorktreePath)
    .split('\0')
    .some(Boolean)

  const finalBranch = readWorktreeBranch(realWorktreePath)
  const finalHeadCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
  const finalBranchCommit = git(['rev-parse', '--verify', `refs/heads/${expectedBranch}^{commit}`], realProjectRoot)
  const finalStatus = readStatus(realWorktreePath)
  const finalHasConflicts = gitRaw(['ls-files', '--unmerged', '-z'], realWorktreePath)
    .split('\0')
    .some(Boolean)
  const finalCommonDirectory = resolveGitPath(realWorktreePath, git(['rev-parse', '--git-common-dir'], realWorktreePath))
  const finalRealWorktreePath = fs.realpathSync(worktreePath)
  const finalWorktreeIdentity = directoryIdentity(finalRealWorktreePath, 'managed worktree')
  const finalCommonIdentity = directoryIdentity(finalCommonDirectory, 'Git common directory')
  if (finalRealWorktreePath !== realWorktreePath
    || finalCommonDirectory !== initialCommonDirectory
    || finalBranch !== branch
    || finalHeadCommit !== headCommit
    || finalBranchCommit !== branchCommit
    || JSON.stringify(finalStatus) !== JSON.stringify(status)
    || finalHasConflicts !== hasConflicts
    || finalWorktreeIdentity.dev !== initialWorktreeIdentity.dev
    || finalWorktreeIdentity.ino !== initialWorktreeIdentity.ino
    || finalCommonIdentity.dev !== initialCommonIdentity.dev
    || finalCommonIdentity.ino !== initialCommonIdentity.ino) {
    throw new Error('managed worktree changed or was rebound during inspection')
  }
  return {
    name: expectedName,
    path: realWorktreePath,
    branch,
    head_commit: headCommit,
    directory_dev: initialWorktreeIdentity.dev,
    directory_ino: initialWorktreeIdentity.ino,
    git_common_directory: initialCommonDirectory,
    git_common_directory_dev: initialCommonIdentity.dev,
    git_common_directory_ino: initialCommonIdentity.ino,
    changed_files: status.changed_files,
    diff_stat: status.diff_stat,
    has_changes: status.has_changes,
    has_conflicts: hasConflicts,
  }
}

/**
 * Commit the complete tracked and untracked state of an exact managed
 * worktree. Hooks are intentionally honored. The returned tree SHA-256 binds
 * the repository's native tree OID without assuming its object format.
 */
function checkpointManagedWorktreeUnlocked(
  projectRoot: string,
  worktreePath: string,
  expectedName: string,
  expectedBranch: string,
  checkpointId: string,
): ManagedWorktreeCheckpoint {
  validateSlug(checkpointId, 'checkpoint ID')
  const before = inspectManagedWorktree(projectRoot, worktreePath, expectedName, expectedBranch)
  if (before.has_conflicts) throw new Error('managed worktree has unresolved conflicts')

  const changedFiles = before.changed_files.map(assertSafeRelativePath)
  if (!before.has_changes) {
    const treeOid = git(['rev-parse', '--verify', 'HEAD^{tree}'], before.path)
    validateOid(treeOid, 'checkpoint tree')
    return {
      checkpoint_commit: before.head_commit,
      checkpoint_tree_oid: treeOid,
      checkpoint_tree_sha256: sha256Hex(treeOid),
      changed_files: [],
      diff_stat: '',
      diff_stat_truncated: false,
      created_commit: false,
    }
  }

  stageAllWithoutFilters(before.path)
  if (gitSucceeds(['diff', '--cached', '--quiet', '--exit-code', '--'], before.path)) {
    throw new Error('managed worktree changes could not be staged for checkpoint')
  }
  const diffMetadata = capUtf8(
    gitRaw(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat=120,200', '--'], before.path),
    MAX_DIFF_METADATA_BYTES,
  )
  // Use commit-tree + update-ref instead of `git commit` to avoid invoking
  // clean/smudge filters that may be defined in .gitattributes.
  const stagedTreeOid = git(['write-tree'], before.path)
  validateOid(stagedTreeOid, 'checkpoint tree')
  const commitOid = gitRaw(['commit-tree', stagedTreeOid, '-p', before.head_commit, '-m', `chore(epic): checkpoint ${checkpointId}`], before.path).trim()
  validateOid(commitOid, 'checkpoint commit')
  git(['update-ref', `refs/heads/${expectedBranch}`, commitOid, before.head_commit], projectRoot)
  // Read the new commit's tree into the index so the index matches HEAD.
  // The index already matches the new commit because we wrote the tree from
  // it. We just need to verify there are no untracked files and the index
  // matches the commit.
  const after = inspectManagedWorktree(projectRoot, before.path, expectedName, expectedBranch)
  if (after.has_conflicts) {
    throw new Error('managed worktree has unresolved conflicts after checkpoint')
  }
  if (!isWorktreeCleanAfterCommit(before.path, commitOid)) {
    throw new Error('managed worktree changed while its checkpoint commit was being created')
  }
  const treeOid = git(['rev-parse', '--verify', `${after.head_commit}^{tree}`], after.path)
  validateOid(treeOid, 'checkpoint tree')
  return {
    checkpoint_commit: after.head_commit,
    checkpoint_tree_oid: treeOid,
    checkpoint_tree_sha256: sha256Hex(treeOid),
    changed_files: changedFiles,
    diff_stat: diffMetadata.content,
    diff_stat_truncated: diffMetadata.truncated,
    created_commit: true,
  }
}

export function checkpointManagedWorktree(
  projectRoot: string,
  worktreePath: string,
  expectedName: string,
  expectedBranch: string,
  checkpointId: string,
): ManagedWorktreeCheckpoint {
  return withRepositoryOperationLock(projectRoot, () => checkpointManagedWorktreeUnlocked(
    projectRoot,
    worktreePath,
    expectedName,
    expectedBranch,
    checkpointId,
  ))
}

/** Produce one bounded, byte-exact patch for an immutable commit range. */
export function createManagedReviewPatch(
  projectRoot: string,
  worktreePath: string,
  expectedName: string,
  expectedBranch: string,
  baseCommit: string,
  checkpointCommit: string,
  options: ManagedReviewPatchOptions = {},
): ManagedReviewPatch {
  validateOid(baseCommit, 'base commit')
  validateOid(checkpointCommit, 'checkpoint commit')
  const maxPatchBytes = options.max_patch_bytes ?? DEFAULT_MAX_PATCH_BYTES
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes <= 0 || maxPatchBytes > DEFAULT_MAX_PATCH_BYTES) {
    throw new Error(`patch byte limit must be between 1 and ${DEFAULT_MAX_PATCH_BYTES}`)
  }

  const before = inspectManagedWorktree(projectRoot, worktreePath, expectedName, expectedBranch)
  if (before.has_conflicts) throw new Error('review patch requires a worktree without conflicts')
  if (before.head_commit !== checkpointCommit) throw new Error('managed worktree HEAD does not equal the reviewed checkpoint')
  if (!isWorktreeCleanAfterCommit(worktreePath, checkpointCommit)) throw new Error('review patch requires a clean managed worktree')
  if (!managedCommitIsAncestor(projectRoot, baseCommit, checkpointCommit)) {
    throw new Error('reviewed checkpoint is not descended from its bound base commit')
  }

  const changedPathOutput = gitBuffer([
    'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', baseCommit, checkpointCommit, '--',
  ], before.path, MAX_DIFF_METADATA_BYTES)
  const changedFiles = parseNulPaths(changedPathOutput)
  const patch = gitBuffer([
    'diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv',
    baseCommit, checkpointCommit, '--',
  ], before.path, maxPatchBytes)
  const patchContent = patch.toString('utf8')
  if (!Buffer.from(patchContent, 'utf8').equals(patch)) {
    throw new Error('review patch is not valid UTF-8')
  }

  const after = inspectManagedWorktree(projectRoot, before.path, expectedName, expectedBranch)
  if (after.head_commit !== checkpointCommit || after.has_conflicts
    || after.directory_dev !== before.directory_dev || after.directory_ino !== before.directory_ino
    || after.git_common_directory_dev !== before.git_common_directory_dev
    || after.git_common_directory_ino !== before.git_common_directory_ino) {
    throw new Error('managed worktree changed while its review patch was being created')
  }
  if (!isWorktreeCleanAfterCommit(before.path, checkpointCommit)) {
    throw new Error('managed worktree changed while its review patch was being created')
  }
  return {
    base_commit: baseCommit,
    checkpoint_commit: checkpointCommit,
    patch_sha256: sha256Hex(patch),
    patch_content: patchContent,
    patch_bytes: patch.byteLength,
    changed_files: changedFiles,
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
  if (snapshot.has_conflicts) throw new Error('managed worktree with unresolved conflicts cannot be removed')
  if (!isWorktreeCleanAfterCommit(snapshot.path, snapshot.head_commit)) throw new Error('managed worktree with retained changes cannot be removed')
  const realProjectRoot = resolveProjectRoot(projectRoot)
  const currentBranchTip = git(['rev-parse', '--verify', `refs/heads/${snapshot.branch}^{commit}`], realProjectRoot)
  if (currentBranchTip !== snapshot.head_commit) {
    throw new Error('managed branch advanced concurrently and cannot be removed')
  }
  git(['worktree', 'remove', snapshot.path], realProjectRoot)
  git(['update-ref', '-d', `refs/heads/${snapshot.branch}`, snapshot.head_commit], realProjectRoot)
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

/** Pin reviewed integration evidence before deleting its attempt branch. */
export function retainManagedCommit(projectRoot: string, commit: string, identity: string): string {
  validateOid(commit, 'retained commit')
  const realProjectRoot = resolveProjectRoot(projectRoot)
  const retentionRef = `refs/opencode-workflows/retained/${sha256Hex(`${identity}\0${commit}`).slice(0, 40)}`
  const existing = gitSucceeds(['show-ref', '--verify', '--quiet', retentionRef], realProjectRoot)
    ? git(['rev-parse', '--verify', `${retentionRef}^{commit}`], realProjectRoot)
    : null
  if (existing !== null && existing !== commit) throw new Error('retention ref points to a different commit')
  if (existing === null) git(['update-ref', retentionRef, commit, ''], realProjectRoot)
  return retentionRef
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
  let created: { projectRoot: string; worktreePath: string; branchName: string; baseCommit: string } | null = null
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

    const baseCommit = git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`], realProjectRoot)
    git(['worktree', 'add', '--no-checkout', '-b', branchName, worktreePath, baseCommit], realProjectRoot)
    created = { projectRoot: realProjectRoot, worktreePath, branchName, baseCommit }
    const indexPath = safeGitIndexPath(worktreePath)
    updateWorktreeWithoutRepositoryDrivers(realProjectRoot, indexPath, worktreePath, ['read-tree', '--reset', '-u', baseCommit])
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
    if (created !== null) {
      try {
        try {
          git(['worktree', 'remove', '--force', created.worktreePath], created.projectRoot)
        } catch {
          fs.rmSync(created.worktreePath, { recursive: true, force: true })
          git(['worktree', 'prune'], created.projectRoot)
        }
        const branchRef = `refs/heads/${created.branchName}`
        if (gitSucceeds(['show-ref', '--verify', '--quiet', branchRef], created.projectRoot)) {
          git(['update-ref', '-d', branchRef, created.baseCommit], created.projectRoot)
        }
      } catch (cleanupError) {
        throw new Error(`worktree creation failed and rollback was incomplete for ${created.worktreePath}: ${cleanupError}`, { cause: err })
      }
    }
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
    const branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)

    if (!options.force) {
      if (!isWorktreeCleanAfterCommit(realWorktreePath, git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath))) {
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
      git(['update-ref', '-d', `refs/heads/${branch}`, branchHead], realProjectRoot)
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
function mergeWorktreeUnlocked(
  projectRoot: string,
  worktreePath: string,
  targetBranch: string,
  options: MergeWorktreeOptions = {},
): { success: boolean; conflicts: string[]; merge_commit: string | null } {
  const failure = (conflicts: string[] = []) => ({ success: false, conflicts, merge_commit: null })

  let realProjectRoot: string
  let realWorktreePath: string
  let branch: string
  let branchHead: string
  let targetHead: string
  let targetIndexPath: string

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

    branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)
    const worktreeHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
    if (branchHead !== worktreeHead || !isWorktreeCleanAfterCommit(realWorktreePath, worktreeHead)) {
      throw new Error('delegation branch is not a clean, committed snapshot of the worktree')
    }

    targetHead = git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot)
    const aheadCount = Number.parseInt(
      git(['rev-list', '--count', `${targetHead}..${branchHead}`], realProjectRoot),
      10,
    )
    if (!Number.isFinite(aheadCount) || aheadCount === 0) {
      if (options.allowNoop) {
        const finalBranch = readWorktreeBranch(realProjectRoot)
        const finalHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], realProjectRoot)
        const finalTarget = git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot)
        const finalSource = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot)
        const finalWorktreeHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath)
        const finalAheadCount = Number.parseInt(
          git(['rev-list', '--count', `${finalTarget}..${finalSource}`], realProjectRoot),
          10,
        )
        if (finalBranch !== targetBranch || finalHead !== targetHead || finalTarget !== targetHead
          || finalSource !== branchHead || finalWorktreeHead !== branchHead || finalAheadCount !== 0
          || !isWorktreeCleanAfterCommit(realWorktreePath, finalWorktreeHead)
          || !isTargetWorktreeClean(realProjectRoot)) {
          throw new Error('target worktree changed before explicit no-op acceptance')
        }
        console.error(`[worktree-manager] accepted explicit no-op for ${realWorktreePath}`)
        return { success: true, conflicts: [], merge_commit: null }
      }
      throw new Error('delegation branch has no changes to merge')
    }

    if (!isTargetWorktreeClean(realProjectRoot)) {
      throw new Error('target worktree changed before merge')
    }
    if (git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot) !== targetHead) {
      throw new Error('target branch advanced before merge')
    }
    targetIndexPath = safeGitIndexPath(realProjectRoot)
  } catch (err) {
    console.error(`[worktree-manager] refused to merge worktree ${worktreePath}: ${err}`)
    return failure()
  }

  let mergeTree: ReturnType<typeof computeSandboxedMergeTree>
  try {
    mergeTree = computeSandboxedMergeTree(realProjectRoot, targetHead, branchHead)
  } catch (error) {
    console.error(`[worktree-manager] merge-tree computation failed for branch ${branch}: ${error}`)
    return failure()
  }
  if (mergeTree.tree_oid === null) return failure(mergeTree.conflict_paths)
  if (git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot) !== targetHead
    || git(['rev-parse', '--verify', 'HEAD^{commit}'], realProjectRoot) !== targetHead
    || git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], realProjectRoot) !== branchHead
    || git(['rev-parse', '--verify', 'HEAD^{commit}'], realWorktreePath) !== branchHead
    || !isTargetWorktreeClean(realProjectRoot)
    || !isWorktreeCleanAfterCommit(realWorktreePath, branchHead)) {
    return failure()
  }
  for (const object of mergeTree.generated_objects) {
    const persistedObject = gitWithInput(['hash-object', '-w', '-t', object.type, '--stdin'], realProjectRoot, object.bytes)
    if (persistedObject !== object.oid) return failure()
  }
  if (!gitSucceeds(['cat-file', '-e', `${mergeTree.tree_oid}^{tree}`], realProjectRoot)) return failure()

  const mergeCommit = gitRaw([
    'commit-tree', mergeTree.tree_oid,
    '-p', targetHead,
    '-p', branchHead,
    '-m', `merge: delegate/${parseDelegationBranch(branch)?.taskId}`,
  ], realProjectRoot).trim()
  validateOid(mergeCommit, 'delegation merge commit')
  try {
    git(['update-ref', `refs/heads/${targetBranch}`, mergeCommit, targetHead], realProjectRoot)
  } catch (error) {
    const currentTarget = git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot)
    if (currentTarget === mergeCommit) {
      throw new WorktreeMergeAmbiguousError('delegation merge publication outcome is ambiguous', mergeCommit)
    }
    console.error(`[worktree-manager] target branch compare-and-swap failed for ${branch}: ${error}`)
    return failure()
  }

  try {
    if (safeGitIndexPath(realProjectRoot) !== targetIndexPath) throw new Error('Git index path changed before worktree synchronization')
    updateWorktreeWithoutRepositoryDrivers(
      realProjectRoot,
      targetIndexPath,
      realProjectRoot,
      ['read-tree', '-m', '-u', targetHead, mergeCommit],
    )
  } catch (error) {
    throw new WorktreeMergeAmbiguousError(`published merge worktree synchronization failed: ${error}`, mergeCommit)
  }
  const mergeParents = git(['rev-list', '--parents', '-n', '1', mergeCommit], realProjectRoot).split(/\s+/)
  if (mergeParents.length !== 3 || mergeParents[1] !== targetHead || mergeParents[2] !== branchHead) {
    throw new WorktreeMergeAmbiguousError('published merge does not preserve the exact reviewed parents', mergeCommit)
  }
  const finalBranch = readWorktreeBranch(realProjectRoot)
  const finalHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], realProjectRoot)
  const finalTarget = git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`], realProjectRoot)
  if (finalBranch !== targetBranch || finalHead !== mergeCommit || finalTarget !== mergeCommit || !isTargetWorktreeClean(realProjectRoot)) {
    throw new WorktreeMergeAmbiguousError('published merge target postconditions are uncertain', mergeCommit)
  }
  console.error(`[worktree-manager] merged ${branch} into ${targetBranch}: ${mergeCommit}`)
  return { success: true, conflicts: [], merge_commit: mergeCommit }
}

export function mergeWorktree(
  projectRoot: string,
  worktreePath: string,
  targetBranch: string,
  options: MergeWorktreeOptions = {},
): { success: boolean; conflicts: string[]; merge_commit: string | null } {
  return withRepositoryOperationLock(projectRoot, () => mergeWorktreeUnlocked(projectRoot, worktreePath, targetBranch, options))
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
