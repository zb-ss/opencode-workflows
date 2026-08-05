import type { EpicAttempt, EpicState } from './epic-contract-schemas.ts'
import { closeEpicUsageIntervals } from './epic-accounting.ts'
import { sha256Hex } from './epic-canonical-json.ts'
import { computeDependencySnapshotDigest } from './epic-integration-digests.ts'

const DERIVED_ID_MAX = 64

function compositeId(...parts: string[]): string {
  const id = parts.join('-')
  if (id.length <= DERIVED_ID_MAX) return id
  const hash = sha256Hex(parts.join('\0'))
  return hash.slice(0, DERIVED_ID_MAX)
}
import type { EpicCoordinatorRuntime, EpicSessionAdapter } from './epic-coordinator.ts'
import type { EpicLoadResult, EpicStoreHandle } from './epic-persistence.ts'
import { transitionEpicItemToIntegrated } from './epic-transitions.ts'
import { verifyRecoveredIntegrationObject, repairRecoveredEpicIntegration, verifyRecoveredEpicIntegration } from './epic-integration.ts'
import { withRepositoryOperationLockAsync } from './repository-operation-lock.ts'

export interface EpicRecoveryOptions {
  store: EpicStoreHandle
  project_root: string
  session: EpicSessionAdapter
  runtime: EpicCoordinatorRuntime
  now: () => number
  expected_revision: number
  expected_state_sha256: string
  expected_generation: number
  former_runtime_terminated: boolean
}

export interface EpicRecoveryResult {
  loaded: EpicLoadResult
  ambiguous: boolean
  reasons: string[]
}

function timestamp(state: EpicState, now: number): string {
  return new Date(Math.max(now, Date.parse(state.updated_at))).toISOString()
}

function active(attempt: EpicAttempt): boolean {
  return ['running', 'checkpointed', 'reviewing'].includes(attempt.status)
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('recovery session inspection timed out')), timeoutMs)
  })
  try { return await Promise.race([operation, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

/** Attended, single-process restart reconciliation. It never adopts children. */
export async function recoverEpic(options: EpicRecoveryOptions): Promise<EpicRecoveryResult> {
  return await withRepositoryOperationLockAsync(options.project_root, async () => {
  if (!options.former_runtime_terminated) throw new Error('attended recovery requires confirmation that the former runtime terminated')
  const current = options.store.load()
  if (!current || !current.recovery_required) throw new Error('epic does not require attended recovery')
  if (current.revision !== options.expected_revision
    || current.state_sha256 !== options.expected_state_sha256
    || current.ownership_generation !== options.expected_generation) throw new Error('epic recovery CAS evidence is stale')

  let next = structuredClone(current.state)
  const reasons: string[] = []
  let ambiguous = false
  let hasAmbiguousReview = false
  let hasAmbiguousExecution = false
  let hasAmbiguousIntegration = false
  let hasAmbiguousUsage = false
  let recoveredIntegrationHead: string | null = null
  const requiresMeteredUsage = (next.budgets ?? []).some(budget => (
    budget.limit !== null && ['input_tokens', 'output_tokens', 'cost_usd'].includes(budget.dimension)
  ))

  for (const item of Object.values(next.items)) {
    for (const attempt of item.attempts) {
      if (!active(attempt)) continue
      let attemptAmbiguous = false
      let reviewAmbiguous = false
      try { options.runtime.inspectWorktree(options.project_root, attempt) }
      catch {
        reasons.push(`worktree_identity:${item.item_id}`)
        attemptAmbiguous = true
      }
      const executionIsActive = attempt.status === 'running'
      const childSessions = [
        ...(executionIsActive && attempt.child_session_id ? [{ id: attempt.child_session_id, review: false }] : []),
        ...(attempt.review?.child_session_id ? [{ id: attempt.review.child_session_id, review: true }] : []),
      ]
      if (executionIsActive && attempt.launch_state === 'reserved') {
        reasons.push(`reserved_execution_launch:${item.item_id}`)
        attemptAmbiguous = true
      }
      if (attempt.review?.launch_state === 'reserved') {
        reasons.push(`reserved_reviewer_launch:${item.item_id}`)
        reviewAmbiguous = true
      }
      for (const child of childSessions) {
        let terminated = false
        try {
          const worktreePath = options.runtime.worktreePath(options.project_root, attempt)
          const inspection = await withDeadline((async () => {
            await options.session.abort(child.id, worktreePath)
            return options.session.inspect(child.id, worktreePath)
          })(), next.coordination_policy!.max_attempt_duration_ms)
          terminated = !['running', 'unknown'].includes(inspection.status)
          if (terminated && requiresMeteredUsage) {
            reasons.push(`usage_accounting:${item.item_id}`)
            hasAmbiguousUsage = true
            if (child.review) reviewAmbiguous = true
            else attemptAmbiguous = true
          }
        } catch { /* the launch remains ambiguous below */ }
        if (!terminated) {
          if (child.review) reviewAmbiguous = true
          else attemptAmbiguous = true
        }
      }
      if (attemptAmbiguous || reviewAmbiguous) {
        attempt.status = 'failed'
        attempt.failure_classification = 'ambiguous_launch'
        attempt.launch_state = attemptAmbiguous ? 'ambiguous' : 'settled'
        if (reviewAmbiguous && attempt.review) attempt.review.launch_state = 'ambiguous'
        item.status = 'failed'
        ambiguous = true
        hasAmbiguousExecution ||= attemptAmbiguous
        hasAmbiguousReview ||= reviewAmbiguous
      } else {
        attempt.status = 'cancelled'; attempt.failure_classification = 'cancelled'; attempt.launch_state = 'settled'
        if (attempt.review && attempt.review.launch_state !== 'ambiguous') attempt.review.launch_state = 'settled'
        item.status = 'cancelled'
      }
      const settledAt = timestamp(next, options.now())
      attempt.completed_at = settledAt
      attempt.result_summary = 'Conservatively settled during attended restart recovery.'
      item.completed_at = settledAt
    }
  }

  const intent = next.integration_intent
  if (intent) {
    let head: string | null = null
    try { head = options.runtime.integrationHead(options.project_root, next.integration_branch) } catch { /* ambiguous below */ }
    if (head === intent.expected_target_commit) {
      reasons.push('integration_undispatched')
      next.integration_intent = null
    } else if (head) {
      let parents: string[] = []
      try { parents = options.runtime.mergeParents(options.project_root, head) } catch { /* ambiguous below */ }
      if (parents.length === 2 && parents[0] === intent.expected_target_commit && parents[1] === intent.expected_source_commit) {
        try {
          // Step 1: Verify the immutable object (parents, tree, identity).
          // If this fails, the commit is forged or has an unreviewed tree.
          // Mark ambiguous without any filesystem mutation.
          options.runtime.verifyRecoveredIntegrationObject({
            project_root: options.project_root,
            project_identity_sha256: next.project_identity_sha256,
            integration_branch: next.integration_branch,
            expected_target_commit: intent.expected_target_commit,
            source_checkpoint_commit: intent.expected_source_commit,
            result_commit: head,
          })
          // Step 2: The object is valid. Verify the checkout matches.
          // If the checkout is stale, try non-destructive repair (only if
          // the worktree is clean and at the expected target commit).
          try {
            options.runtime.verifyRecoveredIntegration({
              project_root: options.project_root,
              project_identity_sha256: next.project_identity_sha256,
              integration_branch: next.integration_branch,
              expected_target_commit: intent.expected_target_commit,
              source_checkpoint_commit: intent.expected_source_commit,
              result_commit: head,
            })
          } catch {
            // Checkout verification failed. Try safe repair.
            options.runtime.repairRecoveredIntegration({
              project_root: options.project_root,
              project_identity_sha256: next.project_identity_sha256,
              integration_branch: next.integration_branch,
              expected_target_commit: intent.expected_target_commit,
              source_checkpoint_commit: intent.expected_source_commit,
              result_commit: head,
            })
          }
          const item = next.items[intent.item_id]!
          next = transitionEpicItemToIntegrated(next, intent.item_id, {
            event_id: compositeId(intent.intent_id, 'recovered'),
            dependency_snapshot_sha256: computeDependencySnapshotDigest(next, item),
            source_commit: intent.expected_source_commit,
            previous_target_commit: intent.expected_target_commit,
            target_commit: head,
            review_evidence_digest: intent.review_evidence_digest,
            recorded_at: timestamp(next, options.now()),
          })
          recoveredIntegrationHead = head
        } catch {
          ambiguous = true
          hasAmbiguousIntegration = true
          reasons.push('integration_tree_mismatch')
        }
      } else {
        ambiguous = true
        hasAmbiguousIntegration = true
        reasons.push('integration_ambiguous')
      }
    } else {
      ambiguous = true
      hasAmbiguousIntegration = true
      reasons.push('integration_ambiguous')
    }
  }

  const at = timestamp(next, options.now())
  next.state_revision = current.state.state_revision + 1
  next.updated_at = at
  next.status = 'paused'
  next.pause_code = hasAmbiguousUsage
    ? 'usage_accounting_ambiguous'
    : hasAmbiguousReview
    ? 'ambiguous_reviewer_launch'
    : hasAmbiguousExecution ? 'ambiguous_execution_launch'
      : hasAmbiguousIntegration ? 'integration_ambiguous'
        : reasons.includes('integration_undispatched') ? 'integration_undispatched' : 'operator_reconciled'
  next.pause_reason = ambiguous
    ? 'Attended restart found ambiguous work that requires owner resolution.'
    : 'Attended restart reconciliation completed; explicit authorization is required to resume.'
  next.usage = closeEpicUsageIntervals(next.usage, at)
  if (recoveredIntegrationHead !== null
    && options.runtime.integrationHead(options.project_root, next.integration_branch) !== recoveredIntegrationHead) {
    throw new Error('integration branch changed before recovered state could be persisted')
  }
  const loaded = options.store.reconcile(next, current.revision, current.state_sha256, current.ownership_generation)
  if (!loaded) throw new Error('epic recovery did not persist')
  return { loaded, ambiguous, reasons }
  })
}
