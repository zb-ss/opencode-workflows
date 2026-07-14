import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  delete process.env.OPENCODE_CONFIG_DIR
})

describe('workflow state isolation', () => {
  it('does not fall back to another active workflow for an unbound session', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-'))
    temporaryDirectories.push(configDir)
    process.env.OPENCODE_CONFIG_DIR = configDir
    const state = await import(`../../lib/state.ts?test=${Date.now()}`)
    fs.mkdirSync(state.ACTIVE_DIR, { recursive: true })
    state.writeState(path.join(state.ACTIVE_DIR, 'active.state.json'), {
      workflow_id: 'workflow-1',
      workflow_type: 'feature',
      phase: { current: 'planning', completed: [], remaining: ['planning'] },
      gates: { planning: { status: 'pending', iteration: 0 } },
      agent_log: [],
      mode: { current: 'standard' },
      updated_at: new Date().toISOString(),
    })
    assert.equal(state.getWorkflowForSession('unbound-session'), null)
  })
})
