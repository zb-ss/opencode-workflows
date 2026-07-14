import fs from 'node:fs'
import path from 'node:path'

import { DrainingQueue } from './draining-queue.ts'
import { log } from './logger.ts'
import { OpenCodeSessionAdapter } from './opencode-session.ts'
import { ensurePrivateDirectory, getRuntimeDir, getSessionRuntimeDir } from './paths.ts'
import type { SwarmTask, SwarmUserConfig } from './types.ts'

const DEFAULT_CONCURRENCY = 4
const DEFAULT_STALE_TIMEOUT_MS = 180_000
const DEFAULT_PROGRESS_TIMEOUT_MS = 600_000
const MIN_STALENESS_TIMEOUT_MS = 60_000
const DEFAULT_AWAIT_TIMEOUT_MS = 300_000
const STORE_FILE = 'swarm-batches.json'

type TaskStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
type TerminalStatus = Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>

interface RuntimeTask extends SwarmTask {
  provider: string
  status: TaskStatus
  sessionId: string
  queuedAt: number
  startedAt?: number
  promptAcceptedAt?: number
  completedAt?: number
  lastProgressAt: number
  progressEvents: number
  error?: string
  result?: string
}

interface RuntimeBatch {
  batchId: string
  callerSessionId: string
  directory: string
  createdAt: number
  restored: boolean
  tasks: RuntimeTask[]
}

interface StoredBatches {
  schemaVersion: 2
  scopeDirectory: string
  callerSessionId: string
  batches: RuntimeBatch[]
}

interface TaskControl {
  promise: Promise<void>
  resolve: () => void
  resolved: boolean
}

interface BatchWaiter {
  resolve: (result: AwaitBatchResult) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export interface SpawnBatchInput {
  batchId: string
  callerSessionId: string
  directory: string
  tasks: SwarmTask[]
  workflowContext?: string
}

export interface SpawnBatchResult {
  batchId: string
  spawned: number
  queued: number
  details: string[]
  queuedTasks: string[]
}

export interface AwaitBatchResult {
  batchId: string
  completed: boolean
  timedOut?: boolean
  results?: Record<string, TaskStatus>
}

export interface CollectBatchResult {
  batchId: string
  results: Record<string, string>
}

export interface CancelTaskResult {
  task_id: string
  cancelled: boolean
  reason?: string
  error?: string
}

export interface RestoredBatchAuthorization {
  directory: string
  tasks: SwarmTask[]
}

export interface SwarmRuntimeOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  restore?: boolean
  scopeDirectory?: string
}

interface QueueItem {
  batchKey: string
  taskId: string
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function providerFromModel(model?: string): string {
  if (!model) return 'unknown'
  const separator = model.indexOf('/')
  return separator > 0 ? model.slice(0, separator) : 'unknown'
}

function terminal(status: TaskStatus): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === 'string') return data.message
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function taskKey(batchKey: string, taskId: string): string {
  return `${batchKey}\u0000${taskId}`
}

function batchKey(callerSessionId: string, batchId: string): string {
  return `${callerSessionId}\u0000${batchId}`
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export class SwarmRuntime {
  private readonly batches = new Map<string, RuntimeBatch>()
  private readonly controls = new Map<string, TaskControl>()
  private readonly scheduled = new Set<string>()
  private readonly sessionTasks = new Map<string, { batchKey: string; taskId: string }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly waiters = new Map<string, Set<BatchWaiter>>()
  private readonly reconciled = new Set<string>()
  private readonly adapters = new Map<string, OpenCodeSessionAdapter>()
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly queue: DrainingQueue<QueueItem, void>
  private readonly staleTimeoutMs: number
  private readonly progressTimeoutMs: number
  private readonly scopeDirectory: string | null
  private disposed = false

  constructor(
    private readonly client: any,
    config: SwarmUserConfig = {},
    options: SwarmRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.scopeDirectory = options.scopeDirectory ? path.resolve(options.scopeDirectory) : null
    const globalLimit = positiveInteger(config.default_concurrency, DEFAULT_CONCURRENCY)
    const providerLimits = Object.fromEntries(
      Object.entries(config.provider_concurrency ?? {})
        .filter(([, value]) => Number.isInteger(value) && value > 0),
    )
    this.queue = new DrainingQueue(globalLimit, providerLimits)
    this.staleTimeoutMs = Math.max(MIN_STALENESS_TIMEOUT_MS, positiveInteger(config.stale_timeout_ms, DEFAULT_STALE_TIMEOUT_MS))
    this.progressTimeoutMs = Math.max(MIN_STALENESS_TIMEOUT_MS, positiveInteger(config.progress_timeout_ms, DEFAULT_PROGRESS_TIMEOUT_MS))

    if (options.restore !== false) this.restoreBatches()
  }

  spawnBatch(input: SpawnBatchInput): SpawnBatchResult {
    this.assertActive()
    const key = batchKey(input.callerSessionId, input.batchId)
    if (this.batches.has(key)) {
      throw new Error(`Batch ${input.batchId} already exists for this session`)
    }
    const ids = new Set<string>()
    for (const task of input.tasks) {
      if (ids.has(task.id)) throw new Error(`Duplicate task ID in batch ${input.batchId}: ${task.id}`)
      ids.add(task.id)
    }

    const now = this.now()
    const context = input.workflowContext ?? ''
    const batch: RuntimeBatch = {
      batchId: input.batchId,
      callerSessionId: input.callerSessionId,
      directory: input.directory,
      createdAt: now,
      restored: false,
      tasks: input.tasks.map((task) => ({
        ...task,
        prompt: context + task.prompt,
        provider: providerFromModel(task.model),
        status: 'queued',
        sessionId: '',
        queuedAt: now,
        lastProgressAt: now,
        progressEvents: 0,
      })),
    }

    this.batches.set(key, batch)
    try {
      this.persistCaller(input.callerSessionId)
    } catch (error) {
      this.batches.delete(key)
      throw error
    }
    for (const task of batch.tasks) this.enqueueTask(key, task)

    const queuedTasks = batch.tasks.filter((task) => task.status === 'queued').map((task) => task.id)
    const admitted = batch.tasks.filter((task) => task.status !== 'queued')
    return {
      batchId: batch.batchId,
      spawned: admitted.length,
      queued: queuedTasks.length,
      details: admitted.map((task) => `Starting ${task.id} (${task.agent})`),
      queuedTasks,
    }
  }

  async awaitBatch(
    callerSessionId: string,
    requestedBatchId: string,
    timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<AwaitBatchResult> {
    this.assertActive()
    const key = batchKey(callerSessionId, requestedBatchId)
    const batch = this.batches.get(key)
    if (!batch) throw new Error(`Batch ${requestedBatchId} not found`)
    if (signal?.aborted) throw abortError()

    if (!this.reconciled.has(key)) {
      this.reconciled.add(key)
      await this.reconcile(batch, key)
    }
    if (this.isBatchComplete(batch)) return this.completedResult(batch)

    return new Promise<AwaitBatchResult>((resolve, reject) => {
      const waiter: BatchWaiter = {
        resolve,
        signal,
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter)
          resolve({ batchId: requestedBatchId, completed: false, timedOut: true })
        }, positiveInteger(timeoutMs, DEFAULT_AWAIT_TIMEOUT_MS)),
      }
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(key, waiter)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      const batchWaiters = this.waiters.get(key) ?? new Set<BatchWaiter>()
      batchWaiters.add(waiter)
      this.waiters.set(key, batchWaiters)

      if (this.isBatchComplete(batch)) {
        this.removeWaiter(key, waiter)
        resolve(this.completedResult(batch))
      }
    })
  }

  restoredBatchAuthorization(callerSessionId: string, requestedBatchId: string): RestoredBatchAuthorization | null {
    const batch = this.batches.get(batchKey(callerSessionId, requestedBatchId))
    if (!batch?.restored) return null
    return {
      directory: batch.directory,
      tasks: batch.tasks.filter((task) => !terminal(task.status)).map((task) => ({
        id: task.id,
        agent: task.agent,
        prompt: task.prompt,
        ...(task.model ? { model: task.model } : {}),
      })),
    }
  }

  resumeRestoredBatch(callerSessionId: string, requestedBatchId: string): boolean {
    const key = batchKey(callerSessionId, requestedBatchId)
    const batch = this.batches.get(key)
    if (!batch?.restored) return false
    batch.restored = false
    this.persistCaller(callerSessionId)
    for (const task of batch.tasks.filter((candidate) => candidate.status === 'running' || candidate.status === 'starting')) {
      this.enqueueTask(key, task)
    }
    for (const task of batch.tasks.filter((candidate) => candidate.status === 'queued')) this.enqueueTask(key, task)
    return true
  }

  async collectResults(callerSessionId: string, requestedBatchId: string): Promise<CollectBatchResult> {
    this.assertActive()
    const batch = this.batches.get(batchKey(callerSessionId, requestedBatchId))
    if (!batch) throw new Error(`Batch ${requestedBatchId} not found`)
    const adapter = this.adapter(batch.directory)
    const results: Record<string, string> = {}

    for (const task of batch.tasks) {
      if (!task.sessionId) {
        results[task.id] = task.error ?? (task.status === 'cancelled' ? 'Cancelled before spawn' : 'Failed to spawn')
        continue
      }
      try {
        const output = await adapter.lastAssistantText(task.sessionId)
        task.result = output || 'No output'
        results[task.id] = task.result
      } catch (error) {
        results[task.id] = `Error retrieving: ${errorText(error)}`
      }
    }
    this.persistCaller(callerSessionId)
    return { batchId: requestedBatchId, results }
  }

  async cancelTask(callerSessionId: string, requestedBatchId: string, taskId: string): Promise<CancelTaskResult> {
    this.assertActive()
    const key = batchKey(callerSessionId, requestedBatchId)
    const batch = this.batches.get(key)
    if (!batch) throw new Error(`Batch ${requestedBatchId} not found`)
    const task = batch.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error(`Task ${taskId} not found in batch ${requestedBatchId}`)
    if (terminal(task.status)) {
      return { task_id: taskId, cancelled: false, reason: `Task is already in terminal state: ${task.status}` }
    }

    if (task.sessionId) {
      try {
        await this.adapter(batch.directory).abort(task.sessionId)
      } catch (error) {
        return { task_id: taskId, cancelled: false, error: errorText(error) }
      }
      if (terminal(task.status)) {
        return { task_id: taskId, cancelled: false, reason: `Task reached terminal state: ${task.status}` }
      }
    }

    this.finalize(key, task, 'cancelled', 'Cancelled by caller')
    return {
      task_id: taskId,
      cancelled: true,
      ...(task.sessionId ? {} : { reason: 'No session ID; marked cancelled' }),
    }
  }

  async handleEvent(event: unknown): Promise<void> {
    if (this.disposed || !event || typeof event !== 'object') return
    const input = event as { type?: string; properties?: any }
    const properties = input.properties

    if (input.type === 'session.status') {
      const tracked = this.trackedTask(properties?.sessionID)
      if (!tracked) return
      if (properties?.status?.type === 'idle' && tracked.task.promptAcceptedAt) {
        this.finalize(tracked.batchKey, tracked.task, 'completed')
      } else if (properties?.status?.type === 'busy' || properties?.status?.type === 'retry') {
        this.touch(tracked.batchKey, tracked.task, false)
      }
      return
    }

    if (input.type === 'session.idle') {
      const tracked = this.trackedTask(properties?.sessionID)
      if (tracked?.task.promptAcceptedAt) this.finalize(tracked.batchKey, tracked.task, 'completed')
      return
    }

    if (input.type === 'session.error') {
      const tracked = this.trackedTask(properties?.sessionID)
      if (tracked) this.finalize(tracked.batchKey, tracked.task, 'failed', errorText(properties?.error ?? 'Session error'))
      return
    }

    if (input.type === 'message.updated') {
      const tracked = this.trackedTask(properties?.info?.sessionID)
      if (tracked) this.touch(tracked.batchKey, tracked.task, true)
      return
    }

    if (input.type === 'message.part.updated') {
      const tracked = this.trackedTask(properties?.part?.sessionID)
      if (tracked) this.touch(tracked.batchKey, tracked.task, true)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const [key, batchWaiters] of this.waiters) {
      for (const waiter of batchWaiters) {
        this.removeWaiter(key, waiter)
        waiter.resolve({ batchId: this.batches.get(key)?.batchId ?? '', completed: false, timedOut: true })
      }
    }
    this.waiters.clear()
    for (const control of this.controls.values()) {
      if (control.resolved) continue
      control.resolved = true
      control.resolve()
    }
    this.sessionTasks.clear()
    this.adapters.clear()
  }

  private enqueueTask(key: string, task: RuntimeTask): void {
    const controlKey = taskKey(key, task.id)
    if (terminal(task.status) || this.scheduled.has(controlKey)) return
    this.control(controlKey)
    this.scheduled.add(controlKey)
    void this.queue.enqueue({ batchKey: key, taskId: task.id }, task.provider, async (item) => {
      await this.runTask(item.batchKey, item.taskId)
    }).catch((error) => {
      const current = this.task(key, task.id)
      if (current && !terminal(current.status)) this.finalize(key, current, 'failed', errorText(error))
    }).finally(() => {
      this.scheduled.delete(controlKey)
    })
  }

  private async runTask(key: string, taskId: string): Promise<void> {
    const batch = this.batches.get(key)
    const task = this.task(key, taskId)
    if (!batch || !task || terminal(task.status) || this.disposed) return
    const control = this.control(taskKey(key, task.id))

    if (task.status === 'running' && task.sessionId) {
      this.scheduleStaleness(key, task)
      await control.promise
      return
    }

    const adapter = this.adapter(batch.directory)

    try {
      if (!task.sessionId) {
        task.status = 'starting'
        task.startedAt = this.now()
        task.lastProgressAt = task.startedAt
        this.persistCaller(batch.callerSessionId)

        const session = await adapter.create(`[${batch.batchId}] ${task.agent}: ${task.id}`, batch.callerSessionId)
        task.sessionId = session.id
        this.sessionTasks.set(session.id, { batchKey: key, taskId: task.id })
        this.persistCaller(batch.callerSessionId)
      }

      if (terminal(task.status) || this.disposed) {
        await adapter.abort(task.sessionId).catch(() => undefined)
        if (this.disposed && !terminal(task.status)) {
          this.sessionTasks.delete(task.sessionId)
          task.sessionId = ''
          task.status = 'queued'
          this.persistSafely(batch.callerSessionId)
        }
        return
      }

      task.status = 'running'
      task.promptAcceptedAt = this.now()
      task.lastProgressAt = task.promptAcceptedAt
      this.persistCaller(batch.callerSessionId)
      await adapter.promptAsync(task.sessionId, task.prompt, {
        agent: task.agent,
        ...(task.model ? { model: { model: task.model } } : {}),
      })
      if (!terminal(task.status)) {
        this.scheduleStaleness(key, task)
      }
      await control.promise
    } catch (error) {
      if (!terminal(task.status)) this.finalize(key, task, 'failed', errorText(error))
      if (task.sessionId) await adapter.abort(task.sessionId).catch(() => undefined)
    }
  }

  private trackedTask(sessionId: unknown): { batchKey: string; task: RuntimeTask } | null {
    if (typeof sessionId !== 'string') return null
    const tracked = this.sessionTasks.get(sessionId)
    if (!tracked) return null
    const task = this.task(tracked.batchKey, tracked.taskId)
    return task ? { batchKey: tracked.batchKey, task } : null
  }

  private task(key: string, taskId: string): RuntimeTask | undefined {
    return this.batches.get(key)?.tasks.find((task) => task.id === taskId)
  }

  private touch(key: string, task: RuntimeTask, madeProgress: boolean): void {
    if (terminal(task.status)) return
    task.lastProgressAt = this.now()
    if (madeProgress) task.progressEvents++
    if (task.status === 'running' && task.promptAcceptedAt) this.scheduleStaleness(key, task)
    const batch = this.batches.get(key)
    if (batch) this.persistSafely(batch.callerSessionId)
  }

  private finalize(key: string, task: RuntimeTask, status: TerminalStatus, error?: string): boolean {
    if (terminal(task.status)) return false
    task.status = status
    task.completedAt = this.now()
    if (error) task.error = error
    const controlKey = taskKey(key, task.id)
    const timer = this.timers.get(controlKey)
    if (timer) clearTimeout(timer)
    this.timers.delete(controlKey)
    if (task.sessionId) this.sessionTasks.delete(task.sessionId)

    const batch = this.batches.get(key)
    if (batch) this.persistSafely(batch.callerSessionId)
    const control = this.controls.get(controlKey)
    if (control && !control.resolved) {
      control.resolved = true
      control.resolve()
    }
    if (batch) this.notifyBatch(key, batch)
    return true
  }

  private scheduleStaleness(key: string, task: RuntimeTask): void {
    const controlKey = taskKey(key, task.id)
    const current = this.timers.get(controlKey)
    if (current) clearTimeout(current)
    if (terminal(task.status) || this.disposed) return

    const timeout = task.progressEvents === 0 ? this.staleTimeoutMs : this.progressTimeoutMs
    const elapsed = Math.max(0, this.now() - task.lastProgressAt)
    const timer = setTimeout(() => {
      const latest = this.task(key, task.id)
      if (!latest || terminal(latest.status) || this.disposed) return
      const expectedTimeout = latest.progressEvents === 0 ? this.staleTimeoutMs : this.progressTimeoutMs
      if (this.now() - latest.lastProgressAt < expectedTimeout) {
        this.scheduleStaleness(key, latest)
        return
      }
      const reason = latest.progressEvents === 0 ? 'stale' : 'stuck'
      this.finalize(key, latest, 'failed', `Session became ${reason}`)
      const batch = this.batches.get(key)
      if (batch && latest.sessionId) {
        void this.adapter(batch.directory).abort(latest.sessionId).catch((error) => {
          log('swarm', `Failed to abort ${reason} session ${latest.sessionId}: ${errorText(error)}`)
        })
      }
    }, Math.max(1, timeout - elapsed))
    timer.unref?.()
    this.timers.set(controlKey, timer)
  }

  private async reconcile(batch: RuntimeBatch, key: string): Promise<void> {
    let statuses: Awaited<ReturnType<OpenCodeSessionAdapter['statuses']>>
    try {
      statuses = await this.adapter(batch.directory).statuses()
    } catch (error) {
      log('swarm', `One-time status reconciliation failed for batch ${batch.batchId}: ${errorText(error)}`)
      return
    }
    for (const task of batch.tasks) {
      if (task.status !== 'running' || !task.sessionId || !task.promptAcceptedAt) continue
      if (statuses[task.sessionId]?.type === 'idle') this.finalize(key, task, 'completed')
    }
  }

  private control(key: string): TaskControl {
    const existing = this.controls.get(key)
    if (existing) return existing
    let resolve: () => void = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    const control = { promise, resolve, resolved: false }
    this.controls.set(key, control)
    return control
  }

  private isBatchComplete(batch: RuntimeBatch): boolean {
    return batch.tasks.every((task) => terminal(task.status))
  }

  private completedResult(batch: RuntimeBatch): AwaitBatchResult {
    return {
      batchId: batch.batchId,
      completed: true,
      results: Object.fromEntries(batch.tasks.map((task) => [task.id, task.status])),
    }
  }

  private notifyBatch(key: string, batch: RuntimeBatch): void {
    if (!this.isBatchComplete(batch)) return
    for (const waiter of [...(this.waiters.get(key) ?? [])]) {
      this.removeWaiter(key, waiter)
      waiter.resolve(this.completedResult(batch))
    }
  }

  private removeWaiter(key: string, waiter: BatchWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    const batchWaiters = this.waiters.get(key)
    batchWaiters?.delete(waiter)
    if (batchWaiters?.size === 0) this.waiters.delete(key)
  }

  private adapter(directory: string): OpenCodeSessionAdapter {
    const existing = this.adapters.get(directory)
    if (existing) return existing
    const adapter = new OpenCodeSessionAdapter(this.client, directory)
    this.adapters.set(directory, adapter)
    return adapter
  }

  private persistCaller(callerSessionId: string): void {
    const directory = ensurePrivateDirectory(getSessionRuntimeDir(callerSessionId, this.env))
    const target = path.join(directory, STORE_FILE)
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    const callerBatches = [...this.batches.values()].filter((batch) => batch.callerSessionId === callerSessionId)
    const document: StoredBatches = {
      schemaVersion: 2,
      scopeDirectory: this.scopeDirectory ?? path.resolve(callerBatches[0]?.directory ?? process.cwd()),
      callerSessionId,
      batches: callerBatches,
    }
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, target)
      try { fs.chmodSync(target, 0o600) } catch {}
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch {}
      throw error
    }
  }

  private persistSafely(callerSessionId: string): void {
    try {
      this.persistCaller(callerSessionId)
    } catch (error) {
      log('swarm', `Failed to persist runtime state for session ${callerSessionId}: ${errorText(error)}`)
    }
  }

  private restoreBatches(): void {
    if (!this.scopeDirectory) return
    const sessionsDirectory = path.join(getRuntimeDir(this.env), 'sessions')
    if (!fs.existsSync(sessionsDirectory)) return
    const restored: Array<{ key: string; batch: RuntimeBatch }> = []

    for (const entry of fs.readdirSync(sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const storePath = path.join(sessionsDirectory, entry.name, STORE_FILE)
      try {
        const document = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<StoredBatches>
        if (document.schemaVersion !== 2
          || path.resolve(String(document.scopeDirectory || '')) !== this.scopeDirectory
          || typeof document.callerSessionId !== 'string'
          || !Array.isArray(document.batches)) continue
        if (path.dirname(storePath) !== getSessionRuntimeDir(document.callerSessionId, this.env)) continue
        for (const candidate of document.batches) {
          if (!this.validBatch(candidate, document.callerSessionId)) continue
          candidate.restored = true
          for (const task of candidate.tasks) {
            if (task.status === 'starting' && !task.sessionId) task.status = 'queued'
            if ((task.status === 'starting' || task.status === 'running') && task.sessionId) {
              this.sessionTasks.set(task.sessionId, {
                batchKey: batchKey(candidate.callerSessionId, candidate.batchId),
                taskId: task.id,
              })
            }
          }
          const key = batchKey(candidate.callerSessionId, candidate.batchId)
          if (!this.batches.has(key)) {
            this.batches.set(key, candidate)
            restored.push({ key, batch: candidate })
          }
        }
      } catch {
        // Ignore malformed or partially-written runtime state.
      }
    }

    restored.sort((left, right) => left.batch.createdAt - right.batch.createdAt)
  }

  private validBatch(candidate: unknown, callerSessionId: string): candidate is RuntimeBatch {
    if (!candidate || typeof candidate !== 'object') return false
    const batch = candidate as RuntimeBatch
    if (batch.callerSessionId !== callerSessionId || typeof batch.batchId !== 'string' || typeof batch.directory !== 'string') return false
    if (!Number.isFinite(batch.createdAt) || !Array.isArray(batch.tasks)) return false
    return batch.tasks.every((task) =>
      task && typeof task.id === 'string' && typeof task.agent === 'string' && typeof task.prompt === 'string'
      && typeof task.provider === 'string'
      && ['queued', 'starting', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)
      && typeof task.sessionId === 'string',
    )
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Swarm runtime has been disposed')
  }
}
