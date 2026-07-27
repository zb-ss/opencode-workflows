import { tool, type Plugin, type PluginInput, type ToolContext } from '@opencode-ai/plugin'
import { createOpencodeClient as createOpencodeClientV2 } from '@opencode-ai/sdk/v2/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { QueueStore, QueueStoreError } from '../lib/queue-store.ts'
import { QueueScheduler, type QueueRecoveryResult } from '../lib/queue-scheduler.ts'
import { enabledQueue, type EnabledQueueConfig } from '../lib/queue-policy.ts'
import { loadWorkflowConfig, modelCandidatesForAgent, validationOperationNames } from '../lib/workflow-config.ts'
import { loadWorkflowDefinition, WorkflowEngine } from '../lib/workflow-engine.ts'
import { OpenCodeSessionAdapter } from '../lib/opencode-session.ts'
import { isPathInside } from '../lib/paths.ts'
import { getConfigDir } from '../lib/paths.ts'
import { MAX_SAFE_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_PATTERN, SafeIdentifierSchema } from '../lib/safe-identifier.ts'
import { sha256Hex } from '../lib/canonical-json.ts'
import { throwIfAborted } from '../lib/tool-context.ts'
import type { FencingLeaseHandle } from '../lib/fencing-lease.ts'

const MAX_REASON_LENGTH = 4096
const MAX_TASK_LENGTH = 20000

class QueueInputError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'QueueInputError'; this.code = code }
}

class QueueMissingError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'QueueMissingError'; this.code = code }
}

function trustedProjectRoot(context: ToolContext): string {
  try {
    const projectRoot = fs.realpathSync(context.worktree)
    const directory = fs.realpathSync(context.directory)
    if (!isPathInside(projectRoot, directory)) throw new Error('outside worktree')
    return projectRoot
  } catch {
    throw new QueueInputError('invalid_context', 'tool context does not identify a valid project worktree')
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function assertRootSession(client: PluginInput['client'], context: ToolContext): Promise<void> {
  throwIfAborted(context)
  const sessions = (client as unknown as { session?: unknown }).session as {
    get?: (input: { path: { id: string }; query: { directory: string }; throwOnError: true }) => Promise<unknown>
  } | undefined
  if (typeof sessions?.get !== 'function') {
    throw new QueueInputError('unverifiable', 'unable to verify that the current session is a root session')
  }
  try {
    const result = await sessions.get({
      path: { id: context.sessionID },
      query: { directory: context.directory },
      throwOnError: true,
    })
    const envelope = record(result)
    const info = record(envelope?.data) ?? envelope
    if (!info || info.id !== context.sessionID) throw new Error('session identity mismatch')
    if (info.parentID) throw new QueueInputError('not_root', 'queue tools are restricted to root sessions')
  } catch (error) {
    if (error instanceof QueueInputError) throw error
    throw new QueueInputError('unverifiable', 'unable to verify that the current session is a root session')
  }
  throwIfAborted(context)
}

function projectScopedQueueDirectory(projectRoot: string): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'opencode')
  const projectHash = sha256Hex(projectRoot)
  return path.join(configDir, 'workflows', 'runtime', 'queue', projectHash)
}

function enginePaths(queueDirectory: string, workflowId: string): { directory: string; statePath: string; definitionPath: string } {
  const directory = path.join(queueDirectory, 'engines', sha256Hex(workflowId))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    directory,
    statePath: path.join(directory, 'workflow-auto.state.json'),
    definitionPath: path.join(directory, 'workflow-auto.definition.json'),
  }
}

function loadModeRouting(mode: string): Record<string, string> {
  const modePath = path.join(getConfigDir(), 'mode', `${mode}.json`)
  const input = JSON.parse(fs.readFileSync(modePath, 'utf8')) as { agent_routing?: unknown }
  if (!input.agent_routing || typeof input.agent_routing !== 'object' || Array.isArray(input.agent_routing)) {
    throw new Error(`mode ${mode} does not define agent_routing`)
  }
  const routing: Record<string, string> = {}
  for (const [role, agent] of Object.entries(input.agent_routing)) {
    if (typeof agent !== 'string' || !agent) throw new Error(`mode ${mode} has an invalid route for ${role}`)
    routing[role] = agent
  }
  return routing
}

function eventSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const input = event as { type?: string; properties?: any }
  if (input.type === 'message.updated') return input.properties?.info?.sessionID ?? null
  if (input.type === 'message.part.updated') return input.properties?.part?.sessionID ?? null
  return input.properties?.sessionID ?? null
}

export async function createQueueOwnerTools(input: PluginInput) {
  const { client, directory: pluginDirectory, serverUrl } = input
  const instances = new Map<string, { store: QueueStore; scheduler: QueueScheduler }>()
  const engines = new Map<string, { engine: WorkflowEngine; leaseHandle: FencingLeaseHandle; store: QueueStore }>()
  const autonomyClient = createOpencodeClientV2({ baseUrl: serverUrl.toString(), directory: pluginDirectory })

  const instanceKey = (session: string, project: string) => `${session}\0${project}`

  function getOrCreate(context: ToolContext, projectRoot: string, queueConfig: EnabledQueueConfig): { store: QueueStore; scheduler: QueueScheduler } {
    const key = instanceKey(context.sessionID, projectRoot)
    const existing = instances.get(key)
    if (existing) return existing
    const dir = projectScopedQueueDirectory(projectRoot)
    const store = new QueueStore({
      config_directory: dir,
      owner: context.sessionID,
      now: Date.now,
      lease_duration_ms: queueConfig.lease_duration_ms,
      max_workflows: 256,
      budgets: queueConfig.budgets,
      retry_policy: queueConfig.retry_policy,
      recovery_attempt_limit: queueConfig.recovery_attempt_limit,
    })
    const scheduler = new QueueScheduler({
      store,
      config: queueConfig,
      now: Date.now,
      onWorkflowReady: (workflowId, leaseHandle) => {
        void dispatchWorkflow(workflowId, leaseHandle, store, projectRoot, context.sessionID)
      },
    })
    instances.set(key, { store, scheduler })
    return { store, scheduler }
  }

  async function dispatchWorkflow(
    workflowId: string,
    leaseHandle: FencingLeaseHandle,
    store: QueueStore,
    projectRoot: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const loaded = store.load(workflowId)
      if (!loaded || loaded.status !== 'leased') return
      const config = loadWorkflowConfig()
      if (!config.automation.enabled) return
      const sourcePath = path.join(getConfigDir(), 'workflow', `${loaded.definition_id}.json`)
      if (!fs.existsSync(sourcePath)) return
      const definition = loadWorkflowDefinition(sourcePath)
      const paths = enginePaths(store.getConfigDirectory(), workflowId)
      fs.copyFileSync(sourcePath, paths.definitionPath)
      const adapter = new OpenCodeSessionAdapter(client, projectRoot, autonomyClient)
      const engine = new WorkflowEngine({
        adapter,
        definition,
        statePath: paths.statePath,
        definitionPath: paths.definitionPath,
        modeRouting: loadModeRouting(loaded.mode),
        modelCandidates: (agent, tier) => modelCandidatesForAgent(config, agent, tier),
        limits: {
          max_sessions: config.automation.max_sessions!,
          max_parallel_sessions: config.automation.max_parallel_sessions!,
          max_attempts_per_stage: config.automation.max_attempts_per_stage!,
          max_active_time_ms: config.automation.max_active_time_ms ?? null,
          max_calendar_age_ms: config.automation.max_calendar_age_ms ?? null,
          max_input_tokens: config.automation.max_input_tokens ?? null,
          max_output_tokens: config.automation.max_output_tokens ?? null,
          max_bounded_read_bytes: config.automation.max_bounded_read_bytes ?? null,
          max_bounded_write_bytes: config.automation.max_bounded_write_bytes ?? null,
          max_validation_runs: config.validation_broker.enabled
            ? validationOperationNames(config.validation_broker).length
            : null,
          max_cost_usd: config.automation.max_cost_usd ?? null,
        },
        validationOperations: validationOperationNames(config.validation_broker),
        autonomy: config.automation.autonomy,
      })
      engines.set(workflowId, { engine, leaseHandle, store })
      // Transition launch intent to created before starting the engine.
      try {
        store.update(workflowId, loaded.state_revision, leaseHandle, (record) => {
          if (record.launch_intent !== null) {
            record.launch_intent = { ...record.launch_intent, launch_state: 'created' }
          }
          return record
        })
      } catch {
        // Best-effort state transition; the engine is still dispatched.
      }
      await engine.start({
        workflowId: loaded.workflow_id,
        rootSessionId: sessionId,
        directory: projectRoot,
        worktree: projectRoot,
        mode: loaded.mode,
        task: loaded.task,
      })
      // Transition launch intent to prompted after the engine has started.
      try {
        const current = store.load(workflowId)
        if (current) {
          store.update(workflowId, current.state_revision, leaseHandle, (record) => {
            if (record.launch_intent !== null) {
              record.launch_intent = { ...record.launch_intent, launch_state: 'prompted' }
            }
            return record
          })
        }
      } catch {
        // Best-effort state transition.
      }
    } catch (error) {
      // Dispatch failure is recorded by the engine state; the scheduler will
      // observe the record as leased with a non-terminal intent until recovery.
      // Fire-and-forget: do not throw back into the scheduler.
    }
  }

  function settleWorkflowRecord(workflowId: string, engine: WorkflowEngine, leaseHandle: FencingLeaseHandle, store: QueueStore): void {
    if (!leaseHandle.is_valid()) return
    try {
      const state = engine.snapshot()
      if (!['completed', 'failed', 'cancelled'].includes(state.status)) return
      const record = store.load(workflowId)
      if (!record || !['leased', 'recovering', 'running'].includes(record.status)) return
      store.update(workflowId, record.state_revision, leaseHandle, (next) => {
        next.status = state.status as 'completed' | 'failed' | 'cancelled'
        next.pause_reason = state.pause_reason
        if (next.launch_intent !== null) {
          next.launch_intent = { ...next.launch_intent, launch_state: 'settled', settled_at: new Date(Date.now()).toISOString() }
        }
        return next
      })
    } catch {
      // Best-effort settlement.
    }
  }

  async function ownerContext(context: ToolContext): Promise<string> {
    await assertRootSession(client, context)
    return trustedProjectRoot(context)
  }

  function assertOwnership(record: { root_session_id: string; directory: string }, context: ToolContext, projectRoot: string): void {
    if (record.root_session_id !== context.sessionID) {
      throw new QueueInputError('not_owner', 'workflow does not belong to this root session')
    }
    if (record.directory !== projectRoot) {
      throw new QueueInputError('wrong_project', 'workflow does not belong to this project')
    }
  }

  function assertExpected(record: { state_revision: number; fencing_generation: number }, expectedRevision: number, expectedGeneration: number): void {
    if (record.state_revision !== expectedRevision || record.fencing_generation !== expectedGeneration) {
      throw new QueueInputError('stale', 'expected revision or fencing generation is stale')
    }
  }

  async function operationAsk(context: ToolContext, permission: string, metadata: Record<string, unknown> = {}): Promise<void> {
    throwIfAborted(context)
    await context.ask({ permission, patterns: ['*'], always: [], metadata })
    throwIfAborted(context)
  }

  function settleEngineForSession(sessionId: string): void {
    for (const [workflowId, { engine, leaseHandle, store }] of engines.entries()) {
      if (engine.ownsSession(sessionId)) {
        settleWorkflowRecord(workflowId, engine, leaseHandle, store)
        return
      }
    }
  }

  const identifier = () => tool.schema.string().min(1).max(MAX_SAFE_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER_PATTERN)
  const casArgs = {
    workflow_id: identifier(),
    expected_revision: tool.schema.number().int().positive(),
    expected_generation: tool.schema.number().int().positive(),
  }

  return {
    event: async ({ event }: { event: unknown }) => {
      const sessionId = eventSessionId(event)
      if (!sessionId) return
      for (const [workflowId, { engine, leaseHandle, store }] of engines.entries()) {
        if (!engine.ownsSession(sessionId)) continue
        await engine.handleEvent(event)
        settleWorkflowRecord(workflowId, engine, leaseHandle, store)
        return
      }
    },

    tool: {
      queue_enqueue: tool({
        description: 'Enqueue a new workflow into the durable queue after explicit root authorization.',
        args: {
          workflow_id: identifier(),
          definition_id: identifier(),
          base_branch: tool.schema.string().min(1).max(MAX_REASON_LENGTH),
          task: tool.schema.string().min(1).max(MAX_TASK_LENGTH),
        },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ enqueued: false, disabled: true })
          const projectRoot = await ownerContext(context)
          await operationAsk(context, 'queue_enqueue', { workflow_id: args.workflow_id })
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const handle = scheduler.start()
          const wfRecord = store.enqueue({
            workflow_id: args.workflow_id,
            definition_id: args.definition_id,
            root_session_id: context.sessionID,
            directory: projectRoot,
            worktree: projectRoot,
            mode: config.default_mode,
            task: args.task,
          }, handle.lease)
          scheduler.schedule()
          return JSON.stringify({ enqueued: true, workflow: { workflow_id: wfRecord.workflow_id, status: wfRecord.status, revision: wfRecord.state_revision, generation: wfRecord.fencing_generation } })
        },
      }),
      queue_status: tool({
        description: 'Return the overall durable queue status without exposing sensitive details.',
        args: {},
        execute: async (_args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const index = store.rebuildIndex()
          const leaseStore = store.getLeaseStore()
          const counts = { queued: 0, leased: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, recovering: 0 }
          for (const entry of index) {
            if (entry.status in counts) counts[entry.status as keyof typeof counts]++
          }
          return JSON.stringify({
            lease_held: leaseStore.isHeld(),
            fencing_generation: leaseStore.currentGeneration(),
            workflow_count: index.length,
            counts,
          })
        },
      }),
      queue_workflow_status: tool({
        description: 'Return the status of one queued workflow by ID.',
        args: { workflow_id: identifier() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store } = getOrCreate(context, projectRoot, queueConfig)
          const wfRecord = store.load(args.workflow_id)
          if (!wfRecord) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(wfRecord, context, projectRoot)
          return JSON.stringify({
            workflow_id: wfRecord.workflow_id,
            status: wfRecord.status,
            revision: wfRecord.state_revision,
            generation: wfRecord.fencing_generation,
            launch_state: wfRecord.launch_intent?.launch_state ?? null,
            failure_classification: wfRecord.failure_classification,
            pause_reason: wfRecord.pause_reason,
          })
        },
      }),
      queue_pause: tool({
        description: 'Pause a queued workflow with exact CAS evidence.',
        args: { ...casArgs, reason: tool.schema.string().min(1).max(MAX_REASON_LENGTH) },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, updated: false })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          await operationAsk(context, 'queue_pause', { workflow_id: args.workflow_id })
          const handle = scheduler.start()
          const updated = store.update(args.workflow_id, args.expected_revision, handle.lease, (wfRecord) => {
            wfRecord.status = 'paused'
            wfRecord.pause_reason = args.reason
            return wfRecord
          })
          return JSON.stringify({ updated: true, workflow: { workflow_id: updated.workflow_id, status: updated.status, revision: updated.state_revision } })
        },
      }),
      queue_resume: tool({
        description: 'Resume a paused workflow back to queued with exact CAS evidence.',
        args: { ...casArgs },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, updated: false })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          await operationAsk(context, 'queue_resume', { workflow_id: args.workflow_id })
          const handle = scheduler.start()
          const updated = store.applyRetryPolicy(args.workflow_id, args.expected_revision, handle.lease)
          scheduler.schedule()
          return JSON.stringify({ updated: true, workflow: { workflow_id: updated.workflow_id, status: updated.status, revision: updated.state_revision } })
        },
      }),
      queue_cancel: tool({
        description: 'Cancel a queued workflow with exact CAS evidence.',
        args: { ...casArgs, reason: tool.schema.string().min(1).max(MAX_REASON_LENGTH) },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, updated: false })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          await operationAsk(context, 'queue_cancel', { workflow_id: args.workflow_id })
          const handle = scheduler.start()
          const updated = store.update(args.workflow_id, args.expected_revision, handle.lease, (wfRecord) => {
            wfRecord.status = 'cancelled'
            wfRecord.pause_reason = args.reason
            return wfRecord
          })
          return JSON.stringify({ updated: true, workflow: { workflow_id: updated.workflow_id, status: updated.status, revision: updated.state_revision } })
        },
      }),
      queue_recover: tool({
        description: 'Trigger attended recovery with former-runtime termination confirmation.',
        args: { former_runtime_terminated: tool.schema.boolean() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, recovered: false })
          if (!args.former_runtime_terminated) {
            throw new QueueInputError('confirmation_required', 'recovery requires explicit confirmation that the former runtime has terminated')
          }
          const projectRoot = await ownerContext(context)
          await operationAsk(context, 'queue_recover', { former_runtime_terminated: args.former_runtime_terminated })
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const handle = scheduler.hasLease ? scheduler.start() : scheduler.start()
          const result: QueueRecoveryResult = await scheduler.recover()
          return JSON.stringify({ recovered: result.recovered, reconciled: result.reconciled, failed: result.failed, failures: result.failures })
        },
      }),
      queue_collect: tool({
        description: 'Collect bounded summaries of all queued workflows.',
        args: {},
        execute: async (_args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, workflows: [] })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store } = getOrCreate(context, projectRoot, queueConfig)
          const index = store.rebuildIndex()
          const summaries: Array<{ workflow_id: string; status: string; revision: number; generation: number }> = []
          for (const entry of index) {
            const wfRecord = store.load(entry.workflow_id)
            if (!wfRecord) continue
            if (wfRecord.root_session_id !== context.sessionID || wfRecord.directory !== projectRoot) continue
            summaries.push({
              workflow_id: entry.workflow_id,
              status: entry.status,
              revision: entry.state_revision,
              generation: entry.fencing_generation,
            })
          }
          return JSON.stringify({ workflows: summaries })
        },
      }),
    },
    dispose: async () => {
      const errors: Error[] = []
      for (const [workflowId, { engine, leaseHandle, store }] of engines.entries()) {
        try { settleWorkflowRecord(workflowId, engine, leaseHandle, store) }
        catch (error) { errors.push(error as Error) }
        try { engine.dispose() }
        catch (error) { errors.push(error as Error) }
      }
      engines.clear()
      for (const instance of instances.values()) {
        try { instance.scheduler.dispose() }
        catch (error) { errors.push(error as Error) }
      }
      instances.clear()
      if (errors.length > 0) throw errors[0]!
    },
  }
}

export const QueueOwnerTools: Plugin = async input => createQueueOwnerTools(input)

export default QueueOwnerTools
