/**
 * Task Router for Delegation Orchestration
 *
 * Routes tasks to providers (Claude/Gemini) based on tags and patterns.
 * Builds CLI arguments and prompts for each provider.
 */

import type {
  DelegationTask,
  DelegationRoutingConfig,
  DelegationOrchestratorConfig,
  DelegationProvider,
  DelegationTaskTag,
} from './types.ts'

/**
 * Infers a task tag from the description using word-boundary pattern matching.
 * Returns 'ui' if any pattern matches, otherwise 'code'.
 */
export function inferTag(description: string, uiPatterns: string[]): DelegationTaskTag {
  for (const pattern of uiPatterns) {
    try {
      // Escape regex special chars in pattern before building regex
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`\\b${escaped}\\b`, 'i')
      if (regex.test(description)) {
        return 'ui'
      }
    } catch {
      // If regex fails, fall back to simple includes check
      if (description.toLowerCase().includes(pattern.toLowerCase())) {
        return 'ui'
      }
    }
  }
  return 'code'
}

/**
 * Routes a task to a provider based on explicit tag or inferred tag from description.
 * Explicit: code → claude, ui → gemini.
 * Inferred: ui → gemini, otherwise → config.default_provider.
 */
export function routeTask(
  task: { description: string; tag?: DelegationTaskTag },
  config: DelegationRoutingConfig,
): DelegationProvider {
  if (task.tag === 'code') {
    return 'claude'
  }

  if (task.tag === 'ui') {
    return 'gemini'
  }

  const inferred = inferTag(task.description, config.ui_patterns)

  if (inferred === 'ui') {
    return 'gemini'
  }

  return config.default_provider
}

/**
 * Composes the full prompt string for a delegation task.
 * Includes project context, task description, relevant files, and revision requirements.
 */
export function buildPrompt(
  task: DelegationTask,
  initFileContent: string | null,
  reviewFeedback: string | null,
): string {
  const sections: string[] = []

  if (initFileContent !== null) {
    sections.push(`## Project Context\n${initFileContent}`)
  }

  sections.push(`## Task\n${task.description}`)

  if (task.files.length > 0) {
    const fileList = task.files.map((f) => `- ${f}`).join('\n')
    sections.push(`## Relevant Files\n${fileList}`)
  }

  if (reviewFeedback !== null) {
    sections.push(`## Revision Requirements\n${reviewFeedback}\n\nAddress ALL issues listed above.`)
  }

  return sections.join('\n\n')
}

/**
 * Builds CLI argument array for the claude command.
 * NOTE: No --worktree flag — we manage worktrees ourselves and set CWD
 * to the worktree path when spawning. This ensures changes land in OUR
 * worktree, not a separate one created by the CLI.
 */
export function buildClaudeArgs(
  prompt: string,
  config: DelegationOrchestratorConfig,
): string[] {
  const args: string[] = ['--print']

  if (config.claude.permission_mode) {
    args.push(`--${config.claude.permission_mode}`)
  }

  if (config.claude.model) {
    args.push('--model', config.claude.model)
  }

  args.push('--output-format', 'json')
  args.push('--', prompt)

  return args
}

/**
 * Builds CLI argument array for the gemini command.
 * Always emits `--model` using the value from config. Throws if
 * `delegation.gemini.model` is not set in workflows.json — the model must
 * be defined in config so it can be updated without touching code.
 */
export function buildGeminiArgs(
  prompt: string,
  config: DelegationOrchestratorConfig,
): string[] {
  const model = config.gemini.model
  if (!model) {
    throw new Error(
      'delegation.gemini.model is not set in workflows.json. ' +
      'Add a model alias exposed by your installed Gemini CLI under the "delegation.gemini" key.',
    )
  }

  const args: string[] = ['--model', model]
  args.push('--yolo')
  args.push('--output-format', 'json')
  args.push('--prompt', prompt)

  return args
}

/**
 * Builds the full CLI command and args for the given provider.
 * worktreePath is used as CWD when spawning (not as a CLI flag).
 */
export function buildCliArgs(
  provider: DelegationProvider,
  prompt: string,
  config: DelegationOrchestratorConfig,
): { command: string; args: string[] } {
  if (provider === 'claude') {
    return {
      command: 'claude',
      args: buildClaudeArgs(prompt, config),
    }
  }

  return {
    command: 'gemini',
    args: buildGeminiArgs(prompt, config),
  }
}
