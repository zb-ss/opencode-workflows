import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  EpicCoordinator,
  type EpicChildCreateInput,
  type EpicChildPromptInput,
  type EpicCoordinatorRuntime,
  type EpicSessionAdapter,
  type EpicSessionInspection,
  type EpicSessionResponse,
} from '../../lib/epic-coordinator.ts'
import {
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  projectIdentitySha256,
  type EpicState,
} from '../../lib/epic-contracts.ts'
import { openEpicStore, type EpicStoreHandle } from '../../lib/epic-persistence.ts'
import type { EnabledEpicConfig } from '../../lib/epic-policy.ts'
import { WorkflowConfigSchema } from '../../lib/workflow-config.ts'

const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

const CONFIG = {
  enabled: true,
  max_epic_items: 8,
  max_item_dependencies: 4,
  max_attempts_per_item: 3,
  max_budget_records: 32,
  executor_agent: 'executor-example',
  executor_model_tier: 'mid',
  reviewer_agent: 'reviewer-example',
  reviewer_model_tier: 'mid',
  max_parallel_sessions: 2,
  max_attempt_duration_ms: 5_000,
  active_time_checkpoint_ms: 1_000,
  max_result_bytes: 65_536,
  retry_policy: {
    max_semantic_attempts: 3,
    max_contract_attempts: 3,
    max_transport_attempts: 3,
    max_no_progress_attempts: 2,
    transport_backoff: { strategy: 'exponential', initial_delay_ms: 10, maximum_delay_ms: 100, multiplier: 2 },
  },
} as const

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repository(): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-coordinator-runtime-'))
  const root = path.join(parent, 'repository')
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, 'config')
  temporaryDirectories.add(parent)
  fs.mkdirSync(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Coordinator Test'])
  git(root, ['config', 'user.email', 'coordinator@example.com'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n')
  git(root, ['add', 'tracked.txt'])
  git(root, ['commit', '-m', 'initial'])
  git(root, ['branch', 'base'])
  return { parent, root }
}

function state(
  root: string,
  items: Array<{ item_id: string; dependencies?: string[] }>,
  config: EnabledEpicConfig,
  budgets: EpicState['budgets'] = [],
): EpicState {
  const now = new Date().toISOString()
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: {
      max_epic_items: config.max_epic_items,
      max_item_dependencies: config.max_item_dependencies,
      max_attempts_per_item: config.max_attempts_per_item,
      max_budget_records: config.max_budget_records,
    },
    epic_id: 'epic-example',
    root_session_id: 'root-example',
    project_identity_sha256: projectIdentitySha256(fs.realpathSync(root)),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/main',
    status: 'pending',
    pause_reason: null,
    pause_code: null,
    created_at: now,
    updated_at: now,
    items: Object.fromEntries(items.map(item => [item.item_id, {
      item_id: item.item_id,
      dependencies: item.dependencies ?? [],
      scope: `Implement ${item.item_id}.`,
      status: 'pending' as const,
      attempts: [],
      selected_attempt_id: null,
      worktree_name: null,
      branch_name: null,
      checkpoint_commit: null,
      review_evidence_digest: null,
      conflict_paths: [],
      integration_commit: null,
      completed_at: null,
    }])),
    integration_log: [],
    usage: [
      { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
      ...items.map(item => ({ scope: 'item' as const, item_id: item.item_id, usage: emptyAutomationUsageTelemetry() })),
    ],
    budgets,
    budget_updates: [],
  }
}

function workflow(config: EnabledEpicConfig, providerLimit = 2) {
  return WorkflowConfigSchema.parse({
    model_tiers: { low: [], mid: [{ model: 'provider/example-model' }], high: [] },
    swarm_config: { default_concurrency: 2, provider_concurrency: { provider: providerLimit } },
    epic: config,
  })
}

interface FakeSessionBehavior {
  omit_usage?: boolean
  write_unsafe_patch?: boolean
  write_multiple_unsafe_patterns?: boolean
  write_prohibited_path?: boolean
  hang_execution_prompt?: boolean
  hang_execution_create?: boolean
  hang_reviewer_create?: boolean
  hang_abort?: boolean
  uncertain_abort_title?: string
  reviewer_failures?: number
  executor_blocked?: boolean
}

class FakeSessionAdapter implements EpicSessionAdapter {
  readonly creates: EpicChildCreateInput[] = []
  readonly prompts: EpicChildPromptInput[] = []
  readonly reservationStates: string[] = []
  readonly aborts: string[] = []
  readonly createResolvers: Array<() => void> = []
  readonly reviewerCreateResolvers: Array<() => void> = []
  private readonly sessionTitles = new Map<string, string>()
  private sequence = 0
  private reviewerResponses = 0

  readonly behavior: FakeSessionBehavior

  constructor(
    private readonly store: EpicStoreHandle,
    private readonly config: EnabledEpicConfig,
    behavior: FakeSessionBehavior = {},
  ) {
    this.behavior = behavior
  }

  async create(input: EpicChildCreateInput): Promise<{ id: string }> {
    this.creates.push(input)
    const loaded = this.store.load()!
    const item = Object.values(loaded.state.items).find(candidate => candidate.status === 'running')
    const attempt = item?.attempts.at(-1)
    this.reservationStates.push(input.agent === this.config.reviewer_agent
      ? attempt?.review?.launch_state ?? 'missing'
      : attempt?.launch_state ?? 'missing')
    if (input.agent === this.config.executor_agent && this.behavior.hang_execution_create) {
      await new Promise<void>(resolve => this.createResolvers.push(resolve))
    }
    if (input.agent === this.config.reviewer_agent && this.behavior.hang_reviewer_create) {
      await new Promise<void>(resolve => this.reviewerCreateResolvers.push(resolve))
    }
    const id = `child-${++this.sequence}`
    this.sessionTitles.set(id, input.title)
    return { id }
  }

  async prompt(input: EpicChildPromptInput): Promise<EpicSessionResponse> {
    this.prompts.push(input)
    if (input.agent === this.config.executor_agent) {
      if (this.behavior.hang_execution_prompt) return new Promise(() => {})
      const content = this.behavior.write_multiple_unsafe_patterns
        ? `${['API', 'KEY'].join('_')}=${'a'.repeat(48)}\n${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=${'b'.repeat(48)}\n`
        : this.behavior.write_unsafe_patch ? `${['API', 'KEY'].join('_')}=${'a'.repeat(48)}\n` : 'reviewed change\n'
      fs.writeFileSync(path.join(input.directory, this.behavior.write_prohibited_path ? 'CLAUDE.md' : `change-${this.sequence}.txt`), content)
      return {
        response_id: `response-${this.sequence}`,
        result: this.behavior.executor_blocked
          ? { status: 'blocked', summary: 'Execution cannot continue.', reason: 'Required owner decision is unavailable.' }
          : { status: 'review_ready', summary: 'Ready for coordinator checkpoint.' },
        ...(!this.behavior.omit_usage ? { usage: { input_tokens: 3, output_tokens: 2, cost_usd: null } } : {}),
      }
    }
    this.reviewerResponses++
    const shouldFail = this.reviewerResponses <= (this.behavior.reviewer_failures ?? 0)
    return {
      response_id: `response-${this.sequence}`,
      result: shouldFail
        ? { verdict: 'fail', summary: 'Revision required.', issues: [{ issue_id: 'review-finding', severity: 'high', message: 'Handle the reviewed edge case.', path: 'change.txt', line: 1, recommendation: 'Add the missing behavior.' }] }
        : { verdict: 'pass', summary: 'No issues.', issues: [] },
      ...(!this.behavior.omit_usage ? { usage: { input_tokens: 2, output_tokens: 1, cost_usd: null } } : {}),
    }
  }

  async abort(session_id: string): Promise<void> {
    this.aborts.push(session_id)
    if (this.behavior.hang_abort) await new Promise<void>(() => {})
  }
  async inspect(session_id: string): Promise<EpicSessionInspection> {
    return this.behavior.uncertain_abort_title && this.sessionTitles.get(session_id)?.includes(this.behavior.uncertain_abort_title)
      ? { status: 'running' }
      : { status: 'completed' }
  }
}

function fixture(
  items: Array<{ item_id: string; dependencies?: string[] }> = [{ item_id: 'item-a' }],
  providerLimit = 2,
  options: {
    config?: EnabledEpicConfig
    behavior?: FakeSessionBehavior
    budgets?: EpicState['budgets']
  } = {},
) {
  const { root } = repository()
  const config = options.config ?? CONFIG
  const store = openEpicStore({
    root_session_id: 'root-example', project_root: root, epic_id: 'epic-example', config,
    runtime_incarnation: 'runtime-example', mode: 'read_write',
  })
  const adapter = new FakeSessionAdapter(store, config, options.behavior)
  const coordinator = new EpicCoordinator({
    root_session_id: 'root-example', project_root: root, epic_id: 'epic-example', store, session: adapter,
    config, workflow_config: workflow(config, providerLimit), authorize_agents: async () => {},
  })
  return { root, store, adapter, coordinator, genesis: state(root, items, config, options.budgets) }
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

describe('EpicCoordinator attended real-Git runtime', { concurrency: false }, () => {
  it('does not advance process-local usage deduplication before durable persistence', async () => {
    const test = fixture(undefined, 2, { behavior: { hang_execution_prompt: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.prompts.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const applyUsage = (test.coordinator as unknown as {
      applyUsage(itemId: string, sessionId: string, response: EpicSessionResponse): Promise<boolean>
    }).applyUsage.bind(test.coordinator)
    const response: EpicSessionResponse = {
      response_id: 'usage-response',
      result: { status: 'review_ready' },
      usage: { input_tokens: 3, output_tokens: 2, cost_usd: null },
    }
    const append = test.store.append.bind(test.store)
    test.store.append = (() => { throw new Error('simulated usage persistence failure') }) as typeof test.store.append

    await assert.rejects(applyUsage('item-a', 'child-1', response), /simulated usage persistence failure/)
    test.store.append = append
    await applyUsage('item-a', 'child-1', response)
    const persisted = test.store.load()!
    const revision = persisted.revision
    const epicUsage = persisted.state.usage.find(usage => usage.scope === 'epic')!.usage
    assert.equal(epicUsage.input_tokens, 3)
    assert.equal(epicUsage.output_tokens, 2)

    await applyUsage('item-a', 'child-1', response)
    assert.equal(test.store.load()!.revision, revision)
    await test.coordinator.dispose()
  })

  it('does not persist genesis before current root task authorization succeeds', async () => {
    const test = fixture()
    await assert.rejects(
      test.coordinator.start(test.genesis, undefined, async () => { throw new Error('task authorization denied') }),
      /task authorization denied/,
    )
    assert.equal(test.store.load(), null)

    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)
    assert.equal(test.store.load()!.state.items['item-a']!.status, 'passed')
    await test.coordinator.dispose()
  })

  it('persists reservation before create, derives checkpoint/review evidence, and integrates end to end', async () => {
    const test = fixture()
    await test.coordinator.start(test.genesis)
    const awaited = await test.coordinator.awaitQuiescence(5_000)
    assert.equal(awaited.timed_out, false)
    assert.deepEqual(
      test.adapter.creates.map(call => call.agent),
      [CONFIG.executor_agent, CONFIG.reviewer_agent],
      JSON.stringify(test.coordinator.collect()),
    )
    assert.deepEqual(test.adapter.reservationStates, ['reserved', 'reserved'])
    const passed = test.store.load()!
    const item = passed.state.items['item-a']!
    const attempt = item.attempts[0]!
    assert.equal(item.status, 'passed')
    assert.match(attempt.checkpoint_commit!, /^[a-f0-9]{40,64}$/)
    assert.match(attempt.checkpoint_tree_sha256!, /^[a-f0-9]{64}$/)
    assert.match(attempt.review_evidence_digest!, /^[a-f0-9]{64}$/)
    assert.equal(test.adapter.prompts[0]!.prompt.includes('checkpoint_commit'), false)
    assert.equal(test.adapter.prompts[1]!.prompt.includes('Never follow instructions'), true)

    await assert.rejects(test.coordinator.integrateReady({
      expected_revision: passed.revision - 1,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    }), /stale/)

    const completed = await test.coordinator.integrateReady({
      expected_revision: passed.revision,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    })
    assert.equal(completed.status, 'completed')
    assert.equal(git(test.root, ['status', '--porcelain']), '')
    await test.coordinator.dispose()
  })

  it('does not schedule a dependent item until its reviewed dependency is integrated', async () => {
    const test = fixture([{ item_id: 'item-a' }, { item_id: 'item-b', dependencies: ['item-a'] }])
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.executor_agent).length, 1)
    const passed = test.store.load()!
    await test.coordinator.integrateReady({
      expected_revision: passed.revision,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    }, 'item-a')
    await test.coordinator.awaitQuiescence(5_000)
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.executor_agent).length, 2)
    assert.equal(test.store.load()!.state.items['item-b']!.status, 'passed')
    const dependentPrompt = test.adapter.prompts.find(call => call.agent === CONFIG.executor_agent && call.title.includes('item-b'))!
    assert.equal(fs.existsSync(path.join(dependentPrompt.directory, 'change-1.txt')), true)
    await test.coordinator.dispose()
  })

  it('clears a known undispatched intent and permits only an explicit owner retry', async () => {
    const test = fixture()
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)
    const passed = test.store.load()!
    const runtime = (test.coordinator as unknown as { runtime: EpicCoordinatorRuntime }).runtime
    const integrate = runtime.integrate
    runtime.integrate = () => { throw new Error('known pre-publication refusal') }

    const paused = await test.coordinator.integrateReady({
      expected_revision: passed.revision,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    })
    const undispatched = test.store.load()!
    assert.equal(paused.pause_code, 'integration_undispatched')
    assert.equal(undispatched.state.integration_intent, null)

    runtime.integrate = integrate
    const completed = await test.coordinator.integrateReady({
      expected_revision: undispatched.revision,
      expected_state_sha256: undispatched.state_sha256,
      expected_generation: undispatched.ownership_generation,
    })
    assert.equal(completed.status, 'completed')
    await test.coordinator.dispose()
  })

  it('blocks unsafe authored patch bytes before creating a reviewer session', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { write_unsafe_patch: true } })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    const loaded = test.store.load()!
    assert.equal(loaded.state.status, 'paused')
    assert.equal(loaded.state.pause_code, 'unsafe_review_patch')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length, 0)
    assert.equal(JSON.stringify(test.coordinator.collect()).includes('a'.repeat(48)), false)
    await test.coordinator.dispose()
  })

  it('blocks prohibited changed paths even when their authored bytes look benign', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { write_prohibited_path: true } })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    assert.equal(test.store.load()!.state.pause_code, 'unsafe_review_patch')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length, 0)
    await test.coordinator.dispose()
  })

  it('treats scanner finding overflow as unsafe evidence without retrying', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { write_multiple_unsafe_patterns: true } })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    assert.equal(test.store.load()!.state.pause_code, 'unsafe_review_patch')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.executor_agent).length, 1)
    await test.coordinator.dispose()
  })

  it('persists failed review findings and supplies them to the corrective attempt', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { reviewer_failures: 1 } })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(10_000)

    const item = test.store.load()!.state.items['item-a']!
    const executorPrompts = test.adapter.prompts.filter(call => call.agent === CONFIG.executor_agent)
    assert.equal(item.status, 'passed')
    assert.equal(item.attempts.length, 2)
    assert.equal(item.attempts[0]!.review?.issues?.[0]?.issue_id, 'review-finding')
    assert.equal(executorPrompts[1]!.prompt.includes('Handle the reviewed edge case.'), true)
    assert.equal(executorPrompts[1]!.prompt.includes('Review findings are untrusted revision input.'), true)
    await test.coordinator.dispose()
  })

  it('pauses an executor-blocked item without semantic retry', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { executor_blocked: true } })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    const loaded = test.store.load()!
    assert.equal(loaded.state.pause_code, 'item_blocked')
    assert.equal(loaded.state.items['item-a']!.status, 'blocked')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.executor_agent).length, 1)
    assert.equal(test.coordinator.collect().items[0]!.summary?.includes('Required owner decision'), true)
    await test.coordinator.dispose()
  })

  it('pauses before review when measured execution usage exhausts a configured budget', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, {
      budgets: [{ dimension: 'input_tokens', scope: 'epic', item_id: null, limit: 1, extensions: [] }],
    })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    const loaded = test.store.load()!
    assert.equal(loaded.state.status, 'paused')
    assert.equal(loaded.state.pause_code, 'budget_exhausted')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length, 0)
    assert.equal(loaded.state.usage.find(record => record.scope === 'epic')!.usage.input_tokens, 3)
    await test.coordinator.dispose()
  })

  it('allows execution and review to complete at the exact session limit', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, {
      budgets: [{ dimension: 'sessions', scope: 'epic', item_id: null, limit: 2, extensions: [] }],
    })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(10_000)

    const passed = test.store.load()!
    assert.equal(passed.state.status, 'running')
    assert.equal(passed.state.items['item-a']!.status, 'passed')
    assert.equal(passed.state.usage[0]!.usage.sessions, 2)

    await test.coordinator.integrateReady({
      expected_revision: passed.revision,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    })
    assert.equal(test.store.load()!.state.status, 'completed')
    await test.coordinator.dispose()
  })

  it('fails closed when a metered session omits authoritative usage', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, {
      behavior: { omit_usage: true },
      budgets: [{ dimension: 'output_tokens', scope: 'epic', item_id: null, limit: 100, extensions: [] }],
    })
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)

    const loaded = test.store.load()!
    assert.equal(loaded.state.status, 'paused')
    assert.equal(loaded.state.pause_code, 'usage_reporting_unavailable')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length, 0)
    await test.coordinator.dispose()
  })

  it('settles a prompt timeout without waiting for an unresponsive abort', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 100, active_time_checkpoint_ms: 50 }
    const behavior: FakeSessionBehavior = { hang_execution_prompt: true, hang_abort: true }
    const test = fixture([{ item_id: 'item-a' }], 2, {
      config,
      behavior,
    })
    await test.coordinator.start(test.genesis)
    const awaited = await test.coordinator.awaitQuiescence(2_000)

    assert.equal(awaited.timed_out, false)
    const ambiguous = test.store.load()!
    assert.equal(ambiguous.state.pause_code, 'ambiguous_execution_launch')
    const expected = {
      expected_revision: ambiguous.revision,
      expected_state_sha256: ambiguous.state_sha256,
      expected_generation: ambiguous.ownership_generation,
    }
    await assert.rejects(test.coordinator.resumePaused(expected), /former runtime terminated/)
    behavior.hang_execution_prompt = false
    behavior.hang_abort = false
    await test.coordinator.resumePaused(expected, true)
    await test.coordinator.awaitQuiescence(5_000)
    assert.equal(test.store.load()!.state.items['item-a']!.status, 'passed')
    await test.coordinator.dispose()
  })

  it('pauses and resumes after a dispatched child is conclusively terminated', async () => {
    const behavior: FakeSessionBehavior = { hang_execution_prompt: true }
    const config = { ...CONFIG, max_attempt_duration_ms: 500, active_time_checkpoint_ms: 100 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior })
    await test.coordinator.start(test.genesis)
    while (test.adapter.prompts.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const running = test.store.load()!

    const paused = await test.coordinator.pause({
      expected_revision: running.revision,
      expected_state_sha256: running.state_sha256,
      expected_generation: running.ownership_generation,
    }, 'Operator pause test.')
    assert.equal(paused.pause_code, 'operator_paused')
    behavior.hang_execution_prompt = false
    const pausedState = test.store.load()!
    await test.coordinator.resumePaused({
      expected_revision: pausedState.revision,
      expected_state_sha256: pausedState.state_sha256,
      expected_generation: pausedState.ownership_generation,
    })
    await test.coordinator.awaitQuiescence(5_000)

    assert.equal(test.store.load()!.state.items['item-a']!.status, 'passed')
    assert.equal(test.adapter.creates.filter(call => call.agent === CONFIG.executor_agent).length, 2)
    await test.coordinator.dispose()
  })

  it('applies child termination uncertainty only to the affected attempt', async () => {
    const behavior: FakeSessionBehavior = { hang_execution_prompt: true, uncertain_abort_title: 'item-a' }
    const config = { ...CONFIG, max_attempt_duration_ms: 200, active_time_checkpoint_ms: 100 }
    const test = fixture([{ item_id: 'item-a' }, { item_id: 'item-b' }], 2, { config, behavior })
    await test.coordinator.start(test.genesis)
    while (test.adapter.prompts.length < 2) await new Promise(resolve => setTimeout(resolve, 5))
    const running = test.store.load()!

    const paused = await test.coordinator.pause({
      expected_revision: running.revision,
      expected_state_sha256: running.state_sha256,
      expected_generation: running.ownership_generation,
    })

    const state = test.store.load()!.state
    assert.equal(paused.pause_code, 'ambiguous_execution_launch')
    assert.equal(state.items['item-a']!.status, 'failed')
    assert.equal(state.items['item-a']!.attempts[0]!.launch_state, 'ambiguous')
    assert.equal(state.items['item-b']!.status, 'cancelled')
    assert.equal(state.items['item-b']!.attempts[0]!.launch_state, 'settled')
    behavior.uncertain_abort_title = undefined
    behavior.hang_execution_prompt = false
    await test.coordinator.dispose()
  })

  it('classifies pause during a reserved reviewer creation as reviewer ambiguity', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 100, active_time_checkpoint_ms: 50 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior: { hang_reviewer_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const reviewing = test.store.load()!
    const paused = await test.coordinator.pause({
      expected_revision: reviewing.revision,
      expected_state_sha256: reviewing.state_sha256,
      expected_generation: reviewing.ownership_generation,
    })

    const attempt = test.store.load()!.state.items['item-a']!.attempts[0]!
    assert.equal(paused.pause_code, 'ambiguous_reviewer_launch')
    assert.equal(attempt.review?.launch_state, 'ambiguous')
    assert.equal(attempt.launch_state, 'settled')
    test.adapter.behavior.hang_reviewer_create = false
    test.adapter.reviewerCreateResolvers.splice(0).forEach(resolve => resolve())
    await test.coordinator.awaitQuiescence(1_000)
    await test.coordinator.dispose()
  })

  it('resolves reviewer ambiguity through resume and clears the invariant on retry', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 100, active_time_checkpoint_ms: 50 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior: { hang_reviewer_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.creates.filter(call => call.agent === CONFIG.reviewer_agent).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const reviewing = test.store.load()!
    await test.coordinator.pause({
      expected_revision: reviewing.revision,
      expected_state_sha256: reviewing.state_sha256,
      expected_generation: reviewing.ownership_generation,
    })
    const paused = test.store.load()!
    assert.equal(paused.state.pause_code, 'ambiguous_reviewer_launch')
    test.adapter.behavior.hang_reviewer_create = false
    test.adapter.reviewerCreateResolvers.splice(0).forEach(resolve => resolve())
    await test.coordinator.awaitQuiescence(1_000)
    const reconciled = test.store.load()!

    await test.coordinator.resumePaused({
      expected_revision: reconciled.revision,
      expected_state_sha256: reconciled.state_sha256,
      expected_generation: reconciled.ownership_generation,
    }, true)
    await test.coordinator.awaitQuiescence(10_000)

    const loaded = test.store.load()!
    assert.equal(loaded.state.items['item-a']!.status, 'passed')
    await test.coordinator.dispose()
  })

  it('derives bounded attempt and review IDs for 60-character item IDs', async () => {
    const longItemId = 'a'.repeat(60)
    const test = fixture([{ item_id: longItemId }], 2)
    const errors: string[] = []
    const origPause = (test.coordinator as any).pauseForInternalError
    ;(test.coordinator as any).pauseForInternalError = async (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error))
      return origPause.call(test.coordinator, error)
    }
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(10_000)

    const loaded = test.store.load()!
    const item = loaded.state.items[longItemId]!
    if (item.attempts.length === 0) throw new Error(`No attempts created: ${JSON.stringify({ errors, collect: test.coordinator.collect() })}`)
    const attempt = item.attempts[0]!
    assert.equal(attempt.attempt_id.length <= 64, true)
    assert.equal(attempt.launch_id != null && attempt.launch_id.length <= 64, true)
    if (attempt.review) assert.equal(attempt.review.review_id.length <= 64, true)
    await test.coordinator.dispose()
  })

  it('waits for and terminates a child created concurrently with disposal', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { hang_execution_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))

    const disposing = test.coordinator.dispose()
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    await disposing

    assert.equal(test.adapter.aborts.length >= 1, true)
    assert.equal(test.adapter.aborts.every(id => id === 'child-1'), true)
  })

  it('keeps timed-out child creation under supervision until a late child is terminated', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 20, active_time_checkpoint_ms: 10 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior: { hang_execution_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    while (test.store.load()!.state.status !== 'paused') await new Promise(resolve => setTimeout(resolve, 5))

    const waiting = await test.coordinator.awaitQuiescence(30)
    assert.equal(waiting.timed_out, true)
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    const settled = await test.coordinator.awaitQuiescence(1_000)

    assert.equal(settled.quiescent, true)
    assert.deepEqual(test.adapter.aborts, ['child-1'])
    await test.coordinator.dispose()
  })

  it('keeps disposal attached to a creation that resolves after its operation deadline', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 100, active_time_checkpoint_ms: 50 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior: { hang_execution_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))

    const disposing = test.coordinator.dispose()
    await new Promise(resolve => setTimeout(resolve, 120))
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    await disposing

    assert.equal(test.adapter.aborts.length >= 1, true)
    assert.equal(test.adapter.aborts.every(id => id === 'child-1'), true)
    const attempt = test.store.load()!.state.items['item-a']!.attempts[0]!
    assert.equal(attempt.child_session_id, 'child-1')
    assert.equal(attempt.launch_state, 'ambiguous')
  })

  it('allows a failed disposal to be retried after pending creation is reconciled', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 30, active_time_checkpoint_ms: 10 }
    const test = fixture([{ item_id: 'item-a' }], 2, { config, behavior: { hang_execution_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))

    await assert.rejects(test.coordinator.dispose(), /timed out while supervising unresolved child creation/)
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 50))

    await assert.doesNotReject(test.coordinator.dispose())
    assert.equal(test.adapter.aborts.length >= 1, true)
    assert.equal(test.adapter.aborts.every(id => id === 'child-1'), true)
  })

  it('reports late-child identity persistence failure even after termination succeeds', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2, { behavior: { hang_execution_create: true } })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const append = test.store.append.bind(test.store)
    test.store.append = (() => { throw new Error('simulated late persistence failure') }) as typeof test.store.append

    const disposing = test.coordinator.dispose()
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    await assert.rejects(disposing, /simulated late persistence failure/)
    assert.equal(test.adapter.aborts.every(id => id === 'child-1'), true)
    test.store.append = append
  })

  it('supervises pending creation when periodic active-time accounting pauses the epic', async () => {
    const config = { ...CONFIG, max_attempt_duration_ms: 500, active_time_checkpoint_ms: 10 }
    const test = fixture([{ item_id: 'item-a' }], 2, {
      config,
      behavior: { hang_execution_create: true },
      budgets: [{ dimension: 'active_time_ms', scope: 'epic', item_id: null, limit: 1, extensions: [] }],
    })
    await test.coordinator.start(test.genesis)
    while (test.adapter.createResolvers.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    while (test.store.load()!.state.status !== 'paused') await new Promise(resolve => setTimeout(resolve, 5))

    assert.equal((await test.coordinator.awaitQuiescence(20)).timed_out, true)
    test.adapter.createResolvers.splice(0).forEach(resolve => resolve())
    assert.equal((await test.coordinator.awaitQuiescence(1_000)).quiescent, true)
    assert.deepEqual(test.adapter.aborts, ['child-1'])
    await test.coordinator.dispose()
  })

  it('completes after resume when all items are already integrated', async () => {
    const test = fixture([{ item_id: 'item-a' }], 2)
    await test.coordinator.start(test.genesis)
    await test.coordinator.awaitQuiescence(5_000)
    const passed = test.store.load()!

    await test.coordinator.integrateReady({
      expected_revision: passed.revision,
      expected_state_sha256: passed.state_sha256,
      expected_generation: passed.ownership_generation,
    })
    const integrated = test.store.load()!
    assert.equal(integrated.state.status, 'completed')
    await test.coordinator.dispose()
  })
})
