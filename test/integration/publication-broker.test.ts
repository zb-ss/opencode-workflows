import type { ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { PublicationBroker } from '../../lib/publication-broker.ts'
import type { AutomaticWorkflowState } from '../../lib/workflow-engine.ts'
import { WorkflowConfigSchema } from '../../lib/workflow-config.ts'

const GIT = '/usr/bin/git'
const ECHO = ['/usr/bin/echo', '/bin/echo'].find(candidate => fs.existsSync(candidate)) ?? '/bin/echo'
const HAS_RUNTIME = fs.existsSync(GIT) && fs.existsSync(ECHO) && process.platform !== 'win32'
const REMOTE_URL = 'https://example.invalid/public/repository.git'
const temporaryDirectories = new Set<string>()

function git(root: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function workflowState(root: string): AutomaticWorkflowState {
  return {
    schema_version: 1,
    workflow_id: 'wf-publication-e2e',
    definition_id: 'development',
    definition_path: path.join(root, 'definition.json'),
    root_session_id: 'publication-root',
    directory: root,
    worktree: root,
    mode: 'standard',
    autonomy: 'bounded',
    task: 'Publish one reviewed commit',
    status: 'completed',
    pause_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stages: {},
    budget: {
      limits: {
        max_sessions: 1,
        max_parallel_sessions: 1,
        max_attempts_per_stage: 1,
        max_wall_time_ms: 60_000,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_bounded_read_bytes: 0,
        max_bounded_write_bytes: 0,
        max_validation_runs: 0,
        max_cost_usd: null,
      },
      usage: {
        sessions: 0,
        attempts: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        bounded_read_bytes: 0,
        bounded_write_bytes: 0,
        validation_runs: 0,
        messages: {},
      },
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('guarded publication broker integration', { concurrency: false, skip: !HAS_RUNTIME }, () => {
  it('runs preview, complete-history scrub, approval, private request dispatch, and durable status end to end', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-broker-repo-'))
    const runtime = fs.mkdtempSync(path.join(os.homedir(), '.publication-broker-runtime-'))
    temporaryDirectories.add(worktree)
    temporaryDirectories.add(runtime)
    git(worktree, ['init', '--initial-branch=main'])
    git(worktree, ['config', 'user.name', 'Integration Test'])
    git(worktree, ['config', 'user.email', 'integration@example.invalid'])
    git(worktree, ['remote', 'add', 'origin', REMOTE_URL])
    fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n')
    git(worktree, ['add', 'README.md'])
    git(worktree, ['commit', '-m', 'initial'])
    git(worktree, ['branch', 'publication-base'])
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'reviewed publication content\n')
    git(worktree, ['add', 'feature.txt'])
    git(worktree, ['commit', '-m', 'add reviewed publication content'])
    const expectedHead = git(worktree, ['rev-parse', 'HEAD'])

    const env = {
      ...process.env,
      OPENCODE_CONFIG_DIR: path.join(runtime, 'config'),
    }
    const config = WorkflowConfigSchema.parse({
      publication: {
        enabled: true,
        artifact_ttl_ms: 60_000,
        git_timeout_ms: 1000,
        max_artifacts_per_workflow: 5,
        max_commits: 10,
        max_objects: 100,
        max_blob_bytes: 1024 * 1024,
        max_total_scan_bytes: 4 * 1024 * 1024,
        max_findings: 20,
        record_settle_attempts: 200,
        record_settle_delay_ms: 5,
        record_settle_timeout_ms: 1000,
        internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
        targets: {
          public: {
            display_name: 'Public destination',
            git_executable: GIT,
            base_ref: 'refs/heads/publication-base',
            head_ref: 'refs/heads/main',
            remote: 'origin',
            expected_remote_url: REMOTE_URL,
            destination_ref: 'refs/heads/main',
            protection: 'unprotected',
            publisher: {
              argv: [ECHO, '{request_file}'],
              working_directory: '.',
              environment: [],
              timeout_ms: 5000,
              max_output_bytes: 4096,
              success_exit_codes: [0],
            },
          },
        },
      },
    }).publication
    const state = workflowState(worktree)
    const permissionRequests: string[] = []
    const broker = new PublicationBroker(
      config,
      sessionId => sessionId === state.root_session_id ? { snapshot: () => structuredClone(state) } : undefined,
      () => ({
        async assertPermissionAction(_agent, _permission, _patterns, expected) {
          assert.equal(expected, 'ask')
        },
      }),
      { env },
    )
    const context: ToolContext = {
      sessionID: state.root_session_id,
      messageID: 'publication-message',
      agent: 'supervisor',
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask(request) {
        permissionRequests.push(request.permission)
        assert.deepEqual(request.always, [])
      },
    }

    const preview = JSON.parse(await broker.preview('public', context))
    assert.equal(preview.status, 'ready')
    assert.equal(preview.source.head_oid, expectedHead)
    assert.deepEqual(preview.findings, [])

    const execution = JSON.parse(await broker.execute(
      preview.artifact_id,
      preview.artifact_sha256,
      context,
    ))
    assert.equal(execution.status, 'ambiguous', JSON.stringify(execution))
    assert.equal(execution.reconciliation_required, true)
    assert.deepEqual(permissionRequests, ['workflow_publication_preview', 'workflow_publication_external'])

    const status = JSON.parse(await broker.status(preview.artifact_id, context))
    assert.equal(status.artifacts[0].execution.status, 'ambiguous')
    assert.deepEqual(
      fs.readdirSync(path.join(runtime, 'config', 'workflows', 'runtime', 'sessions')).length,
      1,
    )
  })
})
