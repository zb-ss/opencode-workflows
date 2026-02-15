/**
 * OpenCode Swarm Manager Plugin
 *
 * Parallel agent execution via OpenCode SDK.
 * Uses client.session.create/promptAsync/status/messages for spawning
 * and tracking parallel sessions.
 *
 * Custom tools:
 * - swarm_spawn_batch: Spawn up to 4 parallel agent sessions
 * - swarm_await_batch: Poll until all sessions complete
 * - swarm_spawn_validation: Spawn 3 parallel validation sessions
 * - swarm_collect_results: Collect results from a completed batch
 */

import type { Plugin } from "@opencode-ai/plugin"
import { log } from "../lib/logger.ts"

interface SwarmTask {
  id: string
  agent: string
  prompt: string
  model?: string
}

interface BatchSession {
  sessionId: string
  taskId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export const SwarmManager: Plugin = async ({ client, $ }) => {
  const batches = new Map<string, Map<string, BatchSession>>()

  return {
    tool: {
      swarm_spawn_batch: {
        description: "Spawn a batch of parallel agent sessions. Max 4 per batch. Returns batch tracking info.",
        parameters: {
          type: "object",
          properties: {
            batchId: { type: "string", description: "Unique batch identifier" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  agent: { type: "string" },
                  prompt: { type: "string" },
                  model: { type: "string" }
                },
                required: ["id", "agent", "prompt"]
              },
              description: "Tasks to spawn in parallel (max 4)"
            },
            workingDir: { type: "string", description: "Working directory for sessions" }
          },
          required: ["batchId", "tasks"]
        },
        async execute(args: { batchId: string; tasks: SwarmTask[]; workingDir?: string }) {
          const { batchId, tasks } = args
          const maxParallel = 4
          const limited = tasks.slice(0, maxParallel)

          const batchSessions = new Map<string, BatchSession>()
          const results: string[] = []

          for (const task of limited) {
            try {
              // 100ms delay between spawns to avoid rate limits
              if (results.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 100))
              }

              const session = await client.session.create({
                title: `[${batchId}] ${task.agent}: ${task.id}`
              })

              // Fire-and-forget prompt
              await client.session.promptAsync({
                path: { id: session.id },
                body: { content: task.prompt }
              })

              batchSessions.set(task.id, {
                sessionId: session.id,
                taskId: task.id,
                status: 'running'
              })

              results.push(`Spawned ${task.id} -> session ${session.id}`)
              log('swarm', `Spawned ${task.id} (${task.agent}) in session ${session.id}`)
            } catch (err) {
              // Fallback to CLI
              log('swarm', `SDK spawn failed for ${task.id}, falling back to CLI: ${err}`)
              try {
                const agent = task.agent
                const model = task.model || ''
                const prompt = task.prompt.replace(/"/g, '\\"')
                const modelFlag = model ? `--model ${model}` : ''
                await $`opencode run "${prompt}" --agent ${agent} ${modelFlag} --format json`
                results.push(`Spawned ${task.id} via CLI fallback`)
              } catch (cliErr) {
                results.push(`Failed to spawn ${task.id}: ${cliErr}`)
                batchSessions.set(task.id, {
                  sessionId: '',
                  taskId: task.id,
                  status: 'failed'
                })
              }
            }
          }

          batches.set(batchId, batchSessions)
          return JSON.stringify({ batchId, spawned: results.length, details: results })
        }
      },

      swarm_await_batch: {
        description: "Wait for all sessions in a batch to complete. Polls every 2 seconds.",
        parameters: {
          type: "object",
          properties: {
            batchId: { type: "string", description: "Batch ID to wait for" },
            timeoutMs: { type: "number", description: "Max wait time in ms (default 300000)" }
          },
          required: ["batchId"]
        },
        async execute(args: { batchId: string; timeoutMs?: number }) {
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })

          const timeout = args.timeoutMs || 300_000
          const start = Date.now()

          while (Date.now() - start < timeout) {
            try {
              const statuses = await client.session.status()
              let allDone = true

              for (const [taskId, session] of batch) {
                if (session.status === 'failed') continue
                const status = statuses.get?.(session.sessionId) || statuses[session.sessionId]
                if (status?.type === 'idle') {
                  session.status = 'completed'
                } else {
                  allDone = false
                }
              }

              if (allDone) {
                log('swarm', `Batch ${args.batchId} completed`)
                return JSON.stringify({
                  batchId: args.batchId,
                  completed: true,
                  results: Object.fromEntries(
                    Array.from(batch.entries()).map(([id, s]) => [id, s.status])
                  )
                })
              }
            } catch (err) {
              log('swarm', `Status poll error: ${err}`)
            }

            await new Promise(resolve => setTimeout(resolve, 2000))
          }

          return JSON.stringify({ batchId: args.batchId, completed: false, timedOut: true })
        }
      },

      swarm_spawn_validation: {
        description: "Spawn 3 parallel validation sessions (functional, security, quality). ALL must PASS.",
        parameters: {
          type: "object",
          properties: {
            workingDir: { type: "string", description: "Working directory" },
            summary: { type: "string", description: "Implementation summary to review" },
            changedFiles: { type: "string", description: "List of changed files" }
          },
          required: ["summary", "changedFiles"]
        },
        async execute(args: { workingDir?: string; summary: string; changedFiles: string }) {
          const batchId = `validation-${Date.now()}`
          const tasks: SwarmTask[] = [
            {
              id: 'functional-review',
              agent: 'reviewer-deep',
              prompt: `## VALIDATION FOCUS: Functional Completeness\n\nReview the implementation against requirements.\nCheck: All features implemented, edge cases handled.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`
            },
            {
              id: 'security-review',
              agent: 'security-deep',
              prompt: `## VALIDATION FOCUS: Security\n\nReview for security vulnerabilities.\nCheck: OWASP top 10, injection, auth issues.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`
            },
            {
              id: 'quality-review',
              agent: 'reviewer-deep',
              prompt: `## VALIDATION FOCUS: Code Quality\n\nReview for code quality and patterns.\nCheck: SOLID, DRY, naming, complexity.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`
            }
          ]

          // Spawn sessions
          const batchSessions = new Map<string, BatchSession>()
          for (const task of tasks) {
            try {
              if (batchSessions.size > 0) await new Promise(r => setTimeout(r, 100))
              const session = await client.session.create({ title: `[${batchId}] ${task.agent}: ${task.id}` })
              await client.session.promptAsync({ path: { id: session.id }, body: { content: task.prompt } })
              batchSessions.set(task.id, { sessionId: session.id, taskId: task.id, status: 'running' })
              log('swarm', `Validation spawned: ${task.id} -> session ${session.id}`)
            } catch (err) {
              batchSessions.set(task.id, { sessionId: '', taskId: task.id, status: 'failed' })
              log('swarm', `Validation spawn failed: ${task.id}: ${err}`)
            }
          }

          batches.set(batchId, batchSessions)
          return JSON.stringify({ batchId, spawned: batchSessions.size })
        }
      },

      swarm_collect_results: {
        description: "Collect full results from a completed batch. Call after swarm_await_batch confirms completion.",
        parameters: {
          type: "object",
          properties: {
            batchId: { type: "string", description: "Batch ID to collect results from" }
          },
          required: ["batchId"]
        },
        async execute(args: { batchId: string }) {
          const batch = batches.get(args.batchId)
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` })

          const results: Record<string, string> = {}

          for (const [taskId, session] of batch) {
            if (!session.sessionId) {
              results[taskId] = 'Failed to spawn'
              continue
            }

            try {
              const messages = await client.session.messages({ path: { id: session.sessionId } })
              // Get last assistant message, truncate to 2KB
              const lastMsg = Array.isArray(messages)
                ? messages.filter((m: any) => m.role === 'assistant').pop()
                : null
              const content = lastMsg?.content || 'No output'
              results[taskId] = content.length > 2048 ? content.slice(0, 2048) + '... [truncated]' : content
            } catch (err) {
              results[taskId] = `Error retrieving: ${err}`
            }
          }

          return JSON.stringify({ batchId: args.batchId, results })
        }
      }
    }
  }
}

export default SwarmManager
