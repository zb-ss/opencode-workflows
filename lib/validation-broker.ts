import type { ToolContext } from '@opencode-ai/plugin'
import crypto from 'node:crypto'
import fs from 'node:fs'

import { openAnchoredDirectory } from './bounded-file-transport.ts'
import { throwIfAborted } from './tool-context.ts'
import { persistValidationAudit } from './validation-audit-store.ts'
import {
  trustedExecutable,
  validationDirectory,
  validationEnvironment,
} from './validation-executable-policy.ts'
import { outputText, redactValidationOutput } from './validation-output.ts'
import {
  killValidationProcess,
  runValidationProcess,
} from './validation-process-runner.ts'
import type {
  ValidationBrokerConfig,
  ValidationExecution,
  ValidationOperation,
  ValidationRunResult,
} from './validation-types.ts'
import type { AutomaticWorkflowState } from './workflow-engine.ts'

interface ValidationWorkflowOwner {
  snapshot(): AutomaticWorkflowState
  usesBoundedAutonomy(): boolean
  consumeValidationRun(sessionId: string): Promise<number>
}

interface ValidationBrokerOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  platform?: NodeJS.Platform
  terminateProcess?: typeof killValidationProcess
}

export type { ValidationRunResult } from './validation-types.ts'

function cancelledExecution(operation: string, executable: string): ValidationExecution {
  const emptyHash = crypto.createHash('sha256').digest('hex')
  return {
    executable,
    outputSensitive: false,
    stderrSha256: emptyHash,
    stdoutSha256: emptyHash,
    result: {
      operation,
      status: 'cancelled',
      exit_code: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdout_bytes: 0,
      stderr_bytes: 0,
      output_truncated: false,
      output_redacted: false,
      duration_ms: 0,
      audit_id: crypto.randomUUID(),
    },
  }
}

export class ValidationBroker {
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly terminateProcess: typeof killValidationProcess

  constructor(
    private readonly config: ValidationBrokerConfig,
    private readonly ownerForSession: (sessionId: string) => ValidationWorkflowOwner | undefined,
    options: ValidationBrokerOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.terminateProcess = options.terminateProcess ?? killValidationProcess
  }

  async run(operationName: string, context: ToolContext): Promise<string> {
    throwIfAborted(context)
    if (!this.config.enabled) throw new Error('validation broker is disabled in workflows.json')
    const operation = this.config.operations[operationName]
    if (!operation) throw new Error(`validation operation is not configured: ${operationName}`)
    if (this.platform === 'win32') {
      throw new Error('validation broker is unavailable on Windows because descendant process termination cannot be guaranteed')
    }
    const owner = this.workflowOwner(context.sessionID)
    const state = owner.snapshot()
    const directory = validationDirectory(state.worktree, operation.working_directory)

    await context.ask({
      permission: 'workflow_validation_run',
      patterns: [operation.permission_pattern],
      always: [],
      metadata: {
        operation: operationName,
        workflow_driver: 'automatic',
        root_session_id: state.root_session_id,
      },
    })
    throwIfAborted(context)
    const runNumber = await owner.consumeValidationRun(context.sessionID)
    if (context.abort.aborted) {
      const execution = cancelledExecution(operationName, operation.argv[0])
      this.persistAudit(context.sessionID, state, operation, execution, execution.result, runNumber)
      return JSON.stringify(execution.result)
    }
    const execution = await this.execute(operationName, operation, state.worktree, directory, context.abort)
    const safeResult = redactValidationOutput(execution.result, execution.outputSensitive)
    this.persistAudit(context.sessionID, state, operation, execution, safeResult, runNumber)
    return JSON.stringify(safeResult)
  }

  private workflowOwner(sessionId: string): ValidationWorkflowOwner {
    const owner = this.ownerForSession(sessionId)
    if (!owner) throw new Error('validation broker is available only inside an owned automatic workflow stage')
    if (owner.usesBoundedAutonomy()) {
      throw new Error('validation broker requires interactive autonomy because validation code is not OS-sandboxed')
    }
    if (owner.snapshot().status !== 'running') {
      throw new Error('validation broker is disabled while the automatic workflow is paused')
    }
    return owner
  }

  private async execute(
    operationName: string,
    operation: ValidationOperation,
    worktree: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<ValidationExecution> {
    const startedAt = this.now()
    const auditId = crypto.randomUUID()
    const resolved = trustedExecutable(operation.argv[0], this.env, worktree)
    const directoryDescriptor = openAnchoredDirectory(directory, worktree)
    try {
      const run = await runValidationProcess(
        resolved.executable,
        operation,
        directoryDescriptor,
        validationEnvironment(operation, this.env, resolved.searchPath, this.platform),
        this.platform,
        signal,
        this.terminateProcess,
      )
      const status = run.forcedStatus ?? (
        run.completion.code !== null && operation.success_exit_codes.includes(run.completion.code) ? 'passed' : 'failed'
      )
      return {
        executable: resolved.executable,
        outputSensitive: run.stdout.sensitive || run.stderr.sensitive,
        stdoutSha256: run.stdout.hash.digest('hex'),
        stderrSha256: run.stderr.hash.digest('hex'),
        result: {
          operation: operationName,
          status,
          exit_code: run.completion.code,
          signal: run.completion.processSignal,
          stdout: outputText(run.stdout),
          stderr: outputText(run.stderr),
          stdout_bytes: run.stdout.totalBytes,
          stderr_bytes: run.stderr.totalBytes,
          output_truncated: run.stdout.totalBytes + run.stderr.totalBytes > run.storedBytes,
          output_redacted: false,
          duration_ms: Math.max(0, this.now() - startedAt),
          audit_id: auditId,
        },
      }
    } finally {
      fs.closeSync(directoryDescriptor)
    }
  }

  private persistAudit(
    sessionId: string,
    state: AutomaticWorkflowState,
    operation: ValidationOperation,
    execution: ValidationExecution,
    result: ValidationRunResult,
    runNumber: number,
  ): void {
    persistValidationAudit(
      sessionId,
      state,
      operation,
      execution,
      result,
      runNumber,
      this.env,
      this.now,
    )
  }
}
