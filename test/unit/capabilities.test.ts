import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertRequiredCapabilities, detectCapabilities } from '../../lib/capabilities.ts'
import { WorkflowConfigSchema } from '../../lib/workflow-config.ts'

function configWithModes(modes: Record<string, 'disabled' | 'auto' | 'required'>) {
  return WorkflowConfigSchema.parse({ experimental_capabilities: modes })
}

describe('runtime capability detection', () => {
  it('activates automatic capabilities only when their environment flag is enabled', () => {
    const config = configWithModes({
      background_subagents: 'auto',
      native_workspaces: 'disabled',
      plugin_v2: 'auto',
      mcp_code_mode: 'auto',
      references: 'required',
    })
    const report = detectCapabilities(config, {
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
      OPENCODE_EXPERIMENTAL_CODE_MODE: '0',
      OPENCODE_EXPERIMENTAL_REFERENCES: '1',
    })

    assert.equal(report.background_subagents.active, true)
    assert.equal(report.native_workspaces.active, false)
    assert.equal(report.mcp_code_mode.available, false)
    assert.equal(report.references.active, true)
    assert.equal(report.plugin_v2.available, true)
    assert.equal(report.plugin_v2.active, true)
  })

  it('rejects a required capability that is unavailable', () => {
    const report = detectCapabilities(configWithModes({ native_workspaces: 'required' }), {})
    assert.throws(
      () => assertRequiredCapabilities(report),
      /native_workspaces \(OPENCODE_EXPERIMENTAL\)/,
    )
  })

  it('uses the broad experimental flag only when a capability flag is absent', () => {
    const config = configWithModes({
      background_subagents: 'required',
      native_workspaces: 'required',
    })
    const report = detectCapabilities(config, {
      OPENCODE_EXPERIMENTAL: 'true',
      OPENCODE_EXPERIMENTAL_WORKSPACES: 'false',
    })

    assert.equal(report.background_subagents.available, true)
    assert.equal(report.background_subagents.source, 'OPENCODE_EXPERIMENTAL')
    assert.equal(report.native_workspaces.available, false)
    assert.equal(report.native_workspaces.source, 'OPENCODE_EXPERIMENTAL_WORKSPACES')
  })
})
