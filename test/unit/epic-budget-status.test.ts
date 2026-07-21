import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EPIC_BUDGET_DIMENSIONS,
  EPIC_SCHEMA_VERSION,
  emptyAutomationUsageTelemetry,
  epicBudgetDecision,
  projectEpicBudgetStatus,
  type EpicState,
} from '../../lib/epic-contracts.ts'
import { epicStatusOnly } from '../../lib/epic-persistence.ts'

const NOW = '2026-07-18T12:00:00.000Z'
const LATER = '2026-07-18T12:05:00.000Z'
const SHA = (character: string) => character.repeat(64)

function state(): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: { max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16 },
    epic_id: 'epic-1',
    root_session_id: 'session-1',
    project_identity_sha256: SHA('a'),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/integration',
    status: 'pending',
    pause_reason: null,
    created_at: NOW,
    updated_at: LATER,
    items: {
      'item-a': { item_id: 'item-a', dependencies: [], scope: 'First item.', status: 'pending', attempts: [], selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null, review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null },
      'item-b': { item_id: 'item-b', dependencies: [], scope: 'Second item.', status: 'pending', attempts: [], selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null, review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null },
    },
    budgets: [
      { dimension: 'sessions', scope: 'epic', item_id: null, limit: 3, extensions: [] },
      { dimension: 'input_tokens', scope: 'item', item_id: 'item-a', limit: 0, extensions: [] },
      { dimension: 'cost_usd', scope: 'epic', item_id: null, limit: 1, extensions: [] },
    ],
    integration_log: [],
    usage: [
      { scope: 'epic', item_id: null, usage: { ...emptyAutomationUsageTelemetry(), sessions: 2 } },
      { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
    ],
    budget_updates: [],
  }
}

describe('epic budget status projection', () => {
  it('surfaces configured, exhausted, blocked, and unconfigured dimensions without item identities', () => {
    const projected = projectEpicBudgetStatus(state())
    assert.deepEqual(Object.keys(projected), [...EPIC_BUDGET_DIMENSIONS])
    assert.deepEqual(projected.sessions.epic, { decision: 'within_limit' })
    assert.deepEqual(projected.input_tokens.item_decision_counts, { not_configured: 1, blocked: 0, within_limit: 0, exhausted: 1 })
    assert.deepEqual(projected.cost_usd.epic, { decision: 'blocked', reason: 'unknown_cost' })
    assert.deepEqual(projected.output_tokens.epic, { decision: 'not_configured' })
    assert.equal(JSON.stringify(projected).includes('item-a'), false)
  })

  it('provides exact trusted-state decisions while rejecting unknown item scopes', () => {
    assert.deepEqual(epicBudgetDecision(state(), 'item', 'item-a', 'input_tokens'), { decision: 'exhausted' })
    assert.deepEqual(epicBudgetDecision(state(), 'item', 'item-b', 'input_tokens'), { decision: 'not_configured' })
    assert.throws(() => epicBudgetDecision(state(), 'item', 'missing', 'sessions'), /unknown epic item/)
  })

  it('includes the aggregate projection in status-only output', () => {
    const status = epicStatusOnly(state(), SHA('b'), SHA('c'))
    assert.deepEqual(status.budget_dimensions.cost_usd.epic, { decision: 'blocked', reason: 'unknown_cost' })
    assert.equal(JSON.stringify(status).includes('item-a'), false)
  })
})
