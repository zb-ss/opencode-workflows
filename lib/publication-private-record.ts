import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { PublicationUuidSchema, stableCanonicalJson } from './publication-contracts.ts'
import { getConfigDir, getSessionRuntimeDir } from './paths.ts'
import {
  MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS,
  MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS,
  MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS,
} from './workflow-config.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const NOFOLLOW = fs.constants.O_NOFOLLOW
const DIRECTORY = fs.constants.O_DIRECTORY

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export interface PublicationStoreLayout {
  root: string
  artifacts: string
  artifactSlots: string
  claims: string
  executions: string
}

export interface PublicationRecordSettlementPolicy {
  attempts: number
  delay_ms: number
  timeout_ms: number
}

export class PublicationStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicationStoreError'
  }
}

export class ExclusiveRecordExistsError extends PublicationStoreError {}

export class IncompletePublicationRecordError extends PublicationStoreError {}

export class ExclusiveRecordWriteError extends PublicationStoreError {
  constructor(message: string, readonly targetCreated: boolean) {
    super(message)
  }
}

export function publicationStoreError(message: string): PublicationStoreError {
  return new PublicationStoreError(message)
}

export function assertPublicationUuid(value: string, label: string): string {
  if (!PublicationUuidSchema.safeParse(value).success) throw publicationStoreError(`${label} is not a UUID`)
  return value
}

export function assertPublicationSha256(value: string, label: string): string {
  if (!Sha256Schema.safeParse(value).success) {
    throw publicationStoreError(`${label} is not a SHA-256 digest`)
  }
  return value
}

function assertPosixSupport(): void {
  if (process.platform === 'win32'
    || typeof NOFOLLOW !== 'number'
    || typeof DIRECTORY !== 'number') {
    throw publicationStoreError('publication storage requires POSIX filesystem semantics')
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null
  let failure: unknown = null
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    fs.fsyncSync(descriptor)
  } catch (error) {
    failure = error
  }
  if (descriptor !== null) {
    try {
      fs.closeSync(descriptor)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== null) {
    throw publicationStoreError('publication storage directory could not be synchronized durably')
  }
}

function inspectPrivateDirectory(directory: string, normalizePermissions: boolean): void {
  let descriptor: number | null = null
  try {
    const lexical = fs.lstatSync(directory)
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
      throw publicationStoreError('publication storage component is not a private directory')
    }
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW)
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw publicationStoreError('publication storage component is not a private directory')
    }
    if (normalizePermissions) fs.fchmodSync(descriptor, DIRECTORY_MODE)
    if ((fs.fstatSync(descriptor).mode & 0o777) !== DIRECTORY_MODE) {
      throw publicationStoreError('publication storage directory permissions are not private')
    }
  } catch (error) {
    if (error instanceof PublicationStoreError) throw error
    throw publicationStoreError('publication storage component is unavailable')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function assertPrivateDirectory(directory: string): void {
  inspectPrivateDirectory(directory, true)
}

function assertExistingPrivateDirectory(directory: string): void {
  inspectPrivateDirectory(directory, false)
}

function ensurePrivateDirectory(directory: string): void {
  let created = false
  try {
    fs.mkdirSync(directory, { mode: DIRECTORY_MODE })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw publicationStoreError('publication storage directory could not be created')
    }
  }
  assertPrivateDirectory(directory)
  if (created) fsyncDirectory(path.dirname(directory))
}

function ensurePrivateDirectoryTree(directory: string): void {
  const missing: string[] = []
  let current = path.resolve(directory)
  while (true) {
    try {
      const lexical = fs.lstatSync(current)
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
        throw publicationStoreError('publication storage ancestor is not a directory')
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(current)
      const parent = path.dirname(current)
      if (parent === current) throw publicationStoreError('publication storage has no usable ancestor')
      current = parent
    }
  }
  for (const component of missing.reverse()) ensurePrivateDirectory(component)
  assertPrivateDirectory(directory)
}

function assertStableIdentity(before: fs.BigIntStats, after: fs.BigIntStats, label: string): void {
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.nlink !== after.nlink
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs) {
    throw publicationStoreError(`${label} changed while it was being read`)
  }
}

function readCompleteFile(descriptor: number, size: number, label: string): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset)
    if (read === 0) throw publicationStoreError(`${label} is incomplete`)
    offset += read
  }
  return bytes
}

function readPrivateRecord(filePath: string, label: string, maximumBytes?: number): Buffer {
  let descriptor: number | null = null
  try {
    const lexical = fs.lstatSync(filePath)
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1) {
      throw publicationStoreError(`${label} is not one private regular file`)
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW)
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) {
      throw publicationStoreError(`${label} is not one private regular file`)
    }
    if (Number(before.mode & 0o777n) !== FILE_MODE) {
      throw publicationStoreError(`${label} permissions are not private`)
    }
    const size = Number(before.size)
    if (!Number.isSafeInteger(size) || size < 0 || (maximumBytes !== undefined && size > maximumBytes)) {
      throw publicationStoreError(`${label} exceeds its byte limit`)
    }
    const bytes = readCompleteFile(descriptor, size, label)
    assertStableIdentity(before, fs.fstatSync(descriptor, { bigint: true }), label)
    return bytes
  } catch (error) {
    if (error instanceof PublicationStoreError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw publicationStoreError(`${label} is unavailable or unsafe`)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function parseJsonRecord<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    value = JSON.parse(text)
  } catch {
    throw publicationStoreError(`${label} is not valid UTF-8 JSON`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw publicationStoreError(`${label} does not match its strict contract`)
  return parsed.data
}

function writeDescriptor(descriptor: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    if (written <= 0) throw publicationStoreError('publication record write did not make progress')
    offset += written
  }
}

function assertImmutableTarget(target: string, label: string): void {
  try {
    const lexical = fs.lstatSync(target)
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1) {
      throw publicationStoreError(`${label} target is unsafe`)
    }
  } catch (error) {
    if (error instanceof PublicationStoreError) throw error
    throw publicationStoreError(`${label} target could not be inspected safely`)
  }
}

function exclusiveWrite(directory: string, target: string, bytes: Buffer, label: string): void {
  let descriptor: number | null = null
  let targetCreated = false
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      FILE_MODE,
    )
    targetCreated = true
    fs.fchmodSync(descriptor, FILE_MODE)
    writeDescriptor(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fsyncDirectory(directory)
  } catch (error) {
    if (!targetCreated && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      assertImmutableTarget(target, label)
      throw new ExclusiveRecordExistsError(`${label} already exists and is immutable`)
    }
    if (error instanceof ExclusiveRecordExistsError) throw error
    throw new ExclusiveRecordWriteError(`${label} could not be created durably`, targetCreated)
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The operation already fails; the immutable target remains a blocker.
      }
    }
  }
}

export function publicationRecordBytes(value: unknown): Buffer {
  // The final newline is a completion marker for directly created immutable records.
  // Canonical JSON never contains a literal newline, so a concurrent reader can
  // distinguish an unfinished write from a complete malformed record.
  return Buffer.from(`${stableCanonicalJson(value)}\n`, 'utf8')
}

export function isMissingPublicationRecord(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class PublicationPrivateRecords {
  readonly root: string
  private readonly sessionDirectory: string

  constructor(
    readonly rootSessionId: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly settlement: PublicationRecordSettlementPolicy | null,
  ) {
    assertPosixSupport()
    if (typeof rootSessionId !== 'string' || rootSessionId.length === 0 || rootSessionId.includes('\0')) {
      throw publicationStoreError('root session ID is invalid')
    }
    if (settlement !== null
      && (!Number.isSafeInteger(settlement.attempts) || settlement.attempts <= 0
        || settlement.attempts > MAX_PUBLICATION_RECORD_SETTLE_ATTEMPTS
        || !Number.isSafeInteger(settlement.delay_ms) || settlement.delay_ms <= 0
        || settlement.delay_ms > MAX_PUBLICATION_RECORD_SETTLE_DELAY_MS
        || !Number.isSafeInteger(settlement.timeout_ms) || settlement.timeout_ms <= 0
        || settlement.timeout_ms > MAX_PUBLICATION_RECORD_SETTLE_TIMEOUT_MS)) {
      throw publicationStoreError('publication record settlement policy is invalid')
    }
    this.sessionDirectory = getSessionRuntimeDir(rootSessionId, env)
    this.root = path.join(this.sessionDirectory, 'publication')
    if (this.settlement !== null) this.ensureLayout()
  }

  ensureLayout(): PublicationStoreLayout {
    if (this.settlement === null) {
      const layout = this.existingLayout()
      if (layout === null) throw publicationStoreError('publication storage does not exist')
      return layout
    }
    const configDirectory = path.resolve(getConfigDir(this.env))
    ensurePrivateDirectoryTree(configDirectory)
    const relativeSession = path.relative(configDirectory, this.sessionDirectory)
    if (relativeSession.startsWith('..') || path.isAbsolute(relativeSession)) {
      throw publicationStoreError('publication session storage is outside the config directory')
    }
    let current = configDirectory
    for (const segment of relativeSession.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      ensurePrivateDirectory(current)
    }
    ensurePrivateDirectory(this.root)
    const layout = this.layoutPaths()
    ensurePrivateDirectory(layout.artifacts)
    ensurePrivateDirectory(layout.artifactSlots)
    ensurePrivateDirectory(layout.claims)
    ensurePrivateDirectory(layout.executions)
    return layout
  }

  existingLayout(): PublicationStoreLayout | null {
    try {
      fs.lstatSync(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw publicationStoreError('publication storage component is unavailable')
    }

    const configDirectory = path.resolve(getConfigDir(this.env))
    const relativeSession = path.relative(configDirectory, this.sessionDirectory)
    if (relativeSession.startsWith('..') || path.isAbsolute(relativeSession)) {
      throw publicationStoreError('publication session storage is outside the config directory')
    }
    assertExistingPrivateDirectory(configDirectory)
    let current = configDirectory
    for (const segment of relativeSession.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      assertExistingPrivateDirectory(current)
    }
    const layout = this.layoutPaths()
    assertExistingPrivateDirectory(layout.root)
    assertExistingPrivateDirectory(layout.artifacts)
    assertExistingPrivateDirectory(layout.artifactSlots)
    assertExistingPrivateDirectory(layout.claims)
    assertExistingPrivateDirectory(layout.executions)
    return layout
  }

  createPrivateDirectory(directory: string, label: string): void {
    try {
      fs.mkdirSync(directory, { mode: DIRECTORY_MODE })
      assertPrivateDirectory(directory)
      fsyncDirectory(path.dirname(directory))
    } catch (error) {
      if (error instanceof PublicationStoreError) throw error
      throw publicationStoreError(`${label} could not be created durably`)
    }
  }

  existingPrivateDirectory(directory: string): string {
    assertExistingPrivateDirectory(directory)
    return directory
  }

  readJsonRecord<T>(filePath: string, schema: z.ZodType<T>, label: string, maximumBytes?: number): T {
    return parseJsonRecord(readPrivateRecord(filePath, label, maximumBytes), schema, label)
  }

  readPotentiallyIncompleteJsonRecord<T>(
    filePath: string,
    schema: z.ZodType<T>,
    label: string,
    maximumBytes?: number,
  ): T {
    return parseJsonRecord(
      this.readPotentiallyIncompleteRecord(filePath, label, maximumBytes),
      schema,
      label,
    )
  }

  readPotentiallyIncompleteRecord(filePath: string, label: string, maximumBytes?: number): Buffer {
    let bytes: Buffer
    try {
      bytes = readPrivateRecord(filePath, label, maximumBytes)
    } catch (error) {
      if (error instanceof PublicationStoreError
        && (error.message === `${label} is incomplete`
          || error.message === `${label} changed while it was being read`)) {
        throw new IncompletePublicationRecordError(`${label} is incomplete`)
      }
      throw error
    }
    if (bytes.at(-1) !== 0x0a) throw new IncompletePublicationRecordError(`${label} is incomplete`)
    return bytes
  }

  parseJsonRecord<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
    return parseJsonRecord(bytes, schema, label)
  }

  readRecord(filePath: string, label: string, maximumBytes?: number): Buffer {
    return readPrivateRecord(filePath, label, maximumBytes)
  }

  writeExclusive(directory: string, target: string, bytes: Buffer, label: string): void {
    exclusiveWrite(directory, target, bytes, label)
  }

  listNames(directory: string): string[] {
    return fs.readdirSync(directory)
  }

  recordExists(filePath: string): boolean {
    return fs.existsSync(filePath)
  }

  removeRecord(filePath: string): void {
    fs.unlinkSync(filePath)
  }

  removeDirectory(directory: string): void {
    fs.rmdirSync(directory)
  }

  synchronizeDirectory(directory: string): void {
    fsyncDirectory(directory)
  }

  async readSettledState<T>(reader: () => T | Promise<T>): Promise<T> {
    if (this.settlement === null) return reader()
    const startedAt = performance.now()
    for (let attempt = 1; attempt <= this.settlement.attempts; attempt += 1) {
      try {
        return await reader()
      } catch (error) {
        if (!(error instanceof IncompletePublicationRecordError)) throw error
        const elapsed = performance.now() - startedAt
        if (attempt >= this.settlement.attempts || elapsed >= this.settlement.timeout_ms) throw error
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(this.settlement!.delay_ms, this.settlement!.timeout_ms - elapsed))
        })
        if (performance.now() - startedAt >= this.settlement.timeout_ms) throw error
      }
    }
    throw publicationStoreError('publication record settlement attempts were exhausted')
  }

  layoutPaths(): PublicationStoreLayout {
    return {
      root: this.root,
      artifacts: path.join(this.root, 'artifacts'),
      artifactSlots: path.join(this.root, 'artifact-slots'),
      claims: path.join(this.root, 'claims'),
      executions: path.join(this.root, 'executions'),
    }
  }
}
