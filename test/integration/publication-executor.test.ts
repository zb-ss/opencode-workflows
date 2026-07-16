import assert from 'node:assert/strict'
import type { SpawnOptions } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'

import {
  executePublication,
  publicationRequestAcknowledgment,
  type PreparedPublicationPublisher,
  type PublicationChildProcess,
  type PublicationPublisher,
  type PublicationSpawn,
  validatePublisher,
} from '../../lib/publication-executor.ts'

const SHA256SUM = ['/usr/bin/sha256sum', '/bin/sha256sum'].find(candidate => fs.existsSync(candidate))
  ?? '/usr/bin/sha256sum'
const YES = ['/usr/bin/yes', '/bin/yes'].find(candidate => fs.existsSync(candidate)) ?? '/usr/bin/yes'
const ECHO = ['/usr/bin/echo', '/bin/echo'].find(candidate => fs.existsSync(candidate)) ?? '/bin/echo'
const ROOT_SCRIPT = ['/usr/bin/ldd', '/bin/ldd'].find(candidate => fs.existsSync(candidate))
const HAS_TRUSTED_UTILITIES = fs.existsSync(SHA256SUM) && fs.existsSync(YES)
  && fs.existsSync(ECHO) && process.platform !== 'win32'
const REQUEST_ARGUMENT = '{request_file}'
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')
const temporaryDirectories = new Set<string>()

interface Fixture {
  root: string
  worktree: string
  marker: string
  env: NodeJS.ProcessEnv
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.publication-executor-'))
  temporaryDirectories.add(root)
  const worktree = path.join(root, 'worktree')
  fs.mkdirSync(worktree, { mode: 0o700 })
  const marker = path.join(root, 'published.marker')
  return {
    root,
    worktree,
    marker,
    env: {
      PATH: process.env.PATH,
      PUBLICATION_MARKER: marker,
      PUBLICATION_ALLOWED: 'allowed-value',
      UNLISTED_PUBLICATION_SECRET: 'must-not-reach-publisher',
    },
  }
}

function publisher(
  testFixture: Fixture,
  executable: string = SHA256SUM,
  overrides: Partial<PublicationPublisher> = {},
): PublicationPublisher {
  return {
    argv: [executable, REQUEST_ARGUMENT],
    working_directory: '.',
    environment: ['PUBLICATION_MARKER', 'PUBLICATION_ALLOWED'],
    timeout_ms: 1000,
    max_output_bytes: 1024,
    success_exit_codes: [0],
    ...overrides,
  }
}

function prepare(
  testFixture: Fixture,
  executable: string = SHA256SUM,
  overrides: Partial<PublicationPublisher> = {},
): PreparedPublicationPublisher {
  return validatePublisher(
    publisher(testFixture, executable, overrides),
    testFixture.worktree,
    testFixture.env,
    process.platform,
  )
}

function inheritedDescriptorPath(descriptor: number): string {
  for (const root of ['/proc/self/fd', '/dev/fd']) {
    try {
      if (fs.statSync(root).isDirectory()) return path.join(root, String(descriptor))
    } catch {
      // Try the next supported descriptor filesystem.
    }
  }
  throw new Error('test requires a process descriptor filesystem')
}

function fakeChild(
  requestPipe: Writable,
  closeOnRequestFinish = true,
  acknowledgment: 'valid' | Buffer | null = 'valid',
): PublicationChildProcess {
  const child = new EventEmitter() as PublicationChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const acknowledgmentPipe = new PassThrough()
  const requestChunks: Buffer[] = []
  requestPipe.on('data', chunk => requestChunks.push(Buffer.from(chunk)))
  Object.assign(child, {
    pid: 999_999_999,
    stdout,
    stderr,
    stdio: [null, stdout, stderr, requestPipe, null, acknowledgmentPipe],
    kill: () => true,
    unref: () => child,
  })
  requestPipe.once('finish', () => {
    acknowledgmentPipe.end(acknowledgment === 'valid'
      ? publicationRequestAcknowledgment(Buffer.concat(requestChunks))
      : acknowledgment ?? undefined)
    if (closeOnRequestFinish) setImmediate(() => {
      stdout.end()
      stderr.end()
      child.emit('close', 0, null)
    })
  })
  return child
}

function outputChild(
  requestPipe: Writable,
  stdoutChunks: readonly string[],
  stderrChunks: readonly string[] = [],
  exitCode = 0,
): PublicationChildProcess {
  const child = fakeChild(requestPipe, false)
  const stdout = child.stdout as PassThrough
  const stderr = child.stderr as PassThrough
  requestPipe.once('finish', () => setImmediate(() => {
    for (const chunk of stdoutChunks) stdout.write(chunk)
    for (const chunk of stderrChunks) stderr.write(chunk)
    stdout.end()
    stderr.end()
    child.emit('close', exitCode, null)
  }))
  return child
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('publication executor integration', { concurrency: false, skip: !HAS_TRUSTED_UTILITIES }, () => {
  it('does not confirm success when a real executable ignores the fd3 request', async () => {
    const testFixture = fixture()
    const prepared = prepare(testFixture, ECHO)
    const request = Buffer.from('publisher request bytes')
    const result = await executePublication(
      prepared,
      request,
      new AbortController().signal,
    )

    assert.equal(result.status, 'ambiguous', JSON.stringify(result))
    assert.equal(result.exit_code, 0)
    assert.equal('stdout' in result, false)
    assert.equal('stderr' in result, false)
    const expectedOutput = `${inheritedDescriptorPath(3)}\n`
    assert.equal(result.stdout_sha256, crypto.createHash('sha256').update(expectedOutput).digest('hex'))
    assert.equal(result.stderr_sha256, EMPTY_SHA256)
    assert.equal(result.invocation_attempted, true)
    assert.equal(Object.isFrozen(prepared), true)
    assert.equal(Object.isFrozen(prepared.argv), true)
    assert.equal(Object.isFrozen(prepared.environment), true)
    assert.equal(Object.isFrozen(prepared.digests), true)
  })

  it('spawns only descriptor paths, no shell, fd3/fd5 pipes, and the executable as fd4', async () => {
    const testFixture = fixture()
    const prepared = prepare(testFixture)
    const delivered: Buffer[] = []
    const requestPipe = new PassThrough()
    requestPipe.on('data', chunk => delivered.push(Buffer.from(chunk)))
    let capturedCommand = ''
    let capturedArguments: readonly string[] = []
    let capturedOptions: SpawnOptions | undefined
    let inheritedExecutableIdentity: { device: string; inode: string } | undefined
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      capturedCommand = command
      capturedArguments = args
      capturedOptions = options
      const executableDescriptor = (options.stdio as unknown[])[4]
      if (typeof executableDescriptor === 'number') {
        const stat = fs.fstatSync(executableDescriptor, { bigint: true })
        inheritedExecutableIdentity = { device: stat.dev.toString(), inode: stat.ino.toString() }
      }
      return fakeChild(requestPipe)
    }) as unknown as PublicationSpawn
    const source = Uint8Array.from([1, 2, 3, 4])
    const pending = executePublication(prepared, source, new AbortController().signal, { spawn: spawnProcess })
    source.fill(9)
    const result = await pending

    assert.equal(result.status, 'succeeded')
    assert.equal(result.request_acknowledged, true)
    assert.equal(capturedCommand, inheritedDescriptorPath(4))
    assert.notEqual(capturedCommand, prepared.configured_executable)
    assert.notEqual(capturedCommand, prepared.executable)
    assert.deepEqual(capturedArguments, [inheritedDescriptorPath(3)])
    assert.equal(capturedOptions?.shell, false)
    assert.equal(capturedOptions?.detached, true)
    assert.match(String(capturedOptions?.cwd), /^(?:\/proc\/self\/fd|\/dev\/fd)\/\d+$/)
    assert.deepEqual(capturedOptions?.env, prepared.environment)
    assert.equal(capturedOptions?.env?.UNLISTED_PUBLICATION_SECRET, undefined)
    assert.deepEqual((capturedOptions?.stdio as unknown[]).slice(0, 4), ['ignore', 'pipe', 'pipe', 'pipe'])
    assert.equal(typeof (capturedOptions?.stdio as unknown[])[4], 'number')
    assert.equal((capturedOptions?.stdio as unknown[])[5], 'pipe')
    assert.deepEqual(inheritedExecutableIdentity, {
      device: prepared.executable_identity.device,
      inode: prepared.executable_identity.inode,
    })
    assert.deepEqual(Buffer.concat(delivered), Buffer.from([1, 2, 3, 4]))
  })

  it('requires an exact request-bound acknowledgment on fd5', async () => {
    const testFixture = fixture()
    for (const acknowledgment of [null, Buffer.from('wrong acknowledgment\n'), Buffer.alloc(4096)]) {
      const child = fakeChild(new PassThrough(), true, acknowledgment)
      const result = await executePublication(
        prepare(testFixture),
        Buffer.from('request'),
        new AbortController().signal,
        {
          spawn: (() => child) as unknown as PublicationSpawn,
          terminateProcess() {
            setImmediate(() => child.emit('close', null, 'SIGKILL'))
            return null
          },
        },
      )

      assert.equal(result.status, 'ambiguous')
      assert.equal(result.request_acknowledged, false)
    }
  })

  it('removes non-root-owned directories and loader controls from publisher authority', () => {
    const testFixture = fixture()
    const userDirectory = path.join(testFixture.root, 'user-bin')
    fs.mkdirSync(userDirectory, { mode: 0o755 })
    testFixture.env.PATH = `${userDirectory}${path.delimiter}${process.env.PATH ?? ''}`

    const prepared = prepare(testFixture)
    assert.equal(prepared.trusted_path.split(path.delimiter).includes(fs.realpathSync(userDirectory)), false)
    for (const directory of prepared.trusted_path.split(path.delimiter).filter(Boolean)) {
      const stat = fs.statSync(directory)
      assert.equal(stat.uid, 0)
      assert.equal(stat.mode & 0o022, 0)
    }
    assert.throws(
      () => prepare(testFixture, SHA256SUM, { environment: ['LD_PRELOAD'] }),
      /unique env-name allowlist/,
    )
    assert.throws(
      () => prepare(testFixture, SHA256SUM, { environment: ['DYLD_INSERT_LIBRARIES'] }),
      /unique env-name allowlist/,
    )
    assert.throws(
      () => prepare(testFixture, SHA256SUM, { environment: ['GIT_SSH_COMMAND'] }),
      /unique env-name allowlist/,
    )
    assert.throws(
      () => prepare(testFixture, SHA256SUM, { environment: ['HOME'] }),
      /unique env-name allowlist/,
    )
  })

  it('treats a request-pipe write error after spawn as ambiguous', async () => {
    const testFixture = fixture()
    const requestPipe = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(Object.assign(new Error('simulated request pipe failure'), { code: 'EPIPE' })))
      },
    })
    const child = fakeChild(requestPipe, false)
    const result = await executePublication(
      prepare(testFixture),
      Buffer.from('request'),
      new AbortController().signal,
      {
        spawn: (() => child) as unknown as PublicationSpawn,
        terminateProcess() {
          setImmediate(() => child.emit('close', null, 'SIGKILL'))
          return null
        },
      },
    )

    assert.equal(result.status, 'ambiguous')
    assert.equal(result.forced_status, null)
    assert.equal(result.invocation_attempted, true)
    assert.equal(result.spawn_uncertain, false)
  })

  it('hashes and scans complete observed streams without returning raw secrets', async () => {
    const stdout = `${'x'.repeat(64)}\npassword=supersecret`
    const stderr = 'publisher diagnostic'
    const testFixture = fixture()
    const child = outputChild(
      new PassThrough(),
      [`${'x'.repeat(64)}\npassword=su`, 'persecret'],
      [stderr],
    )
    const result = await executePublication(
      prepare(testFixture),
      Buffer.alloc(0),
      new AbortController().signal,
      { spawn: (() => child) as unknown as PublicationSpawn },
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(result.stdout_bytes, Buffer.byteLength(stdout))
    assert.equal(result.stderr_bytes, Buffer.byteLength(stderr))
    assert.equal(result.stdout_sha256, crypto.createHash('sha256').update(stdout).digest('hex'))
    assert.equal(result.stderr_sha256, crypto.createHash('sha256').update(stderr).digest('hex'))
    assert.equal(result.stdout_sensitive, true)
    assert.equal(result.output_sensitive, true)
    assert.equal(result.output_redacted, true)
    assert.equal(result.output_truncated, false)
    assert.doesNotMatch(JSON.stringify(result), /supersecret|password=/)
  })

  it('detects a maximum-length credential assignment across an internal scan boundary', async () => {
    const testFixture = fixture()
    const boundaryPrefix = `${'x'.repeat((64 * 1024) - 33)}\nDB_PASSWORD="`
    const credentialValue = 'a'.repeat(4096)
    const child = outputChild(new PassThrough(), [boundaryPrefix, `${credentialValue}"`])
    const result = await executePublication(
      prepare(testFixture, SHA256SUM, { max_output_bytes: 128 * 1024 }),
      Buffer.alloc(0),
      new AbortController().signal,
      { spawn: (() => child) as unknown as PublicationSpawn },
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(result.stdout_sensitive, true)
    assert.equal(result.output_redacted, true)
  })

  it('detects an oversized token whose character classes span multiple scan windows', async () => {
    const testFixture = fixture()
    const token = `${'a'.repeat(100_000)}${'A'.repeat(100_000)}${'1'.repeat(100_000)}`
    const child = outputChild(new PassThrough(), [token])
    const result = await executePublication(
      prepare(testFixture, SHA256SUM, { max_output_bytes: 512 * 1024 }),
      Buffer.alloc(0),
      new AbortController().signal,
      { spawn: (() => child) as unknown as PublicationSpawn },
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(result.stdout_sensitive, true)
    assert.equal(result.output_redacted, true)
  })

  it('kills the process group and returns output_limit once combined output exceeds the bound', async () => {
    const testFixture = fixture()
    const result = await executePublication(
      prepare(testFixture, YES, { max_output_bytes: 512 }),
      Buffer.alloc(0),
      new AbortController().signal,
    )

    assert.equal(result.status, 'ambiguous')
    assert.equal(result.forced_status, 'output_limit')
    assert.equal(result.invocation_attempted, true)
    assert.equal(result.output_truncated, true)
    assert.ok(result.stdout_bytes + result.stderr_bytes > 512)
    assert.match(result.stdout_sha256, /^[a-f0-9]{64}$/)
    assert.match(result.stderr_sha256, /^[a-f0-9]{64}$/)
  })

  it('returns ambiguous outcomes for timeout, cancellation, and uncertain termination', async () => {
    const testFixture = fixture()
    const timedChild = fakeChild(new PassThrough(), false)
    const timed = await executePublication(
      prepare(testFixture, SHA256SUM, { timeout_ms: 20 }),
      Buffer.alloc(0),
      new AbortController().signal,
      {
        spawn: (() => timedChild) as unknown as PublicationSpawn,
        terminateProcess() {
          setImmediate(() => timedChild.emit('close', null, 'SIGKILL'))
          return null
        },
      },
    )
    assert.equal(timed.status, 'ambiguous')
    assert.equal(timed.forced_status, 'timed_out')
    assert.equal(timed.invocation_attempted, true)

    const controller = new AbortController()
    const cancelledChild = fakeChild(new PassThrough(), false)
    const pending = executePublication(prepare(testFixture), Buffer.alloc(0), controller.signal, {
      spawn: (() => cancelledChild) as unknown as PublicationSpawn,
      terminateProcess() {
        setImmediate(() => cancelledChild.emit('close', null, 'SIGKILL'))
        return null
      },
    })
    setTimeout(() => controller.abort(), 20)
    const cancelled = await pending
    assert.equal(cancelled.status, 'ambiguous')
    assert.equal(cancelled.forced_status, 'cancelled')
    assert.equal(cancelled.invocation_attempted, true)

    const uncertainChild = fakeChild(new PassThrough(), false)
    const uncertain = await executePublication(
      prepare(testFixture, SHA256SUM, { timeout_ms: 20 }),
      Buffer.alloc(0),
      new AbortController().signal,
      {
        spawn: (() => uncertainChild) as unknown as PublicationSpawn,
        terminateProcess() {
          return new Error('simulated uncertain termination')
        },
      },
    )
    assert.equal(uncertain.status, 'ambiguous')
    assert.equal(uncertain.termination_uncertain, true)
    assert.equal(uncertain.output_truncated, true)

    const neverCloses = fakeChild(new PassThrough(), false)
    const watchdog = await executePublication(
      prepare(testFixture, SHA256SUM, { timeout_ms: 20 }),
      Buffer.alloc(0),
      new AbortController().signal,
      {
        spawn: (() => neverCloses) as unknown as PublicationSpawn,
        terminateProcess: () => null,
      },
    )
    assert.equal(watchdog.status, 'ambiguous')
    assert.equal(watchdog.forced_status, 'timed_out')
    assert.equal(watchdog.termination_uncertain, true)
    assert.equal(watchdog.output_truncated, true)
  })

  it('rejects extra argv resources, nonzero success codes, and oversized request bytes', async () => {
    const testFixture = fixture()
    assert.throws(
      () => prepare(testFixture, SHA256SUM, { argv: [SHA256SUM, '--binary', REQUEST_ARGUMENT] }),
      /argv must be exactly/,
    )
    assert.throws(
      () => prepare(testFixture, process.execPath, { argv: [process.execPath, '/tmp/script', REQUEST_ARGUMENT] }),
      /argv must be exactly/,
    )
    assert.throws(() => prepare(testFixture, SHA256SUM, { success_exit_codes: [7] }), /exactly \[0\]/)
    assert.throws(() => prepare(testFixture, SHA256SUM, { success_exit_codes: [0, 1] }), /exactly \[0\]/)
    await assert.rejects(
      executePublication(
        prepare(testFixture),
        new Uint8Array((1024 * 1024) + 1),
        new AbortController().signal,
      ),
      /1 MiB limit/,
    )
  })

  it('rejects untrusted executables, Windows, escaped cwd, and changed executable or cwd identities', async () => {
    const testFixture = fixture()
    const insideWorktree = path.join(testFixture.worktree, 'publisher')
    fs.writeFileSync(insideWorktree, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o700 })
    assert.throws(
      () => prepare(testFixture, insideWorktree),
      /trusted external regular file/,
    )
    assert.throws(
      () => validatePublisher(publisher(testFixture), testFixture.worktree, testFixture.env, 'win32'),
      /unavailable on Windows/,
    )
    assert.throws(() => prepare(testFixture, SHA256SUM, { working_directory: '..' }), /worktree-relative/)

    const adapter = path.join(testFixture.root, 'publisher-adapter')
    fs.writeFileSync(adapter, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o500 })
    assert.throws(() => prepare(testFixture, adapter), /root-owned/)
    if (ROOT_SCRIPT) {
      assert.throws(() => prepare(testFixture, ROOT_SCRIPT), /supported native executable/)
    }

    const cwd = path.join(testFixture.worktree, 'publisher-cwd')
    fs.mkdirSync(cwd)
    const preparedDirectory = prepare(testFixture, SHA256SUM, { working_directory: 'publisher-cwd' })
    fs.renameSync(cwd, `${cwd}-original`)
    fs.mkdirSync(cwd)
    await assert.rejects(
      executePublication(preparedDirectory, Buffer.alloc(0), new AbortController().signal),
      /working directory identity changed/,
    )
  })

  it('never treats a nonzero publisher exit as success', async () => {
    const testFixture = fixture()
    const child = outputChild(new PassThrough(), [], [], 7)
    const result = await executePublication(
      prepare(testFixture),
      Buffer.alloc(0),
      new AbortController().signal,
      { spawn: (() => child) as unknown as PublicationSpawn },
    )

    assert.equal(result.status, 'ambiguous')
    assert.equal(result.exit_code, 7)
    assert.equal(result.forced_status, null)
  })
})
