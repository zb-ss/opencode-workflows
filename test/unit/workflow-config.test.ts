import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelCandidatesForAgent } from '../../lib/workflow-config.ts'

describe('workflow config', () => {
  it('normalizes variants and deduplicates real fallback candidates', () => {
    const config: any = {
      model_tiers: { low: [], mid: ['provider/primary'], high: [] },
      agent_models: {},
      agent_variants: { 'wf-executor': 'high' },
      fallback_order: ['provider/primary', { model: 'other/fallback', variant: 'medium' }],
    }
    assert.deepEqual(modelCandidatesForAgent(config, 'wf-executor', 'mid'), [
      { model: 'provider/primary', variant: 'high' },
      { model: 'other/fallback', variant: 'medium' },
    ])
  })
})
