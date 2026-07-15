import type { Plugin, ToolContext } from '@opencode-ai/plugin'
import path from 'node:path'

import { log } from '../lib/logger.ts'
import { enabledReviewLoop } from '../lib/fixed-point-contracts.ts'
import { FixedPointReviewCoordinator } from '../lib/fixed-point-review.ts'
import { unwrapSdkResult } from '../lib/opencode-session.ts'
import { isPathInside } from '../lib/paths.ts'
import { getWorkflowForSession } from '../lib/state.ts'
import { SwarmRuntime } from '../lib/swarm-runtime.ts'
import { authorizeToolPath, throwIfAborted } from '../lib/tool-context.ts'
import type { SwarmTask } from '../lib/types.ts'
import { loadWorkflowConfig } from '../lib/workflow-config.ts'

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

export const SwarmManager: Plugin = async ({ client, directory, serverUrl }) => {
  const { tool } = await import('@opencode-ai/plugin')
  const { createOpencodeClient: createOpencodeClientV2 } = await import('@opencode-ai/sdk/v2/client')
  const workflowConfig = loadWorkflowConfig()
  const swarmConfig = workflowConfig.swarm_config
  const autonomyClient = serverUrl
    ? createOpencodeClientV2({ baseUrl: serverUrl.toString(), directory: path.resolve(directory) })
    : undefined
  const runtime = new SwarmRuntime(client, swarmConfig, { autonomyClient, scopeDirectory: directory })
  const reviewLoopConfig = workflowConfig.review_loop
  const activeReviewLoopConfig = reviewLoopConfig.enabled ? enabledReviewLoop(reviewLoopConfig) : null
  const reviewCoordinator = new FixedPointReviewCoordinator(runtime, reviewLoopConfig, {
    async loadChangedFiles(reviewDirectory) {
      const result = await client.file.status({
        query: { directory },
        throwOnError: true,
      })
      const files = unwrapSdkResult<Array<{ path: string }>>(result, 'file.status')
      const projectRoot = path.resolve(directory)
      if (path.resolve(reviewDirectory) !== projectRoot) {
        throw new Error('fixed-point review directory must equal the plugin project root')
      }
      return [...new Set(files.map((file) => {
        const target = path.resolve(projectRoot, file.path)
        if (!isPathInside(projectRoot, target) || target === projectRoot) {
          throw new Error(`file.status returned a path outside the project: ${file.path}`)
        }
        return path.relative(projectRoot, target)
      }))]
    },
  })
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

      swarm_review_fixed_point: tool({
        description: 'Run configured structured reviewers selected by typed risk tags, apply bounded correction rounds, and stop on acceptance, repeated issues, a blocker, or the configured iteration limit.',
        args: {
          summary: tool.schema.string().min(1).max(20000).describe('Implementation summary treated as untrusted review data'),
          changedFiles: tool.schema.array(tool.schema.string().min(1).max(1000)).min(1).max(500)
            .describe('Repository-relative changed file paths'),
          riskTags: tool.schema.array(tool.schema.string().min(1).max(64)).max(32)
            .describe('Configured risk tags observed for this change'),
        },
        async execute(args, context) {
          if (!activeReviewLoopConfig) {
            return JSON.stringify({ status: 'disabled', reason: 'review_loop.enabled is false in workflows.json' })
          }
          try {
            const reviewDirectory = path.resolve(directory)
            return JSON.stringify(await reviewCoordinator.run({
              callerSessionId: context.sessionID,
              directory: reviewDirectory,
              summary: args.summary,
              changedFiles: args.changedFiles,
              riskTags: args.riskTags,
              workflowContext: buildWorkflowContextPrefix(context.sessionID),
              signal: context.abort,
              async authorizeReads(files) {
                for (const file of files) {
                  await authorizeToolPath(context, path.resolve(reviewDirectory, file), 'read', { kind: 'file' })
                }
              },
              async authorizeReviewers(reviewers) {
                await authorizeTasks(context, reviewers.map((reviewer) => ({
                  id: reviewer.id,
                  agent: reviewer.agent,
                  prompt: activeReviewLoopConfig.reviewers.find((configured) => configured.id === reviewer.id)?.focus ?? reviewer.id,
                })))
              },
              async authorizeCorrectionAgent(agent) {
                await authorizeTasks(context, [{
                  id: 'correction',
                  agent,
                  prompt: activeReviewLoopConfig.correction_focus,
                }])
              },
              async authorizeEdits(files) {
                for (const file of files) {
                  await authorizeToolPath(context, path.resolve(reviewDirectory, file), 'edit', { kind: 'file' })
                }
              },
            }))
          } catch (error) {
            if (context.abort.aborted) throw error
            return JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
          }
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
