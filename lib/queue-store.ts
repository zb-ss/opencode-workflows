import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  FencingLeaseStore,
  FencingLeaseHandle,
  withLock,
} from './fencing-lease.ts'
import {
  QUEUE_SCHEMA_VERSION,
  QueueWorkflowRecordSchema,
  parseQueueWorkflowRecord,
  isValidTransition,
  type QueueWorkflowRecord,
  type QueueWorkflowStatus,
  type QueueIndexEntry,
} from './queue-contracts.ts'
import { emptyAutomationUsageTelemetry } from './epic-budget-usage.ts'
import { sha256Hex } from './canonical-json.ts'
import type { EnabledQueueConfig, QueueBudget } from './queue-policy.ts'
import { isFailureRetryable, transportBackoffDelayMs } from './automation-retry-policy.ts'
import type { FailureClass, RetryAttemptCounters } from './automation-policy-contracts.ts'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const O_EXCL = fs.constants?.O_EXCL ?? 0x40
const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x20000

export class QueueStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'QueueStoreError'
    this.code = code
  }
}

export interface QueueStoreOptions {
  config_directory: string
  owner: string
  now: () => number
  lease_duration_ms?: number
  max_workflows?: number
  budgets?: QueueBudget[]
  retry_policy?: EnabledQueueConfig['retry_policy']
  recovery_attempt_limit?: number
}

export interface QueueWorkflowInput {
  workflow_id: string
  definition_id: string
  root_session_id: string
  directory: string
  worktree: string
  mode: string
  task: string
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | O_NOFOLLOW)
    fs.fsyncSync(fd)
  } catch {
    // Best-effort directory fsync.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

function validateDirectory(directory: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(directory)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new QueueStoreError('unsafe_path', `queue directory component is a symlink: ${directory}`)
  }
  if (!stat.isDirectory()) {
    throw new QueueStoreError('unsafe_path', `queue path is not a directory: ${directory}`)
  }
}

function safeWorkflowFileName(workflowId: string): string {
  // SafeIdentifierSchema guarantees this, but we also reject any path separators.
  if (workflowId.includes('/') || workflowId.includes('\\') || workflowId.includes('\0')) {
    throw new QueueStoreError('unsafe_workflow_id', `workflow ID contains path separators: ${workflowId}`)
  }
  return `${workflowId}.json`
}

function assertAuthority(leaseStore: FencingLeaseStore, handle: FencingLeaseHandle): void {
  leaseStore.assertAuthority(handle.lease.fencing_generation, handle.lease.lease_id)
}

function incrementRetryCounters(counters: RetryAttemptCounters, failure: FailureClass): RetryAttemptCounters {
  if (failure === 'semantic') return { ...counters, semantic_attempts: counters.semantic_attempts + 1 }
  if (failure === 'contract') return { ...counters, contract_attempts: counters.contract_attempts + 1 }
  if (failure === 'transport') return { ...counters, transport_attempts: counters.transport_attempts + 1 }
  return counters
}

function transportRetryNotBefore(policy: NonNullable<QueueStoreOptions['retry_policy']>, now: number, retryIndex: number): string {
  const delay = transportBackoffDelayMs(policy, retryIndex)
  return new Date(now + delay).toISOString()
}

interface RetryDecision {
  requeue: boolean
  reason: string | null
  updatedCounters: RetryAttemptCounters
  retryNotBefore: string | null
}

function evaluateRetryDecision(
  record: QueueWorkflowRecord,
  config: Pick<QueueStoreOptions, 'retry_policy' | 'recovery_attempt_limit'>,
  now: number,
): RetryDecision {
  const baseCounters: RetryAttemptCounters = record.retry_counters ?? { semantic_attempts: 0, contract_attempts: 0, transport_attempts: 0, consecutive_no_progress_attempts: 0 }

  // Non-failed/paused records (e.g. queued by owner resume) requeue without
  // incrementing counters.
  if (record.status !== 'failed' && record.status !== 'paused') {
    return { requeue: true, reason: null, updatedCounters: baseCounters, retryNotBefore: null }
  }

  // Recovery attempt ceiling.
  if ((record.recovery_attempt_count ?? 0) >= (config.recovery_attempt_limit ?? Number.MAX_SAFE_INTEGER)) {
    return { requeue: false, reason: 'recovery attempt limit exceeded', updatedCounters: baseCounters, retryNotBefore: null }
  }

  // No failure classification (e.g. owner-initiated resume from pause).
  if (record.failure_classification === null) {
    return { requeue: true, reason: null, updatedCounters: baseCounters, retryNotBefore: null }
  }

  // Ambiguous and cancelled failures are never retried.
  if (record.failure_classification === 'ambiguous_launch' || record.failure_classification === 'cancelled') {
    return { requeue: false, reason: `failure classification ${record.failure_classification} is not retryable`, updatedCounters: baseCounters, retryNotBefore: null }
  }

  // Increment the matching counter exactly once for this failure.
  const failure = record.failure_classification
  const updatedCounters = incrementRetryCounters(baseCounters, failure)

  // Check retry policy ceiling using the incremented counters.
  if (config.retry_policy && !isFailureRetryable(failure, updatedCounters, config.retry_policy)) {
    return { requeue: false, reason: 'retry policy ceiling reached', updatedCounters, retryNotBefore: null }
  }

  // Calculate transport backoff from the incremented transport attempt index.
  let retryNotBefore: string | null = null
  if (failure === 'transport' && config.retry_policy) {
    const transportAttempts = updatedCounters.transport_attempts
    retryNotBefore = transportRetryNotBefore(config.retry_policy, now, Math.max(0, transportAttempts - 1))
  }

  return { requeue: true, reason: null, updatedCounters, retryNotBefore }
}

export class QueueStore {
  private readonly directory: string
  private readonly workflowsDir: string
  private readonly leaseStore: FencingLeaseStore
  private readonly now: () => number
  private readonly owner: string
  private readonly maxWorkflows: number
  private readonly budgets: QueueBudget[]
  private readonly retryPolicy: EnabledQueueConfig['retry_policy'] | undefined
  private readonly recoveryAttemptLimit: number

  constructor(options: QueueStoreOptions) {
    this.directory = path.resolve(options.config_directory)
    this.workflowsDir = path.join(this.directory, 'workflows')
    this.owner = options.owner
    this.now = options.now
    this.maxWorkflows = options.max_workflows ?? 256
    this.budgets = options.budgets ?? []
    this.retryPolicy = options.retry_policy
    this.recoveryAttemptLimit = options.recovery_attempt_limit ?? Number.MAX_SAFE_INTEGER
    validateDirectory(this.directory)
    fs.mkdirSync(this.workflowsDir, { recursive: true, mode: DIR_MODE })
    validateDirectory(this.workflowsDir)
    this.leaseStore = new FencingLeaseStore({
      lease_directory: path.join(this.directory, 'lease'),
      lock_directory: this.directory,
      owner: this.owner,
      lease_duration_ms: options.lease_duration_ms ?? 60_000,
      now: this.now,
    })
  }

  enqueue(input: QueueWorkflowInput, leaseHandle: FencingLeaseHandle): QueueWorkflowRecord {
    return withLock(this.directory, () => {
      assertAuthority(this.leaseStore, leaseHandle)
      const index = this.rebuildIndexLocked()
      if (index.length >= this.maxWorkflows) {
        throw new QueueStoreError('queue_full', `queue is at capacity (${this.maxWorkflows} workflows)`)
      }
      this.assertSessionsBudgetsLocked(index, input.definition_id)
      const nowIso = new Date(this.now()).toISOString()
      const record: QueueWorkflowRecord = {
        schema_version: QUEUE_SCHEMA_VERSION,
        workflow_id: input.workflow_id,
        definition_id: input.definition_id,
        root_session_id: input.root_session_id,
        directory: input.directory,
        worktree: input.worktree,
        mode: input.mode,
        task: input.task,
        status: 'queued',
        pause_reason: null,
        fencing_generation: leaseHandle.lease.fencing_generation,
        state_revision: 1,
        launch_intent: null,
        failure_classification: null,
        retry_counters: null,
        retry_not_before: null,
        recovery_attempt_count: 0,
        created_at: nowIso,
        updated_at: nowIso,
        usage: emptyAutomationUsageTelemetry(),
      }
      const parsed = QueueWorkflowRecordSchema.parse(record)
      this.writeWorkflowRecord(parsed)
      return parsed
    })
  }

  load(workflowId: string): QueueWorkflowRecord | null {
    const filePath = this.workflowPath(workflowId)
    if (!fs.existsSync(filePath)) return null
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      return parseQueueWorkflowRecord(parsed)
    } catch (error) {
      if (error instanceof QueueStoreError) throw error
      throw new QueueStoreError('record_corrupt', `workflow ${workflowId} has a corrupt or unreadable record: ${(error as Error).message}`)
    }
  }

  update(
    workflowId: string,
    expectedRevision: number,
    leaseHandle: FencingLeaseHandle,
    mutate: (record: QueueWorkflowRecord) => QueueWorkflowRecord,
  ): QueueWorkflowRecord {
    return withLock(this.directory, () => {
      assertAuthority(this.leaseStore, leaseHandle)
      const current = this.loadLocked(workflowId)
      if (!current) throw new QueueStoreError('missing', `workflow ${workflowId} not found`)
      if (current.state_revision !== expectedRevision) {
        throw new QueueStoreError('stale_revision', `expected revision ${expectedRevision}, found ${current.state_revision}`)
      }
      const next = mutate(structuredClone(current))
      if (!isValidTransition(current.status, next.status)) {
        throw new QueueStoreError('invalid_transition', `transition from '${current.status}' to '${next.status}' is not permitted`)
      }
      next.state_revision = current.state_revision + 1
      next.updated_at = new Date(this.now()).toISOString()
      next.fencing_generation = leaseHandle.lease.fencing_generation
      const parsed = QueueWorkflowRecordSchema.parse(next)
      this.replaceWorkflowRecord(parsed)
      return parsed
    })
  }

  /**
   * Reconcile a workflow record during attended recovery. Unlike `update`,
   * the CAS check compares the on-disk state_revision against the caller's
   * expected revision. The caller MUST hold a valid lease and pass the
   * current lease handle; the previous record's fencing_generation is
   * overwritten with the lease's generation.
   */
  reconcile(
    workflowId: string,
    expectedRevision: number,
    leaseHandle: FencingLeaseHandle,
    mutate: (record: QueueWorkflowRecord) => QueueWorkflowRecord,
  ): QueueWorkflowRecord {
    return withLock(this.directory, () => {
      assertAuthority(this.leaseStore, leaseHandle)
      const current = this.loadLocked(workflowId)
      if (!current) throw new QueueStoreError('missing', `workflow ${workflowId} not found`)
      if (current.state_revision !== expectedRevision) {
        throw new QueueStoreError('stale_revision', `expected revision ${expectedRevision}, found ${current.state_revision}`)
      }
      const next = mutate(structuredClone(current))
      if (!isValidTransition(current.status, next.status)) {
        throw new QueueStoreError('invalid_transition', `transition from '${current.status}' to '${next.status}' is not permitted`)
      }
      next.state_revision = current.state_revision + 1
      next.fencing_generation = leaseHandle.lease.fencing_generation
      next.updated_at = new Date(this.now()).toISOString()
      const parsed = QueueWorkflowRecordSchema.parse(next)
      this.replaceWorkflowRecord(parsed)
      return parsed
    })
  }

  /**
   * Decide whether a failed/paused record should be requeued, applying the
   * configured retry policy and recovery attempt ceiling. Returns the
   * reconciled record if requeued, or a terminal record if retry is blocked.
   */
  applyRetryPolicy(
    workflowId: string,
    expectedRevision: number,
    leaseHandle: FencingLeaseHandle,
  ): QueueWorkflowRecord {
    return this.update(workflowId, expectedRevision, leaseHandle, (record) => {
      const decision = evaluateRetryDecision(record, { retry_policy: this.retryPolicy, recovery_attempt_limit: this.recoveryAttemptLimit }, this.now())
      // Always persist the updated counters, even when retry is blocked.
      // This ensures the ceiling is recorded durably.
      record.retry_counters = decision.updatedCounters
      if (!decision.requeue) {
        record.status = 'failed'
        record.pause_reason = decision.reason
        record.retry_not_before = null
        return record
      }
      record.status = 'queued'
      record.pause_reason = null
      record.retry_not_before = decision.retryNotBefore
      // Clear the failure classification only after all retry evidence
      // (counters, backoff) has been derived from it.
      record.failure_classification = null
      record.recovery_attempt_count = (record.recovery_attempt_count ?? 0) + 1
      return record
    })
  }

  /**
   * Build the queue index. Throws on corrupt records (fail-closed).
   */
  rebuildIndex(): QueueIndexEntry[] {
    return withLock(this.directory, () => this.rebuildIndexLocked())
  }

  getLeaseStore(): FencingLeaseStore {
    return this.leaseStore
  }

  getConfigDirectory(): string {
    return this.directory
  }

  countByStatus(index: QueueIndexEntry[], status: QueueWorkflowStatus): number {
    return index.filter(entry => entry.status === status).length
  }

  private workflowPath(workflowId: string): string {
    return path.join(this.workflowsDir, safeWorkflowFileName(workflowId))
  }

  private loadLocked(workflowId: string): QueueWorkflowRecord | null {
    const filePath = this.workflowPath(workflowId)
    if (!fs.existsSync(filePath)) return null
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      return parseQueueWorkflowRecord(parsed)
    } catch (error) {
      if (error instanceof QueueStoreError) throw error
      throw new QueueStoreError('record_corrupt', `workflow ${workflowId} has a corrupt or unreadable record: ${(error as Error).message}`)
    }
  }

  private rebuildIndexLocked(): QueueIndexEntry[] {
    const entries: QueueIndexEntry[] = []
    let files: string[]
    try { files = fs.readdirSync(this.workflowsDir) } catch { return [] }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const workflowId = file.slice(0, -5)
      const record = this.loadLocked(workflowId)
      if (record) {
        entries.push({
          workflow_id: record.workflow_id,
          status: record.status,
          fencing_generation: record.fencing_generation,
          state_revision: record.state_revision,
          updated_at: record.updated_at,
        })
      }
    }
    return entries.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  }

  private assertSessionsBudgetsLocked(index: QueueIndexEntry[], definitionId: string): void {
    const totalWorkflows = index.length
    const definitionWorkflows = index.filter(entry => {
      const record = this.loadLocked(entry.workflow_id)
      return record?.definition_id === definitionId
    }).length
    for (const budget of this.budgets) {
      if (budget.limit === null || budget.dimension !== 'sessions') continue
      const limit = budget.limit
      const current = budget.scope === 'global' ? totalWorkflows : definitionWorkflows
      if (current >= limit) {
        throw new QueueStoreError('budget_exhausted', `queue ${budget.scope} sessions budget exhausted (${current} / ${limit})`)
      }
    }
  }

  private writeWorkflowRecord(record: QueueWorkflowRecord): void {
    const filePath = this.workflowPath(record.workflow_id)
    let fd: number | null = null
    try {
      fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' })
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fsyncDirectory(this.workflowsDir)
    } catch (error) {
      if (fd !== null) { try { fs.closeSync(fd) } catch {} }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new QueueStoreError('already_exists', `workflow ${record.workflow_id} already exists`)
      }
      throw error
    }
  }

  private replaceWorkflowRecord(record: QueueWorkflowRecord): void {
    const filePath = this.workflowPath(record.workflow_id)
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | null = null
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' })
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(temp, filePath)
      fsyncDirectory(this.workflowsDir)
      try { fs.chmodSync(filePath, FILE_MODE) } catch {}
    } catch (error) {
      if (fd !== null) { try { fs.closeSync(fd) } catch {} }
      try { fs.unlinkSync(temp) } catch {}
      throw error
    }
  }
}
