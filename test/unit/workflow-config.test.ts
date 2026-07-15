import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorkflowConfigSchema, modelCandidatesForAgent } from '../../lib/workflow-config.ts'

describe('workflow config', () => {
  it('defaults autonomy to interactive when it is omitted', () => {
    assert.equal(WorkflowConfigSchema.parse({ automation: { enabled: false } }).automation.autonomy, 'interactive')
    assert.equal(WorkflowConfigSchema.parse({}).automation.autonomy, 'interactive')
  })

  it('accepts only portable autonomy profiles', () => {
    assert.equal(
      WorkflowConfigSchema.parse({ automation: { enabled: false, autonomy: 'bounded' } }).automation.autonomy,
      'bounded',
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({ automation: { enabled: false, autonomy: 'unrestricted' } }),
      /Invalid option/,
    )
  })

  it('caps bounded byte budgets at the operational safety limit', () => {
    assert.throws(
      () => WorkflowConfigSchema.parse({
        automation: { enabled: false, max_bounded_read_bytes: (16 * 1024 * 1024) + 1 },
      }),
      /<=16777216/,
    )
  })

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
