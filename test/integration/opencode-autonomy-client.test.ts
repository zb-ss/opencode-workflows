import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import type { OpencodeClient } from '@opencode-ai/sdk'
import type { PermissionRule } from '@opencode-ai/sdk/v2'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'

import { OpenCodeSessionAdapter } from '../../lib/opencode-session.ts'

describe('OpenCode v2 bounded autonomy transport', () => {
  interface CreateBody {
    agent?: string
    parentID?: string
    permission?: PermissionRule[]
    title?: string
  }

  const requests: Array<{ method: string; path: string; body?: CreateBody }> = []
  let baseUrl = ''
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/agent') {
      requests.push({ method: 'GET', path: url.pathname })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([
        {
          name: 'supervisor',
          mode: 'primary',
          permission: [{ permission: 'task', pattern: 'wf-*', action: 'allow' }],
          options: {},
        },
        {
          name: 'wf-executor',
          mode: 'subagent',
          permission: [
            { permission: 'read', pattern: '*', action: 'allow' },
            { permission: 'edit', pattern: '*', action: 'allow' },
            { permission: 'external_directory', pattern: '*', action: 'allow' },
            { permission: 'custom_network_tool', pattern: '*', action: 'allow' },
          ],
          options: {},
        },
      ]))
      return
    }
    if (request.method === 'POST' && url.pathname === '/session') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CreateBody
      requests.push({ method: 'POST', path: url.pathname, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'bounded-child',
        slug: 'bounded-child',
        projectID: 'project',
        directory: '/project',
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  it('lists effective agents and creates a typed child with resolved rules', async () => {
    const autonomyClient = createOpencodeClient({ baseUrl, directory: '/project' })
    const adapter = new OpenCodeSessionAdapter({} as OpencodeClient, '/project', autonomyClient)

    await adapter.assertPermissionAllowed('supervisor', 'task', ['wf-executor'])
    const session = await adapter.create('Bounded child', 'root', {
      agent: 'wf-executor',
      autonomy: 'bounded',
    })

    assert.equal(session.id, 'bounded-child')
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1)
    const create = requests.find((request) => request.method === 'POST')?.body
    assert.ok(create)
    assert.equal(create.agent, 'wf-executor')
    assert.equal(create.parentID, 'root')
    assert.ok(create.permission)
    assert.equal(create.permission.some((rule) => rule.action === 'ask'), false)
    assert.equal(create.permission[0].permission, '*')
    assert.equal(create.permission[0].action, 'deny')
    assert.equal(create.permission.find((rule) => rule.permission === 'workflow_bounded_read')?.action, 'allow')
    assert.equal(create.permission.find((rule) => rule.permission === 'workflow_bounded_write')?.action, 'allow')
    assert.equal(create.permission.slice().reverse().find((rule) => rule.permission === 'edit')?.action, 'deny')
    assert.equal(create.permission.slice().reverse().find((rule) => rule.permission === 'read')?.action, 'deny')
    assert.equal(create.permission.find((rule) => rule.permission === 'external_directory')?.action, 'deny')
    assert.equal(create.permission.some((rule) => rule.permission === 'custom_network_tool'), false)
  })
})
