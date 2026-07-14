import type { WorkflowConfig } from './workflow-config.ts'

export const CAPABILITY_ENVIRONMENT = {
  background_subagents: 'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
  native_workspaces: 'OPENCODE_EXPERIMENTAL_WORKSPACES',
  mcp_code_mode: 'OPENCODE_EXPERIMENTAL_CODE_MODE',
  references: 'OPENCODE_EXPERIMENTAL_REFERENCES',
} as const

export type CapabilityName = keyof WorkflowConfig['experimental_capabilities']

export interface CapabilityStatus {
  mode: 'disabled' | 'auto' | 'required'
  available: boolean
  active: boolean
  source: string
}

export type CapabilityReport = Record<CapabilityName, CapabilityStatus>

function environmentFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function detectCapabilities(
  config: WorkflowConfig,
  environment: NodeJS.ProcessEnv = process.env,
): CapabilityReport {
  const report = {} as CapabilityReport

  for (const [name, variable] of Object.entries(CAPABILITY_ENVIRONMENT)) {
    const capability = name as Exclude<CapabilityName, 'plugin_v2'>
    const mode = config.experimental_capabilities[capability]
    const explicit = environment[variable]
    const source = explicit === undefined ? 'OPENCODE_EXPERIMENTAL' : variable
    const available = environmentFlagEnabled(explicit ?? environment.OPENCODE_EXPERIMENTAL)
    report[capability] = {
      mode,
      available,
      active: mode !== 'disabled' && available,
      source,
    }
  }

  const pluginMode = config.experimental_capabilities.plugin_v2
  report.plugin_v2 = {
    mode: pluginMode,
    available: true,
    active: pluginMode !== 'disabled',
    source: '@opencode-ai/plugin runtime',
  }

  return report
}

export function assertRequiredCapabilities(report: CapabilityReport): void {
  const unavailable = Object.entries(report)
    .filter(([, status]) => status.mode === 'required' && !status.available)
    .map(([name, status]) => `${name} (${status.source})`)

  if (unavailable.length > 0) {
    throw new Error(`required OpenCode capabilities are unavailable: ${unavailable.join(', ')}`)
  }
}
