import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCliArgs } from '../../lib/task-router.ts'
import type { DelegationOrchestratorConfig } from '../../lib/types.ts'

function config(permissionMode?: string): DelegationOrchestratorConfig {
  return {
    claude: {},
    gemini: permissionMode ? { permission_mode: permissionMode } : {},
    max_parallel: 1,
    routing: { ui_patterns: [], default_provider: 'claude' },
    fallback_order: [],
    max_review_iterations: 1,
    auto_init_files: false,
    max_output_bytes: 1024,
  }
}

describe('delegation task router CLI arguments', () => {
  it('routes the gemini provider token to Antigravity without selecting a model', () => {
    assert.deepEqual(buildCliArgs('gemini', 'Review this UI', config()), {
      command: 'agy',
      args: ['--mode', 'accept-edits', '--print', 'Review this UI'],
    })
  })

  it('forwards only an explicit task model alias', () => {
    assert.deepEqual(buildCliArgs('gemini', 'Review this UI', config(), 'manual-model-alias'), {
      command: 'agy',
      args: ['--model', 'manual-model-alias', '--mode', 'accept-edits', '--print', 'Review this UI'],
    })
  })

  it('uses Antigravity unsafe mode only when explicitly configured', () => {
    assert.deepEqual(
      buildCliArgs('gemini', 'Implement this UI', config('dangerously-skip-permissions')),
      {
        command: 'agy',
        args: ['--dangerously-skip-permissions', '--mode', 'accept-edits', '--print', 'Implement this UI'],
      },
    )
  })
})
