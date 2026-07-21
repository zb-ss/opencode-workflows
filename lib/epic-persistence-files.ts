import fs from 'node:fs'
import path from 'node:path'

import {
  EpicCorruptError,
  EpicIncompleteStateError,
  EpicMissingError,
  EpicStaleRevisionError,
  EpicStoreError,
  EpicUnavailableError,
  EpicUnsafeStorageError,
} from './epic-persistence-errors.ts'
import { projectIdentitySha256 } from './epic-integration-digests.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const SETTLEMENT_RETRY_DELAY_MS = 2
const NOFOLLOW = fs.constants.O_NOFOLLOW
const DIRECTORY = fs.constants.O_DIRECTORY
const NONBLOCK = fs.constants.O_NONBLOCK

export interface EpicProjectIdentity {
  canonical_path: string
  canonical_path_sha256: string
  dev: string
  ino: string
}

export function assertEpicPosixStorage(): void {
  if (process.platform === 'win32' || typeof NOFOLLOW !== 'number' || typeof DIRECTORY !== 'number') {
    throw new EpicUnavailableError('epic storage requires POSIX descriptor semantics')
  }
}

function assertOwned(stat: fs.Stats | fs.BigIntStats, label: string): void {
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new EpicUnsafeStorageError(`${label} is owned by a different user`)
  }
}

function sameInode(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLEMENT_RETRY_DELAY_MS)
}

export function canonicalEpicProjectRoot(projectRoot: string): EpicProjectIdentity {
  let descriptor: number | null = null
  try {
    const canonical_path = fs.realpathSync(projectRoot)
    descriptor = fs.openSync(canonical_path, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const pathStat = fs.statSync(canonical_path, { bigint: true })
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!pathStat.isDirectory() || !opened.isDirectory() || !sameInode(pathStat, opened)) {
      throw new EpicUnsafeStorageError('project directory identity is unstable')
    }
    return {
      canonical_path,
      canonical_path_sha256: projectIdentitySha256(canonical_path),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    }
  } catch (error) {
    if (error instanceof EpicStoreError) throw error
    throw new EpicUnavailableError('project root cannot be opened as an existing canonical directory')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

export function verifyEpicProjectIdentity(project: EpicProjectIdentity): void {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(project.canonical_path, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const pathStat = fs.statSync(project.canonical_path, { bigint: true })
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameInode(pathStat, opened) || opened.dev.toString() !== project.dev || opened.ino.toString() !== project.ino) {
      throw new EpicUnsafeStorageError('project directory was rebound after store construction')
    }
  } catch (error) {
    if (error instanceof EpicStoreError) throw error
    throw new EpicUnsafeStorageError('project directory is no longer the opened project identity')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

export function inspectEpicDirectory(directory: string, normalize: boolean): void {
  let descriptor: number | null = null
  try {
    const lexical = fs.lstatSync(directory)
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new EpicUnsafeStorageError('managed epic directory is not a real directory')
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isDirectory()) throw new EpicUnsafeStorageError('managed epic directory changed identity')
    assertOwned(stat, 'managed epic directory')
    if (normalize) fs.fchmodSync(descriptor, DIRECTORY_MODE)
    if ((fs.fstatSync(descriptor).mode & 0o777) !== DIRECTORY_MODE) {
      throw new EpicUnsafeStorageError('managed epic directory permissions are not 0700')
    }
  } catch (error) {
    if (error instanceof EpicStoreError) throw error
    throw new EpicUnavailableError('managed epic directory is unavailable')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function assertNoSymlinkAncestors(target: string): void {
  const resolved = path.resolve(target)
  const root = path.parse(resolved).root
  let current = root
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new EpicUnsafeStorageError('managed epic path has a symlink ancestor')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof EpicStoreError) throw error
      throw new EpicUnavailableError('managed epic path ancestor is unavailable')
    }
  }
}

export function withStableEpicDirectory<T>(directory: string, operation: () => T): T {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const before = fs.fstatSync(descriptor, { bigint: true })
    const value = operation()
    const after = fs.fstatSync(descriptor, { bigint: true })
    const pathname = fs.statSync(directory, { bigint: true })
    if (!sameInode(before, after) || !sameInode(after, pathname)) {
      throw new EpicUnsafeStorageError('managed epic directory changed during pathname operation')
    }
    return value
  } catch (error) {
    if (error instanceof EpicStoreError) throw error
    throw new EpicUnavailableError('managed epic pathname operation failed')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function fsyncDirectory(directory: string, sync: (descriptor: number) => void): void {
  withStableEpicDirectory(directory, () => {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    try {
      sync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  })
}

function ensureDirectory(directory: string, sync: (descriptor: number) => void): void {
  let created = false
  try {
    fs.mkdirSync(directory, { mode: DIRECTORY_MODE })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new EpicUnavailableError('managed epic directory could not be created')
    }
  }
  inspectEpicDirectory(directory, true)
  if (created) fsyncDirectory(path.dirname(directory), sync)
}

export function ensureEpicDirectoryTree(directory: string, managedRoot: string, sync: (descriptor: number) => void): void {
  assertNoSymlinkAncestors(directory)
  const missing: string[] = []
  let current = path.resolve(directory)
  while (!fs.existsSync(current)) {
    missing.push(current)
    current = path.dirname(current)
  }
  for (const entry of missing.reverse()) ensureDirectory(entry, sync)
  const relative = path.relative(path.resolve(managedRoot), path.resolve(directory))
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EpicUnsafeStorageError('managed epic path escaped its runtime root')
  let managed = path.resolve(managedRoot)
  inspectEpicDirectory(managed, true)
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    managed = path.join(managed, segment)
    inspectEpicDirectory(managed, true)
  }
}

export function inspectEpicDirectoryTree(directory: string, managedRoot: string): boolean {
  assertNoSymlinkAncestors(directory)
  if (!fs.existsSync(managedRoot)) return false
  const relative = path.relative(path.resolve(managedRoot), path.resolve(directory))
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EpicUnsafeStorageError('managed epic path escaped its runtime root')
  let managed = path.resolve(managedRoot)
  inspectEpicDirectory(managed, false)
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    managed = path.join(managed, segment)
    if (!fs.existsSync(managed)) return false
    inspectEpicDirectory(managed, false)
  }
  return true
}

export function readEpicRecord(filePath: string, directory: string, label: string, maximumBytes: number, settlementRetries: number): unknown {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return withStableEpicDirectory(directory, () => readStableRecord(filePath, label, maximumBytes))
    } catch (error) {
      if (error instanceof EpicIncompleteStateError && attempt < settlementRetries) {
        sleepBriefly()
        continue
      }
      throw error
    }
  }
}

function readStableRecord(filePath: string, label: string, maximumBytes: number): unknown {
  let descriptor: number | null = null
  try {
    const lexical = fs.lstatSync(filePath)
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1) throw new EpicUnsafeStorageError(`${label} is not one regular private file`)
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NONBLOCK | NOFOLLOW)
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) throw new EpicUnsafeStorageError(`${label} is not one regular private file`)
    assertOwned(before, label)
    if (Number(before.mode & 0o777n) !== FILE_MODE) throw new EpicUnsafeStorageError(`${label} permissions are not 0600`)
    const size = Number(before.size)
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximumBytes) throw new EpicCorruptError(`${label} has an invalid size`)
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = fs.readSync(descriptor, bytes, offset, size - offset, offset)
      if (count === 0) throw new EpicIncompleteStateError(`${label} is incomplete`)
      offset += count
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (!sameInode(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new EpicUnsafeStorageError(`${label} changed while being read`)
    }
    if (bytes.at(-1) !== 0x0a) throw new EpicIncompleteStateError(`${label} lacks its completion marker`)
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    } catch {
      throw new EpicCorruptError(`${label} is not fatal UTF-8 JSON`)
    }
  } catch (error) {
    if (error instanceof EpicStoreError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EpicMissingError(`${label} is missing`)
    throw new EpicUnavailableError(`${label} is unavailable`)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

export function writeExclusiveEpicRecord(directory: string, target: string, bytes: Buffer, sync: (descriptor: number) => void): void {
  withStableEpicDirectory(directory, () => {
    let descriptor: number | null = null
    let created = false
    try {
      descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, FILE_MODE)
      created = true
      fs.fchmodSync(descriptor, FILE_MODE)
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink !== 1) throw new EpicUnsafeStorageError('new epic record is not one regular file')
      assertOwned(stat, 'new epic record')
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
        if (count <= 0) throw new EpicUnavailableError('epic write made no progress')
        offset += count
      }
      sync(descriptor)
      fs.closeSync(descriptor)
      descriptor = null
      fsyncDirectory(directory, sync)
    } catch (error) {
      if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new EpicStaleRevisionError('immutable epic record already exists')
      if (error instanceof EpicStoreError) throw error
      throw new EpicUnavailableError(created ? 'immutable epic record remains incomplete' : 'epic record could not be created')
    } finally {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor)
        } catch {
          // The incomplete immutable record remains a recovery blocker.
        }
      }
    }
  })
}

export function listEpicDirectory(directory: string): string[] {
  return withStableEpicDirectory(directory, () => {
    const entries: string[] = []
    const handle = fs.opendirSync(directory)
    try {
      for (;;) {
        const entry = handle.readSync()
        if (entry === null) break
        entries.push(entry.name)
      }
    } finally {
      handle.closeSync()
    }
    return entries
  })
}

/*
 * Trust boundary: pathname operations retain O_NOFOLLOW, containment, private
 * modes, and before/after directory-descriptor inode checks. Node exposes no
 * openat/openat2 API, so malicious same-UID directory renames between pathname
 * operations cannot be excluded completely. Project inode replacement is
 * intentionally fail-closed and requires reopening a new epic identity.
 */
