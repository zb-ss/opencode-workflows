import type { Message, OpencodeClient, Part, Session, SessionStatus } from '@opencode-ai/sdk'
import type { Agent as V2Agent, OpencodeClient as V2OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  evaluatePermissionRules,
  parsePermissionRules,
  resolveBoundedPermissionRules,
  type AutonomyProfile,
  type PermissionRule,
} from './autonomy-policy.ts'

export interface ModelSelection {
  model: string
  variant?: string
}

export interface SessionPromptOptions {
  agent?: string
  model?: ModelSelection
}

export interface SessionCreateOptions {
  agent?: string
  autonomy?: AutonomyProfile
  permission?: PermissionRule[]
}

type SdkEnvelope<T> = {
  data?: T
  error?: unknown
  request?: Request
  response?: Response
}

function isEnvelope(value: unknown): value is SdkEnvelope<unknown> {
  return typeof value === 'object' && value !== null && ('data' in value || 'error' in value || 'response' in value)
}

export function unwrapSdkResult<T>(result: unknown, operation: string, allowUndefined = false): T {
  if (!isEnvelope(result)) return result as T
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${formatSdkError(result.error)}`)
  }
  if (result.data === undefined && !allowUndefined) {
    throw new Error(`${operation} returned no data`)
  }
  return result.data as T
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function parseModel(selection: ModelSelection): { providerID: string; modelID: string } {
  const separator = selection.model.indexOf('/')
  if (separator <= 0 || separator === selection.model.length - 1) {
    throw new Error(`invalid model identifier: ${selection.model}`)
  }
  return {
    providerID: selection.model.slice(0, separator),
    modelID: selection.model.slice(separator + 1),
  }
}

export class OpenCodeSessionAdapter {
  private effectiveAgentRules?: Map<string, PermissionRule[]>

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string,
    private readonly autonomyClient?: V2OpencodeClient,
  ) {}

  async create(title: string, parentID?: string, options: SessionCreateOptions = {}): Promise<Pick<Session, 'id'>> {
    if (options.permission && options.autonomy) {
      throw new Error('session creation cannot combine an autonomy profile with explicit permissions')
    }
    if (options.permission) return this.createWithPermissions(title, parentID, options.agent, options.permission)
    if (options.autonomy === 'bounded') return this.createBounded(title, parentID, options.agent)

    const result = await this.client.session.create({
      body: { title, ...(parentID ? { parentID } : {}) },
      query: { directory: this.directory },
      throwOnError: true,
    })
    return unwrapSdkResult<Session>(result, 'session.create')
  }

  private async createWithPermissions(
    title: string,
    parentID: string | undefined,
    agent: string | undefined,
    permission: PermissionRule[],
  ): Promise<Pick<Session, 'id'>> {
    if (!agent) throw new Error('restricted session creation requires an agent')
    if (!this.autonomyClient) throw new Error('restricted session creation requires the OpenCode v2 client')
    const rules = parsePermissionRules(permission)
    const result = await this.autonomyClient.session.create({
      directory: this.directory,
      title,
      ...(parentID ? { parentID } : {}),
      agent,
      permission: rules,
    }, { throwOnError: true })
    return unwrapSdkResult<Pick<Session, 'id'>>(result, 'session.create')
  }

  private async createBounded(
    title: string,
    parentID: string | undefined,
    agent: string | undefined,
  ): Promise<Pick<Session, 'id'>> {
    if (!agent) throw new Error('bounded session creation requires an agent')
    if (!this.autonomyClient) throw new Error('bounded session creation requires the OpenCode v2 client')
    const permission = resolveBoundedPermissionRules(await this.agentRules(agent))
    const result = await this.autonomyClient.session.create({
      directory: this.directory,
      title,
      ...(parentID ? { parentID } : {}),
      agent,
      permission,
    }, { throwOnError: true })
    return unwrapSdkResult<Pick<Session, 'id'>>(result, 'session.create')
  }

  async assertPermissionAllowed(agent: string, permission: string, patterns: string[]): Promise<void> {
    const rules = await this.agentRules(agent)
    for (const pattern of patterns) {
      const action = evaluatePermissionRules(rules, permission, pattern)
      if (action !== 'allow') {
        throw new Error(
          `bounded autonomy requires ${agent} to silently allow ${permission} permission for ${pattern}; resolved action is ${action}`,
        )
      }
    }
  }

  async assertPermissionAction(
    agent: string,
    permission: string,
    patterns: string[],
    expected: 'allow' | 'ask' | 'deny',
  ): Promise<void> {
    const rules = await this.agentRules(agent)
    for (const pattern of patterns) {
      const action = evaluatePermissionRules(rules, permission, pattern)
      if (action !== expected) {
        throw new Error(
          `${permission} permission for ${pattern} must resolve to ${expected}; resolved action is ${action}`,
        )
      }
    }
  }

  private async agentRules(agent: string): Promise<PermissionRule[]> {
    const rules = (await this.loadEffectiveAgentRules()).get(agent)
    if (!rules) throw new Error(`bounded session agent not found: ${agent}`)
    return rules.map((rule) => ({ ...rule }))
  }

  private async loadEffectiveAgentRules(): Promise<Map<string, PermissionRule[]>> {
    if (this.effectiveAgentRules) return this.effectiveAgentRules
    if (!this.autonomyClient) throw new Error('bounded session creation requires the OpenCode v2 client')

    const result = await this.autonomyClient.app.agents({ directory: this.directory }, { throwOnError: true })
    const agents = unwrapSdkResult<V2Agent[]>(result, 'app.agents')

    const effectiveAgentRules = new Map<string, PermissionRule[]>()
    for (const [index, candidate] of agents.entries()) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error(`app.agents returned malformed agent ${index}`)
      }
      const { name, permission } = candidate as { name?: unknown; permission?: unknown }
      if (typeof name !== 'string' || name === '' || effectiveAgentRules.has(name)) {
        throw new Error(`app.agents returned malformed agent ${index}`)
      }
      effectiveAgentRules.set(name, parsePermissionRules(permission))
    }
    this.effectiveAgentRules = effectiveAgentRules
    return effectiveAgentRules
  }

  async promptAsync(sessionID: string, prompt: string, options: SessionPromptOptions = {}): Promise<void> {
    const model = options.model ? parseModel(options.model) : undefined
    const result = await this.client.session.promptAsync({
      path: { id: sessionID },
      query: { directory: this.directory },
      body: {
        ...(model ? { model } : {}),
        ...(options.model?.variant ? { variant: options.model.variant } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        parts: [{ type: 'text', text: prompt }],
      },
      throwOnError: true,
    })
    unwrapSdkResult<void>(result, 'session.promptAsync', true)
  }

  async abort(sessionID: string): Promise<void> {
    const result = await this.client.session.abort({
      path: { id: sessionID },
      query: { directory: this.directory },
      throwOnError: true,
    })
    unwrapSdkResult<void>(result, 'session.abort', true)
  }

  async statuses(): Promise<Record<string, SessionStatus>> {
    const result = await this.client.session.status({
      query: { directory: this.directory },
      throwOnError: true,
    })
    return unwrapSdkResult<Record<string, SessionStatus>>(result, 'session.status')
  }

  async messages(sessionID: string): Promise<Array<{ info: Message; parts: Part[] }>> {
    const result = await this.client.session.messages({
      path: { id: sessionID },
      query: { directory: this.directory },
      throwOnError: true,
    })
    return unwrapSdkResult<Array<{ info: Message; parts: Part[] }>>(result, 'session.messages')
  }

  async lastAssistantText(sessionID: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
    const messages = await this.messages(sessionID)
    const assistant = messages.slice().reverse().find((message) => message.info.role === 'assistant')
    if (!assistant) return ''
    const parts = assistant.parts
      .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    const output: string[] = []
    let bytes = 0
    for (const part of parts) {
      bytes += Buffer.byteLength(part.text, 'utf8') + (output.length === 0 ? 0 : 1)
      if (bytes > maximumBytes) throw new Error('assistant text exceeds configured result bytes')
      output.push(part.text)
    }
    return output.join('\n')
  }

  async availableModels(): Promise<Map<string, { variants: string[]; status?: string; context?: number }>> {
    const result = await this.client.config.providers({
      query: { directory: this.directory },
      throwOnError: true,
    })
    const data = unwrapSdkResult<{ providers: any[] }>(result, 'config.providers')
    const models = new Map<string, { variants: string[]; status?: string; context?: number }>()
    for (const provider of data.providers ?? []) {
      for (const model of Object.values(provider.models ?? {}) as any[]) {
        const variants = Object.entries(model.variants ?? {})
          .filter(([, value]) => !(value as { disabled?: boolean })?.disabled)
          .map(([name]) => name)
        models.set(`${provider.id}/${model.id}`, {
          variants,
          status: model.status,
          context: model.limit?.context,
        })
      }
    }
    return models
  }
}
