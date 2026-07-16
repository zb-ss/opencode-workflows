import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Message, Part, Session, SessionStatus } from '@opencode-ai/sdk'

import type { ModelCandidate } from './workflow-config.ts'

export type WorkflowModelTier = 'low' | 'mid' | 'high'
export type AutomaticWorkflowStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type AutomaticStageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked'

export interface WorkflowStageDefinition {
  id: string
  description: string
  depends_on: string[]
  required: boolean
  agent_role: string
  model_tier: WorkflowModelTier
  prompt: string
}

export interface WorkflowDefinition {
  schema_version: 1
  id: string
  description: string
  stages: WorkflowStageDefinition[]
}

export interface StageResult {
  status: 'passed' | 'failed'
  summary: string
  details?: string[]
  retryable?: boolean
}

export interface AutomationLimits {
  max_sessions: number
  max_parallel_sessions: number
  max_attempts_per_stage: number
  max_wall_time_ms: number
  max_input_tokens: number
  max_output_tokens: number
  max_cost_usd: number | null
}

interface MessageUsage {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

export interface AutomaticStageState {
  status: AutomaticStageStatus
  attempt: number
  session_id: string | null
  agent: string
  model: string | null
  started_at: string | null
  completed_at: string | null
  result: StageResult | null
  error: string | null
}

export interface AutomaticWorkflowState {
  schema_version: 1
  workflow_id: string
  definition_id: string
  definition_path: string
  root_session_id: string
  directory: string
  worktree: string
  mode: string
  task: string
  status: AutomaticWorkflowStatus
  pause_reason: string | null
  created_at: string
  updated_at: string
  stages: Record<string, AutomaticStageState>
  budget: {
    limits: AutomationLimits
    usage: {
      sessions: number
      attempts: number
      input_tokens: number
      output_tokens: number
      cost_usd: number
      messages: Record<string, MessageUsage>
    }
  }
}

export interface WorkflowSessionAdapter {
  create(title: string, parentID?: string): Promise<Session>
  promptAsync(
    sessionID: string,
    prompt: string,
    options?: { agent?: string; model?: ModelCandidate },
  ): Promise<void>
  abort(sessionID: string): Promise<void>
  statuses(): Promise<Record<string, SessionStatus>>
  messages(sessionID: string): Promise<Array<{ info: Message; parts: Part[] }>>
}

export interface WorkflowEngineOptions {
  adapter: WorkflowSessionAdapter
  definition: WorkflowDefinition
  statePath: string
  definitionPath: string
  modeRouting: Record<string, string>
  modelCandidates: (agent: string, tier: WorkflowModelTier) => ModelCandidate[]
  limits: AutomationLimits
  state?: AutomaticWorkflowState
  schedulingEnabled?: boolean
  now?: () => number
}

export interface StartAutomaticWorkflowInput {
  workflowId?: string
  rootSessionId: string
  directory: string
  worktree: string
  mode: string
  task: string
}

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/
const TERMINAL_STAGE_STATUSES = new Set<AutomaticStageStatus>(['passed', 'failed', 'blocked'])
const TERMINAL_WORKFLOW_STATUSES = new Set<AutomaticWorkflowStatus>(['completed', 'failed', 'cancelled'])

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string, maximum = 20_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null`)
  return value
}

function dateTime(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date-time${nullable ? ' or null' : ''}`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const result = nonEmptyString(value, label, 64)
  if (!IDENTIFIER.test(result)) throw new Error(`${label} is not a safe identifier`)
  return result
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} has unsupported properties: ${unexpected.join(', ')}`)
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = objectValue(input, 'workflow definition')
  assertExactKeys(definition, ['schema_version', 'id', 'description', 'stages'], 'workflow definition')
  if (definition.schema_version !== 1) throw new Error('workflow definition schema_version must be 1')
  if (!Array.isArray(definition.stages) || definition.stages.length === 0 || definition.stages.length > 100) {
    throw new Error('workflow definition stages must contain between 1 and 100 entries')
  }

  const seen = new Set<string>()
  const stages = definition.stages.map((inputStage, index): WorkflowStageDefinition => {
    const stage = objectValue(inputStage, `stage ${index}`)
    assertExactKeys(
      stage,
      ['id', 'description', 'depends_on', 'required', 'agent_role', 'model_tier', 'prompt'],
      `stage ${index}`,
    )
    const id = identifier(stage.id, `stage ${index} id`)
    if (seen.has(id)) throw new Error(`duplicate stage ID: ${id}`)
    seen.add(id)
    const dependencies = stage.depends_on ?? []
    if (!Array.isArray(dependencies) || dependencies.length > 100) {
      throw new Error(`stage ${id} depends_on must be an array with at most 100 entries`)
    }
    const dependsOn = dependencies.map((dependency, dependencyIndex) =>
      identifier(dependency, `stage ${id} dependency ${dependencyIndex}`),
    )
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`stage ${id} has duplicate dependencies`)
    if (stage.required !== undefined && typeof stage.required !== 'boolean') {
      throw new Error(`stage ${id} required must be a boolean`)
    }
    if (stage.model_tier !== 'low' && stage.model_tier !== 'mid' && stage.model_tier !== 'high') {
      throw new Error(`stage ${id} has invalid model_tier`)
    }
    return {
      id,
      description: nonEmptyString(stage.description, `stage ${id} description`, 1000),
      depends_on: dependsOn,
      required: stage.required ?? true,
      agent_role: identifier(stage.agent_role, `stage ${id} agent_role`),
      model_tier: stage.model_tier,
      prompt: nonEmptyString(stage.prompt, `stage ${id} prompt`),
    }
  })

  const stageIds = new Set(stages.map((stage) => stage.id))
  for (const stage of stages) {
    for (const dependency of stage.depends_on) {
      if (!stageIds.has(dependency)) throw new Error(`stage ${stage.id} depends on unknown stage ${dependency}`)
      if (dependency === stage.id) throw new Error(`stage ${stage.id} cannot depend on itself`)
    }
  }

  const normalized: WorkflowDefinition = {
    schema_version: 1,
    id: identifier(definition.id, 'workflow definition id'),
    description: nonEmptyString(definition.description, 'workflow definition description', 1000),
    stages,
  }
  topologicalStageIds(normalized)
  return normalized
}

export function topologicalStageIds(definition: WorkflowDefinition): string[] {
  const order = new Map(definition.stages.map((stage, index) => [stage.id, index]))
  const indegree = new Map(definition.stages.map((stage) => [stage.id, stage.depends_on.length]))
  const dependents = new Map(definition.stages.map((stage) => [stage.id, [] as string[]]))
  for (const stage of definition.stages) {
    for (const dependency of stage.depends_on) dependents.get(dependency)?.push(stage.id)
  }
  const ready = definition.stages.filter((stage) => stage.depends_on.length === 0).map((stage) => stage.id)
  const result: string[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    const current = ready.shift()!
    result.push(current)
    for (const dependent of dependents.get(current) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (result.length !== definition.stages.length) {
    const cyclic = definition.stages.map((stage) => stage.id).filter((id) => !result.includes(id))
    throw new Error(`workflow definition contains a dependency cycle involving: ${cyclic.join(', ')}`)
  }
  return result
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const document = fenced ? fenced[1] : trimmed
  if (!document) throw new Error('stage result is empty')
  try {
    return JSON.parse(document)
  } catch (error) {
    throw new Error(`stage result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function validateStageResult(input: unknown): StageResult {
  const result = objectValue(input, 'stage result')
  assertExactKeys(result, ['status', 'summary', 'details', 'retryable'], 'stage result')
  if (result.status !== 'passed' && result.status !== 'failed') {
    throw new Error('stage result status must be passed or failed')
  }
  const summary = nonEmptyString(result.summary, 'stage result summary', 8000)
  let details: string[] | undefined
  if (result.details !== undefined) {
    if (!Array.isArray(result.details) || result.details.length > 100) {
      throw new Error('stage result details must contain at most 100 strings')
    }
    details = result.details.map((detail, index) => nonEmptyString(detail, `stage result detail ${index}`, 4000))
  }
  if (result.retryable !== undefined && typeof result.retryable !== 'boolean') {
    throw new Error('stage result retryable must be a boolean')
  }
  return {
    status: result.status,
    summary,
    ...(details ? { details } : {}),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
  }
}

export function parseStageResult(text: string): StageResult {
  return validateStageResult(parseJsonDocument(text))
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`)
  return Number(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

export function validateAutomationLimits(input: AutomationLimits): AutomationLimits {
  return {
    max_sessions: positiveInteger(input.max_sessions, 'max_sessions'),
    max_parallel_sessions: positiveInteger(input.max_parallel_sessions, 'max_parallel_sessions'),
    max_attempts_per_stage: positiveInteger(input.max_attempts_per_stage, 'max_attempts_per_stage'),
    max_wall_time_ms: positiveInteger(input.max_wall_time_ms, 'max_wall_time_ms'),
    max_input_tokens: nonNegativeInteger(input.max_input_tokens, 'max_input_tokens'),
    max_output_tokens: nonNegativeInteger(input.max_output_tokens, 'max_output_tokens'),
    max_cost_usd: input.max_cost_usd === null
      ? null
      : (() => {
          if (!Number.isFinite(input.max_cost_usd) || input.max_cost_usd < 0) {
            throw new Error('max_cost_usd must be null or a non-negative number')
          }
          return input.max_cost_usd
        })(),
  }
}

export function loadWorkflowDefinition(filePath: string): WorkflowDefinition {
  return validateWorkflowDefinition(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

export function loadAutomaticWorkflowState(filePath: string): AutomaticWorkflowState {
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AutomaticWorkflowState
  validateAutomaticWorkflowState(state)
  return state
}

export function validateAutomaticWorkflowState(input: unknown): asserts input is AutomaticWorkflowState {
  const state = objectValue(input, 'automatic workflow state')
  assertExactKeys(state, [
    'schema_version', 'workflow_id', 'definition_id', 'definition_path', 'root_session_id', 'directory',
    'worktree', 'mode', 'task', 'status', 'pause_reason', 'created_at', 'updated_at', 'stages', 'budget',
  ], 'automatic workflow state')
  if (state.schema_version !== 1) throw new Error('automatic workflow state schema_version must be 1')
  for (const key of ['workflow_id', 'definition_id', 'definition_path', 'root_session_id', 'directory', 'worktree', 'mode', 'task']) {
    nonEmptyString(state[key], `automatic workflow state ${key}`)
  }
  if (!['running', 'paused', 'completed', 'failed', 'cancelled'].includes(String(state.status))) {
    throw new Error('automatic workflow state has invalid status')
  }
  if (state.pause_reason !== null && typeof state.pause_reason !== 'string') {
    throw new Error('automatic workflow state pause_reason must be a string or null')
  }
  dateTime(state.created_at, 'automatic workflow state created_at')
  dateTime(state.updated_at, 'automatic workflow state updated_at')
  const stages = objectValue(state.stages, 'automatic workflow state stages')
  if (Object.keys(stages).length === 0) throw new Error('automatic workflow state has no stages')
  for (const [id, inputStage] of Object.entries(stages)) {
    identifier(id, 'automatic workflow stage ID')
    const stage = objectValue(inputStage, `automatic workflow stage ${id}`)
    assertExactKeys(stage, [
      'status', 'attempt', 'session_id', 'agent', 'model', 'started_at', 'completed_at', 'result', 'error',
    ], `automatic workflow stage ${id}`)
    if (!['pending', 'running', 'passed', 'failed', 'blocked'].includes(String(stage.status))) {
      throw new Error(`automatic workflow stage ${id} has invalid status`)
    }
    nonNegativeInteger(stage.attempt, `automatic workflow stage ${id} attempt`)
    nullableString(stage.session_id, `automatic workflow stage ${id} session_id`)
    nonEmptyString(stage.agent, `automatic workflow stage ${id} agent`)
    nullableString(stage.model, `automatic workflow stage ${id} model`)
    dateTime(stage.started_at, `automatic workflow stage ${id} started_at`, true)
    dateTime(stage.completed_at, `automatic workflow stage ${id} completed_at`, true)
    if (stage.result !== null) validateStageResult(stage.result)
    nullableString(stage.error, `automatic workflow stage ${id} error`)
  }
  const budget = objectValue(state.budget, 'automatic workflow state budget')
  assertExactKeys(budget, ['limits', 'usage'], 'automatic workflow state budget')
  validateAutomationLimits(objectValue(budget.limits, 'automatic workflow limits') as unknown as AutomationLimits)
  const usage = objectValue(budget.usage, 'automatic workflow usage')
  assertExactKeys(
    usage,
    ['sessions', 'attempts', 'input_tokens', 'output_tokens', 'cost_usd', 'messages'],
    'automatic workflow usage',
  )
  for (const key of ['sessions', 'attempts', 'input_tokens', 'output_tokens']) {
    nonNegativeInteger(usage[key], `automatic workflow usage ${key}`)
  }
  if (!Number.isFinite(usage.cost_usd) || Number(usage.cost_usd) < 0) {
    throw new Error('automatic workflow usage cost_usd must be a non-negative number')
  }
  const messages = objectValue(usage.messages, 'automatic workflow usage messages')
  for (const [id, inputMessage] of Object.entries(messages)) {
    const message = objectValue(inputMessage, `automatic workflow usage message ${id}`)
    assertExactKeys(message, ['input_tokens', 'output_tokens', 'cost_usd'], `automatic workflow usage message ${id}`)
    nonNegativeInteger(message.input_tokens, `automatic workflow usage message ${id} input_tokens`)
    nonNegativeInteger(message.output_tokens, `automatic workflow usage message ${id} output_tokens`)
    if (!Number.isFinite(message.cost_usd) || Number(message.cost_usd) < 0) {
      throw new Error(`automatic workflow usage message ${id} cost_usd must be a non-negative number`)
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === 'string') return data.message
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function eventSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const input = event as { type?: string; properties?: any }
  if (input.type === 'message.updated') return input.properties?.info?.sessionID ?? null
  if (input.type === 'message.part.updated') return input.properties?.part?.sessionID ?? null
  return input.properties?.sessionID ?? null
}

function cloneState(state: AutomaticWorkflowState): AutomaticWorkflowState {
  return structuredClone(state)
}

export class WorkflowEngine {
  private readonly adapter: WorkflowSessionAdapter
  private readonly definition: WorkflowDefinition
  private readonly statePath: string
  private readonly definitionPath: string
  private readonly modeRouting: Record<string, string>
  private readonly modelCandidates: WorkflowEngineOptions['modelCandidates']
  private readonly configuredLimits: AutomationLimits
  private readonly now: () => number
  private readonly topologicalOrder: string[]
  private state: AutomaticWorkflowState | null
  private schedulingEnabled: boolean
  private operation: Promise<void> = Promise.resolve()
  private wallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: WorkflowEngineOptions) {
    this.adapter = options.adapter
    this.definition = validateWorkflowDefinition(options.definition)
    this.statePath = path.resolve(options.statePath)
    this.definitionPath = path.resolve(options.definitionPath)
    this.modeRouting = { ...options.modeRouting }
    this.modelCandidates = options.modelCandidates
    this.configuredLimits = validateAutomationLimits(options.limits)
    this.now = options.now ?? Date.now
    this.topologicalOrder = topologicalStageIds(this.definition)
    this.schedulingEnabled = options.schedulingEnabled ?? true
    this.state = options.state ? cloneState(options.state) : null
    if (this.state) {
      validateAutomaticWorkflowState(this.state)
      if (this.state.definition_id !== this.definition.id) throw new Error('saved state does not match the workflow definition')
      this.assertStateStages()
      this.state.budget.limits = this.configuredLimits
      if (this.state.status === 'running') this.scheduleWallTimer()
    }
  }

  start(input: StartAutomaticWorkflowInput): Promise<AutomaticWorkflowState> {
    return this.serial(async () => {
      if (this.state) throw new Error('an automatic workflow already exists in this engine')
      const task = nonEmptyString(input.task.trim(), 'automatic workflow task', 20_000)
      const now = new Date(this.now()).toISOString()
      const stages: Record<string, AutomaticStageState> = {}
      for (const stage of this.definition.stages) {
        const routed = this.modeRouting[stage.agent_role]
        if (!routed) throw new Error(`mode does not route agent role ${stage.agent_role} for stage ${stage.id}`)
        const agent = routed.startsWith('wf-') ? routed : `wf-${routed}`
        stages[stage.id] = {
          status: 'pending',
          attempt: 0,
          session_id: null,
          agent,
          model: null,
          started_at: null,
          completed_at: null,
          result: null,
          error: null,
        }
      }
      this.state = {
        schema_version: 1,
        workflow_id: input.workflowId ?? `auto-${this.definition.id}-${crypto.randomUUID()}`,
        definition_id: this.definition.id,
        definition_path: this.definitionPath,
        root_session_id: nonEmptyString(input.rootSessionId, 'root session ID'),
        directory: path.resolve(nonEmptyString(input.directory, 'workflow directory')),
        worktree: path.resolve(nonEmptyString(input.worktree, 'workflow worktree')),
        mode: nonEmptyString(input.mode, 'workflow mode', 64),
        task,
        status: 'running',
        pause_reason: null,
        created_at: now,
        updated_at: now,
        stages,
        budget: {
          limits: validateAutomationLimits(this.currentLimits()),
          usage: {
            sessions: 0,
            attempts: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            messages: {},
          },
        },
      }
      this.persistDefinition()
      this.persist()
      this.scheduleWallTimer()
      await this.schedule()
      return cloneState(this.requiredState())
    })
  }

  resume(limits?: AutomationLimits): Promise<AutomaticWorkflowState> {
    return this.serial(async () => {
      const state = this.requiredState()
      if (TERMINAL_WORKFLOW_STATUSES.has(state.status)) return cloneState(state)
      if (limits) state.budget.limits = validateAutomationLimits(limits)
      this.schedulingEnabled = true
      state.status = 'running'
      state.pause_reason = null
      this.persist()
      this.scheduleWallTimer()
      await this.reconcileInternal()
      await this.schedule()
      return cloneState(this.requiredState())
    })
  }

  reconcile(): Promise<AutomaticWorkflowState> {
    return this.serial(async () => {
      await this.reconcileInternal()
      await this.schedule()
      return cloneState(this.requiredState())
    })
  }

  handleEvent(event: unknown): Promise<void> {
    return this.serial(async () => {
      const state = this.state
      const sessionId = eventSessionId(event)
      if (!state || !sessionId || TERMINAL_WORKFLOW_STATUSES.has(state.status)) return
      const stage = this.stageForSession(sessionId)
      if (!stage) return
      const input = event as { type?: string; properties?: any }

      if (input.type === 'message.updated') {
        if (this.accountMessage(input.properties?.info)) {
          this.persist()
          const reason = this.exceededUsageReason()
          if (reason) await this.pauseInternal(reason, true)
        }
        return
      }
      if (input.type === 'session.error') {
        await this.finishAttempt(stage.id, null, `child session failed: ${errorText(input.properties?.error ?? 'unknown error')}`)
        await this.schedule()
        return
      }
      const isIdle = input.type === 'session.idle'
        || (input.type === 'session.status' && input.properties?.status?.type === 'idle')
      if (isIdle) {
        await this.completeSession(stage.id, sessionId)
        await this.schedule()
      }
    })
  }

  cancel(): Promise<AutomaticWorkflowState> {
    return this.serial(async () => {
      const state = this.requiredState()
      if (TERMINAL_WORKFLOW_STATUSES.has(state.status)) return cloneState(state)
      const running = Object.values(state.stages).filter((stage) => stage.status === 'running' && stage.session_id)
      const now = new Date(this.now()).toISOString()
      for (const stage of Object.values(state.stages)) {
        if (stage.status === 'pending') {
          stage.status = 'blocked'
          stage.error = 'Workflow cancelled by owner'
          stage.completed_at = now
        } else if (stage.status === 'running') {
          stage.status = 'failed'
          stage.error = 'Workflow cancelled by owner'
          stage.completed_at = now
        }
      }
      state.status = 'cancelled'
      state.pause_reason = null
      this.clearWallTimer()
      this.persist()
      await Promise.all(running.map((stage) => this.adapter.abort(stage.session_id!).catch(() => undefined)))
      return cloneState(state)
    })
  }

  snapshot(): AutomaticWorkflowState {
    return cloneState(this.requiredState())
  }

  ownsSession(sessionId: string): boolean {
    return Boolean(this.state && Object.values(this.state.stages).some((stage) => stage.session_id === sessionId))
  }

  dispose(): void {
    this.clearWallTimer()
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async schedule(): Promise<void> {
    const state = this.requiredState()
    if (state.status !== 'running') return
    this.applyDependencyBlocks()
    if (this.evaluateTerminalState()) return
    if (!this.schedulingEnabled) {
      if (!this.hasRunningStages() && this.readyStageIds().length > 0) {
        await this.pauseInternal('Explicit /workflow-auto-resume is required after runtime restoration', false)
      }
      return
    }

    const generalReason = this.launchBudgetReason()
    if (generalReason) {
      await this.pauseInternal(generalReason, true)
      return
    }
    let available = state.budget.limits.max_parallel_sessions - this.runningCount()
    for (const stageId of this.readyStageIds()) {
      if (available <= 0 || state.status !== 'running') break
      const stage = state.stages[stageId]
      if (stage.attempt >= state.budget.limits.max_attempts_per_stage) {
        await this.pauseInternal(`Attempt budget exhausted for stage ${stageId}`, true)
        break
      }
      const reason = this.launchBudgetReason()
      if (reason) {
        await this.pauseInternal(reason, true)
        break
      }
      await this.launch(stageId)
      available = state.budget.limits.max_parallel_sessions - this.runningCount()
    }
    this.evaluateTerminalState()
    if (state.status === 'running' && !this.hasRunningStages() && this.readyStageIds().length > 0) {
      await this.schedule()
    }
  }

  private async launch(stageId: string): Promise<void> {
    const state = this.requiredState()
    const stageDefinition = this.definition.stages.find((stage) => stage.id === stageId)!
    const stage = state.stages[stageId]
    stage.status = 'running'
    stage.attempt++
    stage.started_at = new Date(this.now()).toISOString()
    stage.completed_at = null
    stage.result = null
    stage.error = null
    state.budget.usage.attempts++
    const candidates = this.modelCandidates(stage.agent, stageDefinition.model_tier)
    const candidate = candidates.length > 0 ? candidates[(stage.attempt - 1) % candidates.length] : undefined
    stage.model = candidate?.model ?? null
    this.persist()

    try {
      const session = await this.adapter.create(
        `[${state.workflow_id}] ${stageId} (attempt ${stage.attempt})`,
        state.root_session_id,
      )
      stage.session_id = session.id
      state.budget.usage.sessions++
      this.persist()
      await this.adapter.promptAsync(session.id, this.stagePrompt(stageDefinition), {
        agent: stage.agent,
        ...(candidate ? { model: candidate } : {}),
      })
    } catch (error) {
      if (stage.session_id) await this.adapter.abort(stage.session_id).catch(() => undefined)
      await this.finishAttempt(stageId, null, `failed to start child session: ${errorText(error)}`)
    }
  }

  private stagePrompt(stage: WorkflowStageDefinition): string {
    const state = this.requiredState()
    const dependencySummaries = stage.depends_on.map((dependency) => {
      const result = state.stages[dependency].result
      return `- ${dependency}: ${result?.summary ?? state.stages[dependency].status}`
    })
    return [
      '# Automatic Workflow Stage',
      `Workflow: ${state.workflow_id}`,
      `Definition: ${state.definition_id}`,
      `Mode: ${state.mode}`,
      `Stage: ${stage.id} - ${stage.description}`,
      `Task: ${state.task}`,
      '',
      stage.prompt,
      ...(dependencySummaries.length > 0 ? ['', 'Dependency results:', ...dependencySummaries] : []),
      '',
      'Do not call the Task tool or spawn nested agents. This session is the complete budgeted stage.',
      'Your final response MUST be only one JSON object matching this exact contract:',
      '{"status":"passed","summary":"non-empty summary","details":["optional detail"],"retryable":true}',
      'Use status "passed" only when this stage is directly verified. Use "failed" otherwise.',
      'Do not wrap the JSON in prose. A fenced JSON object is accepted only for compatibility.',
    ].join('\n')
  }

  private async completeSession(stageId: string, sessionId: string): Promise<void> {
    const state = this.requiredState()
    const stage = state.stages[stageId]
    if (stage.status !== 'running' || stage.session_id !== sessionId) return
    try {
      const messages = await this.adapter.messages(sessionId)
      let lastText = ''
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        this.accountMessage(message.info, `${sessionId}:${index}`)
        if (message.info.role !== 'assistant') continue
        lastText = message.parts
          .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      }
      this.persist()
      const budgetReason = this.exceededUsageReason()
      if (budgetReason) {
        await this.pauseInternal(budgetReason, true)
        return
      }
      const result = parseStageResult(lastText)
      await this.finishAttempt(stageId, result)
    } catch (error) {
      await this.finishAttempt(stageId, null, `invalid structured stage result: ${errorText(error)}`)
    }
  }

  private async finishAttempt(stageId: string, result: StageResult | null, failure?: string): Promise<void> {
    const state = this.requiredState()
    const stage = state.stages[stageId]
    if (stage.status !== 'running') return
    stage.session_id = null
    stage.completed_at = new Date(this.now()).toISOString()
    stage.result = result
    stage.error = failure ?? (result?.status === 'failed' ? result.summary : null)

    if (result?.status === 'passed') {
      stage.status = 'passed'
      this.persist()
      return
    }
    const retryable = result?.retryable !== false
    if (!retryable) {
      stage.status = 'failed'
      this.applyDependencyBlocks()
      this.persist()
      return
    }
    if (stage.attempt >= state.budget.limits.max_attempts_per_stage) {
      stage.status = 'pending'
      this.persist()
      await this.pauseInternal(`Attempt budget exhausted for stage ${stageId}`, true)
      return
    }
    stage.status = 'pending'
    this.persist()
  }

  private async reconcileInternal(): Promise<void> {
    const state = this.requiredState()
    if (TERMINAL_WORKFLOW_STATUSES.has(state.status)) return
    let recovered = false
    for (const [stageId, stage] of Object.entries(state.stages)) {
      if (stage.status !== 'running' || stage.session_id) continue
      stage.status = 'pending'
      stage.error = `Recovered interrupted launch for stage ${stageId}`
      stage.started_at = null
      recovered = true
    }
    if (recovered) this.persist()
    const running = Object.entries(state.stages).filter(([, stage]) => stage.status === 'running' && stage.session_id)
    if (running.length === 0) return
    let statuses: Record<string, SessionStatus> = {}
    try {
      statuses = await this.adapter.statuses()
    } catch (error) {
      await this.pauseInternal(`Child-session reconciliation failed: ${errorText(error)}`, false)
      return
    }
    for (const [stageId, stage] of running) {
      if (stage.status !== 'running' || !stage.session_id) continue
      const sessionStatus = statuses[stage.session_id]
      if (sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry') continue
      await this.completeSession(stageId, stage.session_id)
    }
  }

  private accountMessage(input: unknown, fallbackId?: string): boolean {
    if (!input || typeof input !== 'object') return false
    const message = input as {
      id?: unknown
      role?: unknown
      cost?: unknown
      tokens?: { input?: unknown; output?: unknown; reasoning?: unknown }
    }
    if (message.role !== 'assistant') return false
    const id = typeof message.id === 'string' ? message.id : fallbackId
    if (!id) return false
    const observed: MessageUsage = {
      input_tokens: Math.floor(Math.max(0, Number.isFinite(message.tokens?.input) ? Number(message.tokens?.input) : 0)),
      output_tokens: Math.floor(Math.max(0,
        (Number.isFinite(message.tokens?.output) ? Number(message.tokens?.output) : 0)
        + (Number.isFinite(message.tokens?.reasoning) ? Number(message.tokens?.reasoning) : 0),
      )),
      cost_usd: Math.max(0, Number.isFinite(message.cost) ? Number(message.cost) : 0),
    }
    const stateUsage = this.requiredState().budget.usage
    const previous = stateUsage.messages[id] ?? { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
    const usage: MessageUsage = {
      input_tokens: Math.max(previous.input_tokens, observed.input_tokens),
      output_tokens: Math.max(previous.output_tokens, observed.output_tokens),
      cost_usd: Math.max(previous.cost_usd, observed.cost_usd),
    }
    stateUsage.input_tokens += usage.input_tokens - previous.input_tokens
    stateUsage.output_tokens += usage.output_tokens - previous.output_tokens
    stateUsage.cost_usd += usage.cost_usd - previous.cost_usd
    stateUsage.messages[id] = usage
    return usage.input_tokens !== previous.input_tokens
      || usage.output_tokens !== previous.output_tokens
      || usage.cost_usd !== previous.cost_usd
  }

  private readyStageIds(): string[] {
    const state = this.requiredState()
    const definitionById = new Map(this.definition.stages.map((stage) => [stage.id, stage]))
    return this.topologicalOrder.filter((stageId) => {
      if (state.stages[stageId].status !== 'pending') return false
      return definitionById.get(stageId)!.depends_on.every((dependency) => state.stages[dependency].status === 'passed')
    })
  }

  private applyDependencyBlocks(): void {
    const state = this.requiredState()
    let changed = false
    do {
      changed = false
      for (const stage of this.definition.stages) {
        const current = state.stages[stage.id]
        if (current.status !== 'pending') continue
        if (stage.depends_on.some((dependency) => {
          const dependencyStatus = state.stages[dependency].status
          return dependencyStatus === 'failed' || dependencyStatus === 'blocked'
        })) {
          current.status = 'blocked'
          current.error = 'Blocked by a failed dependency'
          current.completed_at = new Date(this.now()).toISOString()
          changed = true
        }
      }
    } while (changed)
  }

  private evaluateTerminalState(): boolean {
    const state = this.requiredState()
    if (state.status !== 'running') return true
    const allTerminal = Object.values(state.stages).every((stage) => TERMINAL_STAGE_STATUSES.has(stage.status))
    if (!allTerminal) return false
    const requiredPassed = this.definition.stages
      .filter((stage) => stage.required)
      .every((stage) => state.stages[stage.id].status === 'passed')
    state.status = requiredPassed ? 'completed' : 'failed'
    state.pause_reason = null
    this.clearWallTimer()
    this.persist()
    return true
  }

  private exceededUsageReason(): string | null {
    const { limits, usage } = this.requiredState().budget
    if (usage.input_tokens > limits.max_input_tokens) return 'Input token budget exhausted'
    if (usage.output_tokens > limits.max_output_tokens) return 'Output token budget exhausted'
    if (limits.max_cost_usd !== null && usage.cost_usd > limits.max_cost_usd) return 'Cost budget exhausted'
    if (this.now() - new Date(this.requiredState().created_at).getTime() >= limits.max_wall_time_ms) {
      return 'Wall-time budget exhausted'
    }
    return null
  }

  private launchBudgetReason(): string | null {
    const exceeded = this.exceededUsageReason()
    if (exceeded) return exceeded
    const { limits, usage } = this.requiredState().budget
    if (usage.sessions >= limits.max_sessions) return 'Child-session budget exhausted'
    if (usage.input_tokens >= limits.max_input_tokens) return 'Input token budget exhausted'
    if (usage.output_tokens >= limits.max_output_tokens) return 'Output token budget exhausted'
    if (limits.max_cost_usd !== null && usage.cost_usd >= limits.max_cost_usd) return 'Cost budget exhausted'
    return null
  }

  private async pauseInternal(reason: string, abortRunning: boolean): Promise<void> {
    const state = this.requiredState()
    if (TERMINAL_WORKFLOW_STATUSES.has(state.status)) return
    const runningSessionIds: string[] = []
    if (abortRunning) {
      for (const stage of Object.values(state.stages)) {
        if (stage.status !== 'running') continue
        if (stage.session_id) runningSessionIds.push(stage.session_id)
        stage.status = 'pending'
        stage.session_id = null
        stage.completed_at = new Date(this.now()).toISOString()
        stage.error = reason
      }
    }
    state.status = 'paused'
    state.pause_reason = reason
    this.clearWallTimer()
    this.persist()
    await Promise.all(runningSessionIds.map((sessionId) => this.adapter.abort(sessionId).catch(() => undefined)))
  }

  private stageForSession(sessionId: string): { id: string; state: AutomaticStageState } | null {
    const entry = Object.entries(this.requiredState().stages).find(([, stage]) => stage.session_id === sessionId)
    return entry ? { id: entry[0], state: entry[1] } : null
  }

  private runningCount(): number {
    return Object.values(this.requiredState().stages).filter((stage) => stage.status === 'running').length
  }

  private hasRunningStages(): boolean {
    return this.runningCount() > 0
  }

  private currentLimits(): AutomationLimits {
    return this.state?.budget.limits ?? this.configuredLimits
  }

  private persistDefinition(): void {
    fs.mkdirSync(path.dirname(this.definitionPath), { recursive: true, mode: 0o700 })
    this.atomicWrite(this.definitionPath, this.definition)
  }

  private persist(): void {
    const state = this.requiredState()
    state.updated_at = new Date(this.now()).toISOString()
    validateAutomaticWorkflowState(state)
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 })
    this.atomicWrite(this.statePath, state)
  }

  private atomicWrite(filePath: string, value: unknown): void {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, filePath)
      try { fs.chmodSync(filePath, 0o600) } catch {}
    } catch (error) {
      try { fs.unlinkSync(temporary) } catch {}
      throw error
    }
  }

  private assertStateStages(): void {
    const state = this.requiredState()
    const expected = this.definition.stages.map((stage) => stage.id).sort()
    const actual = Object.keys(state.stages).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('saved state stages do not match the definition')
  }

  private scheduleWallTimer(): void {
    this.clearWallTimer()
    const state = this.state
    if (!state || state.status !== 'running') return
    const elapsed = this.now() - new Date(state.created_at).getTime()
    const remaining = state.budget.limits.max_wall_time_ms - elapsed
    const timer = setTimeout(() => {
      void this.serial(async () => this.pauseInternal('Wall-time budget exhausted', true))
    }, Math.max(1, remaining))
    timer.unref?.()
    this.wallTimer = timer
  }

  private clearWallTimer(): void {
    if (this.wallTimer) clearTimeout(this.wallTimer)
    this.wallTimer = null
  }

  private requiredState(): AutomaticWorkflowState {
    if (!this.state) throw new Error('automatic workflow has not been started')
    return this.state
  }
}
