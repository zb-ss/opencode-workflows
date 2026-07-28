import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  type FencingLeaseHandle,
  type FencingLeaseRecord,
} from './fencing-lease.ts'
import {
  type QueueIndexEntry,
  type QueueLaunchIntent,
  type QueueLaunchState,
  type QueueWorkflowRecord,
  type QueueWorkflowStatus,
} from './queue-contracts.ts'
import type { EnabledQueueConfig } from './queue-policy.ts'
import { QueueRateLimiter } from './queue-rate-limiter.ts'
import type { QueueStore } from './queue-store.ts'

export class QueueSchedulerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueSchedulerError'
    this.code = code
  }
}

export interface QueueSchedulerOptions {
  store: QueueStore
  config: EnabledQueueConfig
  now: () => number
  onWorkflowReady?: (workflowId: string, leaseHandle: FencingLeaseHandle) => void
  onLeaseLost?: () => void
  interval?: (callback: () => void, delayMs: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface QueueSchedulerHandle {
  generation: number
  lease: FencingLeaseHandle
  renew(): void
  dispose(): void
  recover(): Promise<QueueRecoveryResult>
  schedule(): void
}

export interface QueueRecoveryResult {
  recovered: boolean
  reconciled: number
  failed: number
  failures: Array<{ workflow_id: string; error: string }>
}

const AMBIGUOUS_LAUNCH_STATES: ReadonlySet<QueueLaunchState> = new Set(['reserved', 'created', 'prompted'])
const TERMINAL_LAUNCH_STATES: ReadonlySet<QueueLaunchState> = new Set(['settled', 'ambiguous'])
const CAPACITY_CONSUMING_STATUSES: ReadonlySet<QueueWorkflowStatus> = new Set(['leased', 'recovering', 'running'])

function assertConfig(config: EnabledQueueConfig): Required<Pick<EnabledQueueConfig, 'max_concurrent_workflows' | 'lease_duration_ms' | 'renewal_interval_ms' | 'recovery_attempt_limit'>> {
  if (config.max_concurrent_workflows === undefined) {
    throw new QueueSchedulerError('config_incomplete', 'max_concurrent_workflows is required')
  }
  if (config.lease_duration_ms === undefined) {
    throw new QueueSchedulerError('config_incomplete', 'lease_duration_ms is required')
  }
  if (config.renewal_interval_ms === undefined) {
    throw new QueueSchedulerError('config_incomplete', 'renewal_interval_ms is required')
  }
  if (config.recovery_attempt_limit === undefined) {
    throw new QueueSchedulerError('config_incomplete', 'recovery_attempt_limit is required')
  }
  if (config.renewal_interval_ms >= config.lease_duration_ms) {
    throw new QueueSchedulerError('config_invalid', 'renewal_interval_ms must be less than lease_duration_ms')
  }
  return config as Required<Pick<EnabledQueueConfig, 'max_concurrent_workflows' | 'lease_duration_ms' | 'renewal_interval_ms' | 'recovery_attempt_limit'>>
}

function defaultInterval(callback: () => void, delayMs: number): unknown {
  return setInterval(callback, delayMs)
}

function defaultClearInterval(handle: unknown): void {
  if (handle !== null && handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>)
}

export class QueueScheduler {
  private readonly store: QueueStore
  private readonly config: Required<Pick<EnabledQueueConfig, 'max_concurrent_workflows' | 'lease_duration_ms' | 'renewal_interval_ms' | 'recovery_attempt_limit'>>
  private readonly now: () => number
  private readonly onWorkflowReady?: (workflowId: string, leaseHandle: FencingLeaseHandle) => void
  private readonly onLeaseLost?: () => void
  private readonly intervalFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearIntervalFn: (handle: unknown) => void
  private readonly rateLimiter: QueueRateLimiter | null
  private leaseHandle: FencingLeaseHandle | null = null
  private leaseRecord: FencingLeaseRecord | null = null
  private renewalTimer: unknown | null = null
  private disposed = false

  constructor(options: QueueSchedulerOptions) {
    this.store = options.store
    this.config = assertConfig(options.config)
    this.now = options.now
    this.onWorkflowReady = options.onWorkflowReady
    this.onLeaseLost = options.onLeaseLost
    this.intervalFn = options.interval ?? defaultInterval
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval
    this.rateLimiter = options.config.rate_windows && options.config.rate_windows.length > 0
      ? new QueueRateLimiter({
          rate_directory: path.join(options.store.getConfigDirectory(), 'rate'),
          windows: options.config.rate_windows,
          now: this.now,
        })
      : null
  }

  start(options?: { schedule?: boolean }): QueueSchedulerHandle {
    const shouldSchedule = options?.schedule ?? true
    if (this.disposed) throw new QueueSchedulerError('disposed', 'scheduler has been disposed')
    if (this.leaseHandle !== null) {
      if (this.leaseHandle.is_valid()) {
        if (shouldSchedule) this.schedule()
        return this.handleFromCurrentLease()
      }
      this.handleLeaseLoss()
    }
    const leaseStore = this.store.getLeaseStore()
    this.leaseHandle = leaseStore.acquire()
    this.leaseRecord = this.leaseHandle.lease
    this.startRenewalTimer()
    if (shouldSchedule) this.schedule()
    return this.handleFromCurrentLease()
  }

  get currentGeneration(): number | null {
    return this.leaseRecord?.fencing_generation ?? null
  }

  get hasLease(): boolean {
    return this.leaseHandle !== null && this.leaseHandle.is_valid()
  }

  private handleFromCurrentLease(): QueueSchedulerHandle {
    const generation = this.leaseRecord!.fencing_generation
    const leaseHandle = this.leaseHandle!
    const self = this
    return {
      generation,
      lease: leaseHandle,
      renew(): void { self.renew() },
      dispose(): void { self.dispose() },
      async recover(): Promise<QueueRecoveryResult> { return await self.recover() },
      schedule(): void { self.schedule() },
    }
  }

  renew(): void {
    if (this.disposed || this.leaseHandle === null) return
    try {
      this.leaseRecord = this.leaseHandle.renew()
    } catch {
      this.handleLeaseLoss()
    }
  }

  async recover(): Promise<QueueRecoveryResult> {
    if (this.disposed) throw new QueueSchedulerError('disposed', 'scheduler has been disposed')
    if (this.leaseHandle === null || this.leaseRecord === null) {
      throw new QueueSchedulerError('no_lease', 'recovery requires an active lease')
    }
    const leaseHandle = this.leaseHandle
    const generation = this.leaseRecord.fencing_generation
    const index = this.store.rebuildIndex()
    for (const entry of index) {
      if (entry.fencing_generation > generation) {
        throw new QueueSchedulerError('stale_generation', `recovery saw a newer generation ${entry.fencing_generation}`)
      }
    }
    const failures: Array<{ workflow_id: string; error: string }> = []
    let reconciled = 0
    for (const entry of index) {
      const record = this.store.load(entry.workflow_id)
      if (record === null) continue
      if (record.launch_intent === null) {
        // Re-stamp records without launch intent under the new generation.
        try {
          this.store.reconcile(record.workflow_id, record.state_revision, leaseHandle, (next) => {
            next.fencing_generation = generation
            return next
          })
          reconciled += 1
        } catch (error) {
          failures.push({ workflow_id: record.workflow_id, error: (error as Error).message })
        }
        continue
      }
      if (record.launch_intent.fencing_generation > generation) {
        throw new QueueSchedulerError('stale_generation', `launch intent carries a newer generation ${record.launch_intent.fencing_generation}`)
      }
      const launchState = record.launch_intent.launch_state
      try {
        switch (launchState) {
          case 'settled': {
            // Terminal: the engine completed. Re-stamp the generation and
            // let settlement finalize the outer status.
            this.store.reconcile(record.workflow_id, record.state_revision, leaseHandle, (next) => {
              next.fencing_generation = generation
              return next
            })
            reconciled += 1
            break
          }
          case 'ambiguous': {
            // Terminal: the launch was ambiguous. Re-stamp and preserve
            // the paused status for attended resolution.
            this.store.reconcile(record.workflow_id, record.state_revision, leaseHandle, (next) => {
              next.fencing_generation = generation
              return next
            })
            reconciled += 1
            break
          }
          case 'reserved': {
            // Ambiguous: a reservation was made but no child session was
            // created. We cannot prove whether the launch occurred.
            this.store.reconcile(record.workflow_id, record.state_revision, leaseHandle, (next) => {
              next.status = 'paused'
              next.pause_reason = 'ambiguous launch intent during recovery'
              if (next.launch_intent !== null) {
                next.launch_intent = { ...next.launch_intent, launch_state: 'ambiguous' }
              }
              return next
            })
            reconciled += 1
            break
          }
          case 'created':
          case 'prompted': {
            // Ambiguous: a child session may have been created. We cannot
            // prove whether the engine launched or produced side effects.
            this.store.reconcile(record.workflow_id, record.state_revision, leaseHandle, (next) => {
              next.status = 'paused'
              next.pause_reason = 'ambiguous launch intent during recovery'
              if (next.launch_intent !== null) {
                next.launch_intent = { ...next.launch_intent, launch_state: 'ambiguous' }
              }
              return next
            })
            reconciled += 1
            break
          }
          default: {
            // Exhaustive: any future launch state must be handled explicitly.
            failures.push({ workflow_id: record.workflow_id, error: `unhandled launch state: ${launchState}` })
          }
        }
      } catch (error) {
        failures.push({ workflow_id: record.workflow_id, error: (error as Error).message })
      }
    }
    return {
      recovered: failures.length === 0,
      reconciled,
      failed: failures.length,
      failures,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopRenewalTimer()
    if (this.leaseHandle !== null) {
      this.preserveLaunchIntents()
      this.leaseHandle.release()
      this.leaseHandle = null
      this.leaseRecord = null
    }
  }

  schedule(): void {
    if (this.disposed || this.leaseHandle === null || this.leaseRecord === null) return
    if (!this.leaseHandle.is_valid()) {
      this.handleLeaseLoss()
      return
    }
    const leaseHandle = this.leaseHandle
    const generation = this.leaseRecord.fencing_generation
    let index: QueueIndexEntry[]
    try {
      index = this.store.rebuildIndex()
    } catch {
      // A corrupt index is fail-closed: stop scheduling until attended repair.
      this.handleLeaseLoss()
      return
    }
    const activeCount = this.countActive(index)
    const maxConcurrent = this.config.max_concurrent_workflows
    if (activeCount >= maxConcurrent) return
    const queued = index.filter(entry => entry.status === 'queued')
    let slots = maxConcurrent - activeCount
    for (const entry of queued) {
      if (slots <= 0) break
      if (this.admitWorkflow(entry, generation, leaseHandle)) slots -= 1
    }
  }

  private countActive(index: QueueIndexEntry[]): number {
    let count = 0
    for (const entry of index) {
      if (CAPACITY_CONSUMING_STATUSES.has(entry.status)) count += 1
    }
    return count
  }

  private admitWorkflow(entry: QueueIndexEntry, generation: number, leaseHandle: FencingLeaseHandle): boolean {
    const record = this.store.load(entry.workflow_id)
    if (record === null) return false
    if (record.status !== 'queued') return false
    if (record.launch_intent !== null) return false
    if (record.retry_not_before !== null && this.now() < Date.parse(record.retry_not_before)) return false
    if (!this.leaseHandle?.is_valid()) {
      this.handleLeaseLoss()
      return false
    }
    if (this.rateLimiter !== null && !this.rateLimiter.tryAcquire()) {
      return false
    }
    const reservedIntent = this.createReservedIntent(record, generation)
    try {
      const updated = this.store.update(record.workflow_id, record.state_revision, leaseHandle, (next) => {
        next.status = 'leased'
        next.launch_intent = reservedIntent
        return next
      })
      if (updated.status !== 'leased' || updated.launch_intent === null) return false
      this.onWorkflowReady?.(record.workflow_id, leaseHandle)
      return true
    } catch {
      return false
    }
  }

  private createReservedIntent(record: QueueWorkflowRecord, generation: number): QueueLaunchIntent {
    const nowIso = new Date(this.now()).toISOString()
    return {
      intent_id: `intent-${randomUUID()}`,
      workflow_id: record.workflow_id,
      fencing_generation: generation,
      session_id: null,
      child_session_ids: [],
      engine_instance_id: null,
      agent: record.mode,
      model: record.definition_id,
      launch_state: 'reserved',
      reserved_at: nowIso,
      created_at: null,
      prompted_at: null,
      settled_at: null,
    }
  }

  private preserveLaunchIntents(): void {
    if (this.leaseHandle === null) return
    const leaseHandle = this.leaseHandle
    let index: QueueIndexEntry[]
    try {
      index = this.store.rebuildIndex()
    } catch {
      return
    }
    for (const entry of index) {
      if (entry.status !== 'leased') continue
      const record = this.store.load(entry.workflow_id)
      if (record === null) continue
      if (record.launch_intent === null) continue
      // During lease loss or disposal, we cannot prove whether a child
      // session was created. All non-terminal launch intents are
      // ambiguous and must be preserved as paused.
      if (!TERMINAL_LAUNCH_STATES.has(record.launch_intent.launch_state)) {
        try {
          this.store.update(record.workflow_id, record.state_revision, leaseHandle, (next) => {
            next.status = 'paused'
            next.pause_reason = 'ambiguous launch intent preserved during lease loss'
            if (next.launch_intent !== null) {
              next.launch_intent = { ...next.launch_intent, launch_state: 'ambiguous' }
            }
            return next
          })
        } catch {
          // Best effort during lease loss.
        }
      }
    }
  }

  private handleLeaseLoss(): void {
    this.stopRenewalTimer()
    if (this.leaseHandle === null || this.leaseRecord === null) return
    this.preserveLaunchIntents()
    this.leaseHandle = null
    this.leaseRecord = null
    // Notify the owner that lease authority was lost so it can cancel any
    // running engines that were dispatched under the expired lease.
    this.onLeaseLost?.()
  }

  private startRenewalTimer(): void {
    if (this.leaseRecord === null) return
    this.renewalTimer = this.intervalFn(() => {
      this.renew()
      this.schedule()
    }, this.config.renewal_interval_ms)
  }

  private stopRenewalTimer(): void {
    if (this.renewalTimer !== null) {
      this.clearIntervalFn(this.renewalTimer)
      this.renewalTimer = null
    }
  }
}
