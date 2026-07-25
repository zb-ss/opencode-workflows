import { randomUUID } from 'node:crypto'

import {
  assertFencingGeneration,
  type FencingLeaseHandle,
  type FencingLeaseRecord,
} from './fencing-lease.ts'
import {
  type QueueIndexEntry,
  type QueueLaunchIntent,
  type QueueLaunchState,
  type QueueWorkflowRecord,
} from './queue-contracts.ts'
import type { EnabledQueueConfig } from './queue-policy.ts'
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
  onWorkflowReady?: (workflowId: string) => void
  interval?: (callback: () => void, delayMs: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface QueueSchedulerHandle {
  generation: number
  renew(): void
  dispose(): void
  recover(): Promise<void>
}

const AMBIGUOUS_LAUNCH_STATES: ReadonlySet<QueueLaunchState> = new Set(['reserved', 'created', 'prompted'])
const TERMINAL_LAUNCH_STATES: ReadonlySet<QueueLaunchState> = new Set(['settled', 'ambiguous'])

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
  private readonly onWorkflowReady?: (workflowId: string) => void
  private readonly intervalFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearIntervalFn: (handle: unknown) => void
  private leaseHandle: FencingLeaseHandle | null = null
  private leaseRecord: FencingLeaseRecord | null = null
  private renewalTimer: unknown | null = null
  private disposed = false

  constructor(options: QueueSchedulerOptions) {
    this.store = options.store
    this.config = assertConfig(options.config)
    this.now = options.now
    this.onWorkflowReady = options.onWorkflowReady
    this.intervalFn = options.interval ?? defaultInterval
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval
  }

  start(): QueueSchedulerHandle {
    if (this.disposed) throw new QueueSchedulerError('disposed', 'scheduler has been disposed')
    if (this.leaseHandle !== null) {
      if (this.leaseHandle.is_valid()) {
        this.schedule()
        return this.handleFromCurrentLease()
      }
      this.handleLeaseLoss()
    }
    const leaseStore = this.store.getLeaseStore()
    this.leaseHandle = leaseStore.acquire()
    this.leaseRecord = this.leaseHandle.lease
    this.startRenewalTimer()
    this.schedule()
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
    const self = this
    return {
      generation,
      renew(): void { self.renew() },
      dispose(): void { self.dispose() },
      async recover(): Promise<void> { await self.recover() },
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

  async recover(): Promise<void> {
    if (this.disposed) throw new QueueSchedulerError('disposed', 'scheduler has been disposed')
    if (this.leaseHandle === null || this.leaseRecord === null) {
      throw new QueueSchedulerError('no_lease', 'recovery requires an active lease')
    }
    const generation = this.leaseRecord.fencing_generation
    assertFencingGeneration(this.store.getLeaseStore(), generation)
    const index = this.store.rebuildIndex()
    for (const entry of index) {
      if (entry.fencing_generation > generation) {
        throw new QueueSchedulerError('stale_generation', `recovery saw a newer generation ${entry.fencing_generation}`)
      }
    }
    for (const entry of index) {
      const record = this.store.load(entry.workflow_id)
      if (record === null) continue
      if (record.launch_intent === null) continue
      if (record.launch_intent.fencing_generation > generation) {
        throw new QueueSchedulerError('stale_generation', `launch intent carries a newer generation ${record.launch_intent.fencing_generation}`)
      }
      if (TERMINAL_LAUNCH_STATES.has(record.launch_intent.launch_state)) continue
      const isAmbiguous = AMBIGUOUS_LAUNCH_STATES.has(record.launch_intent.launch_state)
      if (isAmbiguous) {
        this.reconcileRecovery(record, generation, (next) => {
          next.status = 'paused'
          next.pause_reason = 'ambiguous launch intent during recovery'
          if (next.launch_intent !== null) {
            next.launch_intent = { ...next.launch_intent, launch_state: 'ambiguous' }
          }
          return next
        })
      } else {
        this.reconcileRecovery(record, generation, (next) => {
          next.status = 'queued'
          next.launch_intent = null
          return next
        })
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopRenewalTimer()
    if (this.leaseHandle !== null) {
      this.returnLeasedToQueued()
      this.leaseHandle.release()
      this.leaseHandle = null
      this.leaseRecord = null
    }
  }

  private schedule(): void {
    if (this.disposed || this.leaseHandle === null || this.leaseRecord === null) return
    if (!this.leaseHandle.is_valid()) {
      this.handleLeaseLoss()
      return
    }
    const generation = this.leaseRecord.fencing_generation
    try {
      assertFencingGeneration(this.store.getLeaseStore(), generation)
    } catch {
      this.handleLeaseLoss()
      return
    }
    const index = this.store.rebuildIndex()
    const runningCount = this.countRunning(index)
    const maxConcurrent = this.config.max_concurrent_workflows
    if (runningCount >= maxConcurrent) return
    const queued = index.filter(entry => entry.status === 'queued')
    let slots = maxConcurrent - runningCount
    for (const entry of queued) {
      if (slots <= 0) break
      if (this.admitWorkflow(entry, generation)) slots -= 1
    }
  }

  private countRunning(index: QueueIndexEntry[]): number {
    let count = 0
    for (const entry of index) if (entry.status === 'running') count += 1
    return count
  }

  private admitWorkflow(entry: QueueIndexEntry, generation: number): boolean {
    const record = this.store.load(entry.workflow_id)
    if (record === null) return false
    if (record.status !== 'queued') return false
    if (record.launch_intent !== null) return false
    try {
      assertFencingGeneration(this.store.getLeaseStore(), generation)
    } catch {
      this.handleLeaseLoss()
      return false
    }
    const reservedIntent = this.createReservedIntent(record, generation)
    try {
      const updated = this.store.update(record.workflow_id, record.state_revision, record.fencing_generation, (next) => {
        next.status = 'leased'
        next.launch_intent = reservedIntent
        return next
      })
      if (updated.status !== 'leased' || updated.launch_intent === null) return false
      this.onWorkflowReady?.(record.workflow_id)
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
      agent: record.mode,
      model: record.definition_id,
      launch_state: 'reserved',
      reserved_at: nowIso,
      created_at: null,
      prompted_at: null,
      settled_at: null,
    }
  }

  private reconcileRecovery(
    record: QueueWorkflowRecord,
    generation: number,
    mutate: (record: QueueWorkflowRecord) => QueueWorkflowRecord,
  ): void {
    try {
      assertFencingGeneration(this.store.getLeaseStore(), generation)
    } catch {
      throw new QueueSchedulerError('stale_generation', `recovery lost authority during reconciliation of ${record.workflow_id}`)
    }
    try {
      this.store.reconcile(record.workflow_id, record.state_revision, generation, mutate)
    } catch {
      // Best effort during recovery — a failed reconciliation leaves the record untouched.
    }
  }

  private returnLeasedToQueued(): void {
    const index = this.store.rebuildIndex()
    for (const entry of index) {
      if (entry.status !== 'leased') continue
      const record = this.store.load(entry.workflow_id)
      if (record === null) continue
      try {
        this.store.update(record.workflow_id, record.state_revision, record.fencing_generation, (next) => {
          next.status = 'queued'
          next.launch_intent = null
          return next
        })
      } catch {
        // Best effort during lease loss or disposal.
      }
    }
  }

  private handleLeaseLoss(): void {
    this.stopRenewalTimer()
    if (this.leaseHandle === null || this.leaseRecord === null) return
    this.returnLeasedToQueued()
    this.leaseHandle = null
    this.leaseRecord = null
  }

  private startRenewalTimer(): void {
    if (this.leaseRecord === null) return
    this.renewalTimer = this.intervalFn(() => this.renew(), this.config.renewal_interval_ms)
  }

  private stopRenewalTimer(): void {
    if (this.renewalTimer !== null) {
      this.clearIntervalFn(this.renewalTimer)
      this.renewalTimer = null
    }
  }
}