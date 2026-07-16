import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hooks-config-'))
const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hooks-worktree-'))
process.env.OPENCODE_CONFIG_DIR = configDir

const [
  { WorkflowEnforcer },
  { WorkflowNotifications },
  { ModelRouter },
  { FileValidator },
  state,
  logger,
] = await Promise.all([
  import('../../plugin/workflow-enforcer.ts'),
  import('../../plugin/workflow-notifications.ts'),
  import('../../plugin/model-router.ts'),
  import('../../plugin/file-validator.ts'),
  import('../../lib/state.ts'),
  import('../../lib/logger.ts'),
])

function pluginInput(): PluginInput {
  return {
    client: {},
    project: {},
    directory: worktree,
    worktree,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost'),
    $: () => {},
  } as unknown as PluginInput
}

function toolContext(
  sessionID: string,
  ask: ToolContext['ask'] = async () => {},
): ToolContext {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: 'test-agent',
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    ask,
  }
}

function sessionInfo(id: string, parentID?: string) {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: 'project-test',
    directory: worktree,
    title: 'Test session',
    version: '1.17.20',
    time: { created: 1, updated: 1 },
  }
}

function textPart(sessionID: string, text: string) {
  return {
    id: `part-${sessionID}`,
    sessionID,
    messageID: `message-${sessionID}`,
    type: 'text' as const,
    text,
    time: { start: 1, end: 2 },
  }
}

function writeWorkflow(
  fileName: string,
  gateStatus: 'pending' | 'passed',
  ownerSession = 'session-bound',
): string {
  fs.mkdirSync(state.ACTIVE_DIR, { recursive: true })
  const statePath = path.join(state.ACTIVE_DIR, fileName)
  const written = state.writeState(statePath, {
    workflow_id: fileName.replace('.state.json', ''),
    workflow_type: 'feature',
    phase: {
      current: gateStatus === 'passed' ? 'completed' : 'implementation',
      completed: gateStatus === 'passed' ? ['implementation'] : [],
      remaining: gateStatus === 'passed' ? [] : ['implementation'],
    },
    gates: { implementation: { status: gateStatus, iteration: gateStatus === 'passed' ? 1 : 0 } },
    agent_log: [],
    mode: { current: 'standard' },
    updated_at: new Date().toISOString(),
    task_ids: { implementation: 'task-1' },
    owner: {
      root_session_id: ownerSession,
      current_session_id: ownerSession,
      project_id: 'project-test',
      directory: worktree,
    },
  })
  assert.equal(written, true)
  return statePath
}

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
})

describe('OpenCode 1.17.20 production plugin hooks', () => {
  it('injects system and compaction context only for the exactly bound session', async () => {
    const statePath = writeWorkflow('workflow-bound.state.json', 'pending')
    assert.equal(state.bindSessionToWorkflow('session-bound', statePath, 'workflow-bound'), true)

    const enforcer = await WorkflowEnforcer(pluginInput())
    const router = await ModelRouter(pluginInput())
    const boundSystem = { system: [] as string[] }
    const unboundSystem = { system: [] as string[] }

    await enforcer['experimental.chat.system.transform']!(
      { sessionID: 'session-bound', model: {} as never },
      boundSystem,
    )
    await enforcer['experimental.chat.system.transform']!(
      { sessionID: 'session-unbound', model: {} as never },
      unboundSystem,
    )
    await router['experimental.chat.system.transform']!(
      { sessionID: 'session-bound', model: {} as never },
      boundSystem,
    )

    assert.equal(boundSystem.system.length, 2)
    assert.match(boundSystem.system[0], /Workflow ID: workflow-bound/)
    assert.match(boundSystem.system[1], /Preferred model tier: mid/)
    assert.deepEqual(unboundSystem.system, [])

    const compacting = { context: [] as string[], prompt: undefined }
    await enforcer['experimental.session.compacting']!({ sessionID: 'session-bound' }, compacting)
    const compactedContext = compacting.context.join('\n')
    assert.match(compactedContext, /Workflow ID: workflow-bound/)
    assert.match(compactedContext, /Current phase: implementation/)
    assert.match(compactedContext, /Pending gates: implementation/)
    assert.match(compactedContext, new RegExp(`State path: ${statePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(compactedContext, /Task IDs: implementation=task-1/)
    assert.match(compactedContext, /Worktree ownership: root session=session-bound/)
  })

  it('uses current event shapes and never falls back by workflow ID', async () => {
    const statePath = path.join(state.ACTIVE_DIR, 'workflow-bound.state.json')
    const enforcer = await WorkflowEnforcer(pluginInput())
    const notifications = await WorkflowNotifications(pluginInput())

    await enforcer.event!({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-bound', status: { type: 'idle' } },
      },
    })
    await enforcer.event!({
      event: {
        type: 'message.part.updated',
        properties: { part: textPart('session-bound', 'VERDICT: PASS - implementation') },
      },
    })
    await notifications.event!({
      event: {
        type: 'message.part.updated',
        properties: { part: textPart('session-bound', 'ordinary progress') },
      },
    })

    const getState = enforcer.tool!.workflow_get_state
    const unbound = JSON.parse(await getState.execute(
      { workflowId: 'workflow-bound' },
      toolContext('session-unbound'),
    ) as string)
    assert.deepEqual(unbound, { active: false })

    const updateGate = enforcer.tool!.workflow_update_gate
    assert.equal(await updateGate.execute({
      gateName: 'implementation',
      status: 'passed',
      workflowId: 'workflow-bound',
    }, toolContext('session-unbound')), 'No active workflow found')
    assert.equal(state.readState(statePath)?.gates.implementation.status, 'pending')

    await assert.rejects(
      getState.execute({ sessionId: 'another-session' }, toolContext('session-unbound')),
      /sessionId must match the current tool session/,
    )
  })

  it('binds native Task child sessions to the parent workflow', async () => {
    const statePath = writeWorkflow('workflow-child.state.json', 'pending')
    assert.equal(state.bindSessionToWorkflow('session-parent', statePath, 'workflow-child'), true)
    const enforcer = await WorkflowEnforcer(pluginInput())

    await enforcer.event!({
      event: { type: 'session.created', properties: { info: sessionInfo('session-child', 'session-parent') } },
    })

    assert.equal(state.getWorkflowForSession('session-child')?.state.workflow_id, 'workflow-child')
    const output = { system: [] as string[] }
    await enforcer['experimental.chat.system.transform']!(
      { sessionID: 'session-child', model: {} as never },
      output,
    )
    assert.match(output.system.join('\n'), /Workflow ID: workflow-child/)
    const denied = await enforcer.tool!.workflow_update_gate.execute({
      gateName: 'implementation',
      status: 'passed',
      workflowId: 'workflow-child',
    }, toolContext('session-child'))
    assert.equal(denied, 'Only the workflow controller session can update gates')
    const takeover = await enforcer.tool!.workflow_bind_session.execute({
      workflowPath: statePath,
      workflowId: 'workflow-child',
    }, toolContext('session-child'))
    assert.match(String(takeover), /controlled by another session/)
    const resumeTakeover = await enforcer.tool!.workflow_resume_session.execute({
      workflowPath: statePath,
      workflowId: 'workflow-child',
    }, toolContext('session-child'))
    assert.match(String(resumeTakeover), /restricted to root sessions/)
    assert.equal(state.readState(statePath)?.owner?.current_session_id, 'session-bound')
  })

  it('transfers controller ownership only through an approved fresh-session resume', async () => {
    const statePath = writeWorkflow('workflow-resume.state.json', 'pending', 'session-old')
    const enforcer = await WorkflowEnforcer(pluginInput())
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext('session-fresh', async request => { requests.push(request) })

    const resumed = await enforcer.tool!.workflow_resume_session.execute({
      workflowPath: statePath,
      workflowId: 'workflow-resume',
    }, context)

    assert.match(String(resumed), /resumed in the current session/)
    assert.equal(requests[0].permission, 'workflow_resume')
    assert.equal(state.readState(statePath)?.owner?.current_session_id, 'session-fresh')
    assert.equal(state.getWorkflowForSession('session-fresh')?.state.workflow_id, 'workflow-resume')
  })

  it('requires resume approval for ownerless legacy state and rejects unbound Task children', async () => {
    const statePath = writeWorkflow('workflow-ownerless.state.json', 'pending')
    state.updateState(statePath, current => {
      delete current.owner
      return current
    })
    const enforcer = await WorkflowEnforcer(pluginInput())
    const ordinaryBind = await enforcer.tool!.workflow_bind_session.execute({
      workflowPath: statePath,
      workflowId: 'workflow-ownerless',
    }, toolContext('session-unbound-root'))
    assert.match(String(ordinaryBind), /ownerless workflow requires workflow_resume_session/)

    await enforcer.event!({
      event: { type: 'session.created', properties: { info: sessionInfo('session-unbound-child', 'session-no-workflow') } },
    })
    const childResume = await enforcer.tool!.workflow_resume_session.execute({
      workflowPath: statePath,
      workflowId: 'workflow-ownerless',
    }, toolContext('session-unbound-child'))
    assert.match(String(childResume), /restricted to root sessions/)
    assert.equal(state.readState(statePath)?.owner, undefined)
  })

  it('refuses to archive a state file paired with a different org basename', () => {
    const statePath = writeWorkflow('workflow-pair.state.json', 'passed', 'session-pair')
    const wrongOrgPath = path.join(state.ACTIVE_DIR, 'different-workflow.org')
    fs.writeFileSync(wrongOrgPath, '# wrong companion\n')
    state.updateState(statePath, current => ({ ...current, org_file: wrongOrgPath }))

    assert.equal(state.archiveCompletedWorkflow(statePath), null)
    assert.equal(fs.existsSync(statePath), true)
    assert.equal(fs.existsSync(wrongOrgPath), true)
  })

  it('clears bindings after successful completion and session deletion', async () => {
    const completedPath = writeWorkflow('workflow-completed.state.json', 'passed', 'session-completed')
    const completedOrgPath = completedPath.replace('.state.json', '.org')
    fs.writeFileSync(completedOrgPath, '# completed workflow\n')
    state.updateState(completedPath, current => ({ ...current, org_file: completedOrgPath }))
    assert.equal(state.bindSessionToWorkflow('session-completed', completedPath, 'workflow-completed'), true)
    assert.equal(state.bindSessionToWorkflow('session-completed-child', completedPath, 'workflow-completed'), true)

    const enforcer = await WorkflowEnforcer(pluginInput())
    const completionResult = JSON.parse(await enforcer.tool!.workflow_check_completion.execute(
      {},
      toolContext('session-completed'),
    ) as string)
    assert.equal(completionResult.canComplete, true)
    assert.equal(fs.existsSync(completedPath), false)
    assert.equal(fs.existsSync(completedOrgPath), false)
    assert.equal(fs.existsSync(path.join(state.COMPLETED_DIR, path.basename(completedPath))), true)
    assert.equal(fs.existsSync(path.join(state.COMPLETED_DIR, path.basename(completedOrgPath))), true)
    assert.equal(state.getWorkflowForSession('session-completed'), null)
    assert.equal(state.getWorkflowForSession('session-completed-child'), null)

    const pendingPath = path.join(state.ACTIVE_DIR, 'workflow-bound.state.json')
    assert.equal(state.bindSessionToWorkflow('session-deleted', pendingPath, 'workflow-bound'), true)
    await enforcer.event!({
      event: { type: 'session.deleted', properties: { info: sessionInfo('session-deleted') } },
    })
    assert.equal(state.getWorkflowForSession('session-deleted'), null)
  })

  it('asks before manual notifications and handles part events without stale message content', async () => {
    const notifications = await WorkflowNotifications(pluginInput())
    const requests: Parameters<ToolContext['ask']>[0][] = []
    const context = toolContext('session-bound', async (request) => {
      requests.push(request)
      throw new Error('notification denied')
    })

    await assert.rejects(
      notifications.tool!.workflow_notify.execute({
        title: 'Workflow paused',
        message: 'Review required',
      }, context),
      /notification denied/,
    )
    assert.equal(requests.length, 1)
    assert.equal(requests[0].permission, 'workflow_notify')
    assert.equal(requests[0].metadata.sessionID, 'session-bound')
  })

  it('validates edit/write/apply_patch filePath outputs and file.edited events', async () => {
    const validator = await FileValidator(pluginInput())
    const invalidWrite = path.join(worktree, 'write-invalid.json')
    const invalidPatch = path.join(worktree, 'patch-invalid.json')
    fs.writeFileSync(invalidWrite, '{ invalid', 'utf8')
    fs.writeFileSync(invalidPatch, '{ invalid', 'utf8')

    for (const tool of ['edit', 'write']) {
      const output = { title: tool, output: `${tool} complete`, metadata: {} }
      await validator['tool.execute.after']!(
        {
          tool,
          sessionID: 'session-bound',
          callID: `call-${tool}`,
          args: { filePath: invalidWrite },
        },
        output,
      )
      assert.match(output.output, /Validation warning: JSON error/)
    }

    const patchOutput = { title: 'Patch', output: 'patched', metadata: {} }
    await validator['tool.execute.after']!(
      {
        tool: 'apply_patch',
        sessionID: 'session-bound',
        callID: 'call-patch',
        args: { patchText: `*** Begin Patch\n*** Update File: ${invalidPatch}\n*** End Patch` },
      },
      patchOutput,
    )
    assert.match(patchOutput.output, /patch-invalid\.json/)

    await validator.event!({
      event: { type: 'file.edited', properties: { file: invalidWrite } },
    })
  })

  it('honors OPENCODE_CONFIG_DIR for hook logs', () => {
    assert.equal(logger.LOG_FILE, path.join(configDir, 'workflows', 'hook.log'))
    logger.log('test', 'private mode')
    assert.equal(fs.statSync(logger.LOG_FILE).mode & 0o777, 0o600)
  })
})
