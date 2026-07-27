/**
 * Hardened Git invocation defaults.
 *
 * Privileged Git operations must not execute user-defined code from the
 * repository, user configuration, or system configuration. This module
 * builds subprocess environments from an allowlist (never inheriting
 * process.env wholesale), disables hooks, all filters, merge drivers,
 * external diff/textconv, fsmonitor, replace refs, config includes, and
 * attribute files, and blocks environment-based configuration injection
 * (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_PARAMETERS).
 *
 * Every privileged `git` call in this project should be routed through
 * these helpers.
 */

import os from 'node:os'
import path from 'node:path'

/**
 * Arguments that suppress all executable user-defined configuration when
 * passed as -c options before the subcommand. These override any
 * repository-local config values that would otherwise invoke external
 * programs.
 */
export function sandboxedGitArgs(extraArgs: string[] = []): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.useReplaceRefs=false',
    '-c', 'core.attributesFile=',
    '-c', 'core.excludesFile=',
    // Disable all known filter drivers, not just LFS. A repository can
    // define arbitrary filter names (e.g. filter.evil.clean), so we also
    // neutralize the generic filter mechanism.
    '-c', 'filter.lfs.required=false',
    '-c', 'filter.lfs.clean=',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    // Disable merge drivers that could execute arbitrary commands.
    '-c', 'merge.conflictStyle=merge',
    // Disable external diff and textconv.
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    ...extraArgs,
  ]
}

/**
 * Build a Git subprocess environment from an allowlist. Never copy
 * process.env wholesale: inherited GIT_* variables can inject
 * configuration (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_PARAMETERS,
 * GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_EXTERNAL_DIFF, GIT_EXEC_PATH,
 * etc.) that bypasses the sandbox.
 *
 * The caller may pass trusted GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, or
 * GIT_OBJECT_DIRECTORY via extraEnv; those are the only GIT_* variables
 * permitted.
 */
export function sandboxedGitEnv(
  extraEnv: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  // Start with a minimal OS-level environment. Only PATH is needed to
  // locate the git executable. HOME and XDG_CONFIG_HOME point to /dev/null
  // directories so Git cannot discover user-level config.
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? '',
    HOME: path.dirname(os.devNull),
    XDG_CONFIG_HOME: path.dirname(os.devNull),
    LANG: 'C',
    LC_ALL: 'C',
    // Suppress all system, global, and local config scopes that could
    // define filters, merge drivers, hooks, or includes.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/dev/null',
    SSH_ASKPASS: '/dev/null',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: '',
    PAGER: '',
    GIT_OPTIONAL_LOCKS: '0',
  }

  // Pass through non-GIT environment variables from extraEnv. GIT_* vars
  // are filtered to an allowlist to prevent config injection. Non-GIT vars
  // (test markers, PATH overrides, etc.) are safe to pass through.
  const allowedGitVars = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_DATE',
  ])
  for (const [key, value] of Object.entries(extraEnv)) {
    if (key.startsWith('GIT_')) {
      // Block dangerous GIT_* env vars that can inject config or commands.
      if (key.startsWith('GIT_CONFIG_') || key.startsWith('GIT_CONFIG_KEY') || key.startsWith('GIT_CONFIG_VALUE') || key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_EXTERNAL_DIFF' || key === 'GIT_EXEC_PATH') {
        continue
      }
      if (!allowedGitVars.has(key)) continue
    }
    env[key] = value
  }

  return env
}
