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
    const regex = new RegExp(`\\b${pattern}\\b`, 'i')
    if (regex.test(description)) {
      return 'ui'
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
 */
export function buildClaudeArgs(
  prompt: string,
  config: DelegationOrchestratorConfig,
  worktreeName: string | null,
): string[] {
  const args: string[] = ['--print']

  if (worktreeName !== null) {
    args.push('--worktree', worktreeName)
  }

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
 */
export function buildGeminiArgs(
  prompt: string,
  config: DelegationOrchestratorConfig,
): string[] {
  const args: string[] = []

  if (config.gemini.model) {
    args.push('--model', config.gemini.model)
  }

  args.push('--yolo')
  args.push('--output-format', 'json')
  args.push('--prompt', prompt)

  return args
}

/**
 * Builds the full CLI command and args for the given provider.
 */
export function buildCliArgs(
  provider: DelegationProvider,
  prompt: string,
  config: DelegationOrchestratorConfig,
  worktreeName: string | null,
): { command: string; args: string[] } {
  if (provider === 'claude') {
    return {
      command: 'claude',
      args: buildClaudeArgs(prompt, config, worktreeName),
    }
  }

  return {
    command: 'gemini',
    args: buildGeminiArgs(prompt, config),
  }
}
