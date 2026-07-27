/**
 * Hardened Git invocation defaults.
 *
 * Privileged Git operations must not execute user-defined code from the
 * repository, user configuration, or system configuration. This module
 * provides the minimal set of overrides that disable hooks, filters,
 * fsmonitor, replace refs, and external attribute/exclude files while still
 * permitting repository-local config (which is required for normal Git behavior
 * in worktrees).
 *
 * Every privileged `git` call in this project should be routed through these
 * helpers. Read-only inspection of known-good object IDs may use fewer
 * overrides, but the conservative default is to apply all of them.
 */

export function sandboxedGitArgs(extraArgs: string[] = []): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.useReplaceRefs=false',
    '-c', 'core.attributesFile=',
    '-c', 'core.excludesFile=',
    '-c', 'filter.lfs.required=false',
    '-c', 'filter.lfs.clean=',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    '-c', 'core.pager=cat',
    ...extraArgs,
  ]
}

export function sandboxedGitEnv(extraEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extraEnv,
  }
}
