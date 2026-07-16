import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  MAX_PUBLICATION_ARTIFACTS_PER_WORKFLOW,
  MAX_PUBLICATION_ARTIFACT_TTL_MS,
  MAX_PUBLICATION_BLOB_BYTES,
  MAX_PUBLICATION_COMMITS,
  MAX_PUBLICATION_FINDINGS,
  MAX_PUBLICATION_OBJECTS,
  MAX_PUBLICATION_OUTPUT_BYTES,
  MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS,
  MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS,
  MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS,
  MAX_PUBLICATION_TIMEOUT_MS,
  MAX_PUBLICATION_TOTAL_SCAN_BYTES,
  ValidationOperationSchema,
  WorkflowConfigSchema,
  enabledPublication,
  modelCandidatesForAgent,
} from '../../lib/workflow-config.ts'

function publicationTarget() {
  return {
    display_name: 'Example destination',
    git_executable: '/opt/tools/git',
    base_ref: 'refs/heads/base',
    head_ref: 'refs/heads/review',
    remote: 'upstream',
    expected_remote_url: 'https://example.invalid/organization/repository.git',
    destination_ref: 'refs/heads/destination',
    protection: 'approval_required' as const,
    publisher: {
      argv: ['/opt/tools/publisher', '{request_file}'],
      working_directory: '.',
      environment: ['PUBLICATION_MODE'],
      timeout_ms: 1000,
      max_output_bytes: 1000,
      success_exit_codes: [0],
    },
  }
}

function enabledPublicationInput() {
  return {
    enabled: true,
    ...publicationLimits(),
    internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
    targets: { example: publicationTarget() },
  }
}

function publicationLimits() {
  return {
    artifact_ttl_ms: 1000,
    git_timeout_ms: 1000,
    max_artifacts_per_workflow: 2,
    max_commits: 10,
    max_objects: 20,
    max_blob_bytes: 1000,
    max_total_scan_bytes: 2000,
    max_findings: 5,
    record_settle_attempts: 200,
    record_settle_delay_ms: 5,
    record_settle_timeout_ms: 1000,
  }
}

function publicationWithPublisher(overrides: Record<string, unknown>) {
  const target = publicationTarget()
  return WorkflowConfigSchema.safeParse({
    publication: {
      enabled: false,
      targets: {
        example: { ...target, publisher: { ...target.publisher, ...overrides } },
      },
    },
  })
}

function workflowSchemaInput(publication: unknown) {
  return {
    schema_version: 1,
    model_tiers: { low: [], mid: [], high: [] },
    agent_models: {},
    agent_variants: {},
    fallback_order: [],
    default_mode: 'standard',
    automation: { enabled: false },
    publication,
    experimental_capabilities: {},
  }
}

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

  it('defaults guarded publication to a disabled empty policy', () => {
    assert.deepEqual(WorkflowConfigSchema.parse({}).publication, {
      enabled: false,
      internal_markers: [],
      targets: {},
    })
    assert.deepEqual(WorkflowConfigSchema.parse({ publication: {} }).publication, {
      enabled: false,
      internal_markers: [],
      targets: {},
    })
  })

  it('accepts incomplete but valid target drafts only while publication is disabled', () => {
    const config = WorkflowConfigSchema.parse({
      publication: {
        enabled: false,
        internal_markers: [],
        targets: {
          draft: {
            display_name: 'Draft destination',
            publisher: { working_directory: 'nested/project' },
          },
        },
      },
    })
    assert.equal(config.publication.targets.draft.display_name, 'Draft destination')

    assert.equal(WorkflowConfigSchema.safeParse({
      publication: {
        ...config.publication,
        enabled: true,
        ...publicationLimits(),
        internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
      },
    }).success, false)
  })

  it('requires a complete explicit policy and target before publication can be enabled', () => {
    const parsed = WorkflowConfigSchema.parse({ publication: enabledPublicationInput() }).publication
    const enabled = enabledPublication(parsed)
    assert.equal(enabled.targets.example.publisher.argv[1], '{request_file}')

    const requiredLimits = [
      'artifact_ttl_ms',
      'git_timeout_ms',
      'max_artifacts_per_workflow',
      'max_commits',
      'max_objects',
      'max_blob_bytes',
      'max_total_scan_bytes',
      'max_findings',
      'record_settle_attempts',
      'record_settle_delay_ms',
      'record_settle_timeout_ms',
    ] as const
    for (const field of requiredLimits) {
      const publication: Record<string, unknown> = structuredClone(enabledPublicationInput())
      delete publication[field]
      assert.equal(
        WorkflowConfigSchema.safeParse({ publication }).success,
        false,
        `${field} must be required`,
      )
    }

    const noTargets = { ...enabledPublicationInput(), targets: {} }
    assert.throws(
      () => WorkflowConfigSchema.parse({ publication: noTargets }),
      /at least one target is required/,
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({
        publication: { ...enabledPublicationInput(), internal_markers: [] },
      }),
      /at least one internal marker is required/,
    )
    assert.throws(
      () => enabledPublication(WorkflowConfigSchema.parse({}).publication),
      /complete enabled configuration/,
    )
  })

  it('enforces every publication safety limit and exported maximum', () => {
    const limits = [
      ['artifact_ttl_ms', MAX_PUBLICATION_ARTIFACT_TTL_MS],
      ['git_timeout_ms', MAX_PUBLICATION_TIMEOUT_MS],
      ['max_artifacts_per_workflow', MAX_PUBLICATION_ARTIFACTS_PER_WORKFLOW],
      ['max_commits', MAX_PUBLICATION_COMMITS],
      ['max_objects', MAX_PUBLICATION_OBJECTS],
      ['max_blob_bytes', MAX_PUBLICATION_BLOB_BYTES],
      ['max_total_scan_bytes', MAX_PUBLICATION_TOTAL_SCAN_BYTES],
      ['max_findings', MAX_PUBLICATION_FINDINGS],
      ['record_settle_attempts', MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS],
      ['record_settle_delay_ms', MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS],
      ['record_settle_timeout_ms', MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS],
    ] as const
    for (const [field, maximum] of limits) {
      const atMaximum = { ...enabledPublicationInput(), [field]: maximum }
      assert.doesNotThrow(() => WorkflowConfigSchema.parse({ publication: atMaximum }))
      assert.equal(
        WorkflowConfigSchema.safeParse({ publication: { ...atMaximum, [field]: maximum + 1 } }).success,
        false,
        `${field} must reject values above its maximum`,
      )
      assert.equal(
        WorkflowConfigSchema.safeParse({ publication: { ...atMaximum, [field]: 0 } }).success,
        false,
        `${field} must be positive`,
      )
    }
    assert.equal(MAX_PUBLICATION_TIMEOUT_MS, 3_600_000)
    assert.equal(MAX_PUBLICATION_OUTPUT_BYTES, 16_777_216)
  })

  it('rejects duplicate marker IDs and case-normalized literals', () => {
    assert.throws(
      () => WorkflowConfigSchema.parse({
        publication: {
          enabled: false,
          internal_markers: [
            { id: 'duplicate', literal: 'first-literal', case_sensitive: true },
            { id: 'duplicate', literal: 'second-literal', case_sensitive: false },
          ],
          targets: {},
        },
      }),
      /duplicate publication marker ID: duplicate/,
    )
    assert.throws(
      () => WorkflowConfigSchema.parse({
        publication: {
          enabled: false,
          internal_markers: [
            { id: 'first', literal: 'Internal-Marker', case_sensitive: true },
            { id: 'second', literal: 'internal-marker', case_sensitive: true },
          ],
          targets: {},
        },
      }),
      /duplicate case-normalized publication marker literal/,
    )
  })

  it('validates marker, target, executable, path, and full-ref constraints while disabled', () => {
    const invalidMarkers = [
      { id: 'not safe', literal: 'valid', case_sensitive: false },
      { id: 'safe', literal: 'x', case_sensitive: false },
      { id: 'safe', literal: 'null\0byte', case_sensitive: false },
      { id: 'safe', literal: 'x'.repeat(257), case_sensitive: false },
    ]
    for (const marker of invalidMarkers) {
      assert.equal(WorkflowConfigSchema.safeParse({
        publication: { enabled: false, internal_markers: [marker], targets: {} },
      }).success, false)
    }

    const invalidTargets = [
      { example: { display_name: '' } },
      { example: { display_name: 'null\0byte' } },
      { example: { git_executable: 'git' } },
      { example: { git_executable: '/opt/tools/git\0hidden' } },
      { example: { remote: 'not safe' } },
      { 'not safe': {} },
      { example: { expected_remote_url: '' } },
      { example: { expected_remote_url: 'ssh://example.invalid' } },
      { example: { expected_remote_url: 'url\0hidden' } },
      { example: { protection: 'sometimes' } },
    ]
    for (const targets of invalidTargets) {
      assert.equal(WorkflowConfigSchema.safeParse({
        publication: { enabled: false, internal_markers: [], targets },
      }).success, false)
    }

    for (const ref of [
      'heads/main',
      'refs/tags/release',
      'refs/heads/has space',
      'refs/heads/-leading-dash',
      'refs/heads/.hidden',
      'refs/heads/trailing.',
      'refs/heads/name.lock',
      'refs/heads/two..dots',
      'refs/heads/reflog@{one',
      'refs//heads/main',
      'refs/heads/back\\slash',
    ]) {
      assert.equal(WorkflowConfigSchema.safeParse({
        publication: { enabled: false, targets: { example: { base_ref: ref } } },
      }).success, false, `${ref} must not be accepted as a full Git ref`)
    }
    assert.doesNotThrow(() => WorkflowConfigSchema.parse({
      publication: {
        enabled: false,
        targets: { example: { git_executable: 'C:\\Tools\\git.exe', base_ref: 'refs/heads/main' } },
      },
    }))
  })

  it('restricts publisher argv to the exact request protocol and validates all execution fields', () => {
    const invalidArgv = [
      ['publisher', '{request_file}'],
      ['/opt/tools/publisher'],
      ['/opt/tools/publisher', '{request_file}', '{request_file}'],
      ['/opt/tools/publisher', '--request={request_file}'],
      ['/opt/tools/publisher', '{other_placeholder}', '{request_file}'],
      ['/opt/tools/{publisher}', '{request_file}'],
      ['/opt/tools/publisher', 'null\0byte', '{request_file}'],
    ]
    for (const argv of invalidArgv) {
      assert.equal(publicationWithPublisher({ argv }).success, false, `argv must be rejected: ${argv.join(' ')}`)
    }

    for (const workingDirectory of ['/tmp', 'C:\\temp', '\\temp', '..', 'nested/../../outside', '.\0hidden']) {
      assert.equal(publicationWithPublisher({ working_directory: workingDirectory }).success, false)
    }
    assert.equal(publicationWithPublisher({ environment: ['VALID', 'VALID'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: ['not-valid'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: ['LD_PRELOAD'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: ['NODE_OPTIONS'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: ['GIT_SSH_COMMAND'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: ['HOME'] }).success, false)
    assert.equal(publicationWithPublisher({ environment: Array.from({ length: 65 }, (_, index) => `ENV_${index}`) }).success, false)
    assert.equal(publicationWithPublisher({ success_exit_codes: [0, 0] }).success, false)
    assert.equal(publicationWithPublisher({ success_exit_codes: [7] }).success, false)
    assert.equal(publicationWithPublisher({ success_exit_codes: [256] }).success, false)
    assert.equal(publicationWithPublisher({ timeout_ms: MAX_PUBLICATION_TIMEOUT_MS + 1 }).success, false)
    assert.equal(publicationWithPublisher({ max_output_bytes: MAX_PUBLICATION_OUTPUT_BYTES + 1 }).success, false)
  })

  it('keeps publication JSON Schema constraints aligned with runtime parsing', () => {
    const publicSchema = JSON.parse(fs.readFileSync(path.resolve('schema/workflows.schema.json'), 'utf8'))
    const AjvConstructor = Ajv2020 as unknown as new (options: object) => {
      compile(schema: object): (input: unknown) => boolean
    }
    const validateWorkflow = new AjvConstructor({
      strict: true,
      strictRequired: false,
      strictTuples: false,
    }).compile(publicSchema)
    const validDisabledDraft = {
      enabled: false,
      internal_markers: [],
      targets: { draft: { display_name: 'Draft' } },
    }
    const validEnabled = enabledPublicationInput()
    const limitMaximums = [
      ['artifact_ttl_ms', MAX_PUBLICATION_ARTIFACT_TTL_MS],
      ['git_timeout_ms', MAX_PUBLICATION_TIMEOUT_MS],
      ['max_artifacts_per_workflow', MAX_PUBLICATION_ARTIFACTS_PER_WORKFLOW],
      ['max_commits', MAX_PUBLICATION_COMMITS],
      ['max_objects', MAX_PUBLICATION_OBJECTS],
      ['max_blob_bytes', MAX_PUBLICATION_BLOB_BYTES],
      ['max_total_scan_bytes', MAX_PUBLICATION_TOTAL_SCAN_BYTES],
      ['max_findings', MAX_PUBLICATION_FINDINGS],
      ['record_settle_attempts', MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS],
      ['record_settle_delay_ms', MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS],
      ['record_settle_timeout_ms', MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS],
    ] as const
    const requiredLimits = limitMaximums.map(([field]) => field)
    const candidates = [
      validDisabledDraft,
      validEnabled,
      ...limitMaximums.map(([field, maximum]) => ({ ...validEnabled, [field]: maximum + 1 })),
      ...requiredLimits.map((field) => {
        const candidate: Record<string, unknown> = structuredClone(validEnabled)
        delete candidate[field]
        return candidate
      }),
      { ...validEnabled, targets: {} },
      { ...validEnabled, internal_markers: [] },
      {
        ...validEnabled,
        internal_markers: [
          { id: 'duplicate', literal: 'same-literal', case_sensitive: false },
          { id: 'duplicate', literal: 'same-literal', case_sensitive: false },
        ],
      },
      {
        ...validEnabled,
        internal_markers: [{ id: 'not safe', literal: 'valid-literal', case_sensitive: false }],
      },
      { ...validEnabled, targets: { example: { ...publicationTarget(), base_ref: 'heads/main' } } },
      { ...validEnabled, targets: { example: { ...publicationTarget(), head_ref: 'refs/tags/release' } } },
      { ...validEnabled, targets: { example: { ...publicationTarget(), git_executable: 'git' } } },
      {
        ...validEnabled,
        targets: {
          example: {
            ...publicationTarget(),
            expected_remote_url: 'https://user:secret@example.invalid/repository.git',
          },
        },
      },
      {
        ...validEnabled,
        targets: {
          example: {
            ...publicationTarget(),
            expected_remote_url: 'file:///tmp/repository.git',
          },
        },
      },
      { ...validEnabled, targets: { 'not safe': publicationTarget() } },
      {
        ...validEnabled,
        targets: {
          example: {
            ...publicationTarget(),
            publisher: { ...publicationTarget().publisher, argv: ['/opt/tools/publisher'] },
          },
        },
      },
      {
        ...validEnabled,
        targets: {
          example: {
            ...publicationTarget(),
            publisher: { ...publicationTarget().publisher, working_directory: '../outside' },
          },
        },
      },
      {
        ...validEnabled,
        targets: {
          example: {
            ...publicationTarget(),
            publisher: { ...publicationTarget().publisher, environment: ['LD_PRELOAD'] },
          },
        },
      },
    ]

    for (const publication of candidates) {
      assert.equal(
        validateWorkflow(workflowSchemaInput(publication)),
        WorkflowConfigSchema.safeParse(workflowSchemaInput(publication)).success,
        JSON.stringify(publication),
      )
    }
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
