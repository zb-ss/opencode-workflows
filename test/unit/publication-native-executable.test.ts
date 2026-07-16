import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { assertNativePublicationExecutable } from '../../lib/publication-native-executable.ts'

const NATIVE_HEADERS = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
  [0xca, 0xfe, 0xba, 0xbf],
  [0xbf, 0xba, 0xfe, 0xca],
] as const

function withDescriptor(bytes: readonly number[], callback: (descriptor: number) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-native-'))
  const target = path.join(directory, 'candidate')
  fs.writeFileSync(target, Buffer.from(bytes))
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY)
  try {
    callback(descriptor)
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

describe('publication native executable validation', () => {
  it('accepts supported ELF and Mach-O headers', () => {
    for (const header of NATIVE_HEADERS) {
      withDescriptor(header, descriptor => {
        assert.doesNotThrow(() => assertNativePublicationExecutable(descriptor, 'publisher'))
      })
    }
  })

  it('rejects shebangs, unsupported headers, and truncated files', () => {
    for (const header of [[0x23, 0x21, 0x2f, 0x62], [0x4d, 0x5a, 0x90, 0x00], [0x7f, 0x45]]) {
      withDescriptor(header, descriptor => {
        assert.throws(
          () => assertNativePublicationExecutable(descriptor, 'publisher'),
          /supported native executable/,
        )
      })
    }
  })
})
