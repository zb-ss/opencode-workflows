import type { WorkflowConfig } from './workflow-config.ts'

export type ValidationBrokerConfig = WorkflowConfig['validation_broker']
export type ValidationOperation = ValidationBrokerConfig['operations'][string]

export interface ValidationRunResult {
  operation: string
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled'
  exit_code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdout_bytes: number
  stderr_bytes: number
  output_truncated: boolean
  output_redacted: boolean
  duration_ms: number
  audit_id: string
}

export interface ValidationExecution {
  executable: string
  outputSensitive: boolean
  result: ValidationRunResult
  stderrSha256: string
  stdoutSha256: string
}
