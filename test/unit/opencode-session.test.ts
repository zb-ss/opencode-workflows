import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OpenCodeSessionAdapter, unwrapSdkResult } from '../../lib/opencode-session.ts'

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
    const adapter = new OpenCodeSessionAdapter(client, '/project')
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
  })
})
