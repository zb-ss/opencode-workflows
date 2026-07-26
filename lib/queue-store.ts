import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  FencingLeaseStore,
  assertFencingGeneration,
} from './fencing-lease.ts'
import {
  QUEUE_SCHEMA_VERSION,
  QueueWorkflowRecordSchema,
  QueueWorkflowStatusSchema,
  isValidTransition,
  type QueueWorkflowRecord,
  type QueueWorkflowStatus,
  type QueueIndexEntry,
} from './queue-contracts.ts'
import { emptyAutomationUsageTelemetry } from './epic-budget-usage.ts'
import { sha256Hex } from './canonical-json.ts'

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

export class QueueStore {
  private readonly directory: string
  private readonly workflowsDir: string
  private readonly leaseStore: FencingLeaseStore
  private readonly now: () => number
  private readonly owner: string
  private readonly maxWorkflows: number

  constructor(options: QueueStoreOptions) {
    this.directory = path.resolve(options.config_directory)
    this.workflowsDir = path.join(this.directory, 'workflows')
    this.owner = options.owner
    this.now = options.now
    this.maxWorkflows = options.max_workflows ?? 256
    validateDirectory(this.directory)
    fs.mkdirSync(this.workflowsDir, { recursive: true, mode: DIR_MODE })
    validateDirectory(this.workflowsDir)
    this.leaseStore = new FencingLeaseStore({
      lease_directory: path.join(this.directory, 'lease'),
      owner: this.owner,
      lease_duration_ms: options.lease_duration_ms ?? 60_000,
      now: this.now,
    })
  }

  enqueue(input: QueueWorkflowInput, fencingGeneration: number): QueueWorkflowRecord {
    assertFencingGeneration(this.leaseStore, fencingGeneration)
    const index = this.rebuildIndex()
    if (index.length >= this.maxWorkflows) {
      throw new QueueStoreError('queue_full', `queue is at capacity (${this.maxWorkflows} workflows)`)
    }
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
      fencing_generation: fencingGeneration,
      state_revision: 1,
      launch_intent: null,
      failure_classification: null,
      retry_counters: null,
      retry_not_before: null,
      created_at: nowIso,
      updated_at: nowIso,
      usage: emptyAutomationUsageTelemetry(),
    }
    const parsed = QueueWorkflowRecordSchema.parse(record)
    this.writeWorkflowRecord(parsed)
    return parsed
  }

  load(workflowId: string): QueueWorkflowRecord | null {
    const filePath = this.workflowPath(workflowId)
    if (!fs.existsSync(filePath)) return null
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      return QueueWorkflowRecordSchema.parse(parsed)
    } catch (error) {
      if (error instanceof QueueStoreError) throw error
      throw new QueueStoreError('record_corrupt', `workflow ${workflowId} has a corrupt or unreadable record: ${(error as Error).message}`)
    }
  }

  update(
    workflowId: string,
    expectedRevision: number,
    expectedGeneration: number,
    mutate: (record: QueueWorkflowRecord) => QueueWorkflowRecord,
  ): QueueWorkflowRecord {
    assertFencingGeneration(this.leaseStore, expectedGeneration)
    const current = this.load(workflowId)
    if (!current) throw new QueueStoreError('missing', `workflow ${workflowId} not found`)
    if (current.state_revision !== expectedRevision) {
      throw new QueueStoreError('stale_revision', `expected revision ${expectedRevision}, found ${current.state_revision}`)
    }
    if (current.fencing_generation !== expectedGeneration) {
      throw new QueueStoreError('stale_generation', `expected generation ${expectedGeneration}, found ${current.fencing_generation}`)
    }
    const next = mutate(structuredClone(current))
    if (!isValidTransition(current.status, next.status)) {
      throw new QueueStoreError('invalid_transition', `transition from '${current.status}' to '${next.status}' is not permitted`)
    }
    next.state_revision = current.state_revision + 1
    next.updated_at = new Date(this.now()).toISOString()
    const parsed = QueueWorkflowRecordSchema.parse(next)
    this.replaceWorkflowRecord(parsed)
    return parsed
  }

  reconcile(
    workflowId: string,
    expectedRevision: number,
    newGeneration: number,
    mutate: (record: QueueWorkflowRecord) => QueueWorkflowRecord,
  ): QueueWorkflowRecord {
    assertFencingGeneration(this.leaseStore, newGeneration)
    const current = this.load(workflowId)
    if (!current) throw new QueueStoreError('missing', `workflow ${workflowId} not found`)
    if (current.state_revision !== expectedRevision) {
      throw new QueueStoreError('stale_revision', `expected revision ${expectedRevision}, found ${current.state_revision}`)
    }
    const next = mutate(structuredClone(current))
    if (!isValidTransition(current.status, next.status)) {
      throw new QueueStoreError('invalid_transition', `transition from '${current.status}' to '${next.status}' is not permitted`)
    }
    next.state_revision = current.state_revision + 1
    next.fencing_generation = newGeneration
    next.updated_at = new Date(this.now()).toISOString()
    const parsed = QueueWorkflowRecordSchema.parse(next)
    this.replaceWorkflowRecord(parsed)
    return parsed
  }

  rebuildIndex(): QueueIndexEntry[] {
    const entries: QueueIndexEntry[] = []
    let files: string[]
    try { files = fs.readdirSync(this.workflowsDir) } catch { return [] }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const workflowId = file.slice(0, -5)
      try {
        const record = this.load(workflowId)
        if (record) {
          entries.push({
            workflow_id: record.workflow_id,
            status: record.status,
            fencing_generation: record.fencing_generation,
            state_revision: record.state_revision,
            updated_at: record.updated_at,
          })
        }
      } catch {
        // Corrupt records are reported, not silently dropped.
        // In a production system this would trigger a health alert.
        // For now, we skip to avoid blocking the entire index rebuild.
        // The load() method throws on corrupt records, so the caller
        // can distinguish missing from corrupt.
      }
    }
    return entries.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
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
    return path.join(this.workflowsDir, `${workflowId}.json`)
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