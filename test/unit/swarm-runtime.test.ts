import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from '@opencode-ai/plugin'

import { getSessionRuntimeDir } from '../../lib/paths.ts'
import { SwarmRuntime } from '../../lib/swarm-runtime.ts'
import type { SwarmTask } from '../../lib/types.ts'
import { SwarmManager } from '../../plugin/swarm-manager.ts'

interface SdkCall {
  name: string
  input: any
}

interface FakeSdk {
  client: any
  calls: SdkCall[]
  sessionIds: string[]
  statusCalls: number
  messages: Map<string, any[]>
}

const runtimes: SwarmRuntime[] = []
const temporaryDirectories: string[] = []

function fakeSdk(): FakeSdk {
  const calls: SdkCall[] = []
  const sessionIds: string[] = []
  const messages = new Map<string, any[]>()
  const aborted = new Set<string>()
  const sdk: FakeSdk = {
    calls,
    sessionIds,
    messages,
    statusCalls: 0,
    client: {
      file: {
        status: async (input: any) => {
          calls.push({ name: 'file.status', input })
          return { data: [{ path: 'src/example.ts', added: 1, removed: 0, status: 'modified' }] }
        },
      },
      session: {
        create: async (input: any) => {
          calls.push({ name: 'create', input })
          const id = `session-${sessionIds.length + 1}`
          sessionIds.push(id)
          return { data: { id } }
        },
        promptAsync: async (input: any) => {
          calls.push({ name: 'promptAsync', input })
          return { data: undefined, error: undefined }
        },
        abort: async (input: any) => {
          calls.push({ name: 'abort', input })
          aborted.add(input.path.id)
          return { data: true }
        },
        status: async (input: any) => {
          calls.push({ name: 'status', input })
          sdk.statusCalls++
          return { data: Object.fromEntries(sessionIds
            .filter((id) => !aborted.has(id))
            .map((id) => [id, { type: 'busy' }])) }
        },
        messages: async (input: any) => {
          calls.push({ name: 'messages', input })
          return { data: messages.get(input.path.id) ?? [] }
        },
      },
    },
  }
  return sdk
}

function createRuntime(sdk: FakeSdk, config: ConstructorParameters<typeof SwarmRuntime>[1] = {}): SwarmRuntime {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-'))
  temporaryDirectories.push(configDirectory)
  const runtime = createRuntimeAt(sdk, configDirectory, config, false)
  return runtime
}

function createRuntimeAt(
  sdk: FakeSdk,
  configDirectory: string,
  config: ConstructorParameters<typeof SwarmRuntime>[1],
  restore: boolean,
): SwarmRuntime {
  const runtime = new SwarmRuntime(sdk.client, config, {
    env: runtimeEnvironment(configDirectory),
    restore,
    scopeDirectory: '/project',
  })
  runtimes.push(runtime)
  return runtime
}

function runtimeEnvironment(configDirectory: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }
}

function task(id: string, provider = 'provider'): SwarmTask {
  return { id, agent: 'test-agent', prompt: `Run ${id}`, model: `${provider}/model` }
}

function spawn(runtime: SwarmRuntime, batchId: string, tasks: SwarmTask[]) {
  return runtime.spawnBatch({
    batchId,
    callerSessionId: 'caller-session',
    directory: '/project',
    tasks,
  })
}

async function idle(runtime: SwarmRuntime, sessionID: string): Promise<void> {
  await runtime.handleEvent({ type: 'session.idle', properties: { sessionID } })
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('SwarmRuntime', () => {
  it('drains every queued task while enforcing global and provider limits', async () => {
    const sdk = fakeSdk()
    const runtime = createRuntime(sdk, {
      default_concurrency: 2,
      provider_concurrency: { provider: 1, other: 1 },
    })

    const result = spawn(runtime, 'queue-drain', [task('first'), task('second'), task('third', 'other')])
    assert.equal(result.spawned, 2)
    assert.deepEqual(result.queuedTasks, ['second'])
    await waitFor(() => sdk.calls.filter((call) => call.name === 'promptAsync').length === 2, 'initial tasks did not start')
    assert.deepEqual(
      sdk.calls.filter((call) => call.name === 'create').map((call) => call.input.body.title),
      ['[queue-drain] test-agent: first', '[queue-drain] test-agent: third'],
    )

    await idle(runtime, 'session-1')
    await waitFor(() => sdk.sessionIds.length === 3, 'provider queue did not drain')
    assert.equal(sdk.calls.filter((call) => call.name === 'create')[2].input.body.title, '[queue-drain] test-agent: second')

    await idle(runtime, 'session-2')
    await waitFor(() => sdk.calls.filter((call) => call.name === 'promptAsync').length === 3, 'queued task was not prompted')
    await idle(runtime, 'session-3')
    const completed = await runtime.awaitBatch('caller-session', 'queue-drain', 100)
    assert.equal(completed.completed, true)
    assert.deepEqual(completed.results, { first: 'completed', second: 'completed', third: 'completed' })
  })

  it('releases a slot only once for duplicate terminal events', async () => {
    const sdk = fakeSdk()
    const runtime = createRuntime(sdk, { default_concurrency: 1 })
    spawn(runtime, 'duplicate-events', [task('first'), task('second'), task('third')])
    await waitFor(() => sdk.sessionIds.length === 1, 'first task did not start')

    await idle(runtime, 'session-1')
    await idle(runtime, 'session-1')
    await runtime.handleEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    })
    await waitFor(() => sdk.sessionIds.length === 2, 'second task did not start')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(sdk.sessionIds.length, 2, 'duplicate completion released more than one slot')

    await idle(runtime, 'session-2')
    await waitFor(() => sdk.sessionIds.length === 3, 'third task did not start')
    await idle(runtime, 'session-3')
    assert.equal((await runtime.awaitBatch('caller-session', 'duplicate-events', 100)).completed, true)
  })

  it('uses 1.17.20 SDK envelopes, body parts, directory queries, parentID, abort, and message parts', async () => {
    const sdk = fakeSdk()
    const runtime = createRuntime(sdk)
    spawn(runtime, 'sdk-shapes', [task('shape')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'task was not prompted')

    const create = sdk.calls.find((call) => call.name === 'create')!.input
    const prompt = sdk.calls.find((call) => call.name === 'promptAsync')!.input
    assert.deepEqual(create.body, { title: '[sdk-shapes] test-agent: shape', parentID: 'caller-session' })
    assert.deepEqual(create.query, { directory: '/project' })
    assert.equal(create.throwOnError, true)
    assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'Run shape' }])
    assert.equal(prompt.body.content, undefined)
    assert.deepEqual(prompt.body.model, { providerID: 'provider', modelID: 'model' })
    assert.deepEqual(prompt.query, { directory: '/project' })

    sdk.messages.set('session-1', [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hello' }, { type: 'tool' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'final' }, { type: 'text', text: 'answer' }] },
    ])
    const collected = await runtime.collectResults('caller-session', 'sdk-shapes')
    assert.equal(collected.results.shape, 'final\nanswer')

    const cancelled = await runtime.cancelTask('caller-session', 'sdk-shapes', 'shape')
    assert.equal(cancelled.cancelled, true)
    const abort = sdk.calls.find((call) => call.name === 'abort')!.input
    assert.deepEqual(abort.path, { id: 'session-1' })
    assert.deepEqual(abort.query, { directory: '/project' })
  })

  it('does not declare cancellation terminal until session termination is observed', async () => {
    const sdk = fakeSdk()
    sdk.client.session.status = async () => ({ data: { 'session-1': { type: 'busy' } } })
    const runtime = createRuntime(sdk)
    spawn(runtime, 'stubborn-cancel', [task('stubborn')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'task was not prompted')

    const cancelled = await runtime.cancelTask('caller-session', 'stubborn-cancel', 'stubborn', 10)

    assert.equal(cancelled.cancelled, false)
    assert.equal(cancelled.terminal, false)
    assert.match(cancelled.error ?? '', /termination was not observed/)
    await idle(runtime, 'session-1')
  })

  it('uses the v2 client for tasks with explicit session permissions', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-restricted-'))
    temporaryDirectories.push(configDirectory)
    let createInput: any
    const runtime = new SwarmRuntime(sdk.client, {}, {
      autonomyClient: {
        session: {
          create: async (input: any) => {
            createInput = input
            sdk.sessionIds.push('restricted-session')
            return { data: { id: 'restricted-session' } }
          },
        },
      } as any,
      env: runtimeEnvironment(configDirectory),
      restore: false,
      scopeDirectory: '/project',
    })
    runtimes.push(runtime)
    const permission = [
      { permission: '*', pattern: '*', action: 'deny' as const },
      { permission: 'read', pattern: '*', action: 'allow' as const },
    ]

    spawn(runtime, 'restricted', [{ ...task('correction'), permission }])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'restricted task was not prompted')

    assert.equal(sdk.calls.some((call) => call.name === 'create'), false)
    assert.deepEqual(createInput.permission, permission)
    assert.equal(createInput.agent, 'test-agent')
    assert.equal(createInput.parentID, 'caller-session')
  })

  it('cancels queued work without later creating its session', async () => {
    const sdk = fakeSdk()
    const runtime = createRuntime(sdk, { default_concurrency: 1 })
    spawn(runtime, 'queued-cancel', [task('running'), task('queued')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'running task was not prompted')

    const cancelled = await runtime.cancelTask('caller-session', 'queued-cancel', 'queued')
    assert.equal(cancelled.cancelled, true)
    await idle(runtime, 'session-1')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(sdk.sessionIds.length, 1)

    const completed = await runtime.awaitBatch('caller-session', 'queued-cancel', 100)
    assert.deepEqual(completed.results, { running: 'completed', queued: 'cancelled' })
  })

  it('cannot complete while work is queued and reconciles status only once', async () => {
    const sdk = fakeSdk()
    const runtime = createRuntime(sdk, { default_concurrency: 1 })
    spawn(runtime, 'queued-await', [task('first'), task('second')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'first task was not prompted')

    const timedOut = await runtime.awaitBatch('caller-session', 'queued-await', 15)
    assert.deepEqual(timedOut, { batchId: 'queued-await', completed: false, timedOut: true })
    assert.equal(sdk.statusCalls, 1)

    await idle(runtime, 'session-1')
    await waitFor(() => sdk.calls.filter((call) => call.name === 'promptAsync').length === 2, 'second task did not drain')
    const completion = runtime.awaitBatch('caller-session', 'queued-await', 100)
    assert.equal(sdk.statusCalls, 1, 'await polled status after its one-time reconciliation')
    await idle(runtime, 'session-2')
    assert.equal((await completion).completed, true)
  })

  it('honors caller cancellation while initial status reconciliation is pending', async () => {
    const sdk = fakeSdk()
    sdk.client.session.status = async () => new Promise(() => {})
    const runtime = createRuntime(sdk)
    spawn(runtime, 'reconcile-abort', [task('active')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'task was not prompted')
    const controller = new AbortController()
    const reason = new Error('deadline reached')
    const pending = runtime.awaitBatch('caller-session', 'reconcile-abort', 1000, controller.signal)
    setTimeout(() => controller.abort(reason), 10)

    await assert.rejects(pending, /deadline reached/)
    assert.equal(reason.name, 'Error')
  })

  it('restores running and queued work from the caller session runtime', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-restore-'))
    temporaryDirectories.push(configDirectory)
    const config = { default_concurrency: 1 }
    const firstRuntime = createRuntimeAt(sdk, configDirectory, config, false)
    spawn(firstRuntime, 'durable', [task('first'), task('second')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'first task was not prompted')

    const storePath = path.join(
      getSessionRuntimeDir('caller-session', runtimeEnvironment(configDirectory)),
      'swarm-batches.json',
    )
    assert.equal(fs.existsSync(storePath), true)
    firstRuntime.dispose()

    const restoredRuntime = createRuntimeAt(sdk, configDirectory, config, true)
    assert.equal(sdk.sessionIds.length, 1, 'restore must not create sessions before explicit resume')
    assert.equal(restoredRuntime.restoredBatchAuthorization('caller-session', 'durable')?.tasks.length, 2)
    assert.equal(restoredRuntime.resumeRestoredBatch('caller-session', 'durable'), true)
    await idle(restoredRuntime, 'session-1')
    await waitFor(() => sdk.sessionIds.length === 2, 'restored queue did not drain')
    await waitFor(() => sdk.calls.filter((call) => call.name === 'promptAsync').length === 2, 'restored task was not prompted')
    await idle(restoredRuntime, 'session-2')

    const result = await restoredRuntime.awaitBatch('caller-session', 'durable', 100)
    assert.deepEqual(result.results, { first: 'completed', second: 'completed' })
  })

  it('restores batches only in the plugin instance that owns their project', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-scope-'))
    temporaryDirectories.push(configDirectory)
    const environment = runtimeEnvironment(configDirectory)
    const first = new SwarmRuntime(sdk.client, { default_concurrency: 1 }, {
      env: environment,
      restore: false,
      scopeDirectory: '/project-a',
    })
    runtimes.push(first)
    first.spawnBatch({
      batchId: 'scoped',
      callerSessionId: 'caller-session',
      directory: '/project-a',
      tasks: [task('first'), task('second')],
    })
    await waitFor(() => sdk.sessionIds.length === 1, 'first scoped task did not start')
    first.dispose()

    const foreign = new SwarmRuntime(sdk.client, { default_concurrency: 1 }, {
      env: environment,
      restore: true,
      scopeDirectory: '/project-b',
    })
    runtimes.push(foreign)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(sdk.sessionIds.length, 1)
    await assert.rejects(foreign.awaitBatch('caller-session', 'scoped', 10), /not found/)
  })

  it('persists progress timestamps before restart', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-progress-'))
    temporaryDirectories.push(configDirectory)
    let now = 1_000
    const environment = runtimeEnvironment(configDirectory)
    const runtime = new SwarmRuntime(sdk.client, {}, {
      env: environment,
      now: () => now,
      restore: false,
      scopeDirectory: '/project',
    })
    runtimes.push(runtime)
    spawn(runtime, 'progress', [task('active')])
    await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'progress task did not start')

    now = 2_000
    await runtime.handleEvent({
      type: 'message.updated',
      properties: { info: { sessionID: 'session-1' } },
    })
    const storePath = path.join(getSessionRuntimeDir('caller-session', environment), 'swarm-batches.json')
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    const storedTask = stored.batches[0].tasks[0]
    assert.equal(storedTask.lastProgressAt, 2_000)
    assert.equal(storedTask.progressEvents, 1)
  })

  it('asks task permission for the target agent before the plugin creates a child session', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-plugin-'))
    temporaryDirectories.push(configDirectory)
    const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDirectory

    try {
      const hooks = await SwarmManager({ client: sdk.client, directory: '/project' } as any)
      const requests: Array<{ permission: string; patterns: string[]; metadata: Record<string, unknown> }> = []
      const context: ToolContext = {
        sessionID: 'caller-session',
        messageID: 'message-1',
        agent: 'supervisor',
        directory: '/project',
        worktree: '/project',
        abort: new AbortController().signal,
        metadata() {},
        async ask(request) {
          assert.equal(sdk.sessionIds.length, 0, 'session was created before permission was granted')
          requests.push(request)
        },
      }

      await hooks.tool!.swarm_spawn_batch.execute({
        batchId: 'permission',
        tasks: [task('authorized')],
        workingDir: undefined,
      }, context)
      await waitFor(() => sdk.sessionIds.length === 1, 'authorized child session was not created')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].permission, 'task')
      assert.deepEqual(requests[0].patterns, ['test-agent'])
      assert.equal(requests[0].metadata.subagent_type, 'test-agent')
      await hooks.dispose?.()
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
    }
  })

  it('runs the configured fixed-point review tool through the swarm runtime', async () => {
    const sdk = fakeSdk()
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-fixed-review-plugin-'))
    temporaryDirectories.push(configDirectory)
    const projectDirectory = path.join(configDirectory, 'project')
    fs.mkdirSync(path.join(projectDirectory, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDirectory, 'src', 'example.ts'), 'export const value = true\n')
    const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    fs.writeFileSync(path.join(configDirectory, 'workflows.json'), JSON.stringify({
      review_loop: {
        enabled: true,
        max_iterations: 2,
        batch_timeout_ms: 1000,
        max_result_bytes: 10_000,
        correction_agent: 'wf-executor',
        correction_focus: 'Correct every issue.',
        reviewers: [{
          id: 'functional',
          agent: 'wf-reviewer-deep',
          always: true,
          risk_tags: [],
          focus: 'Review functional correctness.',
        }],
      },
    }))
    const server = http.createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'session-1' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const serverUrl = new URL(`http://127.0.0.1:${address.port}`)

    try {
      const hooks = await SwarmManager({ client: sdk.client, directory: projectDirectory, serverUrl } as any)
      const requestedPatterns: string[] = []
      const context: ToolContext = {
        sessionID: 'caller-session',
        messageID: 'message-1',
        agent: 'supervisor',
        directory: projectDirectory,
        worktree: projectDirectory,
        abort: new AbortController().signal,
        metadata() {},
        async ask(request) { requestedPatterns.push(...request.patterns) },
      }
      const resultPromise = hooks.tool!.swarm_review_fixed_point.execute({
        summary: 'Review the implementation.',
        changedFiles: ['src/example.ts'],
        riskTags: [],
      }, context)
      await waitFor(() => sdk.calls.some((call) => call.name === 'promptAsync'), 'review task was not prompted')
      sdk.messages.set('session-1', [{
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: JSON.stringify({
          verdict: 'pass',
          summary: 'Accepted',
          issues: [],
          resolved_issue_ids: [],
        }) }],
      }])
      await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } } as any)

      const result = JSON.parse(await resultPromise as string)
      assert.equal(result.status, 'accepted')
      assert.deepEqual(requestedPatterns, ['src/example.ts', 'wf-reviewer-deep'])
      await hooks.dispose?.()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
    }
  })
})
