import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import type { OpencodeClient as V2OpencodeClient } from '@opencode-ai/sdk/v2'
import { evaluatePermissionRules } from '../../lib/autonomy-policy.ts'
import { OpenCodeSessionAdapter, unwrapSdkResult } from '../../lib/opencode-session.ts'

function legacyClient(value: unknown): OpencodeClient {
  return value as OpencodeClient
}

function autonomyClient(value: unknown): V2OpencodeClient {
  return value as V2OpencodeClient
}

describe('OpenCodeSessionAdapter', () => {
  it('unwraps SDK envelopes and preserves valid 204 responses', () => {
    assert.deepEqual(unwrapSdkResult({ data: { id: 'session-1' } }, 'test'), { id: 'session-1' })
    assert.equal(unwrapSdkResult<void>({ data: undefined, error: undefined }, 'test', true), undefined)
    assert.throws(() => unwrapSdkResult({ error: { message: 'bad' } }, 'test'), /failed/)
  })

  it('uses body, text parts, envelopes, and abort', async () => {
    const calls: Array<{ name: string; input: any }> = []
    const client = {
      session: {
        create: async (input: any) => {
          calls.push({ name: 'create', input })
          return { data: { id: 'session-1' } }
        },
        promptAsync: async (input: any) => {
          calls.push({ name: 'promptAsync', input })
          return { data: undefined, error: undefined }
        },
        abort: async (input: any) => {
          calls.push({ name: 'abort', input })
          return { data: true }
        },
        messages: async () => ({
          data: [
            { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
          ],
        }),
      },
      config: { providers: async () => ({ data: { providers: [] } }) },
    }
    const adapter = new OpenCodeSessionAdapter(legacyClient(client), '/project')
    const session = await adapter.create('Title', 'parent-1')
    await adapter.promptAsync(session.id, 'Prompt', {
      agent: 'wf-executor',
      model: { model: 'provider/model', variant: 'balanced' },
    })
    await adapter.abort(session.id)

    assert.deepEqual(calls[0].input.body, { title: 'Title', parentID: 'parent-1' })
    assert.deepEqual(calls[1].input.body.parts, [{ type: 'text', text: 'Prompt' }])
    assert.equal(calls[1].input.body.variant, 'balanced')
    assert.equal(calls[1].input.body.content, undefined)
    assert.equal(calls[2].name, 'abort')
    assert.equal(await adapter.lastAssistantText(session.id), 'hello\nworld')
    await assert.rejects(adapter.lastAssistantText(session.id, 5), /exceeds configured result bytes/)
  })

  it('returns JSON Schema structured output through the connected prompt transport', async () => {
    let promptInput: any
    const client = {
      session: {
        prompt: async (input: any) => {
          promptInput = input
          return {
            data: {
              info: { role: 'assistant', structured: { status: 'passed' } },
              parts: [],
            },
          }
        },
      },
    }
    const adapter = new OpenCodeSessionAdapter(legacyClient(client), '/project')
    const format = {
      type: 'json_schema' as const,
      schema: { type: 'object', required: ['status'] },
    }

    const result = await adapter.prompt('session-1', 'Return JSON', {
      agent: 'wf-reviewer',
      model: { model: 'ollama/model', variant: 'balanced' },
      format,
    })

    assert.deepEqual(promptInput, {
      path: { id: 'session-1' },
      query: { directory: '/project' },
      body: {
        model: { providerID: 'ollama', modelID: 'model' },
        variant: 'balanced',
        agent: 'wf-reviewer',
        format,
        parts: [{ type: 'text', text: 'Return JSON' }],
      },
      throwOnError: true,
    })
    assert.deepEqual((result.info as any).structured, { status: 'passed' })
  })

  it('serializes structured output through the real SDK HTTP transport', async () => {
    let requestBody: any
    let requestDirectory = ''
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      if (request.method === 'GET' && url.pathname === '/session/session-1/message/message-1') {
        requestDirectory = url.searchParams.get('directory') ?? ''
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          info: { id: 'message-1', sessionID: 'session-1', role: 'assistant' },
          parts: [],
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/session') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ name: 'BadRequest', data: { message: 'create rejected' } }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/session/session-rejected/message') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ name: 'BadRequest', data: { message: 'schema rejected' } }))
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/session/session-1/message') {
        response.writeHead(404).end()
        return
      }
      requestDirectory = url.searchParams.get('directory') ?? ''
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        info: { role: 'assistant', structured: { status: 'passed' } },
        parts: [],
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    try {
      const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
      const adapter = new OpenCodeSessionAdapter(client, '/project')
      const result = await adapter.prompt('session-1', 'Return JSON', {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      })
      assert.deepEqual((result.info as any).structured, { status: 'passed' })
      const recovered = await adapter.message('session-1', 'message-1')
      assert.equal((recovered.info as any).id, 'message-1')
      await assert.rejects(
        adapter.create('Rejected session'),
        (error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'create rejected') return false
          return (error.cause as { status?: number } | undefined)?.status === 400
        },
      )
      await assert.rejects(
        adapter.prompt('session-rejected', 'Return JSON', {
          format: { type: 'json_schema', schema: { type: 'object' } },
        }),
        (error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'schema rejected') return false
          return (error.cause as { status?: number } | undefined)?.status === 400
        },
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }

    assert.equal(requestDirectory, '/project')
    assert.equal(requestBody.format.type, 'json_schema')
    assert.deepEqual(requestBody.format.schema.required, ['status'])
    assert.deepEqual(requestBody.parts, [{ type: 'text', text: 'Return JSON' }])
  })

  it('keeps interactive creation identical even when interactive options are supplied', async () => {
    let createInput: any
    const client = {
      session: {
        create: async (input: any) => {
          createInput = input
          return { data: { id: 'session-1' } }
        },
      },
    }
    const adapter = new OpenCodeSessionAdapter(legacyClient(client), '/project')

    await adapter.create('Title', 'parent-1', { agent: 'executor', autonomy: 'interactive' })

    assert.deepEqual(createInput, {
      body: { title: 'Title', parentID: 'parent-1' },
      query: { directory: '/project' },
      throwOnError: true,
    })
  })

  it('creates bounded sessions with cached effective agent permissions', async () => {
    const createInputs: any[] = []
    let agentCalls = 0
    const boundedClient = {
      app: {
        agents: async (input: any, options: any) => {
          agentCalls++
          assert.deepEqual(input, { directory: '/project' })
          assert.deepEqual(options, { throwOnError: true })
          return {
            data: [
              {
                name: 'supervisor',
                permission: [
                  { permission: 'task', pattern: '*', action: 'ask' },
                  { permission: 'task', pattern: 'executor', action: 'allow' },
                ],
              },
              {
                name: 'executor',
                permission: {
                  bash: { '*': 'ask', 'sudo *': 'deny' },
                  custom_unsafe: 'ask',
                },
              },
            ],
          }
        },
      },
      session: {
        create: async (input: any, options: any) => {
          createInputs.push(input)
          assert.deepEqual(options, { throwOnError: true })
          return { data: { id: `session-${createInputs.length}` } }
        },
      },
    }
    const adapter = new OpenCodeSessionAdapter(
      legacyClient({}),
      '/project',
      autonomyClient(boundedClient),
    )

    await adapter.assertPermissionAllowed('supervisor', 'task', ['executor'])
    await adapter.assertPermissionAction(
      'supervisor',
      'workflow_publication_external',
      ['target:public'],
      'ask',
    )
    await assert.rejects(
      adapter.assertPermissionAction(
        'supervisor',
        'workflow_publication_external',
        ['target:public'],
        'allow',
      ),
      /must resolve to allow; resolved action is ask/,
    )
    await assert.rejects(
      adapter.assertPermissionAllowed('supervisor', 'task', ['wf-security']),
      /resolved action is ask/,
    )
    await adapter.create('One', 'parent-1', { agent: 'executor', autonomy: 'bounded' })
    await adapter.create('Two', undefined, { agent: 'executor', autonomy: 'bounded' })

    assert.equal(agentCalls, 1)
    assert.deepEqual(createInputs[0].permission[0], { permission: '*', pattern: '*', action: 'deny' })
    assert.equal(evaluatePermissionRules(createInputs[0].permission, 'bash', 'sudo command'), 'deny')
    assert.equal(evaluatePermissionRules(createInputs[0].permission, 'custom_unsafe', '*'), 'deny')
    assert.equal(evaluatePermissionRules(createInputs[0].permission, 'workflow_bounded_read', 'source.ts'), 'deny')
    assert.equal(createInputs[0].agent, 'executor')
    assert.equal(createInputs[0].parentID, 'parent-1')
    assert.equal(createInputs[0].permission.some((rule: any) => rule.action === 'ask'), false)
    assert.equal(createInputs[1].parentID, undefined)
  })

  it('creates explicitly restricted sessions without inheriting the agent permission profile', async () => {
    let createInput: any
    const adapter = new OpenCodeSessionAdapter(
      legacyClient({}),
      '/project',
      autonomyClient({
        session: {
          create: async (input: any) => {
            createInput = input
            return { data: { id: 'restricted-session' } }
          },
        },
      }),
    )
    const permission = [
      { permission: '*', pattern: '*', action: 'deny' as const },
      { permission: 'read', pattern: '*', action: 'allow' as const },
    ]

    await adapter.create('Restricted', 'parent-1', { agent: 'wf-executor', permission })

    assert.deepEqual(createInput, {
      directory: '/project',
      title: 'Restricted',
      parentID: 'parent-1',
      agent: 'wf-executor',
      permission,
    })
    await assert.rejects(
      adapter.create('Invalid', undefined, { agent: 'wf-executor', autonomy: 'bounded', permission }),
      /cannot combine/,
    )
  })

  it('fails closed when bounded session prerequisites are unavailable or malformed', async (context) => {
    await context.test('agent is absent', async () => {
      const adapter = new OpenCodeSessionAdapter(legacyClient({}), '/project')
      await assert.rejects(adapter.create('Title', undefined, { autonomy: 'bounded' }), /requires an agent/)
    })

    await context.test('v2 client is unavailable', async () => {
      const adapter = new OpenCodeSessionAdapter(legacyClient({}), '/project')
      await assert.rejects(
        adapter.create('Title', undefined, { agent: 'executor', autonomy: 'bounded' }),
        /requires the OpenCode v2 client/,
      )
    })

    await context.test('agent is not found', async () => {
      const adapter = new OpenCodeSessionAdapter(
        legacyClient({}),
        '/project',
        autonomyClient({ app: { agents: async () => ({ data: [] }) } }),
      )
      await assert.rejects(
        adapter.create('Title', undefined, { agent: 'executor', autonomy: 'bounded' }),
        /agent not found/,
      )
    })

    await context.test('permission data is malformed', async () => {
      const adapter = new OpenCodeSessionAdapter(
        legacyClient({}),
        '/project',
        autonomyClient({ app: { agents: async () => ({ data: [{ name: 'executor', permission: { bash: 42 } }] }) } }),
      )
      await assert.rejects(
        adapter.create('Title', undefined, { agent: 'executor', autonomy: 'bounded' }),
        /permission bash has an invalid rule set/,
      )
    })
  })
})
