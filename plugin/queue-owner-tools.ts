import { tool, type Plugin, type PluginInput, type ToolContext } from '@opencode-ai/plugin'
import { createOpencodeClient as createOpencodeClientV2 } from '@opencode-ai/sdk/v2/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { QueueStore, QueueStoreError } from '../lib/queue-store.ts'
import { QueueScheduler, type QueueRecoveredLaunch, type QueueRecoveryResult } from '../lib/queue-scheduler.ts'
import { enabledQueue, type EnabledQueueConfig } from '../lib/queue-policy.ts'
import { loadWorkflowConfig, modelCandidatesForAgent, validationOperationNames } from '../lib/workflow-config.ts'
import { loadAutomaticWorkflowState, loadWorkflowDefinition, WorkflowEngine, type AutomaticWorkflowState } from '../lib/workflow-engine.ts'
import { OpenCodeSessionAdapter } from '../lib/opencode-session.ts'
import { isPathInside } from '../lib/paths.ts'
import { getConfigDir } from '../lib/paths.ts'
import { MAX_SAFE_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_PATTERN, SafeIdentifierSchema } from '../lib/safe-identifier.ts'
import { sha256Hex } from '../lib/canonical-json.ts'
import { throwIfAborted } from '../lib/tool-context.ts'
import type { FencingLeaseHandle } from '../lib/fencing-lease.ts'
import { MAX_QUEUE_CHILD_SESSION_IDS, type QueueWorkflowRecord } from '../lib/queue-contracts.ts'

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

function engineDirectory(queueDirectory: string, workflowId: string): string {
  return path.join(queueDirectory, 'engines', sha256Hex(workflowId))
}

function enginePaths(queueDirectory: string, workflowId: string): { directory: string; statePath: string; definitionPath: string } {
  const directory = engineDirectory(queueDirectory, workflowId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    directory,
    statePath: path.join(directory, 'workflow-auto.state.json'),
    definitionPath: path.join(directory, 'workflow-auto.definition.json'),
  }
}

function assertPersistedEngineIdentity(
  state: AutomaticWorkflowState,
  record: QueueWorkflowRecord,
  paths: ReturnType<typeof enginePaths>,
  projectRoot: string,
  sessionId: string,
): void {
  if (state.workflow_id !== record.workflow_id || state.definition_id !== record.definition_id
    || state.root_session_id !== sessionId || state.mode !== record.mode || state.task !== record.task
    || path.resolve(state.directory) !== projectRoot || path.resolve(state.worktree) !== projectRoot
    || path.resolve(state.definition_path) !== path.resolve(paths.definitionPath)) {
    throw new QueueInputError('engine_identity_mismatch', 'persisted workflow engine state does not match its queue record')
  }
}

function automationLimits(config: ReturnType<typeof loadWorkflowConfig>) {
  return {
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
  const engines = new Map<string, { workflowId: string; engine: WorkflowEngine; leaseHandle: FencingLeaseHandle; store: QueueStore }>()
  const controlledEngines = new Map<string, number>()
  const autonomyClient = createOpencodeClientV2({ baseUrl: serverUrl.toString(), directory: pluginDirectory })

  const instanceKey = (session: string, project: string) => `${session}\0${project}`
  const engineKey = (store: QueueStore, workflowId: string) => `${store.getConfigDirectory()}\0${workflowId}`

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
      onRecoverLaunch: (record, leaseHandle) => recoverPersistedLaunch(record, leaseHandle, store, projectRoot, context.sessionID),
      onLeaseLost: () => {
        // Cancel engines dispatched under the lost lease, but retain any
        // engine whose child termination cannot be proved so owner controls
        // can retry cleanup without losing the session identity.
        for (const [key, entry] of engines.entries()) {
          if (entry.store !== store) continue
          const { engine } = entry
          void engine.disposeAsync(false).then(() => {
            try { engine.dispose() } catch {}
            if (engines.get(key) === entry) engines.delete(key)
          }).catch(() => {
            // Retain ambiguous engines for attended cleanup.
          })
        }
      },
    })
    instances.set(key, { store, scheduler })
    return { store, scheduler }
  }

  function persistCreatedSession(
    store: QueueStore,
    workflowId: string,
    leaseHandle: FencingLeaseHandle,
    engineInstanceId: string,
    childSessionId: string,
  ): void {
    const current = store.load(workflowId)
    if (!current?.launch_intent || current.launch_intent.engine_instance_id !== engineInstanceId
      || !['created', 'prompted'].includes(current.launch_intent.launch_state)) {
      throw new QueueInputError('launch_evidence_stale', 'queue launch evidence changed before child identity could be persisted')
    }
    store.update(workflowId, current.state_revision, leaseHandle, (record) => {
      const intent = record.launch_intent
      if (!intent || intent.engine_instance_id !== engineInstanceId || !['created', 'prompted'].includes(intent.launch_state)) {
        throw new QueueInputError('launch_evidence_stale', 'queue launch evidence changed before child identity could be persisted')
      }
      const childSessionIds = intent.child_session_ids.includes(childSessionId)
        ? intent.child_session_ids
        : [...intent.child_session_ids, childSessionId]
      record.launch_intent = {
        ...intent,
        session_id: intent.session_id ?? childSessionId,
        child_session_ids: childSessionIds,
      }
      return record
    })
  }

  async function recoverPersistedLaunch(
    record: QueueWorkflowRecord,
    leaseHandle: FencingLeaseHandle,
    store: QueueStore,
    projectRoot: string,
    sessionId: string,
  ): Promise<QueueRecoveredLaunch | null> {
    const key = engineKey(store, record.workflow_id)
    const recoveredChildIds = new Set([
      ...(record.launch_intent?.session_id ? [record.launch_intent.session_id] : []),
      ...(record.launch_intent?.child_session_ids ?? []),
    ])
    let entry = engines.get(key)
    if (!entry) {
      try {
        const config = loadWorkflowConfig()
        const paths = enginePaths(store.getConfigDirectory(), record.workflow_id)
        if (!fs.existsSync(paths.statePath) || !fs.existsSync(paths.definitionPath)) return null
        const state = loadAutomaticWorkflowState(paths.statePath)
        assertPersistedEngineIdentity(state, record, paths, projectRoot, sessionId)
        const activeIds = Object.values(state.stages)
          .filter(stage => stage.status === 'running' && stage.session_id !== null)
          .map(stage => stage.session_id!)
        for (const id of activeIds) recoveredChildIds.add(id)
        const engine = new WorkflowEngine({
          adapter: new OpenCodeSessionAdapter(client, projectRoot, autonomyClient),
          definition: loadWorkflowDefinition(paths.definitionPath),
          state,
          statePath: paths.statePath,
          definitionPath: paths.definitionPath,
          modeRouting: loadModeRouting(record.mode),
          modelCandidates: (agent, tier) => modelCandidatesForAgent(config, agent, tier),
          limits: automationLimits(config),
          validationOperations: validationOperationNames(config.validation_broker),
          autonomy: state.autonomy,
          schedulingEnabled: false,
          sessionOperationTimeoutMs: config.automation.session_operation_timeout_ms!,
        })
        entry = { workflowId: record.workflow_id, engine, leaseHandle, store }
        engines.set(key, entry)
      } catch {
        return null
      }
    } else {
      for (const stage of Object.values(entry.engine.snapshot().stages)) {
        if (stage.status === 'running' && stage.session_id !== null) recoveredChildIds.add(stage.session_id)
      }
    }
    try {
      await entry.engine.disposeAsync(false)
      const state = entry.engine.snapshot()
      if (Object.values(state.stages).some(stage => stage.status === 'running') || recoveredChildIds.size > MAX_QUEUE_CHILD_SESSION_IDS) return null
      if (!['paused', 'completed', 'failed', 'cancelled'].includes(state.status)) return null
      if (engines.get(key) === entry) engines.delete(key)
      return {
        status: state.status as QueueRecoveredLaunch['status'],
        pause_reason: state.pause_reason,
        child_session_ids: [...recoveredChildIds],
      }
    } catch {
      return null
    }
  }

  async function dispatchWorkflow(
    workflowId: string,
    leaseHandle: FencingLeaseHandle,
    store: QueueStore,
    projectRoot: string,
    sessionId: string,
  ): Promise<void> {
    let engine: WorkflowEngine | null = null
    let key: string | null = null
    let launchAttempted = false
    try {
      const loaded = store.load(workflowId)
      if (!loaded || loaded.status !== 'leased') return
      const config = loadWorkflowConfig()
      validateDispatchPrerequisites(config, loaded.definition_id, loaded.mode)
      const sourcePath = path.join(getConfigDir(), 'workflow', `${loaded.definition_id}.json`)
      const paths = enginePaths(store.getConfigDirectory(), workflowId)
      const persistedState = fs.existsSync(paths.statePath) ? loadAutomaticWorkflowState(paths.statePath) : undefined
      let definition
      if (persistedState) {
        if (!fs.existsSync(paths.definitionPath)) throw new QueueInputError('missing_engine_definition', 'persisted workflow engine definition is missing')
        assertPersistedEngineIdentity(persistedState, loaded, paths, projectRoot, sessionId)
        if (persistedState.status !== 'paused' && persistedState.status !== 'failed') {
          throw new QueueInputError('engine_not_resumable', 'persisted workflow engine is not paused or failed')
        }
        definition = loadWorkflowDefinition(paths.definitionPath)
      } else {
        definition = loadWorkflowDefinition(sourcePath)
        fs.copyFileSync(sourcePath, paths.definitionPath)
      }
      const adapter = new OpenCodeSessionAdapter(client, projectRoot, autonomyClient)
      const engineInstanceId = `engine-${randomUUID()}`
      engine = new WorkflowEngine({
        adapter,
        definition,
        state: persistedState,
        statePath: paths.statePath,
        definitionPath: paths.definitionPath,
        modeRouting: loadModeRouting(loaded.mode),
        modelCandidates: (agent, tier) => modelCandidatesForAgent(config, agent, tier),
        limits: automationLimits(config),
        validationOperations: validationOperationNames(config.validation_broker),
        autonomy: persistedState?.autonomy ?? config.automation.autonomy,
        sessionOperationTimeoutMs: config.automation.session_operation_timeout_ms!,
        schedulingEnabled: persistedState ? false : undefined,
        onSessionCreated: childSessionId => persistCreatedSession(store, workflowId, leaseHandle, engineInstanceId, childSessionId),
        onStateChanged: () => {
          const changedEngine = engine
          if (changedEngine === null) return
          queueMicrotask(() => {
            const changedKey = engineKey(store, workflowId)
            if ((controlledEngines.get(changedKey) ?? 0) > 0 || engines.get(changedKey)?.engine !== changedEngine) return
            settleWorkflowRecord(workflowId, changedEngine, leaseHandle, store)
          })
        },
      })
      key = engineKey(store, workflowId)
      engines.set(key, { workflowId, engine, leaseHandle, store })
      // Transition launch intent to created before starting the engine.
      try {
        store.update(workflowId, loaded.state_revision, leaseHandle, (record) => {
          if (record.launch_intent !== null) {
            record.launch_intent = {
              ...record.launch_intent,
              launch_state: 'created',
              engine_instance_id: engineInstanceId,
              created_at: new Date().toISOString(),
            }
          }
          return record
        })
      } catch (error) {
        if (engines.get(key)?.engine === engine) engines.delete(key)
        try { engine.dispose() } catch {}
        engine = null
        key = null
        throw error
      }
      launchAttempted = true
      if (persistedState) {
        if (persistedState.status === 'failed') await engine.retryFailed(automationLimits(config))
        else await engine.resume(automationLimits(config))
      } else {
        await engine.start({
          workflowId: loaded.workflow_id,
          rootSessionId: sessionId,
          directory: projectRoot,
          worktree: projectRoot,
          mode: loaded.mode,
          task: loaded.task,
        })
      }
      // Transition to prompted and running after the engine has started.
      try {
        const current = store.load(workflowId)
        if (current) {
          store.update(workflowId, current.state_revision, leaseHandle, (record) => {
            if (record.launch_intent !== null) {
              record.launch_intent = {
                ...record.launch_intent,
                launch_state: 'prompted',
                prompted_at: new Date().toISOString(),
              }
            }
            // Transition outer status to running now that the engine is launched.
            if (record.status === 'leased') {
              record.status = 'running'
            }
            return record
          })
        }
      } catch {
        // Best-effort state transition.
      }
      settleWorkflowRecord(workflowId, engine, leaseHandle, store)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_LENGTH - 32)
      if (!launchAttempted && engine !== null && key !== null) {
        if (engines.get(key)?.engine === engine) engines.delete(key)
        try { engine.dispose() } catch {}
      } else if (launchAttempted && engine !== null) {
        try { await engine.pause(`Ambiguous queue dispatch failure: ${message}`) } catch {}
      }
      try {
        const current = store.load(workflowId)
        if (current && ['leased', 'running'].includes(current.status)) {
          store.update(workflowId, current.state_revision, leaseHandle, (record) => {
            record.status = 'paused'
            record.pause_reason = `${launchAttempted ? 'ambiguous dispatch' : 'dispatch failed'}: ${message}`
            record.failure_classification = launchAttempted
              ? 'ambiguous_launch'
              : error instanceof QueueInputError ? 'contract' : 'transport'
            if (record.launch_intent !== null) {
              record.launch_intent = launchAttempted
                ? { ...record.launch_intent, launch_state: 'ambiguous' }
                : { ...record.launch_intent, launch_state: 'settled', settled_at: new Date().toISOString() }
            }
            return record
          })
        }
      } catch {
        // Stop dispatch after a durable launch failure cannot be recorded.
        try { leaseHandle.release() } catch {}
      }
    }
  }

  function settleWorkflowRecord(workflowId: string, engine: WorkflowEngine, leaseHandle: FencingLeaseHandle, store: QueueStore): boolean {
    let state: ReturnType<WorkflowEngine['snapshot']>
    try {
      state = engine.snapshot()
      if (!['paused', 'completed', 'failed', 'cancelled'].includes(state.status)) return false
      if (!leaseHandle.is_valid()) return false
      const hasRunningStages = Object.values(state.stages).some(stage => stage.status === 'running')
      const record = store.load(workflowId)
      if (record && ['leased', 'recovering', 'running'].includes(record.status)) {
        store.update(workflowId, record.state_revision, leaseHandle, (next) => {
          next.status = state.status === 'paused'
            ? hasRunningStages ? 'recovering' : 'paused'
            : state.status === 'failed' ? 'paused' : state.status as 'completed' | 'cancelled'
          next.pause_reason = state.status === 'failed'
            ? state.pause_reason ?? 'automatic workflow completed with failed required stages'
            : state.pause_reason
          next.failure_classification = state.status === 'paused' && hasRunningStages
            ? 'ambiguous_launch'
            : state.status === 'failed'
            ? 'semantic'
            : state.status === 'cancelled' ? 'cancelled' : null
          if (next.launch_intent !== null) {
            next.launch_intent = hasRunningStages
              ? { ...next.launch_intent, launch_state: 'ambiguous' }
              : { ...next.launch_intent, launch_state: 'settled', settled_at: new Date(Date.now()).toISOString() }
          }
          return next
        })
      }
      const current = store.load(workflowId)
      const expectedStatuses = hasRunningStages
        ? ['recovering']
        : ['paused', 'completed', 'failed', 'cancelled']
      if (current && !expectedStatuses.includes(current.status)) return false
      if (hasRunningStages) return false
      disposeEngineEntry(store, workflowId)
      return true
    } catch {
      // Best-effort settlement.
      return false
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

  function assertNoControlInProgress(store: QueueStore, workflowId: string): void {
    if ((controlledEngines.get(engineKey(store, workflowId)) ?? 0) > 0) {
      throw new QueueInputError('control_in_progress', 'another owner control is already in progress for this workflow')
    }
  }

  async function operationAsk(context: ToolContext, permission: string, metadata: Record<string, unknown> = {}): Promise<void> {
    throwIfAborted(context)
    await context.ask({ permission, patterns: ['*'], always: [], metadata })
    throwIfAborted(context)
  }

  function settleEngineForSession(sessionId: string): void {
    for (const { workflowId, engine, leaseHandle, store } of engines.values()) {
      if (engine.ownsSession(sessionId)) {
        settleWorkflowRecord(workflowId, engine, leaseHandle, store)
        return
      }
    }
  }

  function disposeEngineEntry(store: QueueStore, workflowId: string): void {
    const key = engineKey(store, workflowId)
    const entry = engines.get(key)
    if (!entry) return
    try { entry.engine.dispose() } catch {}
    if (engines.get(key) === entry) engines.delete(key)
  }

  async function controlEngine(store: QueueStore, record: QueueWorkflowRecord, action: 'pause' | 'cancel', reason: string): Promise<'settled' | 'ambiguous'> {
    const workflowId = record.workflow_id
    const key = engineKey(store, workflowId)
    const entry = engines.get(key)
    if (!entry) {
      return record.launch_intent === null || record.launch_intent.launch_state === 'settled'
        ? 'settled'
        : 'ambiguous'
    }
    const { engine } = entry
    controlledEngines.set(key, (controlledEngines.get(key) ?? 0) + 1)
    try {
      if (action === 'pause') {
        const state = await engine.pause(reason)
        return Object.values(state.stages).some(stage => stage.status === 'running') ? 'ambiguous' : 'settled'
      } else {
        const state = await engine.cancel()
        return state.status === 'cancelled' ? 'settled' : 'ambiguous'
      }
    } catch {
      return 'ambiguous'
    } finally {
      const remaining = (controlledEngines.get(key) ?? 1) - 1
      if (remaining === 0) controlledEngines.delete(key)
      else controlledEngines.set(key, remaining)
    }
  }

  async function cleanupRetainedEngines(store: QueueStore): Promise<void> {
    for (const [key, entry] of [...engines.entries()]) {
      if (entry.store !== store || entry.leaseHandle.is_valid()) continue
      await entry.engine.disposeAsync(false)
      if (engines.get(key) === entry) engines.delete(key)
    }
  }

  function terminalControlResult(store: QueueStore, workflowId: string): QueueWorkflowRecord | null {
    const current = store.load(workflowId)
    return current && ['completed', 'failed', 'cancelled'].includes(current.status) ? current : null
  }

  function validateDispatchPrerequisites(config: ReturnType<typeof loadWorkflowConfig>, definitionId: string, mode: string): void {
    if (!config.automation.enabled) {
      throw new QueueInputError('automation_disabled', 'automation must be enabled to dispatch queued workflows')
    }
    const sourcePath = path.join(getConfigDir(), 'workflow', `${definitionId}.json`)
    if (!fs.existsSync(sourcePath)) {
      throw new QueueInputError('missing_definition', `workflow definition ${definitionId} not found`)
    }
    try {
      loadWorkflowDefinition(sourcePath)
    } catch (error) {
      throw new QueueInputError('invalid_definition', `workflow definition ${definitionId} is invalid: ${(error as Error).message}`)
    }
    try {
      loadModeRouting(mode)
    } catch (error) {
      throw new QueueInputError('invalid_mode', `mode ${mode} routing is invalid: ${(error as Error).message}`)
    }
  }

  const identifier = () => tool.schema.string()
    .min(1)
    .max(MAX_SAFE_IDENTIFIER_LENGTH)
    .regex(SAFE_IDENTIFIER_PATTERN)
    .refine(value => SafeIdentifierSchema.safeParse(value).success, 'reserved object property names are not valid identifiers')
  const casArgs = {
    workflow_id: identifier(),
    expected_revision: tool.schema.number().int().positive(),
    expected_generation: tool.schema.number().int().positive(),
  }

  return {
    event: async ({ event }: { event: unknown }) => {
      const sessionId = eventSessionId(event)
      if (!sessionId) return
      for (const { workflowId, engine, leaseHandle, store } of engines.values()) {
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
          task: tool.schema.string().min(1).max(MAX_TASK_LENGTH),
        },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ enqueued: false, disabled: true })
          const projectRoot = await ownerContext(context)
          await operationAsk(context, 'queue_enqueue', { workflow_id: args.workflow_id })
          validateDispatchPrerequisites(config, args.definition_id, config.default_mode)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const handle = scheduler.start({ schedule: false })
          if (scheduler.recoveryRequired) throw new QueueInputError('recovery_required', 'attended queue recovery is required before enqueuing workflows')
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
          assertNoControlInProgress(store, args.workflow_id)
          const handle = scheduler.start({ schedule: false })
          if (scheduler.recoveryRequired) throw new QueueInputError('recovery_required', 'attended queue recovery is required before mutating persisted workflows')
          const controlling = store.update(args.workflow_id, args.expected_revision, handle.lease, (wfRecord) => {
            wfRecord.status = ['leased', 'recovering', 'running'].includes(wfRecord.status) ? 'recovering' : 'paused'
            wfRecord.pause_reason = `Pause in progress: ${args.reason}`
            return wfRecord
          }, args.expected_generation)
          const engineOutcome = await controlEngine(store, controlling, 'pause', args.reason)
          let updated: QueueWorkflowRecord
          try {
            updated = store.update(args.workflow_id, controlling.state_revision, handle.lease, (wfRecord) => {
              wfRecord.status = engineOutcome === 'settled' ? 'paused' : controlling.status
              wfRecord.pause_reason = engineOutcome === 'settled'
                ? args.reason
                : `${args.reason}; child termination remains ambiguous`
              if (wfRecord.launch_intent !== null) {
                wfRecord.launch_intent = engineOutcome === 'settled'
                  ? { ...wfRecord.launch_intent, launch_state: 'settled', settled_at: new Date().toISOString() }
                  : { ...wfRecord.launch_intent, launch_state: 'ambiguous' }
              }
              return wfRecord
            })
          } catch (error) {
            const terminal = error instanceof QueueStoreError && error.code === 'stale_revision'
              ? terminalControlResult(store, args.workflow_id)
              : null
            if (!terminal) throw error
            updated = terminal
          }
          if (engineOutcome === 'settled') disposeEngineEntry(store, args.workflow_id)
          scheduler.schedule()
          return JSON.stringify({ updated: true, workflow: { workflow_id: updated.workflow_id, status: updated.status, revision: updated.state_revision, generation: updated.fencing_generation } })
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
          if (loaded.status !== 'paused') throw new QueueInputError('not_paused', 'only a paused workflow can be resumed')
          await operationAsk(context, 'queue_resume', { workflow_id: args.workflow_id })
          validateDispatchPrerequisites(config, loaded.definition_id, loaded.mode)
          // Reject ambiguous launch intents: resuming an ambiguous record
          // would requeue it with a non-null intent, which admission rejects,
          // leaving it permanently stuck.
          if (loaded.launch_intent !== null && loaded.launch_intent.launch_state === 'ambiguous') {
            throw new QueueInputError('ambiguous_intent', 'cannot resume a workflow with an ambiguous launch intent; require explicit owner resolution')
          }
          const handle = scheduler.start()
          if (scheduler.recoveryRequired) throw new QueueInputError('recovery_required', 'attended queue recovery is required before resuming persisted workflows')
          const updated = store.applyRetryPolicy(args.workflow_id, args.expected_revision, handle.lease, args.expected_generation)
          scheduler.schedule()
          const finalRecord = store.load(args.workflow_id) ?? updated
          return JSON.stringify({ updated: true, workflow: { workflow_id: finalRecord.workflow_id, status: finalRecord.status, revision: finalRecord.state_revision, generation: finalRecord.fencing_generation } })
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
          assertNoControlInProgress(store, args.workflow_id)
          const handle = scheduler.start({ schedule: false })
          if (scheduler.recoveryRequired) throw new QueueInputError('recovery_required', 'attended queue recovery is required before mutating persisted workflows')
          const controlling = store.update(args.workflow_id, args.expected_revision, handle.lease, (wfRecord) => {
            wfRecord.status = ['leased', 'recovering', 'running'].includes(wfRecord.status) ? 'recovering' : 'paused'
            wfRecord.pause_reason = `Cancellation in progress: ${args.reason}`
            return wfRecord
          }, args.expected_generation)
          const engineOutcome = await controlEngine(store, controlling, 'cancel', args.reason)
          let updated: QueueWorkflowRecord
          try {
            updated = store.update(args.workflow_id, controlling.state_revision, handle.lease, (wfRecord) => {
              wfRecord.status = engineOutcome === 'settled' ? 'cancelled' : controlling.status
              wfRecord.pause_reason = engineOutcome === 'settled'
                ? args.reason
                : `${args.reason}; cancellation could not prove child termination`
              if (wfRecord.launch_intent !== null) {
                wfRecord.launch_intent = engineOutcome === 'settled'
                  ? { ...wfRecord.launch_intent, launch_state: 'settled', settled_at: new Date().toISOString() }
                  : { ...wfRecord.launch_intent, launch_state: 'ambiguous' }
              }
              return wfRecord
            })
          } catch (error) {
            const terminal = error instanceof QueueStoreError && error.code === 'stale_revision'
              ? terminalControlResult(store, args.workflow_id)
              : null
            if (!terminal) throw error
            updated = terminal
          }
          if (engineOutcome === 'settled') disposeEngineEntry(store, args.workflow_id)
          scheduler.schedule()
          return JSON.stringify({ updated: true, workflow: { workflow_id: updated.workflow_id, status: updated.status, revision: updated.state_revision, generation: updated.fencing_generation } })
        },
      }),
      queue_delete: tool({
        description: 'Delete one terminal workflow record and its retained engine files with exact CAS evidence.',
        args: { ...casArgs },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.queue.enabled) return JSON.stringify({ disabled: true, deleted: false })
          const projectRoot = await ownerContext(context)
          const queueConfig = enabledQueue(config.queue)
          const { store, scheduler } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          if (!['completed', 'failed', 'cancelled'].includes(loaded.status)) {
            throw new QueueInputError('not_terminal', 'only a terminal workflow can be deleted')
          }
          await operationAsk(context, 'queue_delete', { workflow_id: args.workflow_id })
          const handle = scheduler.start({ schedule: false })
          if (scheduler.recoveryRequired) throw new QueueInputError('recovery_required', 'attended queue recovery is required before deleting persisted workflows')
          store.removeTerminal(
            args.workflow_id,
            args.expected_revision,
            handle.lease,
            args.expected_generation,
            () => {
              const directory = engineDirectory(store.getConfigDirectory(), args.workflow_id)
              const parent = path.dirname(directory)
              fs.rmSync(directory, { recursive: true, force: true })
              return fs.existsSync(parent) ? [parent] : []
            },
          )
          disposeEngineEntry(store, args.workflow_id)
          scheduler.schedule()
          return JSON.stringify({ deleted: true, workflow_id: args.workflow_id })
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
          try {
            await cleanupRetainedEngines(store)
          } catch {
            throw new QueueInputError('former_runtime_active', 'retained workflow engines could not prove child termination')
          }
          const handle = scheduler.start({ schedule: false })
          if (!scheduler.recoveryRequired) throw new QueueInputError('recovery_not_required', 'the queue does not require attended recovery')
          const result: QueueRecoveryResult = await scheduler.recover()
          // Only schedule if recovery succeeded. If it failed, the scheduler
          // stays non-dispatching until the operator resolves the failures.
          if (result.recovered) {
            scheduler.schedule()
          }
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
      // Every engine enforces the same configured operation deadline, so
      // concurrent draining bounds shutdown by one deadline rather than N.
      const results = await Promise.allSettled([...engines.values()].map(async ({ workflowId, engine, leaseHandle, store }) => {
        try {
          await engine.disposeAsync(true)
          const state = engine.snapshot()
          if (!['completed', 'failed', 'cancelled'].includes(state.status)) {
            throw new Error(`workflow ${workflowId} child termination remains ambiguous`)
          }
          if (!settleWorkflowRecord(workflowId, engine, leaseHandle, store)) {
            throw new Error(`workflow ${workflowId} cancellation could not be durably settled`)
          }
        } catch (error) {
          try {
            const current = store.load(workflowId)
            if (current && ['leased', 'recovering', 'running'].includes(current.status) && leaseHandle.is_valid()) {
              store.update(workflowId, current.state_revision, leaseHandle, (record) => {
                record.status = 'paused'
                record.pause_reason = 'plugin disposal could not prove child termination'
                if (record.launch_intent !== null) record.launch_intent = { ...record.launch_intent, launch_state: 'ambiguous' }
                return record
              })
            }
          } catch { /* Preserve the original disposal failure. */ }
          throw error
        }
      }))
      for (const result of results) {
        if (result.status === 'rejected') errors.push(result.reason as Error)
      }
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
