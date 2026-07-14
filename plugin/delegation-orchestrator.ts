/**
 * OpenCode Delegation Orchestrator Plugin
 *
 * Manages plan decomposition, safe worktree lifecycle, external Claude/Antigravity
 * processes, re-delegation, merging, and cleanup.
 */

import type { Plugin, ToolContext } from '@opencode-ai/plugin'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {
  DelegationTask,
  DelegationPlan,
  DelegationOrchestratorConfig,
  DelegationProvider,
  DelegationTaskTag,
  DelegationRoutingConfig,
} from '../lib/types.ts'
import {
  createWorktree,
  mergeWorktree,
  getWorktreeStatus,
  removeWorktree,
} from '../lib/worktree-manager.ts'
import { routeTask, buildPrompt, buildCliArgs, inferTag } from '../lib/task-router.ts'
import { ensureInitFile } from '../lib/init-file-generator.ts'
import { OpenCodeSessionAdapter } from '../lib/opencode-session.ts'
import { getConfigDir, hashIdentifier, isPathInside } from '../lib/paths.ts'
import { throwIfAborted } from '../lib/tool-context.ts'
import { log } from '../lib/logger.ts'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_AWAIT_TIMEOUT_MS = 600_000
const POLL_INTERVAL_MS = 3_000
const CUSTOM_PERMISSION = 'delegation'
const UNSAFE_PERMISSION = 'delegation_unsafe'
const UNSAFE_FLAGS = new Set(['--dangerously-skip-permissions'])
const SAFE_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/

const DEFAULT_CONFIG: DelegationOrchestratorConfig = {
  claude: { timeout_ms: DEFAULT_TIMEOUT_MS },
  gemini: { timeout_ms: DEFAULT_TIMEOUT_MS },
  max_parallel: 3,
  routing: {
    ui_patterns: [
      'css', 'style', 'layout', 'responsive', 'animation', 'theme',
      'font', 'color', 'visual', 'ui', 'ux', 'design', 'icon',
      'svg', 'image', 'modal', 'dialog', 'tooltip', 'dropdown',
      'menu', 'navbar', 'sidebar', 'footer', 'header', 'banner',
    ],
    default_provider: 'claude',
  },
  fallback_order: ['claude', 'gemini'],
  max_review_iterations: 3,
  auto_init_files: true,
  max_output_bytes: 1_048_576,
}

interface PermissionRequest {
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

interface InvocationIdentity {
  projectRoot: string
  sessionId: string
}

interface DelegationTaskInput {
  id: string
  description: string
  tag?: DelegationTaskTag
  provider: DelegationProvider
  model?: string
  files?: string[]
  branch_name?: string
  review_feedback?: string | null
}

type ExecutionPhase = 'queued' | 'starting' | 'running' | 'completed'

interface TrackedExecution {
  taskId: string
  worktreeTaskId: string
  provider: DelegationProvider
  worktreePath: string | null
  branchName: string | null
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
  stdout: string
  stderr: string
  exitCode: number | null
  completed: boolean
  timedOut: boolean
  aborted: boolean
  error: string | null
  pid: number | null
  process: ReturnType<typeof spawn> | null
  phase: ExecutionPhase
}

interface QueuedExecution {
  input: DelegationTaskInput
  task: DelegationTask
  tracked: TrackedExecution
  projectRoot: string
  workflowId: string
  featureBranch: string
  allowUnsafe: boolean
  signal: AbortSignal
}

interface BatchState {
  batchId: string
  projectRoot: string
  sessionId: string
  workflowId: string
  featureBranch: string
  executions: Map<string, TrackedExecution>
  tasks: Map<string, DelegationTask>
  history: Map<string, TrackedExecution[]>
  abortController: AbortController
}

interface QueueEntry<T> {
  definition: T
  run: (definition: T) => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/** A strict FIFO queue which retains each full definition until it starts. */
export class FifoProcessQueue<T> {
  private readonly pending: Array<QueueEntry<T>> = []
  private active = 0

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('process queue concurrency must be a positive integer')
    }
  }

  enqueue(definition: T, run: (definition: T) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ definition, run, resolve, reject })
      this.drain()
    })
  }

  snapshot(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.active }
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()
      if (!entry) return

      this.active++
      let completion: Promise<void>
      try {
        completion = entry.run(entry.definition)
      } catch (error) {
        completion = Promise.reject(error)
      }

      void completion.then(entry.resolve, entry.reject).finally(() => {
        this.active--
        this.drain()
      })
    }
  }
}

function workflowsJsonPath(): string {
  return path.join(getConfigDir(), 'workflows.json')
}

function delegationContextDir(): string {
  return path.join(getConfigDir(), 'workflows', 'context', 'delegation')
}

function stripDocumentationKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_example_') || key.startsWith('_comment_')) continue
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? stripDocumentationKeys(value as Record<string, unknown>)
      : value
  }
  return result
}

function loadDelegationConfig(): DelegationOrchestratorConfig {
  const configPath = workflowsJsonPath()
  try {
    if (!fs.existsSync(configPath)) {
      log('delegation', 'Using default delegation config')
      return structuredClone(DEFAULT_CONFIG)
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const section = raw?.delegation
    if (!section || typeof section !== 'object') {
      log('delegation', 'No delegation section in workflows.json, using defaults')
      return structuredClone(DEFAULT_CONFIG)
    }

    const cleaned = stripDocumentationKeys(section)
    const configuredParallel = cleaned.max_parallel
    const maxParallel = typeof configuredParallel === 'number'
      && Number.isInteger(configuredParallel)
      && configuredParallel > 0
      ? configuredParallel
      : DEFAULT_CONFIG.max_parallel

    const config: DelegationOrchestratorConfig = {
      claude: {
        ...DEFAULT_CONFIG.claude,
        ...((cleaned.claude as object | undefined) ?? {}),
      },
      gemini: {
        ...DEFAULT_CONFIG.gemini,
        ...((cleaned.gemini as object | undefined) ?? {}),
      },
      max_parallel: maxParallel,
      routing: {
        ...DEFAULT_CONFIG.routing,
        ...((cleaned.routing as object | undefined) ?? {}),
      },
      fallback_order: Array.isArray(cleaned.fallback_order)
        ? cleaned.fallback_order as DelegationProvider[]
        : DEFAULT_CONFIG.fallback_order,
      max_review_iterations: typeof cleaned.max_review_iterations === 'number'
        ? cleaned.max_review_iterations
        : DEFAULT_CONFIG.max_review_iterations,
      max_output_bytes: typeof cleaned.max_output_bytes === 'number' && cleaned.max_output_bytes > 0
        ? Math.floor(cleaned.max_output_bytes)
        : DEFAULT_CONFIG.max_output_bytes,
      auto_init_files: typeof cleaned.auto_init_files === 'boolean'
        ? cleaned.auto_init_files
        : DEFAULT_CONFIG.auto_init_files,
    }

    log('delegation', `Loaded delegation config from ${configPath}`)
    return config
  } catch (error) {
    log('delegation', `Failed to load delegation config: ${error}`)
    return structuredClone(DEFAULT_CONFIG)
  }
}

function resolveExistingDirectory(directory: string, label: string): string {
  try {
    return fs.realpathSync(directory)
  } catch {
    throw new Error(`${label} does not exist: ${directory}`)
  }
}

function getInvocationIdentity(
  context: ToolContext,
  legacyProjectRoot?: string,
  legacySessionId?: string,
): InvocationIdentity {
  throwIfAborted(context)
  const projectRoot = resolveExistingDirectory(context.worktree, 'context worktree')
  const directory = resolveExistingDirectory(context.directory, 'context directory')
  if (!isPathInside(projectRoot, directory)) {
    throw new Error('context directory is outside the context worktree')
  }

  if (legacyProjectRoot) {
    const legacyRoot = resolveExistingDirectory(legacyProjectRoot, 'legacy projectRoot')
    if (legacyRoot !== projectRoot) {
      throw new Error('legacy projectRoot does not match the ToolContext worktree')
    }
  }
  if (legacySessionId && legacySessionId !== context.sessionID) {
    throw new Error('legacy sessionId does not match the ToolContext session')
  }

  return { projectRoot, sessionId: context.sessionID }
}

function assertBatchOwner(batch: BatchState, identity: InvocationIdentity): void {
  if (batch.projectRoot !== identity.projectRoot) {
    throw new Error(`Batch ${batch.batchId} belongs to a different project`)
  }
  if (batch.sessionId !== identity.sessionId) {
    throw new Error(`Batch ${batch.batchId} belongs to a different session`)
  }
}

function assertSafeSlug(value: string, label: string): void {
  if (!SAFE_SLUG.test(value) || value.includes('..')) {
    throw new Error(`${label} must be a safe slug`)
  }
}

async function requestPermissions(context: ToolContext, requests: PermissionRequest[]): Promise<void> {
  for (const request of requests) {
    throwIfAborted(context)
    await context.ask({
      permission: request.permission,
      patterns: request.patterns,
      always: request.patterns,
      metadata: request.metadata,
    })
  }
  throwIfAborted(context)
}

function unsafeFlagFor(provider: DelegationProvider, config: DelegationOrchestratorConfig): string | null {
  if (provider === 'claude' && config.claude.permission_mode === 'dangerously-skip-permissions') {
    return '--dangerously-skip-permissions'
  }
  if (provider === 'gemini' && config.gemini.permission_mode === 'dangerously-skip-permissions') {
    return '--dangerously-skip-permissions'
  }
  return null
}

async function authorizeExternalExecution(
  context: ToolContext,
  workflowId: string,
  providers: DelegationProvider[],
  config: DelegationOrchestratorConfig,
): Promise<Set<DelegationProvider>> {
  const uniqueProviders = [...new Set(providers)]
  const unsafeProviders = new Set<DelegationProvider>()
  const requests: PermissionRequest[] = [
    {
      permission: 'edit',
      patterns: ['*'],
      metadata: { workflowId, purpose: 'delegated edits' },
    },
    {
      permission: 'worktree',
      patterns: [`${workflowId}/*`],
      metadata: { workflowId },
    },
    {
      permission: CUSTOM_PERMISSION,
      patterns: uniqueProviders.map(provider => `external:${provider}`),
      metadata: { workflowId, providers: uniqueProviders },
    },
  ]

  for (const provider of uniqueProviders) {
    const flag = unsafeFlagFor(provider, config)
    if (!flag) continue
    unsafeProviders.add(provider)
    requests.push({
      permission: UNSAFE_PERMISSION,
      patterns: [`${provider}:${flag}`],
      metadata: { workflowId, provider, flag },
    })
  }

  await requestPermissions(context, requests)
  return unsafeProviders
}

function parsePlanText(planText: string): Array<{ description: string; files: string[] }> {
  const tasks: Array<{ description: string; files: string[] }> = []
  let currentTask: { description: string; files: string[] } | null = null

  for (const line of planText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const numberedMatch = trimmed.match(/^\d+[.):]\s+(.+)/)
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)/)
    const headerMatch = trimmed.match(/^#{2,4}\s+(.+)/)
    if (numberedMatch || bulletMatch || headerMatch) {
      if (currentTask?.description) tasks.push(currentTask)
      currentTask = {
        description: (numberedMatch?.[1] || bulletMatch?.[1] || headerMatch?.[1] || '').trim(),
        files: [],
      }
      continue
    }
    if (!currentTask) continue

    const fileMatch = trimmed.match(/(?:file|path|modify|edit|create|update)s?\s*:?\s*[`"]?([^\s`"]+\.\w+)[`"]?/i)
    if (fileMatch) currentTask.files.push(fileMatch[1])
    const backtickFiles = trimmed.match(/`([^`]+\.\w{1,10})`/g)
    if (backtickFiles) {
      for (const match of backtickFiles) {
        const file = match.replaceAll('`', '')
        if ((file.includes('/') || file.includes('.')) && !currentTask.files.includes(file)) {
          currentTask.files.push(file)
        }
      }
    }
    if (!fileMatch && !backtickFiles) currentTask.description += ` ${trimmed}`
  }

  if (currentTask?.description) tasks.push(currentTask)
  return tasks
}

function readInitFileContent(provider: DelegationProvider, projectRoot: string): string | null {
  const fileName = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'
  const filePath = path.join(projectRoot, fileName)
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  } catch {
    return null
  }
}

function savePlan(workflowId: string, plan: DelegationPlan): string {
  const contextDirectory = delegationContextDir()
  fs.mkdirSync(contextDirectory, { recursive: true, mode: 0o700 })
  const planPath = path.join(contextDirectory, `${workflowId}.plan.json`)
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 })
  log('delegation', `Plan saved to ${planPath}`)
  return planPath
}

function parseJsonLoose(input: string): unknown | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    try {
      return JSON.parse(jsonMatch[0])
    } catch {
      return null
    }
  }
}

function extractResponseText(stdout: string, provider: DelegationProvider): string {
  if (provider === 'claude') {
    const parsed = parseJsonLoose(stdout)
    if (parsed && typeof parsed === 'object') {
      const object = parsed as Record<string, unknown>
      for (const value of [object.result, object.response, object.content]) {
        if (typeof value === 'string') return value
      }
    }
  }
  return stdout.length > 8_000 ? `${stdout.slice(0, 8_000)}\n...[truncated]` : stdout
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function completeExecution(tracked: TrackedExecution, error?: string): void {
  if (tracked.completed) return
  tracked.completed = true
  tracked.completedAt = Date.now()
  tracked.phase = 'completed'
  tracked.process = null
  if (error) tracked.error = error
}

function spawnTracked(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  tracked: TrackedExecution,
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      tracked.aborted = true
      completeExecution(tracked, 'Execution aborted before process spawn')
      resolve()
      return
    }

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      detached: process.platform !== 'win32',
    })
    tracked.process = child
    tracked.pid = child.pid ?? null
    tracked.phase = 'running'
    let settled = false
    let capturedOutputBytes = 0

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      tracked.exitCode = exitCode
      completeExecution(tracked, error)
      log('delegation', `Task ${tracked.taskId} process exited: code=${exitCode}`)
      resolve()
    }
    const stop = (reason: 'abort' | 'timeout') => {
      if (settled) return
      if (reason === 'abort') tracked.aborted = true
      if (reason === 'timeout') tracked.timedOut = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Best effort; the fallback completion below still releases the slot.
      }
      setTimeout(() => finish(null, reason === 'abort' ? 'Execution aborted' : 'Execution timed out'), 250)
    }
    const onAbort = () => stop('abort')
    const timeout = setTimeout(() => stop('timeout'), timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - capturedOutputBytes
      if (remaining <= 0) return
      const captured = chunk.subarray(0, remaining)
      tracked.stdout += captured.toString()
      capturedOutputBytes += captured.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - capturedOutputBytes
      if (remaining <= 0) return
      const captured = chunk.subarray(0, remaining)
      tracked.stderr += captured.toString()
      capturedOutputBytes += captured.length
    })
    child.on('error', (error: Error) => finish(null, error.message))
    child.on('close', (exitCode: number | null) => finish(exitCode))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function buildAuthorizedCliArgs(
  provider: DelegationProvider,
  prompt: string,
  config: DelegationOrchestratorConfig,
  allowUnsafe: boolean,
  model?: string | null,
): { command: string; args: string[] } {
  const invocation = buildCliArgs(provider, prompt, config, model)
  if (allowUnsafe) return invocation

  const args = [...invocation.args]
  const generatedFlagIndex = args.findIndex(argument => UNSAFE_FLAGS.has(argument))
  if (generatedFlagIndex !== -1) args.splice(generatedFlagIndex, 1)
  return {
    command: invocation.command,
    args,
  }
}

function createTrackedExecution(
  taskId: string,
  worktreeTaskId: string,
  provider: DelegationProvider,
): TrackedExecution {
  return {
    taskId,
    worktreeTaskId,
    provider,
    worktreePath: null,
    branchName: null,
    queuedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    completed: false,
    timedOut: false,
    aborted: false,
    error: null,
    pid: null,
    process: null,
    phase: 'queued',
  }
}

function createTaskMetadata(
  input: DelegationTaskInput,
  config: DelegationOrchestratorConfig,
  attempt: number,
): DelegationTask {
  const now = new Date().toISOString()
  return {
    id: input.id,
    description: input.description,
    tag: input.tag ?? 'code',
    provider: input.provider,
    model: input.model ?? null,
    prompt: '',
    files: [...(input.files ?? [])],
    worktree_name: null,
    status: 'pending',
    attempt,
    max_attempts: config.max_review_iterations,
    review_feedback: input.review_feedback ?? null,
    run_id: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    created_at: now,
    updated_at: now,
  }
}

async function runQueuedExecution(
  definition: QueuedExecution,
  config: DelegationOrchestratorConfig,
): Promise<void> {
  const { tracked, task } = definition
  if (tracked.completed || definition.signal.aborted) {
    tracked.aborted = true
    completeExecution(tracked, 'Execution aborted while queued')
    task.status = 'failed'
    return
  }

  tracked.phase = 'starting'
  tracked.startedAt = Date.now()
  task.status = 'executing'
  task.updated_at = new Date().toISOString()

  try {
    const worktreeState = createWorktree(
      definition.projectRoot,
      tracked.worktreeTaskId,
      definition.featureBranch,
      definition.workflowId,
      tracked.provider,
    )
    if (!worktreeState) throw new Error(`Failed to create worktree for task ${tracked.taskId}`)

    tracked.worktreePath = worktreeState.path
    tracked.branchName = worktreeState.branch
    task.worktree_name = worktreeState.name
    task.worktree_path = worktreeState.path
    task.branch_name = worktreeState.branch

    if (definition.signal.aborted) {
      tracked.aborted = true
      completeExecution(tracked, 'Execution aborted after worktree creation')
      task.status = 'failed'
      return
    }

    const initContent = readInitFileContent(tracked.provider, definition.projectRoot)
    const prompt = buildPrompt(task, initContent, task.review_feedback)
    const invocation = buildAuthorizedCliArgs(
      tracked.provider,
      prompt,
      config,
      definition.allowUnsafe,
      definition.input.model,
    )
    const timeoutMs = tracked.provider === 'claude'
      ? (config.claude.timeout_ms ?? DEFAULT_TIMEOUT_MS)
      : (config.gemini.timeout_ms ?? DEFAULT_TIMEOUT_MS)

    await spawnTracked(
      invocation.command,
      invocation.args,
      worktreeState.path,
      timeoutMs,
      tracked,
      definition.signal,
      config.max_output_bytes,
    )
    task.status = tracked.exitCode === 0 && !tracked.aborted && !tracked.timedOut ? 'reviewing' : 'failed'
    task.updated_at = new Date().toISOString()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    completeExecution(tracked, message)
    task.status = 'failed'
    task.updated_at = new Date().toISOString()
    log('delegation', `Task ${tracked.taskId} failed to start: ${message}`)
  }
}

function makeAttemptTaskId(taskId: string, attempt: number): string {
  const suffix = `-attempt-${attempt}`
  return `${taskId.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`
}

function executionStatus(tracked: TrackedExecution): string {
  if (tracked.phase === 'queued') return tracked.aborted ? 'aborted' : 'queued'
  if (!tracked.completed) return tracked.phase
  if (tracked.aborted) return 'aborted'
  if (tracked.timedOut) return 'timed_out'
  return tracked.exitCode === 0 ? 'success' : 'failed'
}

export function delegationMergeError(input: {
  completed: boolean
  exitCode: number | null
  aborted: boolean
  timedOut: boolean
  executionError: string | null
  taskStatus: string | null
  targetBranch: string
  featureBranch: string
}): string | null {
  if (!input.completed) return 'Task is still running'
  if (input.exitCode !== 0 || input.aborted || input.timedOut || input.executionError) {
    return 'Task did not complete successfully'
  }
  if (input.taskStatus !== 'passed') return 'Task requires a recorded passing review before merge'
  if (input.targetBranch !== input.featureBranch) return `Merge target must be the authorized feature branch ${input.featureBranch}`
  return null
}

function executionDuration(tracked: TrackedExecution): number {
  if (tracked.startedAt === null) return 0
  return (tracked.completedAt ?? Date.now()) - tracked.startedAt
}

function batchResults(batch: BatchState): Record<string, {
  status: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
}> {
  const results: Record<string, {
    status: string
    exit_code: number | null
    duration_ms: number
    timed_out: boolean
  }> = {}
  for (const [taskId, tracked] of batch.executions) {
    results[taskId] = {
      status: executionStatus(tracked),
      exit_code: tracked.exitCode,
      duration_ms: executionDuration(tracked),
      timed_out: tracked.timedOut,
    }
  }
  return results
}

function abortBatch(batch: BatchState, reason: Error): void {
  if (!batch.abortController.signal.aborted) batch.abortController.abort(reason)
  for (const tracked of batch.executions.values()) {
    if (tracked.phase !== 'queued' || tracked.completed) continue
    tracked.aborted = true
    completeExecution(tracked, reason.message)
  }
}

function linkContextAbort(context: ToolContext, batch: BatchState): () => void {
  const onAbort = () => {
    const reason = context.abort.reason instanceof Error
      ? context.abort.reason
      : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    abortBatch(batch, reason)
  }
  if (context.abort.aborted) onAbort()
  else context.abort.addEventListener('abort', onAbort, { once: true })
  return () => context.abort.removeEventListener('abort', onAbort)
}

function normalizeTaskInputs(tasks: DelegationTaskInput[]): DelegationTaskInput[] {
  const seen = new Set<string>()
  return tasks.map(task => {
    if (!task.id || seen.has(task.id)) throw new Error(`Duplicate or empty task ID: ${task.id}`)
    assertSafeSlug(task.id, 'task ID')
    seen.add(task.id)
    if (task.provider !== 'claude' && task.provider !== 'gemini') {
      throw new Error(`Unsupported provider for task ${task.id}: ${String(task.provider)}`)
    }
    if (task.model && (/^[\s-]/.test(task.model) || /[\0\r\n]/.test(task.model))) {
      throw new Error(`Invalid model alias for task ${task.id}`)
    }
    return {
      ...task,
      files: [...(task.files ?? [])],
      review_feedback: task.review_feedback ?? null,
    }
  })
}

export const DelegationOrchestrator: Plugin = async ({ client }) => {
  const { tool: pluginTool } = await import('@opencode-ai/plugin')
  const z = pluginTool.schema
  const config = loadDelegationConfig()
  const processQueue = new FifoProcessQueue<QueuedExecution>(config.max_parallel)
  const batches = new Map<string, BatchState>()

  log('delegation', `DelegationOrchestrator initialized: max_parallel=${config.max_parallel}, routing=${config.routing.default_provider}`)

  return {
    tool: {
      delegation_decompose: {
        description: 'Parse plan text into discrete DelegationTasks with provider routing. Saves plan to context directory.',
        args: {
          planText: z.string().describe('Plan text with numbered/bulleted task descriptions'),
          workflowId: z.string().describe('Workflow ID for plan tracking'),
          featureBranch: z.string().describe('Git branch to base worktrees on'),
          routingConfig: z.object({
            ui_patterns: z.array(z.string()),
            default_provider: z.string(),
          }).optional().describe('Optional routing config override'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: {
          planText: string
          workflowId: string
          featureBranch: string
          routingConfig?: DelegationRoutingConfig
          sessionId?: string
        }, context: ToolContext) {
          const identity = getInvocationIdentity(context, undefined, args.sessionId)
          assertSafeSlug(args.workflowId, 'workflow ID')
          const routing = args.routingConfig ?? config.routing
          const parsedTasks = parsePlanText(args.planText)
          if (parsedTasks.length === 0) {
            return JSON.stringify({ error: 'No tasks could be parsed from the plan text' })
          }

          const planPath = path.join(delegationContextDir(), `${args.workflowId}.plan.json`)
          await requestPermissions(context, [
            {
              permission: 'edit',
              patterns: [planPath],
              metadata: { workflowId: args.workflowId, projectRoot: identity.projectRoot },
            },
            {
              permission: CUSTOM_PERMISSION,
              patterns: ['plan'],
              metadata: { workflowId: args.workflowId },
            },
          ])

          const now = new Date().toISOString()
          const tasks: DelegationTask[] = parsedTasks.map((parsed, index) => {
            const tag = inferTag(parsed.description, routing.ui_patterns)
            return {
              id: `task-${String(index + 1).padStart(2, '0')}`,
              description: parsed.description,
              tag,
              provider: routeTask({ description: parsed.description, tag }, routing),
              model: null,
              prompt: '',
              files: parsed.files,
              worktree_name: null,
              status: 'pending',
              attempt: 0,
              max_attempts: config.max_review_iterations,
              review_feedback: null,
              run_id: null,
              session_id: null,
              worktree_path: null,
              branch_name: null,
              created_at: now,
              updated_at: now,
            }
          })
          const plan: DelegationPlan = {
            workflow_id: args.workflowId,
            feature_branch: args.featureBranch,
            tasks,
            max_parallel: config.max_parallel,
            created_at: now,
          }
          const savedPath = savePlan(args.workflowId, plan)

          return JSON.stringify({
            plan_path: savedPath,
            task_count: tasks.length,
            tasks: tasks.map(task => ({
              id: task.id,
              description: task.description.slice(0, 120),
              tag: task.tag,
              provider: task.provider,
              files: task.files,
              status: task.status,
            })),
          })
        },
      },

      delegation_init_files: {
        description: 'Ensure CLAUDE.md and GEMINI.md init files exist in the project root. Uses an OpenCode child session with static detection as fallback.',
        args: {
          projectRoot: z.string().optional().describe('Deprecated project root; when supplied it must match ToolContext'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: { projectRoot?: string; sessionId?: string }, context: ToolContext) {
          const identity = getInvocationIdentity(context, args.projectRoot, args.sessionId)
          await requestPermissions(context, [
            {
              permission: 'task',
              patterns: ['init-files'],
              metadata: { projectRoot: identity.projectRoot },
            },
            {
              permission: 'edit',
              patterns: ['CLAUDE.md', 'GEMINI.md'],
              metadata: { projectRoot: identity.projectRoot },
            },
            {
              permission: CUSTOM_PERMISSION,
              patterns: ['init-files'],
              metadata: { projectRoot: identity.projectRoot },
            },
          ])

          const results: Record<string, { created: boolean; path: string; method: string }> = {}
          const sessions = new OpenCodeSessionAdapter(client, identity.projectRoot)

          for (const provider of ['claude', 'gemini'] as const) {
            throwIfAborted(context)
            const fileName = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'
            const filePath = path.join(identity.projectRoot, fileName)
            if (fs.existsSync(filePath)) {
              results[provider] = { created: false, path: filePath, method: 'existing' }
              continue
            }

            let generated = false
            let childSessionId: string | null = null
            try {
              const session = await sessions.create(`Generate ${fileName}`, identity.sessionId)
              childSessionId = session.id
              const cliName = provider === 'claude' ? 'Claude Code' : 'Antigravity CLI'
              const prompt = [
                `Analyze the project at ${identity.projectRoot} and generate a ${fileName} file.`,
                `This file provides context to ${cliName} when working on this project.`,
                '',
                'Read key project files and scan the directory structure.',
                `Write a concise ${fileName} (under 150 lines) covering project overview, development commands, key directories, conventions, and important notes.`,
                `Start with: <!-- Auto-generated by OpenCode Workflows for ${cliName}. Edit freely. -->`,
                `Write the file to: ${filePath}`,
                'Write ONLY the file. No explanations.',
              ].join('\n')
              await sessions.promptAsync(session.id, prompt)

              const startedAt = Date.now()
              while (Date.now() - startedAt < 90_000) {
                await abortableDelay(2_000, context.abort)
                if (!fs.existsSync(filePath)) continue
                await abortableDelay(1_000, context.abort)
                generated = true
                break
              }
            } catch (error) {
              throwIfAborted(context)
              log('delegation', `LLM generation failed for ${provider}: ${error}`)
            } finally {
              if (childSessionId) {
                try {
                  await sessions.abort(childSessionId)
                } catch {
                  // Best-effort child-session cleanup.
                }
              }
            }

            if (generated) {
              results[provider] = { created: true, path: filePath, method: 'llm' }
              continue
            }

            throwIfAborted(context)
            try {
              const result = ensureInitFile(provider, identity.projectRoot)
              results[provider] = { created: result.created, path: result.path, method: 'static' }
            } catch (error) {
              results[provider] = { created: false, path: `error: ${error}`, method: 'failed' }
            }
          }

          return JSON.stringify(results)
        },
      },

      delegation_execute_batch: {
        description: 'Queue CLI processes in safe git worktrees. The FIFO queue starts more tasks whenever a concurrency slot is released.',
        args: {
          batchId: z.string().describe('Unique batch identifier'),
          tasks: z.array(z.object({
            id: z.string(),
            description: z.string(),
            tag: z.string().optional(),
            provider: z.string(),
            model: z.string().optional().describe('Optional provider-native model alias for this task only'),
            files: z.array(z.string()).optional(),
            branch_name: z.string().optional(),
            review_feedback: z.string().optional(),
          })).describe('Tasks to execute'),
          projectRoot: z.string().optional().describe('Deprecated project root; when supplied it must match ToolContext'),
          workflowId: z.string().optional().describe('Workflow ID for worktree branch naming; a session-and-batch identity is derived when omitted'),
          featureBranch: z.string().describe('Authorized base and merge target branch for worktrees'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: {
          batchId: string
          tasks: DelegationTaskInput[]
          projectRoot?: string
          workflowId?: string
          featureBranch: string
          sessionId?: string
        }, context: ToolContext) {
          const identity = getInvocationIdentity(context, args.projectRoot, args.sessionId)
          if (batches.has(args.batchId)) {
            return JSON.stringify({ error: `Batch ${args.batchId} already exists` })
          }

          let tasks: DelegationTaskInput[]
          try {
            tasks = normalizeTaskInputs(args.tasks)
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
          if (tasks.length === 0) {
            return JSON.stringify({ error: 'At least one delegation task is required' })
          }
          const workflowId = args.workflowId ?? `batch-${hashIdentifier(`${identity.sessionId}\0${args.batchId}`)}`
          const featureBranch = args.featureBranch
          assertSafeSlug(workflowId, 'workflow ID')
          const unsafeProviders = await authorizeExternalExecution(
            context,
            workflowId,
            tasks.map(task => task.provider),
            config,
          )

          const batch: BatchState = {
            batchId: args.batchId,
            projectRoot: identity.projectRoot,
            sessionId: identity.sessionId,
            workflowId,
            featureBranch,
            executions: new Map(),
            tasks: new Map(),
            history: new Map(),
            abortController: new AbortController(),
          }
          batches.set(args.batchId, batch)
          linkContextAbort(context, batch)

          for (const input of tasks) {
            const task = createTaskMetadata(input, config, 1)
            const tracked = createTrackedExecution(input.id, input.id, input.provider)
            batch.tasks.set(input.id, task)
            batch.executions.set(input.id, tracked)

            const definition: QueuedExecution = {
              input,
              task,
              tracked,
              projectRoot: identity.projectRoot,
              workflowId,
              featureBranch,
              allowUnsafe: unsafeProviders.has(input.provider),
              signal: batch.abortController.signal,
            }
            void processQueue.enqueue(definition, queued => runQueuedExecution(queued, config)).catch(error => {
              completeExecution(tracked, error instanceof Error ? error.message : String(error))
              task.status = 'failed'
            })
          }

          const started = [...batch.executions.values()].filter(tracked => tracked.phase !== 'queued')
          const queued = [...batch.executions.values()].filter(tracked => tracked.phase === 'queued')
          return JSON.stringify({
            batchId: args.batchId,
            spawned: started.length,
            queued: queued.length,
            errors: started.filter(tracked => tracked.error).map(tracked => tracked.error),
            details: started.map(tracked => `${tracked.taskId} -> ${tracked.provider} (pid=${tracked.pid}, worktree=${tracked.worktreePath ?? 'pending'})`),
            queued_tasks: queued.map(tracked => tracked.taskId),
          })
        },
      },

      delegation_await_batch: {
        description: 'Wait for every queued and running task in a batch to finish.',
        args: {
          batchId: z.string().describe('Batch ID to wait for'),
          timeoutMs: z.number().optional().describe('Maximum wait time in milliseconds'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: { batchId: string; timeoutMs?: number; sessionId?: string }, context: ToolContext) {
          const identity = getInvocationIdentity(context, undefined, args.sessionId)
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          assertBatchOwner(batch, identity)
          await requestPermissions(context, [{
            permission: CUSTOM_PERMISSION,
            patterns: ['await'],
            metadata: { batchId: args.batchId },
          }])

          const unlinkAbort = linkContextAbort(context, batch)
          const timeoutMs = args.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS
          const startedAt = Date.now()
          try {
            while (Date.now() - startedAt < timeoutMs) {
              throwIfAborted(context)
              if ([...batch.executions.values()].every(tracked => tracked.completed)) {
                return JSON.stringify({
                  batchId: args.batchId,
                  completed: true,
                  results: batchResults(batch),
                })
              }
              await abortableDelay(POLL_INTERVAL_MS, context.abort)
            }

            abortBatch(batch, new Error(`Batch ${args.batchId} timed out after ${timeoutMs}ms`))
            await abortableDelay(500, new AbortController().signal)
            return JSON.stringify({
              batchId: args.batchId,
              completed: [...batch.executions.values()].every(tracked => tracked.completed),
              timedOut: true,
              results: batchResults(batch),
            })
          } finally {
            unlinkAbort()
          }
        },
      },

      delegation_collect_results: {
        description: 'Collect stdout, changed files, and diff stats after a complete batch.',
        args: {
          batchId: z.string().describe('Batch ID to collect results from'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: { batchId: string; sessionId?: string }, context: ToolContext) {
          const identity = getInvocationIdentity(context, undefined, args.sessionId)
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          assertBatchOwner(batch, identity)
          await requestPermissions(context, [
            {
              permission: 'worktree',
              patterns: [`${batch.workflowId}/*`],
              metadata: { batchId: args.batchId, operation: 'status' },
            },
            {
              permission: CUSTOM_PERMISSION,
              patterns: ['collect'],
              metadata: { batchId: args.batchId },
            },
          ])

          const incomplete = [...batch.executions.values()].filter(tracked => !tracked.completed)
          if (incomplete.length > 0) {
            return JSON.stringify({
              error: `Batch ${args.batchId} is not complete`,
              queued: incomplete.filter(tracked => tracked.phase === 'queued').map(tracked => tracked.taskId),
              running: incomplete.filter(tracked => tracked.phase !== 'queued').map(tracked => tracked.taskId),
            })
          }

          const results: Record<string, {
            status: string
            response_text: string
            changed_files: string[]
            diff_stat: string
            provider: DelegationProvider
            exit_code: number | null
            duration_ms: number
            stderr_preview: string
            error: string | null
            worktree_path: string | null
            prior_attempts: Array<{ worktree_path: string | null; branch_name: string | null }>
          }> = {}
          for (const [taskId, tracked] of batch.executions) {
            throwIfAborted(context)
            const worktreeStatus = tracked.worktreePath && fs.existsSync(tracked.worktreePath)
              ? getWorktreeStatus(tracked.worktreePath)
              : { changed_files: [], diff_stat: '' }
            results[taskId] = {
              status: executionStatus(tracked),
              response_text: extractResponseText(tracked.stdout, tracked.provider),
              changed_files: worktreeStatus.changed_files,
              diff_stat: worktreeStatus.diff_stat,
              provider: tracked.provider,
              exit_code: tracked.exitCode,
              duration_ms: executionDuration(tracked),
              stderr_preview: tracked.stderr.length > 2_000
                ? `${tracked.stderr.slice(0, 2_000)}\n...[truncated]`
                : tracked.stderr,
              error: tracked.error,
              worktree_path: tracked.worktreePath,
              prior_attempts: (batch.history.get(taskId) ?? []).map(attempt => ({
                worktree_path: attempt.worktreePath,
                branch_name: attempt.branchName,
              })),
            }
          }
          return JSON.stringify({ batchId: args.batchId, results })
        },
      },

      delegation_redelegate: {
        description: 'Run a failed task in a new uniquely named worktree while preserving every prior attempt.',
        args: {
          taskId: z.string().describe('Task ID to redelegate'),
          feedback: z.string().describe('Review feedback for the task'),
          batchId: z.string().describe('Batch ID containing the task'),
          projectRoot: z.string().optional().describe('Deprecated project root; when supplied it must match ToolContext'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: {
          taskId: string
          feedback: string
          batchId: string
          projectRoot?: string
          sessionId?: string
        }, context: ToolContext) {
          const identity = getInvocationIdentity(context, args.projectRoot, args.sessionId)
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          assertBatchOwner(batch, identity)

          const previous = batch.executions.get(args.taskId)
          const task = batch.tasks.get(args.taskId)
          if (!previous || !task) {
            return JSON.stringify({ error: `Task ${args.taskId} not found in batch ${args.batchId}` })
          }
          if (!previous.completed) {
            return JSON.stringify({ error: `Task ${args.taskId} is still ${previous.phase}` })
          }
          const nextAttempt = task.attempt + 1
          if (nextAttempt > task.max_attempts) {
            return JSON.stringify({
              taskId: args.taskId,
              error: `Max attempts reached (${task.max_attempts})`,
              attempt: task.attempt,
              max_attempts: task.max_attempts,
              status: 'failed',
            })
          }

          const unsafeProviders = await authorizeExternalExecution(
            context,
            batch.workflowId,
            [task.provider],
            config,
          )
          if (batch.abortController.signal.aborted) batch.abortController = new AbortController()
          linkContextAbort(context, batch)

          const worktreeTaskId = makeAttemptTaskId(args.taskId, nextAttempt)
          const tracked = createTrackedExecution(args.taskId, worktreeTaskId, task.provider)
          const history = batch.history.get(args.taskId) ?? []
          history.push(previous)
          batch.history.set(args.taskId, history)
          batch.executions.set(args.taskId, tracked)

          task.attempt = nextAttempt
          task.review_feedback = args.feedback
          task.worktree_name = null
          task.worktree_path = null
          task.branch_name = null
          task.status = 'pending'
          task.updated_at = new Date().toISOString()
          const input: DelegationTaskInput = {
            id: task.id,
            description: task.description,
            tag: task.tag,
            provider: task.provider,
            model: task.model ?? undefined,
            files: [...task.files],
            review_feedback: args.feedback,
          }
          const definition: QueuedExecution = {
            input,
            task,
            tracked,
            projectRoot: batch.projectRoot,
            workflowId: batch.workflowId,
            featureBranch: batch.featureBranch,
            allowUnsafe: unsafeProviders.has(task.provider),
            signal: batch.abortController.signal,
          }
          void processQueue.enqueue(definition, queued => runQueuedExecution(queued, config)).catch(error => {
            completeExecution(tracked, error instanceof Error ? error.message : String(error))
            task.status = 'failed'
          })

          return JSON.stringify({
            taskId: args.taskId,
            attempt: task.attempt,
            max_attempts: task.max_attempts,
            status: tracked.phase,
            provider: task.provider,
            worktree_task_id: worktreeTaskId,
            previous_worktree_preserved: previous.worktreePath,
          })
        },
      },

      delegation_record_review: {
        description: 'Record the owning supervisor review verdict for a successful delegated task before merge.',
        args: {
          taskId: z.string().describe('Reviewed task ID'),
          batchId: z.string().describe('Batch containing the task'),
          passed: z.boolean().describe('Whether review approved the task for merge'),
          feedback: z.string().describe('Concrete review evidence or required corrections'),
        },
        async execute(args: { taskId: string; batchId: string; passed: boolean; feedback: string }, context: ToolContext) {
          const identity = getInvocationIdentity(context)
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          assertBatchOwner(batch, identity)
          const tracked = batch.executions.get(args.taskId)
          const task = batch.tasks.get(args.taskId)
          if (!tracked || !task) return JSON.stringify({ error: `Task ${args.taskId} not found in batch ${args.batchId}` })
          if (!tracked.completed || tracked.exitCode !== 0 || tracked.aborted || tracked.timedOut || tracked.error) {
            return JSON.stringify({ error: `Task ${args.taskId} did not complete successfully and cannot be approved` })
          }
          const feedback = args.feedback.trim()
          if (!feedback) return JSON.stringify({ error: 'Review feedback or evidence is required' })
          task.review_feedback = feedback
          task.status = args.passed ? 'passed' : 'failed'
          task.updated_at = new Date().toISOString()
          return JSON.stringify({ taskId: args.taskId, review: args.passed ? 'passed' : 'failed' })
        },
      },

      delegation_merge_task: {
        description: 'Checkpoint and merge a completed task worktree into the checked-out target branch.',
        args: {
          taskId: z.string().describe('Task ID to merge'),
          targetBranch: z.string().describe('Branch to merge into'),
          batchId: z.string().describe('Batch ID containing the task'),
          projectRoot: z.string().optional().describe('Deprecated project root; when supplied it must match ToolContext'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: {
          taskId: string
          targetBranch: string
          batchId: string
          projectRoot?: string
          sessionId?: string
        }, context: ToolContext) {
          const identity = getInvocationIdentity(context, args.projectRoot, args.sessionId)
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          assertBatchOwner(batch, identity)
          const tracked = batch.executions.get(args.taskId)
          const task = batch.tasks.get(args.taskId)
          if (!tracked) return JSON.stringify({ error: `Task ${args.taskId} not found in batch ${args.batchId}` })
          const mergeError = delegationMergeError({
            completed: tracked.completed,
            exitCode: tracked.exitCode,
            aborted: tracked.aborted,
            timedOut: tracked.timedOut,
            executionError: tracked.error,
            taskStatus: task?.status ?? null,
            targetBranch: args.targetBranch,
            featureBranch: batch.featureBranch,
          })
          if (mergeError) return JSON.stringify({ error: `${mergeError}: ${args.taskId}` })
          if (!tracked.worktreePath || !fs.existsSync(tracked.worktreePath)) {
            return JSON.stringify({ error: `Worktree not found for task ${args.taskId}` })
          }

          await requestPermissions(context, [
            {
              permission: 'edit',
              patterns: ['*'],
              metadata: { batchId: args.batchId, taskId: args.taskId, operation: 'merge' },
            },
            {
              permission: 'worktree',
              patterns: [`merge:${tracked.branchName ?? args.taskId}`],
              metadata: { batchId: args.batchId, taskId: args.taskId },
            },
            {
              permission: CUSTOM_PERMISSION,
              patterns: ['merge'],
              metadata: { batchId: args.batchId, taskId: args.taskId },
            },
          ])

          const result = mergeWorktree(identity.projectRoot, tracked.worktreePath, args.targetBranch)
          if (result.success) {
            if (task) {
              task.status = 'merged'
              task.updated_at = new Date().toISOString()
            }
          }
          return JSON.stringify({
            taskId: args.taskId,
            merged: result.success,
            conflicts: result.conflicts,
            merge_commit: result.merge_commit,
          })
        },
      },

      delegation_cleanup: {
        description: 'Safely remove only clean, merged worktrees owned by one exact in-memory batch.',
        args: {
          batchId: z.string().describe('Exact owned batch to clean up'),
          workflowId: z.string().optional().describe('Optional expected workflow ID for the batch'),
          projectRoot: z.string().optional().describe('Deprecated project root; when supplied it must match ToolContext'),
          sessionId: z.string().optional().describe('Deprecated session ID; when supplied it must match ToolContext'),
        },
        async execute(args: { batchId: string; workflowId?: string; projectRoot?: string; sessionId?: string }, context: ToolContext) {
          const identity = getInvocationIdentity(context, args.projectRoot, args.sessionId)
          const batch = batches.get(args.batchId)
          if (!batch) {
            return JSON.stringify({
              batchId: args.batchId,
              removed: 0,
              error: 'Cleanup requires an in-memory batch owned by the current session; inspect orphaned worktrees manually after restart',
            })
          }
          assertBatchOwner(batch, identity)
          if (args.workflowId && args.workflowId !== batch.workflowId) {
            return JSON.stringify({ batchId: args.batchId, removed: 0, error: 'Workflow ID does not match the owned batch' })
          }
          const incomplete = [...batch.executions.values()].filter(tracked => !tracked.completed).map(tracked => tracked.taskId)
          if (incomplete.length > 0) {
            return JSON.stringify({
              batchId: args.batchId,
              removed: 0,
              error: 'Cleanup refused while delegation tasks are queued or running',
              incomplete_tasks: incomplete,
            })
          }

          await requestPermissions(context, [
            {
              permission: 'edit',
              patterns: ['*'],
              metadata: { batchId: args.batchId, workflowId: batch.workflowId, operation: 'cleanup' },
            },
            {
              permission: 'worktree',
              patterns: [`cleanup:${args.batchId}`],
              metadata: { batchId: args.batchId, workflowId: batch.workflowId },
            },
            {
              permission: CUSTOM_PERMISSION,
              patterns: ['cleanup'],
              metadata: { workflowId: args.workflowId },
            },
          ])

          const current = [...batch.executions.values()]
          const history = [...batch.history.values()].flat()
          const ownedWorktrees = [...new Set([...current, ...history]
            .map(tracked => tracked.worktreePath)
            .filter((worktreePath): worktreePath is string => Boolean(worktreePath && fs.existsSync(worktreePath))))]
          let removed = 0
          for (const worktreePath of ownedWorktrees) {
            if (removeWorktree(identity.projectRoot, worktreePath)) removed++
          }
          const retainedWorktrees = ownedWorktrees.filter(worktreePath => fs.existsSync(worktreePath))
          // Cleanup is intentionally one-shot so stale in-memory paths cannot
          // claim a later worktree that reuses the same deterministic identity.
          batches.delete(batch.batchId)

          return JSON.stringify({
            batchId: args.batchId,
            workflowId: batch.workflowId,
            removed,
            retained_worktrees: [...new Set(retainedWorktrees)],
          })
        },
      },
    },
  }
}

export default DelegationOrchestrator
