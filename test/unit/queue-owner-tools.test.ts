import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { createQueueOwnerTools } from '../../plugin/queue-owner-tools.ts'
import { sha256Hex } from '../../lib/canonical-json.ts'
import { QueueStore } from '../../lib/queue-store.ts'

const temporaryDirectories = new Set<string>()
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

function setup(): { parent: string; config: string; projects: string[] } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-owner-tools-'))
  temporaryDirectories.add(parent)
  const config = path.join(parent, 'config')
  const projects = [path.join(parent, 'project-a'), path.join(parent, 'project-b')]
  fs.mkdirSync(path.join(config, 'mode'), { recursive: true })
  fs.mkdirSync(path.join(config, 'workflow'), { recursive: true })
  projects.forEach(project => fs.mkdirSync(project))
  fs.copyFileSync(path.join(process.cwd(), 'mode', 'standard.json'), path.join(config, 'mode', 'standard.json'))
  fs.copyFileSync(path.join(process.cwd(), 'workflow', 'development.json'), path.join(config, 'workflow', 'development.json'))
  fs.writeFileSync(path.join(config, 'workflows.json'), JSON.stringify({
    default_mode: 'standard',
    model_tiers: {
      low: [{ model: 'provider/example' }],
      mid: [{ model: 'provider/example' }],
      high: [{ model: 'provider/example' }],
    },
    automation: {
      enabled: true,
      autonomy: 'interactive',
      max_parallel_sessions: 1,
      max_sessions: 10,
      max_attempts_per_stage: 2,
      session_operation_timeout_ms: 1_000,
    },
    queue: {
      enabled: true,
      max_concurrent_workflows: 1,
      lease_duration_ms: 60_000,
      renewal_interval_ms: 20_000,
      recovery_attempt_limit: 3,
      retry_policy: {
        max_semantic_attempts: 2,
        max_contract_attempts: 2,
        max_transport_attempts: 2,
        max_no_progress_attempts: 2,
        transport_backoff: { strategy: 'exponential', initial_delay_ms: 10, maximum_delay_ms: 100, multiplier: 2 },
      },
    },
  }))
  process.env.OPENCODE_CONFIG_DIR = config
  return { parent, config, projects }
}

function context(project: string): ToolContext {
  return {
    sessionID: 'root-session',
    messageID: 'message-1',
    agent: 'build',
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  } as unknown as ToolContext
}

function input(project: string, abortedDirectories: string[], behavior: { statusBusy: boolean; abortGate?: Promise<void>; createdSessions?: string[] } = { statusBusy: false }): PluginInput {
  let sequence = 0
  const childDirectories = new Map<string, string>()
  return {
    client: {
      session: {
        get: async ({ path: requestPath }: { path: { id: string } }) => ({ data: { id: requestPath.id } }),
        create: async ({ query }: { query: { directory: string } }) => {
          const id = `child-${++sequence}`
          childDirectories.set(id, query.directory)
          behavior.createdSessions?.push(id)
          return { data: { id } }
        },
        prompt: async () => await new Promise(() => {}),
        promptAsync: async () => await new Promise(() => {}),
        abort: async ({ path: requestPath }: { path: { id: string } }) => {
          abortedDirectories.push(childDirectories.get(requestPath.id) ?? 'unknown')
          await behavior.abortGate
          return { data: undefined }
        },
        status: async () => ({
          data: behavior.statusBusy
            ? Object.fromEntries([...childDirectories].map(([id]) => [id, { type: 'busy' }]))
            : {},
        }),
        messages: async () => ({ data: [] }),
        message: async () => ({ data: undefined }),
      },
    },
    project: {},
    directory: project,
    worktree: project,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost'),
    $: () => {},
  } as unknown as PluginInput
}

async function waitForStatus(tools: any, toolContext: ToolContext, workflowId: string, expected: string): Promise<any> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const status = JSON.parse(await tools.tool.queue_workflow_status.execute({ workflow_id: workflowId }, toolContext) as string)
    if (status.status === expected) return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`workflow ${workflowId} did not reach ${expected}`)
}

async function enqueue(tools: any, toolContext: ToolContext, workflowId: string): Promise<void> {
  await tools.tool.queue_enqueue.execute({
    workflow_id: workflowId,
    definition_id: 'development',
    task: `Run ${workflowId}`,
  }, toolContext)
}

describe('queue owner tools', { concurrency: false }, () => {
  it('isolates equal workflow IDs by queue directory', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories))
    const firstContext = context(test.projects[0]!)
    const secondContext = context(test.projects[1]!)

    await enqueue(tools, firstContext, 'shared-workflow')
    await enqueue(tools, secondContext, 'shared-workflow')
    const first = await waitForStatus(tools, firstContext, 'shared-workflow', 'running')
    await waitForStatus(tools, secondContext, 'shared-workflow', 'running')

    await tools.tool.queue_cancel.execute({
      workflow_id: 'shared-workflow',
      expected_revision: first.revision,
      expected_generation: first.generation,
      reason: 'Cancel only project A',
    }, firstContext)

    assert.deepEqual(abortedDirectories, [test.projects[0]])
    const second = JSON.parse(await tools.tool.queue_workflow_status.execute({ workflow_id: 'shared-workflow' }, secondContext) as string)
    assert.equal(second.status, 'running')
    await tools.dispose()
  })

  it('releases capacity after a definitive pre-launch dispatch failure', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'running-workflow')
    const running = await waitForStatus(tools, toolContext, 'running-workflow', 'running')
    await enqueue(tools, toolContext, 'waiting-workflow')
    await waitForStatus(tools, toolContext, 'waiting-workflow', 'queued')
    fs.unlinkSync(path.join(test.config, 'mode', 'standard.json'))

    await tools.tool.queue_cancel.execute({
      workflow_id: 'running-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Release the active slot',
    }, toolContext)

    const paused = await waitForStatus(tools, toolContext, 'waiting-workflow', 'paused')
    assert.equal(paused.launch_state, 'settled')
    assert.equal(paused.failure_classification, 'contract')
    assert.match(paused.pause_reason, /dispatch failed/)
    await tools.dispose()
  })

  it('settles a failed created-intent write as a retryable transport pause', async () => {
    const test = setup()
    const originalUpdate = QueueStore.prototype.update
    let injected = false
    QueueStore.prototype.update = function (...args: Parameters<QueueStore['update']>) {
      const current = this.load(args[0])
      if (!injected && current?.status === 'leased' && current.launch_intent?.launch_state === 'reserved') {
        injected = true
        throw new Error('injected created-intent persistence failure')
      }
      return originalUpdate.apply(this, args)
    }
    try {
      const tools = await createQueueOwnerTools(input(test.projects[0]!, []))
      const toolContext = context(test.projects[0]!)

      await enqueue(tools, toolContext, 'created-write-failure')
      const paused = await waitForStatus(tools, toolContext, 'created-write-failure', 'paused')

      assert.equal(injected, true)
      assert.equal(paused.failure_classification, 'transport')
      assert.equal(paused.launch_state, 'settled')
      assert.match(paused.pause_reason, /dispatch failed/)
      await tools.dispose()
    } finally {
      QueueStore.prototype.update = originalUpdate
    }
  })

  it('retains queue capacity until cancellation proves child termination', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    let releaseAbort!: () => void
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories, { statusBusy: false, abortGate }))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'running-workflow')
    const running = await waitForStatus(tools, toolContext, 'running-workflow', 'running')
    const cancelling = tools.tool.queue_cancel.execute({
      workflow_id: 'running-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Wait for child termination',
    }, toolContext)
    await waitForStatus(tools, toolContext, 'running-workflow', 'recovering')

    await enqueue(tools, toolContext, 'waiting-workflow')
    await waitForStatus(tools, toolContext, 'waiting-workflow', 'queued')

    releaseAbort()
    await cancelling
    await waitForStatus(tools, toolContext, 'waiting-workflow', 'running')
    await tools.dispose()
  })

  it('rejects overlapping owner controls without downgrading a later cancellation', async () => {
    const test = setup()
    let releaseAbort!: () => void
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    const tools = await createQueueOwnerTools(input(test.projects[0]!, [], { statusBusy: false, abortGate }))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'controlled-workflow')
    const running = await waitForStatus(tools, toolContext, 'controlled-workflow', 'running')
    const pausing = tools.tool.queue_pause.execute({
      workflow_id: 'controlled-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Pause first',
    }, toolContext)
    const controlling = await waitForStatus(tools, toolContext, 'controlled-workflow', 'recovering')
    await assert.rejects(
      tools.tool.queue_cancel.execute({
        workflow_id: 'controlled-workflow',
        expected_revision: controlling.revision,
        expected_generation: controlling.generation,
        reason: 'Overlapping cancellation',
      }, toolContext),
      /control is already in progress/,
    )

    releaseAbort()
    const paused = JSON.parse(await pausing as string).workflow
    const cancelled = JSON.parse(await tools.tool.queue_cancel.execute({
      workflow_id: 'controlled-workflow',
      expected_revision: paused.revision,
      expected_generation: paused.generation,
      reason: 'Cancellation after pause settled',
    }, toolContext) as string)
    assert.equal(cancelled.workflow.status, 'cancelled')
    await tools.dispose()
  })

  it('projects an internal prompt timeout as capacity-retaining queue recovery', async () => {
    const test = setup()
    const tools = await createQueueOwnerTools(input(test.projects[0]!, []))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'prompt-timeout')
    await waitForStatus(tools, toolContext, 'prompt-timeout', 'running')
    const recovering = await waitForStatus(tools, toolContext, 'prompt-timeout', 'recovering')

    assert.equal(recovering.failure_classification, 'ambiguous_launch')
    assert.equal(recovering.launch_state, 'ambiguous')
    assert.match(recovering.pause_reason, /structured prompt timed out/)
    const cancelled = JSON.parse(await tools.tool.queue_cancel.execute({
      workflow_id: 'prompt-timeout',
      expected_revision: recovering.revision,
      expected_generation: recovering.generation,
      reason: 'Resolve the timed-out child',
    }, toolContext) as string)
    assert.equal(cancelled.workflow.status, 'cancelled')
    await tools.dispose()
  })

  it('resumes the persisted engine without resetting cumulative usage', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    const createdSessions: string[] = []
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories, { statusBusy: false, createdSessions }))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'resumed-workflow')
    const running = await waitForStatus(tools, toolContext, 'resumed-workflow', 'running')
    const pausedResult = JSON.parse(await tools.tool.queue_pause.execute({
      workflow_id: 'resumed-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Pause before resuming',
    }, toolContext) as string)
    const queueDirectory = path.join(
      test.config,
      'workflows',
      'runtime',
      'queue',
      sha256Hex(fs.realpathSync(test.projects[0]!)),
    )
    const queueRecord = JSON.parse(fs.readFileSync(path.join(queueDirectory, 'workflows', 'resumed-workflow.json'), 'utf8'))
    assert.equal(queueRecord.launch_intent.session_id, 'child-1')
    assert.deepEqual(queueRecord.launch_intent.child_session_ids, ['child-1'])
    const statePath = path.join(queueDirectory, 'engines', sha256Hex('resumed-workflow'), 'workflow-auto.state.json')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).budget.usage.sessions, 1)

    await tools.tool.queue_resume.execute({
      workflow_id: 'resumed-workflow',
      expected_revision: pausedResult.workflow.revision,
      expected_generation: pausedResult.workflow.generation,
    }, toolContext)
    await waitForStatus(tools, toolContext, 'resumed-workflow', 'running')

    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).budget.usage.sessions, 2)
    assert.deepEqual(createdSessions, ['child-1', 'child-2'])
    await tools.dispose()
  })

  it('classifies a terminal workflow failure and retries it without resetting usage', async () => {
    const test = setup()
    const createdSessions: string[] = []
    const tools = await createQueueOwnerTools(input(test.projects[0]!, [], { statusBusy: false, createdSessions }))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'retry-workflow')
    await waitForStatus(tools, toolContext, 'retry-workflow', 'running')
    assert.deepEqual(createdSessions, ['child-1'])
    const now = Date.now()
    await tools.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'message-child-1',
            sessionID: 'child-1',
            role: 'assistant',
            parentID: 'user-message',
            providerID: 'provider',
            modelID: 'example',
            mode: 'test',
            agent: 'wf-architect',
            path: { cwd: test.projects[0], root: test.projects[0] },
            time: { created: now, completed: now },
            cost: 0,
            tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            structured: { status: 'failed', summary: 'Retry the planning stage.', retryable: false },
          },
        },
      },
    })
    const failed = await waitForStatus(tools, toolContext, 'retry-workflow', 'paused')
    assert.equal(failed.failure_classification, 'semantic')

    await tools.tool.queue_resume.execute({
      workflow_id: 'retry-workflow',
      expected_revision: failed.revision,
      expected_generation: failed.generation,
    }, toolContext)
    await waitForStatus(tools, toolContext, 'retry-workflow', 'running')
    assert.deepEqual(createdSessions, ['child-1', 'child-2'])

    const queueDirectory = path.join(
      test.config,
      'workflows',
      'runtime',
      'queue',
      sha256Hex(fs.realpathSync(test.projects[0]!)),
    )
    const state = JSON.parse(fs.readFileSync(path.join(
      queueDirectory,
      'engines',
      sha256Hex('retry-workflow'),
      'workflow-auto.state.json',
    ), 'utf8'))
    assert.equal(state.budget.usage.sessions, 2)
    assert.equal(state.budget.usage.input_tokens, 3)
    await tools.dispose()
  })

  it('deletes terminal queue records and retained engine state', async () => {
    const test = setup()
    const tools = await createQueueOwnerTools(input(test.projects[0]!, []))
    const toolContext = context(test.projects[0]!)

    await enqueue(tools, toolContext, 'deleted-workflow')
    const running = await waitForStatus(tools, toolContext, 'deleted-workflow', 'running')
    const cancelled = JSON.parse(await tools.tool.queue_cancel.execute({
      workflow_id: 'deleted-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Delete this completed test record',
    }, toolContext) as string).workflow
    const engineState = path.join(
      test.config,
      'workflows',
      'runtime',
      'queue',
      sha256Hex(fs.realpathSync(test.projects[0]!)),
      'engines',
      sha256Hex('deleted-workflow'),
      'workflow-auto.state.json',
    )
    await assert.rejects(
      tools.tool.queue_delete.execute({
        workflow_id: 'deleted-workflow',
        expected_revision: cancelled.revision - 1,
        expected_generation: cancelled.generation,
      }, toolContext),
      /stale/,
    )
    assert.equal(fs.existsSync(engineState), true)
    await tools.tool.queue_delete.execute({
      workflow_id: 'deleted-workflow',
      expected_revision: cancelled.revision,
      expected_generation: cancelled.generation,
    }, toolContext)

    await assert.rejects(
      tools.tool.queue_workflow_status.execute({ workflow_id: 'deleted-workflow' }, toolContext),
      /not found/,
    )
    assert.equal(fs.existsSync(engineState), false)
    await tools.dispose()
  })

  it('requires retained engines to terminate before attended takeover recovery', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    const behavior = { statusBusy: true }
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories, behavior))
    const toolContext = context(test.projects[0]!)
    await enqueue(tools, toolContext, 'retained-workflow')
    const running = await waitForStatus(tools, toolContext, 'retained-workflow', 'running')

    const queueDirectory = path.join(
      test.config,
      'workflows',
      'runtime',
      'queue',
      sha256Hex(fs.realpathSync(test.projects[0]!)),
    )
    const leasePath = path.join(queueDirectory, 'lease', 'fencing-lease.json')
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'))
    lease.expires_at = new Date(Date.now() - 1_000).toISOString()
    fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`)

    await assert.rejects(tools.tool.queue_pause.execute({
      workflow_id: 'retained-workflow',
      expected_revision: running.revision,
      expected_generation: running.generation,
      reason: 'Trigger lease-loss cleanup',
    }, toolContext), /attended queue recovery/)
    while (abortedDirectories.length === 0) await new Promise(resolve => setTimeout(resolve, 5))

    await assert.rejects(
      tools.tool.queue_recover.execute({ former_runtime_terminated: true }, toolContext),
      /could not prove child termination/,
    )
    behavior.statusBusy = false
    const recovered = JSON.parse(await tools.tool.queue_recover.execute({ former_runtime_terminated: true }, toolContext) as string)
    assert.equal(recovered.recovered, true)
    const paused = await waitForStatus(tools, toolContext, 'retained-workflow', 'paused')
    assert.equal(paused.launch_state, 'settled')
    await tools.tool.queue_resume.execute({
      workflow_id: 'retained-workflow',
      expected_revision: paused.revision,
      expected_generation: paused.generation,
    }, toolContext)
    await waitForStatus(tools, toolContext, 'retained-workflow', 'running')
    await tools.dispose()
  })

  it('recovers a newer active child persisted between engine and queue evidence writes', async () => {
    const test = setup()
    const project = fs.realpathSync(test.projects[0]!)
    const queueDirectory = path.join(test.config, 'workflows', 'runtime', 'queue', sha256Hex(project))
    const store = new QueueStore({
      config_directory: queueDirectory,
      owner: 'root-session',
      now: Date.now,
      lease_duration_ms: 60_000,
    })
    const lease = store.getLeaseStore().acquire()
    const enqueued = store.enqueue({
      workflow_id: 'crash-window',
      definition_id: 'development',
      root_session_id: 'root-session',
      directory: project,
      worktree: project,
      mode: 'standard',
      task: 'Recover exact child evidence',
    }, lease)
    const now = new Date().toISOString()
    const leased = store.update('crash-window', enqueued.state_revision, lease, record => {
      record.status = 'leased'
      record.launch_intent = {
        intent_id: 'intent-crash-window',
        workflow_id: 'crash-window',
        fencing_generation: lease.lease.fencing_generation,
        session_id: 'child-1',
        child_session_ids: ['child-1'],
        engine_instance_id: 'engine-crash-window',
        agent: 'standard',
        model: 'development',
        launch_state: 'prompted',
        reserved_at: now,
        created_at: now,
        prompted_at: now,
        settled_at: null,
      }
      return record
    })
    store.update('crash-window', leased.state_revision, lease, record => {
      record.status = 'running'
      return record
    })

    const engineDirectory = path.join(queueDirectory, 'engines', sha256Hex('crash-window'))
    fs.mkdirSync(engineDirectory, { recursive: true })
    const definitionPath = path.join(engineDirectory, 'workflow-auto.definition.json')
    const statePath = path.join(engineDirectory, 'workflow-auto.state.json')
    fs.copyFileSync(path.join(test.config, 'workflow', 'development.json'), definitionPath)
    const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'))
    const stages = Object.fromEntries(definition.stages.map((stage: { id: string; agent_role: string }, index: number) => [stage.id, {
      status: index === 0 ? 'running' : 'pending',
      attempt: index === 0 ? 2 : 0,
      session_id: index === 0 ? 'child-2' : null,
      agent: `wf-${stage.agent_role}`,
      model: index === 0 ? 'provider/example' : null,
      started_at: index === 0 ? now : null,
      completed_at: null,
      result: null,
      error: null,
    }]))
    fs.writeFileSync(statePath, `${JSON.stringify({
      schema_version: 2,
      workflow_id: 'crash-window',
      definition_id: 'development',
      definition_path: definitionPath,
      root_session_id: 'root-session',
      directory: project,
      worktree: project,
      mode: 'standard',
      autonomy: 'interactive',
      task: 'Recover exact child evidence',
      status: 'running',
      pause_reason: null,
      created_at: now,
      updated_at: now,
      stages,
      budget: {
        limits: {
          max_sessions: 10,
          max_parallel_sessions: 1,
          max_attempts_per_stage: 2,
          max_active_time_ms: null,
          max_calendar_age_ms: null,
          max_input_tokens: null,
          max_output_tokens: null,
          max_bounded_read_bytes: null,
          max_bounded_write_bytes: null,
          max_validation_runs: null,
          max_cost_usd: null,
        },
        usage: {
          sessions: 2,
          attempts: 2,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          bounded_read_bytes: 0,
          bounded_write_bytes: 0,
          validation_runs: 0,
          active_time_ms: 0,
          active_interval_started_at: now,
          last_active_checkpoint_at: now,
          messages: {},
        },
      },
    }, null, 2)}\n`, { mode: 0o600 })

    const leasePath = path.join(queueDirectory, 'lease', 'fencing-lease.json')
    const leaseRecord = JSON.parse(fs.readFileSync(leasePath, 'utf8'))
    leaseRecord.expires_at = new Date(Date.now() - 1_000).toISOString()
    fs.writeFileSync(leasePath, `${JSON.stringify(leaseRecord, null, 2)}\n`)

    const abortedDirectories: string[] = []
    const tools = await createQueueOwnerTools(input(project, abortedDirectories))
    const recovered = JSON.parse(await tools.tool.queue_recover.execute({ former_runtime_terminated: true }, context(project)) as string)
    assert.equal(recovered.recovered, true)
    const record = JSON.parse(fs.readFileSync(path.join(queueDirectory, 'workflows', 'crash-window.json'), 'utf8'))
    assert.equal(record.status, 'paused')
    assert.equal(record.launch_intent.launch_state, 'settled')
    assert.deepEqual(record.launch_intent.child_session_ids, ['child-1', 'child-2'])
    assert.deepEqual(abortedDirectories, ['unknown'])
    await tools.dispose()
  })

  it('releases the scheduler lease even when engine disposal fails', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories, { statusBusy: true }))
    const toolContext = context(test.projects[0]!)
    await enqueue(tools, toolContext, 'uncertain-disposal')
    await waitForStatus(tools, toolContext, 'uncertain-disposal', 'running')

    await assert.rejects(tools.dispose(), /termination remains uncertain/)
    const queueDirectory = path.join(
      test.config,
      'workflows',
      'runtime',
      'queue',
      sha256Hex(fs.realpathSync(test.projects[0]!)),
    )
    const lease = JSON.parse(fs.readFileSync(path.join(queueDirectory, 'lease', 'fencing-lease.json'), 'utf8'))
    assert.equal(Date.parse(lease.expires_at) < Date.now(), true)
  })

  it('drains multiple engines concurrently before releasing scheduler leases', async () => {
    const test = setup()
    const abortedDirectories: string[] = []
    let releaseAbort!: () => void
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    const tools = await createQueueOwnerTools(input(test.projects[0]!, abortedDirectories, { statusBusy: false, abortGate }))
    const firstContext = context(test.projects[0]!)
    const secondContext = context(test.projects[1]!)
    await enqueue(tools, firstContext, 'first-disposal')
    await enqueue(tools, secondContext, 'second-disposal')
    await waitForStatus(tools, firstContext, 'first-disposal', 'running')
    await waitForStatus(tools, secondContext, 'second-disposal', 'running')

    const disposing = tools.dispose()
    const deadline = Date.now() + 1_000
    while (abortedDirectories.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(abortedDirectories.length, 2)

    releaseAbort()
    await disposing
  })
})
