import fs from 'node:fs'

import { openEpicStore } from '../../lib/epic-persistence.ts'

const [configDir, projectRoot, stateFile, expectedRevision, expectedSha, barrier, writerId] = process.argv.slice(2)
if (!configDir || !projectRoot || !stateFile || !expectedRevision || !expectedSha || !barrier || !writerId) process.exit(2)

try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as unknown
  fs.writeFileSync(`${barrier}/ready-${writerId}`, '')
  while (!fs.existsSync(`${barrier}/go`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
  const store = openEpicStore({
    root_session_id: 'session-1', project_root: projectRoot, epic_id: 'epic-1', runtime_incarnation: 'race-runtime', mode: 'read_write',
    config: {
      enabled: true, max_epic_items: 8, max_item_dependencies: 4, max_attempts_per_item: 3, max_budget_records: 16,
      executor_agent: 'executor-example', executor_model_tier: 'mid', reviewer_agent: 'reviewer-example', reviewer_model_tier: 'mid',
      max_parallel_sessions: 2, max_attempt_duration_ms: 60_000, active_time_checkpoint_ms: 10_000, max_result_bytes: 65_536,
      retry_policy: {
        max_semantic_attempts: 3, max_contract_attempts: 3, max_transport_attempts: 3, max_no_progress_attempts: 2,
        transport_backoff: { strategy: 'exponential', initial_delay_ms: 100, maximum_delay_ms: 1_000, multiplier: 2 },
      },
    },
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
  })
  store.append(state, Number(expectedRevision), expectedSha, 1)
  process.stdout.write('won')
} catch (error) {
  process.stdout.write((error as { code?: string }).code ?? 'error')
  process.exitCode = 1
}
