import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { BoundedFileService } from '../../lib/bounded-file-service.ts'
import { acquireProjectReviewLease } from '../../lib/project-mutation-lease.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('BoundedFileService', () => {
  it('fits long directory entries to the exact serialized byte reservation', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-file-service-'))
    temporaryDirectories.push(worktree)
    fs.writeFileSync(path.join(worktree, `${'a'.repeat(200)}.ts`), '')
    let chargedBytes = 0
    const owner = {
      usesBoundedAutonomy: () => true,
      snapshot: () => ({
        status: 'running',
        worktree,
        directory: worktree,
        root_session_id: 'root',
      }) as any,
      reserveBoundedIo: async () => ({
        size: () => 100,
        adjust: async (bytes: number) => { chargedBytes = bytes },
        commit: async () => undefined,
        cancel: async () => undefined,
      }),
    }
    const service = new BoundedFileService(() => owner)
    const output = await service.list({}, {
      sessionID: 'child',
      async ask() {},
    } as any)
    const result = JSON.parse(output)

    assert.deepEqual(result.entries, [])
    assert.equal(result.truncated, true)
    assert.equal(Buffer.byteLength(output, 'utf8') <= 100, true)
    assert.equal(chargedBytes, Buffer.byteLength(output, 'utf8'))
  })

  it('does not interleave bounded workflow writes with a fixed-point review lease', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-file-service-lease-'))
    temporaryDirectories.push(worktree)
    const target = path.join(worktree, 'source.ts')
    fs.writeFileSync(target, 'export const value = false\n')
    const owner = {
      usesBoundedAutonomy: () => true,
      snapshot: () => ({
        status: 'running',
        worktree,
        directory: worktree,
        root_session_id: 'root',
      }) as any,
      reserveBoundedIo: async () => ({
        size: () => 100,
        adjust: async () => undefined,
        commit: async () => undefined,
        cancel: async () => undefined,
      }),
    }
    const service = new BoundedFileService(() => owner)
    const context = { sessionID: 'child', async ask() {} } as any
    const release = acquireProjectReviewLease(worktree)
    try {
      await assert.rejects(
        service.write({ path: 'source.ts', content: 'export const value = true\n' }, context),
        /locked for fixed-point review/,
      )
      assert.equal(fs.readFileSync(target, 'utf8'), 'export const value = false\n')
    } finally {
      release()
    }

    await service.write({ path: 'source.ts', content: 'export const value = true\n' }, context)
    assert.equal(fs.readFileSync(target, 'utf8'), 'export const value = true\n')
  })
})
