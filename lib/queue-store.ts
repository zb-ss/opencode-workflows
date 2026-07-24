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
  type QueueWorkflowRecord,
  type QueueWorkflowStatus,
  type QueueIndexEntry,
} from './queue-contracts.ts'
import { emptyAutomationUsageTelemetry } from './epic-budget-usage.ts'

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

export class QueueStore {
  private readonly directory: string
  private readonly workflowsDir: string
  private readonly leaseStore: FencingLeaseStore
  private readonly now: () => number
  private readonly owner: string

  constructor(options: QueueStoreOptions) {
    this.directory = path.resolve(options.config_directory)
    this.workflowsDir = path.join(this.directory, 'workflows')
    this.owner = options.owner
    this.now = options.now
    this.leaseStore = new FencingLeaseStore({
      lease_directory: path.join(this.directory, 'lease'),
      owner: this.owner,
      lease_duration_ms: 60_000,
      now: this.now,
    })
    fs.mkdirSync(this.workflowsDir, { recursive: true, mode: DIR_MODE })
  }

  enqueue(input: QueueWorkflowInput, fencingGeneration: number): QueueWorkflowRecord {
    assertFencingGeneration(this.leaseStore, fencingGeneration)
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
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      return QueueWorkflowRecordSchema.parse(parsed)
    } catch {
      return null
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
    next.state_revision = current.state_revision + 1
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
      try {
        const content = fs.readFileSync(path.join(this.workflowsDir, file), 'utf8')
        const record = QueueWorkflowRecordSchema.parse(JSON.parse(content))
        entries.push({
          workflow_id: record.workflow_id,
          status: record.status,
          fencing_generation: record.fencing_generation,
          state_revision: record.state_revision,
          updated_at: record.updated_at,
        })
      } catch { /* skip corrupt */ }
    }
    return entries.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  }

  getLeaseStore(): FencingLeaseStore {
    return this.leaseStore
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
    try {
      fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE })
      fs.renameSync(temp, filePath)
      try { fs.chmodSync(filePath, FILE_MODE) } catch {}
    } catch (error) {
      try { fs.unlinkSync(temp) } catch {}
      throw error
    }
  }
}