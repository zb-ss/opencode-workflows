import {
  EpicBudgetExtensionSchema,
  type EpicBudgetDimension,
  type EpicBudgetRecord,
  type EpicBudgetScope,
  EpicBudgetUpdateSchema,
  type EpicState,
  EpicValidationError,
} from './epic-contract-schemas.ts'
import { budgetKey } from './epic-budget-usage.ts'
import { validateEpicState } from './epic-dag-state-validation.ts'
import { validateEpicTransition } from './epic-transitions.ts'

export interface EpicBudgetPolicyMutation {
  kind: 'update' | 'extension'
  update_id: string
  extension_id?: string
  actor_session_id: string
  project_identity: string
  dimension: EpicBudgetDimension
  scope: Exclude<EpicBudgetScope, 'global'>
  item_id: string | null
  new_limit: number | null
  reason: string
  recorded_at: string
}

function assertUnusedPolicyId(state: EpicState, updateId: string): void {
  const records = [
    ...state.budget_updates,
    ...(state.budgets ?? []).flatMap(budget => budget.extensions),
  ]
  if (records.some(record => record.update_id === updateId)) {
    throw new EpicValidationError(`budget policy ID is already in use: ${updateId}`)
  }
}

function checkpointActiveUsage(state: EpicState, recordedAt: string): EpicState['usage'] {
  const checkpointTime = Date.parse(recordedAt)
  return state.usage.map((record) => {
    const previousCheckpoint = record.usage.last_active_checkpoint_at
    if (previousCheckpoint === null) return record
    const elapsed = checkpointTime - Date.parse(previousCheckpoint)
    const activeTime = record.usage.active_time_ms + elapsed
    if (elapsed < 0 || !Number.isSafeInteger(activeTime)) {
      throw new EpicValidationError('active usage checkpoint cannot be represented safely')
    }
    return {
      ...record,
      usage: {
        ...record.usage,
        active_time_ms: activeTime,
        last_active_checkpoint_at: recordedAt,
      },
    }
  })
}

export function applyEpicBudgetPolicyMutation(
  stateInput: unknown,
  mutation: EpicBudgetPolicyMutation,
): EpicState {
  const state = validateEpicState(stateInput)
  if (mutation.scope === 'epic' && mutation.item_id !== null) {
    throw new EpicValidationError('epic budget policy requires item_id null')
  }
  if (mutation.scope === 'item'
    && (mutation.item_id === null || !Object.hasOwn(state.items, mutation.item_id))) {
    throw new EpicValidationError(`unknown epic item: ${String(mutation.item_id)}`)
  }
  assertUnusedPolicyId(state, mutation.update_id)
  if (mutation.kind === 'extension') {
    if (!mutation.extension_id) throw new EpicValidationError('budget extension requires extension_id')
    if (mutation.extension_id === mutation.update_id) {
      throw new EpicValidationError('budget extension and root update IDs must differ')
    }
    assertUnusedPolicyId(state, mutation.extension_id)
  }

  const target = {
    dimension: mutation.dimension,
    scope: mutation.scope,
    item_id: mutation.item_id,
  }
  const budgets = state.budgets ?? []
  const index = budgets.findIndex(record => budgetKey(record) === budgetKey(target))
  const current = index < 0 ? undefined : budgets[index]
  const previousLimit = current?.limit ?? null
  if (previousLimit === mutation.new_limit) {
    throw new EpicValidationError('budget policy mutation must change the active limit')
  }
  if (mutation.kind === 'extension') {
    if (previousLimit === null || mutation.new_limit === null || mutation.new_limit <= previousLimit) {
      throw new EpicValidationError('budget extension requires a strict increase of an existing numeric limit')
    }
  } else if (previousLimit !== null && mutation.new_limit !== null && mutation.new_limit > previousLimit) {
    throw new EpicValidationError('numeric budget increases require an explicit extension')
  }

  const stateRevision = state.state_revision + 1
  const recordFields = {
    actor_session_id: mutation.actor_session_id,
    project_identity: mutation.project_identity,
    ...target,
    previous_limit: previousLimit,
    new_limit: mutation.new_limit,
    reason: mutation.reason,
    recorded_at: mutation.recorded_at,
    state_revision: stateRevision,
    fencing_generation: null,
  } as const
  const update = EpicBudgetUpdateSchema.parse({ update_id: mutation.update_id, ...recordFields })
  const extensions = mutation.kind === 'extension'
    ? [...current!.extensions, EpicBudgetExtensionSchema.parse({ update_id: mutation.extension_id, ...recordFields })]
    : current?.extensions ?? []
  const nextBudget: EpicBudgetRecord = { ...target, limit: mutation.new_limit, extensions }
  const nextBudgets = [...budgets]
  if (index < 0) nextBudgets.push(nextBudget)
  else nextBudgets[index] = nextBudget

  return validateEpicTransition(state, {
    ...state,
    state_revision: stateRevision,
    updated_at: mutation.recorded_at,
    budgets: nextBudgets,
    usage: checkpointActiveUsage(state, mutation.recorded_at),
    budget_updates: [...state.budget_updates, update],
  })
}
