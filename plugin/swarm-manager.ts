/**
 * OpenCode Swarm Manager Plugin
 *
 * Parallel agent execution via OpenCode SDK with configurable concurrency limits,
 * provider-based slot management, and staleness detection.
 *
 * Reads swarm_config from ~/.config/opencode/workflows.json at initialization.
 * See workflows.json.template for all available options.
 *
 * Custom tools:
 * - swarm_spawn_batch:      Spawn parallel agent sessions (respects concurrency limits)
 * - swarm_await_batch:      Poll until all sessions complete (with staleness detection)
 * - swarm_spawn_validation: Spawn 3 parallel validation sessions
 * - swarm_collect_results:  Collect results from a completed batch
 * - swarm_cancel_task:      Cancel a specific tracked session and release its slot
 */

import type { Plugin } from "@opencode-ai/plugin"
import { log } from "../lib/logger.ts"
import { extractProvider } from "../lib/model-registry.ts"
import type { SwarmUserConfig, SwarmTask, TrackedSession } from "../lib/types.ts"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load swarm_config from workflows.json in the OpenCode config directory.
 * Falls back to safe defaults if not found.
 */
function loadSwarmConfig(): SwarmUserConfig {
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode');

  const candidates = [
    path.join(configHome, 'workflows.json'),
  ];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.swarm_config && typeof parsed.swarm_config === 'object') {
        // Strip comment keys (keys starting with '_comment_')
        const config: SwarmUserConfig = {};
        for (const [key, val] of Object.entries(parsed.swarm_config)) {
          if (!key.startsWith('_comment_')) {
            (config as any)[key] = val;
          }
        }
        log('swarm', `Loaded swarm_config from ${candidate}`);
        return config;
      }
    } catch {
      // File not found or parse error — use defaults
    }
  }

  log('swarm', 'No swarm_config found in workflows.json, using defaults');
  return {};
}

// ---------------------------------------------------------------------------
// ConcurrencyManager
// ---------------------------------------------------------------------------

/**
 * Manages per-provider concurrency slots to prevent rate-limit errors.
 * Uses provider-specific limits when configured; falls back to default_concurrency.
 */
class ConcurrencyManager {
  private slots: Map<string, number> = new Map();
  private limits: Map<string, number>;
  private defaultLimit: number;

  constructor(config: SwarmUserConfig) {
    this.defaultLimit = config.default_concurrency ?? 4;
    this.limits = new Map(Object.entries(config.provider_concurrency ?? {}));
  }

  canAcquire(provider: string): boolean {
    const limit = this.limits.get(provider) ?? this.defaultLimit;
    const current = this.slots.get(provider) ?? 0;
    return current < limit;
  }

  acquire(provider: string): void {
    const current = this.slots.get(provider) ?? 0;
    this.slots.set(provider, current + 1);
  }

  release(provider: string): void {
    const current = this.slots.get(provider) ?? 0;
    this.slots.set(provider, Math.max(0, current - 1));
  }

  getActive(provider: string): number {
    return this.slots.get(provider) ?? 0;
  }

  getLimit(provider: string): number {
    return this.limits.get(provider) ?? this.defaultLimit;
  }
}

// ---------------------------------------------------------------------------
// StalenessDetector
// ---------------------------------------------------------------------------

/**
 * Detects sessions that have stopped making progress.
 * Two modes:
 * - 'stale': Never made any progress within stale_timeout_ms
 * - 'stuck': Made progress but then stalled for progress_timeout_ms
 */
class StalenessDetector {
  private staleTimeoutMs: number;
  private progressTimeoutMs: number;

  constructor(config: SwarmUserConfig) {
    this.staleTimeoutMs = Math.max(60000, config.stale_timeout_ms ?? 180000);
    this.progressTimeoutMs = Math.max(60000, config.progress_timeout_ms ?? 600000);
  }

  check(session: TrackedSession, now: number): 'active' | 'stale' | 'stuck' {
    const runtime = now - session.startedAt;
    if (runtime < 30000) return 'active'; // min 30s before checking

    const timeSinceProgress = now - session.lastProgressAt;

    if (session.lastMessageCount === 0 && timeSinceProgress > this.staleTimeoutMs) {
      return 'stale'; // never made any progress
    }
    if (session.lastMessageCount > 0 && timeSinceProgress > this.progressTimeoutMs) {
      return 'stuck'; // made progress but stalled
    }
    return 'active';
  }
}

// ---------------------------------------------------------------------------
// Plugin types
// ---------------------------------------------------------------------------

// SwarmTask is imported from lib/types.ts

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const SwarmManager: Plugin = async ({ client, $ }) => {
  // Load config at plugin initialization
  const swarmConfig = loadSwarmConfig();
  const concurrencyManager = new ConcurrencyManager(swarmConfig);
  const stalenessDetector = new StalenessDetector(swarmConfig);
  const pollIntervalMs = Math.max(1000, swarmConfig.poll_interval_ms ?? 3000);

  // Batch tracking: batchId -> (taskId -> TrackedSession)
  const batches = new Map<string, Map<string, TrackedSession>>();

  log('swarm', `SwarmManager initialized: default_concurrency=${swarmConfig.default_concurrency ?? 4}, poll=${pollIntervalMs}ms, stale=${swarmConfig.stale_timeout_ms ?? 180000}ms`);

  return {
    tool: {
      swarm_spawn_batch: {
        description: "Spawn a batch of parallel agent sessions. Respects per-provider concurrency limits. Tasks that cannot acquire a slot are returned as queued.",
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
                  model: { type: "string" },
                },
                required: ["id", "agent", "prompt"],
              },
              description: "Tasks to spawn in parallel",
            },
            workingDir: { type: "string", description: "Working directory for sessions" },
          },
          required: ["batchId", "tasks"],
        },
        async execute(args: { batchId: string; tasks: SwarmTask[]; workingDir?: string }) {
          const { batchId, tasks } = args;
          const batchSessions = new Map<string, TrackedSession>();
          const spawned: string[] = [];
          const queued: string[] = [];

          for (const task of tasks) {
            const provider = task.model ? extractProvider(task.model) : 'unknown';

            // Check concurrency slot availability
            if (!concurrencyManager.canAcquire(provider)) {
              queued.push(task.id);
              log('swarm', `Task ${task.id} queued — provider '${provider}' at limit (${concurrencyManager.getActive(provider)}/${concurrencyManager.getLimit(provider)})`);
              continue;
            }

            // 100ms delay between spawns to avoid thundering herd
            if (spawned.length > 0) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            try {
              concurrencyManager.acquire(provider);

              const session = await client.session.create({
                title: `[${batchId}] ${task.agent}: ${task.id}`,
              });

              // Fire-and-forget prompt — pass model and agent so OpenCode routes correctly
              await client.session.promptAsync({
                path: { id: session.id },
                body: {
                  ...(task.model ? {
                    model: {
                      providerID: extractProvider(task.model),
                      modelID: task.model.substring(task.model.indexOf('/') + 1),
                    }
                  } : {}),
                  ...(task.agent ? { agent: task.agent } : {}),
                  content: task.prompt,
                },
              });

              const now = Date.now();
              const tracked: TrackedSession = {
                sessionId: session.id,
                taskId: task.id,
                agent: task.agent,
                provider,
                status: 'running',
                startedAt: now,
                lastMessageCount: 0,
                lastProgressAt: now,
              };

              batchSessions.set(task.id, tracked);
              spawned.push(`Spawned ${task.id} -> session ${session.id} (provider: ${provider})`);
              log('swarm', `Spawned ${task.id} (${task.agent}) in session ${session.id} [provider: ${provider}]`);
            } catch (err) {
              // Release slot — spawn failed, not occupying a session
              concurrencyManager.release(provider);
              log('swarm', `SDK spawn failed for ${task.id}: ${err}`);

              const now = Date.now();
              batchSessions.set(task.id, {
                sessionId: '',
                taskId: task.id,
                agent: task.agent,
                provider,
                status: 'failed',
                startedAt: now,
                lastMessageCount: 0,
                lastProgressAt: now,
              });
              spawned.push(`Failed to spawn ${task.id}: ${err}`);
            }
          }

          batches.set(batchId, batchSessions);
          return JSON.stringify({
            batchId,
            spawned: spawned.length,
            queued: queued.length,
            details: spawned,
            queuedTasks: queued,
          });
        },
      },

      swarm_await_batch: {
        description: "Wait for all sessions in a batch to complete. Polls at the configured interval with staleness detection. Cancels stale or stuck sessions automatically.",
        parameters: {
          type: "object",
          properties: {
            batchId: { type: "string", description: "Batch ID to wait for" },
            timeoutMs: { type: "number", description: "Max wait time in ms (default 300000)" },
          },
          required: ["batchId"],
        },
        async execute(args: { batchId: string; timeoutMs?: number }) {
          const batch = batches.get(args.batchId);
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` });

          const timeout = args.timeoutMs || 300_000;
          const start = Date.now();

          while (Date.now() - start < timeout) {
            try {
              const statuses = await client.session.status();
              const now = Date.now();
              let allDone = true;

              for (const [taskId, session] of batch) {
                if (session.status === 'failed' || session.status === 'completed' || session.status === 'cancelled') {
                  continue;
                }

                if (!session.sessionId) {
                  // No session ID means spawn failed; already marked failed
                  continue;
                }

                const statusEntry = statuses.get?.(session.sessionId) || statuses[session.sessionId];

                // Try to update message count for staleness tracking
                try {
                  const messages = await client.session.messages({ path: { id: session.sessionId } });
                  if (Array.isArray(messages) && messages.length > session.lastMessageCount) {
                    session.lastMessageCount = messages.length;
                    session.lastProgressAt = now;
                  }
                } catch {
                  // Message fetch failed — staleness falls back to time-based detection only
                }

                if (statusEntry?.type === 'idle') {
                  session.status = 'completed';
                  concurrencyManager.release(session.provider);
                  log('swarm', `Task ${taskId} completed (session ${session.sessionId})`);
                } else {
                  // Check for staleness
                  const stalenessResult = stalenessDetector.check(session, now);
                  if (stalenessResult === 'stale' || stalenessResult === 'stuck') {
                    log('swarm', `Task ${taskId} is ${stalenessResult} — cancelling session ${session.sessionId}`);
                    try {
                      await client.session.cancel({ path: { id: session.sessionId } });
                    } catch (cancelErr) {
                      log('swarm', `Failed to cancel session ${session.sessionId}: ${cancelErr}`);
                    }
                    session.status = 'failed';
                    concurrencyManager.release(session.provider);
                    log('swarm', `Task ${taskId} marked failed (${stalenessResult}), slot released for provider '${session.provider}'`);
                  } else {
                    allDone = false;
                  }
                }
              }

              if (allDone) {
                log('swarm', `Batch ${args.batchId} completed`);
                return JSON.stringify({
                  batchId: args.batchId,
                  completed: true,
                  results: Object.fromEntries(
                    Array.from(batch.entries()).map(([id, s]) => [id, s.status])
                  ),
                });
              }
            } catch (err) {
              log('swarm', `Status poll error: ${err}`);
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          }

          return JSON.stringify({ batchId: args.batchId, completed: false, timedOut: true });
        },
      },

      swarm_spawn_validation: {
        description: "Spawn 3 parallel validation sessions (functional, security, quality). ALL must PASS.",
        parameters: {
          type: "object",
          properties: {
            workingDir: { type: "string", description: "Working directory" },
            summary: { type: "string", description: "Implementation summary to review" },
            changedFiles: { type: "string", description: "List of changed files" },
          },
          required: ["summary", "changedFiles"],
        },
        async execute(args: { workingDir?: string; summary: string; changedFiles: string }) {
          const batchId = `validation-${Date.now()}`;
          const tasks: SwarmTask[] = [
            {
              id: 'functional-review',
              agent: 'reviewer-deep',
              prompt: `## VALIDATION FOCUS: Functional Completeness\n\nReview the implementation against requirements.\nCheck: All features implemented, edge cases handled.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`,
            },
            {
              id: 'security-review',
              agent: 'security-deep',
              prompt: `## VALIDATION FOCUS: Security\n\nReview for security vulnerabilities.\nCheck: OWASP top 10, injection, auth issues.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`,
            },
            {
              id: 'quality-review',
              agent: 'reviewer-deep',
              prompt: `## VALIDATION FOCUS: Code Quality\n\nReview for code quality and patterns.\nCheck: SOLID, DRY, naming, complexity.\n\n## Summary\n${args.summary}\n\n## Changed Files\n${args.changedFiles}`,
            },
          ];

          const batchSessions = new Map<string, TrackedSession>();

          for (const task of tasks) {
            const provider = task.model ? extractProvider(task.model) : 'unknown';

            if (batchSessions.size > 0) {
              await new Promise(r => setTimeout(r, 100));
            }

            try {
              if (!concurrencyManager.canAcquire(provider)) {
                log('swarm', `Validation: provider '${provider}' at concurrency limit, spawning anyway (validation always runs all 3)`);
              }
              concurrencyManager.acquire(provider);

              const session = await client.session.create({
                title: `[${batchId}] ${task.agent}: ${task.id}`,
              });
              await client.session.promptAsync({
                path: { id: session.id },
                body: {
                  ...(task.model ? {
                    model: {
                      providerID: extractProvider(task.model),
                      modelID: task.model.substring(task.model.indexOf('/') + 1),
                    }
                  } : {}),
                  ...(task.agent ? { agent: task.agent } : {}),
                  content: task.prompt,
                },
              });

              const now = Date.now();
              batchSessions.set(task.id, {
                sessionId: session.id,
                taskId: task.id,
                agent: task.agent,
                provider,
                status: 'running',
                startedAt: now,
                lastMessageCount: 0,
                lastProgressAt: now,
              });
              log('swarm', `Validation spawned: ${task.id} -> session ${session.id}`);
            } catch (err) {
              concurrencyManager.release(provider);
              const now = Date.now();
              batchSessions.set(task.id, {
                sessionId: '',
                taskId: task.id,
                agent: task.agent,
                provider,
                status: 'failed',
                startedAt: now,
                lastMessageCount: 0,
                lastProgressAt: now,
              });
              log('swarm', `Validation spawn failed: ${task.id}: ${err}`);
            }
          }

          batches.set(batchId, batchSessions);
          return JSON.stringify({ batchId, spawned: batchSessions.size });
        },
      },

      swarm_collect_results: {
        description: "Collect full results from a completed batch. Call after swarm_await_batch confirms completion.",
        parameters: {
          type: "object",
          properties: {
            batchId: { type: "string", description: "Batch ID to collect results from" },
          },
          required: ["batchId"],
        },
        async execute(args: { batchId: string }) {
          const batch = batches.get(args.batchId);
          if (!batch) return JSON.stringify({ error: `Batch ${args.batchId} not found` });

          const results: Record<string, string> = {};

          for (const [taskId, session] of batch) {
            if (!session.sessionId) {
              results[taskId] = 'Failed to spawn';
              continue;
            }

            try {
              const messages = await client.session.messages({ path: { id: session.sessionId } });
              // Get last assistant message, truncate to 2KB
              const lastMsg = Array.isArray(messages)
                ? messages.filter((m: any) => m.role === 'assistant').pop()
                : null;
              const content = lastMsg?.content || 'No output';
              results[taskId] = content.length > 2048
                ? content.slice(0, 2048) + '... [truncated]'
                : content;
            } catch (err) {
              results[taskId] = `Error retrieving: ${err}`;
            }
          }

          return JSON.stringify({ batchId: args.batchId, results });
        },
      },

      swarm_cancel_task: {
        description: "Cancel a specific tracked session and release its concurrency slot.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task ID to cancel" },
            batch_id: { type: "string", description: "Batch ID containing the task" },
          },
          required: ["task_id", "batch_id"],
        },
        async execute(args: { task_id: string; batch_id: string }) {
          const batch = batches.get(args.batch_id);
          if (!batch) {
            return JSON.stringify({ error: `Batch ${args.batch_id} not found` });
          }

          const session = batch.get(args.task_id);
          if (!session) {
            return JSON.stringify({ error: `Task ${args.task_id} not found in batch ${args.batch_id}` });
          }

          if (session.status === 'completed' || session.status === 'cancelled' || session.status === 'failed') {
            return JSON.stringify({
              task_id: args.task_id,
              cancelled: false,
              reason: `Task is already in terminal state: ${session.status}`,
            });
          }

          if (!session.sessionId) {
            session.status = 'cancelled';
            return JSON.stringify({ task_id: args.task_id, cancelled: true, reason: 'No session ID; marked cancelled' });
          }

          try {
            await client.session.cancel({ path: { id: session.sessionId } });
            session.status = 'cancelled';
            concurrencyManager.release(session.provider);
            log('swarm', `Task ${args.task_id} cancelled (session ${session.sessionId}), slot released for provider '${session.provider}'`);
            return JSON.stringify({ task_id: args.task_id, cancelled: true });
          } catch (err) {
            log('swarm', `Failed to cancel task ${args.task_id}: ${err}`);
            return JSON.stringify({ task_id: args.task_id, cancelled: false, error: String(err) });
          }
        },
      },
    },
  };
};

export default SwarmManager;
