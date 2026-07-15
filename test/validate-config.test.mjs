import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { validateFile } from '../script/validate-config.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('configuration validator semantics', () => {
  it('rejects duplicate fixed-point reviewer IDs before runtime loading', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'))
    temporaryDirectories.push(directory)
    const source = JSON.parse(fs.readFileSync(path.resolve('workflows.json.template'), 'utf8'))
    source.review_loop = {
      enabled: false,
      reviewers: [
        { id: 'duplicate', agent: 'wf-reviewer', always: true, risk_tags: [], focus: 'Review.' },
        { id: 'duplicate', agent: 'wf-security', always: false, risk_tags: ['security'], focus: 'Secure.' },
      ],
    }
    const target = path.join(directory, 'workflows.json')
    fs.writeFileSync(target, JSON.stringify(source))

    assert.throws(
      () => validateFile(target, path.resolve('schema/workflows.schema.json')),
      /duplicate review_loop reviewer ID: duplicate/,
    )
  })
})
