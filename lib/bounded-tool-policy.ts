import fs from 'node:fs'
import path from 'node:path'

import { BoundedAccessError } from './bounded-access-error.ts'
import { lstatIfPresent } from './fs-safe.ts'
import { isPathInside } from './paths.ts'

type PathAccess = 'list' | 'read' | 'write'

interface PathPolicy {
  access: PathAccess
  keys: string[]
  optional?: boolean
}

type BoundedToolDescriptor = {
  sourcePermission: string
  sessionPermission: string
  tool: string
  path: PathPolicy
} | {
  sourcePermission: string
  sessionPermission: string
  tool: string
  path?: undefined
}

const BOUNDED_TOOL_DESCRIPTORS: readonly BoundedToolDescriptor[] = [
  {
    sourcePermission: 'edit',
    sessionPermission: 'workflow_bounded_write',
    tool: 'workflow_bounded_write',
    path: { access: 'write', keys: ['path'] },
  },
  {
    sourcePermission: 'glob',
    sessionPermission: 'workflow_bounded_list',
    tool: 'workflow_bounded_list',
    path: { access: 'list', keys: ['path'], optional: true },
  },
  {
    sourcePermission: 'list',
    sessionPermission: 'workflow_bounded_list',
    tool: 'workflow_bounded_list',
    path: { access: 'list', keys: ['path'], optional: true },
  },
  {
    sourcePermission: 'read',
    sessionPermission: 'workflow_bounded_read',
    tool: 'workflow_bounded_read',
    path: { access: 'read', keys: ['path'] },
  },
  { sourcePermission: 'todowrite', sessionPermission: 'todowrite', tool: 'todoread' },
  { sourcePermission: 'todowrite', sessionPermission: 'todowrite', tool: 'todowrite' },
]

const TOOL_DESCRIPTORS = new Map(BOUNDED_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.tool, descriptor]))

const SENSITIVE_NAMES = new Set([
  '.authinfo',
  '.authinfo.gpg',
  '.creds',
  '.credentials',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  'application.properties',
  'auth.json',
  'credentials',
  'credentials.json',
  'secrets.json',
  'vault-token',
  'wp-config.php',
])

const SENSITIVE_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.opencode',
  '.ssh',
])

const PRIVATE_KEY_EXTENSIONS = new Set(['.jks', '.kdbx', '.key', '.keystore', '.p12', '.pem', '.pfx'])

const READABLE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.htm', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.less', '.md', '.mjs', '.cjs', '.php', '.py', '.rb', '.rs', '.sass', '.scala', '.scss',
  '.svelte', '.swift', '.ts', '.tsx', '.txt', '.vue',
])

const READABLE_NAMES = new Set(['changelog', 'copying', 'license', 'readme'])

const CONTROL_FILE_NAMES = new Set([
  '.clinerules',
  '.cursorrules',
  '.gitlab-ci.yml',
  '.windsurfrules',
  'agents.md',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'build.gradle',
  'build.gradle.kts',
  'build.rs',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'cargo.toml',
  'cmakelists.txt',
  'claude.md',
  'composer.json',
  'composer.lock',
  'deno.json',
  'deno.jsonc',
  'dockerfile',
  'flake.nix',
  'gemfile',
  'gemfile.lock',
  'gemini.md',
  'go.mod',
  'go.sum',
  'jenkinsfile',
  'justfile',
  'lefthook.yml',
  'lefthook.yaml',
  'makefile',
  'mise.toml',
  'opencode.json',
  'opencode.jsonc',
  'package.json',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'pom.xml',
  'poetry.lock',
  'pyproject.toml',
  'requirements.txt',
  'setup.cfg',
  'setup.py',
  'taskfile.yml',
  'taskfile.yaml',
  'tox.ini',
  'uv.lock',
  'yarn.lock',
])

export function boundedPermissionTargets(sourcePermission: string): string[] {
  if (sourcePermission === '*') {
    return [...new Set(BOUNDED_TOOL_DESCRIPTORS.map((descriptor) => descriptor.sessionPermission))]
  }
  return [...new Set(BOUNDED_TOOL_DESCRIPTORS
    .filter((descriptor) => descriptor.sourcePermission === sourcePermission)
    .map((descriptor) => descriptor.sessionPermission))]
}

export function isBoundedStageTool(toolName: string): boolean {
  return TOOL_DESCRIPTORS.has(toolName)
}

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function toolPaths(descriptor: BoundedToolDescriptor, args: unknown): string[] {
  if (!descriptor.path) return []
  const input = objectInput(args, `${descriptor.tool} arguments`)
  const value = descriptor.path.keys
    .map((key) => input[key])
    .find((candidate) => candidate !== undefined)
  if (value === undefined && descriptor.path.optional) return []
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`bounded ${descriptor.tool} requires a file path`)
  }
  return [value]
}

function pathSegments(filePath: string): string[] {
  return filePath.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase())
}

function isSensitivePath(filePath: string): boolean {
  const segments = pathSegments(filePath)
  const name = segments.at(-1) ?? ''
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) return true
  if (name.startsWith('.env') || SENSITIVE_NAMES.has(name)) return true
  if (/^(?:credentials?|passwords?|secrets?|tokens?)(?:\.[^.]+)?$/.test(name)) return true
  if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/.test(name)) return true
  if (/^service[-_]?account.*\.json$/.test(name)) return true
  return PRIVATE_KEY_EXTENSIONS.has(path.extname(name))
}

function isProtectedWritePath(filePath: string): boolean {
  if (isSensitivePath(filePath)) return true
  const segments = pathSegments(filePath)
  const name = segments.at(-1) ?? ''
  if (segments.some((segment) => segment.startsWith('.'))) return true
  if (/^(?:babel|eslint|jest|playwright|postcss|prettier|rollup|tailwind|vite|vitest|webpack)\.config\.(?:cjs|cts|js|mjs|mts|ts)$/.test(name)) return true
  return CONTROL_FILE_NAMES.has(name)
}

function isReadableSourcePath(filePath: string): boolean {
  const segments = pathSegments(filePath)
  const name = segments.at(-1) ?? ''
  if (!name || name.startsWith('.')) return false
  if (READABLE_NAMES.has(name) || [...READABLE_NAMES].some((prefix) => name.startsWith(`${prefix}.`))) return true
  if (/^(?:jsconfig|package|tsconfig(?:\..+)?)\.json$/.test(name)) return true
  return READABLE_EXTENSIONS.has(path.extname(name))
}

export function isBoundedVisiblePath(filePath: string, isDirectory: boolean): boolean {
  const name = pathSegments(filePath).at(-1) ?? ''
  if (!name || name.startsWith('.')) return false
  if (isSensitivePath(filePath) || isProtectedWritePath(filePath)) return false
  return isDirectory || isReadableSourcePath(filePath)
}

function assertBoundedPath(
  worktree: string,
  directory: string,
  candidate: string,
  access: PathAccess,
): void {
  if (candidate.includes('\0')) throw new Error('bounded file path contains a null byte')
  const root = path.resolve(worktree)
  const target = path.resolve(directory, candidate)
  if (!isPathInside(root, target)) {
    throw new BoundedAccessError('outside_worktree', `bounded file path is outside the worktree: ${candidate}`)
  }

  const relative = path.relative(root, target)
  if (access === 'read' && isSensitivePath(relative)) {
    throw new BoundedAccessError('sensitive_path', `bounded file path targets a sensitive file: ${candidate}`)
  }
  if (access === 'read' && !isReadableSourcePath(relative)) {
    throw new BoundedAccessError('unsupported_read', `bounded read target is not an approved source or documentation file: ${candidate}`)
  }
  if (access === 'list' && (isSensitivePath(relative) || isProtectedWritePath(relative))) {
    throw new Error(`bounded list targets a protected directory: ${candidate}`)
  }
  if (access === 'write' && isProtectedWritePath(relative)) {
    throw new BoundedAccessError('protected_write', `bounded write targets a protected control or sensitive file: ${candidate}`)
  }

  const realRoot = fs.realpathSync(root)
  let current = root
  let lastExisting = root
  let targetStat: fs.Stats | null = target === root ? fs.statSync(root) : null
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = lstatIfPresent(current)
    if (!stat) continue
    if (stat.isSymbolicLink()) {
      throw new BoundedAccessError('symlink_path', `bounded file path traverses a symbolic link: ${candidate}`)
    }
    lastExisting = current
    if (current === target) targetStat = stat
  }
  const realExisting = fs.realpathSync(lastExisting)
  if (!isPathInside(realRoot, realExisting)) {
    throw new BoundedAccessError('outside_worktree', `bounded file path resolves outside the worktree: ${candidate}`)
  }
  const realRelative = path.relative(realRoot, realExisting)
  if (access === 'read' && isSensitivePath(realRelative)) {
    throw new BoundedAccessError('sensitive_path', `bounded file path resolves to a sensitive file: ${candidate}`)
  }
  if (access === 'write' && isProtectedWritePath(realRelative)) {
    throw new BoundedAccessError('protected_write', `bounded write resolves to a protected control or sensitive file: ${candidate}`)
  }
  if (access === 'read') {
    if (!targetStat || !targetStat.isFile()) {
      throw new BoundedAccessError('missing_file', `bounded ${candidate} read must target one existing regular file`)
    }
    if (targetStat.nlink > 1) {
      throw new BoundedAccessError('hard_link', `bounded file read rejects hard-linked targets: ${candidate}`)
    }
  }
  if (access === 'write' && targetStat && !targetStat.isFile()) {
    throw new Error(`bounded write target is not a regular file: ${candidate}`)
  }
  if (access === 'list' && (!targetStat || !targetStat.isDirectory())) {
    throw new Error(`bounded list target is not an existing directory: ${candidate}`)
  }
}

export function resolveBoundedToolPaths(
  toolName: string,
  args: unknown,
  worktree: string,
  directory: string,
): string[] {
  const descriptor = TOOL_DESCRIPTORS.get(toolName)
  if (!descriptor) throw new Error(`tool ${toolName} is not allowed inside a bounded automatic workflow stage`)
  if (!descriptor.path) return []
  const candidates = toolPaths(descriptor, args)
  for (const candidate of candidates) {
    assertBoundedPath(worktree, directory, candidate, descriptor.path.access)
  }
  return candidates.map((candidate) => path.resolve(directory, candidate))
}

export function assertBoundedToolPaths(
  toolName: string,
  args: unknown,
  worktree: string,
  directory: string,
): void {
  resolveBoundedToolPaths(toolName, args, worktree, directory)
}
