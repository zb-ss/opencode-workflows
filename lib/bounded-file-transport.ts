import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { BoundedAccessError } from './bounded-access-error.ts'
import { lstatIfPresent } from './fs-safe.ts'
import { isPathInside } from './paths.ts'
import { containsSensitiveContent } from './sensitive-content.ts'

const SENSITIVE_SCAN_OVERLAP_BYTES = 1024
const MAX_BOUNDED_DIRECTORY_SCAN = 10_000

function ensureBoundedParent(root: string, filePath: string): void {
  const relative = path.relative(root, path.dirname(filePath))
  let current = root
  const realRoot = fs.realpathSync(root)
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const existing = lstatIfPresent(current)
    if (!existing) fs.mkdirSync(current, { mode: 0o777 })
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`bounded write parent is not a real directory: ${current}`)
    }
    if (!isPathInside(realRoot, fs.realpathSync(current))) {
      throw new Error(`bounded write parent resolves outside the worktree: ${current}`)
    }
  }
}

export function descriptorPath(descriptor: number): string {
  const candidate = ['/proc/self/fd', '/dev/fd']
    .map((root) => path.join(root, String(descriptor)))
    .find((entry) => fs.existsSync(entry))
  if (!candidate) throw new Error('bounded file access requires descriptor-relative filesystem support')
  return candidate
}

function expectedCanonicalPath(candidate: string, worktree: string): string {
  const lexicalRoot = path.resolve(worktree)
  const lexicalCandidate = path.resolve(candidate)
  if (!isPathInside(lexicalRoot, lexicalCandidate)) {
    throw new Error('bounded file target is outside the worktree')
  }
  return path.resolve(fs.realpathSync(lexicalRoot), path.relative(lexicalRoot, lexicalCandidate))
}

function assertDescriptorLocation(descriptor: number, candidate: string, worktree: string): void {
  const actual = fs.realpathSync(descriptorPath(descriptor))
  const expected = expectedCanonicalPath(candidate, worktree)
  if (path.relative(expected, actual) !== '') {
    throw new Error('bounded file path changed during access')
  }
}

function anchoredPath(filePath: string, worktree: string): { parent: number; path: string } {
  const parent = fs.openSync(
    path.dirname(filePath),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  )
  try {
    const anchoredParent = descriptorPath(parent)
    assertDescriptorLocation(parent, path.dirname(filePath), worktree)
    return { parent, path: path.join(anchoredParent, path.basename(filePath)) }
  } catch (error) {
    fs.closeSync(parent)
    throw error
  }
}

export function openAnchoredDirectory(directoryPath: string, worktree: string): number {
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  )
  try {
    assertDescriptorLocation(descriptor, directoryPath, worktree)
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf
}

function expectedUtf8Length(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

function isValidFirstContinuation(lead: number, continuation: number | null): boolean {
  if (continuation === null) return true
  if (lead === 0xe0) return continuation >= 0xa0 && continuation <= 0xbf
  if (lead === 0xed) return continuation >= 0x80 && continuation <= 0x9f
  if (lead === 0xf0) return continuation >= 0x90 && continuation <= 0xbf
  if (lead === 0xf4) return continuation >= 0x80 && continuation <= 0x8f
  return isContinuationByte(continuation)
}

function incompleteUtf8SuffixLength(buffer: Buffer): number {
  let suffixStart = buffer.length - 1
  while (suffixStart >= 0 && isContinuationByte(buffer[suffixStart])) suffixStart--
  if (suffixStart < 0) return 0
  const lead = buffer[suffixStart]
  const expectedLength = expectedUtf8Length(lead)
  const suffixLength = buffer.length - suffixStart
  if (expectedLength <= suffixLength) return 0
  const firstContinuation = suffixStart + 1 < buffer.length ? buffer[suffixStart + 1] : null
  const hasOnlyContinuations = buffer
    .subarray(suffixStart + 1)
    .every((byte) => isContinuationByte(byte))
  return isValidFirstContinuation(lead, firstContinuation) && hasOnlyContinuations ? suffixLength : 0
}

function readCompleteBytes(descriptor: number, size: number): Buffer {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const bytesRead = fs.readSync(descriptor, buffer, offset, size - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== size) throw new Error('bounded file changed while reading expected content')
  return buffer
}

function decodeCompleteUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    throw new BoundedAccessError('invalid_utf8', 'bounded file target is not valid UTF-8')
  }
}

function readCompleteUtf8(descriptor: number, size: number): string {
  return decodeCompleteUtf8(readCompleteBytes(descriptor, size))
}

function assertNoSensitiveContent(descriptor: number, offset: number, length: number, size: number): void {
  const scanStart = Math.max(0, offset - SENSITIVE_SCAN_OVERLAP_BYTES)
  const scanEnd = Math.min(size, offset + length + SENSITIVE_SCAN_OVERLAP_BYTES)
  const buffer = Buffer.alloc(64 * 1024)
  let position = scanStart
  let carry = ''
  while (position < scanEnd) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, scanEnd - position), position)
    if (bytesRead === 0) break
    const text = carry + buffer.subarray(0, bytesRead).toString('utf8')
    if (containsSensitiveContent(text)) {
      throw new BoundedAccessError('credential_content', 'bounded read rejected credential-like file content')
    }
    carry = text.slice(-512)
    position += bytesRead
  }
}

export function readBoundedFile(filePath: string, offset: number, length: number, worktree: string): {
  content: string
  eof: boolean
  next_offset: number
} {
  const anchored = anchoredPath(filePath, worktree)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(anchored.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('bounded read target is not a regular file')
    if (stat.nlink > 1) throw new BoundedAccessError('hard_link', 'bounded read rejects hard-linked targets')
    assertNoSensitiveContent(descriptor, offset, length, stat.size)
    if (offset > stat.size) throw new Error('bounded read offset is beyond end of file')
    if (offset > 0 && offset < stat.size) {
      const boundary = Buffer.alloc(1)
      fs.readSync(descriptor, boundary, 0, 1, offset)
      if ((boundary[0] & 0xc0) === 0x80) throw new Error('bounded read offset must be a UTF-8 character boundary')
    }
    const size = Math.min(length, Math.max(0, stat.size - offset))
    const buffer = Buffer.alloc(size)
    const bytesRead = size === 0 ? 0 : fs.readSync(descriptor, buffer, 0, size, offset)
    const decodedLength = bytesRead - incompleteUtf8SuffixLength(buffer.subarray(0, bytesRead))
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, decodedLength))
    } catch {
      throw new BoundedAccessError('invalid_utf8', 'bounded read target is not valid UTF-8')
    }
    if (bytesRead > 0 && decodedLength === 0) {
      throw new Error('bounded read length is too small for the next UTF-8 character')
    }
    const nextOffset = offset + decodedLength
    return { content, eof: nextOffset >= stat.size, next_offset: nextOffset }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.closeSync(anchored.parent)
  }
}

export interface BoundedDirectoryEntry {
  name: string
  type: 'directory' | 'file'
}

export interface BoundedFileIdentity {
  kind: 'file' | 'missing'
  mode?: number
  sha256?: string
  size?: number
}

export interface BoundedFileSnapshot {
  content: string
  identity: BoundedFileIdentity
}

function assertStableIdentity(before: fs.BigIntStats, after: fs.BigIntStats): void {
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs) {
    throw new Error('bounded file identity changed during snapshot')
  }
}

function boundedStatSize(stat: fs.BigIntStats): number {
  const size = Number(stat.size)
  if (!Number.isSafeInteger(size)) throw new Error('bounded file size exceeds the safe integer range')
  return size
}

export function boundedFileIdentity(filePath: string, worktree: string): BoundedFileIdentity {
  const anchored = anchoredPath(filePath, worktree)
  let descriptor: number | null = null
  try {
    try {
      descriptor = fs.openSync(anchored.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      throw error
    }
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!stat.isFile()) throw new Error('bounded identity target is not a regular file')
    if (stat.nlink > 1n) throw new BoundedAccessError('hard_link', 'bounded identity rejects hard-linked targets')
    const size = boundedStatSize(stat)
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    while (position < size) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position)
      if (bytesRead === 0) throw new Error('bounded identity target changed while hashing')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    assertStableIdentity(stat, fs.fstatSync(descriptor, { bigint: true }))
    return {
      kind: 'file',
      mode: Number(stat.mode & 0o777n),
      sha256: hash.digest('hex'),
      size,
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.closeSync(anchored.parent)
  }
}

export function boundedFileSnapshot(
  filePath: string,
  worktree: string,
  maximumBytes: number,
): BoundedFileSnapshot {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('bounded snapshot byte limit must be a non-negative safe integer')
  }
  const anchored = anchoredPath(filePath, worktree)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(anchored.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new Error('bounded snapshot target is not a regular file')
    if (before.nlink > 1n) throw new BoundedAccessError('hard_link', 'bounded snapshot rejects hard-linked targets')
    const size = boundedStatSize(before)
    if (size > maximumBytes) {
      throw new BoundedAccessError('too_large', 'bounded snapshot target exceeds the configured byte limit')
    }
    const bytes = readCompleteBytes(descriptor, size)
    const content = decodeCompleteUtf8(bytes)
    assertStableIdentity(before, fs.fstatSync(descriptor, { bigint: true }))
    if (containsSensitiveContent(content)) {
      throw new BoundedAccessError('credential_content', 'bounded snapshot rejected credential-like file content')
    }
    return {
      content,
      identity: {
        kind: 'file',
        mode: Number(before.mode & 0o777n),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size,
      },
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.closeSync(anchored.parent)
  }
}

export function listBoundedDirectory(
  directoryPath: string,
  worktree: string,
  maxEntries: number,
  include: (entry: BoundedDirectoryEntry) => boolean,
): { entries: BoundedDirectoryEntry[]; truncated: boolean } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new Error('bounded list entry limit must be a non-negative safe integer')
  }
  let descriptor: number | null = null
  let directory: fs.Dir | null = null
  try {
    descriptor = openAnchoredDirectory(directoryPath, worktree)
    if (!fs.fstatSync(descriptor).isDirectory()) throw new Error('bounded list target is not a directory')
    directory = fs.opendirSync(descriptorPath(descriptor))
    const entries: BoundedDirectoryEntry[] = []
    let scanned = 0
    while (scanned < MAX_BOUNDED_DIRECTORY_SCAN) {
      const entry = directory.readSync()
      if (!entry) return { entries: entries.sort((left, right) => left.name.localeCompare(right.name)), truncated: false }
      scanned++
      if (!entry.isDirectory() && !entry.isFile()) continue
      const mapped = {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' as const : 'file' as const,
      }
      if (!include(mapped)) continue
      if (entries.length >= maxEntries) {
        return { entries: entries.sort((left, right) => left.name.localeCompare(right.name)), truncated: true }
      }
      entries.push(mapped)
    }
    return { entries: entries.sort((left, right) => left.name.localeCompare(right.name)), truncated: true }
  } finally {
    if (directory) directory.closeSync()
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

export function writeBoundedFile(
  filePath: string,
  content: string,
  worktree: string,
  expectedContent?: string,
): void {
  const root = path.resolve(worktree)
  ensureBoundedParent(root, filePath)
  const anchored = anchoredPath(filePath, root)
  const temporary = `${anchored.path}.bounded-${randomUUID()}`
  let descriptor: number | null = null
  let expectedDescriptor: number | null = null
  try {
    const existing = lstatIfPresent(anchored.path)
    if (expectedContent !== undefined) {
      expectedDescriptor = fs.openSync(anchored.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const expectedStat = fs.fstatSync(expectedDescriptor)
      if (!expectedStat.isFile() || expectedStat.nlink > 1) {
        throw new Error('bounded write expected target is not one regular unlinked file')
      }
      if (readCompleteUtf8(expectedDescriptor, expectedStat.size) !== expectedContent) {
        throw new Error('bounded write target changed before replacement')
      }
    }
    const mode = existing?.mode === undefined ? 0o666 : existing.mode & 0o777
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    )
    if (existing) fs.fchmodSync(descriptor, mode)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    if (expectedDescriptor !== null) {
      const expectedStat = fs.fstatSync(expectedDescriptor)
      const currentStat = fs.lstatSync(anchored.path)
      if (currentStat.isSymbolicLink()
        || currentStat.dev !== expectedStat.dev
        || currentStat.ino !== expectedStat.ino
        || readCompleteUtf8(expectedDescriptor, expectedStat.size) !== expectedContent) {
        throw new Error('bounded write target changed before atomic replacement')
      }
    }
    fs.renameSync(temporary, anchored.path)
    try { fs.fsyncSync(anchored.parent) } catch {}
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  } finally {
    if (expectedDescriptor !== null) fs.closeSync(expectedDescriptor)
    fs.closeSync(anchored.parent)
  }
}
