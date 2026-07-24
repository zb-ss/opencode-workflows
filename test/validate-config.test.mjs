import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { validateFile } from '../script/validate-config.mjs'

const temporaryDirectories = []

function templateConfig() {
  return JSON.parse(fs.readFileSync(path.resolve('workflows.json.template'), 'utf8'))
}

function enabledPublication() {
  return {
    enabled: true,
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
    internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
    targets: {
      example: {
        display_name: 'Example destination',
        git_executable: '/opt/tools/git',
        base_ref: 'refs/heads/base',
        head_ref: 'refs/heads/review',
        remote: 'upstream',
        expected_remote_url: 'https://example.invalid/organization/repository.git',
        destination_ref: 'refs/heads/destination',
        protection: 'approval_required',
        publisher: {
          argv: ['/opt/tools/publisher', '{request_file}'],
          working_directory: '.',
          environment: [],
          timeout_ms: 1000,
          max_output_bytes: 1000,
          success_exit_codes: [0],
        },
      },
    },
  }
}

function writeConfig(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'))
  temporaryDirectories.push(directory)
  const target = path.join(directory, 'workflows.json')
  fs.writeFileSync(target, JSON.stringify(value))
  return target
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('configuration validator semantics', () => {
  it('accepts disabled epic configuration and requires complete strict enabled limits', () => {
    const disabled = templateConfig()
    assert.deepEqual(disabled.epic, { enabled: false })
    assert.doesNotThrow(() => validateFile(writeConfig(disabled), path.resolve('schema/workflows.schema.json')))

    const enabled = templateConfig()
    enabled.epic = {
      enabled: true,
      max_epic_items: 12,
      max_item_dependencies: 4,
      max_attempts_per_item: 3,
      max_budget_records: 24,
      executor_agent: 'executor-example',
      executor_model_tier: 'mid',
      reviewer_agent: 'reviewer-example',
      reviewer_model_tier: 'mid',
      max_parallel_sessions: 2,
      max_attempt_duration_ms: 60_000,
      active_time_checkpoint_ms: 10_000,
      max_result_bytes: 65_536,
      retry_policy: {
        max_semantic_attempts: 3,
        max_contract_attempts: 3,
        max_transport_attempts: 3,
        max_no_progress_attempts: 2,
        transport_backoff: { strategy: 'exponential', initial_delay_ms: 100, maximum_delay_ms: 1_000, multiplier: 2 },
      },
    }
    assert.doesNotThrow(() => validateFile(writeConfig(enabled), path.resolve('schema/workflows.schema.json')))

    for (const epic of [
      { enabled: true },
      { ...enabled.epic, max_epic_items: 257 },
      { ...enabled.epic, unknown: true },
    ]) {
      const invalid = templateConfig()
      invalid.epic = epic
      assert.throws(() => validateFile(writeConfig(invalid), path.resolve('schema/workflows.schema.json')), /workflows\.json is invalid/)
    }
  })

  it('rejects duplicate fixed-point reviewer IDs before runtime loading', () => {
    const source = templateConfig()
    source.review_loop = {
      enabled: false,
      reviewers: [
        { id: 'duplicate', agent: 'wf-reviewer', always: true, risk_tags: [], focus: 'Review.' },
        { id: 'duplicate', agent: 'wf-security', always: false, risk_tags: ['security'], focus: 'Secure.' },
      ],
    }
    const target = writeConfig(source)

    assert.throws(
      () => validateFile(target, path.resolve('schema/workflows.schema.json')),
      /duplicate review_loop reviewer ID: duplicate/,
    )
  })

  it('accepts a complete guarded publication policy before runtime loading', () => {
    const source = templateConfig()
    source.publication = enabledPublication()
    assert.doesNotThrow(
      () => validateFile(writeConfig(source), path.resolve('schema/workflows.schema.json')),
    )
  })

  it('rejects incomplete and unsafe publication policies before runtime loading', () => {
    const missingLimit = templateConfig()
    missingLimit.publication = enabledPublication()
    delete missingLimit.publication.max_findings

    const missingSettlementTimeout = templateConfig()
    missingSettlementTimeout.publication = enabledPublication()
    delete missingSettlementTimeout.publication.record_settle_timeout_ms

    const oversizedSettlementTimeout = templateConfig()
    oversizedSettlementTimeout.publication = enabledPublication()
    oversizedSettlementTimeout.publication.record_settle_timeout_ms = 60_001

    const unsafeRef = templateConfig()
    unsafeRef.publication = enabledPublication()
    unsafeRef.publication.targets.example.destination_ref = 'heads/main'

    const unsafePublisher = templateConfig()
    unsafePublisher.publication = enabledPublication()
    unsafePublisher.publication.targets.example.publisher.argv = [
      '/opt/tools/publisher',
      '--request={request_file}',
    ]

    const escapingDirectory = templateConfig()
    escapingDirectory.publication = enabledPublication()
    escapingDirectory.publication.targets.example.publisher.working_directory = '../outside'

    const duplicateMarker = templateConfig()
    duplicateMarker.publication = enabledPublication()
    duplicateMarker.publication.internal_markers.push(
      structuredClone(duplicateMarker.publication.internal_markers[0]),
    )

    const duplicateLiteral = templateConfig()
    duplicateLiteral.publication = enabledPublication()
    duplicateLiteral.publication.internal_markers.push({
      id: 'second-marker',
      literal: 'INTERNAL-ONLY',
      case_sensitive: true,
    })

    const unsafeRemote = templateConfig()
    unsafeRemote.publication = enabledPublication()
    unsafeRemote.publication.targets.example.expected_remote_url = 'https://user:secret@example.invalid/repository.git'

    for (const source of [
      missingLimit,
      missingSettlementTimeout,
      oversizedSettlementTimeout,
      unsafeRef,
      unsafePublisher,
      escapingDirectory,
      duplicateMarker,
      duplicateLiteral,
      unsafeRemote,
    ]) {
      assert.throws(
        () => validateFile(writeConfig(source), path.resolve('schema/workflows.schema.json')),
        /workflows\.json is invalid/,
      )
    }
  })
})
