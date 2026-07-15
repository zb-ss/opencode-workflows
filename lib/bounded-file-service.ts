import type { ToolContext } from '@opencode-ai/plugin'
import path from 'node:path'

import { MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE } from './bounded-json.ts'
import {
  listBoundedDirectory,
  readBoundedFile,
  writeBoundedFile,
} from './bounded-file-transport.ts'
import type { BoundedIoReservation } from './bounded-io-ledger.ts'
import { isBoundedVisiblePath, resolveBoundedToolPaths } from './bounded-tool-policy.ts'
import type { AutomaticWorkflowState } from './workflow-engine.ts'
import { acquireProjectMutationLease } from './project-mutation-lease.ts'

const MAX_BOUNDED_LIST_ENTRIES = 1000

interface ReadArguments {
  path: string
  offset?: number
  length?: number
}

interface WriteArguments {
  path: string
  content: string
}

interface ListArguments {
  path?: string
}

type BoundedToolName = 'workflow_bounded_list' | 'workflow_bounded_read' | 'workflow_bounded_write'

interface BoundedWorkflowOwner {
  snapshot(): AutomaticWorkflowState
  usesBoundedAutonomy(): boolean
  reserveBoundedIo(kind: 'read' | 'write', requestedBytes?: number): Promise<BoundedIoReservation>
}

export class BoundedFileService {
  constructor(private readonly ownerForSession: (sessionId: string) => BoundedWorkflowOwner | undefined) {}

  async read(args: ReadArguments, context: ToolContext): Promise<string> {
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
      throw new Error('bounded read offset must be a non-negative safe integer')
    }
    if (args.length !== undefined && (!Number.isSafeInteger(args.length) || args.length < 0)) {
      throw new Error('bounded read length must be a non-negative safe integer')
    }
    const authorized = await this.authorize(context, 'workflow_bounded_read', args)
    const offset = args.offset ?? 0
    const envelopeBytes = Buffer.byteLength(JSON.stringify({
      path: authorized.permissionPath,
      content: '',
      eof: false,
      next_offset: Number.MAX_SAFE_INTEGER,
    }), 'utf8')
    if (args.length !== undefined
      && args.length > Math.floor((Number.MAX_SAFE_INTEGER - envelopeBytes) / MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE)) {
      throw new Error('bounded read length is too large')
    }
    const requestedBytes = args.length === undefined
      ? undefined
      : envelopeBytes + (args.length * MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE)
    return this.withReservation(
      authorized.owner,
      'read',
      requestedBytes,
      (reservedBytes) => {
        const contentBytes = Math.floor(
          Math.max(0, reservedBytes - envelopeBytes) / MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE,
        )
        const length = Math.min(args.length ?? contentBytes, contentBytes)
        const result = readBoundedFile(
          authorized.target,
          offset,
          length,
          authorized.state.worktree,
        )
        if (!result.eof && result.next_offset === offset) {
          throw new Error('bounded read budget is too small for the next UTF-8 character')
        }
        return JSON.stringify({ path: authorized.permissionPath, ...result })
      },
      (output) => Buffer.byteLength(output, 'utf8'),
    )
  }

  async write(args: WriteArguments, context: ToolContext): Promise<string> {
    const authorized = await this.authorize(context, 'workflow_bounded_write', args)
    const bytes = Buffer.byteLength(args.content, 'utf8')
    return this.withExactWriteReservation(authorized.owner, bytes, () => {
      const release = acquireProjectMutationLease(authorized.state.worktree)
      try {
        writeBoundedFile(authorized.target, args.content, authorized.state.worktree)
        return JSON.stringify({ written: true, path: authorized.permissionPath })
      } finally {
        release()
      }
    })
  }

  async list(args: ListArguments, context: ToolContext): Promise<string> {
    const input = { path: args.path ?? '.' }
    const authorized = await this.authorize(context, 'workflow_bounded_list', input)
    return this.withReservation(
      authorized.owner,
      'read',
      undefined,
      (reservedBytes) => {
        const result = listBoundedDirectory(
          authorized.target,
          authorized.state.worktree,
          MAX_BOUNDED_LIST_ENTRIES,
          (entry) => isBoundedVisiblePath(
            path.relative(authorized.state.worktree, path.join(authorized.target, entry.name)),
            entry.type === 'directory',
          ),
        )
        let entries: typeof result.entries = []
        let output = JSON.stringify({
          path: authorized.permissionPath,
          entries,
          truncated: result.truncated || result.entries.length > 0,
        })
        for (const [index, entry] of result.entries.entries()) {
          const candidateEntries = [...entries, entry]
          const candidate = JSON.stringify({
            path: authorized.permissionPath,
            entries: candidateEntries,
            truncated: result.truncated || index < result.entries.length - 1,
          })
          if (Buffer.byteLength(candidate, 'utf8') > reservedBytes) break
          entries = candidateEntries
          output = candidate
        }
        return output
      },
      (value) => Buffer.byteLength(value, 'utf8'),
    )
  }

  private async authorize(
    context: ToolContext,
    toolName: BoundedToolName,
    args: unknown,
  ): Promise<{
    owner: BoundedWorkflowOwner
    state: AutomaticWorkflowState
    target: string
    permissionPath: string
  }> {
    const owner = this.boundedOwner(context.sessionID)
    const state = owner.snapshot()
    const [target] = resolveBoundedToolPaths(toolName, args, state.worktree, state.directory)
    const permissionPath = path.relative(state.worktree, target)
    await context.ask({
      permission: toolName,
      patterns: [permissionPath],
      always: [],
      metadata: { workflow_driver: 'automatic', root_session_id: state.root_session_id },
    })
    return { owner, state, target, permissionPath }
  }

  private boundedOwner(sessionId: string): BoundedWorkflowOwner {
    const owner = this.ownerForSession(sessionId)
    if (!owner || !owner.usesBoundedAutonomy()) {
      throw new Error('bounded file tools are available only inside an owned bounded automatic workflow stage')
    }
    if (owner.snapshot().status !== 'running') {
      throw new Error('bounded file tools are disabled while the automatic workflow is paused')
    }
    return owner
  }

  private async withReservation<T>(
    owner: BoundedWorkflowOwner,
    kind: 'read' | 'write',
    requestedBytes: number | undefined,
    operation: (reservedBytes: number) => T | Promise<T>,
    chargedBytes: (value: T) => number,
  ): Promise<T> {
    const reservation = await owner.reserveBoundedIo(kind, requestedBytes)
    try {
      const value = await operation(reservation.size())
      await reservation.adjust(chargedBytes(value))
      await reservation.commit()
      return value
    } catch (error) {
      try {
        await reservation.cancel()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `bounded ${kind} failed and its budget reservation could not be cancelled`,
        )
      }
      throw error
    }
  }

  private async withExactWriteReservation<T>(
    owner: BoundedWorkflowOwner,
    bytes: number,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const reservation = await owner.reserveBoundedIo('write', bytes)
    let value: T
    try {
      value = await operation()
    } catch (error) {
      try {
        await reservation.cancel()
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'bounded write failed and its budget reservation could not be cancelled')
      }
      throw error
    }
    await reservation.commit()
    return value
  }
}
