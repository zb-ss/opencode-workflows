import type { ToolContext } from '@opencode-ai/plugin'
import Ajv2020 from 'ajv/dist/2020.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  WorkflowEngine,
  loadAutomaticWorkflowState,
  parseStageResult,
  topologicalStageIds,
  validateWorkflowDefinition,
  type AutomationLimits,
  type WorkflowDefinition,
  type WorkflowSessionAdapter,
} from '../../lib/workflow-engine.ts'
import { AutoWorkflow } from '../../plugin/auto-workflow.ts'

interface AdapterCall {
  name: string
  sessionId?: string
  title?: string
  prompt?: string
  options?: unknown
}

class FakeAdapter implements WorkflowSessionAdapter {
  readonly calls: AdapterCall[] = []
  readonly messagesBySession = new Map<string, any[]>()
  readonly statusBySession: Record<string, any> = {}
  statusError: Error | null = null
  private sequence = 0

  async create(title: string, _parentID?: string): Promise<any> {
    const id = `child-${++this.sequence}`
    this.calls.push({ name: 'create', sessionId: id, title })
    this.statusBySession[id] = { type: 'busy' }
    return { id }
  }

  async promptAsync(sessionId: string, prompt: string, options?: unknown): Promise<void> {
    this.calls.push({ name: 'prompt', sessionId, prompt, options })
  }

  async abort(sessionId: string): Promise<void> {
    this.calls.push({ name: 'abort', sessionId })
    delete this.statusBySession[sessionId]
  }

  async statuses(): Promise<Record<string, any>> {
    this.calls.push({ name: 'statuses' })
    if (this.statusError) throw this.statusError
    return { ...this.statusBySession }
  }

  async messages(sessionId: string): Promise<any[]> {
    this.calls.push({ name: 'messages', sessionId })
    return this.messagesBySession.get(sessionId) ?? []
  }

  setResult(sessionId: string, result: unknown, usage: Partial<{ input: number; output: number; reasoning: number; cost: number }> = {}): void {
    const text = typeof result === 'string' ? result : JSON.stringify(result)
    this.messagesBySession.set(sessionId, [{
      info: assistantMessage(`message-${sessionId}`, sessionId, usage),
      parts: [{ type: 'text', text }],
    }])
    this.statusBySession[sessionId] = { type: 'idle' }
  }
}

const engines: WorkflowEngine[] = []
const temporaryDirectories: string[] = []

function assistantMessage(
  id: string,
  sessionID: string,
  usage: Partial<{ input: number; output: number; reasoning: number; cost: number }> = {},
) {
  return {
    id,
    sessionID,
    role: 'assistant',
    cost: usage.cost ?? 0,
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning ?? 0,
      cache: { read: 0, write: 0 },
    },
  }
}

function limits(overrides: Partial<AutomationLimits> = {}): AutomationLimits {
  return {
    max_sessions: 20,
    max_parallel_sessions: 2,
    max_attempts_per_stage: 3,
    max_wall_time_ms: 60_000,
    max_input_tokens: 10_000,
    max_output_tokens: 10_000,
    max_cost_usd: 10,
    ...overrides,
  }
}

function definition(
  stages: Array<{ id: string; depends_on?: string[]; required?: boolean; role?: string }>,
): WorkflowDefinition {
  return validateWorkflowDefinition({
    schema_version: 1,
    id: 'test_workflow',
    description: 'Test workflow',
    stages: stages.map((stage) => ({
      id: stage.id,
      description: `Run ${stage.id}`,
      depends_on: stage.depends_on ?? [],
      required: stage.required ?? true,
      agent_role: stage.role ?? stage.id,
      model_tier: 'mid',
      prompt: `Perform ${stage.id}`,
    })),
  })
}

function createEngine(
  workflowDefinition: WorkflowDefinition,
  adapter: FakeAdapter,
  options: {
    budget?: Partial<AutomationLimits>
    directory?: string
    now?: () => number
    state?: ReturnType<typeof loadAutomaticWorkflowState>
    schedulingEnabled?: boolean
    candidates?: Array<{ model: string; variant?: string }>
  } = {},
): { engine: WorkflowEngine; statePath: string; definitionPath: string } {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-'))
  if (!options.directory) temporaryDirectories.push(directory)
  const statePath = path.join(directory, 'workflow-auto.state.json')
  const definitionPath = path.join(directory, 'workflow-auto.definition.json')
  const routing = Object.fromEntries(workflowDefinition.stages.map((stage) => [stage.agent_role, `${stage.agent_role}-agent`]))
  const engine = new WorkflowEngine({
    adapter,
    definition: workflowDefinition,
    statePath,
    definitionPath,
    modeRouting: routing,
    modelCandidates: () => options.candidates ?? [{ model: 'provider/primary' }],
    limits: limits(options.budget),
    state: options.state,
    schedulingEnabled: options.schedulingEnabled,
    now: options.now,
  })
  engines.push(engine)
  return { engine, statePath, definitionPath }
}

async function start(engine: WorkflowEngine) {
  return engine.start({
    rootSessionId: 'root-session',
    directory: '/project/app',
    worktree: '/project',
    mode: 'standard',
    task: 'Implement the requested behavior',
  })
}

async function complete(
  engine: WorkflowEngine,
  adapter: FakeAdapter,
  stageId: string,
  result: unknown = { status: 'passed', summary: 'Verified' },
): Promise<void> {
  const sessionId = engine.snapshot().stages[stageId].session_id
  assert.ok(sessionId, `${stageId} has no active session`)
  adapter.setResult(sessionId, result)
  await engine.handleEvent({ type: 'session.idle', properties: { sessionID: sessionId } })
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('declarative workflow validation', () => {
  it('rejects missing dependencies and cycles with deterministic diagnostics', () => {
    assert.throws(() => definition([{ id: 'a', depends_on: ['missing'] }]), /unknown stage missing/)
    assert.throws(() => definition([
      { id: 'a', depends_on: ['c'] },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['b'] },
    ]), /dependency cycle involving: a, b, c/)
  })

  it('uses stable declaration order for a diamond DAG', () => {
    const input = definition([
      { id: 'root' },
      { id: 'left', depends_on: ['root'] },
      { id: 'right', depends_on: ['root'] },
      { id: 'join', depends_on: ['left', 'right'] },
    ])
    assert.deepEqual(topologicalStageIds(input), ['root', 'left', 'right', 'join'])
  })

  it('parses only schema-valid structured stage results', () => {
    assert.deepEqual(parseStageResult('```json\n{"status":"passed","summary":"ok"}\n```'), {
      status: 'passed',
      summary: 'ok',
    })
    assert.throws(() => parseStageResult('VERDICT: PASS'), /not valid JSON/)
    assert.throws(() => parseStageResult('{"status":"passed","summary":"ok","extra":true}'), /unsupported properties/)
    assert.throws(() => parseStageResult('{"status":"passed","summary":""}'), /non-empty string/)
  })

  it('compiles all public JSON schemas in draft 2020-12 mode', () => {
    const AjvConstructor = Ajv2020 as unknown as new (options: object) => {
      addSchema(schema: object): void
      compile(schema: object): unknown
    }
    const ajv = new AjvConstructor({ strict: true, formats: { 'date-time': true } })
    const stageResult = JSON.parse(fs.readFileSync(path.resolve('schema/stage-result.schema.json'), 'utf8'))
    const definitionSchema = JSON.parse(fs.readFileSync(path.resolve('schema/workflow-definition.schema.json'), 'utf8'))
    const stateSchema = JSON.parse(fs.readFileSync(path.resolve('schema/workflow-state.schema.json'), 'utf8'))
    ajv.addSchema(stageResult)
    assert.doesNotThrow(() => ajv.compile(definitionSchema))
    assert.doesNotThrow(() => ajv.compile(stateSchema))
  })

  it('routes every installed definition stage in every automatic mode', () => {
    for (const definitionName of ['development', 'e2e']) {
      const installedDefinition = validateWorkflowDefinition(JSON.parse(
        fs.readFileSync(path.resolve(`workflow/${definitionName}.json`), 'utf8'),
      ))
      for (const mode of ['eco', 'turbo', 'standard', 'thorough', 'swarm']) {
        const modeConfig = JSON.parse(fs.readFileSync(path.resolve(`mode/${mode}.json`), 'utf8'))
        for (const stage of installedDefinition.stages) {
          assert.equal(
            typeof modeConfig.agent_routing[stage.agent_role],
            'string',
            `${definitionName}.${stage.id} is not routed by mode ${mode}`,
          )
        }
      }
    }
  })
})

describe('WorkflowEngine scheduling and events', () => {
  it('runs a diamond deterministically, fills concurrency, and waits for every dependency', async () => {
    const adapter = new FakeAdapter()
    const { engine } = createEngine(definition([
      { id: 'root' },
      { id: 'left', depends_on: ['root'] },
      { id: 'right', depends_on: ['root'] },
      { id: 'join', depends_on: ['left', 'right'] },
    ]), adapter)
    await start(engine)
    assert.deepEqual(adapter.calls.filter((call) => call.name === 'create').map((call) => call.title?.match(/] (\w+)/)?.[1]), ['root'])

    await complete(engine, adapter, 'root')
    assert.deepEqual(adapter.calls.filter((call) => call.name === 'create').map((call) => call.title?.match(/] (\w+)/)?.[1]), [
      'root', 'left', 'right',
    ])
    assert.equal(Object.values(engine.snapshot().stages).filter((stage) => stage.status === 'running').length, 2)

    await complete(engine, adapter, 'left')
    assert.equal(engine.snapshot().stages.join.status, 'pending')
    await complete(engine, adapter, 'right')
    assert.equal(engine.snapshot().stages.join.status, 'running')
    await complete(engine, adapter, 'join')
    assert.equal(engine.snapshot().status, 'completed')
  })

  it('blocks all failed descendants while allowing an independent branch to finish', async () => {
    const adapter = new FakeAdapter()
    const { engine } = createEngine(definition([
      { id: 'source' },
      { id: 'dependent', depends_on: ['source'] },
      { id: 'grandchild', depends_on: ['dependent'] },
      { id: 'independent' },
    ]), adapter)
    await start(engine)
    await complete(engine, adapter, 'source', { status: 'failed', summary: 'Cannot continue', retryable: false })
    assert.equal(engine.snapshot().stages.dependent.status, 'blocked')
    assert.equal(engine.snapshot().stages.grandchild.status, 'blocked')
    assert.equal(engine.snapshot().stages.independent.status, 'running')
    await complete(engine, adapter, 'independent')
    assert.equal(engine.snapshot().status, 'failed')
  })

  it('ignores duplicate terminal events and never releases two scheduling slots', async () => {
    const adapter = new FakeAdapter()
    const { engine } = createEngine(definition([
      { id: 'first' },
      { id: 'second', depends_on: ['first'] },
      { id: 'third', depends_on: ['second'] },
    ]), adapter, { budget: { max_parallel_sessions: 1 } })
    await start(engine)
    const firstSession = engine.snapshot().stages.first.session_id!
    adapter.setResult(firstSession, { status: 'passed', summary: 'first complete' })
    await engine.handleEvent({ type: 'session.idle', properties: { sessionID: firstSession } })
    await engine.handleEvent({ type: 'session.idle', properties: { sessionID: firstSession } })
    await engine.handleEvent({ type: 'session.status', properties: { sessionID: firstSession, status: { type: 'idle' } } })
    assert.equal(adapter.calls.filter((call) => call.name === 'create').length, 2)
    assert.equal(engine.snapshot().stages.second.attempt, 1)
    assert.equal(engine.snapshot().stages.third.status, 'pending')
  })

  it('retries invalid output with the next model fallback candidate', async () => {
    const adapter = new FakeAdapter()
    const { engine } = createEngine(definition([{ id: 'validate' }]), adapter, {
      candidates: [{ model: 'provider/primary' }, { model: 'provider/fallback', variant: 'fast' }],
    })
    await start(engine)
    await complete(engine, adapter, 'validate', 'not-json')
    const prompts = adapter.calls.filter((call) => call.name === 'prompt')
    assert.equal(prompts.length, 2)
    assert.deepEqual(prompts[0].options, { agent: 'wf-validate-agent', model: { model: 'provider/primary' } })
    assert.deepEqual(prompts[1].options, {
      agent: 'wf-validate-agent',
      model: { model: 'provider/fallback', variant: 'fast' },
    })
  })
})

describe('WorkflowEngine budgets and persistence', () => {
  it('pauses instead of false-completing when session or attempt budgets are exhausted', async () => {
    const sessionAdapter = new FakeAdapter()
    const { engine: sessionEngine } = createEngine(definition([
      { id: 'first' },
      { id: 'second', depends_on: ['first'] },
    ]), sessionAdapter, { budget: { max_sessions: 1 } })
    await start(sessionEngine)
    await complete(sessionEngine, sessionAdapter, 'first')
    assert.equal(sessionEngine.snapshot().status, 'paused')
    assert.match(sessionEngine.snapshot().pause_reason!, /session budget exhausted/i)
    assert.equal(sessionEngine.snapshot().stages.second.status, 'pending')

    const attemptAdapter = new FakeAdapter()
    const { engine: attemptEngine } = createEngine(definition([{ id: 'only' }]), attemptAdapter, {
      budget: { max_attempts_per_stage: 1 },
    })
    await start(attemptEngine)
    await complete(attemptEngine, attemptAdapter, 'only', 'invalid')
    assert.equal(attemptEngine.snapshot().status, 'paused')
    assert.match(attemptEngine.snapshot().pause_reason!, /attempt budget exhausted/i)
  })

  it('accounts duplicate message updates by delta and enforces input, output, and cost budgets', async () => {
    for (const budgetCase of [
      { budget: { max_input_tokens: 5 }, usage: { input: 6 }, reason: /input token/i },
      { budget: { max_output_tokens: 5 }, usage: { output: 4, reasoning: 2 }, reason: /output token/i },
      { budget: { max_cost_usd: 0.5 }, usage: { cost: 0.6 }, reason: /cost budget/i },
    ]) {
      const adapter = new FakeAdapter()
      const { engine } = createEngine(definition([{ id: 'metered' }]), adapter, { budget: budgetCase.budget })
      await start(engine)
      const sessionId = engine.snapshot().stages.metered.session_id!
      const message = assistantMessage('usage-message', sessionId, budgetCase.usage)
      await engine.handleEvent({ type: 'message.updated', properties: { info: message } })
      await engine.handleEvent({ type: 'message.updated', properties: { info: message } })
      const state = engine.snapshot()
      assert.equal(state.status, 'paused')
      assert.match(state.pause_reason!, budgetCase.reason)
      assert.ok(state.budget.usage.input_tokens <= (budgetCase.usage.input ?? 0))
      assert.ok(state.budget.usage.output_tokens <= (budgetCase.usage.output ?? 0) + (budgetCase.usage.reasoning ?? 0))
    }
  })

  it('enforces wall time and persists enough state to reconcile and resume after restart', async () => {
    let now = 1_000
    const wallAdapter = new FakeAdapter()
    const { engine: wallEngine } = createEngine(definition([{ id: 'slow' }]), wallAdapter, {
      budget: { max_wall_time_ms: 10 },
      now: () => now,
    })
    await start(wallEngine)
    now += 11
    await wallEngine.reconcile()
    assert.equal(wallEngine.snapshot().status, 'paused')
    assert.match(wallEngine.snapshot().pause_reason!, /wall-time/i)

    const adapter = new FakeAdapter()
    const workflowDefinition = definition([
      { id: 'first' },
      { id: 'second', depends_on: ['first'] },
    ])
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-resume-'))
    temporaryDirectories.push(directory)
    const firstRuntime = createEngine(workflowDefinition, adapter, { directory })
    await start(firstRuntime.engine)
    const firstSession = firstRuntime.engine.snapshot().stages.first.session_id!
    adapter.setResult(firstSession, { status: 'passed', summary: 'Recovered result' })
    firstRuntime.engine.dispose()

    const saved = loadAutomaticWorkflowState(firstRuntime.statePath)
    assert.equal(saved.root_session_id, 'root-session')
    assert.equal(saved.definition_path, firstRuntime.definitionPath)
    const restored = createEngine(workflowDefinition, adapter, {
      directory,
      state: saved,
      schedulingEnabled: false,
    })
    await restored.engine.resume(limits())
    assert.equal(restored.engine.snapshot().stages.first.status, 'passed')
    assert.equal(restored.engine.snapshot().stages.second.status, 'running')
    assert.equal(loadAutomaticWorkflowState(restored.statePath).stages.second.attempt, 1)
  })

  it('pauses non-destructively when restored child-session reconciliation is unavailable', async () => {
    const adapter = new FakeAdapter()
    const workflowDefinition = definition([{ id: 'running' }])
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-reconcile-'))
    temporaryDirectories.push(directory)
    const original = createEngine(workflowDefinition, adapter, { directory })
    await start(original.engine)
    const sessionId = original.engine.snapshot().stages.running.session_id
    original.engine.dispose()

    adapter.statusError = new Error('status endpoint unavailable')
    const restored = createEngine(workflowDefinition, adapter, {
      directory,
      state: loadAutomaticWorkflowState(original.statePath),
      schedulingEnabled: false,
    })
    await restored.engine.resume(limits())
    const state = restored.engine.snapshot()
    assert.equal(state.status, 'paused')
    assert.match(state.pause_reason!, /reconciliation failed/)
    assert.equal(state.stages.running.status, 'running')
    assert.equal(state.stages.running.session_id, sessionId)
    assert.equal(adapter.calls.filter((call) => call.name === 'create').length, 1)
  })

  it('recovers a persisted running stage that has no child session ID', async () => {
    const adapter = new FakeAdapter()
    const workflowDefinition = definition([{ id: 'interrupted' }])
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-interrupted-'))
    temporaryDirectories.push(directory)
    const original = createEngine(workflowDefinition, adapter, { directory })
    await start(original.engine)
    original.engine.dispose()

    const interrupted = loadAutomaticWorkflowState(original.statePath)
    interrupted.stages.interrupted.session_id = null
    fs.writeFileSync(original.statePath, `${JSON.stringify(interrupted, null, 2)}\n`)
    const restored = createEngine(workflowDefinition, adapter, {
      directory,
      state: loadAutomaticWorkflowState(original.statePath),
      schedulingEnabled: false,
    })

    await restored.engine.resume(limits())
    const stage = restored.engine.snapshot().stages.interrupted
    assert.equal(stage.status, 'running')
    assert.equal(stage.attempt, 2)
    assert.equal(stage.session_id, 'child-2')
  })
})

describe('AutoWorkflow production plugin integration', () => {
  it('imports with OpenCode 1.17.20 shapes and asks before creating child sessions', async () => {
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-workflow-plugin-'))
    temporaryDirectories.push(configDirectory)
    fs.mkdirSync(path.join(configDirectory, 'mode'), { recursive: true })
    fs.mkdirSync(path.join(configDirectory, 'workflow'), { recursive: true })
    fs.writeFileSync(path.join(configDirectory, 'workflows.json'), JSON.stringify({
      default_mode: 'standard',
      model_tiers: { low: [], mid: ['provider/model'], high: [] },
      automation: {
        enabled: true,
        max_parallel_sessions: 1,
        max_sessions: 3,
        max_attempts_per_stage: 2,
        max_wall_time_ms: 60_000,
        max_input_tokens: 1_000,
        max_output_tokens: 1_000,
        max_cost_usd: 1,
      },
    }))
    fs.writeFileSync(path.join(configDirectory, 'mode', 'standard.json'), JSON.stringify({
      agent_routing: { planning: 'architect' },
    }))
    fs.writeFileSync(path.join(configDirectory, 'workflow', 'development.json'), JSON.stringify({
      schema_version: 1,
      id: 'development',
      description: 'Production import test',
      stages: [{
        id: 'planning',
        description: 'Plan',
        agent_role: 'planning',
        model_tier: 'mid',
        prompt: 'Plan the task',
      }],
    }))

    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    const calls: string[] = []
    const client = {
      session: {
        create: async () => {
          calls.push('create')
          return { data: { id: 'plugin-child' } }
        },
        promptAsync: async () => {
          calls.push('prompt')
          return { data: undefined, error: undefined }
        },
        abort: async () => ({ data: true }),
        status: async () => ({ data: { 'plugin-child': { type: 'busy' } } }),
        messages: async () => ({ data: [] }),
      },
    }
    try {
      const hooks = await AutoWorkflow({ client, directory: '/project/app' } as any)
      const permissionRequests: any[] = []
      const context: ToolContext = {
        sessionID: 'plugin-root',
        messageID: 'message-root',
        agent: 'supervisor',
        directory: '/project/app',
        worktree: '/project',
        abort: new AbortController().signal,
        metadata() {},
        async ask(request) {
          assert.equal(calls.includes('create'), false, 'child session was created before context.ask')
          permissionRequests.push(request)
        },
      }
      const result = JSON.parse(await hooks.tool!.workflow_auto_start.execute({
        workflow_type: 'development',
        task: 'Test production plugin import',
        mode: 'standard',
      }, context) as string)
      assert.equal(result.started, true)
      assert.deepEqual(permissionRequests.map((request) => request.patterns), [['wf-architect']])
      assert.deepEqual(calls, ['create', 'prompt'])

      const status = JSON.parse(await hooks.tool!.workflow_auto_status.execute({}, context) as string)
      assert.equal(status.active, true)
      assert.equal(status.workflow.status, 'running')
      for (const toolName of ['task', 'delegate_run', 'delegation_execute_batch', 'swarm_spawn_batch', 'workflow_auto_start']) {
        await assert.rejects(
          hooks['tool.execute.before']!({ tool: toolName, sessionID: 'plugin-child', callID: `call-${toolName}` }, { args: {} }),
          /spawning tools are disabled/,
        )
      }
      await assert.doesNotReject(
        hooks['tool.execute.before']!({ tool: 'task', sessionID: 'plugin-root', callID: 'call-2' }, { args: {} }),
      )
      await hooks.dispose?.()

      const foreignHooks = await AutoWorkflow({ client, directory: '/other-project' } as any)
      const foreignContext = { ...context, directory: '/other-project', worktree: '/other-project' }
      const foreignStatus = JSON.parse(
        await foreignHooks.tool!.workflow_auto_status.execute({}, foreignContext) as string,
      )
      assert.deepEqual(foreignStatus, { active: false })
      await foreignHooks.dispose?.()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })
})
