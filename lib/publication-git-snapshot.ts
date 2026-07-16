import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BoundedProcessRunner } from './bounded-process.ts'
import {
  type PublicationFinding,
  PublicationFindingOverflowError,
  type PublicationInternalMarker,
  type PublicationScanOptions,
  scanPublicationBytes,
  scanPublicationPath,
} from './publication-scanner.ts'
import { compareOrdinal, stableCanonicalJson } from './publication-contracts.ts'
import {
  isFullPublicationGitRef,
  isOperatorOwnedPublicationExecutable,
  isPublicationSourceBranchRef,
  normalizePublicationRemoteUrl,
  PUBLICATION_SCAN_POLICY_VERSION,
  PUBLICATION_SCHEMA_VERSION,
} from './publication-policy.ts'
import { childDescriptorPath, terminateDetachedProcessGroup } from './posix-process.ts'
import { publicationMarkerIssues } from './publication-marker-policy.mjs'
import { assertNativePublicationExecutable } from './publication-native-executable.ts'
import { trustedExecutable } from './validation-executable-policy.ts'

const GIT_COMMON_ARGUMENTS = [
  '--no-pager',
  '--no-replace-objects',
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', `core.attributesFile=${os.devNull}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'protocol.allow=never',
] as const

export interface PublicationGitSnapshotLimits {
  max_commits: number
  max_objects: number
  max_blob_bytes: number
  max_total_scan_bytes: number
  max_findings: number
}

export interface PublicationGitSnapshotInput {
  worktree: string
  git_executable: string
  base_ref: string
  head_ref: string
  remote: string
  expected_remote_url: string
  destination_ref: string
  command_timeout_ms: number
  limits: PublicationGitSnapshotLimits
  internal_markers: readonly PublicationInternalMarker[]
  signal: AbortSignal
  spawnProcess?: typeof spawn
}

export interface PublicationGitSnapshot {
  schema_version: number
  source: {
    git_executable_identity_sha256: string
    repository_identity_sha256: string
    git_common_dir_sha256: string
    object_format: 'sha1' | 'sha256'
    base_ref: string
    base_oid: string
    head_ref: string
    head_oid: string
    tree_oid: string
    remote: string
    remote_url: string
  }
  target: {
    destination_ref: string
  }
  scan_policy: {
    version: string
    limits: PublicationGitSnapshotLimits
    internal_markers_sha256: string
  }
  scan_counts: {
    commits: number
    objects: number
    blobs: number
    paths: number
    bytes: number
    findings: number
  }
  findings: PublicationFinding[]
  snapshot_sha256: string
}

export type PublicationGitSnapshotErrorCode =
  | 'cancelled'
  | 'command_timeout'
  | 'command_failed'
  | 'dirty_worktree'
  | 'invalid_configuration'
  | 'invalid_repository'
  | 'limit_exceeded'
  | 'malformed_git_output'
  | 'missing_object'
  | 'remote_mismatch'
  | 'termination_uncertain'
  | 'unsupported_repository'

export class PublicationGitSnapshotError extends Error {
  constructor(readonly code: PublicationGitSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'PublicationGitSnapshotError'
  }
}

interface GitContext {
  executable: string
  executableDescriptor: number
  executableIdentitySha256: string
  worktree: string
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  maxOutputBytes: number
  commandTimeoutMs: number
  spawnProcess: typeof spawn
}

interface GitResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

type GitProcessReason = 'cancelled' | 'command_failed' | 'command_timeout' | 'limit_exceeded'

interface ObjectRecord {
  oid: string
  type: 'blob' | 'commit' | 'tree'
  size: number
}

interface LocalConfigEntry {
  key: string
  value: string
}

interface RepositoryIdentity {
  gitDir: string
  commonDir: string
  commonDirSha256: string
  graftStateSha256: string
  repositorySha256: string
}

interface SnapshotSourceState {
  config: LocalConfigEntry[]
  identity: RepositoryIdentity
  objectFormat: 'sha1' | 'sha256'
  remote: string
  baseOid: string
  headOid: string
  treeOid: string
  executableIdentitySha256: string
}

interface SnapshotObjectSet {
  commits: string[]
  records: Map<string, ObjectRecord>
}

interface SnapshotScanResult {
  scannedBytes: number
  blobCount: number
  pathCount: number
  findings: PublicationFinding[]
}

function fail(code: PublicationGitSnapshotErrorCode, message: string): never {
  throw new PublicationGitSnapshotError(code, message)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function gitExecutableIdentitySha256(stat: fs.BigIntStats): string {
  return sha256(stableCanonicalJson({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o7777n),
    owner: stat.uid.toString(),
    group: stat.gid.toString(),
    size: stat.size.toString(),
    modified_ns: stat.mtimeNs.toString(),
    changed_ns: stat.ctimeNs.toString(),
  }))
}

function gitChildDescriptorPath(descriptor: number): string {
  try {
    return childDescriptorPath(descriptor)
  } catch {
    fail('unsupported_repository', 'publication Git requires a process descriptor filesystem')
  }
}

function openPinnedGitExecutable(executable: string): {
  descriptor: number
  identitySha256: string
} {
  const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true })
    const pathStat = fs.statSync(executable, { bigint: true })
    const identitySha256 = gitExecutableIdentitySha256(descriptorStat)
    if (!descriptorStat.isFile() || !isOperatorOwnedPublicationExecutable(descriptorStat)
      || identitySha256 !== gitExecutableIdentitySha256(pathStat)) {
      fail('invalid_configuration', 'publication Git executable changed while it was being pinned')
    }
    assertNativePublicationExecutable(descriptor, 'publication Git executable')
    return { descriptor, identitySha256 }
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

function positiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_configuration', `${name} must be a positive safe integer`)
  }
}

function validateLimits(limits: PublicationGitSnapshotLimits): void {
  positiveLimit(limits.max_commits, 'max_commits')
  positiveLimit(limits.max_objects, 'max_objects')
  positiveLimit(limits.max_blob_bytes, 'max_blob_bytes')
  positiveLimit(limits.max_total_scan_bytes, 'max_total_scan_bytes')
  positiveLimit(limits.max_findings, 'max_findings')
}

function validateInput(input: PublicationGitSnapshotInput): void {
  if (process.platform === 'win32') {
    fail('unsupported_repository', 'publication snapshots require POSIX process-group semantics')
  }
  if (!path.isAbsolute(input.worktree) || !path.isAbsolute(input.git_executable)) {
    fail('invalid_configuration', 'publication worktree and Git executable must be absolute paths')
  }
  if (!isPublicationSourceBranchRef(input.base_ref)
    || !isPublicationSourceBranchRef(input.head_ref)
    || !isFullPublicationGitRef(input.destination_ref)) {
    fail('invalid_configuration', 'publication refs must be valid full Git refs')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.remote)) {
    fail('invalid_configuration', 'publication remote name is invalid')
  }
  if (!(input.signal instanceof AbortSignal)) fail('invalid_configuration', 'publication AbortSignal is required')
  positiveLimit(input.command_timeout_ms, 'command_timeout_ms')
  if (publicationMarkerIssues(input.internal_markers).length > 0) {
    fail('invalid_configuration', 'publication internal marker configuration is invalid')
  }
  validateLimits(input.limits)
}

function gitEnvironment(executable: string): NodeJS.ProcessEnv {
  return {
    PATH: path.dirname(executable),
    HOME: path.dirname(os.devNull),
    XDG_CONFIG_HOME: path.dirname(os.devNull),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: os.devNull,
    SSH_ASKPASS: os.devNull,
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: '',
    PAGER: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
  }
}

function openVerifiedGitInvocation(context: GitContext): number {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(context.executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!isOperatorOwnedPublicationExecutable(stat)
      || gitExecutableIdentitySha256(stat) !== context.executableIdentitySha256) {
      fail('invalid_configuration', 'trusted Git executable identity changed between commands')
    }
    assertNativePublicationExecutable(descriptor, 'publication Git executable')
    return descriptor
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    if (error instanceof PublicationGitSnapshotError) throw error
    fail('invalid_configuration', 'trusted Git executable could not be opened for invocation')
  }
}

async function runGit(
  context: GitContext,
  argv: readonly string[],
  options: { allowedExitCodes?: readonly number[]; input?: Uint8Array; maxOutputBytes?: number } = {},
): Promise<GitResult> {
  if (context.signal.aborted) fail('cancelled', 'publication snapshot was cancelled')
  const outputLimit = Math.min(context.maxOutputBytes, options.maxOutputBytes ?? context.maxOutputBytes)
  if (!Number.isSafeInteger(outputLimit) || outputLimit <= 0) fail('limit_exceeded', 'Git output limit exhausted')

  const invocationDescriptor = openVerifiedGitInvocation(context)
  let child: ReturnType<typeof spawn> | null = null
  let spawnFailed = false
  try {
    child = context.spawnProcess(gitChildDescriptorPath(3), [...GIT_COMMON_ARGUMENTS, ...argv], {
      cwd: context.worktree,
      detached: true,
      env: context.environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', invocationDescriptor],
    })
  } catch {
    spawnFailed = true
  }
  try {
    fs.closeSync(invocationDescriptor)
  } catch {
    if (child) terminateDetachedProcessGroup(child, 'trusted Git')
    fail('command_failed', 'trusted Git invocation descriptor could not be closed')
  }
  if (spawnFailed) fail('command_failed', 'trusted Git process failed to start')
  if (!child) fail('command_failed', 'trusted Git process failed to start')
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const processRunner = new BoundedProcessRunner<GitProcessReason>({
    child,
    timeout_ms: context.commandTimeoutMs,
    termination_grace_ms: context.commandTimeoutMs,
    max_output_bytes: outputLimit,
    timeout_reason: 'command_timeout',
    cancellation_reason: 'cancelled',
    output_limit_reason: 'limit_exceeded',
    terminate_process: candidate => terminateDetachedProcessGroup(candidate, 'trusted Git'),
    on_stdout: chunk => stdout.push(chunk),
    on_stderr: chunk => stderr.push(chunk),
  })
  child.stdin!.on('error', () => {
    processRunner.terminate('command_failed')
  })

  if (options.input) child.stdin!.end(options.input)
  else child.stdin!.end()

  const completed = await processRunner.run(context.signal)
  if (completed.termination_uncertain) {
    fail('termination_uncertain', 'trusted Git termination did not complete')
  }
  if (completed.forced_reason === 'command_timeout') fail('command_timeout', 'trusted Git command timed out')
  if (completed.forced_reason === 'cancelled') fail('cancelled', 'publication snapshot was cancelled')
  if (completed.forced_reason === 'limit_exceeded') fail('limit_exceeded', 'bounded Git output limit exceeded')
  if (completed.forced_reason === 'command_failed') fail('command_failed', 'trusted Git rejected bounded input')
  if (completed.process_error || completed.code === null) fail('command_failed', 'trusted Git process failed to start')
  const allowedExitCodes = options.allowedExitCodes ?? [0]
  if (!allowedExitCodes.includes(completed.code)) fail('command_failed', 'trusted local Git command failed')
  return {
    stdout: Buffer.concat(stdout, completed.stdout_bytes),
    stderr: Buffer.concat(stderr, completed.stderr_bytes),
    exitCode: completed.code,
  }
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)
  } catch {
    fail('malformed_git_output', 'trusted Git returned non-UTF-8 metadata')
  }
}

function singleLine(value: Uint8Array, label: string): string {
  const text = decodeUtf8(value)
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r') || text.includes('\0')) {
    fail('malformed_git_output', `trusted Git returned malformed ${label}`)
  }
  const result = text.slice(0, -1)
  if (result.length === 0) fail('malformed_git_output', `trusted Git returned empty ${label}`)
  return result
}

function oidPattern(objectFormat: 'sha1' | 'sha256'): RegExp {
  return objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/
}

function parseLineList(value: Uint8Array, label: string): string[] {
  const text = decodeUtf8(value)
  if (text.length === 0) return []
  if (!text.endsWith('\n') || text.includes('\r') || text.includes('\0')) {
    fail('malformed_git_output', `trusted Git returned malformed ${label}`)
  }
  const entries = text.slice(0, -1).split('\n')
  if (entries.some(entry => entry.length === 0)) fail('malformed_git_output', `trusted Git returned malformed ${label}`)
  return entries
}

function parseNulRecords(value: Uint8Array, label: string): Buffer[] {
  const buffer = Buffer.from(value)
  if (buffer.length === 0) return []
  if (buffer.at(-1) !== 0) fail('malformed_git_output', `trusted Git returned unterminated ${label}`)
  const records: Buffer[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0) continue
    if (index === start) fail('malformed_git_output', `trusted Git returned empty ${label}`)
    records.push(buffer.subarray(start, index))
    start = index + 1
  }
  return records
}

function parseLocalConfig(value: Uint8Array): LocalConfigEntry[] {
  return parseNulRecords(value, 'local configuration').map((record) => {
    const separator = record.indexOf(10)
    if (separator <= 0) fail('malformed_git_output', 'trusted Git returned malformed local configuration')
    const key = decodeUtf8(record.subarray(0, separator))
    const configValue = decodeUtf8(record.subarray(separator + 1))
    if (key.length > 1024 || /[\u0000-\u001F\u007F]/.test(key)) {
      fail('malformed_git_output', 'trusted Git returned an invalid local configuration key')
    }
    return { key, value: configValue }
  })
}

function isExecutableConfig(key: string): boolean {
  return key === 'core.askpass'
    || key === 'core.attributesfile'
    || key === 'core.editor'
    || key === 'core.fsmonitor'
    || key === 'core.hookspath'
    || key === 'core.pager'
    || key === 'core.sshcommand'
    || key === 'diff.external'
    || key === 'gc.recentobjectshook'
    || key === 'interactive.difffilter'
    || key === 'sequence.editor'
    || key.startsWith('alias.')
    || key.startsWith('filter.')
    || key.startsWith('pager.')
    || (/^remote\..*\.(?:receivepack|uploadpack)$/.test(key))
    || (/^diff\..*\.(?:command|textconv)$/.test(key))
    || (/^merge\..*\.driver$/.test(key))
}

function assertSafeLocalConfig(entries: readonly LocalConfigEntry[]): void {
  for (const entry of entries) {
    const key = entry.key.toLocaleLowerCase('en-US')
    const prohibited = key === 'extensions.partialclone'
      || key === 'core.alternaterefscommand'
      || key.startsWith('credential.')
      || key.startsWith('include.')
      || key.startsWith('includeif.')
      || key.startsWith('submodule.')
      || /^remote\..*\.(?:partialclonefilter|promisor|pushurl)$/.test(key)
      || /^url\..*\.(?:insteadof|pushinsteadof)$/.test(key)
      || isExecutableConfig(key)
    if (prohibited) fail('unsupported_repository', 'repository local configuration is unsafe for publication')
  }
}

function markerPolicyIdentity(markers: readonly PublicationInternalMarker[]): string {
  const canonical = [...markers]
    .map(marker => ({ ...marker }))
    .sort((left, right) => compareOrdinal(left.id, right.id))
  return sha256(stableCanonicalJson(canonical))
}

function findingOrder(left: PublicationFinding, right: PublicationFinding): number {
  return compareOrdinal(left.source_kind, right.source_kind)
    || compareOrdinal(left.location_identity, right.location_identity)
    || compareOrdinal(left.rule_id, right.rule_id)
    || compareOrdinal(left.category, right.category)
    || compareOrdinal(left.fingerprint, right.fingerprint)
}

function appendFindings(
  target: Map<string, PublicationFinding>,
  findings: readonly PublicationFinding[],
  maximum: number,
): void {
  for (const finding of findings) {
    if (target.has(finding.fingerprint)) continue
    if (target.size >= maximum) fail('limit_exceeded', 'publication finding limit exceeded')
    target.set(finding.fingerprint, finding)
  }
}

function scanOptions(
  input: PublicationGitSnapshotInput,
  findings: ReadonlyMap<string, PublicationFinding>,
  kind: PublicationScanOptions['source']['kind'],
  locationIdentity: string,
): PublicationScanOptions {
  return {
    max_findings: input.limits.max_findings - findings.size,
    internal_markers: input.internal_markers,
    source: { kind, location_identity: locationIdentity },
  }
}

function commandOutputBound(maximumEntries: number, bytesPerEntry: number, totalLimit: number): number {
  const calculated = (maximumEntries * bytesPerEntry) + 1
  return Math.max(1, Math.min(totalLimit, Number.isSafeInteger(calculated) ? calculated : totalLimit))
}

function parseObjectRecords(
  value: Uint8Array,
  expectedOids: readonly string[],
  objectFormat: 'sha1' | 'sha256',
): Map<string, ObjectRecord> {
  const lines = parseLineList(value, 'object metadata')
  if (lines.length !== expectedOids.length) fail('missing_object', 'Git object metadata is incomplete')
  const result = new Map<string, ObjectRecord>()
  const oidRegex = oidPattern(objectFormat)
  lines.forEach((line, index) => {
    if (line.endsWith(' missing')) fail('missing_object', 'publication source contains a missing Git object')
    const match = /^([0-9a-f]+) (blob|commit|tree) ([0-9]+)$/.exec(line)
    if (!match || !oidRegex.test(match[1]) || match[1] !== expectedOids[index]) {
      fail('malformed_git_output', 'trusted Git returned malformed object metadata')
    }
    const size = Number(match[3])
    if (!Number.isSafeInteger(size) || size < 0) fail('malformed_git_output', 'trusted Git returned an invalid object size')
    result.set(match[1], { oid: match[1], type: match[2] as ObjectRecord['type'], size })
  })
  return result
}

function assertVerifiedTree(value: Uint8Array, objectFormat: 'sha1' | 'sha256'): void {
  const bytes = Buffer.from(value)
  const oidBytes = objectFormat === 'sha1' ? 20 : 32
  let offset = 0
  while (offset < bytes.length) {
    const modeEnd = bytes.indexOf(0x20, offset)
    if (modeEnd <= offset) fail('malformed_git_output', 'Git tree object has malformed mode data')
    const mode = bytes.subarray(offset, modeEnd).toString('ascii')
    if (!/^[0-7]{5,6}$/.test(mode)) fail('malformed_git_output', 'Git tree object has an invalid mode')
    const nameEnd = bytes.indexOf(0, modeEnd + 1)
    if (nameEnd <= modeEnd + 1 || nameEnd + 1 + oidBytes > bytes.length) {
      fail('malformed_git_output', 'Git tree object has malformed entry data')
    }
    if (mode === '160000') fail('unsupported_repository', 'Git submodules are unsupported for publication snapshots')
    offset = nameEnd + 1 + oidBytes
  }
}

function assertRawCommitClosure(
  commit: string,
  value: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  commits: ReadonlySet<string>,
  records: ReadonlyMap<string, ObjectRecord>,
): void {
  const bytes = Buffer.from(value)
  const separator = bytes.indexOf('\n\n')
  if (separator <= 0) fail('malformed_git_output', 'Git commit object has malformed headers')
  const header = bytes.subarray(0, separator)
  const lines = decodeUtf8(header).split('\n')
  const expectedOid = oidPattern(objectFormat)
  if (!lines[0]?.startsWith('tree ') || !expectedOid.test(lines[0].slice(5))) {
    fail('malformed_git_output', 'Git commit object has an invalid tree header')
  }
  for (const line of lines) {
    if (!line.startsWith('parent ')) continue
    const parent = line.slice(7)
    if (!expectedOid.test(parent)) fail('malformed_git_output', 'Git commit object has an invalid parent header')
    if (!commits.has(parent) || records.get(parent)?.type !== 'commit') {
      fail('unsupported_repository', `Git revision walking omitted a raw parent of commit ${commit}`)
    }
  }
}

async function canonicalGitContext(input: PublicationGitSnapshotInput): Promise<GitContext> {
  let lexicalWorktree: string
  let canonicalWorktree: string
  try {
    lexicalWorktree = path.resolve(input.worktree)
    canonicalWorktree = fs.realpathSync(lexicalWorktree)
    if (!fs.statSync(canonicalWorktree).isDirectory() || lexicalWorktree !== canonicalWorktree) {
      fail('invalid_repository', 'publication worktree must be its exact canonical directory')
    }
  } catch (error) {
    if (error instanceof PublicationGitSnapshotError) throw error
    fail('invalid_repository', 'publication worktree is unavailable')
  }

  let executable: string
  try {
    executable = trustedExecutable(input.git_executable, process.env, canonicalWorktree).executable
  } catch {
    fail('invalid_configuration', 'publication Git executable is not a trusted external executable')
  }
  let pinned: ReturnType<typeof openPinnedGitExecutable>
  try {
    pinned = openPinnedGitExecutable(executable)
  } catch (error) {
    if (error instanceof PublicationGitSnapshotError) throw error
    fail('invalid_configuration', 'publication Git executable could not be pinned')
  }
  const context: GitContext = {
    executable,
    executableDescriptor: pinned.descriptor,
    executableIdentitySha256: pinned.identitySha256,
    worktree: canonicalWorktree,
    environment: gitEnvironment(executable),
    signal: input.signal,
    maxOutputBytes: input.limits.max_total_scan_bytes,
    commandTimeoutMs: input.command_timeout_ms,
    spawnProcess: input.spawnProcess ?? spawn,
  }
  try {
    const topLevel = singleLine(
      (await runGit(context, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).stdout,
      'worktree root',
    )
    let canonicalTopLevel: string
    try {
      canonicalTopLevel = fs.realpathSync(topLevel)
    } catch {
      fail('invalid_repository', 'Git worktree root is unavailable')
    }
    if (topLevel !== canonicalTopLevel || canonicalTopLevel !== canonicalWorktree) {
      fail('invalid_repository', 'publication context does not exactly match the canonical Git worktree root')
    }
    return context
  } catch (error) {
    fs.closeSync(context.executableDescriptor)
    throw error
  }
}

async function localConfiguration(context: GitContext): Promise<LocalConfigEntry[]> {
  const local = parseLocalConfig((await runGit(context, [
    'config', '--local', '--no-includes', '--null', '--list',
  ])).stdout)
  assertSafeLocalConfig(local)
  const hasWorktreeConfig = local.some(entry => (
    entry.key.toLocaleLowerCase('en-US') === 'extensions.worktreeconfig'
    && ['1', 'on', 'true', 'yes'].includes(entry.value.toLocaleLowerCase('en-US'))
  ))
  if (!hasWorktreeConfig) return local
  const worktree = parseLocalConfig((await runGit(context, [
    'config', '--worktree', '--no-includes', '--null', '--list',
  ])).stdout)
  assertSafeLocalConfig(worktree)
  return [...local, ...worktree]
}

async function repositoryIdentity(
  context: GitContext,
): Promise<RepositoryIdentity> {
  const gitDirOutput = singleLine(
    (await runGit(context, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])).stdout,
    'Git directory',
  )
  const commonDirOutput = singleLine(
    (await runGit(context, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout,
    'Git common directory',
  )
  let gitDir: string
  let commonDir: string
  try {
    gitDir = fs.realpathSync(gitDirOutput)
    commonDir = fs.realpathSync(commonDirOutput)
  } catch {
    fail('invalid_repository', 'Git common directory is unavailable')
  }
  if (gitDir !== gitDirOutput || commonDir !== commonDirOutput) {
    fail('invalid_repository', 'Git directories must be canonical')
  }
  const objectsDirectory = path.join(commonDir, 'objects')
  try {
    if (!fs.statSync(objectsDirectory).isDirectory()
      || fs.realpathSync(objectsDirectory) !== objectsDirectory) {
      fail('unsupported_repository', 'Git object directory must be a canonical local directory')
    }
    const packDirectory = path.join(objectsDirectory, 'pack')
    if (fs.existsSync(packDirectory)
      && fs.readdirSync(packDirectory).some(filename => filename.endsWith('.promisor'))) {
      fail('unsupported_repository', 'Git promisor object stores are unsupported')
    }
  } catch (error) {
    if (error instanceof PublicationGitSnapshotError) throw error
    fail('invalid_repository', 'Git object directory is unavailable')
  }
  for (const filename of ['alternates', 'http-alternates']) {
    const alternatePath = path.join(objectsDirectory, 'info', filename)
    try {
      if (fs.lstatSync(alternatePath)) fail('unsupported_repository', 'Git object alternates are unsupported')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const graftStateSha256 = gitGraftStateIdentity([gitDir, commonDir])
  return {
    gitDir,
    commonDir,
    commonDirSha256: sha256(commonDir),
    graftStateSha256,
    repositorySha256: sha256(stableCanonicalJson([
      context.worktree,
      gitDir,
      commonDir,
      graftStateSha256,
    ])),
  }
}

function gitGraftStateIdentity(gitDirectories: readonly string[]): string {
  const identities = [...new Set(gitDirectories)].sort(compareOrdinal).map((directory) => {
    const infoDirectory = path.join(directory, 'info')
    const graftPath = path.join(infoDirectory, 'grafts')
    try {
      fs.lstatSync(graftPath)
      fail('unsupported_repository', 'Git graft files are unsupported for publication')
    } catch (error) {
      if (error instanceof PublicationGitSnapshotError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('invalid_repository', 'Git graft state could not be inspected')
      }
    }

    let anchor = infoDirectory
    let state = 'present'
    try {
      const lexical = fs.lstatSync(infoDirectory)
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
        fail('unsupported_repository', 'Git info directory must be a real directory')
      }
    } catch (error) {
      if (error instanceof PublicationGitSnapshotError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('invalid_repository', 'Git info directory could not be inspected')
      }
      anchor = directory
      state = 'missing'
    }
    const stat = fs.statSync(anchor, { bigint: true })
    return {
      directory,
      state,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      mode: Number(stat.mode & 0o7777n),
      owner: stat.uid.toString(),
      group: stat.gid.toString(),
      modified_ns: stat.mtimeNs.toString(),
      changed_ns: stat.ctimeNs.toString(),
    }
  })
  return sha256(stableCanonicalJson(identities))
}

async function assertRepositoryState(context: GitContext): Promise<void> {
  const shallow = singleLine(
    (await runGit(context, ['rev-parse', '--is-shallow-repository'])).stdout,
    'shallow repository state',
  )
  if (shallow !== 'false') fail('unsupported_repository', 'shallow repositories are unsupported for publication')
  const replacements = (await runGit(context, [
    'for-each-ref', '--format=%(refname)', 'refs/replace/',
  ])).stdout
  if (parseLineList(replacements, 'replace refs').length > 0) {
    fail('unsupported_repository', 'Git replace refs are unsupported for publication')
  }
  const status = (await runGit(context, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
  ])).stdout
  if (status.length > 0) fail('dirty_worktree', 'publication requires a clean tracked, staged, and untracked worktree')
}

async function resolveObjectFormat(context: GitContext): Promise<'sha1' | 'sha256'> {
  const format = singleLine(
    (await runGit(context, ['rev-parse', '--show-object-format'])).stdout,
    'object format',
  )
  if (format !== 'sha1' && format !== 'sha256') {
    fail('unsupported_repository', 'Git object format is unsupported')
  }
  return format
}

async function resolveOid(
  context: GitContext,
  revision: string,
  suffix: 'commit' | 'tree',
  objectFormat: 'sha1' | 'sha256',
): Promise<string> {
  const oid = singleLine((await runGit(context, [
    'rev-parse', '--verify', '--end-of-options', `${revision}^{${suffix}}`,
  ])).stdout, `${suffix} object ID`)
  if (!oidPattern(objectFormat).test(oid)) fail('malformed_git_output', 'trusted Git returned an invalid object ID')
  return oid
}

async function resolveRawOid(
  context: GitContext,
  revision: string,
  objectFormat: 'sha1' | 'sha256',
): Promise<string> {
  const oid = singleLine((await runGit(context, [
    'rev-parse', '--verify', '--end-of-options', revision,
  ])).stdout, 'raw ref object ID')
  if (!oidPattern(objectFormat).test(oid)) fail('malformed_git_output', 'trusted Git returned an invalid ref object ID')
  return oid
}

async function remoteUrl(
  input: PublicationGitSnapshotInput,
  config: readonly LocalConfigEntry[],
): Promise<string> {
  const key = `remote.${input.remote}.url`
  const urls = config.filter(entry => entry.key === key).map(entry => entry.value)
  if (urls.length !== 1) fail('remote_mismatch', 'publication remote must have exactly one local fetch URL')
  const actual = normalizePublicationRemoteUrl(urls[0])
  const expected = normalizePublicationRemoteUrl(input.expected_remote_url)
  if (!actual || !expected) fail('invalid_configuration', 'publication remote URL is not a safe HTTPS or SSH repository URL')
  if (actual !== expected) fail('remote_mismatch', 'publication remote URL does not match the configured target')
  return actual
}

function scanByteSource(
  input: PublicationGitSnapshotInput,
  findings: Map<string, PublicationFinding>,
  value: Uint8Array,
  kind: 'git_blob' | 'git_commit' | 'git_path',
  location: string,
): void {
  try {
    const scanned = scanPublicationBytes(value, scanOptions(input, findings, kind, location))
    appendFindings(findings, scanned, input.limits.max_findings)
  } catch (error) {
    if (error instanceof PublicationFindingOverflowError) {
      fail('limit_exceeded', 'publication finding limit exceeded')
    }
    throw error
  }
}

async function changedPaths(
  context: GitContext,
  input: PublicationGitSnapshotInput,
  commits: readonly string[],
  findings: Map<string, PublicationFinding>,
  reserveBytes: (size: number) => void,
): Promise<number> {
  let count = 0
  for (const commit of commits) {
    const output = (await runGit(context, [
      'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', '-z',
      '--no-renames', '--no-ext-diff', '--no-textconv', commit,
    ])).stdout
    for (const rawPath of parseNulRecords(output, 'changed paths')) {
      reserveBytes(rawPath.length)
      count += 1
      const location = `commit:${commit}:path:${sha256(rawPath)}`
      let publicationPath: string
      try {
        publicationPath = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawPath)
      } catch {
        scanByteSource(input, findings, rawPath, 'git_path', location)
        continue
      }
      try {
        const scanned = scanPublicationPath(
          publicationPath,
          scanOptions(input, findings, 'git_path', location),
        )
        appendFindings(findings, scanned, input.limits.max_findings)
      } catch (error) {
        if (error instanceof PublicationFindingOverflowError) {
          fail('limit_exceeded', 'publication finding limit exceeded')
        }
        throw error
      }
    }
  }
  return count
}

async function readObject(
  context: GitContext,
  record: ObjectRecord,
  remainingScanBytes: number,
  objectFormat: 'sha1' | 'sha256',
): Promise<Buffer> {
  if (record.size > remainingScanBytes) fail('limit_exceeded', 'publication total scan byte limit exceeded')
  const result = await runGit(context, ['cat-file', record.type, record.oid], {
    maxOutputBytes: Math.max(1, Math.min(context.maxOutputBytes, record.size + 1)),
  })
  if (result.stdout.length !== record.size) fail('missing_object', 'Git object content is incomplete')
  const calculatedOid = createHash(objectFormat)
    .update(`${record.type} ${record.size}\0`, 'ascii')
    .update(result.stdout)
    .digest('hex')
  if (calculatedOid !== record.oid) fail('missing_object', 'Git object content does not match its object ID')
  return result.stdout
}

async function resolveSnapshotSource(
  context: GitContext,
  input: PublicationGitSnapshotInput,
): Promise<SnapshotSourceState> {
  const config = await localConfiguration(context)
  const identity = await repositoryIdentity(context)
  await assertRepositoryState(context)
  const objectFormat = await resolveObjectFormat(context)
  const remote = await remoteUrl(input, config)
  const baseOid = await resolveOid(context, input.base_ref, 'commit', objectFormat)
  const headOid = await resolveOid(context, input.head_ref, 'commit', objectFormat)
  const rawBaseOid = await resolveRawOid(context, input.base_ref, objectFormat)
  const rawHeadOid = await resolveRawOid(context, input.head_ref, objectFormat)
  if (rawBaseOid !== baseOid || rawHeadOid !== headOid) {
    fail('unsupported_repository', 'publication source refs must point directly to commits')
  }
  const treeOid = await resolveOid(context, input.head_ref, 'tree', objectFormat)
  const checkedOutHead = await resolveOid(context, 'HEAD', 'commit', objectFormat)
  if (checkedOutHead !== headOid) fail('invalid_repository', 'publication head must match the checked-out clean worktree')

  const ancestry = await runGit(context, ['merge-base', '--is-ancestor', baseOid, headOid], {
    allowedExitCodes: [0, 1],
  })
  if (ancestry.exitCode !== 0) fail('invalid_repository', 'publication base is not an ancestor of head')
  if (baseOid === headOid) fail('invalid_repository', 'publication commit range must not be empty')
  return {
    config,
    identity,
    objectFormat,
    remote,
    baseOid,
    headOid,
    treeOid,
    executableIdentitySha256: context.executableIdentitySha256,
  }
}

async function enumerateSnapshotObjects(
  context: GitContext,
  input: PublicationGitSnapshotInput,
  source: SnapshotSourceState,
): Promise<SnapshotObjectSet> {
  const oidBytes = source.objectFormat === 'sha1' ? 41 : 65
  const commits = parseLineList((await runGit(context, [
    'rev-list', '--reverse', '--topo-order', source.headOid,
  ], {
    maxOutputBytes: commandOutputBound(input.limits.max_commits, oidBytes, input.limits.max_total_scan_bytes),
  })).stdout, 'commit list')
  if (commits.length === 0) fail('invalid_repository', 'publication head history must not be empty')
  if (commits.length > input.limits.max_commits) fail('limit_exceeded', 'publication commit limit exceeded')
  if (new Set(commits).size !== commits.length
    || !commits.includes(source.headOid)
    || commits.some(oid => !oidPattern(source.objectFormat).test(oid))) {
    fail('malformed_git_output', 'trusted Git returned an invalid commit list')
  }

  const listedObjects = parseLineList((await runGit(context, [
    'rev-list', '--objects', '--no-object-names', source.headOid,
  ], {
    maxOutputBytes: commandOutputBound(input.limits.max_objects, oidBytes, input.limits.max_total_scan_bytes),
  })).stdout, 'object list')
  const objectOids = [...new Set(listedObjects)].sort(compareOrdinal)
  if (objectOids.length > input.limits.max_objects) fail('limit_exceeded', 'publication object limit exceeded')
  if (objectOids.some(oid => !oidPattern(source.objectFormat).test(oid))) {
    fail('malformed_git_output', 'trusted Git returned an invalid object list')
  }

  const objectMetadata = await runGit(context, [
    'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
  ], {
    input: Buffer.from(`${objectOids.join('\n')}\n`, 'ascii'),
    maxOutputBytes: commandOutputBound(input.limits.max_objects, 88, input.limits.max_total_scan_bytes),
  })
  const records = parseObjectRecords(objectMetadata.stdout, objectOids, source.objectFormat)
  for (const commit of commits) {
    if (records.get(commit)?.type !== 'commit') fail('missing_object', 'publication commit object is missing')
  }
  return { commits, records }
}

async function scanSnapshotObjects(
  context: GitContext,
  input: PublicationGitSnapshotInput,
  source: SnapshotSourceState,
  objects: SnapshotObjectSet,
): Promise<SnapshotScanResult> {
  let scannedBytes = 0
  const reserveBytes = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || scannedBytes + size > input.limits.max_total_scan_bytes) {
      fail('limit_exceeded', 'publication total scan byte limit exceeded')
    }
    scannedBytes += size
  }
  const findings = new Map<string, PublicationFinding>()
  const sortedRecords = [...objects.records.values()].sort((left, right) => compareOrdinal(left.oid, right.oid))
  const commitSet = new Set(objects.commits)

  for (const record of sortedRecords.filter(candidate => candidate.type === 'tree')) {
    const content = await readObject(
      context,
      record,
      input.limits.max_total_scan_bytes - scannedBytes,
      source.objectFormat,
    )
    reserveBytes(content.length)
    assertVerifiedTree(content, source.objectFormat)
  }
  for (const commit of objects.commits) {
    const record = objects.records.get(commit)
    if (!record) fail('missing_object', 'publication commit object is missing')
    const content = await readObject(
      context,
      record,
      input.limits.max_total_scan_bytes - scannedBytes,
      source.objectFormat,
    )
    reserveBytes(content.length)
    assertRawCommitClosure(commit, content, source.objectFormat, commitSet, objects.records)
    scanByteSource(input, findings, content, 'git_commit', `commit:${commit}`)
  }

  const pathCount = await changedPaths(context, input, objects.commits, findings, reserveBytes)
  let blobCount = 0
  for (const record of sortedRecords.filter(candidate => candidate.type === 'blob')) {
    if (record.size > input.limits.max_blob_bytes) fail('limit_exceeded', 'publication blob byte limit exceeded')
    const content = await readObject(
      context,
      record,
      input.limits.max_total_scan_bytes - scannedBytes,
      source.objectFormat,
    )
    reserveBytes(content.length)
    blobCount += 1
    scanByteSource(input, findings, content, 'git_blob', `blob:${record.oid}`)
  }
  return {
    scannedBytes,
    blobCount,
    pathCount,
    findings: [...findings.values()].sort(findingOrder),
  }
}

async function assertSnapshotSourceUnchanged(
  context: GitContext,
  input: PublicationGitSnapshotInput,
  expected: SnapshotSourceState,
): Promise<void> {
  const current = await resolveSnapshotSource(context, input)
  if (stableCanonicalJson(current.config) !== stableCanonicalJson(expected.config)
    || current.identity.commonDirSha256 !== expected.identity.commonDirSha256
    || current.identity.repositorySha256 !== expected.identity.repositorySha256
    || current.executableIdentitySha256 !== expected.executableIdentitySha256
    || current.objectFormat !== expected.objectFormat
    || current.baseOid !== expected.baseOid
    || current.headOid !== expected.headOid
    || current.treeOid !== expected.treeOid
    || current.remote !== expected.remote) {
    fail('invalid_repository', 'publication repository changed while the snapshot was being scanned')
  }
}

function createSnapshot(
  input: PublicationGitSnapshotInput,
  source: SnapshotSourceState,
  objects: SnapshotObjectSet,
  scan: SnapshotScanResult,
): PublicationGitSnapshot {
  const snapshotWithoutHash = {
    schema_version: PUBLICATION_SCHEMA_VERSION,
    source: {
      git_executable_identity_sha256: source.executableIdentitySha256,
      repository_identity_sha256: source.identity.repositorySha256,
      git_common_dir_sha256: source.identity.commonDirSha256,
      object_format: source.objectFormat,
      base_ref: input.base_ref,
      base_oid: source.baseOid,
      head_ref: input.head_ref,
      head_oid: source.headOid,
      tree_oid: source.treeOid,
      remote: input.remote,
      remote_url: source.remote,
    },
    target: { destination_ref: input.destination_ref },
    scan_policy: {
      version: PUBLICATION_SCAN_POLICY_VERSION,
      limits: { ...input.limits },
      internal_markers_sha256: markerPolicyIdentity(input.internal_markers),
    },
    scan_counts: {
      commits: objects.commits.length,
      objects: objects.records.size,
      blobs: scan.blobCount,
      paths: scan.pathCount,
      bytes: scan.scannedBytes,
      findings: scan.findings.length,
    },
    findings: scan.findings,
  }
  return {
    ...snapshotWithoutHash,
    snapshot_sha256: sha256(stableCanonicalJson(snapshotWithoutHash)),
  }
}

export async function buildPublicationGitSnapshot(
  input: PublicationGitSnapshotInput,
): Promise<PublicationGitSnapshot> {
  validateInput(input)
  const context = await canonicalGitContext(input)
  try {
    const source = await resolveSnapshotSource(context, input)
    const objects = await enumerateSnapshotObjects(context, input, source)
    const scan = await scanSnapshotObjects(context, input, source, objects)
    await assertSnapshotSourceUnchanged(context, input, source)
    return createSnapshot(input, source, objects, scan)
  } finally {
    fs.closeSync(context.executableDescriptor)
  }
}
