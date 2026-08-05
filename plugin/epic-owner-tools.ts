import { tool, type Plugin, type PluginInput, type ToolContext } from '@opencode-ai/plugin'
import fs from 'node:fs'

import {
  applyEpicBudgetPolicyMutation,
  type EpicBudgetPolicyMutation,
} from '../lib/epic-budget-policy.ts'
import {
  EPIC_BUDGET_DIMENSIONS,
  type EpicBudgetExtension,
  type EpicBudgetUpdate,
  type EpicState,
} from '../lib/epic-contract-schemas.ts'
import {
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  projectIdentitySha256,
} from '../lib/epic-contracts.ts'
import {
  EpicCoordinator,
  EpicDefinitiveSessionError,
  type EpicCoordinatorOptions,
  type EpicSessionAdapter,
  type EpicSessionResponse,
} from '../lib/epic-coordinator.ts'
import {
  EpicInputError,
  EpicMissingError,
  EpicRecoveryRequiredError,
  EpicStaleRevisionError,
  openEpicStore,
  projectEpicStatus,
  type EpicLoadResult,
} from '../lib/epic-persistence.ts'
import { isPathInside } from '../lib/paths.ts'
import { MAX_SAFE_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_PATTERN } from '../lib/safe-identifier.ts'
import { WORKFLOW_RUNTIME_INCARNATION } from '../lib/runtime-incarnation.ts'
import { throwIfAborted } from '../lib/tool-context.ts'
import { loadWorkflowConfig } from '../lib/workflow-config.ts'
import { enabledEpic } from '../lib/epic-policy.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_REASON_LENGTH = 4096
const MAX_AWAIT_MS = 60 * 60 * 1000
const DEFINITIVE_REQUEST_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422])

interface MutationCas {
  epic_id: string
  expected_revision: number
  expected_state_sha256: string
  expected_generation: number
}

function modelParts(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/')
  if (slash < 1 || slash === model.length - 1) throw new EpicInputError('configured model identifier is invalid')
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function responseText(value: unknown, maxBytes: number): string {
  const payload = record(value)
  const parts = Array.isArray(payload?.parts) ? payload.parts : []
  const texts: string[] = []
  let bytes = 0
  for (const candidate of parts) {
    const part = record(candidate)
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    bytes += Buffer.byteLength(part.text, 'utf8') + (texts.length > 0 ? 1 : 0)
    if (bytes > maxBytes) throw new Error('assistant response exceeds the configured epic result bound')
    texts.push(part.text)
  }
  return texts.join('\n')
}

function sessionResponse(value: unknown, maxBytes: number): EpicSessionResponse {
  const envelope = record(value)
  const payload = record(envelope?.data) ?? envelope ?? {}
  const info = record(payload.info) ?? {}
  const responseId = info.id ?? info.messageID
  if (typeof responseId !== 'string' || responseId.length === 0 || responseId.length > MAX_SAFE_IDENTIFIER_LENGTH || responseId.includes('\0')) {
    throw new Error('assistant response lacks a bounded stable message identity')
  }
  const text = responseText(payload, maxBytes)
  let result: unknown
  try { result = JSON.parse(text) } catch { result = text }
  const tokens = record(info.tokens) ?? record(info.usage)
  const inputTokens = tokens?.input
  const outputTokens = tokens?.output
  const usage = Number.isSafeInteger(inputTokens) && Number(inputTokens) >= 0
    && Number.isSafeInteger(outputTokens) && Number(outputTokens) >= 0
    ? { input_tokens: Number(inputTokens), output_tokens: Number(outputTokens), cost_usd: typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : null }
    : undefined
  return { response_id: responseId, result, ...(usage ? { usage } : {}) }
}

function definitiveSessionError(error: unknown): EpicDefinitiveSessionError | null {
  if (!(error instanceof Error)) return null
  const directStatus = (error as Error & { status?: unknown }).status
  const causeStatus = record(error.cause)?.status
  const status = Number.isInteger(directStatus) ? Number(directStatus) : Number.isInteger(causeStatus) ? Number(causeStatus) : null
  return status !== null && DEFINITIVE_REQUEST_REJECTION_STATUSES.has(status)
    ? new EpicDefinitiveSessionError(`OpenCode session request was definitively rejected with HTTP ${status}.`)
    : null
}

class PluginEpicSessionAdapter implements EpicSessionAdapter {
  constructor(private readonly client: PluginInput['client']) {}
  async create(input: Parameters<EpicSessionAdapter['create']>[0]): Promise<{ id: string }> {
    try {
      const value = await this.client.session.create({
        body: { title: input.title, parentID: input.parent_id }, query: { directory: input.directory }, throwOnError: true,
      })
      const envelope = record(value)
      const session = record(envelope?.data) ?? envelope
      if (typeof session?.id !== 'string' || session.id.length === 0) throw new Error('session.create returned no child identity')
      if (session.id.length > MAX_SAFE_IDENTIFIER_LENGTH || !SAFE_IDENTIFIER_PATTERN.test(session.id)) {
        try {
          await this.client.session.abort({ path: { id: session.id }, query: { directory: input.directory }, throwOnError: true })
        } catch {
          throw new Error('session.create returned an invalid child identity and termination is uncertain')
        }
        throw new EpicDefinitiveSessionError('session.create returned an invalid child identity that was terminated')
      }
      return { id: session.id }
    } catch (error) {
      throw definitiveSessionError(error) ?? error
    }
  }
  async prompt(input: Parameters<EpicSessionAdapter['prompt']>[0]): Promise<EpicSessionResponse> {
    try {
      const value = await this.client.session.prompt({
        path: { id: input.session_id }, query: { directory: input.directory }, throwOnError: true,
        body: { agent: input.agent, model: modelParts(input.model.model), ...(input.model.variant ? { variant: input.model.variant } : {}), parts: [{ type: 'text', text: input.prompt }] },
      })
      return sessionResponse(value, input.max_result_bytes)
    } catch (error) {
      throw definitiveSessionError(error) ?? error
    }
  }
  async abort(session_id: string, directory: string): Promise<void> {
    await this.client.session.abort({ path: { id: session_id }, query: { directory }, throwOnError: true })
  }
  async inspect(session_id: string, directory: string) {
    try {
      const statuses = await this.client.session.status({ query: { directory }, throwOnError: true })
      const statusEnvelope = record(statuses)
      const statusMap = record(statusEnvelope?.data) ?? statusEnvelope
      const status = record(statusMap?.[session_id])
      if (status?.type === 'busy' || status?.type === 'retry') return { status: 'running' as const }
      const messages = await this.client.session.messages({ path: { id: session_id }, query: { directory }, throwOnError: true })
      const messageEnvelope = record(messages)
      const entries = Array.isArray(messageEnvelope?.data) ? messageEnvelope.data : Array.isArray(messages) ? messages : []
      const last = entries.slice().reverse().find(entry => record(record(entry)?.info)?.role === 'assistant')
      return last ? { status: 'completed' as const } : { status: 'idle' as const }
    } catch { return { status: 'unknown' as const } }
  }
}

interface BudgetToolArgs {
  epic_id: string
  expected_revision: number
  expected_state_sha256: string
  expected_generation: number
  update_id: string
  dimension: (typeof EPIC_BUDGET_DIMENSIONS)[number]
  scope: 'epic' | 'item'
  item_id?: string | null
  new_limit: number | null
  reason: string
  extension_id?: string
}

function trustedProjectRoot(context: ToolContext): string {
  try {
    const projectRoot = fs.realpathSync(context.worktree)
    const directory = fs.realpathSync(context.directory)
    if (!isPathInside(projectRoot, directory)) throw new Error('outside worktree')
    return projectRoot
  } catch {
    throw new EpicInputError('tool context does not identify a valid project worktree')
  }
}

async function assertRootSession(client: PluginInput['client'], context: ToolContext): Promise<void> {
  throwIfAborted(context)
  const sessions = (client as unknown as { session?: unknown }).session as {
    get?: (input: { path: { id: string }; query: { directory: string }; throwOnError: true }) => Promise<unknown>
  } | undefined
  if (typeof sessions?.get !== 'function') {
    throw new EpicInputError('unable to verify that the current session is a root session')
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
    if (info.parentID) throw new EpicInputError('epic policy tools are restricted to root sessions')
  } catch (error) {
    if (error instanceof EpicInputError) throw error
    throw new EpicInputError('unable to verify that the current session is a root session')
  }
  throwIfAborted(context)
}

function matchingRecord(
  record: EpicBudgetUpdate | EpicBudgetExtension,
  args: BudgetToolArgs,
  loaded: EpicLoadResult,
): boolean {
  return record.actor_session_id === loaded.state.root_session_id
    && record.project_identity === loaded.state.project_identity_sha256
    && record.dimension === args.dimension
    && record.scope === args.scope
    && record.item_id === (args.item_id ?? null)
    && record.new_limit === args.new_limit
    && record.reason === args.reason
    && record.state_revision === args.expected_revision + 1
}

function findExtension(state: EpicState, updateId: string): EpicBudgetExtension | undefined {
  return (state.budgets ?? []).flatMap(record => record.extensions)
    .find(record => record.update_id === updateId)
}

function idempotentRetry(
  loaded: EpicLoadResult,
  args: BudgetToolArgs,
  kind: EpicBudgetPolicyMutation['kind'],
): boolean {
  const rootUpdate = loaded.state.budget_updates.find(record => record.update_id === args.update_id)
  const extension = args.extension_id ? findExtension(loaded.state, args.extension_id) : undefined
  const hasAnyId = rootUpdate !== undefined || extension !== undefined
  if (!hasAnyId) return false
  const rootMatches = rootUpdate !== undefined && matchingRecord(rootUpdate, args, loaded)
  const isNumericIncrease = rootUpdate !== undefined
    && rootUpdate.previous_limit !== null
    && rootUpdate.new_limit !== null
    && rootUpdate.new_limit > rootUpdate.previous_limit
  const exact = kind === 'extension'
    ? rootMatches && isNumericIncrease && extension !== undefined
      && matchingRecord(extension, args, loaded)
      && extension.previous_limit === rootUpdate.previous_limit
      && extension.new_limit === rootUpdate.new_limit
    : rootMatches && !isNumericIncrease && extension === undefined
  if (!exact) throw new EpicInputError('budget policy ID is already bound to a different policy change')
  const evidence = loaded.revision_evidence?.find(entry => entry.revision === rootUpdate!.state_revision)
  if (!evidence
    || evidence.previous_state_sha256 !== args.expected_state_sha256
    || evidence.ownership_generation !== args.expected_generation) {
    throw new EpicStaleRevisionError('idempotent policy retry does not match its original state digest or ownership generation')
  }
  return true
}

function assertExpected(loaded: EpicLoadResult, args: BudgetToolArgs): void {
  if (loaded.revision !== args.expected_revision
    || loaded.state_sha256 !== args.expected_state_sha256
    || loaded.ownership_generation !== args.expected_generation) {
    throw new EpicStaleRevisionError('expected revision, state digest, or ownership generation is stale')
  }
}

function recordedAt(state: EpicState): string {
  return new Date(Math.max(Date.now(), Date.parse(state.updated_at))).toISOString()
}

function permissionPattern(args: BudgetToolArgs): string {
  return `${args.epic_id}:${args.scope}:${args.item_id ?? ''}:${args.dimension}`
}

function statusResult(updated: boolean, idempotent: boolean, loaded: EpicLoadResult): string {
  return JSON.stringify({
    updated,
    idempotent,
    epic: projectEpicStatus(loaded.state, loaded),
  })
}

export async function createEpicOwnerTools(
  input: PluginInput,
  runtimeIncarnation = WORKFLOW_RUNTIME_INCARNATION,
) {
  const { client } = input
  const coordinators = new Map<string, EpicCoordinator>()
  const sessionAdapter = new PluginEpicSessionAdapter(client)

  const coordinatorKey = (session: string, project: string, epic: string) => `${session}\0${project}\0${epic}`

  function storeFor(context: ToolContext, projectRoot: string, epic_id: string, mode: 'read_only' | 'read_write' = 'read_write') {
    const config = loadWorkflowConfig()
    return openEpicStore({
      root_session_id: context.sessionID,
      project_root: projectRoot,
      epic_id,
      config: config.epic,
      runtime_incarnation: runtimeIncarnation,
      mode,
    })
  }

  function coordinatorFor(context: ToolContext, projectRoot: string, epic_id: string): EpicCoordinator {
    const key = coordinatorKey(context.sessionID, projectRoot, epic_id)
    const existing = coordinators.get(key)
    if (existing) return existing
    const workflow_config = loadWorkflowConfig()
    const coordinator = new EpicCoordinator({
      root_session_id: context.sessionID,
      project_root: projectRoot,
      epic_id,
      store: storeFor(context, projectRoot, epic_id),
      session: sessionAdapter,
      config: enabledEpic(workflow_config.epic),
      workflow_config,
    } satisfies EpicCoordinatorOptions)
    coordinators.set(key, coordinator)
    return coordinator
  }

  async function ownerContext(context: ToolContext): Promise<{ projectRoot: string }> {
    await assertRootSession(client, context)
    return { projectRoot: trustedProjectRoot(context) }
  }

  function loadedForCas(context: ToolContext, projectRoot: string, args: MutationCas): EpicLoadResult {
    const loaded = storeFor(context, projectRoot, args.epic_id).load()
    if (!loaded) throw new EpicMissingError('no epic belongs to this root session and project')
    assertExpected(loaded, args as BudgetToolArgs)
    return loaded
  }

  async function operationAsk(context: ToolContext, permission: string, args: MutationCas, metadata: Record<string, unknown> = {}): Promise<void> {
    throwIfAborted(context)
    await context.ask({ permission, patterns: [`${args.epic_id}:${args.expected_revision}:${args.expected_generation}`], always: [], metadata: { epic_id: args.epic_id, ...metadata } })
    throwIfAborted(context)
  }

  function taskAuthorization(context: ToolContext, epic_id: string) {
    return async (agents: string[]) => {
      throwIfAborted(context)
      await context.ask({ permission: 'task', patterns: agents, always: [], metadata: { epic_id, agents } })
      throwIfAborted(context)
    }
  }

  async function mutate(
    args: BudgetToolArgs,
    context: ToolContext,
    kind: EpicBudgetPolicyMutation['kind'],
  ): Promise<string> {
    const config = loadWorkflowConfig()
    if (!config.epic.enabled) {
      return JSON.stringify({ updated: false, disabled: true, reason: 'epic.enabled is false in workflows.json' })
    }
    await assertRootSession(client, context)
    const projectRoot = trustedProjectRoot(context)
    const store = openEpicStore({
      root_session_id: context.sessionID,
      project_root: projectRoot,
      epic_id: args.epic_id,
      config: config.epic,
      runtime_incarnation: runtimeIncarnation,
      mode: 'read_write',
    })
    const loaded = store.load()
    if (!loaded) throw new EpicMissingError('no epic belongs to this root session and project')
    if (idempotentRetry(loaded, args, kind)) return statusResult(false, true, loaded)
    assertExpected(loaded, args)
    if (loaded.recovery_required) {
      throw new EpicRecoveryRequiredError('epic requires attended restart reconciliation before policy updates')
    }
    const next = applyEpicBudgetPolicyMutation(loaded.state, {
      kind,
      update_id: args.update_id,
      extension_id: args.extension_id,
      actor_session_id: context.sessionID,
      project_identity: loaded.state.project_identity_sha256,
      dimension: args.dimension,
      scope: args.scope,
      item_id: args.item_id ?? null,
      new_limit: args.new_limit,
      reason: args.reason,
      recorded_at: recordedAt(loaded.state),
    })
    throwIfAborted(context)
    await context.ask({
      permission: kind === 'extension' ? 'epic_budget_extend' : 'epic_budget_update',
      patterns: [permissionPattern(args)],
      always: [],
      metadata: {
        epic_id: args.epic_id,
        update_id: args.update_id,
        dimension: args.dimension,
        scope: args.scope,
        item_id: args.item_id ?? null,
        previous_limit: next.budget_updates.at(-1)!.previous_limit,
        new_limit: args.new_limit,
      },
    })
    throwIfAborted(context)
    const written = store.append(
      next,
      args.expected_revision,
      args.expected_state_sha256,
      args.expected_generation,
    )
    if (!written) throw new EpicInputError('epic policy update did not produce persisted state')
    return statusResult(true, false, written)
  }

  const identifier = () => tool.schema.string().min(1).max(MAX_SAFE_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER_PATTERN)
  const stateDigest = () => tool.schema.string().regex(SHA256_PATTERN)
  const casArgs = {
    epic_id: identifier().describe('Owned epic identifier'),
    expected_revision: tool.schema.number().int().positive(),
    expected_state_sha256: stateDigest(),
    expected_generation: tool.schema.number().int().positive(),
  }
  const commonArgs = {
    epic_id: identifier().describe('Owned epic identifier'),
    expected_revision: tool.schema.number().int().positive().describe('Current persisted epic revision'),
    expected_state_sha256: tool.schema.string().regex(SHA256_PATTERN).describe('Current persisted state digest'),
    expected_generation: tool.schema.number().int().positive().describe('Current ownership generation'),
    update_id: identifier().describe('Idempotency identifier for the root policy update'),
    dimension: tool.schema.enum(EPIC_BUDGET_DIMENSIONS).describe('Typed budget dimension'),
    scope: tool.schema.enum(['epic', 'item']).describe('Epic or item policy scope'),
    item_id: identifier().nullable().optional().describe('Required for item scope; omitted for epic scope'),
    reason: tool.schema.string().min(1).max(MAX_REASON_LENGTH)
      .refine(value => !value.includes('\0')).describe('Operator reason recorded in policy history'),
  }

  return {
    tool: {
      epic_start: tool({
        description: 'Create or start one attended, single-process epic coordinator after explicit root authorization.',
        args: {
          epic_id: identifier(),
          expected_revision: tool.schema.literal(0),
          expected_state_sha256: tool.schema.null(),
          expected_generation: tool.schema.literal(1),
          base_branch: tool.schema.string().min(1).max(MAX_REASON_LENGTH),
          integration_branch: tool.schema.string().min(1).max(MAX_REASON_LENGTH),
          items: tool.schema.array(tool.schema.object({
            item_id: identifier(),
            dependencies: tool.schema.array(identifier()),
            scope: tool.schema.string().min(1).max(MAX_REASON_LENGTH),
          })).min(1),
          budgets: tool.schema.array(tool.schema.object({
            dimension: tool.schema.enum(EPIC_BUDGET_DIMENSIONS),
            scope: tool.schema.enum(['epic', 'item']),
            item_id: identifier().nullable(),
            limit: tool.schema.number().nonnegative().nullable(),
          })).optional(),
        },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.epic.enabled) return JSON.stringify({ started: false, disabled: true, reason: 'epic.enabled is false in workflows.json' })
          const { projectRoot } = await ownerContext(context)
          const store = storeFor(context, projectRoot, args.epic_id)
          if (store.load()) throw new EpicInputError('owned epic already exists')
          if (new Set(args.items.map(item => item.item_id)).size !== args.items.length) {
            throw new EpicInputError('epic item identifiers must be unique')
          }
          await context.ask({ permission: 'epic_start', patterns: [args.epic_id], always: [], metadata: { epic_id: args.epic_id, item_count: args.items.length } })
          const now = new Date().toISOString()
          const items = Object.fromEntries(args.items.map(item => [item.item_id, {
            item_id: item.item_id, dependencies: item.dependencies, scope: item.scope, status: 'pending' as const, attempts: [],
            selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null,
            review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null,
          }]))
          const genesis: EpicState = {
            schema_version: EPIC_SCHEMA_VERSION,
            state_revision: 1,
            operational_limits: {
              max_epic_items: config.epic.max_epic_items,
              max_item_dependencies: config.epic.max_item_dependencies,
              max_attempts_per_item: config.epic.max_attempts_per_item,
              max_budget_records: config.epic.max_budget_records,
            },
            epic_id: args.epic_id,
            root_session_id: context.sessionID,
            project_identity_sha256: projectIdentitySha256(projectRoot),
            base_branch: args.base_branch,
            integration_branch: args.integration_branch,
            status: 'pending', pause_reason: null, pause_code: null, created_at: now, updated_at: now,
            items, integration_log: [],
            budgets: (args.budgets ?? []).map(budget => ({ ...budget, extensions: [] })),
            usage: [
              { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
              ...args.items.map(item => ({ scope: 'item' as const, item_id: item.item_id, usage: emptyAutomationUsageTelemetry() })),
            ],
            budget_updates: [],
          }
          const coordinator = coordinatorFor(context, projectRoot, args.epic_id)
          const epic = await coordinator.start(genesis, args, taskAuthorization(context, args.epic_id))
          return JSON.stringify({ started: true, epic })
        },
      }),
      epic_status: tool({
        description: 'Return the redacted operational status for an owned epic without exposing children, models, paths, prompts, or output.',
        args: { epic_id: identifier() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.epic.enabled) return JSON.stringify({ disabled: true, reason: 'epic.enabled is false in workflows.json' })
          const { projectRoot } = await ownerContext(context)
          const key = coordinatorKey(context.sessionID, projectRoot, args.epic_id)
          const epic = coordinators.get(key)?.status() ?? storeFor(context, projectRoot, args.epic_id, 'read_only').statusOnly()
          if (!epic) throw new EpicMissingError('no epic belongs to this root session and project')
          return JSON.stringify({ epic })
        },
      }),
      epic_await: tool({
        description: 'Wait for an owned in-process epic to become quiescent or for the bounded timeout to expire.',
        args: { epic_id: identifier(), timeout_ms: tool.schema.number().int().nonnegative().max(MAX_AWAIT_MS) },
        execute: async (args, context) => {
          const config = loadWorkflowConfig()
          if (!config.epic.enabled) return JSON.stringify({ disabled: true, quiescent: true })
          const { projectRoot } = await ownerContext(context)
          const coordinator = coordinators.get(coordinatorKey(context.sessionID, projectRoot, args.epic_id))
          if (!coordinator) {
            const epic = storeFor(context, projectRoot, args.epic_id, 'read_only').statusOnly()
            if (!epic) throw new EpicMissingError()
            return JSON.stringify({ quiescent: true, timed_out: false, epic })
          }
          return JSON.stringify(await coordinator.awaitQuiescence(args.timeout_ms))
        },
      }),
      epic_collect: tool({
        description: 'Collect bounded redacted item summaries and evidence from the attended coordinator.',
        args: { epic_id: identifier() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, items: [] })
          const { projectRoot } = await ownerContext(context)
          return JSON.stringify(coordinatorFor(context, projectRoot, args.epic_id).collect())
        },
      }),
      epic_pause: tool({
        description: 'Pause an owned epic and conservatively settle known active work.', args: { ...casArgs, reason: tool.schema.string().min(1).max(MAX_REASON_LENGTH) },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, updated: false })
          const { projectRoot } = await ownerContext(context); loadedForCas(context, projectRoot, args); await operationAsk(context, 'epic_pause', args)
          return JSON.stringify({ epic: await coordinatorFor(context, projectRoot, args.epic_id).pause(args, args.reason) })
        },
      }),
      epic_cancel: tool({
        description: 'Cancel an owned epic after one revision-bound authorization.', args: { ...casArgs, reason: tool.schema.string().min(1).max(MAX_REASON_LENGTH) },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, updated: false })
          const { projectRoot } = await ownerContext(context); loadedForCas(context, projectRoot, args); await operationAsk(context, 'epic_cancel', args)
          return JSON.stringify({ epic: await coordinatorFor(context, projectRoot, args.epic_id).cancel(args, args.reason) })
        },
      }),
      epic_resume: tool({
        description: 'Perform attended restart recovery with exact CAS evidence and former-runtime termination confirmation.',
        args: { ...casArgs, former_runtime_terminated: tool.schema.boolean() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, updated: false })
          const { projectRoot } = await ownerContext(context)
          const loaded = loadedForCas(context, projectRoot, args)
          await operationAsk(context, 'epic_resume', args, { former_runtime_terminated: args.former_runtime_terminated })
          const coordinator = coordinatorFor(context, projectRoot, args.epic_id)
          const authorize = taskAuthorization(context, args.epic_id)
          const epic = loaded.recovery_required
            ? await coordinator.resumeAttended(args, authorize)
            : await coordinator.resumePaused(args, args.former_runtime_terminated, authorize)
          return JSON.stringify({ epic })
        },
      }),
      epic_redelegate: tool({
        description: 'Requeue one eligible non-ambiguous item under the frozen epic policy.', args: { ...casArgs, item_id: identifier() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, updated: false })
          const { projectRoot } = await ownerContext(context); loadedForCas(context, projectRoot, args); await operationAsk(context, 'epic_redelegate', args, { item_id: args.item_id })
          return JSON.stringify({ epic: coordinatorFor(context, projectRoot, args.epic_id).redelegate(args, args.item_id) })
        },
      }),
      epic_integrate: tool({
        description: 'Persist an exact integration intent before integrating one reviewed dependency-ready item.', args: { ...casArgs, item_id: identifier().optional() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, updated: false })
          const { projectRoot } = await ownerContext(context); loadedForCas(context, projectRoot, args); await operationAsk(context, 'epic_integrate', args, { item_id: args.item_id ?? null })
          return JSON.stringify({ epic: await coordinatorFor(context, projectRoot, args.epic_id).integrateReady(args, args.item_id) })
        },
      }),
      epic_cleanup: tool({
        description: 'Remove only clean, identity-bound worktrees for already integrated attempts.', args: { ...casArgs, item_id: identifier().optional() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true, cleaned: [] })
          const { projectRoot } = await ownerContext(context); loadedForCas(context, projectRoot, args); await operationAsk(context, 'epic_cleanup', args, { item_id: args.item_id ?? null })
          return JSON.stringify(coordinatorFor(context, projectRoot, args.epic_id).cleanup(args, args.item_id))
        },
      }),
      epic_budget_status: tool({
        description: 'Return only the typed redacted epic budget projection.', args: { epic_id: identifier() },
        execute: async (args, context) => {
          const config = loadWorkflowConfig(); if (!config.epic.enabled) return JSON.stringify({ disabled: true })
          const { projectRoot } = await ownerContext(context)
          const epic = storeFor(context, projectRoot, args.epic_id, 'read_only').statusOnly()
          if (!epic) throw new EpicMissingError()
          return JSON.stringify({ epic_id: epic.epic_id, revision: epic.revision, ownership_generation: epic.ownership_generation, state_sha256: epic.state_sha256, budget_dimensions: epic.budget_dimensions })
        },
      }),
      epic_budget_update: tool({
        description: 'Apply one owner-authorized, revision-checked epic budget update. Numeric increases require epic_budget_extend.',
        args: {
          ...commonArgs,
          new_limit: tool.schema.number().nonnegative().nullable()
            .describe('New limit; null explicitly removes the active limit'),
        },
        execute: (args, context) => mutate(args, context, 'update'),
      }),
      epic_budget_extend: tool({
        description: 'Strictly increase one existing numeric epic budget limit with durable owner-authorized extension evidence.',
        args: {
          ...commonArgs,
          extension_id: identifier().describe('Distinct idempotency identifier for nested extension evidence'),
          new_limit: tool.schema.number().nonnegative().describe('Strictly higher numeric limit'),
        },
        execute: (args, context) => mutate(args, context, 'extension'),
      }),
    },
    dispose: async () => {
      const results = await Promise.allSettled(
        [...coordinators.values()].map(coordinator => coordinator.dispose())
      )
      coordinators.clear()
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => r.reason as Error)
      if (errors.length > 0) throw errors[0]!
    },
  }
}

export const EpicOwnerTools: Plugin = async input => createEpicOwnerTools(input)

export default EpicOwnerTools
