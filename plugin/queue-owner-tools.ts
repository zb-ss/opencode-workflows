import { tool, type Plugin, type PluginInput, type ToolContext } from '@opencode-ai/plugin'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { QueueStore, QueueStoreError } from '../lib/queue-store.ts'
import { QueueScheduler, type QueueRecoveryResult } from '../lib/queue-scheduler.ts'
import { enabledQueue, type EnabledQueueConfig } from '../lib/queue-policy.ts'
import { loadWorkflowConfig } from '../lib/workflow-config.ts'
import { isPathInside } from '../lib/paths.ts'
import { MAX_SAFE_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_PATTERN, SafeIdentifierSchema } from '../lib/safe-identifier.ts'
import { sha256Hex } from '../lib/canonical-json.ts'
import { throwIfAborted } from '../lib/tool-context.ts'

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

export async function createQueueOwnerTools(input: PluginInput) {
  const { client } = input
  const instances = new Map<string, { store: QueueStore; scheduler: QueueScheduler }>()

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
    })
    const scheduler = new QueueScheduler({
      store,
      config: queueConfig,
      now: Date.now,
      onWorkflowReady: (workflowId) => {
        // In production, this callback dispatches the workflow to the
        // automatic workflow engine. The engine creates a child session,
        // records the launch state transition, and settles the intent
        // on completion. This wiring point is where the durable queue
        // connects to the workflow engine.
        void workflowId
      },
    })
    instances.set(key, { store, scheduler })
    return { store, scheduler }
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

  const identifier = () => tool.schema.string().min(1).max(MAX_SAFE_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER_PATTERN)
  const casArgs = {
    workflow_id: identifier(),
    expected_revision: tool.schema.number().int().positive(),
    expected_generation: tool.schema.number().int().positive(),
  }

  return {
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
          let generation = scheduler.currentGeneration
          if (generation === null) {
            scheduler.start()
            generation = scheduler.currentGeneration
          }
          const wfRecord = store.enqueue({
            workflow_id: args.workflow_id,
            definition_id: args.definition_id,
            root_session_id: context.sessionID,
            directory: projectRoot,
            worktree: projectRoot,
            mode: config.default_mode,
            task: args.task,
          }, generation!)
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
          const { store } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          await operationAsk(context, 'queue_pause', { workflow_id: args.workflow_id })
          const updated = store.update(args.workflow_id, args.expected_revision, args.expected_generation, (wfRecord) => {
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
          const updated = store.update(args.workflow_id, args.expected_revision, args.expected_generation, (wfRecord) => {
            wfRecord.status = 'queued'
            wfRecord.pause_reason = null
            wfRecord.launch_intent = null
            return wfRecord
          })
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
          const { store } = getOrCreate(context, projectRoot, queueConfig)
          const loaded = store.load(args.workflow_id)
          if (!loaded) throw new QueueMissingError('missing', `workflow ${args.workflow_id} not found`)
          assertOwnership(loaded, context, projectRoot)
          assertExpected(loaded, args.expected_revision, args.expected_generation)
          await operationAsk(context, 'queue_cancel', { workflow_id: args.workflow_id })
          const updated = store.update(args.workflow_id, args.expected_revision, args.expected_generation, (wfRecord) => {
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
          if (!scheduler.hasLease) {
            scheduler.start()
          }
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