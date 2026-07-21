import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  emptyAutomationUsageTelemetry,
  EPIC_SCHEMA_VERSION,
  projectIdentitySha256,
  type EpicState,
} from '../../lib/epic-contracts.ts'
import {
  EpicInputError,
  EpicMissingError,
  EpicStaleRevisionError,
  openEpicStore,
} from '../../lib/epic-persistence.ts'
import { getRuntimeDir } from '../../lib/paths.ts'
import { createEpicOwnerTools } from '../../plugin/epic-owner-tools.ts'

const CONFIG = {
  enabled: true,
  max_epic_items: 8,
  max_item_dependencies: 4,
  max_attempts_per_item: 3,
  max_budget_records: 32,
} as const
const RUNTIME = 'epic-owner-test-runtime'
const NOW = '2026-07-18T12:00:00.000Z'
const temporaryDirectories: string[] = []
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
})

function pluginInput(project: string, parentBySession: Record<string, string | undefined> = {}): PluginInput {
  return {
    client: {
      session: {
        get: async ({ path: inputPath }: { path: { id: string } }) => ({
          data: {
            id: inputPath.id,
            ...(parentBySession[inputPath.id] ? { parentID: parentBySession[inputPath.id] } : {}),
          },
        }),
      },
    },
    project: {},
    directory: project,
    worktree: project,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost'),
    $: () => {},
  } as unknown as PluginInput
}

function toolContext(
  project: string,
  sessionID = 'session-1',
  ask: ToolContext['ask'] = async () => {},
): ToolContext {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: 'supervisor',
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    metadata() {},
    ask,
  }
}

function state(project: string): EpicState {
  return {
    schema_version: EPIC_SCHEMA_VERSION,
    state_revision: 1,
    operational_limits: {
      max_epic_items: CONFIG.max_epic_items,
      max_item_dependencies: CONFIG.max_item_dependencies,
      max_attempts_per_item: CONFIG.max_attempts_per_item,
      max_budget_records: CONFIG.max_budget_records,
    },
    epic_id: 'epic-1',
    root_session_id: 'session-1',
    project_identity_sha256: projectIdentitySha256(fs.realpathSync(project)),
    base_branch: 'refs/heads/base',
    integration_branch: 'refs/heads/integration',
    status: 'pending',
    pause_reason: null,
    created_at: NOW,
    updated_at: NOW,
    items: {
      item: {
        item_id: 'item', dependencies: [], scope: 'Neutral owner-tool fixture.', status: 'pending', attempts: [],
        selected_attempt_id: null, worktree_name: null, branch_name: null, checkpoint_commit: null,
        review_evidence_digest: null, conflict_paths: [], integration_commit: null, completed_at: null,
      },
    },
    integration_log: [],
    budgets: [{ dimension: 'sessions', scope: 'epic', item_id: null, limit: 2, extensions: [] }],
    usage: [
      { scope: 'epic', item_id: null, usage: emptyAutomationUsageTelemetry() },
      { scope: 'item', item_id: 'item', usage: emptyAutomationUsageTelemetry() },
    ],
    budget_updates: [],
  }
}

function fixture(parentBySession: Record<string, string | undefined> = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-owner-config-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-owner-project-'))
  temporaryDirectories.push(configDir, project)
  process.env.OPENCODE_CONFIG_DIR = configDir
  fs.writeFileSync(path.join(configDir, 'workflows.json'), JSON.stringify({ epic: CONFIG }))
  const store = openEpicStore({
    root_session_id: 'session-1', project_root: project, epic_id: 'epic-1', config: CONFIG,
    runtime_incarnation: RUNTIME, mode: 'read_write',
  })
  const initial = store.append(state(project), 0, null, 1)!
  return { configDir, project, store, initial, input: pluginInput(project, parentBySession) }
}

function updateArgs(revision: number, sha256: string, overrides: Record<string, unknown> = {}) {
  return {
    epic_id: 'epic-1', expected_revision: revision, expected_state_sha256: sha256, expected_generation: 1,
    update_id: 'update-1', dimension: 'output_tokens' as const, scope: 'epic' as const, item_id: null,
    new_limit: 100, reason: 'Owner-approved policy update.', ...overrides,
  }
}

describe('epic owner budget tools', () => {
  it('is a true disabled no-op before session or path verification', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-owner-disabled-'))
    temporaryDirectories.push(configDir)
    process.env.OPENCODE_CONFIG_DIR = configDir
    fs.writeFileSync(path.join(configDir, 'workflows.json'), JSON.stringify({ epic: { enabled: false } }))
    const hooks = await createEpicOwnerTools({ client: {} } as PluginInput, RUNTIME)
    const context = toolContext('/definitely/missing')

    const result = JSON.parse(await hooks.tool.epic_budget_update.execute(
      updateArgs(1, 'a'.repeat(64)),
      context,
    ) as string)

    assert.deepEqual(result, {
      updated: false,
      disabled: true,
      reason: 'epic.enabled is false in workflows.json',
    })
    assert.equal(fs.existsSync(getRuntimeDir()), false)
  })

  it('binds durable idempotent retries to the original CAS evidence', async () => {
    const test = fixture()
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)
    const args = updateArgs(test.initial.revision, test.initial.state_sha256)

    const first = JSON.parse(await hooks.tool.epic_budget_update.execute(args, context) as string)
    const retry = JSON.parse(await hooks.tool.epic_budget_update.execute(args, context) as string)
    const afterFirst = test.store.load()!
    await hooks.tool.epic_budget_update.execute(updateArgs(afterFirst.revision, afterFirst.state_sha256, {
      update_id: 'update-2', dimension: 'input_tokens', new_limit: 50,
    }), context)
    const delayedRetry = JSON.parse(await hooks.tool.epic_budget_update.execute(args, context) as string)
    const persisted = test.store.load()!

    assert.equal(first.updated, true)
    assert.equal(first.idempotent, false)
    assert.equal(retry.updated, false)
    assert.equal(retry.idempotent, true)
    assert.equal(delayedRetry.idempotent, true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].permission, 'epic_budget_update')
    assert.deepEqual(requests[0].always, [])
    assert.equal(persisted.revision, 3)
    assert.equal(persisted.state.budgets?.find(record => record.dimension === 'output_tokens')?.limit, 100)
    assert.equal(persisted.state.budget_updates[0]?.actor_session_id, 'session-1')
    assert.equal(JSON.stringify(first).includes('root_session_id'), false)

    await assert.rejects(
      hooks.tool.epic_budget_update.execute({ ...args, reason: 'Conflicting reuse.' }, context),
      EpicInputError,
    )
    await assert.rejects(
      hooks.tool.epic_budget_update.execute({ ...args, expected_state_sha256: 'f'.repeat(64) }, context),
      EpicStaleRevisionError,
    )
    await assert.rejects(
      hooks.tool.epic_budget_update.execute({ ...args, expected_generation: 2 }, context),
      EpicStaleRevisionError,
    )
    await assert.rejects(
      hooks.tool.epic_budget_update.execute({ ...args, update_id: 'update-stale' }, context),
      EpicStaleRevisionError,
    )
    assert.equal(requests.length, 2)
  })

  it('checkpoints open active-time intervals before update and extension policy changes', async () => {
    const test = fixture()
    const running = test.store.append({
      ...test.initial.state,
      state_revision: 2,
      status: 'running',
      usage: test.initial.state.usage.map(record => record.scope === 'epic' ? {
        ...record,
        usage: {
          ...record.usage,
          active_interval_started_at: NOW,
          last_active_checkpoint_at: NOW,
        },
      } : record),
    }, test.initial.revision, test.initial.state_sha256, 1)!
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)

    await hooks.tool.epic_budget_update.execute(updateArgs(running.revision, running.state_sha256), context)
    const afterUpdate = test.store.load()!
    await hooks.tool.epic_budget_extend.execute({
      ...updateArgs(afterUpdate.revision, afterUpdate.state_sha256, {
        update_id: 'running-extension-root', dimension: 'sessions', new_limit: 3,
      }),
      extension_id: 'running-extension',
    }, context)
    const persisted = test.store.load()!
    const epicUsage = persisted.state.usage.find(record => record.scope === 'epic')!.usage

    assert.ok(epicUsage.active_time_ms > 0)
    assert.notEqual(epicUsage.last_active_checkpoint_at, NOW)
    assert.deepEqual(requests.map(request => request.permission), ['epic_budget_update', 'epic_budget_extend'])
  })

  it('keeps extension evidence through later tightening, another extension, and explicit removal', async () => {
    const test = fixture()
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)
    let current = test.initial

    const extend = async (updateId: string, extensionId: string, newLimit: number) => {
      const result = await hooks.tool.epic_budget_extend.execute({
        ...updateArgs(current.revision, current.state_sha256, {
          update_id: updateId, dimension: 'sessions', new_limit: newLimit,
        }),
        extension_id: extensionId,
      }, context)
      assert.equal(JSON.parse(result as string).updated, true)
      current = test.store.load()!
    }
    const update = async (updateId: string, newLimit: number | null) => {
      const result = await hooks.tool.epic_budget_update.execute({
        ...updateArgs(current.revision, current.state_sha256, {
          update_id: updateId, dimension: 'sessions', new_limit: newLimit,
        }),
      }, context)
      assert.equal(JSON.parse(result as string).updated, true)
      current = test.store.load()!
    }

    await extend('root-extension-1', 'extension-1', 4)
    await update('tighten-1', 3)
    await extend('root-extension-2', 'extension-2', 5)
    await update('remove-1', null)

    const budget = current.state.budgets?.find(record => record.dimension === 'sessions')
    assert.equal(budget?.limit, null)
    assert.deepEqual(budget?.extensions.map(record => [record.previous_limit, record.new_limit]), [[2, 4], [3, 5]])
    assert.deepEqual(current.state.budget_updates.map(record => [record.previous_limit, record.new_limit]), [[2, 4], [4, 3], [3, 5], [5, null]])
    assert.deepEqual(requests.map(request => request.permission), [
      'epic_budget_extend', 'epic_budget_update', 'epic_budget_extend', 'epic_budget_update',
    ])
  })

  it('rejects numeric increases through update and non-increases through extension before approval', async () => {
    const test = fixture()
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)

    await assert.rejects(
      hooks.tool.epic_budget_update.execute(updateArgs(test.initial.revision, test.initial.state_sha256, {
        dimension: 'sessions', new_limit: 3,
      }), context),
      /numeric budget increases require an explicit extension/,
    )
    await assert.rejects(
      hooks.tool.epic_budget_extend.execute({
        ...updateArgs(test.initial.revision, test.initial.state_sha256, {
          dimension: 'sessions', new_limit: 1,
        }),
        extension_id: 'extension-1',
      }, context),
      /strict increase/,
    )
    assert.equal(requests.length, 0)
    assert.equal(test.store.load()?.revision, 1)
  })

  it('applies item-scoped policy only with matching telemetry', async () => {
    const test = fixture()
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })

    await hooks.tool.epic_budget_update.execute(updateArgs(test.initial.revision, test.initial.state_sha256, {
      scope: 'item', item_id: 'item', dimension: 'sessions', new_limit: 1,
    }), context)

    const itemBudget = test.store.load()?.state.budgets?.find(record => record.scope === 'item')
    assert.deepEqual(itemBudget && {
      item_id: itemBudget.item_id,
      dimension: itemBudget.dimension,
      limit: itemBudget.limit,
    }, { item_id: 'item', dimension: 'sessions', limit: 1 })
    assert.equal(requests[0].metadata.item_id, 'item')
  })

  it('requires attended recovery after an incarnation change and rejects escaped context paths', async () => {
    const test = fixture()
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext(test.project, 'session-1', async request => { requests.push(request) })
    const restarted = await createEpicOwnerTools(test.input, 'different-runtime-incarnation')

    await assert.rejects(
      restarted.tool.epic_budget_update.execute(
        updateArgs(test.initial.revision, test.initial.state_sha256),
        context,
      ),
      /attended restart reconciliation/,
    )
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-owner-outside-'))
    temporaryDirectories.push(outside)
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)
    await assert.rejects(
      hooks.tool.epic_budget_update.execute(
        updateArgs(test.initial.revision, test.initial.state_sha256),
        { ...context, directory: outside },
      ),
      /valid project worktree/,
    )
    assert.equal(requests.length, 0)
    assert.equal(test.store.load()?.revision, 1)
  })

  it('rejects child, foreign-owner, unverifiable, and denied invocations without mutation', async () => {
    const test = fixture({ 'session-child': 'session-1' })
    const hooks = await createEpicOwnerTools(test.input, RUNTIME)
    const args = updateArgs(test.initial.revision, test.initial.state_sha256)

    await assert.rejects(
      hooks.tool.epic_budget_update.execute(args, toolContext(test.project, 'session-child')),
      /restricted to root sessions/,
    )
    await assert.rejects(
      hooks.tool.epic_budget_update.execute(args, toolContext(test.project, 'session-2')),
      EpicMissingError,
    )
    const unverifiable = await createEpicOwnerTools({ client: {} } as PluginInput, RUNTIME)
    await assert.rejects(
      unverifiable.tool.epic_budget_update.execute(args, toolContext(test.project)),
      /unable to verify/,
    )
    await assert.rejects(
      hooks.tool.epic_budget_update.execute(args, toolContext(test.project, 'session-1', async () => {
        throw new Error('permission denied')
      })),
      /permission denied/,
    )
    assert.equal(test.store.load()?.revision, 1)
  })
})
