import { spawn } from 'node:child_process'

import { descriptorPath } from './bounded-file-transport.ts'
import {
  appendOutput,
  capturedOutput,
  type CapturedOutput,
} from './validation-output.ts'
import type { ValidationOperation } from './validation-types.ts'

interface ProcessCompletion {
  code: number | null
  processSignal: NodeJS.Signals | null
  error?: Error
  fatal?: boolean
}

export interface ProcessRun {
  completion: ProcessCompletion
  forcedStatus: 'timed_out' | 'cancelled' | null
  stderr: CapturedOutput
  stdout: CapturedOutput
  storedBytes: number
}

export function killValidationProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): Error | null {
  if (!child.pid) return new Error('validation process has no PID to terminate')
  let groupError: unknown = null
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null
      groupError = error
    }
  }
  try {
    if (child.kill('SIGKILL')) return null
    throw new Error('direct child termination returned false')
  } catch (error) {
    return groupError
      ? new AggregateError([groupError, error], 'validation process-group and direct-child termination failed')
      : (error instanceof Error ? error : new Error(String(error)))
  }
}

export async function runValidationProcess(
  executable: string,
  operation: ValidationOperation,
  directoryDescriptor: number,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  signal: AbortSignal,
  terminateProcess: typeof killValidationProcess,
): Promise<ProcessRun> {
  const stdout = capturedOutput()
  const stderr = capturedOutput()
  let storedBytes = 0
  let forcedStatus: ProcessRun['forcedStatus'] = null
  const child = spawn(executable, operation.argv.slice(1), {
    cwd: descriptorPath(directoryDescriptor),
    detached: true,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk: Buffer | string) => {
    storedBytes += appendOutput(stdout, Buffer.from(chunk), operation.max_output_bytes - storedBytes)
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    storedBytes += appendOutput(stderr, Buffer.from(chunk), operation.max_output_bytes - storedBytes)
  })

  let finishCompletion: (value: ProcessCompletion) => void = () => {}
  const completion = new Promise<ProcessCompletion>((resolve) => {
    let settled = false
    finishCompletion = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('error', (error) => finishCompletion({ code: null, processSignal: null, error }))
    child.once('close', (code, processSignal) => finishCompletion({ code, processSignal }))
  })
  const terminate = (status: 'timed_out' | 'cancelled') => {
    if (!forcedStatus) forcedStatus = status
    const error = terminateProcess(child, platform)
    if (!error) return
    child.stdout.destroy()
    child.stderr.destroy()
    child.unref()
    finishCompletion({ code: null, processSignal: null, error, fatal: true })
  }
  const onAbort = () => terminate('cancelled')
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(() => terminate('timed_out'), operation.timeout_ms)
  timer.unref?.()

  const completed = await completion
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
  if (completed.fatal) throw completed.error
  if (completed.error) {
    const message = Buffer.from(completed.error.message, 'utf8')
    storedBytes += appendOutput(stderr, message, operation.max_output_bytes - storedBytes)
  }
  return { completion: completed, forcedStatus, stderr, stdout, storedBytes }
}
