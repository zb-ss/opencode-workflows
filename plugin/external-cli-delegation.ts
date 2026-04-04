/**
 * OpenCode External CLI Delegation Plugin
 *
 * Provides tool wrappers for delegating prompts to official provider CLIs:
 * - Claude Code CLI (`claude`)
 * - Gemini CLI (`gemini`)
 *
 * Design goals:
 * - Headless execution only (stdout/stderr capture)
 * - Non-blocking diagnostics (warn instead of hard-fail where possible)
 * - Safe process spawning (no shell interpolation)
 * - Run metadata persistence for follow-up chaining
 */

import type { Plugin } from '@opencode-ai/plugin'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Provider = 'claude' | 'gemini'
type OutputFormat = 'text' | 'json'

interface ExecResult {
  exit_code: number | null
  stdout: string
  stderr: string
  timed_out: boolean
  duration_ms: number
  spawn_error: string | null
}

interface ProviderAttempt {
  provider: Provider
  success: boolean
  category: string
  message: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
  response_text: string | null
  response_json: unknown | null
  raw_stdout: string
  raw_stderr: string
  warnings: string[]
  resume_token: string | null
}

interface DelegationRunRecord {
  id: string
  provider: Provider
  created_at: string
  updated_at: string
  status: 'success' | 'failed'
  workflow_id: string | null
  parent_run_id: string | null
  used_native_resume: boolean
  stateless_followup: boolean
  output_format: OutputFormat
  prompt_hash: string
  prompt_preview: string
  response_text: string
  response_json: unknown | null
  warnings: string[]
  attempt_count: number
  attempts: Array<{
    provider: Provider
    success: boolean
    category: string
    message: string
    exit_code: number | null
    duration_ms: number
    timed_out: boolean
  }>
  resume_token: string | null
}

const xdg = process.env.XDG_CONFIG_HOME
const CONFIG_DIR = xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode')

const DELEGATION_DIR = path.join(CONFIG_DIR, 'workflows', 'context', 'delegation')
const RUNS_DIR = path.join(DELEGATION_DIR, 'runs')

const MAX_STORE_TEXT = 120_000
const MAX_PREVIEW = 500
const MAX_FOLLOWUP_CONTEXT = 8_000

function ensureDirs(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true })
}

function nowIso(): string {
  return new Date().toISOString()
}

function truncate(input: string, max: number): string {
  if (!input) return ''
  if (input.length <= max) return input
  return `${input.slice(0, max)}\n...[truncated ${input.length - max} chars]`
}

function hashText(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 20)
}

function makeRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rnd = crypto.randomBytes(3).toString('hex')
  return `dlg-${ts}-${rnd}`
}

function commandExists(command: string): { available: boolean; path: string | null } {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const result = spawnSync(probe, [command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    })
    if (result.status === 0) {
      const first = (result.stdout || '').split('\n').map(v => v.trim()).find(Boolean) || null
      return { available: true, path: first }
    }
    return { available: false, path: null }
  } catch {
    return { available: false, path: null }
  }
}

async function execCommand(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  const started = Date.now()

  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError: string | null = null
    let finished = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (exitCode: number | null) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      resolve({
        exit_code: exitCode,
        stdout,
        stderr,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        spawn_error: spawnError,
      })
    }

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: Error) => {
      spawnError = error.message
      finish(null)
    })

    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // best-effort
      }
      // If process does not emit close after kill, finish anyway.
      setTimeout(() => finish(null), 250)
    }, timeoutMs)

    child.on('close', (exitCode: number | null) => {
      finish(exitCode)
    })
  })
}

function detectAuthState(text: string): 'authenticated' | 'unauthenticated' | 'unknown' {
  const normalized = text.toLowerCase()

  if (/(not\s+logged\s+in|login\s+required|sign\s+in|unauth|authentication\s+required|oauth)/i.test(normalized)) {
    return 'unauthenticated'
  }

  if (/(logged\s+in|authenticated|active\s+account|subscription|account\s*:\s*|auth\s*:\s*ok)/i.test(normalized)) {
    return 'authenticated'
  }

  return 'unknown'
}

function parseJsonLoose(input: string): unknown | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }

  const firstObject = trimmed.indexOf('{')
  const lastObject = trimmed.lastIndexOf('}')
  if (firstObject !== -1 && lastObject > firstObject) {
    try {
      return JSON.parse(trimmed.slice(firstObject, lastObject + 1))
    } catch {
      // continue
    }
  }

  const firstArray = trimmed.indexOf('[')
  const lastArray = trimmed.lastIndexOf(']')
  if (firstArray !== -1 && lastArray > firstArray) {
    try {
      return JSON.parse(trimmed.slice(firstArray, lastArray + 1))
    } catch {
      // ignore
    }
  }

  return null
}

function extractResponseText(responseJson: unknown, fallback: string): string {
  if (typeof responseJson === 'string') return responseJson
  if (responseJson && typeof responseJson === 'object') {
    const obj = responseJson as Record<string, unknown>
    const candidates = [
      obj.response,
      obj.output,
      obj.text,
      obj.message,
      (obj.result && typeof obj.result === 'object' ? (obj.result as Record<string, unknown>).text : null),
    ]

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value
      }
    }
  }

  return fallback
}

function extractResumeToken(responseJson: unknown): string | null {
  if (!responseJson || typeof responseJson !== 'object') return null
  const obj = responseJson as Record<string, unknown>
  const keys = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'run_id', 'runId']
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function getProviderArgs(
  provider: Provider,
  prompt: string,
  outputFormat: OutputFormat,
  resumeToken: string | null,
): string[] {
  const args: string[] = []

  if (resumeToken) {
    args.push('--resume', resumeToken)
  }

  args.push('-p', prompt)

  if (outputFormat === 'json') {
    args.push('--output-format', 'json')
  }

  return args
}

function saveRun(record: DelegationRunRecord): void {
  ensureDirs()
  const runPath = path.join(RUNS_DIR, `${record.id}.json`)
  fs.writeFileSync(runPath, JSON.stringify(record, null, 2) + '\n', 'utf8')
}

function loadRun(runId: string): DelegationRunRecord | null {
  if (!runId || /[^a-zA-Z0-9-_]/.test(runId)) return null
  const runPath = path.join(RUNS_DIR, `${runId}.json`)
  if (!fs.existsSync(runPath)) return null

  try {
    const raw = fs.readFileSync(runPath, 'utf8')
    return JSON.parse(raw) as DelegationRunRecord
  } catch {
    return null
  }
}

function listRuns(limit: number): DelegationRunRecord[] {
  ensureDirs()
  const safeLimit = Math.max(1, Math.min(limit, 100))
  const files = fs.readdirSync(RUNS_DIR)
    .filter(name => name.endsWith('.json'))

  const records: DelegationRunRecord[] = []
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(RUNS_DIR, file), 'utf8')
      records.push(JSON.parse(content) as DelegationRunRecord)
    } catch {
      // skip unreadable records
    }
  }

  records.sort((a, b) => {
    const ta = new Date(a.created_at).getTime()
    const tb = new Date(b.created_at).getTime()
    return tb - ta
  })

  return records.slice(0, safeLimit)
}

async function preflightProvider(
  provider: Provider,
  opts?: { checkAuth?: boolean; versionTimeoutMs?: number; authTimeoutMs?: number },
): Promise<Record<string, unknown>> {
  const binary = commandExists(provider)
  const warnings: string[] = []
  const checkAuth = opts?.checkAuth !== false
  const versionTimeoutMs = Math.max(1000, Math.min(opts?.versionTimeoutMs || 3000, 15000))
  const authTimeoutMs = Math.max(1000, Math.min(opts?.authTimeoutMs || 2500, 15000))

  if (!binary.available) {
    return {
      provider,
      installed: false,
      binary_path: null,
      version: null,
      auth_state: 'unknown',
      warnings: [`${provider} CLI not found in PATH`],
      ready: false,
    }
  }

  let version: string | null = null
  const versionResult = await execCommand(provider, ['--version'], versionTimeoutMs)
  if (versionResult.timed_out) {
    warnings.push(`${provider} --version timed out after ${versionTimeoutMs}ms.`)
  }
  const versionLine = (versionResult.stdout || versionResult.stderr).split('\n').map(v => v.trim()).find(Boolean)
  if (versionLine) {
    version = versionLine
  }

  const authProbeCommands: Record<Provider, string[][]> = {
    claude: [
      ['auth', 'status'],
      ['status'],
    ],
    gemini: [
      ['auth', 'status'],
      ['whoami'],
    ],
  }

  let authState: 'authenticated' | 'unauthenticated' | 'unknown' = 'unknown'

  if (checkAuth) {
    for (const probeArgs of authProbeCommands[provider]) {
      const probe = await execCommand(provider, probeArgs, authTimeoutMs)
      if (probe.timed_out) {
        warnings.push(`${provider} ${probeArgs.join(' ')} timed out after ${authTimeoutMs}ms.`)
        continue
      }

      const probeOutput = `${probe.stdout}\n${probe.stderr}`.trim()
      if (!probeOutput) continue
      authState = detectAuthState(probeOutput)
      if (authState !== 'unknown') break
    }
  } else {
    warnings.push(`Skipped ${provider} auth probe (checkAuth=false).`)
  }

  if (authState === 'unknown') {
    warnings.push(`Could not confidently determine ${provider} auth state. Run '${provider}' once interactively if needed.`)
  }

  if (authState === 'unauthenticated') {
    warnings.push(`${provider} appears unauthenticated. Run '${provider}' interactively to complete login.`)
  }

  return {
    provider,
    installed: true,
    binary_path: binary.path,
    version,
    auth_state: authState,
    warnings,
    ready: authState !== 'unauthenticated',
  }
}

async function runAttempt(
  provider: Provider,
  prompt: string,
  outputFormat: OutputFormat,
  timeoutMs: number,
  resumeToken: string | null,
): Promise<ProviderAttempt> {
  const binary = commandExists(provider)
  if (!binary.available) {
    return {
      provider,
      success: false,
      category: 'missing_binary',
      message: `${provider} CLI not found in PATH`,
      exit_code: null,
      duration_ms: 0,
      timed_out: false,
      response_text: null,
      response_json: null,
      raw_stdout: '',
      raw_stderr: '',
      warnings: [],
      resume_token: null,
    }
  }

  const args = getProviderArgs(provider, prompt, outputFormat, resumeToken)
  const result = await execCommand(provider, args, timeoutMs)

  const combined = `${result.stdout}\n${result.stderr}`.trim()
  const warnings: string[] = []

  if (result.timed_out) {
    return {
      provider,
      success: false,
      category: 'timeout',
      message: `${provider} timed out after ${timeoutMs}ms`,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: true,
      response_text: null,
      response_json: null,
      raw_stdout: truncate(result.stdout, 4000),
      raw_stderr: truncate(result.stderr, 4000),
      warnings,
      resume_token: null,
    }
  }

  if (result.spawn_error) {
    return {
      provider,
      success: false,
      category: 'execution_failed',
      message: `${provider} execution error: ${result.spawn_error}`,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: false,
      response_text: null,
      response_json: null,
      raw_stdout: truncate(result.stdout, 4000),
      raw_stderr: truncate(result.stderr, 4000),
      warnings,
      resume_token: null,
    }
  }

  if (result.exit_code !== 0) {
    let category = 'execution_failed'
    if (/(not\s+logged\s+in|login\s+required|sign\s+in|unauth|authentication\s+required|401|403)/i.test(combined)) {
      category = 'auth_required'
    } else if (/(unknown option|unrecognized option|invalid option)/i.test(combined)) {
      category = 'unsupported_flag'
    }

    return {
      provider,
      success: false,
      category,
      message: `${provider} failed (${category})`,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: false,
      response_text: null,
      response_json: null,
      raw_stdout: truncate(result.stdout, 4000),
      raw_stderr: truncate(result.stderr, 4000),
      warnings,
      resume_token: null,
    }
  }

  const rawText = (result.stdout || result.stderr || '').trim()
  if (!rawText) {
    return {
      provider,
      success: false,
      category: 'empty_output',
      message: `${provider} returned empty output`,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: false,
      response_text: null,
      response_json: null,
      raw_stdout: truncate(result.stdout, 4000),
      raw_stderr: truncate(result.stderr, 4000),
      warnings,
      resume_token: null,
    }
  }

  let parsed: unknown | null = null
  if (outputFormat === 'json') {
    parsed = parseJsonLoose(rawText)
    if (!parsed) {
      warnings.push(`${provider} returned non-JSON output while JSON was requested; falling back to text parsing.`)
    }
  }

  const responseText = extractResponseText(parsed, rawText)

  return {
    provider,
    success: true,
    category: 'success',
    message: `${provider} succeeded`,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    timed_out: false,
    response_text: responseText,
    response_json: parsed,
    raw_stdout: truncate(result.stdout, 20_000),
    raw_stderr: truncate(result.stderr, 4_000),
    warnings,
    resume_token: extractResumeToken(parsed),
  }
}

function buildStatelessFollowupPrompt(previous: DelegationRunRecord, followup: string): string {
  return [
    'You are continuing a previous delegated conversation in stateless mode.',
    '',
    'Previous prompt (preview):',
    previous.prompt_preview,
    '',
    'Previous response (excerpt):',
    truncate(previous.response_text, MAX_FOLLOWUP_CONTEXT),
    '',
    'Follow-up request:',
    followup,
  ].join('\n')
}

function toAttemptsSummary(attempts: ProviderAttempt[]): DelegationRunRecord['attempts'] {
  return attempts.map((attempt) => ({
    provider: attempt.provider,
    success: attempt.success,
    category: attempt.category,
    message: attempt.message,
    exit_code: attempt.exit_code,
    duration_ms: attempt.duration_ms,
    timed_out: attempt.timed_out,
  }))
}

function splitArgs(input: string): string[] {
  const tokens: string[] = []
  if (!input || !input.trim()) return tokens

  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4])
  }
  return tokens
}

async function executeDelegateCommand(rawInput: string): Promise<Record<string, unknown>> {
  const input = (rawInput || '').trim()
  const cleaned = input.startsWith('/delegate ') ? input.slice('/delegate '.length).trim() : input
  const tokens = splitArgs(cleaned)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !/^\$\d+$/.test(token) && token !== '$ARGUMENTS')

  if (tokens.length === 0) {
    return {
      success: false,
      error: 'Missing subcommand',
      usage: [
        '/delegate status [provider] [--auth]',
        '/delegate ask <provider|auto> <prompt>',
        '/delegate followup <run-id> <prompt>',
        '/delegate runs [limit]',
        '/delegate show <run-id>',
      ],
    }
  }

  const subcommand = tokens[0].toLowerCase()

  if (subcommand === 'status') {
    const hasAuthFlag = tokens.includes('--auth')
    const providerToken = tokens.find(t => t === 'claude' || t === 'gemini') as Provider | undefined
    const providers = providerToken ? [providerToken] : ['claude', 'gemini']

    const checks = await Promise.all(
      providers.map(provider => preflightProvider(provider, {
        checkAuth: hasAuthFlag,
        versionTimeoutMs: 3000,
        authTimeoutMs: 2500,
      })),
    )

    const warnings = checks.flatMap((check) => {
      const list = (check as Record<string, unknown>).warnings
      return Array.isArray(list) ? (list as string[]) : []
    })

    return {
      success: true,
      command: 'status',
      checkAuth: hasAuthFlag,
      providers: checks,
      warnings,
    }
  }

  if (subcommand === 'ask') {
    const maybeProvider = tokens[1]
    const provider: Provider | 'auto' = maybeProvider === 'claude' || maybeProvider === 'gemini' || maybeProvider === 'auto'
      ? maybeProvider
      : 'auto'

    const promptStart = provider === 'auto' && maybeProvider !== 'auto' && maybeProvider !== 'claude' && maybeProvider !== 'gemini'
      ? 1
      : 2
    const prompt = tokens.slice(promptStart).join(' ').trim()

    const result = await executeDelegation({ provider, prompt })
    return {
      command: 'ask',
      ...result.payload,
    }
  }

  if (subcommand === 'followup') {
    const runId = tokens[1]
    const prompt = tokens.slice(2).join(' ').trim()
    if (!runId || !prompt) {
      return {
        success: false,
        error: 'followup requires <run-id> and <prompt>',
        usage: '/delegate followup <run-id> <prompt>',
      }
    }

    const previous = loadRun(runId)
    if (!previous) {
      return { success: false, error: `Run not found: ${runId}` }
    }

    const useNative = Boolean(previous.resume_token)
    const composedPrompt = useNative
      ? prompt
      : buildStatelessFollowupPrompt(previous, prompt)

    const result = await executeDelegation({
      provider: previous.provider,
      prompt: composedPrompt,
      outputFormat: previous.output_format,
      timeoutMs: 120000,
      allowFallback: false,
      resumeToken: useNative ? previous.resume_token : null,
      parentRunId: previous.id,
      workflowId: previous.workflow_id || undefined,
    })

    return {
      command: 'followup',
      followup_of: previous.id,
      used_native_resume: useNative,
      ...result.payload,
    }
  }

  if (subcommand === 'runs') {
    const limitToken = tokens[1]
    const parsed = Number.parseInt(limitToken || '20', 10)
    const limit = Number.isFinite(parsed) ? parsed : 20
    const runs = listRuns(limit)
    return {
      success: true,
      command: 'runs',
      count: runs.length,
      runs: runs.map(run => ({
        id: run.id,
        provider: run.provider,
        created_at: run.created_at,
        status: run.status,
        workflow_id: run.workflow_id,
        prompt_preview: run.prompt_preview,
      })),
    }
  }

  if (subcommand === 'show') {
    const runId = tokens[1]
    if (!runId) {
      return { success: false, error: 'show requires <run-id>', usage: '/delegate show <run-id>' }
    }
    const run = loadRun(runId)
    if (!run) return { success: false, error: `Run not found: ${runId}` }
    return { success: true, command: 'show', run }
  }

  return {
    success: false,
    error: `Unknown subcommand: ${subcommand}`,
    usage: [
      '/delegate status [provider] [--auth]',
      '/delegate ask <provider|auto> <prompt>',
      '/delegate followup <run-id> <prompt>',
      '/delegate runs [limit]',
      '/delegate show <run-id>',
    ],
  }
}

interface ExecuteDelegationArgs {
  provider: Provider | 'auto' | string | null | undefined
  prompt: string | null | undefined
  outputFormat?: OutputFormat
  timeoutMs?: number
  workflowId?: string
  allowFallback?: boolean
  fallbackOrder?: Array<Provider | string>
  resumeToken?: string | null
  parentRunId?: string | null
}

async function executeDelegation(args: ExecuteDelegationArgs): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const inputWarnings: string[] = []

  const rawProvider = args.provider
  const normalizedProvider: Provider | 'auto' =
    rawProvider === 'claude' || rawProvider === 'gemini' || rawProvider === 'auto'
      ? rawProvider
      : 'auto'

  if (normalizedProvider !== rawProvider) {
    inputWarnings.push(`Invalid or missing provider '${String(rawProvider)}'; defaulted to 'auto'.`)
  }

  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return {
      ok: false,
      payload: {
        success: false,
        provider: normalizedProvider,
        run_id: null,
        error: 'Missing or empty prompt',
        attempts: [],
        warnings: inputWarnings,
      },
    }
  }

  const outputFormat: OutputFormat = args.outputFormat === 'json' ? 'json' : 'text'
  const timeoutMs = Math.max(5000, Math.min(args.timeoutMs || 120000, 600000))
  const allowFallback = args.allowFallback !== false

  const fallbackOrder = Array.isArray(args.fallbackOrder)
    ? args.fallbackOrder.filter((p): p is Provider => p === 'claude' || p === 'gemini')
    : []

  if (Array.isArray(args.fallbackOrder) && fallbackOrder.length !== args.fallbackOrder.length) {
    inputWarnings.push('Some invalid fallback providers were ignored.')
  }

  const providers: Provider[] = normalizedProvider === 'auto'
    ? (fallbackOrder.length > 0 ? fallbackOrder : ['claude', 'gemini'])
    : [normalizedProvider]

  const attempts: ProviderAttempt[] = []
  let winner: ProviderAttempt | null = null

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]
    const attempt = await runAttempt(
      provider,
      prompt,
      outputFormat,
      timeoutMs,
      args.resumeToken || null,
    )
    attempts.push(attempt)

    if (attempt.success) {
      winner = attempt
      break
    }

    const isLast = i === providers.length - 1
    if (!allowFallback || isLast) break
  }

  if (!winner) {
    return {
      ok: false,
      payload: {
        success: false,
        provider: null,
        run_id: null,
        error: 'All provider attempts failed',
        attempts: attempts.map(a => ({
          provider: a.provider,
          category: a.category,
          message: a.message,
          exit_code: a.exit_code,
          duration_ms: a.duration_ms,
        })),
        warnings: [...inputWarnings, ...attempts.flatMap(a => a.warnings)],
      },
    }
  }

  const runId = makeRunId()
  const now = nowIso()
  const warnings = [...inputWarnings, ...attempts.flatMap(a => a.warnings)]
  const hasStatelessParent = Boolean(args.parentRunId && !args.resumeToken)

  const record: DelegationRunRecord = {
    id: runId,
    provider: winner.provider,
    created_at: now,
    updated_at: now,
    status: 'success',
    workflow_id: args.workflowId || null,
    parent_run_id: args.parentRunId || null,
    used_native_resume: Boolean(args.resumeToken),
    stateless_followup: hasStatelessParent,
    output_format: outputFormat,
    prompt_hash: hashText(prompt),
    prompt_preview: truncate(prompt, MAX_PREVIEW),
    response_text: truncate(winner.response_text || '', MAX_STORE_TEXT),
    response_json: winner.response_json,
    warnings,
    attempt_count: attempts.length,
    attempts: toAttemptsSummary(attempts),
    resume_token: winner.resume_token,
  }

  saveRun(record)

  return {
    ok: true,
    payload: {
      success: true,
      provider: winner.provider,
      run_id: runId,
      response: winner.response_text,
      response_json: winner.response_json,
      warnings: [
        ...warnings,
        ...(hasStatelessParent ? ['Stateless follow-up mode was used for this run.'] : []),
      ],
      attempts: attempts.map(a => ({
        provider: a.provider,
        success: a.success,
        category: a.category,
        message: a.message,
        duration_ms: a.duration_ms,
      })),
    },
  }
}

export const ExternalCliDelegation: Plugin = async () => {
  return {
    tool: {
      delegate_command: {
        description: 'Execute /delegate subcommands deterministically from raw arguments string.',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Raw arguments after /delegate' },
            subcommand: {
              type: 'string',
              enum: ['status', 'ask', 'followup', 'runs', 'show'],
              description: 'Structured subcommand (use when input is omitted)',
            },
            provider: {
              type: 'string',
              enum: ['claude', 'gemini', 'auto'],
              description: 'Provider for ask/status structured mode',
            },
            prompt: { type: 'string', description: 'Prompt for ask/followup structured mode' },
            runId: { type: 'string', description: 'Run ID for followup/show structured mode' },
            limit: { type: 'number', description: 'Limit for runs structured mode' },
            checkAuth: { type: 'boolean', description: 'Auth probe flag for status structured mode' },
          },
        },
        async execute(args: {
          input?: string
          subcommand?: 'status' | 'ask' | 'followup' | 'runs' | 'show'
          provider?: 'claude' | 'gemini' | 'auto'
          prompt?: string
          runId?: string
          limit?: number
          checkAuth?: boolean
        }) {
          let input = (args.input || '').trim()

          if (!input && args.subcommand) {
            if (args.subcommand === 'status') {
              input = `status${args.provider && args.provider !== 'auto' ? ` ${args.provider}` : ''}${args.checkAuth ? ' --auth' : ''}`
            } else if (args.subcommand === 'ask') {
              const provider = args.provider || 'auto'
              input = `ask ${provider} ${args.prompt || ''}`.trim()
            } else if (args.subcommand === 'followup') {
              input = `followup ${args.runId || ''} ${args.prompt || ''}`.trim()
            } else if (args.subcommand === 'runs') {
              input = `runs ${args.limit || ''}`.trim()
            } else if (args.subcommand === 'show') {
              input = `show ${args.runId || ''}`.trim()
            }
          }

          const result = await executeDelegateCommand(input)
          return JSON.stringify(result, null, 2)
        },
      },

      delegate_preflight: {
        description: 'Check external CLI delegation readiness for Claude and Gemini CLIs.',
        parameters: {
          type: 'object',
          properties: {
            providers: {
              type: 'array',
              items: { type: 'string', enum: ['claude', 'gemini'] },
              description: 'Optional subset of providers to check',
            },
            checkAuth: {
              type: 'boolean',
              description: 'Whether to probe provider auth state (can be slower on some CLI setups)',
            },
          },
        },
        async execute(args: { providers?: Array<Provider | string>; checkAuth?: boolean }) {
          const requestedProviders = Array.isArray(args?.providers) ? args.providers : []
          const providers = requestedProviders
            .filter((provider): provider is Provider => provider === 'claude' || provider === 'gemini')

          const finalProviders = providers.length > 0 ? providers : ['claude', 'gemini']
          const warningsFromInput: string[] = []

          if (requestedProviders.length > 0 && providers.length !== requestedProviders.length) {
            warningsFromInput.push('Some invalid providers were ignored. Valid values: claude, gemini.')
          }

          const checks = await Promise.all(
            finalProviders.map(provider => preflightProvider(provider, {
              checkAuth: args?.checkAuth !== false,
              versionTimeoutMs: 3000,
              authTimeoutMs: 2500,
            })),
          )

          const warnings = checks.flatMap((check) => {
            const list = (check as Record<string, unknown>).warnings
            return Array.isArray(list) ? (list as string[]) : []
          })

          return JSON.stringify({
            success: true,
            checked_at: nowIso(),
            providers: checks,
            warnings: [...warningsFromInput, ...warnings],
          }, null, 2)
        },
      },

      delegate_run: {
        description: 'Run a prompt through Claude CLI, Gemini CLI, or auto-fallback and persist metadata.',
        parameters: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['claude', 'gemini', 'auto'], description: 'Target provider or auto fallback' },
            prompt: { type: 'string', description: 'Prompt to send to provider CLI' },
            outputFormat: { type: 'string', enum: ['text', 'json'], description: 'Requested output format' },
            timeoutMs: { type: 'number', description: 'Process timeout in milliseconds' },
            workflowId: { type: 'string', description: 'Optional workflow ID for traceability' },
            allowFallback: { type: 'boolean', description: 'Allow fallback to next provider on failure' },
            fallbackOrder: {
              type: 'array',
              items: { type: 'string', enum: ['claude', 'gemini'] },
              description: 'Provider order when provider=auto',
            },
            resumeToken: { type: 'string', description: 'Optional provider-native session token for resume' },
            parentRunId: { type: 'string', description: 'Optional run ID that this invocation follows' },
          },
          required: ['provider', 'prompt'],
        },
        async execute(args: {
          provider: Provider | 'auto'
          prompt: string
          outputFormat?: OutputFormat
          timeoutMs?: number
          workflowId?: string
          allowFallback?: boolean
          fallbackOrder?: Provider[]
          resumeToken?: string
          parentRunId?: string
        }) {
          const result = await executeDelegation({
            provider: args.provider,
            prompt: args.prompt,
            outputFormat: args.outputFormat,
            timeoutMs: args.timeoutMs,
            workflowId: args.workflowId,
            allowFallback: args.allowFallback,
            fallbackOrder: args.fallbackOrder,
            resumeToken: args.resumeToken || null,
            parentRunId: args.parentRunId || null,
          })

          return JSON.stringify(result.payload, null, 2)
        },
      },

      delegate_followup: {
        description: 'Send a follow-up prompt based on a previous delegation run.',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Previous run ID to continue from' },
            prompt: { type: 'string', description: 'Follow-up prompt' },
            outputFormat: { type: 'string', enum: ['text', 'json'], description: 'Requested output format' },
            timeoutMs: { type: 'number', description: 'Process timeout in milliseconds' },
            preferNativeResume: { type: 'boolean', description: 'Try provider-native resume first if token exists' },
          },
          required: ['runId', 'prompt'],
        },
        async execute(args: {
          runId: string
          prompt: string
          outputFormat?: OutputFormat
          timeoutMs?: number
          preferNativeResume?: boolean
        }) {
          const previous = loadRun(args.runId)
          if (!previous) {
            return JSON.stringify({ success: false, error: `Run not found: ${args.runId}` }, null, 2)
          }

          const preferNative = args.preferNativeResume !== false
          let useNative = false
          let composedPrompt = args.prompt
          let resumeToken: string | null = null
          const warnings: string[] = []

          if (preferNative && previous.resume_token) {
            useNative = true
            resumeToken = previous.resume_token
          } else {
            composedPrompt = buildStatelessFollowupPrompt(previous, args.prompt)
            warnings.push('Stateless follow-up fallback used (no provider resume token available).')
          }

          const result = await executeDelegation({
            provider: previous.provider,
            prompt: composedPrompt,
            outputFormat: args.outputFormat || previous.output_format,
            timeoutMs: args.timeoutMs || 120000,
            workflowId: previous.workflow_id || undefined,
            allowFallback: false,
            resumeToken,
            parentRunId: previous.id,
          })

          if (!result.ok) {
            return JSON.stringify({
              success: false,
              error: 'Follow-up delegation failed',
              used_native_resume: useNative,
              warnings,
              provider: previous.provider,
              details: result.payload,
            }, null, 2)
          }

          const parsed = result.payload

          const mergedWarnings = [
            ...warnings,
            ...((Array.isArray(parsed.warnings) ? parsed.warnings : []) as string[]),
          ]

          return JSON.stringify({
            ...parsed,
            followup_of: previous.id,
            used_native_resume: useNative,
            warnings: mergedWarnings,
          }, null, 2)
        },
      },

      delegate_get_run: {
        description: 'Get a stored delegation run record by ID.',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Delegation run ID' },
          },
          required: ['runId'],
        },
        async execute(args: { runId: string }) {
          const run = loadRun(args.runId)
          if (!run) {
            return JSON.stringify({ success: false, error: `Run not found: ${args.runId}` }, null, 2)
          }

          return JSON.stringify({
            success: true,
            run,
          }, null, 2)
        },
      },

      delegate_list_runs: {
        description: 'List recent delegation runs.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum records to return (1-100)' },
          },
        },
        async execute(args: { limit?: number }) {
          const limit = args?.limit || 20
          const runs = listRuns(limit)

          return JSON.stringify({
            success: true,
            count: runs.length,
            runs: runs.map(run => ({
              id: run.id,
              provider: run.provider,
              created_at: run.created_at,
              status: run.status,
              workflow_id: run.workflow_id,
              parent_run_id: run.parent_run_id,
              prompt_preview: run.prompt_preview,
              warnings: run.warnings,
            })),
          }, null, 2)
        },
      },
    },
  }
}

export default ExternalCliDelegation
