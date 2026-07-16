import type { ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { getSessionRuntimeDir } from '../../lib/paths.ts'
import { ValidationBroker } from '../../lib/validation-broker.ts'
import { WorkflowConfigSchema } from '../../lib/workflow-config.ts'

const temporaryDirectories: string[] = []
const TRUSTED_NODE_EXECUTABLE = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

interface FixtureOptions {
  bounded?: boolean
  env?: (worktree: string) => NodeJS.ProcessEnv
  onAsk?: (worktree: string) => void | Promise<void>
  platform?: NodeJS.Platform
  terminateProcess?: () => Error | null
}

function fixture(
  operation: Record<string, unknown>,
  consumeValidationRun = async () => 1,
  options: FixtureOptions = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-broker-'))
  temporaryDirectories.push(root)
  const worktree = path.join(root, 'project')
  const configDirectory = path.join(root, 'config')
  fs.mkdirSync(worktree)
  fs.mkdirSync(configDirectory)
  const config = WorkflowConfigSchema.parse({
    validation_broker: {
      enabled: true,
      max_runs_per_workflow: 3,
      operations: { check: operation },
    },
  }).validation_broker
  const owner = {
    usesBoundedAutonomy: () => options.bounded ?? false,
    snapshot: () => ({
      status: 'running',
      worktree,
      workflow_id: 'workflow-1',
      root_session_id: 'root-session',
    }) as any,
    consumeValidationRun,
  }
  const broker = new ValidationBroker(config, () => owner, {
    env: {
      ...process.env,
      ...options.env?.(worktree),
      OPENCODE_CONFIG_DIR: configDirectory,
      BROKER_HIDDEN_VALUE: 'hidden',
    },
    platform: options.platform,
    terminateProcess: options.terminateProcess,
  })
  const permissionRequests: any[] = []
  const controller = new AbortController()
  const context = {
    sessionID: 'stage-session',
    directory: worktree,
    worktree,
    abort: controller.signal,
    async ask(request: unknown) {
      permissionRequests.push(request)
      await options.onAsk?.(worktree)
    },
  } as ToolContext
  return { broker, configDirectory, context, controller, permissionRequests, worktree }
}

function auditRecord(configDirectory: string, auditId: string): Record<string, unknown> {
  const auditDirectory = path.join(
    getSessionRuntimeDir('stage-session', { ...process.env, OPENCODE_CONFIG_DIR: configDirectory }),
    'validation-audit',
  )
  return JSON.parse(fs.readFileSync(path.join(auditDirectory, `${auditId}.json`), 'utf8'))
}

function operation(script: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    argv: [TRUSTED_NODE_EXECUTABLE, '-e', script],
    working_directory: '.',
    permission_pattern: 'node validation-check',
    environment: [],
    timeout_ms: 1000,
    max_output_bytes: 1024,
    success_exit_codes: [0],
    ...overrides,
  }
}

describe('ValidationBroker integration', () => {
  it('rejects executable validation from bounded autonomy before permission or budget use', async () => {
    let consumed = 0
    const fixtureData = fixture(operation('process.exit(0)'), async () => ++consumed, { bounded: true })

    await assert.rejects(
      fixtureData.broker.run('check', fixtureData.context),
      /requires interactive autonomy.*not OS-sandboxed/,
    )
    assert.equal(fixtureData.permissionRequests.length, 0)
    assert.equal(consumed, 0)
  })

  it('runs fixed argv without a shell and persists a private audit record', async () => {
    let consumed = 0
    const fixtureData = fixture(
      operation("process.stdout.write(process.cwd().endsWith('project') && process.env.PATH && !process.env.BROKER_HIDDEN_VALUE ? 'validated' : 'wrong')"),
      async () => ++consumed,
    )

    const result = JSON.parse(await fixtureData.broker.run('check', fixtureData.context))

    assert.equal(result.status, 'passed')
    assert.equal(result.stdout, 'validated')
    assert.equal(result.exit_code, 0)
    assert.equal(consumed, 1)
    assert.equal(fixtureData.permissionRequests[0].permission, 'workflow_validation_run')
    assert.deepEqual(fixtureData.permissionRequests[0].patterns, ['node validation-check'])

    const auditDirectory = path.join(
      getSessionRuntimeDir('stage-session', { ...process.env, OPENCODE_CONFIG_DIR: fixtureData.configDirectory }),
      'validation-audit',
    )
    const audits = fs.readdirSync(auditDirectory)
    assert.deepEqual(audits, [`${result.audit_id}.json`])
    const auditPath = path.join(auditDirectory, audits[0])
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
    assert.equal(audit.operation, 'check')
    assert.equal(audit.executable, fs.realpathSync(TRUSTED_NODE_EXECUTABLE))
    assert.equal(audit.argument_count, 2)
    assert.match(audit.argv_sha256, /^[a-f0-9]{64}$/)
    assert.equal(audit.status, 'passed')
    assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600)
  })

  it('caps combined output and reports timeout and cancellation', async () => {
    const capped = fixture(operation(
      "process.stdout.write('a'.repeat(32)); process.stderr.write('b'.repeat(32))",
      { max_output_bytes: 16 },
    ))
    const cappedResult = JSON.parse(await capped.broker.run('check', capped.context))
    assert.equal(cappedResult.status, 'passed')
    assert.equal(Buffer.byteLength(cappedResult.stdout + cappedResult.stderr, 'utf8') <= 16, true)
    assert.equal(cappedResult.output_truncated, true)
    assert.equal(cappedResult.stdout_bytes + cappedResult.stderr_bytes, 64)
    const cappedAudit = auditRecord(capped.configDirectory, cappedResult.audit_id)
    assert.equal(cappedAudit.stdout_sha256, crypto.createHash('sha256').update('a'.repeat(32)).digest('hex'))
    assert.equal(cappedAudit.stderr_sha256, crypto.createHash('sha256').update('b'.repeat(32)).digest('hex'))

    const timed = fixture(operation('setTimeout(() => {}, 10000)', { timeout_ms: 20 }))
    const timedResult = JSON.parse(await timed.broker.run('check', timed.context))
    assert.equal(timedResult.status, 'timed_out')

    const cancelled = fixture(operation('setTimeout(() => {}, 10000)'))
    const pending = cancelled.broker.run('check', cancelled.context)
    setTimeout(() => cancelled.controller.abort(), 20)
    const cancelledResult = JSON.parse(await pending)
    assert.equal(cancelledResult.status, 'cancelled')
  })

  it('redacts credential-like command output before returning or auditing it', async () => {
    const fixtureData = fixture(operation("process.stdout.write('const password = \\\"supersecret\\\"')"))
    const serialized = await fixtureData.broker.run('check', fixtureData.context)
    const result = JSON.parse(serialized)

    assert.equal(result.status, 'failed')
    assert.equal(result.output_redacted, true)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(serialized, /supersecret/)
    const auditDirectory = path.join(
      getSessionRuntimeDir('stage-session', { ...process.env, OPENCODE_CONFIG_DIR: fixtureData.configDirectory }),
      'validation-audit',
    )
    assert.doesNotMatch(fs.readFileSync(path.join(auditDirectory, fs.readdirSync(auditDirectory)[0]), 'utf8'), /supersecret/)
  })

  it('redacts a credential detected after the returned-output cap across stream chunks', async () => {
    const fixtureData = fixture(operation(
      "process.stdout.write('x'.repeat(16) + '\\npassword=su'); setTimeout(() => process.stdout.write('persecret'), 5)",
      { max_output_bytes: 20 },
    ))

    const serialized = await fixtureData.broker.run('check', fixtureData.context)
    const result = JSON.parse(serialized)
    assert.equal(result.status, 'failed')
    assert.equal(result.output_truncated, true)
    assert.equal(result.output_redacted, true)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(serialized, /pass|secret/)
  })

  it('rejects escaped working directories before permission or budget consumption', async () => {
    let consumed = 0
    const fixtureData = fixture(operation('process.exit(0)', { working_directory: '..' }), async () => ++consumed)

    await assert.rejects(fixtureData.broker.run('check', fixtureData.context), /outside the workflow worktree/)
    assert.equal(fixtureData.permissionRequests.length, 0)
    assert.equal(consumed, 0)
  })

  it('rejects a working directory rebound after permission instead of spawning through the new path', async () => {
    const fixtureData = fixture(operation('process.exit(0)', { working_directory: 'target' }), async () => 1, {
      onAsk(worktree) {
        const target = path.join(worktree, 'target')
        const outside = path.join(path.dirname(worktree), 'outside')
        fs.renameSync(target, `${target}-original`)
        fs.mkdirSync(outside)
        fs.symlinkSync(outside, target, 'dir')
      },
    })
    fs.mkdirSync(path.join(fixtureData.worktree, 'target'))

    await assert.rejects(fixtureData.broker.run('check', fixtureData.context), /ELOOP|ENOTDIR|symbolic link/)
  })

  it('removes relative, worktree, and untrusted writable entries from the child PATH', async () => {
    const fixtureData = fixture(operation("process.stdout.write(/project|external-bin/.test(process.env.PATH) ? 'unsafe' : 'safe')"), async () => 1, {
      env(worktree) {
        const maliciousDirectory = path.join(worktree, 'bin')
        const externalWritableDirectory = path.join(path.dirname(worktree), 'external-bin')
        fs.mkdirSync(maliciousDirectory)
        fs.mkdirSync(externalWritableDirectory, { mode: 0o777 })
        const maliciousExecutable = path.join(maliciousDirectory, 'node')
        fs.writeFileSync(maliciousExecutable, '#!/bin/sh\nprintf compromised', { mode: 0o755 })
        return {
          PATH: [
            '.',
            maliciousDirectory,
            externalWritableDirectory,
            path.dirname(process.execPath),
          ].join(path.delimiter),
        }
      },
    })

    const result = JSON.parse(await fixtureData.broker.run('check', fixtureData.context))
    assert.equal(result.status, 'passed')
    assert.equal(result.stdout, 'safe')
  })

  it('fails closed on Windows before requesting permission or consuming a run', async () => {
    let consumed = 0
    const fixtureData = fixture(operation('process.exit(0)'), async () => ++consumed, { platform: 'win32' })

    await assert.rejects(fixtureData.broker.run('check', fixtureData.context), /unavailable on Windows/)
    assert.equal(fixtureData.permissionRequests.length, 0)
    assert.equal(consumed, 0)
  })

  it('rejects an absolute executable below a world-writable host path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-untrusted-executable-'))
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'check')
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const fixtureData = fixture(operation('process.exit(0)', { argv: [executable] }))

    await assert.rejects(
      fixtureData.broker.run('check', fixtureData.context),
      /not a trusted external regular file/,
    )
  })

  it('reports process termination failure without waiting indefinitely for close', async () => {
    const fixtureData = fixture(operation('setTimeout(() => {}, 100)', { timeout_ms: 5 }), async () => 1, {
      terminateProcess: () => new Error('simulated termination failure'),
    })

    await assert.rejects(
      fixtureData.broker.run('check', fixtureData.context),
      /simulated termination failure/,
    )
  })

  it('persists cancellation without spawning when abort occurs during budget consumption', async () => {
    let controller: AbortController
    const markerName = 'validation-spawned.marker'
    const fixtureData = fixture(operation(
      "require('node:fs').writeFileSync(process.env.VALIDATION_MARKER, 'spawned')",
      { environment: ['VALIDATION_MARKER'] },
    ), async () => {
      controller.abort()
      return 1
    }, {
      env: (worktree) => ({ VALIDATION_MARKER: path.join(worktree, markerName) }),
    })
    controller = fixtureData.controller

    const result = JSON.parse(await fixtureData.broker.run('check', fixtureData.context))
    assert.equal(result.status, 'cancelled')
    assert.equal(fs.existsSync(path.join(fixtureData.worktree, markerName)), false)
    const audit = auditRecord(fixtureData.configDirectory, result.audit_id)
    assert.equal(audit.status, 'cancelled')
  })
})
