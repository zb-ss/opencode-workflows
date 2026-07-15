import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ValidationOperationSchema, WorkflowConfigSchema, modelCandidatesForAgent } from '../../lib/workflow-config.ts'

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

  it('requires complete opt-in validation and fixed-point review policies', () => {
    assert.throws(
      () => WorkflowConfigSchema.parse({ validation_broker: { enabled: true, operations: {} } }),
      /max_runs_per_workflow|at least one operation/,
    )
    const config = WorkflowConfigSchema.parse({
      validation_broker: {
        enabled: true,
        max_runs_per_workflow: 2,
        operations: {
          check: {
            argv: ['/opt/tools/npm', 'test'],
            working_directory: '.',
            permission_pattern: 'npm test',
            environment: [],
            timeout_ms: 1000,
            max_output_bytes: 1000,
            success_exit_codes: [0],
          },
        },
      },
      review_loop: {
        enabled: true,
        max_iterations: 2,
        batch_timeout_ms: 1000,
        max_result_bytes: 1000,
        correction_agent: 'wf-executor',
        correction_focus: 'Correct every issue.',
        reviewers: [{
          id: 'functional',
          agent: 'wf-reviewer',
          always: true,
          risk_tags: [],
          focus: 'Review functional behavior.',
        }],
      },
    })
    assert.equal(config.validation_broker.operations.check.argv[0], '/opt/tools/npm')
    assert.equal(config.review_loop.reviewers[0].id, 'functional')

    assert.throws(
      () => WorkflowConfigSchema.parse({
        validation_broker: {
          enabled: true,
          max_runs_per_workflow: 1,
          operations: {
            unsafe: {
              argv: ['sh', '-c', 'command'],
              working_directory: '.',
              permission_pattern: 'unsafe',
              environment: [],
              timeout_ms: 1000,
              max_output_bytes: 1000,
              success_exit_codes: [0],
            },
          },
        },
      }),
      /operator-configured absolute path/,
    )
  })

  it('enforces one 64-character identifier contract across validation and review configuration', () => {
    const identifier = `a${'b'.repeat(63)}`
    const tooLong = `${identifier}c`
    const operation = {
      argv: ['/opt/tools/node', '--version'],
      working_directory: '.',
      permission_pattern: 'node version',
      environment: [],
      timeout_ms: 1000,
      max_output_bytes: 1000,
      success_exit_codes: [0],
    }

    assert.doesNotThrow(() => WorkflowConfigSchema.parse({
      validation_broker: { enabled: false, operations: { [identifier]: operation } },
      review_loop: {
        enabled: false,
        reviewers: [{ id: identifier, agent: identifier, always: true, risk_tags: [identifier], focus: 'Review.' }],
      },
    }))
    assert.throws(
      () => WorkflowConfigSchema.parse({ validation_broker: { enabled: false, operations: { [tooLong]: operation } } }),
      /Too big|<=64/,
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({
        review_loop: {
          enabled: false,
          reviewers: [{ id: tooLong, agent: 'reviewer', always: true, risk_tags: [], focus: 'Review.' }],
        },
      }),
      /Too big|<=64/,
    )
  })

  it('rejects unknown validation and review policy fields consistently with JSON Schema', () => {
    assert.throws(
      () => WorkflowConfigSchema.parse({
        validation_broker: { enabled: false, operations: {}, misspelled_limit: 1 },
      }),
      /Unrecognized key|misspelled_limit/,
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({
        review_loop: { enabled: false, reviewers: [], correction_agents: 'wf-executor' },
      }),
      /Unrecognized key|correction_agents/,
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({
        review_loop: {
          enabled: false,
          reviewers: [
            { id: 'duplicate', agent: 'reviewer', always: true, risk_tags: [], focus: 'Review.' },
            { id: 'duplicate', agent: 'security', always: false, risk_tags: ['security'], focus: 'Secure.' },
          ],
        },
      }),
      /duplicate reviewer ID/,
    )
  })

  it('keeps validation-operation JSON Schema string constraints aligned with runtime parsing', () => {
    const publicSchema = JSON.parse(fs.readFileSync(path.resolve('schema/workflows.schema.json'), 'utf8'))
    const AjvConstructor = Ajv2020 as unknown as new (options: object) => {
      compile(schema: object): (input: unknown) => boolean
    }
    const validate = new AjvConstructor({ strict: true, strictTuples: false }).compile(publicSchema.$defs.validationOperation)
    const valid = {
      argv: ['/opt/tools/node', '--version'],
      working_directory: '.',
      permission_pattern: 'node version',
      environment: [],
      timeout_ms: 1000,
      max_output_bytes: 1000,
      success_exit_codes: [0],
    }
    const candidates = [
      valid,
      { ...valid, argv: [`/${'a'.repeat(1024)}`] },
      { ...valid, argv: ['/opt/tools/node\0hidden'] },
      { ...valid, argv: ['/opt/tools/node', 'arg\0hidden'] },
      { ...valid, working_directory: '.\0hidden' },
      { ...valid, working_directory: 'C:\\temp' },
      { ...valid, working_directory: '\\temp' },
      { ...valid, working_directory: '\\\\server\\share' },
      { ...valid, permission_pattern: 'node\0hidden' },
      { ...valid, environment: [`A${'B'.repeat(1024)}`] },
    ]

    for (const candidate of candidates) {
      assert.equal(validate(candidate), ValidationOperationSchema.safeParse(candidate).success)
    }

    const validateWorkflow = new AjvConstructor({
      strict: true,
      strictRequired: false,
      strictTuples: false,
    }).compile(publicSchema)
    const base = {
      schema_version: 1,
      model_tiers: { low: [], mid: [], high: [] },
      agent_models: {},
      agent_variants: {},
      fallback_order: [],
      default_mode: 'standard',
      automation: { enabled: false },
      experimental_capabilities: {},
    }
    for (const policy of [
      { validation_broker: { enabled: false } },
      { review_loop: { enabled: false } },
    ]) {
      const candidate = { ...base, ...policy }
      assert.equal(validateWorkflow(candidate), WorkflowConfigSchema.safeParse(candidate).success)
    }
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
