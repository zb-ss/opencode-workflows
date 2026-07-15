import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensurePrivateDirectory, getSessionRuntimeDir } from './paths.ts'
import type { AutomaticWorkflowState } from './workflow-engine.ts'
import type {
  ValidationExecution,
  ValidationOperation,
  ValidationRunResult,
} from './validation-types.ts'

export function persistValidationAudit(
  sessionId: string,
  state: AutomaticWorkflowState,
  operation: ValidationOperation,
  execution: ValidationExecution,
  result: ValidationRunResult,
  runNumber: number,
  env: NodeJS.ProcessEnv,
  now: () => number,
): void {
  const directory = ensurePrivateDirectory(path.join(getSessionRuntimeDir(sessionId, env), 'validation-audit'))
  const target = path.join(directory, `${result.audit_id}.json`)
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  const record = {
    schema_version: 1,
    audit_id: result.audit_id,
    workflow_id: state.workflow_id,
    root_session_id: state.root_session_id,
    stage_session_id: sessionId,
    run_number: runNumber,
    operation: result.operation,
    executable: execution.executable,
    argument_count: operation.argv.length - 1,
    argv_sha256: crypto.createHash('sha256').update(JSON.stringify(operation.argv)).digest('hex'),
    environment: operation.environment,
    working_directory: operation.working_directory,
    started_at: new Date(now() - result.duration_ms).toISOString(),
    completed_at: new Date(now()).toISOString(),
    status: result.status,
    exit_code: result.exit_code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    stdout_bytes: result.stdout_bytes,
    stderr_bytes: result.stderr_bytes,
    output_truncated: result.output_truncated,
    output_redacted: result.output_redacted,
    stdout_sha256: execution.stdoutSha256,
    stderr_sha256: execution.stderrSha256,
  }
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    fs.renameSync(temporary, target)
    try { fs.chmodSync(target, 0o600) } catch {}
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}
