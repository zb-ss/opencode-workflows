import type { PluginInput, ToolContext, ToolDefinition } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'

import {
  ExternalCliDelegation,
  getSessionDelegationDirectory,
  getSessionRunsDirectory,
} from '../../plugin/external-cli-delegation.ts'

interface LoggedInvocation {
  provider: 'claude' | 'agy'
  args: string[]
  cwd: string
}

interface Harness {
  configDirectory: string
  worktree: string
  logPath: string
  requests: Array<Parameters<ToolContext['ask']>[0]>
  context(
    sessionID: string,
    ask?: ToolContext['ask'],
    abort?: AbortSignal,
  ): ToolContext
  writeConfig(config: Record<string, unknown>): void
  invocations(): LoggedInvocation[]
}

const fakeCliSource = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const provider = path.basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ provider, args, cwd: process.cwd() }) + '\\n')

if (args.includes('--version')) {
  process.stdout.write(provider + '-fake 1.0.0\\n')
  process.exit(0)
}
if (provider === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true }))
  process.exit(0)
}

const mode = process.env['FAKE_' + provider.toUpperCase() + '_MODE'] || 'success'
const promptIndex = provider === 'claude' ? args.lastIndexOf('--') + 1 : args.indexOf('--print') + 1
const prompt = promptIndex > 0 ? args[promptIndex] : ''

if (mode === 'auth-fail') {
  process.stderr.write('authentication required (401)\\n')
  process.exit(1)
}
if (mode === 'rate-limit') {
  process.stderr.write('rate limit exceeded (429)\\n')
  process.exit(1)
}
if (mode === 'slow') {
  setTimeout(() => process.stdout.write('late response'), 10000)
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(Number(process.env.FAKE_OUTPUT_BYTES || '200000')))
} else if (provider === 'claude') {
  process.stdout.write(JSON.stringify({ result: 'claude:' + prompt, session_id: 'fake-session-token' }))
} else {
  process.stdout.write('antigravity:' + prompt)
}
`

function createHarness(test: TestContext): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-cli-delegation-'))
  const configDirectory = path.join(root, 'config')
  const worktree = path.join(root, 'worktree')
  const binaryDirectory = path.join(root, 'bin')
  const logPath = path.join(root, 'fake-cli.log')
  fs.mkdirSync(configDirectory, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(binaryDirectory, { recursive: true })
  for (const provider of ['claude', 'agy']) {
    const binaryPath = path.join(binaryDirectory, provider)
    fs.writeFileSync(binaryPath, fakeCliSource, { mode: 0o700 })
  }

  const previousEnvironment = {
    configDirectory: process.env.OPENCODE_CONFIG_DIR,
    path: process.env.PATH,
    log: process.env.FAKE_CLI_LOG,
    claudeMode: process.env.FAKE_CLAUDE_MODE,
    agyMode: process.env.FAKE_AGY_MODE,
    outputBytes: process.env.FAKE_OUTPUT_BYTES,
  }
  process.env.OPENCODE_CONFIG_DIR = configDirectory
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousEnvironment.path ?? ''}`
  process.env.FAKE_CLI_LOG = logPath
  delete process.env.FAKE_CLAUDE_MODE
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_OUTPUT_BYTES

  test.after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore('OPENCODE_CONFIG_DIR', previousEnvironment.configDirectory)
    restore('PATH', previousEnvironment.path)
    restore('FAKE_CLI_LOG', previousEnvironment.log)
    restore('FAKE_CLAUDE_MODE', previousEnvironment.claudeMode)
    restore('FAKE_AGY_MODE', previousEnvironment.agyMode)
    restore('FAKE_OUTPUT_BYTES', previousEnvironment.outputBytes)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const requests: Array<Parameters<ToolContext['ask']>[0]> = []
  return {
    configDirectory,
    worktree,
    logPath,
    requests,
    context(
      sessionID: string,
      ask: ToolContext['ask'] = async request => {
        requests.push(request)
      },
      abort = new AbortController().signal,
    ): ToolContext {
      return {
        sessionID,
        messageID: `message-${sessionID}`,
        agent: 'test-agent',
        directory: worktree,
        worktree,
        abort,
        metadata() {},
        ask,
      }
    },
    writeConfig(config: Record<string, unknown>): void {
      fs.writeFileSync(path.join(configDirectory, 'workflows.json'), JSON.stringify(config))
    },
    invocations(): LoggedInvocation[] {
      if (!fs.existsSync(logPath)) return []
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LoggedInvocation)
    },
  }
}

async function pluginTools(): Promise<Record<string, ToolDefinition>> {
  const hooks = await ExternalCliDelegation({} as PluginInput)
  assert.ok(hooks.tool)
  return hooks.tool
}

async function executeJson(
  tools: Record<string, ToolDefinition>,
  toolID: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const result = await tools[toolID].execute(args, context)
  if (typeof result !== 'string') throw new Error(`${toolID} returned a non-string result`)
  return JSON.parse(result) as Record<string, unknown>
}

describe('external CLI delegation', () => {
  it('runs the worktree command from a private runtime checkout', async test => {
    const harness = createHarness(test)
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: harness.worktree, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Integration Test'], { cwd: harness.worktree })
    execFileSync('git', ['config', 'user.email', 'integration@example.com'], { cwd: harness.worktree })
    fs.writeFileSync(path.join(harness.worktree, 'tracked.txt'), 'base\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: harness.worktree })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: harness.worktree, stdio: 'ignore' })

    const tools = await pluginTools()
    const result = await executeJson(tools, 'delegate_command', {
      input: 'exec-worktree claude --task-id task-private --branch main inspect checkout',
    }, harness.context('session-worktree'))
    const invocation = harness.invocations()[0]

    assert.equal(result.success, true)
    assert.match(String(result.branch_name), /^delegate\/session-[a-f0-9]{24}\/task-private$/)
    assert.equal(invocation.cwd.startsWith(`${harness.worktree}${path.sep}`), false)
    assert.ok(invocation.cwd.startsWith(path.join(harness.configDirectory, 'workflows', 'runtime', 'worktrees')))
    assert.equal(fs.existsSync(path.join(invocation.cwd, 'tracked.txt')), true)

    const followup = await executeJson(tools, 'delegate_followup', {
      runId: result.run_id,
      prompt: 'continue in checkout',
    }, harness.context('session-worktree'))
    assert.equal(followup.success, true)
    assert.equal(harness.invocations()[1].cwd, invocation.cwd)
  })

  it('does not spawn when external execution permission is denied', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    const context = harness.context('session-denied', async () => {
      throw new Error('permission denied')
    })

    await assert.rejects(
      tools.delegate_run.execute({ provider: 'claude', prompt: 'do not run' }, context),
      /permission denied/,
    )
    assert.deepEqual(harness.invocations(), [])
  })

  it('kills an in-flight provider when ToolContext aborts', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    process.env.FAKE_CLAUDE_MODE = 'slow'
    const controller = new AbortController()
    const context = harness.context('session-abort', undefined, controller.signal)
    const startedAt = Date.now()
    const execution = tools.delegate_run.execute({
      provider: 'claude',
      prompt: 'wait',
      allowFallback: false,
    }, context)

    const invocationDeadline = Date.now() + 2_000
    while (harness.invocations().length === 0 && Date.now() < invocationDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(harness.invocations().length, 1)
    const abortedAt = Date.now()
    controller.abort(new Error('test abort'))

    await assert.rejects(execution, /test abort/)
    assert.ok(Date.now() - abortedAt < 1_000)
    assert.ok(Date.now() - startedAt < 3_000)
  })

  it('isolates run records by authoritative ToolContext session', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    const firstContext = harness.context('session-one')
    const secondContext = harness.context('session-two')
    const run = await executeJson(tools, 'delegate_run', {
      provider: 'claude',
      prompt: 'session private',
      allowFallback: false,
    }, firstContext)
    const runId = String(run.run_id)

    const firstRead = await executeJson(tools, 'delegate_get_run', { runId }, firstContext)
    const secondRead = await executeJson(tools, 'delegate_get_run', { runId }, secondContext)
    const secondList = await executeJson(tools, 'delegate_list_runs', {}, secondContext)

    assert.equal(firstRead.success, true)
    assert.equal('resume_token' in (firstRead.run as Record<string, unknown>), false)
    assert.equal('response_json' in (firstRead.run as Record<string, unknown>), false)
    assert.equal(secondRead.success, false)
    assert.equal(secondList.count, 0)
    assert.notEqual(getSessionRunsDirectory(firstContext), getSessionRunsDirectory(secondContext))
  })

  it('falls back to the next provider and classifies the failed attempt', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    process.env.FAKE_CLAUDE_MODE = 'auth-fail'
    const result = await executeJson(tools, 'delegate_run', {
      provider: 'auto',
      prompt: 'fallback request',
    }, harness.context('session-fallback'))
    const attempts = result.attempts as Array<Record<string, unknown>>

    assert.equal(result.success, true)
    assert.equal(result.provider, 'gemini')
    assert.deepEqual(attempts.map(attempt => attempt.category), ['auth_required', 'success'])
    assert.deepEqual(harness.invocations().map(invocation => invocation.provider), ['claude', 'agy'])
  })

  it('uses Antigravity defaults unless a model is selected for the run', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    harness.writeConfig({ delegation: { gemini: { model: 'stale-config-alias' } } })

    const defaultResult = await executeJson(tools, 'delegate_run', {
      provider: 'gemini',
      prompt: 'default model',
      allowFallback: false,
    }, harness.context('session-antigravity-default'))
    const selectedResult = await executeJson(tools, 'delegate_run', {
      provider: 'gemini',
      prompt: 'manual model',
      model: 'manual-model-alias',
      allowFallback: false,
    }, harness.context('session-antigravity-model'))
    const invocations = harness.invocations()

    assert.equal(defaultResult.success, true)
    assert.equal(selectedResult.success, true)
    assert.deepEqual(invocations[0], {
      provider: 'agy',
      args: ['--print', 'default model'],
      cwd: harness.worktree,
    })
    assert.deepEqual(invocations[1].args, [
      '--print',
      'manual model',
      '--model',
      'manual-model-alias',
    ])
  })

  it('passes prompts and model aliases as literal argv without shell injection', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    const marker = path.join(path.dirname(harness.worktree), 'injected')
    const prompt = `--literal; touch ${marker} $(touch ${marker})`
    const modelAlias = 'sonnet/custom;literal'
    const result = await executeJson(tools, 'delegate_run', {
      provider: 'claude',
      prompt,
      model: modelAlias,
      allowFallback: false,
    }, harness.context('session-argv'))
    const invocation = harness.invocations()[0]
    const separatorIndex = invocation.args.indexOf('--')
    const modelIndex = invocation.args.indexOf('--model')

    assert.equal(result.success, true)
    assert.equal(invocation.args[separatorIndex + 1], prompt)
    assert.equal(invocation.args[modelIndex + 1], modelAlias)
    assert.equal(fs.existsSync(marker), false)
  })

  it('caps in-memory and private-file output while preserving mode-0600 records', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    process.env.FAKE_AGY_MODE = 'large'
    process.env.FAKE_OUTPUT_BYTES = '200000'
    harness.writeConfig({ delegation: { max_output_bytes: 100_000 } })
    const context = harness.context('session-large')
    const result = await executeJson(tools, 'delegate_run', {
      provider: 'gemini',
      prompt: 'large output',
      allowFallback: false,
    }, context)
    const runId = String(result.run_id)
    const recordPath = path.join(getSessionRunsDirectory(context), `${runId}.json`)
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as {
      attempts: Array<{ stdout_file: string; stdout_bytes: number; stdout_truncated: boolean }>
    }
    const outputPath = path.join(getSessionDelegationDirectory(context), record.attempts[0].stdout_file)

    assert.equal(result.success, true)
    assert.ok(String(result.response).length < 70_000)
    assert.equal(record.attempts[0].stdout_bytes, 200_000)
    assert.equal(record.attempts[0].stdout_truncated, true)
    assert.equal(fs.statSync(outputPath).size, 100_000)
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600)
  })

  it('uses a stored Claude resume token for follow-up', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    const context = harness.context('session-followup')
    const first = await executeJson(tools, 'delegate_run', {
      provider: 'claude',
      prompt: 'initial request',
      allowFallback: false,
    }, context)
    const followup = await executeJson(tools, 'delegate_followup', {
      runId: first.run_id,
      prompt: 'focus the answer',
    }, context)
    const invocations = harness.invocations()

    assert.equal(followup.success, true)
    assert.equal(followup.followup_of, first.run_id)
    assert.equal(followup.used_native_resume, true)
    assert.deepEqual(
      invocations[1].args.slice(invocations[1].args.indexOf('--resume'), invocations[1].args.indexOf('--resume') + 2),
      ['--resume', 'fake-session-token'],
    )
    assert.equal(invocations[1].args.at(-1), 'focus the answer')
  })

  it('requires a separate permission before enabling an explicitly configured unsafe flag', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    harness.writeConfig({
      delegation: {
        claude: { permission_mode: 'dangerously-skip-permissions' },
      },
    })
    const requests: Array<Parameters<ToolContext['ask']>[0]> = []
    const context = harness.context('session-unsafe', async request => {
      requests.push(request)
      if (request.permission === 'delegation_unsafe') throw new Error('unsafe denied')
    })

    await assert.rejects(
      tools.delegate_run.execute({
        provider: 'claude',
        prompt: 'unsafe request',
        allowFallback: false,
      }, context),
      /unsafe denied/,
    )
    assert.deepEqual(requests.map(request => request.permission), ['delegation', 'delegation_unsafe'])
    assert.deepEqual(harness.invocations(), [])

    const allowedRequests: Array<Parameters<ToolContext['ask']>[0]> = []
    const result = await executeJson(tools, 'delegate_run', {
      provider: 'claude',
      prompt: 'explicitly approved unsafe request',
      allowFallback: false,
    }, harness.context('session-unsafe-approved', async request => { allowedRequests.push(request) }))
    assert.equal(result.success, true)
    assert.deepEqual(allowedRequests.map(request => request.permission), ['delegation', 'delegation_unsafe'])
    assert.ok(harness.invocations()[0].args.includes('--dangerously-skip-permissions'))
  })

  it('imports a legacy record only after explicit permission and never writes the legacy file', async test => {
    const harness = createHarness(test)
    const tools = await pluginTools()
    const runId = 'dlg-legacy-test'
    const legacyDirectory = path.join(harness.configDirectory, 'workflows', 'context', 'delegation', 'runs')
    const legacyPath = path.join(legacyDirectory, `${runId}.json`)
    fs.mkdirSync(legacyDirectory, { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify({
      id: runId,
      provider: 'claude',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'success',
      workflow_id: null,
      parent_run_id: null,
      used_native_resume: false,
      stateless_followup: false,
      output_format: 'text',
      prompt_hash: 'legacy',
      prompt_preview: 'legacy prompt',
      response_text: 'legacy response',
      response_json: null,
      warnings: [],
      attempt_count: 0,
      attempts: [],
      resume_token: null,
    }), { mode: 0o600 })
    const originalLegacyContent = fs.readFileSync(legacyPath, 'utf8')

    await assert.rejects(
      tools.delegate_get_run.execute(
        { runId },
        harness.context('session-legacy', async () => { throw new Error('legacy denied') }),
      ),
      /legacy denied/,
    )

    const requests: Array<Parameters<ToolContext['ask']>[0]> = []
    const context = harness.context('session-legacy', async request => { requests.push(request) })
    const imported = await executeJson(tools, 'delegate_get_run', { runId }, context)
    const run = imported.run as Record<string, unknown>

    assert.equal(imported.success, true)
    assert.equal(run.imported_from_legacy, true)
    assert.equal('session_id' in run, false)
    assert.equal(requests[0].permission, 'delegation_legacy')
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), originalLegacyContent)
    assert.equal(fs.statSync(path.join(getSessionRunsDirectory(context), `${runId}.json`)).mode & 0o777, 0o600)
  })
})
