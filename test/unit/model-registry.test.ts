import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadLiveModelCatalog,
  modelCatalogFromProviders,
  selectAvailableModelCandidate,
  selectAvailableModelCandidateFromClient,
  shouldChunkForModel,
  validateModelCandidate,
} from '../../lib/model-registry.ts'

function providerResponse() {
  return {
    data: {
      providers: [{
        id: 'provider-a',
        models: {
          first: {
            id: 'model-one',
            status: 'active',
            limit: { context: 1000 },
            variants: {
              balanced: {},
              disabled: { disabled: true },
            },
          },
          second: { id: 'model-two', variants: { precise: {} } },
        },
      }],
    },
  }
}

describe('model registry', () => {
  it('validates migration strings and candidate variants without model-name inference', () => {
    assert.deepEqual(validateModelCandidate('provider-a/model-one'), { model: 'provider-a/model-one' })
    assert.deepEqual(
      validateModelCandidate({ model: 'provider-a/model-one', variant: 'balanced' }),
      { model: 'provider-a/model-one', variant: 'balanced' },
    )
    assert.throws(
      () => validateModelCandidate({ model: 'provider-a/model-one', variant: 'not valid' }),
      /invalid model variant/,
    )
  })

  it('selects the first live candidate with a valid variant and explains fallbacks', () => {
    const catalog = modelCatalogFromProviders(providerResponse())
    const result = selectAvailableModelCandidate([
      'provider-a/missing',
      { model: 'provider-a/model-one', variant: 'precise' },
      { model: 'provider-a/model-two', variant: 'precise' },
    ], catalog)
    assert.deepEqual(result.selected, { model: 'provider-a/model-two', variant: 'precise' })
    assert.deepEqual(result.diagnostics.map((item) => item.reason), [
      'model_unavailable',
      'variant_unavailable',
      'available',
    ])
    assert.equal(shouldChunkForModel('provider-a/model-one', 801, catalog), true)
  })

  it('queries OpenCode config.providers when a runtime client is available', async () => {
    const calls: unknown[] = []
    const client = {
      config: {
        providers: async (input: unknown) => {
          calls.push(input)
          return providerResponse()
        },
      },
    }
    const catalog = await loadLiveModelCatalog(client, '/workspace')
    assert.equal(catalog.has('provider-a/model-one'), true)
    assert.deepEqual(calls, [{ query: { directory: '/workspace' }, throwOnError: true }])

    const result = await selectAvailableModelCandidateFromClient(
      ['provider-a/model-two'],
      client,
      '/workspace',
    )
    assert.deepEqual(result.selected, { model: 'provider-a/model-two' })
  })
})
