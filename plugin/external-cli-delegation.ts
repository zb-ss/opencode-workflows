/**
 * OpenCode External CLI Delegation Plugin
 *
 * Provider CLIs run as argv-only child processes after OpenCode permission
 * approval. Run records and bounded process output are isolated by session.
 */

import { tool as pluginTool, type Plugin, type ToolContext } from '@opencode-ai/plugin'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  ensurePrivateDirectory,
  getConfigDir,
  getSessionRuntimeDir,
  hashIdentifier,
  isPathInside,
} from '../lib/paths.ts'
import { throwIfAborted } from '../lib/tool-context.ts'
import { getDelegationWorktreeName, getWorktreeDir } from '../lib/worktree-manager.ts'

export type DelegationProvider = 'claude' | 'gemini'
export type DelegationOutputFormat = 'text' | 'json'

type AttemptCategory =
  | 'success'
  | 'missing_binary'
  | 'timeout'
  | 'execution_failed'
  | 'storage_failed'
  | 'auth_required'
  | 'rate_limited'
  | 'model_unavailable'
  | 'invalid_request'
  | 'unsupported_flag'
  | 'provider_error'
  | 'empty_output'

interface ProviderConfig {
  timeout_ms?: number
  permission_mode?: string
}

interface DelegationConfig {
  claude?: ProviderConfig
  gemini?: ProviderConfig
  default_provider?: DelegationProvider | 'auto'
  fallback_order?: DelegationProvider[]
  max_output_bytes?: number
}

interface OutputFilePaths {
  stdoutAbsolute: string
  stderrAbsolute: string
  stdoutRelative: string
  stderrRelative: string
}

interface ExecResult {
  exit_code: number | null
  stdout: string
  stderr: string
  stdout_bytes: number
  stderr_bytes: number
  stdout_truncated: boolean
  stderr_truncated: boolean
  timed_out: boolean
  duration_ms: number
  spawn_error: string | null
  storage_error: string | null
}

interface AttemptOutput {
  stdout_file: string | null
  stderr_file: string | null
  stdout_bytes: number
  stderr_bytes: number
  stdout_truncated: boolean
  stderr_truncated: boolean
}

interface ProviderAttempt {
  provider: DelegationProvider
  success: boolean
  category: AttemptCategory
  message: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  response_text: string | null
  response_json: unknown | null
  raw_stdout: string
  raw_stderr: string
  warnings: string[]
  resume_token: string | null
  output: AttemptOutput
  model_alias: string | null
}

interface AttemptSummary {
  provider: DelegationProvider
  success: boolean
  category: AttemptCategory
  message: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  stdout_file: string | null
  stderr_file: string | null
  stdout_bytes: number
  stderr_bytes: number
  stdout_truncated: boolean
  stderr_truncated: boolean
  model_alias: string | null
}

export interface DelegationRunRecord {
  version: 2
  id: string
  provider: DelegationProvider | null
  session_id: string
  directory: string
  worktree: string
  created_at: string
  updated_at: string
  status: 'success' | 'failed'
  workflow_id: string | null
  parent_run_id: string | null
  used_native_resume: boolean
  stateless_followup: boolean
  output_format: DelegationOutputFormat
  prompt_hash: string
  prompt_preview: string
  response_text: string
  response_json: unknown | null
  warnings: string[]
  attempt_count: number
  attempts: AttemptSummary[]
  resume_token: string | null
  imported_from_legacy?: boolean
}

export interface ExecuteDelegationArgs {
  provider: DelegationProvider | 'auto' | string | null | undefined
  prompt: string | null | undefined
  outputFormat?: DelegationOutputFormat
  timeoutMs?: number
  workflowId?: string
  allowFallback?: boolean
  fallbackOrder?: Array<DelegationProvider | string>
  resumeToken?: string | null
  parentRunId?: string | null
  model?: string | null
  antigravityMode?: 'accept-edits' | 'plan'
}

interface PreflightOptions {
  checkAuth?: boolean
  versionTimeoutMs?: number
  authTimeoutMs?: number
}

interface PreflightResult {
  provider: DelegationProvider
  installed: boolean
  binary_path: string | null
  version: string | null
  auth_state: 'authenticated' | 'unauthenticated' | 'unknown'
  warnings: string[]
  ready: boolean
}

interface InvocationPaths {
  directory: string
  worktree: string
}

interface ExecuteCommandOptions {
  timeoutMs: number
  signal: AbortSignal
  cwd: string
  outputFiles?: OutputFilePaths
  maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 600_000
const MAX_STDOUT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_PREVIEW = 500
const MAX_FOLLOWUP_CONTEXT = 8_000
const MAX_LIST_LIMIT = 100
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const EXTERNAL_PERMISSION = 'delegation'
const UNSAFE_PERMISSION = 'delegation_unsafe'
const LEGACY_PERMISSION = 'delegation_legacy'
const EXTERNAL_DIRECTORY_PERMISSION = 'external_directory'
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]+$/
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

class BoundedCapture {
  private readonly chunks: Buffer[] = []
  private capturedBytes = 0
  private totalBytes = 0

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    const remaining = this.limit - this.capturedBytes
    if (remaining <= 0) return

    const captured = Buffer.from(chunk.subarray(0, remaining))
    this.chunks.push(captured)
    this.capturedBytes += captured.length
  }

  text(): string {
    return Buffer.concat(this.chunks, this.capturedBytes).toString('utf8')
  }

  formattedText(): string {
    const text = this.text()
    const omitted = this.totalBytes - this.capturedBytes
    return omitted > 0
      ? `${text}\n...[truncated ${omitted} bytes; additional output was omitted]`
      : text
  }

  get bytes(): number {
    return this.totalBytes
  }

  get truncated(): boolean {
    return this.totalBytes > this.capturedBytes
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  return `${input.slice(0, max)}\n...[truncated ${input.length - max} chars]`
}

function hashText(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 20)
}

function makeRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `dlg-${timestamp}-${crypto.randomBytes(6).toString('hex')}`
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(MIN_TIMEOUT_MS, Math.min(value, MAX_TIMEOUT_MS))
}

function normalizeModelAlias(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const alias = value.trim()
  if (!alias) return null
  if (/[\0\r\n]/.test(alias)) throw new Error('Provider CLI model alias contains control characters')
  if (alias.startsWith('-')) throw new Error('Provider CLI model alias cannot start with a flag prefix')
  return alias
}

function normalizeResumeToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (!token) return null
  if (token.startsWith('-') || /[\0\r\n]/.test(token)) {
    throw new Error('Provider resume token is not safe for argv use')
  }
  return token
}

function resolveInvocationPaths(context: ToolContext): InvocationPaths {
  throwIfAborted(context)
  const directory = fs.realpathSync(context.directory)
  const worktree = fs.realpathSync(context.worktree)
  if (!isPathInside(worktree, directory)) {
    throw new Error('ToolContext directory is outside the ToolContext worktree')
  }
  return { directory, worktree }
}

function loadDelegationConfig(): DelegationConfig {
  const configPath = path.join(getConfigDir(), 'workflows.json')
  try {
    const root: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!isRecord(root) || !isRecord(root.delegation)) return {}
    const section = root.delegation

    const providerConfig = (provider: DelegationProvider): ProviderConfig | undefined => {
      const value = section[provider]
      if (!isRecord(value)) return undefined
      const config: ProviderConfig = {}
      if (typeof value.timeout_ms === 'number') config.timeout_ms = value.timeout_ms
      if (typeof value.permission_mode === 'string') config.permission_mode = value.permission_mode
      return Object.keys(config).length > 0 ? config : undefined
    }

    const fallbackOrder = Array.isArray(section.fallback_order)
      ? section.fallback_order.filter(isProvider)
      : undefined
    const defaultProvider = section.default_provider

    return {
      claude: providerConfig('claude'),
      gemini: providerConfig('gemini'),
      default_provider: defaultProvider === 'claude' || defaultProvider === 'gemini' || defaultProvider === 'auto'
        ? defaultProvider
        : undefined,
      fallback_order: fallbackOrder,
      max_output_bytes: typeof section.max_output_bytes === 'number' && section.max_output_bytes > 0
        ? Math.floor(section.max_output_bytes)
        : undefined,
    }
  } catch {
    return {}
  }
}

function isProvider(value: unknown): value is DelegationProvider {
  return value === 'claude' || value === 'gemini'
}

function providerCommand(provider: DelegationProvider): string {
  return provider === 'claude' ? 'claude' : 'agy'
}

function providerLabel(provider: DelegationProvider): string {
  return provider === 'claude' ? 'Claude Code' : 'Antigravity CLI'
}

export function buildProviderOrder(
  requested: DelegationProvider | 'auto',
  allowFallback: boolean,
  configuredOrder: DelegationProvider[],
  defaultProvider: DelegationProvider | 'auto' = 'auto',
): DelegationProvider[] {
  const configured = [...new Set(configuredOrder)]
  const defaults: DelegationProvider[] = configured.length > 0 ? configured : ['claude', 'gemini']

  if (requested === 'auto') {
    if (defaultProvider === 'claude' || defaultProvider === 'gemini') {
      return [defaultProvider, ...defaults.filter(provider => provider !== defaultProvider)]
    }
    return defaults
  }

  if (!allowFallback) return [requested]
  return [requested, ...defaults.filter(provider => provider !== requested)]
}

function ensureSessionDelegationDirectory(context: ToolContext): string {
  const sessionRuntime = getSessionRuntimeDir(context.sessionID)
  const directories = [
    path.dirname(path.dirname(sessionRuntime)),
    path.dirname(sessionRuntime),
    sessionRuntime,
    path.join(sessionRuntime, 'external-cli-delegation'),
  ]
  for (const directory of directories) ensurePrivateDirectory(directory)
  return directories.at(-1)!
}

export function getSessionDelegationDirectory(context: ToolContext): string {
  return path.join(getSessionRuntimeDir(context.sessionID), 'external-cli-delegation')
}

export function getSessionRunsDirectory(context: ToolContext): string {
  return path.join(getSessionDelegationDirectory(context), 'runs')
}

function ensureRunsDirectory(context: ToolContext): string {
  ensureSessionDelegationDirectory(context)
  return ensurePrivateDirectory(getSessionRunsDirectory(context))
}

function legacyRunsDirectory(): string {
  return path.join(getConfigDir(), 'workflows', 'context', 'delegation', 'runs')
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Some filesystems do not expose POSIX permissions.
  }
}

function saveRun(context: ToolContext, record: DelegationRunRecord): void {
  const runPath = path.join(ensureRunsDirectory(context), `${record.id}.json`)
  writePrivateFile(runPath, `${JSON.stringify(record, null, 2)}\n`)
}

function normalizeRunRecord(value: unknown): DelegationRunRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !SAFE_RUN_ID.test(value.id)) return null
  if (!isProvider(value.provider)) return null
  if (value.status !== 'success' && value.status !== 'failed') return null
  if (value.output_format !== 'text' && value.output_format !== 'json') return null
  if (typeof value.prompt_preview !== 'string' || typeof value.response_text !== 'string') return null

  const attempts = Array.isArray(value.attempts)
    ? value.attempts.filter(isRecord).map((attempt): AttemptSummary => ({
        provider: isProvider(attempt.provider) ? attempt.provider : value.provider as DelegationProvider,
        success: attempt.success === true,
        category: typeof attempt.category === 'string' ? attempt.category as AttemptCategory : 'execution_failed',
        message: typeof attempt.message === 'string' ? attempt.message : '',
        exit_code: typeof attempt.exit_code === 'number' ? attempt.exit_code : null,
        duration_ms: typeof attempt.duration_ms === 'number' ? attempt.duration_ms : 0,
        timed_out: attempt.timed_out === true,
        stdout_file: typeof attempt.stdout_file === 'string' ? attempt.stdout_file : null,
        stderr_file: typeof attempt.stderr_file === 'string' ? attempt.stderr_file : null,
        stdout_bytes: typeof attempt.stdout_bytes === 'number' ? attempt.stdout_bytes : 0,
        stderr_bytes: typeof attempt.stderr_bytes === 'number' ? attempt.stderr_bytes : 0,
        stdout_truncated: attempt.stdout_truncated === true,
        stderr_truncated: attempt.stderr_truncated === true,
        model_alias: typeof attempt.model_alias === 'string' ? attempt.model_alias : null,
      }))
    : []

  return {
    version: 2,
    id: value.id,
    provider: value.provider,
    session_id: typeof value.session_id === 'string' ? value.session_id : '',
    directory: typeof value.directory === 'string' ? value.directory : '',
    worktree: typeof value.worktree === 'string' ? value.worktree : '',
    created_at: typeof value.created_at === 'string' ? value.created_at : nowIso(),
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : nowIso(),
    status: value.status,
    workflow_id: typeof value.workflow_id === 'string' ? value.workflow_id : null,
    parent_run_id: typeof value.parent_run_id === 'string' ? value.parent_run_id : null,
    used_native_resume: value.used_native_resume === true,
    stateless_followup: value.stateless_followup === true,
    output_format: value.output_format,
    prompt_hash: typeof value.prompt_hash === 'string' ? value.prompt_hash : '',
    prompt_preview: value.prompt_preview,
    response_text: value.response_text,
    response_json: value.response_json ?? null,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string') : [],
    attempt_count: typeof value.attempt_count === 'number' ? value.attempt_count : attempts.length,
    attempts,
    resume_token: typeof value.resume_token === 'string' ? value.resume_token : null,
    imported_from_legacy: value.imported_from_legacy === true,
  }
}

function publicRunRecord(record: DelegationRunRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: record.status,
    workflow_id: record.workflow_id,
    parent_run_id: record.parent_run_id,
    used_native_resume: record.used_native_resume,
    stateless_followup: record.stateless_followup,
    output_format: record.output_format,
    prompt_preview: record.prompt_preview,
    response_text: record.response_text,
    warnings: record.warnings,
    attempt_count: record.attempt_count,
    imported_from_legacy: record.imported_from_legacy === true,
    attempts: record.attempts.map((attempt) => ({
      provider: attempt.provider,
      success: attempt.success,
      category: attempt.category,
      message: attempt.message,
      exit_code: attempt.exit_code,
      duration_ms: attempt.duration_ms,
      timed_out: attempt.timed_out,
      stdout_bytes: attempt.stdout_bytes,
      stderr_bytes: attempt.stderr_bytes,
      stdout_truncated: attempt.stdout_truncated,
      stderr_truncated: attempt.stderr_truncated,
      model_alias: attempt.model_alias,
    })),
  }
}

function readRunFile(filePath: string): DelegationRunRecord | null {
  try {
    return normalizeRunRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

async function loadRun(context: ToolContext, runId: string): Promise<DelegationRunRecord | null> {
  throwIfAborted(context)
  if (!SAFE_RUN_ID.test(runId)) return null

  const currentPath = path.join(getSessionRunsDirectory(context), `${runId}.json`)
  const current = readRunFile(currentPath)
  if (current?.id === runId && current.session_id === context.sessionID) return current

  const legacyPath = path.join(legacyRunsDirectory(), `${runId}.json`)
  if (!fs.existsSync(legacyPath)) return null

  const pattern = `import:${runId}`
  await context.ask({
    permission: LEGACY_PERMISSION,
    patterns: [pattern],
    always: [pattern],
    metadata: { runId, source: legacyPath },
  })
  throwIfAborted(context)

  const legacy = readRunFile(legacyPath)
  if (legacy?.id !== runId) return null
  const invocation = resolveInvocationPaths(context)
  const imported: DelegationRunRecord = {
    ...legacy,
    session_id: context.sessionID,
    directory: invocation.directory,
    worktree: invocation.worktree,
    attempts: legacy.attempts.map(attempt => ({
      ...attempt,
      stdout_file: null,
      stderr_file: null,
    })),
    imported_from_legacy: true,
    updated_at: nowIso(),
  }
  saveRun(context, imported)
  return imported
}

function listRuns(context: ToolContext, limit: number): DelegationRunRecord[] {
  throwIfAborted(context)
  const runsDirectory = ensureRunsDirectory(context)
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 20, MAX_LIST_LIMIT))
  const records = fs.readdirSync(runsDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => readRunFile(path.join(runsDirectory, fileName)))
    .filter((record): record is DelegationRunRecord => record?.session_id === context.sessionID)

  records.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
  return records.slice(0, safeLimit)
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH
  if (!pathValue) return null

  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null
}

function writeAll(fd: number, chunk: Buffer): void {
  let offset = 0
  while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset)
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

async function execCommand(
  command: string,
  args: string[],
  options: ExecuteCommandOptions,
): Promise<ExecResult> {
  throwIfSignalAborted(options.signal)
  const startedAt = Date.now()
  const stdoutCapture = new BoundedCapture(MAX_STDOUT_BYTES)
  const stderrCapture = new BoundedCapture(MAX_STDERR_BYTES)
  let stdoutFd: number | null = null
  let stderrFd: number | null = null
  let storedOutputBytes = 0
  let stdoutStorageTruncated = false
  let stderrStorageTruncated = false
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (options.outputFiles) {
    stdoutFd = fs.openSync(options.outputFiles.stdoutAbsolute, 'w', 0o600)
    try {
      stderrFd = fs.openSync(options.outputFiles.stderrAbsolute, 'w', 0o600)
      fs.chmodSync(options.outputFiles.stdoutAbsolute, 0o600)
      fs.chmodSync(options.outputFiles.stderrAbsolute, 0o600)
    } catch (error) {
      fs.closeSync(stdoutFd)
      if (stderrFd !== null) fs.closeSync(stderrFd)
      throw error
    }
  }

  return await new Promise<ExecResult>((resolve) => {
    let finished = false
    let timedOut = false
    let spawnError: string | null = null
    let storageError: string | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null
    let killFallback: ReturnType<typeof setTimeout> | null = null

    const closeFiles = () => {
      for (const fd of [stdoutFd, stderrFd]) {
        if (fd === null) continue
        try {
          fs.closeSync(fd)
        } catch {
          // The first completion path owns cleanup.
        }
      }
      stdoutFd = null
      stderrFd = null
    }

    const finish = (exitCode: number | null) => {
      if (finished) return
      finished = true
      if (timeout) clearTimeout(timeout)
      if (killFallback) clearTimeout(killFallback)
      options.signal.removeEventListener('abort', onAbort)
      closeFiles()
      resolve({
        exit_code: exitCode,
        stdout: stdoutCapture.formattedText(),
        stderr: stderrCapture.formattedText(),
        stdout_bytes: stdoutCapture.bytes,
        stderr_bytes: stderrCapture.bytes,
        stdout_truncated: stdoutCapture.truncated || stdoutStorageTruncated,
        stderr_truncated: stderrCapture.truncated || stderrStorageTruncated,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        spawn_error: spawnError,
        storage_error: storageError,
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error)
      finish(null)
      return
    }

    const stop = (reason: 'abort' | 'timeout') => {
      if (finished) return
      timedOut = reason === 'timeout'
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // The fallback completion still closes files and settles the call.
      }
      killFallback = setTimeout(() => finish(null), 250)
    }
    const onAbort = () => stop('abort')

    child.stdout?.on('data', (value: Buffer | string) => {
      if (finished) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      stdoutCapture.append(chunk)
      if (stdoutFd === null) return
      try {
        const captured = chunk.subarray(0, Math.max(0, maxOutputBytes - storedOutputBytes))
        if (captured.length > 0) writeAll(stdoutFd, captured)
        storedOutputBytes += captured.length
        stdoutStorageTruncated ||= captured.length < chunk.length
      } catch (error) {
        storageError ??= error instanceof Error ? error.message : String(error)
      }
    })
    child.stderr?.on('data', (value: Buffer | string) => {
      if (finished) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      stderrCapture.append(chunk)
      if (stderrFd === null) return
      try {
        const captured = chunk.subarray(0, Math.max(0, maxOutputBytes - storedOutputBytes))
        if (captured.length > 0) writeAll(stderrFd, captured)
        storedOutputBytes += captured.length
        stderrStorageTruncated ||= captured.length < chunk.length
      } catch (error) {
        storageError ??= error instanceof Error ? error.message : String(error)
      }
    })
    child.on('error', (error: Error) => {
      spawnError = error.message
      finish(null)
    })
    child.on('close', (exitCode: number | null) => finish(exitCode))
    options.signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => stop('timeout'), options.timeoutMs)
    if (options.signal.aborted) onAbort()
  })
}

async function requestExternalExecution(
  context: ToolContext,
  provider: DelegationProvider,
  cwd: string,
  unsafeFlag: string | null,
): Promise<void> {
  throwIfAborted(context)
  const externalPattern = `external:${provider}`
  await context.ask({
    permission: EXTERNAL_PERMISSION,
    patterns: [externalPattern],
    always: [externalPattern],
    metadata: { provider, cwd },
  })
  throwIfAborted(context)

  if (!unsafeFlag) return
  const unsafePattern = `${provider}:${unsafeFlag}`
  await context.ask({
    permission: UNSAFE_PERMISSION,
    patterns: [unsafePattern],
    always: [],
    metadata: { provider, flag: unsafeFlag, cwd },
  })
  throwIfAborted(context)
}

async function resolveExecutionDirectory(
  context: ToolContext,
  invocation: InvocationPaths,
  requestedDirectory?: string,
): Promise<string> {
  if (!requestedDirectory) return invocation.directory
  const executionDirectory = fs.realpathSync(requestedDirectory)
  if (isPathInside(invocation.worktree, executionDirectory)) return executionDirectory

  const managedRoot = getWorktreeDir(invocation.worktree)
  if (path.dirname(executionDirectory) !== managedRoot
    || !path.basename(executionDirectory).startsWith('delegate-')) {
    throw new Error('Delegation execution directory is outside the current project and managed runtime worktrees')
  }
  await context.ask({
    permission: EXTERNAL_DIRECTORY_PERMISSION,
    patterns: [executionDirectory],
    always: [],
    metadata: { directory: executionDirectory, operation: 'delegation' },
  })
  throwIfAborted(context)
  return executionDirectory
}

function configuredUnsafeFlag(
  provider: DelegationProvider,
  config: ProviderConfig | undefined,
  warnings: string[],
): string | null {
  const mode = config?.permission_mode
  if (!mode) return null
  if (provider === 'claude' && mode === 'dangerously-skip-permissions') {
    return '--dangerously-skip-permissions'
  }
  if (provider === 'gemini' && mode === 'dangerously-skip-permissions') {
    return '--dangerously-skip-permissions'
  }

  warnings.push(`Ignored unsupported ${provider} permission_mode '${mode}'.`)
  return null
}

export function getProviderArgs(
  provider: DelegationProvider,
  prompt: string,
  outputFormat: DelegationOutputFormat,
  resumeToken: string | null,
  modelAlias: string | null,
  unsafeFlag: string | null = null,
  antigravityMode?: 'accept-edits' | 'plan',
): string[] {
  if (provider === 'claude') {
    const args = ['--print']
    if (unsafeFlag) args.push(unsafeFlag)
    if (resumeToken) args.push('--resume', resumeToken)
    if (modelAlias) args.push('--model', modelAlias)
    args.push('--output-format', 'json', '--', prompt)
    return args
  }

  const args: string[] = []
  if (unsafeFlag) args.push(unsafeFlag)
  if (antigravityMode) args.push('--mode', antigravityMode)
  args.push('--print', prompt)
  if (modelAlias) args.push('--model', modelAlias)
  return args
}

function createAttemptOutputFiles(
  context: ToolContext,
  runId: string,
  attemptNumber: number,
  provider: DelegationProvider,
): OutputFilePaths {
  const delegationDirectory = ensureSessionDelegationDirectory(context)
  const outputDirectory = ensurePrivateDirectory(path.join(delegationDirectory, 'outputs', runId))
  const prefix = `${String(attemptNumber).padStart(2, '0')}-${provider}`
  const stdoutAbsolute = path.join(outputDirectory, `${prefix}.stdout.log`)
  const stderrAbsolute = path.join(outputDirectory, `${prefix}.stderr.log`)
  return {
    stdoutAbsolute,
    stderrAbsolute,
    stdoutRelative: path.relative(delegationDirectory, stdoutAbsolute),
    stderrRelative: path.relative(delegationDirectory, stderrAbsolute),
  }
}

function emptyAttemptOutput(): AttemptOutput {
  return {
    stdout_file: null,
    stderr_file: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
  }
}

function outputFromResult(files: OutputFilePaths, result: ExecResult): AttemptOutput {
  return {
    stdout_file: files.stdoutRelative,
    stderr_file: files.stderrRelative,
    stdout_bytes: result.stdout_bytes,
    stderr_bytes: result.stderr_bytes,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
  }
}

function failedAttempt(
  provider: DelegationProvider,
  category: AttemptCategory,
  message: string,
  result: ExecResult | null,
  warnings: string[],
  output: AttemptOutput,
  modelAlias: string | null,
): ProviderAttempt {
  return {
    provider,
    success: false,
    category,
    message,
    exit_code: result?.exit_code ?? null,
    duration_ms: result?.duration_ms ?? 0,
    timed_out: result?.timed_out ?? false,
    response_text: null,
    response_json: null,
    raw_stdout: result?.stdout ?? '',
    raw_stderr: result?.stderr ?? '',
    warnings,
    resume_token: null,
    output,
    model_alias: modelAlias,
  }
}

function parseJsonLoose(input: string): unknown | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const objectStart = trimmed.indexOf('{')
    const objectEnd = trimmed.lastIndexOf('}')
    if (objectStart !== -1 && objectEnd > objectStart) {
      try {
        return JSON.parse(trimmed.slice(objectStart, objectEnd + 1))
      } catch {
        // Try an array next.
      }
    }
    const arrayStart = trimmed.indexOf('[')
    const arrayEnd = trimmed.lastIndexOf(']')
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function extractResponseText(responseJson: unknown, fallback: string): string {
  if (typeof responseJson === 'string') return responseJson
  if (isRecord(responseJson)) {
    const nestedResult = isRecord(responseJson.result) ? responseJson.result.text : null
    for (const value of [
      responseJson.result,
      responseJson.response,
      responseJson.output,
      responseJson.text,
      responseJson.message,
      nestedResult,
    ]) {
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  return fallback
}

function extractResumeToken(responseJson: unknown): string | null {
  if (!isRecord(responseJson)) return null
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'run_id', 'runId']) {
    const value = responseJson[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function classifyExitFailure(output: string): AttemptCategory {
  if (/(not\s+logged\s+in|login\s+required|sign\s+in|unauth|authentication\s+required|\b401\b|\b403\b)/i.test(output)) {
    return 'auth_required'
  }
  if (/(rate.?limit|quota\s+exceeded|\b429\b)/i.test(output)) return 'rate_limited'
  if (/(model\s+(?:not\s+found|unavailable|does\s+not\s+exist)|unknown\s+model)/i.test(output)) {
    return 'model_unavailable'
  }
  if (/(unknown option|unrecognized option|invalid option|unknown flag)/i.test(output)) return 'unsupported_flag'
  if (/(invalid request|bad request|\b400\b)/i.test(output)) return 'invalid_request'
  return 'execution_failed'
}

async function runAttempt(
  context: ToolContext,
  invocation: InvocationPaths,
  provider: DelegationProvider,
  prompt: string,
  outputFormat: DelegationOutputFormat,
  timeoutMs: number,
  resumeToken: string | null,
  modelAlias: string | null,
  unsafeFlag: string | null,
  antigravityMode: 'accept-edits' | 'plan' | undefined,
  runId: string,
  attemptNumber: number,
  maxOutputBytes: number,
  executionDirectory = invocation.directory,
): Promise<ProviderAttempt> {
  const command = providerCommand(provider)
  const binary = resolveExecutable(command)
  const warnings: string[] = []
  if (!binary) {
    return failedAttempt(
      provider,
      'missing_binary',
      `${providerLabel(provider)} (${command}) not found in PATH`,
      null,
      warnings,
      emptyAttemptOutput(),
      modelAlias,
    )
  }

  const effectiveResumeToken = provider === 'claude' ? resumeToken : null
  if (provider === 'gemini' && resumeToken) {
    warnings.push('Antigravity resume is not enabled by this integration; using stateless mode.')
  }

  await requestExternalExecution(context, provider, executionDirectory, unsafeFlag)
  const outputFiles = createAttemptOutputFiles(context, runId, attemptNumber, provider)
  const args = getProviderArgs(
    provider,
    prompt,
    outputFormat,
    effectiveResumeToken,
    modelAlias,
    unsafeFlag,
    antigravityMode,
  )
  const result = await execCommand(binary, args, {
    timeoutMs,
    signal: context.abort,
    cwd: executionDirectory,
    outputFiles,
    maxOutputBytes,
  })
  throwIfAborted(context)

  const output = outputFromResult(outputFiles, result)
  if (result.timed_out) {
    return failedAttempt(provider, 'timeout', `${provider} timed out after ${timeoutMs}ms`, result, warnings, output, modelAlias)
  }
  if (result.storage_error) {
    return failedAttempt(provider, 'storage_failed', `${provider} output could not be persisted: ${result.storage_error}`, result, warnings, output, modelAlias)
  }
  if (result.spawn_error) {
    return failedAttempt(provider, 'execution_failed', `${provider} execution error: ${result.spawn_error}`, result, warnings, output, modelAlias)
  }
  if (result.exit_code !== 0) {
    const category = classifyExitFailure(`${result.stdout}\n${result.stderr}`)
    return failedAttempt(provider, category, `${provider} failed (${category}): exit ${result.exit_code}`, result, warnings, output, modelAlias)
  }

  const rawText = (result.stdout || result.stderr).trim()
  if (!rawText) {
    return failedAttempt(provider, 'empty_output', `${provider} returned empty output`, result, warnings, output, modelAlias)
  }

  const shouldParseJson = provider === 'claude' || outputFormat === 'json'
  const wasTruncated = result.stdout_truncated || (!result.stdout && result.stderr_truncated)
  const parsed = shouldParseJson && !wasTruncated ? parseJsonLoose(rawText) : null
  if (shouldParseJson && !parsed) {
    warnings.push(wasTruncated
      ? `${provider} JSON exceeded the in-memory cap; the structured response was omitted.`
      : `${provider} returned non-JSON output; using text.`)
  }

  const responseText = extractResponseText(parsed, rawText)
  if (provider === 'claude' && isRecord(parsed) && parsed.is_error === true) {
    const detail = typeof parsed.result === 'string' ? truncate(parsed.result, 200) : 'unknown'
    const attempt = failedAttempt(provider, 'provider_error', `Claude reported error: ${detail}`, result, warnings, output, modelAlias)
    attempt.response_text = responseText
    attempt.response_json = parsed
    return attempt
  }

  return {
    provider,
    success: true,
    category: 'success',
    message: `${provider} succeeded`,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    timed_out: false,
    response_text: responseText,
    response_json: parsed,
    raw_stdout: result.stdout,
    raw_stderr: result.stderr,
    warnings,
    resume_token: provider === 'claude' ? extractResumeToken(parsed) : null,
    output,
    model_alias: modelAlias,
  }
}

function toAttemptsSummary(attempts: ProviderAttempt[]): AttemptSummary[] {
  return attempts.map(attempt => ({
    provider: attempt.provider,
    success: attempt.success,
    category: attempt.category,
    message: attempt.message,
    exit_code: attempt.exit_code,
    duration_ms: attempt.duration_ms,
    timed_out: attempt.timed_out,
    stdout_file: attempt.output.stdout_file,
    stderr_file: attempt.output.stderr_file,
    stdout_bytes: attempt.output.stdout_bytes,
    stderr_bytes: attempt.output.stderr_bytes,
    stdout_truncated: attempt.output.stdout_truncated,
    stderr_truncated: attempt.output.stderr_truncated,
    model_alias: attempt.model_alias,
  }))
}

function attemptPayload(attempt: ProviderAttempt): Record<string, unknown> {
  return {
    provider: attempt.provider,
    success: attempt.success,
    category: attempt.category,
    message: attempt.message,
    exit_code: attempt.exit_code,
    duration_ms: attempt.duration_ms,
  }
}

async function executeDelegationInDirectory(
  args: ExecuteDelegationArgs,
  context: ToolContext,
  executionDirectory?: string,
): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const invocation = resolveInvocationPaths(context)
  const runDirectory = await resolveExecutionDirectory(context, invocation, executionDirectory)
  const config = loadDelegationConfig()
  const inputWarnings: string[] = []
  const rawProvider = args.provider
  const normalizedProvider: DelegationProvider | 'auto' = isProvider(rawProvider) || rawProvider === 'auto'
    ? rawProvider
    : 'auto'
  if (normalizedProvider !== rawProvider) {
    inputWarnings.push(`Invalid or missing provider '${String(rawProvider)}'; defaulted to 'auto'.`)
  }

  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return {
      ok: false,
      payload: {
        success: false,
        provider: normalizedProvider,
        run_id: null,
        error: 'Missing or empty prompt',
        attempts: [],
        warnings: inputWarnings,
      },
    }
  }

  const fallbackOrder = Array.isArray(args.fallbackOrder)
    ? args.fallbackOrder.filter(isProvider)
    : (config.fallback_order ?? [])
  if (Array.isArray(args.fallbackOrder) && fallbackOrder.length !== args.fallbackOrder.length) {
    inputWarnings.push('Some invalid fallback providers were ignored.')
  }

  const outputFormat: DelegationOutputFormat = args.outputFormat === 'json' ? 'json' : 'text'
  const defaultTimeout = clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS)
  const providers = buildProviderOrder(
    normalizedProvider,
    args.allowFallback !== false,
    fallbackOrder,
    config.default_provider,
  )
  const explicitModelAlias = normalizeModelAlias(args.model)
  const resumeToken = normalizeResumeToken(args.resumeToken)
  const runId = makeRunId()
  const attempts: ProviderAttempt[] = []
  let winner: ProviderAttempt | null = null

  for (const provider of providers) {
    throwIfAborted(context)
    const providerConfig = config[provider]
    const warnings: string[] = []
    const unsafeFlag = configuredUnsafeFlag(provider, providerConfig, warnings)
    const modelAlias = explicitModelAlias
    const timeoutMs = clampTimeout(providerConfig?.timeout_ms, defaultTimeout)
    const attempt = await runAttempt(
      context,
      invocation,
      provider,
      prompt,
      outputFormat,
      timeoutMs,
      resumeToken,
      modelAlias,
      unsafeFlag,
      args.antigravityMode,
      runId,
      attempts.length + 1,
      config.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      runDirectory,
    )
    attempt.warnings.unshift(...warnings)
    attempts.push(attempt)
    if (attempt.success) {
      winner = attempt
      break
    }
    if (args.allowFallback === false) break
  }

  const timestamp = nowIso()
  const warnings = [...inputWarnings, ...attempts.flatMap(attempt => attempt.warnings)]
  const hasStatelessParent = Boolean(args.parentRunId && !resumeToken)
  const record: DelegationRunRecord = {
    version: 2,
    id: runId,
    provider: winner?.provider ?? attempts.at(-1)?.provider ?? null,
    session_id: context.sessionID,
    directory: runDirectory,
    worktree: executionDirectory ? runDirectory : invocation.worktree,
    created_at: timestamp,
    updated_at: timestamp,
    status: winner ? 'success' : 'failed',
    workflow_id: args.workflowId ?? null,
    parent_run_id: args.parentRunId ?? null,
    used_native_resume: Boolean(resumeToken && winner?.provider === 'claude'),
    stateless_followup: hasStatelessParent,
    output_format: outputFormat,
    prompt_hash: hashText(prompt),
    prompt_preview: truncate(prompt, MAX_PREVIEW),
    response_text: winner?.response_text ?? '',
    response_json: winner?.response_json ?? null,
    warnings,
    attempt_count: attempts.length,
    attempts: toAttemptsSummary(attempts),
    resume_token: winner?.resume_token ?? null,
  }
  saveRun(context, record)

  if (!winner) {
    return {
      ok: false,
      payload: {
        success: false,
        provider: null,
        run_id: runId,
        error: 'All provider attempts failed',
        attempts: attempts.map(attemptPayload),
        warnings,
      },
    }
  }

  return {
    ok: true,
    payload: {
      success: true,
      provider: winner.provider,
      run_id: runId,
      response: winner.response_text,
      warnings: [
        ...warnings,
        ...(hasStatelessParent ? ['Stateless follow-up mode was used for this run.'] : []),
      ],
      attempts: attempts.map(attemptPayload),
    },
  }
}

export async function executeDelegation(
  args: ExecuteDelegationArgs,
  context: ToolContext,
): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  return executeDelegationInDirectory(args, context)
}

function detectAuthState(
  text: string,
  provider: DelegationProvider,
): 'authenticated' | 'unauthenticated' | 'unknown' {
  if (provider === 'claude') {
    const parsed = parseJsonLoose(text)
    if (isRecord(parsed) && typeof parsed.loggedIn === 'boolean') {
      return parsed.loggedIn ? 'authenticated' : 'unauthenticated'
    }
  }

  if (/(not\s+logged\s+in|loggedin["']?\s*:\s*false|login\s+required|sign\s+in|unauth|authentication\s+required)/i.test(text)) {
    return 'unauthenticated'
  }
  if (/(logged\s*in|loggedin["']?\s*:\s*true|authenticated|active\s+account|subscription|account\s*:\s*|auth\s*:\s*ok)/i.test(text)) {
    return 'authenticated'
  }
  return 'unknown'
}

async function preflightProvider(
  provider: DelegationProvider,
  context: ToolContext,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const invocation = resolveInvocationPaths(context)
  const command = providerCommand(provider)
  const binary = resolveExecutable(command)
  const warnings: string[] = []
  if (!binary) {
    return {
      provider,
      installed: false,
      binary_path: null,
      version: null,
      auth_state: 'unknown',
      warnings: [`${providerLabel(provider)} (${command}) not found in PATH`],
      ready: false,
    }
  }

  await requestExternalExecution(context, provider, invocation.directory, null)
  const versionTimeoutMs = clampTimeout(options.versionTimeoutMs, MIN_TIMEOUT_MS)
  const versionResult = await execCommand(binary, ['--version'], {
    timeoutMs: versionTimeoutMs,
    signal: context.abort,
    cwd: invocation.directory,
  })
  throwIfAborted(context)
  if (versionResult.timed_out) warnings.push(`${provider} --version timed out after ${versionTimeoutMs}ms.`)
  const version = (versionResult.stdout || versionResult.stderr)
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? null

  let authState: PreflightResult['auth_state'] = 'unknown'
  if (options.checkAuth !== false) {
    const authArgs = provider === 'claude'
      ? ['auth', 'status']
      : ['--print', 'Reply with OK only.']
    const authTimeoutMs = clampTimeout(options.authTimeoutMs, MIN_TIMEOUT_MS)
    const authResult = await execCommand(binary, authArgs, {
      timeoutMs: authTimeoutMs,
      signal: context.abort,
      cwd: invocation.directory,
    })
    throwIfAborted(context)
    if (authResult.timed_out) {
      warnings.push(`${provider} auth probe timed out after ${authTimeoutMs}ms.`)
    } else {
      const output = `${authResult.stdout}\n${authResult.stderr}`.trim()
      authState = detectAuthState(output, provider)
      if (provider === 'gemini' && authState === 'unknown' && authResult.exit_code === 0 && output) {
        authState = 'authenticated'
      }
    }
  } else {
    warnings.push(`Skipped ${provider} auth probe (checkAuth=false).`)
  }

  if (authState === 'unknown') {
    warnings.push(`Could not confidently determine ${provider} auth state. Run '${command}' interactively if needed.`)
  } else if (authState === 'unauthenticated') {
    warnings.push(`${provider} appears unauthenticated. Run '${command}' interactively to complete login.`)
  }

  return {
    provider,
    installed: true,
    binary_path: binary,
    version,
    auth_state: authState,
    warnings,
    ready: authState !== 'unauthenticated',
  }
}

function buildStatelessFollowupPrompt(previous: DelegationRunRecord, followup: string): string {
  return [
    'You are continuing a previous delegated conversation in stateless mode.',
    '',
    'Previous prompt (preview):',
    previous.prompt_preview,
    '',
    'Previous response (excerpt):',
    truncate(previous.response_text, MAX_FOLLOWUP_CONTEXT),
    '',
    'Follow-up request:',
    followup,
  ].join('\n')
}

interface FollowupArgs {
  runId: string
  prompt: string
  outputFormat?: DelegationOutputFormat
  timeoutMs?: number
  preferNativeResume?: boolean
}

async function executeFollowup(args: FollowupArgs, context: ToolContext): Promise<Record<string, unknown>> {
  const previous = await loadRun(context, args.runId)
  if (!previous) return { success: false, error: `Run not found: ${args.runId}` }
  if (previous.status !== 'success' || !previous.provider) {
    return { success: false, error: `Run cannot be continued: ${args.runId}` }
  }

  const useNative = args.preferNativeResume !== false
    && previous.provider === 'claude'
    && Boolean(previous.resume_token)
  const warnings: string[] = []
  const prompt = useNative
    ? args.prompt
    : buildStatelessFollowupPrompt(previous, args.prompt)
  if (!useNative) warnings.push('Stateless follow-up fallback used (no provider resume token available).')

  const result = await executeDelegationInDirectory({
    provider: previous.provider,
    prompt,
    outputFormat: args.outputFormat ?? previous.output_format,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workflowId: previous.workflow_id ?? undefined,
    allowFallback: false,
    resumeToken: useNative ? previous.resume_token : null,
    parentRunId: previous.id,
  }, context, previous.directory)

  if (!result.ok) {
    return {
      success: false,
      error: 'Follow-up delegation failed',
      used_native_resume: useNative,
      warnings,
      provider: previous.provider,
      details: result.payload,
    }
  }

  return {
    ...result.payload,
    followup_of: previous.id,
    used_native_resume: useNative,
    warnings: [
      ...warnings,
      ...(Array.isArray(result.payload.warnings)
        ? result.payload.warnings.filter(item => typeof item === 'string')
        : []),
    ],
  }
}

export function splitDelegateArgs(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4])
  }
  return tokens
}

const COMMAND_USAGE = [
  '/delegate status [provider] [--auth]',
  '/delegate ask <provider|auto> [--model <model>] <prompt>',
  '/delegate followup <run-id> <prompt>',
  '/delegate runs [limit]',
  '/delegate show <run-id>',
  '/delegate exec-worktree <provider> --task-id <id> --branch <branch> [--model <model>] <prompt>',
]

function takeFlag(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag)
  if (index === -1 || index + 1 >= tokens.length) return null
  const value = tokens[index + 1]
  tokens.splice(index, 2)
  return value
}

function assertSafeGitRef(value: string): void {
  if (!value || value.startsWith('-') || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value)
    || value.includes('..') || value.includes('@{') || value.endsWith('/') || value.endsWith('.')) {
    throw new Error('branch must be a safe git ref')
  }
}

async function executeWorktreeCommand(tokens: string[], context: ToolContext): Promise<Record<string, unknown>> {
  const filteredTokens = [...tokens]
  const taskId = takeFlag(filteredTokens, '--task-id')
  const branch = takeFlag(filteredTokens, '--branch')
  const model = takeFlag(filteredTokens, '--model')
  const workflowId = takeFlag(filteredTokens, '--workflow-id')
  if (!taskId || !branch) {
    return {
      success: false,
      error: 'exec-worktree requires --task-id and --branch',
      usage: COMMAND_USAGE.at(-1),
    }
  }
  if (!SAFE_SLUG.test(taskId) || (workflowId && !SAFE_SLUG.test(workflowId))) {
    return { success: false, error: 'task ID and workflow ID must be safe slugs' }
  }
  assertSafeGitRef(branch)

  const providerToken = filteredTokens[1]
  const provider: DelegationProvider = isProvider(providerToken) ? providerToken : 'claude'
  const prompt = filteredTokens.slice(2).join(' ').trim()
  if (!prompt) return { success: false, error: 'exec-worktree requires a prompt' }

  const invocation = resolveInvocationPaths(context)
  const effectiveWorkflowId = workflowId ?? `session-${hashIdentifier(context.sessionID)}`
  const worktreeName = getDelegationWorktreeName(effectiveWorkflowId, taskId)
  const worktreesDirectory = getWorktreeDir(invocation.worktree)
  const worktreePath = path.join(worktreesDirectory, worktreeName)
  const branchName = `delegate/${effectiveWorkflowId}/${taskId}`
  if (!isPathInside(worktreesDirectory, worktreePath)) {
    return { success: false, error: 'Derived worktree path is outside the managed directory' }
  }

  const git = resolveExecutable('git')
  if (!git) return { success: false, error: 'git CLI not found in PATH' }
  const gitPattern = 'external:git-worktree-add'
  await context.ask({
    permission: EXTERNAL_PERMISSION,
    patterns: [gitPattern],
    always: [gitPattern],
    metadata: { cwd: invocation.worktree, worktreePath, branchName },
  })
  throwIfAborted(context)
  ensurePrivateDirectory(worktreesDirectory)
  const gitResult = await execCommand(git, ['worktree', 'add', '-b', branchName, worktreePath, branch], {
    timeoutMs: 15_000,
    signal: context.abort,
    cwd: invocation.worktree,
  })
  throwIfAborted(context)
  if (gitResult.exit_code !== 0 || gitResult.spawn_error) {
    const detail = gitResult.spawn_error ?? (gitResult.stderr.trim() || `exit ${gitResult.exit_code}`)
    return {
      success: false,
      error: `Failed to create worktree: ${detail}`,
    }
  }

  const result = await executeDelegationInDirectory({
    provider,
    prompt,
    model,
    antigravityMode: provider === 'gemini' ? 'accept-edits' : undefined,
    timeoutMs: 300_000,
    workflowId: effectiveWorkflowId,
  }, context, fs.realpathSync(worktreePath))
  return {
    command: 'exec-worktree',
    task_id: taskId,
    workflow_id: effectiveWorkflowId,
    worktree_path: worktreePath,
    branch_name: branchName,
    ...result.payload,
  }
}

export async function executeDelegateCommand(
  rawInput: string,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  throwIfAborted(context)
  const input = rawInput.trim()
  const cleaned = input === '/delegate'
    ? ''
    : input.startsWith('/delegate ')
      ? input.slice('/delegate '.length).trim()
      : input
  const tokens = splitDelegateArgs(cleaned)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !/^\$\d+$/.test(token) && token !== '$ARGUMENTS')
  if (tokens.length === 0) return { success: false, error: 'Missing subcommand', usage: COMMAND_USAGE }

  const subcommand = tokens[0].toLowerCase()
  if (subcommand === 'status') {
    const providerToken = tokens.find(isProvider)
    const providers: DelegationProvider[] = providerToken ? [providerToken] : ['claude', 'gemini']
    const checks: PreflightResult[] = []
    for (const provider of providers) {
      checks.push(await preflightProvider(provider, context, {
        checkAuth: tokens.includes('--auth'),
        versionTimeoutMs: 3_000,
        authTimeoutMs: 2_500,
      }))
    }
    return {
      success: true,
      command: 'status',
      checkAuth: tokens.includes('--auth'),
      providers: checks.map(({ binary_path: _binaryPath, ...check }) => check),
      warnings: checks.flatMap(check => check.warnings),
    }
  }

  if (subcommand === 'ask') {
    const filteredTokens = [...tokens]
    const model = takeFlag(filteredTokens, '--model')
    const providerToken = filteredTokens[1]
    const provider: DelegationProvider | 'auto' = isProvider(providerToken) || providerToken === 'auto'
      ? providerToken
      : 'auto'
    const promptStart = provider === 'auto' && providerToken !== 'auto' ? 1 : 2
    const result = await executeDelegation({
      provider,
      prompt: filteredTokens.slice(promptStart).join(' ').trim(),
      model,
    }, context)
    return { command: 'ask', ...result.payload }
  }

  if (subcommand === 'followup') {
    const runId = tokens[1]
    const prompt = tokens.slice(2).join(' ').trim()
    if (!runId || !prompt) {
      return {
        success: false,
        error: 'followup requires <run-id> and <prompt>',
        usage: '/delegate followup <run-id> <prompt>',
      }
    }
    return {
      command: 'followup',
      ...(await executeFollowup({ runId, prompt }, context)),
    }
  }

  if (subcommand === 'runs') {
    const parsedLimit = Number.parseInt(tokens[1] ?? '20', 10)
    const runs = listRuns(context, Number.isFinite(parsedLimit) ? parsedLimit : 20)
    return {
      success: true,
      command: 'runs',
      count: runs.length,
      runs: runs.map(run => ({
        id: run.id,
        provider: run.provider,
        created_at: run.created_at,
        status: run.status,
        workflow_id: run.workflow_id,
        prompt_preview: run.prompt_preview,
      })),
    }
  }

  if (subcommand === 'show') {
    const runId = tokens[1]
    if (!runId) return { success: false, error: 'show requires <run-id>', usage: '/delegate show <run-id>' }
    const run = await loadRun(context, runId)
    return run
      ? { success: true, command: 'show', run: publicRunRecord(run) }
      : { success: false, error: `Run not found: ${runId}` }
  }

  if (subcommand === 'exec-worktree') return executeWorktreeCommand(tokens, context)
  return { success: false, error: `Unknown subcommand: ${subcommand}`, usage: COMMAND_USAGE }
}

export const ExternalCliDelegation: Plugin = async () => {
  const z = pluginTool.schema

  return {
    tool: {
      delegate_command: pluginTool({
        description: 'Execute a /delegate subcommand. Pass the full command string in "input".',
        args: {
          input: z.string().default('').describe('Raw arguments, for example "status claude --auth" or "ask claude Explain this flow"'),
        },
        async execute(args: { input: string }, context: ToolContext) {
          try {
            return JSON.stringify(await executeDelegateCommand(args.input.trim(), context), null, 2)
          } catch (error) {
            if (context.abort.aborted) throw error
            const message = error instanceof Error ? error.message : String(error)
            return JSON.stringify({ success: false, error: `delegate_command crashed: ${message}` })
          }
        },
      }),

      delegate_preflight: pluginTool({
        description: 'Check external CLI delegation readiness for Claude Code and Antigravity CLI.',
        args: {
          providers: z.string().optional().describe('Comma-separated routing tokens to check (claude,gemini); gemini invokes agy. Defaults to both.'),
          checkAuth: z.boolean().optional().describe('Whether to probe provider auth state'),
        },
        async execute(args: { providers?: string; checkAuth?: boolean }, context: ToolContext) {
          const requested = (args.providers ?? '').split(',').map(provider => provider.trim()).filter(Boolean)
          const providers = requested.filter(isProvider)
          const selected: DelegationProvider[] = providers.length > 0 ? providers : ['claude', 'gemini']
          const inputWarnings = requested.length > providers.length
            ? ['Some invalid providers were ignored. Valid values: claude, gemini.']
            : []
          const checks: PreflightResult[] = []
          for (const provider of selected) {
            checks.push(await preflightProvider(provider, context, {
              checkAuth: args.checkAuth !== false,
              versionTimeoutMs: 3_000,
              authTimeoutMs: 2_500,
            }))
          }
          return JSON.stringify({
            success: true,
            checked_at: nowIso(),
            providers: checks.map(({ binary_path: _binaryPath, ...check }) => check),
            warnings: [...inputWarnings, ...checks.flatMap(check => check.warnings)],
          }, null, 2)
        },
      }),

      delegate_run: pluginTool({
        description: 'Run a prompt through Claude Code, Antigravity CLI, or provider fallback and persist a session-scoped record.',
        args: {
          provider: z.string().describe('Target routing token: claude, gemini (Antigravity), or auto'),
          prompt: z.string().describe('Prompt to send to the provider CLI'),
          outputFormat: z.string().optional().describe('Output format: text or json'),
          timeoutMs: z.number().optional().describe('Process timeout in milliseconds'),
          workflowId: z.string().optional().describe('Optional workflow ID for traceability'),
          allowFallback: z.boolean().optional().describe('Allow fallback to the next external provider'),
          resumeToken: z.string().optional().describe('Optional provider-native session token for resume'),
          parentRunId: z.string().optional().describe('Optional run ID that this invocation follows'),
          model: z.string().optional().describe('Optional request-scoped provider CLI model alias, not an OpenCode provider/model ID'),
        },
        async execute(args: {
          provider: string
          prompt: string
          outputFormat?: string
          timeoutMs?: number
          workflowId?: string
          allowFallback?: boolean
          resumeToken?: string
          parentRunId?: string
          model?: string
        }, context: ToolContext) {
          const result = await executeDelegation({
            provider: args.provider,
            prompt: args.prompt,
            outputFormat: args.outputFormat === 'json' ? 'json' : 'text',
            timeoutMs: args.timeoutMs,
            workflowId: args.workflowId,
            allowFallback: args.allowFallback,
            resumeToken: args.resumeToken ?? null,
            parentRunId: args.parentRunId ?? null,
            model: args.model ?? null,
          }, context)
          return JSON.stringify(result.payload, null, 2)
        },
      }),

      delegate_followup: pluginTool({
        description: 'Send a follow-up prompt based on a session-scoped delegation run.',
        args: {
          runId: z.string().describe('Previous run ID to continue from'),
          prompt: z.string().describe('Follow-up prompt'),
          outputFormat: z.string().optional().describe('Output format: text or json'),
          timeoutMs: z.number().optional().describe('Process timeout in milliseconds'),
          preferNativeResume: z.boolean().optional().describe('Try provider-native resume first if a token exists'),
        },
        async execute(args: {
          runId: string
          prompt: string
          outputFormat?: string
          timeoutMs?: number
          preferNativeResume?: boolean
        }, context: ToolContext) {
          const result = await executeFollowup({
            runId: args.runId,
            prompt: args.prompt,
            outputFormat: args.outputFormat === 'json' ? 'json' : args.outputFormat === 'text' ? 'text' : undefined,
            timeoutMs: args.timeoutMs,
            preferNativeResume: args.preferNativeResume,
          }, context)
          return JSON.stringify(result, null, 2)
        },
      }),

      delegate_get_run: pluginTool({
        description: 'Get a session-scoped delegation run record by ID.',
        args: {
          runId: z.string().describe('Delegation run ID'),
        },
        async execute(args: { runId: string }, context: ToolContext) {
          const run = await loadRun(context, args.runId)
          return JSON.stringify(run
            ? { success: true, run: publicRunRecord(run) }
            : { success: false, error: `Run not found: ${args.runId}` }, null, 2)
        },
      }),

      delegate_list_runs: pluginTool({
        description: 'List recent delegation runs for the current session.',
        args: {
          limit: z.number().optional().describe('Maximum records to return (1-100)'),
        },
        async execute(args: { limit?: number }, context: ToolContext) {
          const runs = listRuns(context, args.limit ?? 20)
          return JSON.stringify({
            success: true,
            count: runs.length,
            runs: runs.map(run => ({
              id: run.id,
              provider: run.provider,
              created_at: run.created_at,
              status: run.status,
              workflow_id: run.workflow_id,
              parent_run_id: run.parent_run_id,
              prompt_preview: run.prompt_preview,
              warnings: run.warnings,
            })),
          }, null, 2)
        },
      }),
    },
  }
}

export default ExternalCliDelegation
