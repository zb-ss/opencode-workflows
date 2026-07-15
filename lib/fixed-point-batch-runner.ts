import type {
  AwaitBatchResult,
  CancelTaskResult,
  CollectBatchResult,
  SpawnBatchInput,
  SpawnBatchResult,
} from './swarm-runtime.ts'
import type { SwarmTask } from './types.ts'

export interface FixedPointRuntime {
  spawnBatch(input: SpawnBatchInput): SpawnBatchResult
  awaitBatch(callerSessionId: string, batchId: string, timeoutMs?: number, signal?: AbortSignal): Promise<AwaitBatchResult>
  collectResults(
    callerSessionId: string,
    batchId: string,
    maximumResultBytes?: number,
    signal?: AbortSignal,
  ): Promise<CollectBatchResult>
  cancelTask(callerSessionId: string, batchId: string, taskId: string, timeoutMs?: number): Promise<CancelTaskResult>
}

export interface FixedPointBatchContext {
  callerSessionId: string
  directory: string
  signal?: AbortSignal
  workflowContext?: string
}

export class FixedPointBatchRunner {
  constructor(private readonly runtime: FixedPointRuntime) {}

  async run(
    context: FixedPointBatchContext,
    batchId: string,
    tasks: SwarmTask[],
    timeoutMs: number,
    maximumResultBytes: number,
  ): Promise<Record<string, string>> {
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('The operation was aborted')
    this.runtime.spawnBatch({
      batchId,
      callerSessionId: context.callerSessionId,
      directory: context.directory,
      tasks,
      workflowContext: context.workflowContext,
    })
    const deadline = new AbortController()
    let timedOut = false
    const onInputAbort = () => deadline.abort(context.signal?.reason)
    context.signal?.addEventListener('abort', onInputAbort, { once: true })
    if (context.signal?.aborted) onInputAbort()
    const timer = setTimeout(() => {
      timedOut = true
      deadline.abort(new Error(`fixed-point batch timed out: ${batchId}`))
    }, timeoutMs)
    timer.unref?.()
    try {
      const completion = await this.runtime.awaitBatch(
        context.callerSessionId,
        batchId,
        timeoutMs,
        deadline.signal,
      )
      if (!completion.completed) throw new Error(`fixed-point batch timed out: ${batchId}`)
      const failed = Object.entries(completion.results ?? {}).filter(([, status]) => status !== 'completed')
      if (failed.length > 0) {
        throw new Error(`fixed-point batch has failed tasks: ${failed.map(([id, status]) => `${id}=${status}`).join(', ')}`)
      }
      return (await this.runtime.collectResults(
        context.callerSessionId,
        batchId,
        maximumResultBytes,
        deadline.signal,
      )).results
    } catch (error) {
      try {
        await this.cancel(context.callerSessionId, batchId, tasks, timeoutMs)
      } catch (cancellationError) {
        const cancellationMessage = cancellationError instanceof Error ? cancellationError.message : String(cancellationError)
        throw new AggregateError(
          [error, cancellationError],
          `fixed-point batch failed and one or more child sessions remain non-terminal: ${batchId}; ${cancellationMessage}`,
        )
      }
      if (timedOut) throw new Error(`fixed-point batch timed out: ${batchId}`)
      throw error
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onInputAbort)
    }
  }

  private async cancel(
    callerSessionId: string,
    batchId: string,
    tasks: SwarmTask[],
    timeoutMs: number,
  ): Promise<void> {
    const outcomes = await Promise.allSettled(tasks.map((task) => (
      this.runtime.cancelTask(callerSessionId, batchId, task.id, timeoutMs)
    )))
    const failures = outcomes.flatMap((outcome, index) => {
      if (outcome.status === 'rejected') return [`${tasks[index].id}: ${String(outcome.reason)}`]
      return outcome.value.terminal ? [] : [`${tasks[index].id}: ${outcome.value.error ?? 'cancellation failed'}`]
    })
    if (failures.length > 0) throw new Error(`non-terminal fixed-point tasks: ${failures.join('; ')}`)
  }
}
