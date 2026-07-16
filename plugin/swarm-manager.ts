import { tool, type Plugin, type ToolContext } from '@opencode-ai/plugin'
import fs from 'node:fs'
import path from 'node:path'

import { log } from '../lib/logger.ts'
import { getConfigDir } from '../lib/paths.ts'
import { getWorkflowForSession } from '../lib/state.ts'
import { SwarmRuntime } from '../lib/swarm-runtime.ts'
import { authorizeToolPath, throwIfAborted } from '../lib/tool-context.ts'
import type { SwarmTask, SwarmUserConfig } from '../lib/types.ts'

function loadSwarmConfig(): SwarmUserConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(getConfigDir(), 'workflows.json'), 'utf8')) as {
      swarm_config?: Record<string, unknown>
    }
    const config = parsed.swarm_config ?? {}
    return {
      ...(typeof config.default_concurrency === 'number' ? { default_concurrency: config.default_concurrency } : {}),
      ...(typeof config.stale_timeout_ms === 'number' ? { stale_timeout_ms: config.stale_timeout_ms } : {}),
      ...(typeof config.poll_interval_ms === 'number' ? { poll_interval_ms: config.poll_interval_ms } : {}),
      ...(typeof config.progress_timeout_ms === 'number' ? { progress_timeout_ms: config.progress_timeout_ms } : {}),
      ...(config.provider_concurrency && typeof config.provider_concurrency === 'object'
        ? { provider_concurrency: config.provider_concurrency as Record<string, number> }
        : {}),
    }
  } catch {
    return {}
  }
}

function buildWorkflowContextPrefix(sessionId: string): string {
  try {
    const workflow = getWorkflowForSession(sessionId)
    if (!workflow) return ''
    const state = workflow.state
    const details = [
      '## Workflow Context (AUTHORITATIVE - do not guess or change these values)',
      `- **Workflow ID**: ${state.workflow_id}`,
      `- **Type**: ${state.workflow_type}`,
      `- **Mode**: ${state.mode?.current || 'standard'}`,
      `- **Phase**: ${state.phase?.current || 'unknown'}`,
      state.org_file ? `- **Org File**: ${state.org_file}` : '',
      `- **State File**: ${workflow.path}`,
      state.workflow?.description ? `- **Description**: ${state.workflow.description}` : '',
    ].filter(Boolean)
    return [
      ...details,
      '',
      'Use the exact Workflow ID above in all references. Do not invent a different ID.',
      '',
    ].join('\n')
  } catch {
    return ''
  }
}

async function authorizeTasks(context: ToolContext, tasks: SwarmTask[]): Promise<void> {
  throwIfAborted(context)
  for (const agent of new Set(tasks.map((task) => task.agent))) {
    await context.ask({
      permission: 'task',
      patterns: [agent],
      always: [agent],
      metadata: { agent, subagent_type: agent },
    })
    throwIfAborted(context)
  }
}

async function sessionDirectory(context: ToolContext, workingDir?: string): Promise<string> {
  if (!workingDir) return context.directory
  return authorizeToolPath(context, path.resolve(context.directory, workingDir), 'read', {
    kind: 'directory',
    recursive: true,
  })
}

function validationTasks(summary: string, changedFiles: string): SwarmTask[] {
  return [
    {
      id: 'functional-review',
      agent: 'wf-reviewer-deep',
      prompt: `## VALIDATION FOCUS: Functional Completeness\n\nReview the implementation against requirements.\nCheck: All features implemented, edge cases handled.\n\n## Summary\n${summary}\n\n## Changed Files\n${changedFiles}`,
    },
    {
      id: 'security-review',
      agent: 'wf-security-deep',
      prompt: `## VALIDATION FOCUS: Security\n\nReview for security vulnerabilities.\nCheck: OWASP top 10, injection, auth issues.\n\n## Summary\n${summary}\n\n## Changed Files\n${changedFiles}`,
    },
    {
      id: 'quality-review',
      agent: 'wf-reviewer-deep',
      prompt: `## VALIDATION FOCUS: Code Quality\n\nReview for code quality and patterns.\nCheck: SOLID, DRY, naming, complexity.\n\n## Summary\n${summary}\n\n## Changed Files\n${changedFiles}`,
    },
  ]
}

export const SwarmManager: Plugin = async ({ client, directory }) => {
  const swarmConfig = loadSwarmConfig()
  const runtime = new SwarmRuntime(client, swarmConfig, { scopeDirectory: directory })
  log('swarm', `SwarmManager initialized with global concurrency ${swarmConfig.default_concurrency ?? 4}`)

  return {
    event: async ({ event }) => {
      await runtime.handleEvent(event)
    },

    dispose: async () => {
      runtime.dispose()
    },

    tool: {
      swarm_spawn_batch: tool({
        description: 'Spawn a batch of parallel agent sessions. Respects global and per-provider concurrency limits and drains queued work automatically.',
        args: {
          batchId: tool.schema.string().describe('Unique batch identifier'),
          tasks: tool.schema.array(tool.schema.object({
            id: tool.schema.string(),
            agent: tool.schema.string(),
            prompt: tool.schema.string(),
            model: tool.schema.string().optional(),
          })).describe('Tasks to spawn in parallel'),
          workingDir: tool.schema.string().optional().describe('Working directory for sessions'),
        },
        async execute(args, context) {
          await authorizeTasks(context, args.tasks)
          const result = runtime.spawnBatch({
            batchId: args.batchId,
            callerSessionId: context.sessionID,
            directory: await sessionDirectory(context, args.workingDir),
            tasks: args.tasks,
            workflowContext: buildWorkflowContextPrefix(context.sessionID),
          })
          return JSON.stringify(result)
        },
      }),

      swarm_await_batch: tool({
        description: 'Wait for all sessions in a batch to complete. Uses lifecycle events, one status reconciliation, and staleness timers.',
        args: {
          batchId: tool.schema.string().describe('Batch ID to wait for'),
          timeoutMs: tool.schema.number().optional().describe('Max wait time in ms (default 300000)'),
        },
        async execute(args, context) {
          try {
            const restored = runtime.restoredBatchAuthorization(context.sessionID, args.batchId)
            if (restored) {
              await authorizeTasks(context, restored.tasks)
              await authorizeToolPath(context, restored.directory, 'read', { kind: 'directory', recursive: true })
              runtime.resumeRestoredBatch(context.sessionID, args.batchId)
            }
            const result = await runtime.awaitBatch(context.sessionID, args.batchId, args.timeoutMs, context.abort)
            return JSON.stringify(result)
          } catch (error) {
            if (context.abort.aborted) throw error
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),

      swarm_spawn_validation: tool({
        description: 'Spawn 3 parallel validation sessions (functional, security, quality). ALL must PASS.',
        args: {
          workingDir: tool.schema.string().optional().describe('Working directory'),
          summary: tool.schema.string().describe('Implementation summary to review'),
          changedFiles: tool.schema.string().describe('List of changed files'),
        },
        async execute(args, context) {
          const tasks = validationTasks(args.summary, args.changedFiles)
          await authorizeTasks(context, tasks)
          const batchId = `validation-${Date.now()}`
          const result = runtime.spawnBatch({
            batchId,
            callerSessionId: context.sessionID,
            directory: await sessionDirectory(context, args.workingDir),
            tasks,
            workflowContext: buildWorkflowContextPrefix(context.sessionID),
          })
          return JSON.stringify({ batchId, spawned: result.spawned, queued: result.queued })
        },
      }),

      swarm_collect_results: tool({
        description: 'Collect full results from a completed batch. Call after swarm_await_batch confirms completion.',
        args: {
          batchId: tool.schema.string().describe('Batch ID to collect results from'),
        },
        async execute(args, context) {
          try {
            return JSON.stringify(await runtime.collectResults(context.sessionID, args.batchId))
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),

      swarm_cancel_task: tool({
        description: 'Cancel a specific tracked session and release its concurrency slot.',
        args: {
          task_id: tool.schema.string().describe('Task ID to cancel'),
          batch_id: tool.schema.string().describe('Batch ID containing the task'),
        },
        async execute(args, context) {
          try {
            return JSON.stringify(await runtime.cancelTask(context.sessionID, args.batch_id, args.task_id))
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    },
  }
}

export default SwarmManager
