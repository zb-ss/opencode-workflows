/**
 * OpenCode Delegation Orchestrator Plugin
 *
 * Core orchestration plugin for delegation workflows. Manages the full
 * delegation pipeline: plan decomposition, worktree lifecycle, CLI process
 * spawning, result collection, re-delegation, merging, and cleanup.
 *
 * Analogous to swarm-manager.ts (which manages parallel OpenCode sessions),
 * this plugin manages external CLI processes (claude/gemini) in git worktrees.
 *
 * Custom tools:
 * - delegation_decompose:      Parse plan text into discrete DelegationTasks
 * - delegation_init_files:     Ensure CLAUDE.md / GEMINI.md exist in project
 * - delegation_execute_batch:  Spawn CLI processes in worktrees (parallel)
 * - delegation_await_batch:    Poll tracked processes until completion
 * - delegation_collect_results: Gather stdout/stderr and diff stats
 * - delegation_redelegate:     Re-run a failed task with review feedback
 * - delegation_merge_task:     Merge a worktree branch into target
 * - delegation_cleanup:        Remove all worktrees for a workflow
 */

import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import type {
  DelegationTask,
  DelegationPlan,
  DelegationOrchestratorConfig,
  DelegationProvider,
  DelegationTaskTag,
  DelegationRoutingConfig,
} from '../lib/types.ts'
import {
  createWorktree,
  mergeWorktree,
  removeWorktree,
  cleanupStaleWorktrees,
  getWorktreeStatus,
  getWorktreeDir,
} from '../lib/worktree-manager.ts'
import { routeTask, buildPrompt, buildCliArgs, inferTag } from '../lib/task-router.ts'
import { ensureInitFile } from '../lib/init-file-generator.ts'
import { log } from '../lib/logger.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const xdg = process.env.XDG_CONFIG_HOME
const CONFIG_DIR = xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode')

const WORKFLOWS_JSON = path.join(CONFIG_DIR, 'workflows.json')
const DELEGATION_CONTEXT_DIR = path.join(CONFIG_DIR, 'workflows', 'context', 'delegation')

/** Default config values when no user config is present. */
const DEFAULT_CONFIG: DelegationOrchestratorConfig = {
  claude: { timeout_ms: 300_000, permission_mode: 'dangerously-skip-permissions' },
  gemini: { timeout_ms: 300_000 },
  max_parallel: 3,
  routing: {
    ui_patterns: [
      'css', 'style', 'layout', 'responsive', 'animation', 'theme',
      'font', 'color', 'visual', 'ui', 'ux', 'design', 'icon',
      'svg', 'image', 'modal', 'dialog', 'tooltip', 'dropdown',
      'menu', 'navbar', 'sidebar', 'footer', 'header', 'banner',
    ],
    default_provider: 'claude',
  },
  fallback_order: ['claude', 'gemini'],
  max_review_iterations: 3,
  auto_init_files: true,
}

/**
 * Load delegation config from workflows.json -> delegation section.
 * Strips keys with _example_ prefix (inactive/documentation keys).
 */
function loadDelegationConfig(): DelegationOrchestratorConfig {
  try {
    if (fs.existsSync(WORKFLOWS_JSON)) {
      const raw = JSON.parse(fs.readFileSync(WORKFLOWS_JSON, 'utf8'))
      const section = raw?.delegation
      if (!section || typeof section !== 'object') {
        log('delegation', 'No delegation section in workflows.json, using defaults')
        return { ...DEFAULT_CONFIG }
      }

      // Strip _example_ prefixed keys recursively
      const strip = (obj: Record<string, unknown>): Record<string, unknown> => {
        const result: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(obj)) {
          if (key.startsWith('_example_') || key.startsWith('_comment_')) continue
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            result[key] = strip(val as Record<string, unknown>)
          } else {
            result[key] = val
          }
        }
        return result
      }

      const cleaned = strip(section)
      const config: DelegationOrchestratorConfig = {
        claude: {
          ...DEFAULT_CONFIG.claude,
          ...(cleaned.claude as object ?? {}),
        },
        gemini: {
          ...DEFAULT_CONFIG.gemini,
          ...(cleaned.gemini as object ?? {}),
        },
        max_parallel: typeof cleaned.max_parallel === 'number'
          ? cleaned.max_parallel
          : DEFAULT_CONFIG.max_parallel,
        routing: {
          ...DEFAULT_CONFIG.routing,
          ...(cleaned.routing as object ?? {}),
        },
        fallback_order: Array.isArray(cleaned.fallback_order)
          ? cleaned.fallback_order as DelegationProvider[]
          : DEFAULT_CONFIG.fallback_order,
        max_review_iterations: typeof cleaned.max_review_iterations === 'number'
          ? cleaned.max_review_iterations
          : DEFAULT_CONFIG.max_review_iterations,
        auto_init_files: typeof cleaned.auto_init_files === 'boolean'
          ? cleaned.auto_init_files
          : DEFAULT_CONFIG.auto_init_files,
      }

      log('delegation', `Loaded delegation config from ${WORKFLOWS_JSON}`)
      return config
    }
  } catch (err) {
    log('delegation', `Failed to load delegation config: ${err}`)
  }

  log('delegation', 'Using default delegation config')
  return { ...DEFAULT_CONFIG }
}

// ---------------------------------------------------------------------------
// Internal state: tracked CLI executions
// ---------------------------------------------------------------------------

interface TrackedExecution {
  taskId: string
  provider: DelegationProvider
  worktreePath: string
  branchName: string
  startedAt: number
  stdout: string
  stderr: string
  exitCode: number | null
  completed: boolean
  timedOut: boolean
  pid: number | null
  process: ReturnType<typeof spawn> | null
}

// ---------------------------------------------------------------------------
// Process spawning helper (adapted from delegate_command.ts execCommand)
// ---------------------------------------------------------------------------

function spawnTracked(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  tracked: TrackedExecution,
): void {
  const child = spawn(command, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  })

  tracked.process = child
  tracked.pid = child.pid ?? null

  child.stdout.on('data', (chunk: Buffer) => {
    tracked.stdout += chunk.toString()
  })

  child.stderr.on('data', (chunk: Buffer) => {
    tracked.stderr += chunk.toString()
  })

  child.on('error', (error: Error) => {
    log('delegation', `Process error for task ${tracked.taskId}: ${error.message}`)
    tracked.completed = true
    tracked.exitCode = null
  })

  child.on('close', (exitCode: number | null) => {
    tracked.completed = true
    tracked.exitCode = exitCode
    tracked.process = null
    log('delegation', `Task ${tracked.taskId} process exited: code=${exitCode}`)
  })

  // Timeout guard
  const timer = setTimeout(() => {
    if (!tracked.completed) {
      tracked.timedOut = true
      log('delegation', `Task ${tracked.taskId} timed out after ${timeoutMs}ms — killing`)
      try {
        child.kill('SIGKILL')
      } catch {
        // best-effort
      }
    }
  }, timeoutMs)

  // Clear timeout when process exits naturally
  child.on('close', () => {
    clearTimeout(timer)
  })
}

// ---------------------------------------------------------------------------
// Plan parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse plan text into discrete task descriptions.
 * Supports numbered lists, bullet points, and section headers.
 */
function parsePlanText(planText: string): Array<{ description: string; files: string[] }> {
  const tasks: Array<{ description: string; files: string[] }> = []
  const lines = planText.split('\n')

  let currentTask: { description: string; files: string[] } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Detect numbered list items: "1.", "2)", "1:"
    const numberedMatch = trimmed.match(/^\d+[\.\)\:]\s+(.+)/)
    // Detect bullet points: "- ", "* ", "+ "
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)/)
    // Detect section headers: "## ", "### "
    const headerMatch = trimmed.match(/^#{2,4}\s+(.+)/)

    if (numberedMatch || bulletMatch || headerMatch) {
      // Start a new task
      if (currentTask && currentTask.description) {
        tasks.push(currentTask)
      }
      const desc = (numberedMatch?.[1] || bulletMatch?.[1] || headerMatch?.[1] || '').trim()
      currentTask = { description: desc, files: [] }
    } else if (currentTask) {
      // Check for file references in continuation lines
      const fileMatch = trimmed.match(/(?:file|path|modify|edit|create|update)s?\s*:?\s*[`"]?([^\s`"]+\.\w+)[`"]?/i)
      if (fileMatch) {
        currentTask.files.push(fileMatch[1])
      }
      // Also detect backtick file paths
      const backtickFiles = trimmed.match(/`([^`]+\.\w{1,10})`/g)
      if (backtickFiles) {
        for (const bf of backtickFiles) {
          const fp = bf.replace(/`/g, '')
          if (fp.includes('/') || fp.includes('.')) {
            if (!currentTask.files.includes(fp)) {
              currentTask.files.push(fp)
            }
          }
        }
      }
      // Append continuation text to description
      if (!fileMatch && !backtickFiles) {
        currentTask.description += ' ' + trimmed
      }
    }
  }

  // Push last task
  if (currentTask && currentTask.description) {
    tasks.push(currentTask)
  }

  return tasks
}

/**
 * Read the init file content for a provider from the project root.
 */
function readInitFileContent(provider: DelegationProvider, projectRoot: string): string | null {
  const fileName = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'
  const filePath = path.join(projectRoot, fileName)
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8')
    }
  } catch {
    // non-fatal
  }
  return null
}

/**
 * Save a delegation plan to the context directory.
 */
function savePlan(workflowId: string, plan: DelegationPlan): string {
  fs.mkdirSync(DELEGATION_CONTEXT_DIR, { recursive: true })
  const planPath = path.join(DELEGATION_CONTEXT_DIR, `${workflowId}.plan.json`)
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8')
  log('delegation', `Plan saved to ${planPath}`)
  return planPath
}

/**
 * Load a delegation plan from the context directory.
 */
function loadPlan(workflowId: string): DelegationPlan | null {
  const planPath = path.join(DELEGATION_CONTEXT_DIR, `${workflowId}.plan.json`)
  try {
    if (fs.existsSync(planPath)) {
      return JSON.parse(fs.readFileSync(planPath, 'utf8'))
    }
  } catch {
    // non-fatal
  }
  return null
}

/**
 * Parse JSON output loosely — handles claude's JSON output format.
 */
function parseJsonLoose(input: string): unknown | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // Try to find JSON in the output
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch {
        // not valid JSON
      }
    }
  }
  return null
}

/**
 * Extract response text from provider output.
 * Claude returns JSON with a result field; Gemini returns plain text.
 */
function extractResponseText(stdout: string, provider: DelegationProvider): string {
  if (provider === 'claude') {
    const parsed = parseJsonLoose(stdout)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.result === 'string') return obj.result
      if (typeof obj.response === 'string') return obj.response
      if (typeof obj.content === 'string') return obj.content
    }
  }
  // Fallback: return raw stdout (truncated)
  return stdout.length > 8000
    ? stdout.slice(0, 8000) + '\n...[truncated]'
    : stdout
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const DelegationOrchestrator: Plugin = async ({ client, directory, worktree }) => {
  // Get zod for tool arg schemas. Dynamic import resolves from config dir's node_modules
  // since plugins are copied (not symlinked) during install.
  const { tool: pluginTool } = await import('@opencode-ai/plugin')
  const z = pluginTool.schema

  const config = loadDelegationConfig()

  // Batch tracking: batchId -> (taskId -> TrackedExecution)
  const batches = new Map<string, Map<string, TrackedExecution>>()

  // Task metadata from plans (for redelegate lookups)
  const taskMeta = new Map<string, DelegationTask>()

  log('delegation', `DelegationOrchestrator initialized: max_parallel=${config.max_parallel}, routing=${config.routing.default_provider}`)

  return {
    tool: {
      // -----------------------------------------------------------------
      // 1. delegation_decompose
      // -----------------------------------------------------------------
      delegation_decompose: {
        description: "Parse plan text into discrete DelegationTasks with provider routing. Saves plan to context directory.",
        args: {
          planText: z.string().describe("Plan text with numbered/bulleted task descriptions"),
          workflowId: z.string().describe("Workflow ID for plan tracking"),
          featureBranch: z.string().describe("Git branch to base worktrees on"),
          routingConfig: z.object({
            ui_patterns: z.array(z.string()),
            default_provider: z.string(),
          }).optional().describe("Optional routing config override"),
        },
        async execute(args: {
          planText: string
          workflowId: string
          featureBranch: string
          routingConfig?: DelegationRoutingConfig
        }) {
          const { planText, workflowId, featureBranch } = args
          const routing = args.routingConfig ?? config.routing

          const parsedTasks = parsePlanText(planText)
          if (parsedTasks.length === 0) {
            return JSON.stringify({ error: 'No tasks could be parsed from the plan text' })
          }

          const now = new Date().toISOString()
          const tasks: DelegationTask[] = parsedTasks.map((parsed, index) => {
            const tag = inferTag(parsed.description, routing.ui_patterns)
            const provider = routeTask({ description: parsed.description, tag }, routing)
            const taskId = `task-${String(index + 1).padStart(2, '0')}`

            const task: DelegationTask = {
              id: taskId,
              description: parsed.description,
              tag,
              provider,
              prompt: '', // Built at execution time
              files: parsed.files,
              worktree_name: null,
              status: 'pending',
              attempt: 0,
              max_attempts: config.max_review_iterations,
              review_feedback: null,
              run_id: null,
              session_id: null,
              worktree_path: null,
              branch_name: null,
              created_at: now,
              updated_at: now,
            }

            // Store for redelegate lookups
            taskMeta.set(taskId, task)
            return task
          })

          const plan: DelegationPlan = {
            workflow_id: workflowId,
            feature_branch: featureBranch,
            tasks,
            max_parallel: config.max_parallel,
            created_at: now,
          }

          const planPath = savePlan(workflowId, plan)

          log('delegation', `Decomposed plan: ${tasks.length} tasks for workflow ${workflowId}`)
          return JSON.stringify({
            plan_path: planPath,
            task_count: tasks.length,
            tasks: tasks.map(t => ({
              id: t.id,
              description: t.description.slice(0, 120),
              tag: t.tag,
              provider: t.provider,
              files: t.files,
              status: t.status,
            })),
          })
        },
      },

      // -----------------------------------------------------------------
      // 2. delegation_init_files
      // -----------------------------------------------------------------
      delegation_init_files: {
        description: "Ensure CLAUDE.md and GEMINI.md init files exist in the project root. Uses the LLM to analyze the repo and generate context-aware init files. Falls back to static detection on timeout.",
        args: {
          projectRoot: z.string().describe("Absolute path to the project root directory"),
        },
        async execute(args: { projectRoot: string }) {
          const results: Record<string, { created: boolean; path: string; method: string }> = {}

          for (const provider of ['claude', 'gemini'] as const) {
            const fileName = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'
            const filePath = path.join(args.projectRoot, fileName)

            // Skip if file already exists
            if (fs.existsSync(filePath)) {
              results[provider] = { created: false, path: filePath, method: 'existing' }
              log('delegation', `Init file for ${provider}: already exists at ${filePath}`)
              continue
            }

            // LLM-first: spawn an OpenCode session to analyze the repo and write the file
            let generated = false
            try {
              log('delegation', `Generating ${fileName} via LLM analysis...`)
              const session = await client.session.create({ title: `Generate ${fileName}` })

              const cliName = provider === 'claude' ? 'Claude Code' : 'Gemini CLI'
              const prompt = [
                `Analyze the project at ${args.projectRoot} and generate a ${fileName} file.`,
                `This file provides context to ${cliName} when working on this project.`,
                '',
                'Read key files (package.json, composer.json, Cargo.toml, go.mod, pyproject.toml,',
                'Makefile, Dockerfile, etc.) and scan the directory structure to understand the project.',
                '',
                `Write a concise, useful ${fileName} (under 150 lines) with these sections:`,
                '- # Project Name',
                '- ## Project Overview (what it does, languages, frameworks, architecture)',
                '- ## Development (install, build, test, lint commands)',
                '- ## Key Directories (brief descriptions)',
                '- ## Conventions (coding style, reference config files)',
                '- ## Important Notes (architectural decisions, gotchas)',
                '',
                `Start the file with: <!-- Auto-generated by OpenCode Workflows for ${cliName}. Edit freely. -->`,
                `Write the file to: ${filePath}`,
                'Write ONLY the file. No explanations.',
              ].join('\n')

              await client.session.promptAsync({
                path: { id: session.id },
                body: { content: prompt },
              })

              // Poll for the FILE to appear (not session status — simpler and more reliable)
              const timeoutMs = 90_000
              const pollMs = 2_000
              const start = Date.now()
              while (Date.now() - start < timeoutMs) {
                await new Promise(r => setTimeout(r, pollMs))
                if (fs.existsSync(filePath)) {
                  // File exists — wait a bit more for write to complete
                  await new Promise(r => setTimeout(r, 1000))
                  generated = true
                  break
                }
              }

              // Clean up session
              try { await client.session.cancel({ path: { id: session.id } }) } catch { /* best effort */ }

              if (generated) {
                results[provider] = { created: true, path: filePath, method: 'llm' }
                log('delegation', `Init file for ${provider}: generated via LLM at ${filePath}`)
              } else {
                log('delegation', `LLM generation timed out for ${provider} after ${timeoutMs}ms`)
              }
            } catch (err) {
              log('delegation', `LLM generation failed for ${provider}: ${err}`)
            }

            // Fallback to static detection if LLM didn't produce the file
            if (!generated) {
              try {
                log('delegation', `Falling back to static detection for ${fileName}`)
                const result = ensureInitFile(provider, args.projectRoot)
                results[provider] = { created: result.created, path: result.path, method: 'static' }
                log('delegation', `Init file for ${provider}: ${result.created ? 'created (static)' : 'failed'} at ${result.path}`)
              } catch (err) {
                results[provider] = { created: false, path: `error: ${err}`, method: 'failed' }
                log('delegation', `Failed to ensure init file for ${provider}: ${err}`)
              }
            }
          }

          return JSON.stringify(results)
        },
      },

      // -----------------------------------------------------------------
      // 3. delegation_execute_batch
      // -----------------------------------------------------------------
      delegation_execute_batch: {
        description: "Spawn CLI processes in git worktrees for a batch of delegation tasks. Respects max_parallel concurrency.",
        args: {
          batchId: z.string().describe("Unique batch identifier"),
          tasks: z.array(z.object({
            id: z.string(),
            description: z.string(),
            tag: z.string().optional(),
            provider: z.string(),
            files: z.array(z.string()).optional(),
            branch_name: z.string().optional(),
            review_feedback: z.string().optional(),
          })).describe("Tasks to execute in parallel"),
          projectRoot: z.string().describe("Absolute path to project root"),
          workflowId: z.string().optional().describe("Workflow ID for worktree branch naming"),
          featureBranch: z.string().optional().describe("Base branch for worktrees"),
        },
        async execute(args: {
          batchId: string
          tasks: Array<{
            id: string
            description: string
            tag?: DelegationTaskTag
            provider: DelegationProvider
            files?: string[]
            branch_name?: string
            review_feedback?: string | null
          }>
          projectRoot: string
          workflowId?: string
          featureBranch?: string
        }) {
          const { batchId, tasks, projectRoot } = args
          const workflowId = args.workflowId ?? 'unknown'
          const featureBranch = args.featureBranch ?? 'main'
          const batchSessions = new Map<string, TrackedExecution>()
          const spawned: string[] = []
          const errors: string[] = []

          // Limit concurrency
          const maxParallel = config.max_parallel
          const toSpawn = tasks.slice(0, maxParallel)
          const queued = tasks.slice(maxParallel)

          for (const task of toSpawn) {
            const provider = task.provider || config.routing.default_provider

            // Create worktree
            const worktreeState = createWorktree(
              projectRoot,
              task.id,
              featureBranch,
              workflowId,
              provider,
            )

            if (!worktreeState) {
              errors.push(`Failed to create worktree for task ${task.id}`)
              log('delegation', `Failed to create worktree for task ${task.id}`)
              continue
            }

            // Read init file content
            const initContent = readInitFileContent(provider, projectRoot)

            // Build a DelegationTask for buildPrompt
            const delegationTask: DelegationTask = {
              id: task.id,
              description: task.description,
              tag: task.tag ?? 'code',
              provider,
              prompt: '',
              files: task.files ?? [],
              worktree_name: worktreeState.name,
              status: 'executing',
              attempt: 1,
              max_attempts: config.max_review_iterations,
              review_feedback: task.review_feedback ?? null,
              run_id: null,
              session_id: null,
              worktree_path: worktreeState.path,
              branch_name: worktreeState.branch,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }

            // Store task metadata for redelegate
            taskMeta.set(task.id, delegationTask)

            // Build prompt and CLI args
            const prompt = buildPrompt(delegationTask, initContent, task.review_feedback ?? null)
            const { command, args: cliArgs } = buildCliArgs(
              provider,
              prompt,
              config,
            )

            // Create tracked execution
            const tracked: TrackedExecution = {
              taskId: task.id,
              provider,
              worktreePath: worktreeState.path,
              branchName: worktreeState.branch,
              startedAt: Date.now(),
              stdout: '',
              stderr: '',
              exitCode: null,
              completed: false,
              timedOut: false,
              pid: null,
              process: null,
            }

            batchSessions.set(task.id, tracked)

            // Determine timeout
            const timeoutMs = provider === 'claude'
              ? (config.claude.timeout_ms ?? 300_000)
              : (config.gemini.timeout_ms ?? 300_000)

            // Spawn the process in the worktree directory
            spawnTracked(command, cliArgs, worktreeState.path, timeoutMs, tracked)

            spawned.push(`${task.id} -> ${provider} (pid=${tracked.pid}, worktree=${worktreeState.path})`)
            log('delegation', `Spawned ${task.id}: ${command} in ${worktreeState.path} (pid=${tracked.pid})`)

            // Small delay between spawns to avoid thundering herd
            if (toSpawn.indexOf(task) < toSpawn.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 200))
            }
          }

          batches.set(batchId, batchSessions)

          return JSON.stringify({
            batchId,
            spawned: spawned.length,
            queued: queued.length,
            errors,
            details: spawned,
            queued_tasks: queued.map(t => t.id),
          })
        },
      },

      // -----------------------------------------------------------------
      // 4. delegation_await_batch
      // -----------------------------------------------------------------
      delegation_await_batch: {
        description: "Wait for all CLI processes in a batch to complete. Polls at 3s intervals with timeout support.",
        args: {
          batchId: z.string().describe("Batch ID to wait for"),
          timeoutMs: z.number().optional().describe("Max wait time in ms (default 600000)"),
        },
        async execute(args: { batchId: string; timeoutMs?: number }) {
          const batch = batches.get(args.batchId)
          if (!batch) {
            return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          }

          const timeout = args.timeoutMs ?? 600_000
          const pollInterval = 3000
          const start = Date.now()

          while (Date.now() - start < timeout) {
            let allDone = true

            for (const [taskId, tracked] of batch) {
              if (!tracked.completed) {
                allDone = false
                break
              }
            }

            if (allDone) {
              log('delegation', `Batch ${args.batchId} completed`)

              const results: Record<string, { status: string; exit_code: number | null; duration_ms: number; timed_out: boolean }> = {}
              for (const [taskId, tracked] of batch) {
                results[taskId] = {
                  status: tracked.timedOut ? 'timed_out'
                    : tracked.exitCode === 0 ? 'success'
                    : 'failed',
                  exit_code: tracked.exitCode,
                  duration_ms: Date.now() - tracked.startedAt,
                  timed_out: tracked.timedOut,
                }
              }

              return JSON.stringify({
                batchId: args.batchId,
                completed: true,
                results,
              })
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval))
          }

          // Timeout: kill remaining processes
          for (const [taskId, tracked] of batch) {
            if (!tracked.completed && tracked.process) {
              log('delegation', `Killing timed-out process for task ${taskId}`)
              tracked.timedOut = true
              try {
                tracked.process.kill('SIGKILL')
              } catch {
                // best-effort
              }
            }
          }

          // Give killed processes a moment to finalize
          await new Promise(resolve => setTimeout(resolve, 500))

          const results: Record<string, { status: string; exit_code: number | null; duration_ms: number; timed_out: boolean }> = {}
          for (const [taskId, tracked] of batch) {
            results[taskId] = {
              status: tracked.timedOut ? 'timed_out'
                : tracked.exitCode === 0 ? 'success'
                : tracked.completed ? 'failed'
                : 'killed',
              exit_code: tracked.exitCode,
              duration_ms: Date.now() - tracked.startedAt,
              timed_out: tracked.timedOut,
            }
          }

          return JSON.stringify({
            batchId: args.batchId,
            completed: false,
            timedOut: true,
            results,
          })
        },
      },

      // -----------------------------------------------------------------
      // 5. delegation_collect_results
      // -----------------------------------------------------------------
      delegation_collect_results: {
        description: "Collect full results from a completed batch: stdout, changed files, diff stats.",
        args: {
          batchId: z.string().describe("Batch ID to collect results from"),
        },
        async execute(args: { batchId: string }) {
          const batch = batches.get(args.batchId)
          if (!batch) {
            return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          }

          const results: Record<string, {
            status: string
            response_text: string
            changed_files: string[]
            diff_stat: string
            provider: DelegationProvider
            exit_code: number | null
            duration_ms: number
            stderr_preview: string
          }> = {}

          for (const [taskId, tracked] of batch) {
            // Get worktree status (changed files, diff stat)
            let changed_files: string[] = []
            let diff_stat = ''

            if (tracked.worktreePath && fs.existsSync(tracked.worktreePath)) {
              const wtStatus = getWorktreeStatus(tracked.worktreePath)
              changed_files = wtStatus.changed_files
              diff_stat = wtStatus.diff_stat
            }

            // Extract response text from stdout
            const responseText = extractResponseText(tracked.stdout, tracked.provider)

            // Truncate stderr preview
            const stderrPreview = tracked.stderr.length > 2000
              ? tracked.stderr.slice(0, 2000) + '\n...[truncated]'
              : tracked.stderr

            const status = tracked.timedOut ? 'timed_out'
              : tracked.exitCode === 0 ? 'success'
              : 'failed'

            results[taskId] = {
              status,
              response_text: responseText,
              changed_files,
              diff_stat,
              provider: tracked.provider,
              exit_code: tracked.exitCode,
              duration_ms: Date.now() - tracked.startedAt,
              stderr_preview: stderrPreview,
            }
          }

          return JSON.stringify({ batchId: args.batchId, results })
        },
      },

      // -----------------------------------------------------------------
      // 6. delegation_redelegate
      // -----------------------------------------------------------------
      delegation_redelegate: {
        description: "Re-run a failed task with review feedback. Resets the worktree and re-spawns the CLI process.",
        args: {
          taskId: z.string().describe("Task ID to redelegate"),
          feedback: z.string().describe("Review feedback for the task"),
          batchId: z.string().describe("Batch ID containing the task"),
          projectRoot: z.string().optional().describe("Absolute path to project root"),
        },
        async execute(args: {
          taskId: string
          feedback: string
          batchId: string
          projectRoot?: string
        }) {
          const batch = batches.get(args.batchId)
          if (!batch) {
            return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          }

          const tracked = batch.get(args.taskId)
          if (!tracked) {
            return JSON.stringify({ error: `Task ${args.taskId} not found in batch ${args.batchId}` })
          }

          // Look up task metadata
          const task = taskMeta.get(args.taskId)
          if (!task) {
            return JSON.stringify({ error: `No task metadata for ${args.taskId}` })
          }

          // Check max attempts
          task.attempt += 1
          if (task.attempt > task.max_attempts) {
            return JSON.stringify({
              taskId: args.taskId,
              error: `Max attempts reached (${task.max_attempts})`,
              attempt: task.attempt,
              max_attempts: task.max_attempts,
              status: 'failed',
            })
          }

          // Reset worktree to base branch state
          if (tracked.worktreePath && fs.existsSync(tracked.worktreePath)) {
            try {
              const { execSync } = await import('node:child_process')
              // Reset to the merge-base (the point where the branch diverged)
              execSync(
                `git -C ${tracked.worktreePath} reset --hard ${tracked.branchName}~0 2>/dev/null || git -C ${tracked.worktreePath} checkout -- .`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
              )
              // Clean untracked files
              execSync(
                `git -C ${tracked.worktreePath} clean -fd`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
              )
              log('delegation', `Reset worktree for task ${args.taskId}`)
            } catch (err) {
              log('delegation', `Warning: could not fully reset worktree for ${args.taskId}: ${err}`)
            }
          }

          // Read init file content
          const projectRoot = args.projectRoot ?? path.dirname(tracked.worktreePath)
          const initContent = readInitFileContent(tracked.provider, projectRoot)

          // Update task with feedback
          task.review_feedback = args.feedback
          task.status = 'executing'
          task.updated_at = new Date().toISOString()

          // Rebuild prompt with feedback
          const prompt = buildPrompt(task, initContent, args.feedback)
          const { command, args: cliArgs } = buildCliArgs(
            tracked.provider,
            prompt,
            config,
          )

          // Reset tracked state
          tracked.stdout = ''
          tracked.stderr = ''
          tracked.exitCode = null
          tracked.completed = false
          tracked.timedOut = false
          tracked.startedAt = Date.now()

          // Determine timeout
          const timeoutMs = tracked.provider === 'claude'
            ? (config.claude.timeout_ms ?? 300_000)
            : (config.gemini.timeout_ms ?? 300_000)

          // Re-spawn
          spawnTracked(command, cliArgs, tracked.worktreePath, timeoutMs, tracked)

          log('delegation', `Redelegated ${args.taskId}: attempt ${task.attempt}/${task.max_attempts}`)

          return JSON.stringify({
            taskId: args.taskId,
            attempt: task.attempt,
            max_attempts: task.max_attempts,
            status: 'executing',
            provider: tracked.provider,
          })
        },
      },

      // -----------------------------------------------------------------
      // 7. delegation_merge_task
      // -----------------------------------------------------------------
      delegation_merge_task: {
        description: "Merge a completed task's worktree branch into the target branch.",
        args: {
          taskId: z.string().describe("Task ID to merge"),
          targetBranch: z.string().describe("Branch to merge into"),
          batchId: z.string().describe("Batch ID containing the task"),
          projectRoot: z.string().describe("Absolute path to project root"),
        },
        async execute(args: {
          taskId: string
          targetBranch: string
          batchId: string
          projectRoot: string
        }) {
          const batch = batches.get(args.batchId)
          if (!batch) {
            return JSON.stringify({ error: `Batch ${args.batchId} not found` })
          }

          const tracked = batch.get(args.taskId)
          if (!tracked) {
            return JSON.stringify({ error: `Task ${args.taskId} not found in batch ${args.batchId}` })
          }

          if (!tracked.worktreePath || !fs.existsSync(tracked.worktreePath)) {
            return JSON.stringify({ error: `Worktree not found for task ${args.taskId}` })
          }

          const result = mergeWorktree(args.projectRoot, tracked.worktreePath, args.targetBranch)

          if (result.success) {
            // Update task metadata
            const task = taskMeta.get(args.taskId)
            if (task) {
              task.status = 'merged'
              task.updated_at = new Date().toISOString()
            }
            log('delegation', `Merged task ${args.taskId} into ${args.targetBranch}: ${result.merge_commit}`)
          } else {
            log('delegation', `Merge failed for task ${args.taskId}: ${result.conflicts.length} conflicts`)
          }

          return JSON.stringify({
            taskId: args.taskId,
            merged: result.success,
            conflicts: result.conflicts,
            merge_commit: result.merge_commit,
          })
        },
      },

      // -----------------------------------------------------------------
      // 8. delegation_cleanup
      // -----------------------------------------------------------------
      delegation_cleanup: {
        description: "Remove all delegation worktrees for a workflow. Cleans up branches and worktree directories.",
        args: {
          workflowId: z.string().describe("Workflow ID to clean up"),
          projectRoot: z.string().describe("Absolute path to project root"),
        },
        async execute(args: { workflowId: string; projectRoot: string }) {
          const removed = cleanupStaleWorktrees(args.projectRoot, args.workflowId)

          // Clean up batch tracking for this workflow
          for (const [batchId, batch] of batches) {
            let allFromThisWorkflow = true
            for (const [_, tracked] of batch) {
              if (!tracked.branchName.includes(args.workflowId)) {
                allFromThisWorkflow = false
                break
              }
            }
            if (allFromThisWorkflow) {
              batches.delete(batchId)
              log('delegation', `Removed batch tracking: ${batchId}`)
            }
          }

          log('delegation', `Cleanup for workflow ${args.workflowId}: removed ${removed} worktree(s)`)

          return JSON.stringify({
            workflowId: args.workflowId,
            removed,
          })
        },
      },
    },
  }
}

export default DelegationOrchestrator
