import type { ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { AutoWorkflow } from '../../plugin/auto-workflow.ts'

describe('bounded automatic workflow plugin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-auto-plugin-'))
  const configDirectory = path.join(root, 'config')
  const worktree = path.join(root, 'project')
  const directory = path.join(worktree, 'app')
  const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
  let baseUrl = ''
  let childSequence = 0
  let agentRequestCount = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/agent') {
      agentRequestCount++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([
        {
          name: 'supervisor',
          mode: 'primary',
          permission: [{ permission: 'task', pattern: 'wf-*', action: 'allow' }],
          options: {},
        },
        {
          name: 'wf-architect',
          mode: 'subagent',
          permission: [
            { permission: 'read', pattern: '*', action: 'allow' },
            { permission: 'edit', pattern: '*', action: 'allow' },
            { permission: 'glob', pattern: '*', action: 'allow' },
            { permission: 'list', pattern: '*', action: 'allow' },
            { permission: 'todowrite', pattern: '*', action: 'allow' },
          ],
          options: {},
        },
      ]))
      return
    }
    if (request.method === 'POST' && url.pathname === '/session') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const id = `bounded-child-${++childSequence}`
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id,
        slug: id,
        projectID: 'project',
        directory,
        title: body.title,
        agent: body.agent,
        version: 'test',
        time: { created: 1, updated: 1 },
        permission: body.permission,
      }))
      return
    }
    response.writeHead(404).end()
  })

  before(async () => {
    fs.mkdirSync(path.join(configDirectory, 'mode'), { recursive: true })
    fs.mkdirSync(path.join(configDirectory, 'workflow'), { recursive: true })
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(configDirectory, 'workflows.json'), JSON.stringify({
      default_mode: 'standard',
      model_tiers: { low: [], mid: ['provider/model'], high: [] },
      automation: {
        enabled: true,
        autonomy: 'bounded',
        max_parallel_sessions: 1,
        max_sessions: 3,
        max_attempts_per_stage: 2,
        max_wall_time_ms: 60_000,
        max_input_tokens: 1_000,
        max_output_tokens: 1_000,
        max_bounded_read_bytes: 1_000,
        max_bounded_write_bytes: 1_000,
        max_cost_usd: 1,
      },
      validation_broker: {
        enabled: true,
        max_runs_per_workflow: 2,
        operations: {
          smoke: {
            argv: ['/usr/bin/node', '-e', "process.stdout.write('validated')"],
            working_directory: '.',
            permission_pattern: 'node validation-smoke',
            environment: [],
            timeout_ms: 1000,
            max_output_bytes: 1000,
            success_exit_codes: [0],
          },
        },
      },
    }))
    fs.writeFileSync(path.join(configDirectory, 'mode', 'standard.json'), JSON.stringify({
      agent_routing: { planning: 'architect' },
    }))
    fs.writeFileSync(path.join(configDirectory, 'workflow', 'development.json'), JSON.stringify({
      schema_version: 1,
      id: 'development',
      description: 'Bounded plugin smoke test',
      stages: [{
        id: 'planning',
        description: 'Plan',
        agent_role: 'planning',
        model_tier: 'mid',
        prompt: 'Plan the task',
      }],
    }))
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('starts with pre-authorized Task access and writes through the side-effect-free bounded tool', async () => {
    const client = {
      session: {
        prompt: async (input: any) => {
          assert.equal(input.body.format?.type, 'json_schema')
          assert.deepEqual(input.body.format?.schema?.required, ['status', 'summary'])
          assert.equal(input.body.format?.schema?.oneOf, undefined)
          return new Promise(() => {})
        },
        abort: async () => ({ data: true }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
      },
    }
    const hooks = await AutoWorkflow({
      client,
      directory,
      worktree,
      serverUrl: new URL(baseUrl),
    } as any)
    const authorizationRequests: Array<{ permission: string; patterns: string[] }> = []
    const rootContext: ToolContext = {
      sessionID: 'bounded-root',
      messageID: 'root-message',
      agent: 'supervisor',
      directory,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask(request) { authorizationRequests.push(request) },
    }

    const started = JSON.parse(await hooks.tool!.workflow_auto_start.execute({
      workflow_type: 'development',
      task: 'Exercise bounded write transport',
      mode: 'standard',
    }, rootContext) as string)
    assert.equal(started.started, true)
    assert.equal(authorizationRequests.length, 1)
    const childSessionId = started.workflow.stages.planning.session_id
    const childContext = { ...rootContext, sessionID: childSessionId, messageID: 'child-message' }
    const args = { path: './source.ts', content: 'export const bounded = true\n' }

    await hooks['tool.execute.before']!(
      { tool: 'workflow_bounded_write', sessionID: childSessionId, callID: 'write-call' },
      { args },
    )
    const result = JSON.parse(await hooks.tool!.workflow_bounded_write.execute(args, childContext) as string)
    assert.equal(result.written, true)
    assert.deepEqual(authorizationRequests[1], {
      permission: 'workflow_bounded_write',
      patterns: ['app/source.ts'],
      always: [],
      metadata: { workflow_driver: 'automatic', root_session_id: 'bounded-root' },
    })
    assert.equal(fs.readFileSync(path.join(directory, 'source.ts'), 'utf8'), args.content)
    const readArgs = { path: 'nested/../source.ts', offset: 0, length: 100 }
    await hooks['tool.execute.before']!(
      { tool: 'workflow_bounded_read', sessionID: childSessionId, callID: 'read-call' },
      { args: readArgs },
    )
    const readOutput = await hooks.tool!.workflow_bounded_read.execute(readArgs, childContext) as string
    const readResult = JSON.parse(readOutput)
    assert.equal(readResult.content, args.content)
    assert.deepEqual(authorizationRequests[2], {
      permission: 'workflow_bounded_read',
      patterns: ['app/source.ts'],
      always: [],
      metadata: { workflow_driver: 'automatic', root_session_id: 'bounded-root' },
    })
    const defaultReadOutput = await hooks.tool!.workflow_bounded_read.execute(
      { path: 'source.ts', offset: 0 },
      childContext,
    ) as string
    assert.equal(JSON.parse(defaultReadOutput).content, args.content)
    const listOutput = await hooks.tool!.workflow_bounded_list.execute({}, childContext) as string
    assert.deepEqual(JSON.parse(listOutput).entries, [{ name: 'source.ts', type: 'file' }])
    const validationArgs = { operation: 'smoke' }
    await assert.rejects(
      hooks['tool.execute.before']!(
        { tool: 'workflow_validation_run', sessionID: childSessionId, callID: 'validation-call' },
        { args: validationArgs },
      ),
      /not allowed inside a bounded automatic workflow stage/,
    )
    await assert.rejects(
      hooks.tool!.workflow_validation_run.execute(validationArgs, childContext),
      /requires interactive autonomy.*not OS-sandboxed/,
    )
    for (const toolName of [
      'epic_start', 'epic_pause', 'epic_cancel', 'epic_resume', 'epic_redelegate', 'epic_integrate', 'epic_cleanup',
      'epic_budget_update', 'epic_budget_extend',
    ]) {
      await assert.rejects(
        hooks['tool.execute.before']!(
          { tool: toolName, sessionID: childSessionId, callID: `${toolName}-call` },
          { args: {} },
        ),
        /not allowed inside a bounded automatic workflow stage/,
      )
    }
    assert.ok(hooks.tool!.workflow_publication_preview)
    assert.ok(hooks.tool!.workflow_publication_execute)
    assert.ok(hooks.tool!.workflow_publication_status)
    await assert.rejects(
      hooks['tool.execute.before']!(
        { tool: 'workflow_publication_preview', sessionID: childSessionId, callID: 'publication-call' },
        { args: { target: 'public' } },
      ),
      /available only to the owning automatic-workflow root session/,
    )
    const status = JSON.parse(await hooks.tool!.workflow_auto_status.execute({}, rootContext) as string)
    assert.equal(
      status.workflow.budget.usage.bounded_read_bytes,
      Buffer.byteLength(readOutput, 'utf8')
        + Buffer.byteLength(defaultReadOutput, 'utf8')
        + Buffer.byteLength(listOutput, 'utf8'),
    )
    assert.equal(status.workflow.budget.usage.bounded_write_bytes, Buffer.byteLength(args.content, 'utf8'))
    assert.equal(status.workflow.budget.usage.validation_runs, 0)
    await assert.rejects(
      hooks['tool.execute.before']!(
        { tool: 'edit', sessionID: childSessionId, callID: 'edit-call' },
        { args: { filePath: 'source.ts' } },
      ),
      /not allowed inside a bounded automatic workflow stage/,
    )
    await assert.rejects(
      hooks.tool!.workflow_bounded_write.execute({ path: 'prettier.config.js', content: 'throw new Error()\n' }, childContext),
      /protected control/,
    )
    const cancelled = JSON.parse(await hooks.tool!.workflow_auto_cancel.execute({}, rootContext) as string)
    assert.equal(cancelled.cancelled, true)
    const requestsBeforeTerminalResume = agentRequestCount
    const resumed = JSON.parse(await hooks.tool!.workflow_auto_resume.execute({}, rootContext) as string)
    assert.equal(resumed.workflow.status, 'cancelled')
    assert.equal(agentRequestCount, requestsBeforeTerminalResume)
    await hooks.dispose?.()
  })
})
