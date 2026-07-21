import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  deriveEpicWorktreeIdentity,
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  EpicValidationError,
  EpicWorktreeEvidenceSchema,
  parseEpicWorktreeEvidence,
  validateEpicState,
  validateEpicTransition,
  type EpicAttempt,
  type EpicItem,
  type EpicState,
  type EpicWorktreeEvidence,
} from '../../lib/epic-contracts.ts'

const NOW = '2026-07-18T12:00:00.000Z'
const LATER = '2026-07-18T12:05:00.000Z'
const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)

function evidence(
  epic_id = 'epic-1',
  item_id = 'item-1',
  attempt_id = 'attempt-1',
  overrides: Partial<EpicWorktreeEvidence> = {},
): EpicWorktreeEvidence {
  return {
    ...deriveEpicWorktreeIdentity(epic_id, item_id, attempt_id),
    base_commit: OID('0'),
    worktree_path_sha256: SHA('1'),
    worktree_directory_dev: '1',
    worktree_directory_ino: '2',
    git_common_directory_sha256: SHA('2'),
    git_common_directory_dev: '3',
    git_common_directory_ino: '4',
    ...overrides,
  }
}

function runningAttempt(attempt_id = 'attempt-1'): EpicAttempt {
  return {
    attempt_id,
    worktree_evidence: evidence('epic-1', 'item-1', attempt_id),
    agent: 'executor',
    model: null,
    child_session_id: null,
    started_at: NOW,
    completed_at: null,
    checkpoint_commit: null,
    review_evidence_digest: null,
    result_summary: null,
    failure_classification: null,
    status: 'running',
  }
}

function item(attempt: EpicAttempt, overrides: Partial<EpicItem> = {}): EpicItem {
  return {
    item_id: 'item-1',
    dependencies: [],
    scope: 'Verify durable worktree provenance.',
    status: 'running',
    attempts: [attempt],
    selected_attempt_id: null,
    worktree_name: attempt.worktree_evidence.worktree_name,
    branch_name: attempt.worktree_evidence.branch_name,
    checkpoint_commit: null,
    review_evidence_digest: null,
    conflict_paths: [],
    integration_commit: null,
    completed_at: null,
    ...overrides,
  }
}

function state(epic_item: EpicItem, overrides: Partial<EpicState> = {}): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: { max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 },
    epic_id: 'epic-1',
    root_session_id: 'session-1',
    project_identity_sha256: SHA('a'),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/integration',
    status: 'running',
    pause_reason: null,
    created_at: NOW,
    updated_at: NOW,
    items: { 'item-1': epic_item },
    integration_log: [],
    usage: [{ scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() }],
    budget_updates: [],
    ...overrides,
  }
}

describe('epic attempt worktree evidence binding', () => {
  it('keeps derivation filesystem-free and rejects Git-invalid identity components and oversized inode evidence', () => {
    assert.equal(deriveEpicWorktreeIdentity('epic-1', 'item-1', 'attempt-1').branch_name, 'epic/epic-1/item-1/attempt-1')
    for (const invalid of ['a..b', 'attempt.lock', 'attempt.']) {
      assert.throws(() => deriveEpicWorktreeIdentity('epic-1', 'item-1', invalid), /safe identifier/)
    }
    assert.equal(EpicWorktreeEvidenceSchema.safeParse({ ...evidence(), attempt_id: 'a..b' }).success, false)
    assert.throws(() => parseEpicWorktreeEvidence(evidence('epic-1', 'item-1', 'attempt-1', { worktree_directory_ino: '1'.repeat(21) })))
  })

  it('requires evidence and cross-binds it to the containing epic, item, and attempt', () => {
    const attempt = runningAttempt()
    assert.doesNotThrow(() => validateEpicState(state(item(attempt))))
    assert.throws(() => validateEpicState(state(item({
      ...attempt,
      worktree_evidence: { ...attempt.worktree_evidence, attempt_id: 'a..b' },
    }))), EpicValidationError)

    const { worktree_evidence: _omitted, ...without_evidence } = attempt
    assert.throws(() => validateEpicState(state(item(attempt), {
      items: { 'item-1': { ...item(attempt), attempts: [without_evidence as EpicAttempt] } },
    })), EpicValidationError)

    const forged = [
      evidence('other-epic', 'item-1', 'attempt-1'),
      evidence('epic-1', 'other-item', 'attempt-1'),
      evidence('epic-1', 'item-1', 'other-attempt'),
    ]
    for (const worktree_evidence of forged) {
      assert.throws(() => validateEpicState(state(item({ ...attempt, worktree_evidence }))), /containing epic|containing item|containing attempt/)
    }
  })

  it('binds running and selected terminal item fields to the corresponding attempt', () => {
    const running = runningAttempt()
    assert.throws(() => validateEpicState(state(item(running, { branch_name: 'epic/epic-1/item-1/other-attempt' }))), /running attempt/)

    const passed: EpicAttempt = {
      ...running,
      status: 'passed',
      completed_at: LATER,
      checkpoint_commit: OID('1'),
      review_evidence_digest: SHA('b'),
      result_summary: 'Passed review.',
    }
    const passed_item = item(passed, {
      status: 'passed',
      selected_attempt_id: passed.attempt_id,
      checkpoint_commit: passed.checkpoint_commit,
      review_evidence_digest: passed.review_evidence_digest,
      completed_at: LATER,
    })
    assert.doesNotThrow(() => validateEpicState(state(passed_item, { updated_at: LATER })))
    assert.throws(() => validateEpicState(state({ ...passed_item, worktree_name: 'epic-000000000000000000000000' }, { updated_at: LATER })), /selected passed attempt/)
  })

  it('freezes evidence before settlement and preserves it through attended cancellation', () => {
    const running = runningAttempt()
    const previous = state(item(running))
    const cancelled: EpicAttempt = {
      ...running,
      status: 'cancelled',
      completed_at: LATER,
      result_summary: 'Cancelled during recovery.',
      failure_classification: 'cancelled',
    }
    const next = state(item(cancelled, { status: 'cancelled', completed_at: LATER }), {
      state_revision: 2,
      status: 'paused',
      pause_code: 'operator_reconciled',
      pause_reason: 'Operator reconciled interrupted work.',
      updated_at: LATER,
    })
    assert.doesNotThrow(() => validateEpicTransition(previous, next))
    const swapped = {
      ...next,
      items: { 'item-1': { ...next.items['item-1']!, attempts: [{ ...cancelled, worktree_evidence: { ...cancelled.worktree_evidence, worktree_directory_ino: '9' } }] } },
    }
    assert.throws(() => validateEpicTransition(previous, swapped), /worktree_evidence is immutable/)
  })

  it('clears queued retry selection while retaining immutable history and binds direct retries to fresh evidence', () => {
    const running = runningAttempt()
    const failed: EpicAttempt = {
      ...running,
      status: 'failed',
      completed_at: LATER,
      result_summary: 'Contract failed.',
      failure_classification: 'contract',
    }
    const previous = state(item(failed, { status: 'failed', completed_at: LATER }), { updated_at: LATER })
    const stale = evidence('epic-1', 'item-1', 'older-attempt')
    assert.throws(() => validateEpicState({
      ...previous,
      items: { 'item-1': { ...previous.items['item-1']!, worktree_name: stale.worktree_name, branch_name: stale.branch_name } },
    }), /final attempt/)
    assert.throws(() => validateEpicState({
      ...previous,
      items: { 'item-1': { ...previous.items['item-1']!, branch_name: null } },
    }), /both worktree fields/)
    const queued = state(item(failed, {
      status: 'queued',
      worktree_name: null,
      branch_name: null,
      completed_at: null,
    }), { state_revision: 2, updated_at: LATER })
    assert.deepEqual(validateEpicTransition(previous, queued).items['item-1']!.attempts[0]!.worktree_evidence, failed.worktree_evidence)

    const fresh = { ...runningAttempt('attempt-2'), started_at: LATER }
    const retried = state(item(fresh, { attempts: [failed, fresh] }), { state_revision: 2, updated_at: LATER })
    assert.equal(validateEpicTransition(previous, retried).items['item-1']!.worktree_name, fresh.worktree_evidence.worktree_name)
    assert.throws(() => validateEpicTransition(previous, {
      ...retried,
      items: { 'item-1': { ...retried.items['item-1']!, worktree_name: failed.worktree_evidence.worktree_name, branch_name: failed.worktree_evidence.branch_name } },
    }), /running attempt/)
  })
})
