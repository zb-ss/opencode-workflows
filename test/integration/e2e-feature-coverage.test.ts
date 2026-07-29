import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { FencingLeaseStore, assertFencingGeneration, FencingLeaseError } from '../../lib/fencing-lease.ts'
import { QueueStore } from '../../lib/queue-store.ts'
import { QueueScheduler } from '../../lib/queue-scheduler.ts'
import { QueueRateLimiter } from '../../lib/queue-rate-limiter.ts'
import { enabledQueue } from '../../lib/queue-policy.ts'
import { loadWorkflowConfig, WorkflowConfigSchema } from '../../lib/workflow-config.ts'
import {
  EpicCoordinator,
  type EpicChildCreateInput,
  type EpicChildPromptInput,
  type EpicSessionAdapter,
  type EpicSessionInspection,
  type EpicSessionResponse,
} from '../../lib/epic-coordinator.ts'
import { openEpicStore } from '../../lib/epic-persistence.ts'
import { loadAutomaticWorkflowState } from '../../lib/workflow-engine.ts'
import {
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  projectIdentitySha256,
  type EpicState,
} from '../../lib/epic-contracts.ts'

const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.add(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories) fs.rmSync(dir, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

function setupGitRepo(): string {
  const parent = tempDir('e2e-')
  const root = path.join(parent, 'repo')
  process.env.OPENCODE_CONFIG_DIR = path.join(parent, 'config')
  fs.mkdirSync(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'E2E Test'])
  git(root, ['config', 'user.email', 'e2e@test.com'])
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])
  git(root, ['branch', 'base'])
  return root
}

const EPIC_CONFIG = {
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
    transport_backoff: { strategy: 'exponential' as const, initial_delay_ms: 10, maximum_delay_ms: 100, multiplier: 2 },
  },
} as const

const QUEUE_CONFIG = {
  enabled: true as const,
  max_concurrent_workflows: 2,
  lease_duration_ms: 60_000,
  renewal_interval_ms: 20_000,
  recovery_attempt_limit: 3,
  retry_policy: {
    max_semantic_attempts: 3,
    max_contract_attempts: 3,
    max_transport_attempts: 3,
    max_no_progress_attempts: 2,
    transport_backoff: { strategy: 'exponential' as const, initial_delay_ms: 100, maximum_delay_ms: 1_000, multiplier: 2 },
  },
  rate_windows: [{ window_ms: 60_000, max_requests: 100 }],
}

class FakeEpicSessionAdapter implements EpicSessionAdapter {
  readonly creates: EpicChildCreateInput[] = []
  readonly prompts: EpicChildPromptInput[] = []
  private sequence = 0

  async create(input: EpicChildCreateInput): Promise<{ id: string }> {
    this.creates.push(input)
    return { id: `child-${++this.sequence}` }
  }

  async prompt(input: EpicChildPromptInput): Promise<EpicSessionResponse> {
    this.prompts.push(input)
    if (input.agent === EPIC_CONFIG.executor_agent) {
      fs.writeFileSync(path.join(input.directory, `change-${this.sequence}.txt`), 'reviewed change\n')
      return {
        response_id: `response-${this.sequence}`,
        result: { status: 'review_ready', summary: 'Ready for checkpoint.' },
        usage: { input_tokens: 3, output_tokens: 2, cost_usd: null },
      }
    }
    return {
      response_id: `response-${this.sequence}`,
      result: { verdict: 'pass', summary: 'No issues.', issues: [] },
      usage: { input_tokens: 2, output_tokens: 1, cost_usd: null },
    }
  }

  async abort(): Promise<void> {}
  async inspect(): Promise<EpicSessionInspection> { return { status: 'completed' } }
}

describe('E2E: all new features', { concurrency: false }, () => {

  describe('1. optional budgets and active/calendar time (WorkflowEngine v2)', () => {
    it('runs a workflow with no budgets configured (telemetry-only)', () => {
      const configDir = tempDir('e2e-budget-')
      process.env.OPENCODE_CONFIG_DIR = configDir
      fs.writeFileSync(path.join(configDir, 'workflows.json'), JSON.stringify({
        automation: { enabled: true, autonomy: 'interactive', max_parallel_sessions: 2, max_sessions: 10, max_attempts_per_stage: 3 },
      }))
      const config = loadWorkflowConfig()
      assert.equal(config.automation.enabled, true)
      assert.equal(config.automation.max_input_tokens, undefined)
      assert.equal(config.automation.max_active_time_ms, undefined)
      assert.equal(config.automation.max_calendar_age_ms, undefined)
      assert.equal(config.automation.max_cost_usd, undefined)
    })

    it('accepts selective budget dimensions while omitting others', () => {
      const configDir = tempDir('e2e-budget-selective-')
      process.env.OPENCODE_CONFIG_DIR = configDir
      fs.writeFileSync(path.join(configDir, 'workflows.json'), JSON.stringify({
        automation: {
          enabled: true, autonomy: 'interactive',
          max_parallel_sessions: 2, max_sessions: 10, max_attempts_per_stage: 3,
          max_input_tokens: 1000000,
          max_cost_usd: 50,
        },
      }))
      const config = loadWorkflowConfig()
      assert.equal(config.automation.max_input_tokens, 1000000)
      assert.equal(config.automation.max_cost_usd, 50)
      assert.equal(config.automation.max_output_tokens, undefined)
      assert.equal(config.automation.max_active_time_ms, undefined)
    })

    it('migrates v1 state with max_wall_time_ms to v2 with max_calendar_age_ms', () => {
      const configDir = tempDir('e2e-migration-')
      process.env.OPENCODE_CONFIG_DIR = configDir
      const stateDir = path.join(configDir, 'workflows', 'runtime', 'sessions', 'test-hash')
      fs.mkdirSync(stateDir, { recursive: true })
      const v1State = {
        schema_version: 1,
        workflow_id: 'wf-old',
        definition_id: 'dev',
        definition_path: '/path/to/def.json',
        root_session_id: 'root-1',
        directory: '/project',
        worktree: '/project',
        mode: 'standard',
        autonomy: 'interactive',
        task: 'Test task',
        status: 'completed',
        pause_reason: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:01:00.000Z',
        stages: {
          'stage-1': {
            status: 'passed', attempt: 1, session_id: 'sess-1', agent: 'wf-executor',
            model: null, started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:30.000Z',
            result: { status: 'passed', summary: 'Done' }, error: null,
          },
        },
        budget: {
          limits: {
            max_sessions: 10, max_parallel_sessions: 2, max_attempts_per_stage: 3,
            max_wall_time_ms: 60000, max_input_tokens: 1000, max_output_tokens: 1000,
            max_bounded_read_bytes: 1024, max_bounded_write_bytes: 1024, max_validation_runs: 5,
            max_cost_usd: null,
          },
          usage: {
            sessions: 1, attempts: 1, input_tokens: 100, output_tokens: 50, cost_usd: 0,
            bounded_read_bytes: 0, bounded_write_bytes: 0, validation_runs: 0, messages: {},
          },
        },
      }
      fs.writeFileSync(path.join(stateDir, 'workflow-auto.state.json'), JSON.stringify(v1State) + '\n', { mode: 0o600 })
      const migrated = loadAutomaticWorkflowState(path.join(stateDir, 'workflow-auto.state.json'))
      assert.equal(migrated.schema_version, 2)
      assert.equal('max_wall_time_ms' in migrated.budget.limits, false)
      assert.equal(migrated.budget.limits.max_calendar_age_ms, 60000)
      assert.equal(migrated.budget.limits.max_active_time_ms, null)
      assert.equal(migrated.budget.usage.active_time_ms, 0)
      assert.equal(migrated.budget.usage.active_interval_started_at, null)
    })
  })

  describe('2. epic coordinator full lifecycle', () => {
    it('start → await → integrate → cleanup end-to-end', async () => {
      const root = setupGitRepo()
      const configDir = process.env.OPENCODE_CONFIG_DIR!
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(path.join(configDir, 'workflows.json'), JSON.stringify({
        model_tiers: { low: [], mid: [{ model: 'provider/example-model' }], high: [] },
        swarm_config: { default_concurrency: 2, provider_concurrency: { provider: 2 } },
        epic: EPIC_CONFIG,
      }))

      const store = openEpicStore({
        root_session_id: 'root-1', project_root: root, epic_id: 'epic-e2e',
        config: EPIC_CONFIG, runtime_incarnation: 'runtime-e2e', mode: 'read_write',
      })
      const adapter = new FakeEpicSessionAdapter()
      const workflowConfig = WorkflowConfigSchema.parse({
        model_tiers: { low: [], mid: [{ model: 'provider/example-model' }], high: [] },
        swarm_config: { default_concurrency: 2, provider_concurrency: { provider: 2 } },
        epic: EPIC_CONFIG,
      })
      const coordinator = new EpicCoordinator({
        root_session_id: 'root-1', project_root: root, epic_id: 'epic-e2e',
        store, session: adapter, config: EPIC_CONFIG, workflow_config: workflowConfig,
        authorize_agents: async () => {},
      })

      const now = new Date().toISOString()
      const genesis: EpicState = {
        schema_version: EPIC_SCHEMA_VERSION, state_revision: 1,
        operational_limits: {
          max_epic_items: EPIC_CONFIG.max_epic_items, max_item_dependencies: EPIC_CONFIG.max_item_dependencies,
          max_attempts_per_item: EPIC_CONFIG.max_attempts_per_item, max_budget_records: EPIC_CONFIG.max_budget_records,
        },
        epic_id: 'epic-e2e', root_session_id: 'root-1',
        project_identity_sha256: projectIdentitySha256(fs.realpathSync(root)),
        base_branch: 'refs/heads/base', integration_branch: 'refs/heads/main',
        status: 'pending', pause_reason: null, created_at: now, updated_at: now,
        items: {
          'item-a': {
            item_id: 'item-a', dependencies: [], scope: 'Implement the feature.', status: 'pending',
            attempts: [], selected_attempt_id: null, worktree_name: null, branch_name: null,
            checkpoint_commit: null, review_evidence_digest: null, conflict_paths: [],
            integration_commit: null, completed_at: null,
          },
        },
        integration_log: [],
        usage: [
          { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
          { scope: 'item', item_id: 'item-a', usage: emptyAutomationUsageTelemetry() },
        ],
        budget_updates: [],
      }

      await coordinator.start(genesis)
      const awaited = await coordinator.awaitQuiescence(10_000)
      assert.equal(awaited.timed_out, false)
      const passed = store.load()!
      assert.equal(passed.state.items['item-a']!.status, 'passed')

      const completed = await coordinator.integrateReady({
        expected_revision: passed.revision,
        expected_state_sha256: passed.state_sha256,
        expected_generation: passed.ownership_generation,
      })
      assert.equal(completed.status, 'completed')
      assert.equal(git(root, ['status', '--porcelain']), '')

      const cleaned = coordinator.cleanup({
        expected_revision: store.load()!.revision,
        expected_state_sha256: store.load()!.state_sha256,
        expected_generation: store.load()!.ownership_generation,
      }, 'item-a')
      assert.deepEqual(cleaned.cleaned, ['item-a'])
      await coordinator.dispose()
    })
  })

  describe('3. fencing lease multiprocess', () => {
    function raceWorker(leaseDir: string, barrier: string, workerId: string, durationMs: string): Promise<{ code: number | null; stdout: string }> {
      return new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/fencing-race-worker.ts', leaseDir, barrier, workerId, durationMs], { cwd: path.resolve('.') })
        let output = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
        child.on('close', (code: number | null) => resolve({ code, stdout: output.trim() }))
      })
    }

    it('exactly one process wins a real multiprocess acquisition race', async () => {
      const dir = tempDir('e2e-fencing-')
      const barrier = path.join(dir, 'barrier')
      fs.mkdirSync(barrier)

      const resultsPromise = Promise.all([
        raceWorker(dir, barrier, 'a', '60000'),
        raceWorker(dir, barrier, 'b', '60000'),
        raceWorker(dir, barrier, 'c', '60000'),
      ])
      while (!fs.existsSync(path.join(barrier, 'ready-a')) || !fs.existsSync(path.join(barrier, 'ready-b')) || !fs.existsSync(path.join(barrier, 'ready-c'))) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      fs.writeFileSync(path.join(barrier, 'go'), '')
      const results = await resultsPromise

      const parsed = results.map(r => { try { return JSON.parse(r.stdout) } catch { return null } }).filter(Boolean) as Array<{ won: boolean; generation?: number }>
      const winners = parsed.filter(r => r.won)
      assert.equal(winners.length, 1)
      assert.equal(winners[0].generation, 1)
    })

    it('takes over after expiry and rejects stale writers', () => {
      const dir = tempDir('e2e-fencing-takeover-')
      const now = { val: Date.now() }
      const storeA = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-a', lease_duration_ms: 1000, now: () => now.val })
      const handleA = storeA.acquire()
      const genA = handleA.lease.fencing_generation

      now.val += 1100

      const storeB = new FencingLeaseStore({ lease_directory: dir, owner: 'proc-b', lease_duration_ms: 1000, now: () => now.val })
      const handleB = storeB.acquire()
      assert.equal(handleB.lease.fencing_generation, genA + 1)
      assert.equal(handleA.is_valid(), false)
      assert.throws(() => assertFencingGeneration(storeA, genA), (err: Error) => err instanceof FencingLeaseError)
    })
  })

  describe('4. durable queue lifecycle', () => {
    it('enqueue → schedule → pause → resume → cancel → recover', () => {
      const dir = tempDir('e2e-queue-')
      const now = { val: Date.parse('2026-07-25T00:00:00.000Z') }
      const store = new QueueStore({ config_directory: dir, owner: 'e2e-scheduler', now: () => now.val, lease_duration_ms: 60_000 })

      const scheduler = new QueueScheduler({
        store, config: enabledQueue(QUEUE_CONFIG), now: () => now.val,
      })
      const handle = scheduler.start()
      const gen = handle.generation

      const wf1 = store.enqueue({
        workflow_id: 'wf-1', definition_id: 'dev', root_session_id: 'root-1',
        directory: '/project', worktree: '/project', mode: 'standard', task: 'Task 1',
      }, handle.lease)
      assert.equal(wf1.status, 'queued')

      const wf2 = store.enqueue({
        workflow_id: 'wf-2', definition_id: 'dev', root_session_id: 'root-1',
        directory: '/project', worktree: '/project', mode: 'standard', task: 'Task 2',
      }, handle.lease)
      assert.equal(wf2.status, 'queued')

      scheduler.schedule()

      const indexAfterSchedule = store.rebuildIndex()
      assert.equal(indexAfterSchedule.filter(e => e.status === 'leased').length, 2)

      const loaded = store.load('wf-1')!
      store.update('wf-1', loaded.state_revision, handle.lease, (r) => { r.status = 'paused'; r.pause_reason = 'Manual pause'; return r })
      assert.equal(store.load('wf-1')!.status, 'paused')

      const paused = store.load('wf-1')!
      store.update('wf-1', paused.state_revision, handle.lease, (r) => { r.status = 'queued'; r.pause_reason = null; return r })
      assert.equal(store.load('wf-1')!.status, 'queued')

      const resumed = store.load('wf-2')!
      store.update('wf-2', resumed.state_revision, handle.lease, (r) => { r.status = 'cancelled'; r.pause_reason = 'Not needed'; return r })
      assert.equal(store.load('wf-2')!.status, 'cancelled')

      const finalIndex = store.rebuildIndex()
      assert.equal(finalIndex.length, 2)
      assert.equal(finalIndex.find(e => e.workflow_id === 'wf-1')!.status, 'queued')
      assert.equal(finalIndex.find(e => e.workflow_id === 'wf-2')!.status, 'cancelled')

      scheduler.dispose()
    })

    it('rate limiter enforces windows and survives crash', () => {
      const dir = tempDir('e2e-rate-')
      const now = { val: Date.parse('2026-07-25T00:00:00.000Z') }
      const limiter1 = new QueueRateLimiter({
        rate_directory: dir, windows: [{ window_ms: 60_000, max_requests: 3 }], now: () => now.val,
      })
      assert.equal(limiter1.tryAcquire(), true)
      assert.equal(limiter1.tryAcquire(), true)
      assert.equal(limiter1.tryAcquire(), true)
      assert.equal(limiter1.tryAcquire(), false)

      const limiter2 = new QueueRateLimiter({
        rate_directory: dir, windows: [{ window_ms: 60_000, max_requests: 3 }], now: () => now.val,
      })
      assert.equal(limiter2.tryAcquire(), false)

      now.val += 61_000
      const limiter3 = new QueueRateLimiter({
        rate_directory: dir, windows: [{ window_ms: 60_000, max_requests: 3 }], now: () => now.val,
      })
      assert.equal(limiter3.tryAcquire(), true)
    })
  })
})