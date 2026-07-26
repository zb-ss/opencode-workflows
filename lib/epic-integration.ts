import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sha256Hex } from './canonical-json.ts'
import {
  inspectEpicAttemptWorktree,
  parseEpicWorktreeEvidence,
  type EpicWorktreeEvidence,
} from './epic-worktree-manager.ts'

const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const MAX_CONFLICT_PATH_BYTES = 64 * 1024
const OPERATION_STATE_NAMES = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
  'BISECT_LOG',
  'BISECT_START',
  'BISECT_TERMS',
] as const

export interface EpicIntegrationInput {
  project_root: string
  project_identity_sha256: string
  integration_branch: string
  expected_target_commit: string
  source_checkpoint_commit: string
  source_worktree_path: string
  worktree_evidence: EpicWorktreeEvidence
  dependency_snapshot_sha256: string
  review_evidence_digest: string
}

interface EpicIntegrationResultBase {
  source_commit: string
  target_commit: string
  dependency_snapshot_sha256: string
  review_evidence_digest: string
}

export interface EpicIntegrationSuccess extends EpicIntegrationResultBase {
  success: true
  result: 'success'
  result_commit: string
  conflict_paths: []
}

export interface EpicIntegrationConflict extends EpicIntegrationResultBase {
  success: false
  result: 'conflict'
  result_commit: null
  conflict_paths: string[]
}

export type EpicIntegrationResult = EpicIntegrationSuccess | EpicIntegrationConflict

export interface EpicRecoveredIntegrationVerificationInput {
  project_root: string
  project_identity_sha256: string
  integration_branch: string
  expected_target_commit: string
  source_checkpoint_commit: string
  result_commit: string
}

export class EpicIntegrationAmbiguousError extends Error {
  readonly expected_target_commit: string
  readonly source_checkpoint_commit: string
  readonly conflict_paths: string[]

  constructor(message: string, input: EpicIntegrationInput, conflictPaths: string[] = [], options?: ErrorOptions) {
    super(message, options)
    this.name = 'EpicIntegrationAmbiguousError'
    this.expected_target_commit = input.expected_target_commit
    this.source_checkpoint_commit = input.source_checkpoint_commit
    this.conflict_paths = conflictPaths
  }
}

interface GitOptions {
  env?: NodeJS.ProcessEnv
  input?: string
  max_output_bytes?: number
}

interface TargetWorktreeIdentity {
  path: string
  directory_dev: string
  directory_ino: string
  git_common_directory: string
  git_common_directory_dev: string
  git_common_directory_ino: string
}

function runGit(args: string[], cwd: string, options: GitOptions = {}): SpawnSyncReturns<Buffer> {
  const maxOutputBytes = options.max_output_bytes ?? MAX_GIT_OUTPUT_BYTES
  return spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    maxBuffer: maxOutputBytes + 1,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function git(args: string[], cwd: string, options: GitOptions = {}): string {
  const result = runGit(args, cwd, options)
  const maxOutputBytes = options.max_output_bytes ?? MAX_GIT_OUTPUT_BYTES
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOBUFS') {
      throw new Error(`Git output exceeds the ${maxOutputBytes}-byte limit`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim()
    throw new Error(`Git command failed${detail ? `: ${detail}` : ''}`)
  }
  if (result.stdout.byteLength > maxOutputBytes || result.stderr.byteLength > maxOutputBytes) {
    throw new Error(`Git output exceeds the ${maxOutputBytes}-byte limit`)
  }
  return result.stdout.toString('utf8').trim()
}

function gitSucceeds(args: string[], cwd: string, options: GitOptions = {}): boolean {
  const result = runGit(args, cwd, options)
  return !result.error && result.status === 0
}

function validateOid(value: string, label: string): void {
  if (!GIT_OID_PATTERN.test(value)) throw new Error(`${label} must be an exact Git object ID`)
}

function validateSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`)
}

function resolveProjectRoot(projectRoot: string): string {
  const requested = fs.realpathSync(projectRoot)
  const repository = fs.realpathSync(git(['rev-parse', '--show-toplevel'], requested))
  if (requested !== repository) throw new Error('project root must be the canonical repository worktree root')
  return repository
}

function resolveGitPath(projectRoot: string, name: string): string {
  const gitPath = git(['rev-parse', '--git-path', name], projectRoot)
  return path.resolve(projectRoot, gitPath)
}

function directoryIdentity(directory: string): { dev: string; ino: string } {
  const stat = fs.statSync(directory, { bigint: true })
  if (!stat.isDirectory()) throw new Error('canonical Git directory identity is not a directory')
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new Error('canonical Git directory identity is owned by another user')
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function captureTargetWorktreeIdentity(projectRoot: string): TargetWorktreeIdentity {
  const realProjectRoot = fs.realpathSync(projectRoot)
  const worktreeIdentity = directoryIdentity(realProjectRoot)
  const commonPath = git(['rev-parse', '--git-common-dir'], realProjectRoot)
  const commonDirectory = fs.realpathSync(path.isAbsolute(commonPath) ? commonPath : path.resolve(realProjectRoot, commonPath))
  const commonIdentity = directoryIdentity(commonDirectory)
  return {
    path: realProjectRoot,
    directory_dev: worktreeIdentity.dev,
    directory_ino: worktreeIdentity.ino,
    git_common_directory: commonDirectory,
    git_common_directory_dev: commonIdentity.dev,
    git_common_directory_ino: commonIdentity.ino,
  }
}

function assertTargetWorktreeIdentity(projectRoot: string, expected: TargetWorktreeIdentity): void {
  const current = captureTargetWorktreeIdentity(projectRoot)
  if (current.path !== expected.path
    || current.directory_dev !== expected.directory_dev
    || current.directory_ino !== expected.directory_ino
    || current.git_common_directory !== expected.git_common_directory
    || current.git_common_directory_dev !== expected.git_common_directory_dev
    || current.git_common_directory_ino !== expected.git_common_directory_ino) {
    throw new Error('canonical integration worktree identity changed')
  }
}

function hasOperationState(projectRoot: string): boolean {
  return OPERATION_STATE_NAMES.some(name => fs.existsSync(resolveGitPath(projectRoot, name)))
}

function isClean(projectRoot: string): boolean {
  return git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], projectRoot) === ''
}

function indexAndWorktreeMatchCommit(projectRoot: string, commit: string): boolean {
  if (!gitSucceeds(['diff-index', '--cached', '--quiet', '--ignore-submodules=none', commit, '--'], projectRoot)) return false
  if (!gitSucceeds(['diff-files', '--quiet', '--ignore-submodules=none', '--'], projectRoot)) return false
  return git(['ls-files', '--others', '--exclude-standard', '-z'], projectRoot) === ''
}

function assertIntegrationBranch(projectRoot: string, integrationBranch: string): void {
  if (!integrationBranch.startsWith('refs/heads/')
    || !gitSucceeds(['check-ref-format', integrationBranch], projectRoot)
    || !gitSucceeds(['show-ref', '--verify', '--quiet', integrationBranch], projectRoot)) {
    throw new Error('integration branch must be an existing full local branch ref')
  }
  if (git(['symbolic-ref', '--quiet', 'HEAD'], projectRoot) !== integrationBranch) {
    throw new Error('integration branch is not checked out in the canonical project worktree')
  }
}

function assertTargetReady(projectRoot: string, integrationBranch: string, expectedTarget: string): void {
  assertIntegrationBranch(projectRoot, integrationBranch)
  if (hasOperationState(projectRoot)) throw new Error('integration target has an incomplete Git operation')
  if (!isClean(projectRoot)) throw new Error('integration target is not clean')
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], projectRoot)
  const branchHead = git(['rev-parse', '--verify', `${integrationBranch}^{commit}`], projectRoot)
  if (head !== expectedTarget || branchHead !== expectedTarget) {
    throw new Error('integration target advanced from its expected commit')
  }
}

function assertSourceReady(projectRoot: string, input: EpicIntegrationInput): void {
  const source = inspectEpicAttemptWorktree(projectRoot, input.source_worktree_path, input.worktree_evidence)
  if (source.head_commit !== input.source_checkpoint_commit || source.has_changes || source.has_conflicts) {
    throw new Error('source worktree is not clean at the exact reviewed checkpoint')
  }
}

function assertSafeConflictPath(filePath: string): string {
  if (!filePath || filePath.length > 4096 || filePath.includes('\0')
    || path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error('Git returned an unsafe conflict path')
  }
  const segments = filePath.replaceAll('\\', '/').split('/')
  if (segments.includes('..') || !segments.some(segment => segment !== '' && segment !== '.')) {
    throw new Error('Git returned an unsafe conflict path')
  }
  return filePath
}

function parseUnmergedPaths(output: Buffer): string[] {
  if (output.length === 0) return []
  if (output.length > MAX_CONFLICT_PATH_BYTES || output.at(-1) !== 0) {
    throw new Error('conflict path evidence exceeds its safe bound')
  }
  const paths = new Set<string>()
  let start = 0
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue
    const record = output.subarray(start, index)
    const tab = record.indexOf(9)
    if (tab < 0) throw new Error('Git returned malformed conflict path evidence')
    const encoded = record.subarray(tab + 1)
    const filePath = encoded.toString('utf8')
    if (!Buffer.from(filePath, 'utf8').equals(encoded)) throw new Error('conflict path is not valid UTF-8')
    paths.add(assertSafeConflictPath(filePath))
    start = index + 1
  }
  return [...paths]
}

interface MergeTreeResult {
  tree_oid: string | null
  conflict_paths: string[]
}

function computeMergeTree(projectRoot: string, targetCommit: string, sourceCommit: string): MergeTreeResult {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-merge-tree-'))
  const temporaryWorktree = path.join(temporaryRoot, 'worktree')
  const temporaryIndex = path.join(temporaryRoot, 'index')
  fs.mkdirSync(temporaryWorktree, { mode: 0o700 })
  const gitDirectory = fs.realpathSync(path.resolve(projectRoot, git(['rev-parse', '--git-common-dir'], projectRoot)))
  const environment = {
    GIT_DIR: gitDirectory,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_WORK_TREE: temporaryWorktree,
  }

  let outcome: MergeTreeResult
  try {
    const mergeBases = git(['merge-base', '--all', targetCommit, sourceCommit], projectRoot)
      .split('\n').filter(Boolean)
    if (mergeBases.length === 0) throw new Error('source and target do not share a merge base')
    mergeBases.forEach(base => validateOid(base, 'merge base'))
    git(['read-tree', targetCommit], projectRoot, { env: environment })
    git(['checkout-index', '--all', '--force'], temporaryWorktree, { env: environment })
    git(['update-index', '--refresh'], temporaryWorktree, { env: environment })
    const merge = runGit(
      ['merge-recursive', ...mergeBases, '--', targetCommit, sourceCommit],
      temporaryWorktree,
      { env: environment },
    )
    if (merge.error) throw merge.error
    if (merge.status === 0) {
      const treeOid = git(['write-tree'], projectRoot, { env: environment })
      validateOid(treeOid, 'computed merge tree')
      outcome = { tree_oid: treeOid, conflict_paths: [] }
    } else if (merge.status === 1) {
      const unmerged = runGit(
        ['ls-files', '--unmerged', '-z'],
        projectRoot,
        { env: environment, max_output_bytes: MAX_CONFLICT_PATH_BYTES },
      )
      if (unmerged.error || unmerged.status !== 0) throw new Error('could not read bounded conflict paths')
      outcome = { tree_oid: null, conflict_paths: parseUnmergedPaths(unmerged.stdout) }
      if (outcome.conflict_paths.length === 0) throw new Error('merge failed without conflict path evidence')
    } else {
      const detail = merge.stderr.toString('utf8').trim()
      throw new Error(`merge-tree computation failed${detail ? `: ${detail}` : ''}`)
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
    if (fs.existsSync(temporaryRoot)) throw new Error('temporary merge state could not be removed')
  }
  return outcome
}

function createMergeCommit(projectRoot: string, input: EpicIntegrationInput, treeOid: string): string {
  const message = `merge(epic): integrate ${input.worktree_evidence.item_id}/${input.worktree_evidence.attempt_id}`
  const commit = git([
    'commit-tree', treeOid,
    '-p', input.expected_target_commit,
    '-p', input.source_checkpoint_commit,
    '-m', message,
  ], projectRoot, {
    env: {
      GIT_AUTHOR_NAME: 'OpenCode Workflows',
      GIT_AUTHOR_EMAIL: 'opencode-workflows@localhost',
      GIT_COMMITTER_NAME: 'OpenCode Workflows',
      GIT_COMMITTER_EMAIL: 'opencode-workflows@localhost',
    },
  })
  validateOid(commit, 'computed merge commit')
  return commit
}

function verifyMergeParents(projectRoot: string, mergeCommit: string, input: EpicIntegrationInput): void {
  const parents = git(['rev-list', '--parents', '-n', '1', mergeCommit], projectRoot).split(/\s+/)
  if (parents.length !== 3 || parents[0] !== mergeCommit
    || parents[1] !== input.expected_target_commit
    || parents[2] !== input.source_checkpoint_commit) {
    throw new Error('computed merge commit does not have the exact expected parents')
  }
}

function resultBinding(input: EpicIntegrationInput): EpicIntegrationResultBase {
  return {
    source_commit: input.source_checkpoint_commit,
    target_commit: input.expected_target_commit,
    dependency_snapshot_sha256: input.dependency_snapshot_sha256,
    review_evidence_digest: input.review_evidence_digest,
  }
}

function publishByCompareAndSwap(projectRoot: string, input: EpicIntegrationInput, mergeCommit: string): void {
  const publication = runGit([
    'update-ref', input.integration_branch, mergeCommit, input.expected_target_commit,
  ], projectRoot)
  if (!publication.error && publication.status === 0) return

  let currentCommit: string
  try {
    currentCommit = git(['rev-parse', '--verify', `${input.integration_branch}^{commit}`], projectRoot)
  } catch (error) {
    throw new EpicIntegrationAmbiguousError('integration ref state is uncertain after compare-and-swap failure', input, [], { cause: error })
  }
  if (currentCommit === mergeCommit) {
    throw new EpicIntegrationAmbiguousError('compare-and-swap outcome is ambiguous and requires attended reconciliation', input)
  }
  throw new Error('integration ref compare-and-swap failed; no reviewed merge was published')
}

function synchronizePublishedWorktree(
  projectRoot: string,
  input: EpicIntegrationInput,
  mergeCommit: string,
  expectedIdentity: TargetWorktreeIdentity,
): void {
  try {
    assertTargetWorktreeIdentity(projectRoot, expectedIdentity)
    assertIntegrationBranch(projectRoot, input.integration_branch)
    if (hasOperationState(projectRoot)) throw new Error('integration target has an incomplete Git operation')
    const publishedHead = git(['rev-parse', '--verify', 'HEAD^{commit}'], projectRoot)
    const publishedRef = git(['rev-parse', '--verify', `${input.integration_branch}^{commit}`], projectRoot)
    if (publishedHead !== mergeCommit || publishedRef !== mergeCommit) {
      throw new Error('published integration ref changed before worktree synchronization')
    }
    if (!indexAndWorktreeMatchCommit(projectRoot, input.expected_target_commit)) {
      throw new Error('integration index or worktree changed before synchronization')
    }

    git(['read-tree', '-m', '-u', input.expected_target_commit, mergeCommit], projectRoot)
    assertTargetWorktreeIdentity(projectRoot, expectedIdentity)
    assertTargetReady(projectRoot, input.integration_branch, mergeCommit)
    if (!indexAndWorktreeMatchCommit(projectRoot, mergeCommit)) {
      throw new Error('integration index or worktree does not match the published merge')
    }
    verifyMergeParents(projectRoot, mergeCommit, input)
  } catch (error) {
    throw new EpicIntegrationAmbiguousError(
      'integration ref was published but checked-out worktree synchronization is uncertain',
      input,
      [],
      { cause: error },
    )
  }
}

/** Compute and atomically publish one exact reviewed checkpoint. */
export function integrateEpicCheckpoint(inputValue: EpicIntegrationInput): EpicIntegrationResult {
  const input = { ...inputValue, worktree_evidence: parseEpicWorktreeEvidence(inputValue.worktree_evidence) }
  validateOid(input.expected_target_commit, 'expected target commit')
  validateOid(input.source_checkpoint_commit, 'source checkpoint commit')
  validateSha256(input.project_identity_sha256, 'project identity')
  validateSha256(input.dependency_snapshot_sha256, 'dependency snapshot')
  validateSha256(input.review_evidence_digest, 'review evidence')

  const projectRoot = resolveProjectRoot(input.project_root)
  if (sha256Hex(projectRoot) !== input.project_identity_sha256) {
    throw new Error('canonical project root does not match the expected project identity')
  }
  if (!gitSucceeds(['cat-file', '-e', `${input.expected_target_commit}^{commit}`], projectRoot)
    || !gitSucceeds(['cat-file', '-e', `${input.source_checkpoint_commit}^{commit}`], projectRoot)) {
    throw new Error('integration input contains an unknown commit')
  }

  const targetIdentity = captureTargetWorktreeIdentity(projectRoot)

  assertTargetReady(projectRoot, input.integration_branch, input.expected_target_commit)
  assertTargetWorktreeIdentity(projectRoot, targetIdentity)
  assertSourceReady(projectRoot, input)
  if (gitSucceeds(['merge-base', '--is-ancestor', input.source_checkpoint_commit, input.expected_target_commit], projectRoot)) {
    throw new Error('source checkpoint has no new commit to integrate')
  }

  const mergeTree = computeMergeTree(projectRoot, input.expected_target_commit, input.source_checkpoint_commit)
  assertTargetReady(projectRoot, input.integration_branch, input.expected_target_commit)
  assertSourceReady(projectRoot, input)
  if (mergeTree.tree_oid === null) {
    return {
      ...resultBinding(input),
      success: false,
      result: 'conflict',
      result_commit: null,
      conflict_paths: mergeTree.conflict_paths,
    }
  }

  const mergeCommit = createMergeCommit(projectRoot, input, mergeTree.tree_oid)
  verifyMergeParents(projectRoot, mergeCommit, input)
  assertTargetReady(projectRoot, input.integration_branch, input.expected_target_commit)
  assertTargetWorktreeIdentity(projectRoot, targetIdentity)
  assertSourceReady(projectRoot, input)
  publishByCompareAndSwap(projectRoot, input, mergeCommit)
  synchronizePublishedWorktree(projectRoot, input, mergeCommit, targetIdentity)
  return {
    ...resultBinding(input),
    success: true,
    result: 'success',
    result_commit: mergeCommit,
    conflict_paths: [],
  }
}

/** Recomputes the reviewed merge tree before accepting a published result after restart. */
export function verifyRecoveredEpicIntegration(input: EpicRecoveredIntegrationVerificationInput): void {
  validateOid(input.expected_target_commit, 'expected target commit')
  validateOid(input.source_checkpoint_commit, 'source checkpoint commit')
  validateOid(input.result_commit, 'result commit')
  validateSha256(input.project_identity_sha256, 'project identity')
  const projectRoot = resolveProjectRoot(input.project_root)
  if (sha256Hex(projectRoot) !== input.project_identity_sha256) throw new Error('canonical project root does not match the expected project identity')
  assertIntegrationBranch(projectRoot, input.integration_branch)
  if (git(['rev-parse', '--verify', `${input.integration_branch}^{commit}`], projectRoot) !== input.result_commit) {
    throw new Error('recovered integration result is not the current integration branch commit')
  }
  const mergeTree = computeMergeTree(projectRoot, input.expected_target_commit, input.source_checkpoint_commit)
  if (mergeTree.tree_oid === null) throw new Error('recovered integration inputs do not produce a clean merge tree')
  if (git(['rev-parse', '--verify', `${input.result_commit}^{tree}`], projectRoot) !== mergeTree.tree_oid) {
    throw new Error('recovered integration tree does not match the exact reviewed merge tree')
  }
  const parents = git(['rev-list', '--parents', '-n', '1', input.result_commit], projectRoot).split(/\s+/)
  if (parents.length !== 3 || parents[1] !== input.expected_target_commit || parents[2] !== input.source_checkpoint_commit) {
    throw new Error('recovered integration result does not have the exact expected parents')
  }
  // Verify the canonical checkout matches the published merge commit.
  // If the worktree or index is stale or dirty, the integration is ambiguous.
  if (hasOperationState(projectRoot)) {
    throw new Error('recovered integration target has an incomplete Git operation')
  }
  if (!indexAndWorktreeMatchCommit(projectRoot, input.result_commit)) {
    throw new Error('recovered integration canonical checkout does not match the published merge commit')
  }
}

export const integrateReviewedEpicCheckpoint = integrateEpicCheckpoint
