import type { spawn } from 'node:child_process'

export type BoundedProcessChild = ReturnType<typeof spawn>

export interface BoundedProcessResult<Reason extends string> {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly process_error: Error | null
  readonly forced_reason: Reason | null
  readonly stdout_bytes: number
  readonly stderr_bytes: number
  readonly output_truncated: boolean
  readonly termination_uncertain: boolean
}

interface BoundedProcessOptions<Reason extends string> {
  readonly child: BoundedProcessChild
  readonly timeout_ms: number
  readonly termination_grace_ms: number
  readonly max_output_bytes: number
  readonly timeout_reason: Reason
  readonly cancellation_reason: Reason
  readonly output_limit_reason: Reason
  readonly terminate_process: (child: BoundedProcessChild) => Error | null
  readonly on_stdout: (chunk: Buffer) => void
  readonly on_stderr: (chunk: Buffer) => void
  readonly on_capture_incomplete?: () => void
  readonly capture_after_termination?: boolean
  readonly select_forced_reason?: (current: Reason | null, next: Reason) => Reason
}

interface ProcessCompletion {
  code: number | null
  signal: NodeJS.Signals | null
  process_error: Error | null
  termination_uncertain: boolean
}

export class BoundedProcessRunner<Reason extends string> {
  private readonly completion: Promise<ProcessCompletion>
  private finishCompletion: (completion: ProcessCompletion) => void = () => {}
  private completionSettled = false
  private terminationRequested = false
  private terminationWatchdog: NodeJS.Timeout | null = null
  private forcedReason: Reason | null = null
  private stdoutBytes = 0
  private stderrBytes = 0
  private outputLimitExceeded = false
  private started = false

  constructor(private readonly options: BoundedProcessOptions<Reason>) {
    this.completion = new Promise(resolve => { this.finishCompletion = resolve })
    this.observeCompletion()
    this.observeOutput()
  }

  terminate(reason: Reason | null): void {
    if (reason !== null) {
      this.forcedReason = this.options.select_forced_reason
        ? this.options.select_forced_reason(this.forcedReason, reason)
        : this.forcedReason ?? reason
    }
    if (this.completionSettled || this.terminationRequested) return
    this.terminationRequested = true
    if (this.options.terminate_process(this.options.child)) {
      this.completeUncertainTermination()
      return
    }
    this.terminationWatchdog = setTimeout(
      () => this.completeUncertainTermination(),
      this.options.termination_grace_ms,
    )
    this.terminationWatchdog.unref?.()
  }

  async run(signal: AbortSignal): Promise<BoundedProcessResult<Reason>> {
    if (this.started) throw new Error('bounded process runner cannot be started more than once')
    this.started = true
    const onAbort = () => this.terminate(this.options.cancellation_reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const timer = setTimeout(
      () => this.terminate(this.options.timeout_reason),
      this.options.timeout_ms,
    )
    timer.unref?.()
    try {
      const completion = await this.completion
      return Object.freeze({
        ...completion,
        forced_reason: this.forcedReason,
        stdout_bytes: this.stdoutBytes,
        stderr_bytes: this.stderrBytes,
        output_truncated: this.outputLimitExceeded || completion.termination_uncertain,
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private observeCompletion(): void {
    this.options.child.once('error', error => this.complete({
      code: null,
      signal: null,
      process_error: error,
      termination_uncertain: false,
    }))
    this.options.child.once('close', (code, signal) => this.complete({
      code,
      signal,
      process_error: null,
      termination_uncertain: false,
    }))
  }

  private observeOutput(): void {
    const capture = (stream: 'stdout' | 'stderr', chunk: unknown) => {
      if (this.terminationRequested && !this.options.capture_after_termination) return
      const bytes = Buffer.from(chunk as Uint8Array)
      if (stream === 'stdout') {
        this.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutBytes + bytes.length)
        this.options.on_stdout(bytes)
      } else {
        this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + bytes.length)
        this.options.on_stderr(bytes)
      }
      if (this.stdoutBytes + this.stderrBytes > this.options.max_output_bytes) {
        this.outputLimitExceeded = true
        this.terminate(this.options.output_limit_reason)
      }
    }
    this.options.child.stdout?.on('data', chunk => capture('stdout', chunk))
    this.options.child.stderr?.on('data', chunk => capture('stderr', chunk))
  }

  private complete(completion: ProcessCompletion): void {
    if (this.completionSettled) return
    this.completionSettled = true
    if (this.terminationWatchdog) clearTimeout(this.terminationWatchdog)
    this.finishCompletion(completion)
  }

  private completeUncertainTermination(): void {
    this.options.child.stdin?.destroy()
    this.options.child.stdout?.destroy()
    this.options.child.stderr?.destroy()
    this.options.on_capture_incomplete?.()
    this.options.child.unref()
    this.complete({
      code: null,
      signal: null,
      process_error: null,
      termination_uncertain: true,
    })
  }
}
