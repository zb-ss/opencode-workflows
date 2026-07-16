import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { descriptorPath, openAnchoredDirectory } from './bounded-file-transport.ts'
import { BoundedProcessRunner, type BoundedProcessResult } from './bounded-process.ts'
import { isPathInside } from './paths.ts'
import { childDescriptorPath, terminateDetachedProcessGroup } from './posix-process.ts'
import { assertNativePublicationExecutable } from './publication-native-executable.ts'
import {
  isPublicationEnvironmentAllowlist,
  isOperatorOwnedPublicationExecutable,
  isPublicationPublisherArgv,
  isPublicationSuccessExitCodes,
  isWorktreeRelativePublicationPath,
  MAX_PUBLICATION_PROTOCOL_STRING_LENGTH,
  PUBLICATION_ACKNOWLEDGMENT_PROTOCOL,
  PUBLICATION_PREPARED_PUBLISHER_SCHEMA_VERSION,
  PUBLICATION_REQUEST_FILE_ARGUMENT,
} from './publication-policy.ts'
import {
  containsSensitiveContent,
  SENSITIVE_CONTENT_STREAM_OVERLAP_BYTES,
} from './sensitive-content.ts'
import { trustedExecutable } from './validation-executable-policy.ts'
import {
  MAX_PUBLICATION_OUTPUT_BYTES,
  MAX_PUBLICATION_TIMEOUT_MS,
} from './workflow-config.ts'

export { PUBLICATION_REQUEST_FILE_ARGUMENT }
const MAX_PUBLICATION_REQUEST_BYTES = 1024 * 1024
const OUTPUT_SCAN_CHUNK_BYTES = 64 * 1024
export interface PublicationPublisher {
  readonly argv: readonly string[]
  readonly working_directory: string
  readonly environment: readonly string[]
  readonly timeout_ms: number
  readonly max_output_bytes: number
  readonly success_exit_codes: readonly number[]
}

export interface PublicationExecutableIdentity {
  readonly device: string
  readonly inode: string
  readonly mode: number
  readonly owner: string
  readonly group: string
  readonly size: string
  readonly modified_ns: string
  readonly changed_ns: string
}

export interface PublicationDirectoryIdentity {
  readonly device: string
  readonly inode: string
  readonly mode: number
  readonly owner: string
  readonly group: string
}

export interface PreparedPublicationPublisherDigests {
  readonly argv_sha256: string
  readonly environment_sha256: string
  readonly executable_identity_sha256: string
  readonly working_directory_identity_sha256: string
  readonly descriptor_sha256: string
}

export interface PreparedPublicationPublisher {
  readonly schema_version: typeof PUBLICATION_PREPARED_PUBLISHER_SCHEMA_VERSION
  readonly platform: NodeJS.Platform
  readonly worktree: string
  readonly configured_executable: string
  readonly executable: string
  readonly argv: readonly string[]
  readonly working_directory: string
  readonly environment: Readonly<Record<string, string>>
  readonly trusted_path: string
  readonly timeout_ms: number
  readonly max_output_bytes: number
  readonly success_exit_codes: readonly number[]
  readonly executable_identity: PublicationExecutableIdentity
  readonly working_directory_identity: PublicationDirectoryIdentity
  readonly digests: PreparedPublicationPublisherDigests
}

export interface PublicationPublisherIdentity {
  readonly argv_sha256: string
  readonly environment_sha256: string
  readonly executable_identity_sha256: string
  readonly working_directory_identity_sha256: string
  readonly descriptor_sha256: string
}

export type PublicationForcedStatus = 'timed_out' | 'cancelled' | 'output_limit'

export interface PublicationExecutionResult {
  readonly status: 'succeeded' | 'ambiguous'
  readonly exit_code: number | null
  readonly signal: NodeJS.Signals | null
  readonly forced_status: PublicationForcedStatus | null
  readonly duration_ms: number
  readonly stdout_bytes: number
  readonly stderr_bytes: number
  readonly stdout_sha256: string
  readonly stderr_sha256: string
  readonly output_truncated: boolean
  readonly output_sensitive: boolean
  readonly stdout_sensitive: boolean
  readonly stderr_sensitive: boolean
  readonly output_redacted: boolean
  readonly request_acknowledged: boolean
  readonly invocation_attempted: boolean
  readonly spawn_uncertain: boolean
  readonly termination_uncertain: boolean
}

export type PublicationChildProcess = ReturnType<typeof spawn>
export type PublicationSpawn = typeof spawn
export type PublicationProcessTerminator = (
  child: PublicationChildProcess,
  platform: NodeJS.Platform,
) => Error | null

export interface PublicationExecutorOptions {
  readonly now?: () => number
  readonly spawn?: PublicationSpawn
  readonly terminateProcess?: PublicationProcessTerminator
}

interface PublicationRequestPipe {
  once(event: 'finish' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown
  end(chunk: Uint8Array): unknown
  destroy(): unknown
}

interface PublicationAcknowledgmentPipe {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  once(event: 'end' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown
  destroy(): unknown
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value: unknown): string {
  return sha256(JSON.stringify(value))
}

export function publicationRequestAcknowledgment(request: Uint8Array): Buffer {
  return Buffer.from(`${PUBLICATION_ACKNOWLEDGMENT_PROTOCOL} ${sha256(request)}\n`, 'ascii')
}

export function publicationPublisherIdentity(
  prepared: PreparedPublicationPublisher,
): PublicationPublisherIdentity {
  return Object.freeze({ ...prepared.digests })
}

function executableIdentity(stat: fs.BigIntStats): PublicationExecutableIdentity {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o7777n),
    owner: stat.uid.toString(),
    group: stat.gid.toString(),
    size: stat.size.toString(),
    modified_ns: stat.mtimeNs.toString(),
    changed_ns: stat.ctimeNs.toString(),
  })
}

function directoryIdentity(stat: fs.BigIntStats): PublicationDirectoryIdentity {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o7777n),
    owner: stat.uid.toString(),
    group: stat.gid.toString(),
  })
}

function environmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return source[name]
}

function assertPositiveBoundedInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`publication publisher ${name} must be a positive bounded integer`)
  }
}

function assertPublisherShape(publisher: PublicationPublisher): void {
  if (!publisher || typeof publisher !== 'object') throw new Error('publication publisher configuration is required')
  const allowedFields = new Set([
    'argv',
    'working_directory',
    'environment',
    'timeout_ms',
    'max_output_bytes',
    'success_exit_codes',
  ])
  if (Object.keys(publisher).some(field => !allowedFields.has(field))) {
    throw new Error('publication publisher contains unsupported process options')
  }
  if (!isPublicationPublisherArgv(publisher.argv)) {
    throw new Error(`publication publisher argv must be exactly [absolute executable, '${PUBLICATION_REQUEST_FILE_ARGUMENT}']`)
  }
  if (typeof publisher.working_directory !== 'string' || publisher.working_directory.length < 1
    || publisher.working_directory.length > MAX_PUBLICATION_PROTOCOL_STRING_LENGTH
    || publisher.working_directory.includes('\0')
    || !isWorktreeRelativePublicationPath(publisher.working_directory)) {
    throw new Error('publication publisher working_directory must be worktree-relative')
  }
  if (!isPublicationEnvironmentAllowlist(publisher.environment)) {
    throw new Error('publication publisher environment must be a unique env-name allowlist')
  }
  assertPositiveBoundedInteger(publisher.timeout_ms, MAX_PUBLICATION_TIMEOUT_MS, 'timeout_ms')
  assertPositiveBoundedInteger(publisher.max_output_bytes, MAX_PUBLICATION_OUTPUT_BYTES, 'max_output_bytes')
  if (!isPublicationSuccessExitCodes(publisher.success_exit_codes)) {
    throw new Error('publication publisher success_exit_codes must be exactly [0]')
  }
}

function publicationDirectory(worktree: string, configuredDirectory: string): string {
  const directory = path.resolve(worktree, configuredDirectory)
  if (!isPathInside(worktree, directory)) {
    throw new Error('publication publisher working directory is outside the workflow worktree')
  }
  return directory
}

function resolveTrustedExecutable(
  configuredExecutable: string,
  source: NodeJS.ProcessEnv,
  worktree: string,
): { executable: string; searchPath: string } {
  try {
    return trustedExecutable(configuredExecutable, source, worktree)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^validation executable/, 'publication publisher executable'), { cause: error })
  }
}

function hasOperatorOwnedDirectoryChain(target: string): boolean {
  const root = path.parse(target).root
  let current = root
  const components = [root, ...path.relative(root, target).split(path.sep).filter(Boolean)]
  for (const component of components) {
    if (component !== root) current = path.join(current, component)
    const stat = fs.statSync(current, { bigint: true })
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) return false
  }
  return true
}

function publicationTrustedPath(searchPath: string): string {
  const directories: string[] = []
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue
    try {
      const realDirectory = fs.realpathSync(entry)
      if (!directories.includes(realDirectory) && hasOperatorOwnedDirectoryChain(realDirectory)) {
        directories.push(realDirectory)
      }
    } catch {
      // Missing, inaccessible, and mutable directories are not publisher authority.
    }
  }
  return directories.join(path.delimiter)
}

function sanitizedEnvironment(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
  trustedPath: string,
): Readonly<Record<string, string>> {
  const entries: [string, string][] = []
  for (const name of names) {
    const value = environmentValue(source, name)
    if (value === undefined) continue
    if (value.includes('\0')) throw new Error(`publication publisher environment value contains a null byte: ${name}`)
    if (name !== 'PATH') entries.push([name, value])
  }
  entries.push(['PATH', trustedPath])
  return Object.freeze(Object.fromEntries(entries))
}

function descriptorDigestInput(prepared: Omit<PreparedPublicationPublisher, 'digests'>): unknown {
  return {
    schema_version: prepared.schema_version,
    platform: prepared.platform,
    worktree: prepared.worktree,
    configured_executable: prepared.configured_executable,
    executable: prepared.executable,
    argv: prepared.argv,
    working_directory: prepared.working_directory,
    environment: Object.entries(prepared.environment),
    trusted_path: prepared.trusted_path,
    timeout_ms: prepared.timeout_ms,
    max_output_bytes: prepared.max_output_bytes,
    success_exit_codes: prepared.success_exit_codes,
    executable_identity: prepared.executable_identity,
    working_directory_identity: prepared.working_directory_identity,
  }
}

function assertPreparedDescriptor(prepared: PreparedPublicationPublisher): void {
  if (!prepared || prepared.schema_version !== PUBLICATION_PREPARED_PUBLISHER_SCHEMA_VERSION) {
    throw new Error('publication publisher prepared descriptor is invalid')
  }
  if (digestJson(prepared.argv) !== prepared.digests.argv_sha256
    || digestJson(Object.entries(prepared.environment)) !== prepared.digests.environment_sha256
    || digestJson(prepared.executable_identity) !== prepared.digests.executable_identity_sha256
    || digestJson(prepared.working_directory_identity) !== prepared.digests.working_directory_identity_sha256
    || digestJson(descriptorDigestInput(prepared)) !== prepared.digests.descriptor_sha256) {
    throw new Error('publication publisher prepared descriptor digest mismatch')
  }
  if (!isPublicationPublisherArgv(prepared.argv)
    || prepared.argv[0] !== prepared.configured_executable) {
    throw new Error('publication publisher prepared argv violates the fixed publisher protocol')
  }
  if (!isPublicationSuccessExitCodes(prepared.success_exit_codes)) {
    throw new Error('publication publisher prepared success_exit_codes must be exactly [0]')
  }
  if (prepared.environment.PATH !== prepared.trusted_path
    || publicationTrustedPath(prepared.trusted_path) !== prepared.trusted_path) {
    throw new Error('publication publisher prepared PATH is not root-owned and immutable')
  }
}

/**
 * Converts operator-controlled publisher configuration into a fixed, immutable
 * process descriptor. The fixed protocol permits only a directly trusted
 * executable and the request descriptor placeholder; scripts, interpreter
 * options, and other replaceable resources cannot be separate argv entries.
 */
export function validatePublisher(
  publisher: PublicationPublisher,
  worktree: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PreparedPublicationPublisher {
  if (platform === 'win32' || process.platform === 'win32') {
    throw new Error('publication publisher is unavailable on Windows because process-group termination cannot be guaranteed')
  }
  assertPublisherShape(publisher)
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) {
    throw new Error('publication publisher worktree must be an absolute path')
  }
  const realWorktree = fs.realpathSync(worktree)
  if (!fs.statSync(realWorktree).isDirectory()) throw new Error('publication publisher worktree must be a directory')
  const resolvedExecutable = resolveTrustedExecutable(publisher.argv[0], env, realWorktree)
  const executableDescriptor = fs.openSync(
    resolvedExecutable.executable,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  )
  let executableStat: fs.BigIntStats
  try {
    executableStat = fs.fstatSync(executableDescriptor, { bigint: true })
    if (!executableStat.isFile()) throw new Error('publication publisher executable must remain a regular file')
    if (!isOperatorOwnedPublicationExecutable(executableStat)) {
      throw new Error('publication publisher executable must be root-owned and not group/world-writable')
    }
    assertNativePublicationExecutable(executableDescriptor, 'publication publisher executable')
  } finally {
    fs.closeSync(executableDescriptor)
  }

  const workingDirectory = publicationDirectory(realWorktree, publisher.working_directory)
  const directoryDescriptor = openAnchoredDirectory(workingDirectory, realWorktree)
  let workingDirectoryIdentity: PublicationDirectoryIdentity
  try {
    const directoryStat = fs.fstatSync(directoryDescriptor, { bigint: true })
    if (!directoryStat.isDirectory()) throw new Error('publication publisher working directory must be a directory')
    workingDirectoryIdentity = directoryIdentity(directoryStat)
  } finally {
    fs.closeSync(directoryDescriptor)
  }

  const argv = Object.freeze([...publisher.argv])
  const successExitCodes = Object.freeze([...publisher.success_exit_codes])
  const trustedPath = publicationTrustedPath(resolvedExecutable.searchPath)
  const environment = sanitizedEnvironment(publisher.environment, env, trustedPath)
  const withoutDigests = Object.freeze({
    schema_version: PUBLICATION_PREPARED_PUBLISHER_SCHEMA_VERSION,
    platform,
    worktree: realWorktree,
    configured_executable: publisher.argv[0],
    executable: resolvedExecutable.executable,
    argv,
    working_directory: workingDirectory,
    environment,
    trusted_path: trustedPath,
    timeout_ms: publisher.timeout_ms,
    max_output_bytes: publisher.max_output_bytes,
    success_exit_codes: successExitCodes,
    executable_identity: executableIdentity(executableStat),
    working_directory_identity: workingDirectoryIdentity,
  } satisfies Omit<PreparedPublicationPublisher, 'digests'>)
  const digests = Object.freeze({
    argv_sha256: digestJson(argv),
    environment_sha256: digestJson(Object.entries(environment)),
    executable_identity_sha256: digestJson(withoutDigests.executable_identity),
    working_directory_identity_sha256: digestJson(withoutDigests.working_directory_identity),
    descriptor_sha256: digestJson(descriptorDigestInput(withoutDigests)),
  })
  return Object.freeze({ ...withoutDigests, digests })
}

function assertMatchingDirectory(
  descriptor: number,
  prepared: PreparedPublicationPublisher,
): void {
  const stat = fs.fstatSync(descriptor, { bigint: true })
  if (!stat.isDirectory()
    || digestJson(directoryIdentity(stat)) !== prepared.digests.working_directory_identity_sha256) {
    throw new Error('publication publisher working directory identity changed before dispatch')
  }
}

function immutableRequestBytes(requestBytes: Uint8Array): Buffer {
  if (!(requestBytes instanceof Uint8Array)) {
    throw new Error('publication request must be provided as immutable bytes')
  }
  if (typeof SharedArrayBuffer !== 'undefined' && requestBytes.buffer instanceof SharedArrayBuffer) {
    throw new Error('publication request bytes must not use shared mutable memory')
  }
  if (requestBytes.byteLength > MAX_PUBLICATION_REQUEST_BYTES) {
    throw new Error('publication request bytes exceed the 1 MiB limit')
  }
  return Buffer.from(requestBytes)
}

function openMatchingExecutable(prepared: PreparedPublicationPublisher): number {
  const descriptor = fs.openSync(
    prepared.executable,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  )
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!stat.isFile()
      || !isOperatorOwnedPublicationExecutable(stat)
      || digestJson(executableIdentity(stat)) !== prepared.digests.executable_identity_sha256) {
      throw new Error('publication publisher executable identity changed before dispatch')
    }
    assertNativePublicationExecutable(descriptor, 'publication publisher executable')
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

class OutputAccumulator {
  private readonly hash = createHash('sha256')
  private tail = Buffer.alloc(0)
  bytes = 0
  sensitive = false

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.hash.update(chunk)
    this.bytes = Math.min(Number.MAX_SAFE_INTEGER, this.bytes + chunk.length)
    for (let offset = 0; offset < chunk.length; offset += OUTPUT_SCAN_CHUNK_BYTES) {
      const part = chunk.subarray(offset, Math.min(chunk.length, offset + OUTPUT_SCAN_CHUNK_BYTES))
      const window = Buffer.concat([this.tail, part])
      if (containsSensitiveContent(window.toString('utf8'))) this.sensitive = true
      this.tail = Buffer.from(window.subarray(Math.max(
        0,
        window.length - SENSITIVE_CONTENT_STREAM_OVERLAP_BYTES,
      )))
    }
  }

  digest(): string {
    return this.hash.digest('hex')
  }
}

export function terminatePublicationProcess(
  child: PublicationChildProcess,
  platform: NodeJS.Platform,
): Error | null {
  return terminateDetachedProcessGroup(child, 'publication publisher', platform)
}

function emptyExecution(
  startedAt: number,
  now: () => number,
  forcedStatus: PublicationForcedStatus,
): PublicationExecutionResult {
  const emptyHash = sha256(Buffer.alloc(0))
  return Object.freeze({
    status: 'ambiguous',
    exit_code: null,
    signal: null,
    forced_status: forcedStatus,
    duration_ms: Math.max(0, now() - startedAt),
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_sha256: emptyHash,
    stderr_sha256: emptyHash,
    output_truncated: false,
    output_sensitive: false,
    stdout_sensitive: false,
    stderr_sensitive: false,
    output_redacted: false,
    request_acknowledged: false,
    invocation_attempted: false,
    spawn_uncertain: false,
    termination_uncertain: false,
  })
}

function spawnUncertainExecution(startedAt: number, now: () => number): PublicationExecutionResult {
  const result = emptyExecution(startedAt, now, 'cancelled')
  return Object.freeze({
    ...result,
    forced_status: null,
    invocation_attempted: true,
    spawn_uncertain: true,
  })
}

function spawnPublisher(
  prepared: PreparedPublicationPublisher,
  directoryDescriptor: number,
  spawnProcess: PublicationSpawn,
): PublicationChildProcess | null {
  const executableDescriptor = openMatchingExecutable(prepared)
  let child: PublicationChildProcess
  try {
    child = spawnProcess(childDescriptorPath(4), [childDescriptorPath(3)], {
      cwd: descriptorPath(directoryDescriptor),
      detached: true,
      env: prepared.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', executableDescriptor, 'pipe'],
    })
  } catch {
    try { fs.closeSync(executableDescriptor) } catch {}
    return null
  }
  try {
    fs.closeSync(executableDescriptor)
  } catch {
    terminateDetachedProcessGroup(child, 'publication publisher', prepared.platform)
    return null
  }
  return child
}

class PublicationInvocation {
  private readonly stdout = new OutputAccumulator()
  private readonly stderr = new OutputAccumulator()
  private readonly process: BoundedProcessRunner<PublicationForcedStatus>
  private readonly requestDelivery: Promise<boolean>
  private requestPipe: PublicationRequestPipe | null = null
  private acknowledgmentPipe: PublicationAcknowledgmentPipe | null = null
  private readonly acknowledgmentChunks: Buffer[] = []
  private acknowledgmentBytes = 0
  private acknowledgmentEnded = false
  private acknowledgmentInvalid = false
  private requestDeliverySettled = false
  private requestDeliveryUncertain = false
  private finishRequestDelivery: (delivered: boolean) => void = () => {}

  constructor(
    private readonly child: PublicationChildProcess,
    prepared: PreparedPublicationPublisher,
    terminateProcess: PublicationProcessTerminator,
    private readonly startedAt: number,
    private readonly now: () => number,
    private readonly expectedAcknowledgment: Buffer,
  ) {
    this.process = new BoundedProcessRunner({
      child,
      timeout_ms: prepared.timeout_ms,
      termination_grace_ms: prepared.timeout_ms,
      max_output_bytes: prepared.max_output_bytes,
      timeout_reason: 'timed_out',
      cancellation_reason: 'cancelled',
      output_limit_reason: 'output_limit',
      terminate_process: candidate => terminateProcess(candidate, prepared.platform),
      on_stdout: chunk => this.stdout.append(chunk),
      on_stderr: chunk => this.stderr.append(chunk),
      on_capture_incomplete: () => {
        this.requestPipe?.destroy()
        this.acknowledgmentPipe?.destroy()
      },
      capture_after_termination: true,
      select_forced_reason: (current, next) => next === 'output_limit' ? next : current ?? next,
    })
    this.requestDelivery = new Promise(resolve => { this.finishRequestDelivery = resolve })
    this.observeRequestDelivery()
    this.observeAcknowledgment()
  }

  private finishDelivery(delivered: boolean): void {
    if (this.requestDeliverySettled) return
    this.requestDeliverySettled = true
    this.finishRequestDelivery(delivered)
  }

  private failDelivery = (): void => {
    this.requestDeliveryUncertain = true
    this.finishDelivery(false)
    this.process.terminate(null)
  }

  private observeRequestDelivery(): void {
    const candidate = this.child.stdio[3]
    if (!candidate
      || typeof (candidate as { once?: unknown }).once !== 'function'
      || typeof (candidate as { end?: unknown }).end !== 'function'
      || typeof (candidate as { destroy?: unknown }).destroy !== 'function') {
      this.failDelivery()
      return
    }
    this.requestPipe = candidate as unknown as PublicationRequestPipe
    this.requestPipe.once('finish', () => this.finishDelivery(true))
    this.requestPipe.once('error', this.failDelivery)
    this.requestPipe.once('close', () => {
      if (!this.requestDeliverySettled) this.failDelivery()
    })
  }

  private observeAcknowledgment(): void {
    const candidate = (this.child.stdio as unknown[])[5]
    if (!candidate
      || typeof (candidate as { on?: unknown }).on !== 'function'
      || typeof (candidate as { once?: unknown }).once !== 'function'
      || typeof (candidate as { destroy?: unknown }).destroy !== 'function') {
      this.acknowledgmentInvalid = true
      this.process.terminate(null)
      return
    }
    this.acknowledgmentPipe = candidate as unknown as PublicationAcknowledgmentPipe
    this.acknowledgmentPipe.on('data', (chunk) => {
      const bytes = Buffer.from(chunk as Uint8Array)
      this.acknowledgmentBytes += bytes.length
      if (this.acknowledgmentBytes > this.expectedAcknowledgment.length) {
        this.acknowledgmentInvalid = true
        this.acknowledgmentPipe?.destroy()
        this.process.terminate(null)
        return
      }
      this.acknowledgmentChunks.push(bytes)
    })
    this.acknowledgmentPipe.once('end', () => { this.acknowledgmentEnded = true })
    this.acknowledgmentPipe.once('error', () => {
      this.acknowledgmentInvalid = true
      this.process.terminate(null)
    })
    this.acknowledgmentPipe.once('close', () => {
      if (!this.acknowledgmentEnded) this.acknowledgmentInvalid = true
    })
  }

  private requestAcknowledged(): boolean {
    return this.acknowledgmentEnded
      && !this.acknowledgmentInvalid
      && Buffer.concat(this.acknowledgmentChunks, this.acknowledgmentBytes)
        .equals(this.expectedAcknowledgment)
  }

  private deliver(request: Buffer, signal: AbortSignal): void {
    if (!this.requestPipe) return
    if (signal.aborted) {
      this.requestPipe.destroy()
      return
    }
    try {
      this.requestPipe.end(request)
    } catch {
      this.failDelivery()
    }
  }

  private async settleRequestDelivery(): Promise<boolean> {
    if (!this.requestDeliverySettled && this.requestPipe) this.requestPipe.destroy()
    this.finishDelivery(false)
    return this.requestDelivery
  }

  private result(
    completed: BoundedProcessResult<PublicationForcedStatus>,
    requestDelivered: boolean,
  ): PublicationExecutionResult {
    const stdoutSha256 = this.stdout.digest()
    const stderrSha256 = this.stderr.digest()
    const outputSensitive = this.stdout.sensitive || this.stderr.sensitive
    const requestAcknowledged = this.requestAcknowledged()
    const isSucceeded = completed.forced_reason === null
      && completed.process_error === null
      && !completed.termination_uncertain
      && requestDelivered
      && !this.requestDeliveryUncertain
      && completed.signal === null
      && completed.code === 0
      && requestAcknowledged
    return Object.freeze({
      status: isSucceeded ? 'succeeded' : 'ambiguous',
      exit_code: completed.code,
      signal: completed.signal,
      forced_status: completed.forced_reason,
      duration_ms: Math.max(0, this.now() - this.startedAt),
      stdout_bytes: completed.stdout_bytes,
      stderr_bytes: completed.stderr_bytes,
      stdout_sha256: stdoutSha256,
      stderr_sha256: stderrSha256,
      output_truncated: completed.output_truncated,
      output_sensitive: outputSensitive,
      stdout_sensitive: this.stdout.sensitive,
      stderr_sensitive: this.stderr.sensitive,
      output_redacted: outputSensitive,
      request_acknowledged: requestAcknowledged,
      invocation_attempted: true,
      spawn_uncertain: completed.process_error !== null,
      termination_uncertain: completed.termination_uncertain,
    })
  }

  async run(request: Buffer, signal: AbortSignal): Promise<PublicationExecutionResult> {
    this.deliver(request, signal)
    const completed = await this.process.run(signal)
    return this.result(completed, await this.settleRequestDelivery())
  }
}

/**
 * Dispatches one already-prepared publisher. The returned record contains only
 * counts, hashes, and safety flags; publisher stdout and stderr are never
 * returned or persisted by this executor.
 */
export async function executePublication(
  prepared: PreparedPublicationPublisher,
  requestBytes: Uint8Array,
  signal: AbortSignal,
  options: PublicationExecutorOptions = {},
): Promise<PublicationExecutionResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  assertPreparedDescriptor(prepared)
  const request = immutableRequestBytes(requestBytes)
  if (prepared.platform === 'win32' || process.platform === 'win32') {
    throw new Error('publication publisher is unavailable on Windows')
  }
  if (!signal || typeof signal.addEventListener !== 'function') {
    throw new Error('publication publisher requires an AbortSignal')
  }
  if (signal.aborted) return emptyExecution(startedAt, now, 'cancelled')

  const directoryDescriptor = openAnchoredDirectory(prepared.working_directory, prepared.worktree)
  try {
    assertMatchingDirectory(directoryDescriptor, prepared)
    if (signal.aborted) return emptyExecution(startedAt, now, 'cancelled')
    const child = spawnPublisher(prepared, directoryDescriptor, options.spawn ?? spawn)
    if (!child) return spawnUncertainExecution(startedAt, now)
    return new PublicationInvocation(
      child,
      prepared,
      options.terminateProcess ?? terminatePublicationProcess,
      startedAt,
      now,
      publicationRequestAcknowledgment(request),
    ).run(request, signal)
  } finally {
    fs.closeSync(directoryDescriptor)
  }
}
