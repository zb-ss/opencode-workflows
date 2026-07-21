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

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_REASON_LENGTH = 4096

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
  if (typeof (client as any)?.session?.get !== 'function') {
    throw new EpicInputError('unable to verify that the current session is a root session')
  }
  try {
    const result = await (client as any).session.get({
      path: { id: context.sessionID },
      query: { directory: context.directory },
      throwOnError: true,
    })
    const info = result?.data ?? result
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
  }
}

export const EpicOwnerTools: Plugin = async input => createEpicOwnerTools(input)

export default EpicOwnerTools
