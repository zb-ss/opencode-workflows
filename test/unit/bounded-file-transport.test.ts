import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { listBoundedDirectory, readBoundedFile, writeBoundedFile } from '../../lib/bounded-file-transport.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(): { worktree: string; directory: string } {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-file-transport-'))
  temporaryDirectories.push(worktree)
  const directory = path.join(worktree, 'app')
  fs.mkdirSync(directory)
  return { worktree, directory }
}

describe('bounded file transport', () => {
  it('preserves modes and creates verified parent directories', () => {
    const { worktree, directory } = fixture()
    const source = path.join(directory, 'source.ts')
    fs.writeFileSync(source, 'export const value = true\n')
    fs.chmodSync(source, 0o755)

    writeBoundedFile(source, 'export const value = false\n', worktree)
    assert.equal(fs.readFileSync(source, 'utf8'), 'export const value = false\n')
    assert.equal(fs.statSync(source).mode & 0o777, 0o755)

    const nested = path.join(directory, 'new-module', 'nested', 'index.ts')
    writeBoundedFile(nested, 'export const nested = true\n', worktree)
    assert.equal(fs.readFileSync(nested, 'utf8'), 'export const nested = true\n')
  })

  it('returns boundary-safe UTF-8 and rejects malformed input', () => {
    const { worktree, directory } = fixture()
    const unicodeFile = path.join(directory, 'unicode.txt')
    writeBoundedFile(unicodeFile, 'AéB', worktree)

    assert.deepEqual(readBoundedFile(unicodeFile, 0, 2, worktree), {
      content: 'A',
      eof: false,
      next_offset: 1,
    })
    assert.deepEqual(readBoundedFile(unicodeFile, 1, 2, worktree), {
      content: 'é',
      eof: false,
      next_offset: 3,
    })
    assert.throws(() => readBoundedFile(unicodeFile, 2, 2, worktree), /UTF-8 character boundary/)
    assert.throws(() => readBoundedFile(unicodeFile, 5, 2, worktree), /beyond end of file/)

    const invalidUtf8 = path.join(directory, 'invalid.txt')
    for (const invalid of [
      [0x41, 0xff],
      [0x41, 0xc3, 0x42],
      [0x41, 0xe0, 0x80],
      [0x41, 0xed, 0xa0],
      [0x41, 0xf0, 0x80],
      [0x41, 0xf4, 0x90],
    ]) {
      fs.writeFileSync(invalidUtf8, Buffer.from(invalid))
      assert.throws(() => readBoundedFile(invalidUtf8, 0, invalid.length, worktree), /not valid UTF-8/)
    }
  })

  it('rejects credential content and hard-linked reads without truncating linked writes', () => {
    const { worktree, directory } = fixture()
    const credentialSource = path.join(directory, 'credential-source.ts')
    fs.writeFileSync(credentialSource, 'const password = "supersecret"\n')
    assert.throws(() => readBoundedFile(credentialSource, 0, 100, worktree), /credential-like file content/)

    for (const token of [
      ['github', 'pat', '1234567890abcdefghijABCDEFGHIJ'].join('_'),
      'eyJabcdefghijk.ABCDEFGHIJK.1234567890ab',
      'postgres://user:supersecret@localhost/database',
    ]) {
      fs.writeFileSync(credentialSource, `export const value = '${token}'\n`)
      assert.throws(() => readBoundedFile(credentialSource, 0, 200, worktree), /credential-like file content/)
    }

    const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-hard-link-'))
    temporaryDirectories.push(externalDirectory)
    const externalFile = path.join(externalDirectory, 'credential.txt')
    const hardLink = path.join(directory, 'ordinary.txt')
    fs.writeFileSync(externalFile, 'external secret\n')
    fs.linkSync(externalFile, hardLink)
    assert.throws(() => readBoundedFile(hardLink, 0, 100, worktree), /hard-linked/)

    writeBoundedFile(hardLink, 'safe replacement\n', worktree)
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external secret\n')
    assert.equal(fs.readFileSync(hardLink, 'utf8'), 'safe replacement\n')
  })

  it('lists through the opened target descriptor and caps enumeration', () => {
    const { worktree, directory } = fixture()
    fs.writeFileSync(path.join(directory, 'b.ts'), '')
    fs.writeFileSync(path.join(directory, 'a.ts'), '')
    fs.writeFileSync(path.join(directory, 'ignored.bin'), '')

    const limited = listBoundedDirectory(directory, worktree, 1, (entry) => entry.name.endsWith('.ts'))
    assert.equal(limited.entries.length, 1)
    assert.equal(limited.entries[0]?.type, 'file')
    assert.equal(limited.truncated, true)
    assert.deepEqual(listBoundedDirectory(directory, worktree, 10, (entry) => entry.name.endsWith('.ts')), {
      entries: [
        { name: 'a.ts', type: 'file' },
        { name: 'b.ts', type: 'file' },
      ],
      truncated: false,
    })
    assert.deepEqual(listBoundedDirectory(worktree, worktree, 1, () => true), {
      entries: [{ name: 'app', type: 'directory' }],
      truncated: false,
    })
  })

  it('rejects descriptor paths rebound to another in-worktree directory', () => {
    const { worktree } = fixture()
    const protectedDirectory = path.join(worktree, '.github', 'nested')
    fs.mkdirSync(protectedDirectory, { recursive: true })
    fs.symlinkSync(path.join(worktree, '.github'), path.join(worktree, 'redirect'))

    assert.throws(
      () => listBoundedDirectory(path.join(worktree, 'redirect', 'nested'), worktree, 1, () => true),
      /path changed during access/,
    )
  })
})
