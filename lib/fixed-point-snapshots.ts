import fs from 'node:fs'
import path from 'node:path'

import { BoundedAccessError } from './bounded-access-error.ts'
import { MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE } from './bounded-json.ts'
import {
  boundedFileIdentity,
  boundedFileSnapshot,
  readBoundedFile,
  writeBoundedFile,
  type BoundedFileIdentity,
} from './bounded-file-transport.ts'
import { resolveBoundedToolPaths } from './bounded-tool-policy.ts'
import type { CorrectionEdit } from './fixed-point-contracts.ts'

const EXPECTED_SOURCE_CODES = new Set([
  'credential_content',
  'hard_link',
  'invalid_utf8',
  'missing_file',
  'protected_write',
  'sensitive_path',
  'symlink_path',
  'too_large',
  'unsupported_read',
])

export interface BoundedSourceSnapshot {
  path: string
  content: string
}

export interface ReviewSnapshotBundle {
  sources: BoundedSourceSnapshot[]
  identities: Record<string, BoundedFileIdentity>
}

interface CapturedSource {
  content: string
  identity?: BoundedFileIdentity
}

function expectedSourceError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return true
  }
  return error instanceof BoundedAccessError && EXPECTED_SOURCE_CODES.has(error.code)
}

function collectSources(
  directory: string,
  changedFiles: string[],
  maximumBytes: number,
  requireWrite: boolean,
  capture: (target: string, maximumContentBytes: number) => CapturedSource,
): ReviewSnapshotBundle {
  const sources: BoundedSourceSnapshot[] = []
  const identities: Record<string, BoundedFileIdentity> = {}
  let serializedBytes = 2
  for (const file of changedFiles) {
    try {
      const [target] = resolveBoundedToolPaths('workflow_bounded_read', { path: file }, directory, directory)
      if (requireWrite) resolveBoundedToolPaths('workflow_bounded_write', { path: file }, directory, directory)
      const separatorBytes = sources.length === 0 ? 0 : 1
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ path: file, content: '' }), 'utf8')
      const maximumContentBytes = Math.floor(
        (maximumBytes - serializedBytes - separatorBytes - envelopeBytes) / MAX_JSON_ESCAPE_BYTES_PER_INPUT_BYTE,
      )
      if (maximumContentBytes < 0) continue
      const captured = capture(target, maximumContentBytes)
      const candidate = { path: file, content: captured.content }
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      if (serializedBytes + separatorBytes + candidateBytes > maximumBytes) continue
      sources.push(candidate)
      if (captured.identity) identities[file] = captured.identity
      serializedBytes += separatorBytes + candidateBytes
    } catch (error) {
      if (!expectedSourceError(error)) throw error
      // Unavailable, protected, oversized, or credential-bearing files require attended handling.
    }
  }
  return { sources, identities }
}

export function correctionSources(
  directory: string,
  changedFiles: string[],
  maximumBytes: number,
): BoundedSourceSnapshot[] {
  return collectSources(directory, changedFiles, maximumBytes, true, (target, maximumContentBytes) => {
    const size = fs.statSync(target).size
    if (size > maximumContentBytes) throw new BoundedAccessError('too_large', 'bounded source exceeds review bytes')
    const snapshot = readBoundedFile(target, 0, size, directory)
    if (!snapshot.eof) throw new Error('bounded correction source was not read completely')
    return { content: snapshot.content }
  }).sources
}

export function reviewSnapshots(
  directory: string,
  changedFiles: string[],
  maximumBytes: number,
): ReviewSnapshotBundle {
  return collectSources(directory, changedFiles, maximumBytes, false, (target, maximumContentBytes) => {
    const snapshot = boundedFileSnapshot(target, directory, maximumContentBytes)
    return { content: snapshot.content, identity: snapshot.identity }
  })
}

export function snapshotFiles(
  directory: string,
  changedFiles: string[],
): Record<string, BoundedFileIdentity> {
  return Object.fromEntries(changedFiles.map((file) => [
    file,
    boundedFileIdentity(path.resolve(directory, file), directory),
  ]))
}

export function applyCorrectionEdits(
  directory: string,
  edits: CorrectionEdit[],
  sources: BoundedSourceSnapshot[],
): void {
  const sourceByPath = new Map(sources.map((source) => [source.path, source.content]))
  const validated = edits.map((edit) => {
    const [target] = resolveBoundedToolPaths('workflow_bounded_write', { path: edit.path }, directory, directory)
    const expected = sourceByPath.get(edit.path)
    if (expected === undefined) throw new Error(`correction edit has no bounded source snapshot: ${edit.path}`)
    const size = fs.statSync(target).size
    const current = readBoundedFile(target, 0, size, directory)
    if (!current.eof || current.content !== expected) throw new Error(`correction source changed before apply: ${edit.path}`)
    return { ...edit, target }
  })
  for (const edit of validated) {
    writeBoundedFile(edit.target, edit.content, directory, sourceByPath.get(edit.path))
  }
}
