import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { BoundedFileService } from '../../lib/bounded-file-service.ts'

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
})
