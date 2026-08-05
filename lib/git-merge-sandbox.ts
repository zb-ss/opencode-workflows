import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sandboxedGitArgs, sandboxedGitEnv, trustedGitExecutable } from './git-sandbox.ts'

const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const MAX_CONFLICT_PATH_BYTES = 64 * 1024
const MAX_GENERATED_OBJECTS = 4096

export interface SandboxedGitObject {
  oid: string
  type: 'blob' | 'tree'
  bytes: Buffer
}

export interface SandboxedMergeTreeResult {
  tree_oid: string | null
  generated_objects: SandboxedGitObject[]
  conflict_paths: string[]
}

interface GitSandbox {
  root: string
  gitDirectory: string
  sourceObjectDirectory: string
}

function runGit(
  args: string[],
  cwd: string,
  environment: Record<string, string | undefined> = {},
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): SpawnSyncReturns<Buffer> {
  return spawnSync(trustedGitExecutable(), sandboxedGitArgs(args, cwd, environment), {
    cwd,
    encoding: 'buffer',
    env: sandboxedGitEnv(environment),
    maxBuffer: maxOutputBytes + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function git(args: string[], cwd: string, environment: Record<string, string | undefined> = {}): string {
  const result = runGit(args, cwd, environment)
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.toString('utf8').trim()
    throw new Error(`Git command failed${detail ? `: ${detail}` : ''}`)
  }
  if (result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES || result.stderr.byteLength > MAX_GIT_OUTPUT_BYTES) {
    throw new Error(`Git output exceeds the ${MAX_GIT_OUTPUT_BYTES}-byte limit`)
  }
  return result.stdout.toString('utf8').trim()
}

function validateOid(value: string, label: string): void {
  if (!GIT_OID_PATTERN.test(value)) throw new Error(`${label} must be an exact Git object ID`)
}

function safeConflictPath(filePath: string): string {
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
  if (output.length > MAX_CONFLICT_PATH_BYTES || output.at(-1) !== 0) throw new Error('conflict path evidence exceeds its safe bound')
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
    paths.add(safeConflictPath(filePath))
    start = index + 1
  }
  return [...paths]
}

function createSandbox(projectRoot: string): GitSandbox {
  const canonicalRoot = fs.realpathSync(projectRoot)
  const commonPath = git(['rev-parse', '--git-common-dir'], canonicalRoot)
  const commonDirectory = fs.realpathSync(path.isAbsolute(commonPath) ? commonPath : path.resolve(canonicalRoot, commonPath))
  const sourceObjectDirectory = fs.realpathSync(path.join(commonDirectory, 'objects'))
  const objectFormat = git(['rev-parse', '--show-object-format'], canonicalRoot)
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('unsupported Git object format')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-git-sandbox-'))
  const gitDirectory = path.join(root, 'git')
  fs.mkdirSync(path.join(gitDirectory, 'objects'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(gitDirectory, 'refs', 'heads'), { recursive: true, mode: 0o700 })
  const config = objectFormat === 'sha256'
    ? '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectFormat = sha256\n'
    : '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
  fs.writeFileSync(path.join(gitDirectory, 'config'), config, { mode: 0o600 })
  fs.writeFileSync(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/sandbox\n', { mode: 0o600 })
  return { root, gitDirectory, sourceObjectDirectory }
}

function sandboxEnvironment(
  sandbox: GitSandbox,
  indexFile: string,
  worktree: string,
): Record<string, string> {
  return {
    GIT_DIR: sandbox.gitDirectory,
    GIT_INDEX_FILE: indexFile,
    GIT_WORK_TREE: worktree,
    GIT_OBJECT_DIRECTORY: path.join(sandbox.gitDirectory, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: sandbox.sourceObjectDirectory,
  }
}

function sourceObjectEnvironment(sandbox: GitSandbox): Record<string, string> {
  return {
    GIT_DIR: sandbox.gitDirectory,
    GIT_OBJECT_DIRECTORY: sandbox.sourceObjectDirectory,
  }
}

function generatedMergeObjects(
  sandbox: GitSandbox,
  treeOid: string,
  worktree: string,
  environment: Record<string, string>,
): SandboxedGitObject[] {
  const listing = runGit(['ls-tree', '-r', '-t', '-z', treeOid], worktree, environment)
  if (listing.error) throw listing.error
  if (listing.status !== 0 || listing.stdout.byteLength > MAX_GIT_OUTPUT_BYTES || listing.stderr.byteLength > MAX_GIT_OUTPUT_BYTES) {
    throw new Error('could not enumerate the computed merge tree')
  }
  if (listing.stdout.byteLength > 0 && listing.stdout.at(-1) !== 0) throw new Error('Git returned unterminated merge-tree object evidence')
  const objects = new Map<string, 'blob' | 'tree'>([[treeOid, 'tree']])
  for (const record of listing.stdout.subarray(0, Math.max(0, listing.stdout.byteLength - 1)).toString('utf8').split('\0')) {
    if (!record) continue
    const match = /^(?:100644|100755|120000|040000|160000) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(record)
    if (!match) throw new Error('Git returned malformed merge-tree object evidence')
    if (match[1] === 'commit') continue
    objects.set(match[2]!, match[1] as 'blob' | 'tree')
  }
  if (objects.size > MAX_GENERATED_OBJECTS) throw new Error('computed merge tree exceeds the generated-object limit')

  const sourceEnvironment = sourceObjectEnvironment(sandbox)
  const generated: SandboxedGitObject[] = []
  let totalBytes = 0
  for (const [oid, type] of objects) {
    const exists = runGit(['cat-file', '-e', oid], worktree, sourceEnvironment)
    if (!exists.error && exists.status === 0) continue
    const object = runGit(['cat-file', type, oid], worktree, environment)
    if (object.error) throw object.error
    if (object.status !== 0) throw new Error('could not export a generated merge object')
    totalBytes += object.stdout.byteLength
    if (totalBytes > MAX_GIT_OUTPUT_BYTES) throw new Error('generated merge objects exceed the safe byte limit')
    generated.push({ oid, type, bytes: Buffer.from(object.stdout) })
  }
  return generated
}

export function computeSandboxedMergeTree(
  projectRoot: string,
  targetCommit: string,
  sourceCommit: string,
): SandboxedMergeTreeResult {
  validateOid(targetCommit, 'target commit')
  validateOid(sourceCommit, 'source commit')
  const sandbox = createSandbox(projectRoot)
  const worktree = path.join(sandbox.root, 'worktree')
  const indexFile = path.join(sandbox.root, 'index')
  fs.mkdirSync(worktree, { mode: 0o700 })
  const environment = sandboxEnvironment(sandbox, indexFile, worktree)
  try {
    const mergeBases = git(['merge-base', '--all', targetCommit, sourceCommit], worktree, environment).split('\n').filter(Boolean)
    if (mergeBases.length === 0) throw new Error('source and target do not share a merge base')
    mergeBases.forEach(base => validateOid(base, 'merge base'))
    git(['read-tree', targetCommit], worktree, environment)
    git(['checkout-index', '--all', '--force'], worktree, environment)
    git(['update-index', '--refresh'], worktree, environment)
    const merge = runGit(['merge-recursive', ...mergeBases, '--', targetCommit, sourceCommit], worktree, environment)
    if (merge.error) throw merge.error
    if (merge.status === 0) {
      const treeOid = git(['write-tree'], worktree, environment)
      validateOid(treeOid, 'computed merge tree')
      return { tree_oid: treeOid, generated_objects: generatedMergeObjects(sandbox, treeOid, worktree, environment), conflict_paths: [] }
    }
    if (merge.status !== 1) {
      const detail = merge.stderr.toString('utf8').trim()
      throw new Error(`merge-tree computation failed${detail ? `: ${detail}` : ''}`)
    }
    const unmerged = runGit(['ls-files', '--unmerged', '-z'], worktree, environment, MAX_CONFLICT_PATH_BYTES)
    if (unmerged.error || unmerged.status !== 0) throw new Error('could not read bounded conflict paths')
    const conflictPaths = parseUnmergedPaths(unmerged.stdout)
    if (conflictPaths.length === 0) throw new Error('merge failed without conflict path evidence')
    return { tree_oid: null, generated_objects: [], conflict_paths: conflictPaths }
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
    if (fs.existsSync(sandbox.root)) throw new Error('temporary merge state could not be removed')
  }
}

export function updateWorktreeWithoutRepositoryDrivers(
  projectRoot: string,
  indexFile: string,
  worktree: string,
  args: string[],
): void {
  const sandbox = createSandbox(projectRoot)
  try {
    git(args, worktree, sandboxEnvironment(sandbox, indexFile, worktree))
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true })
    if (fs.existsSync(sandbox.root)) throw new Error('temporary checkout state could not be removed')
  }
}
