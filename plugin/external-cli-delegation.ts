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

interface DelegationConfig {
  claude?: { model?: string; timeout_ms?: number }
  gemini?: { model?: string; timeout_ms?: number }
  default_provider?: Provider | 'auto'
  fallback_order?: Provider[]
}

const xdg = process.env.XDG_CONFIG_HOME
const CONFIG_DIR = xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode')

const WORKFLOWS_JSON = path.join(CONFIG_DIR, 'workflows.json')
const DELEGATION_DIR = path.join(CONFIG_DIR, 'workflows', 'context', 'delegation')
const RUNS_DIR = path.join(DELEGATION_DIR, 'runs')

const MAX_STORE_TEXT = 120_000
const MAX_PREVIEW = 500
const MAX_FOLLOWUP_CONTEXT = 8_000

function loadDelegationConfig(): DelegationConfig {
  try {
    if (fs.existsSync(WORKFLOWS_JSON)) {
      const raw = JSON.parse(fs.readFileSync(WORKFLOWS_JSON, 'utf8'))
      const section = raw?.delegation
      if (!section || typeof section !== 'object') return {}

      // Resolve _example_ prefixed keys: only active (non-prefixed) keys take effect
      const resolveProviderConfig = (provider: string): { model?: string; timeout_ms?: number } | undefined => {
        const cfg = section[provider]
        if (!cfg || typeof cfg !== 'object') return undefined
        const result: { model?: string; timeout_ms?: number } = {}
        // Active key takes precedence over _example_ key
        if (typeof cfg.model === 'string') result.model = cfg.model
        else if (typeof cfg._example_model === 'string') { /* skip inactive */ }
        if (typeof cfg.timeout_ms === 'number') result.timeout_ms = cfg.timeout_ms
        else if (typeof cfg._example_timeout_ms === 'number') { /* skip inactive */ }
        return Object.keys(result).length > 0 ? result : undefined
      }

      return {
        claude: resolveProviderConfig('claude'),
        gemini: resolveProviderConfig('gemini'),
        default_provider: section.default_provider,
        fallback_order: Array.isArray(section.fallback_order) ? section.fallback_order : undefined,
      }
    }
  } catch {
    // fall through to defaults
  }
  return {}
}

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

function detectAuthState(text: string, provider: Provider): 'authenticated' | 'unauthenticated' | 'unknown' {
  // Claude `auth status` returns JSON: {"loggedIn": true/false, ...}
  if (provider === 'claude') {
    try {
      const json = JSON.parse(text.trim())
      if (typeof json.loggedIn === 'boolean') {
        return json.loggedIn ? 'authenticated' : 'unauthenticated'
      }
    } catch {
      // not JSON, fall through to regex
    }
  }

  const normalized = text.toLowerCase()

  if (/(not\s+logged\s+in|loggedin["']?\s*:\s*false|login\s+required|sign\s+in|unauth|authentication\s+required)/i.test(normalized)) {
    return 'unauthenticated'
  }

  if (/(logged\s*in|loggedin["']?\s*:\s*true|authenticated|active\s+account|subscription|account\s*:\s*|auth\s*:\s*ok)/i.test(normalized)) {
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
    // Claude JSON: { result: "response text", ... }
    // Gemini JSON: may use response, output, text, or message
    const candidates = [
      obj.result,
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
  model: string | null,
): string[] {
  if (provider === 'claude') {
    return getClaudeArgs(prompt, outputFormat, resumeToken, model)
  }
  return getGeminiArgs(prompt, outputFormat, model)
}

/**
 * Claude CLI: `--print` is a boolean flag (non-interactive mode),
 * prompt is a positional argument, `--resume SESSION_ID` for continuation.
 * Always request JSON output to get session_id for resume capability.
 */
function getClaudeArgs(
  prompt: string,
  outputFormat: OutputFormat,
  resumeToken: string | null,
  model: string | null,
): string[] {
  const args: string[] = ['--print']

  if (resumeToken) {
    args.push('--resume', resumeToken)
  }

  if (model) {
    args.push('--model', model)
  }

  // Always use JSON internally for structured parsing + session_id extraction.
  // We extract the human-readable text from the JSON response.
  args.push('--output-format', 'json')

  // -- separates flags from positional prompt (prevents prompts starting with - from being misinterpreted)
  args.push('--', prompt)

  return args
}

/**
 * Gemini CLI: `--prompt TEXT` takes the prompt as a string value (non-interactive mode).
 * Resume uses `--resume latest|INDEX`, NOT session IDs — native resume is unsupported.
 */
function getGeminiArgs(
  prompt: string,
  outputFormat: OutputFormat,
  model: string | null,
): string[] {
  const args: string[] = []

  if (model) {
    args.push('--model', model)
  }

  if (outputFormat === 'json') {
    args.push('--output-format', 'json')
  }

  // Gemini uses --prompt as a string option (not a boolean flag like Claude)
  args.push('--prompt', prompt)

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

  // Claude: `auth status` returns JSON {"loggedIn": true/false, ...}
  // Gemini: no dedicated auth subcommand; probe with a minimal headless prompt
  const authProbeCommands: Record<Provider, string[][]> = {
    claude: [
      ['auth', 'status'],
    ],
    gemini: [
      // Gemini has no auth subcommand. Run a trivial headless prompt to detect auth errors.
      ['--prompt', 'ping', '--output-format', 'text'],
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
      authState = detectAuthState(probeOutput, provider)

      // For Gemini's trivial-prompt probe: exit 0 with output means authenticated
      if (provider === 'gemini' && authState === 'unknown') {
        authState = probe.exit_code === 0 && probeOutput.length > 0 ? 'authenticated' : 'unknown'
      }

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
  model: string | null,
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

  // Gemini does not support session-ID-based resume
  const effectiveResumeToken = provider === 'gemini' ? null : resumeToken
  const warnings: string[] = []

  if (provider === 'gemini' && resumeToken) {
    warnings.push('Gemini CLI does not support session-based resume; falling back to stateless mode.')
  }

  const args = getProviderArgs(provider, prompt, outputFormat, effectiveResumeToken, model)
  const result = await execCommand(provider, args, timeoutMs)

  const combined = `${result.stdout}\n${result.stderr}`.trim()

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
      message: `${provider} failed (${category}): exit ${result.exit_code}`,
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

  // Claude always returns JSON (we request --output-format json).
  // Gemini returns JSON only when explicitly requested.
  const shouldParseJson = provider === 'claude' || outputFormat === 'json'
  let parsed: unknown | null = null
  if (shouldParseJson) {
    parsed = parseJsonLoose(rawText)
    if (!parsed && provider === 'claude') {
      warnings.push('Claude returned non-JSON output unexpectedly; using raw text.')
    } else if (!parsed && outputFormat === 'json') {
      warnings.push(`${provider} returned non-JSON output while JSON was requested; falling back to text.`)
    }
  }

  const responseText = extractResponseText(parsed, rawText)

  // Claude: is_error flag in JSON means the request failed even with exit 0
  if (provider === 'claude' && parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (obj.is_error === true) {
      return {
        provider,
        success: false,
        category: 'provider_error',
        message: `Claude reported error: ${typeof obj.result === 'string' ? obj.result.slice(0, 200) : 'unknown'}`,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: false,
        response_text: responseText,
        response_json: parsed,
        raw_stdout: truncate(result.stdout, 4000),
        raw_stderr: truncate(result.stderr, 4000),
        warnings,
        resume_token: null,
      }
    }
  }

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
    // Extract --model flag if present
    let model: string | null = null
    const modelIdx = tokens.indexOf('--model')
    const filteredTokens = [...tokens]
    if (modelIdx !== -1 && modelIdx + 1 < filteredTokens.length) {
      model = filteredTokens[modelIdx + 1]
      filteredTokens.splice(modelIdx, 2)
    }

    const maybeProvider = filteredTokens[1]
    const provider: Provider | 'auto' = maybeProvider === 'claude' || maybeProvider === 'gemini' || maybeProvider === 'auto'
      ? maybeProvider
      : 'auto'

    const promptStart = provider === 'auto' && maybeProvider !== 'auto' && maybeProvider !== 'claude' && maybeProvider !== 'gemini'
      ? 1
      : 2
    const prompt = filteredTokens.slice(promptStart).join(' ').trim()

    const result = await executeDelegation({ provider, prompt, model })
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
  model?: string | null
}

async function executeDelegation(args: ExecuteDelegationArgs): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const config = loadDelegationConfig()
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
  const defaultTimeout = Math.max(5000, Math.min(args.timeoutMs || 120000, 600000))
  const allowFallback = args.allowFallback !== false

  const fallbackOrder = Array.isArray(args.fallbackOrder)
    ? args.fallbackOrder.filter((p): p is Provider => p === 'claude' || p === 'gemini')
    : (config.fallback_order ?? [])

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
    // Resolve model: explicit arg > config per-provider > null (use CLI default)
    const providerConfig = config[provider]
    const model = (args.model ? args.model : providerConfig?.model) || null
    const timeoutMs = providerConfig?.timeout_ms
      ? Math.max(5000, Math.min(providerConfig.timeout_ms, 600000))
      : defaultTimeout
    const attempt = await runAttempt(
      provider,
      prompt,
      outputFormat,
      timeoutMs,
      args.resumeToken || null,
      model,
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
  // Get zod schema builder. Bun's require() resolves from the OpenCode config
  // node_modules even for symlinked plugins (unlike ESM static import).
  const { tool: pluginTool } = require('@opencode-ai/plugin')
  const z = pluginTool.schema

  return {
    tool: {
      delegate_command: {
        description: 'Execute a /delegate subcommand. Pass the full command string in "input" (e.g. "status claude --auth", "ask auto Summarize this repo").',
        args: {
          input: z.string().default('').describe('Raw arguments string, e.g. "status claude --auth" or "ask claude Explain the auth flow"'),
        },
        async execute(args: { input?: string }) {
          try {
            const input = (args?.input || '').trim()
            const result = await executeDelegateCommand(input)
            return JSON.stringify(result, null, 2)
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return JSON.stringify({ success: false, error: `delegate_command crashed: ${message}` })
          }
        },
      },

      delegate_preflight: {
        description: 'Check external CLI delegation readiness for Claude and Gemini CLIs.',
        args: {
          providers: z.string().optional().describe('Comma-separated providers to check (claude,gemini). Defaults to both.'),
          checkAuth: z.boolean().optional().describe('Whether to probe provider auth state'),
        },
        async execute(args) {
          const requestedProviders = (args.providers || '').split(',').map(s => s.trim()).filter(Boolean)
          const providers = requestedProviders
            .filter((provider): provider is Provider => provider === 'claude' || provider === 'gemini')

          const finalProviders: string[] = providers.length > 0 ? providers : ['claude', 'gemini']
          const warningsFromInput: string[] = []

          if (requestedProviders.length > 0 && providers.length !== requestedProviders.length) {
            warningsFromInput.push('Some invalid providers were ignored. Valid values: claude, gemini.')
          }

          const checks = await Promise.all(
            finalProviders.map(provider => preflightProvider(provider as Provider, {
              checkAuth: args.checkAuth !== false,
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
        args: {
          provider: z.string().describe('Target provider: claude, gemini, or auto'),
          prompt: z.string().describe('Prompt to send to provider CLI'),
          outputFormat: z.string().optional().describe('Output format: text or json'),
          timeoutMs: z.number().optional().describe('Process timeout in milliseconds'),
          workflowId: z.string().optional().describe('Optional workflow ID for traceability'),
          allowFallback: z.boolean().optional().describe('Allow fallback to next provider on failure'),
          resumeToken: z.string().optional().describe('Optional provider-native session token for resume'),
          parentRunId: z.string().optional().describe('Optional run ID that this invocation follows'),
          model: z.string().optional().describe('Model override for the provider CLI (e.g. "sonnet", "gemini-2.5-pro")'),
        },
        async execute(args) {
          const result = await executeDelegation({
            provider: args.provider as Provider | 'auto',
            prompt: args.prompt,
            outputFormat: args.outputFormat as OutputFormat | undefined,
            timeoutMs: args.timeoutMs,
            workflowId: args.workflowId,
            allowFallback: args.allowFallback,
            resumeToken: args.resumeToken || null,
            parentRunId: args.parentRunId || null,
            model: args.model || null,
          })

          return JSON.stringify(result.payload, null, 2)
        },
      },

      delegate_followup: {
        description: 'Send a follow-up prompt based on a previous delegation run.',
        args: {
          runId: z.string().describe('Previous run ID to continue from'),
          prompt: z.string().describe('Follow-up prompt'),
          outputFormat: z.string().optional().describe('Output format: text or json'),
          timeoutMs: z.number().optional().describe('Process timeout in milliseconds'),
          preferNativeResume: z.boolean().optional().describe('Try provider-native resume first if token exists'),
        },
        async execute(args) {
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
            outputFormat: (args.outputFormat as OutputFormat) || previous.output_format,
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
        args: {
          runId: z.string().describe('Delegation run ID'),
        },
        async execute(args) {
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
        args: {
          limit: z.number().optional().describe('Maximum records to return (1-100)'),
        },
        async execute(args) {
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
