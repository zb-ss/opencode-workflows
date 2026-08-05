/**
 * Hardened Git invocation defaults.
 *
 * Privileged Git operations must not execute user-defined code from the
 * repository, user configuration, or system configuration. This module
 * builds subprocess environments from an allowlist (never inheriting
 * process.env wholesale), disables hooks, external diff/textconv, fsmonitor,
 * replace refs, global attributes, and environment-based configuration
 * injection. Operations that materialize files or compute merges run through
 * git-merge-sandbox.ts with a private Git directory that has no repository
 * config or info/attributes.
 *
 * Every privileged `git` call in this project should be routed through
 * these helpers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function assertTrustedExecutablePath(executable: string): fs.Stats {
  const executableStat = fs.statSync(executable)
  if (!executableStat.isFile() || executableStat.uid !== 0 || (executableStat.mode & 0o022) !== 0) {
    throw new Error('untrusted Git executable')
  }
  let parent = path.dirname(executable)
  const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : 0
  while (true) {
    const parentStat = fs.statSync(parent)
    const trustedOwner = parentStat.uid === 0
      || (process.platform === 'linux' && runtimeUid !== 0 && parentStat.uid === runtimeUid)
    if (!parentStat.isDirectory() || !trustedOwner || (parentStat.mode & 0o022) !== 0) {
      throw new Error('untrusted Git executable parent')
    }
    const next = path.dirname(parent)
    if (next === parent) break
    parent = next
  }
  return executableStat
}

function resolveTrustedGitExecutable(): string {
  const configured = process.env.OPENCODE_WORKFLOWS_GIT_EXECUTABLE
  if (configured && !path.isAbsolute(configured)) throw new Error('configured Git executable must be an absolute path')
  const startupDirectory = fs.realpathSync(process.cwd())
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'git'))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const executable = fs.realpathSync(candidate)
      if (!configured && startupDirectory !== path.parse(startupDirectory).root && isInside(startupDirectory, executable)) continue
      const executableStat = assertTrustedExecutablePath(executable)
      if (process.platform === 'linux') {
        const fd = fs.openSync(executable, fs.constants.O_RDONLY | (fs.constants?.O_NOFOLLOW ?? 0x20000))
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || opened.dev !== executableStat.dev || opened.ino !== executableStat.ino) {
          fs.closeSync(fd)
          continue
        }
        // Keep the read-only descriptor open for the process lifetime. Every
        // child executes this exact inode even if a writable parent directory
        // later rebinds the original pathname.
        return `/proc/${process.pid}/fd/${fd}`
      }
      return executable
    } catch {
      // Continue until a root-owned executable can be pinned safely.
    }
  }
  throw new Error(configured
    ? 'the configured Git executable is not trusted'
    : 'no trusted Git executable is available on the startup PATH')
}

const TRUSTED_GIT_EXECUTABLE = resolveTrustedGitExecutable()

export function trustedGitExecutable(): string {
  return TRUSTED_GIT_EXECUTABLE
}

function baseSandboxedGitArgs(): string[] {
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
    '-c', 'merge.conflictStyle=merge',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
  ]
}

/**
 * Arguments that suppress executable global defaults for non-materializing
 * plumbing commands. Merge and checkout operations use a private Git
 * directory through git-merge-sandbox.ts instead of trusting local config.
 */
export function sandboxedGitArgs(
  extraArgs: string[] = [],
  _cwd?: string,
  _extraEnv: Record<string, string | undefined> = {},
): string[] {
  return [
    ...baseSandboxedGitArgs(),
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
  // locate the git executable. No loader, shell, askpass, or repository-
  // supplied environment variable is inherited.
  const env: Record<string, string | undefined> = {
    PATH: path.dirname(TRUSTED_GIT_EXECUTABLE),
    HOME: os.devNull,
    XDG_CONFIG_HOME: os.devNull,
    LANG: 'C',
    LC_ALL: 'C',
    // Suppress system and global config. Repository-local executable drivers
    // are discovered and overridden by repositoryDriverOverrides().
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
    GIT_AUTHOR_NAME: 'OpenCode Workflows',
    GIT_AUTHOR_EMAIL: 'opencode-workflows@localhost',
    GIT_COMMITTER_NAME: 'OpenCode Workflows',
    GIT_COMMITTER_EMAIL: 'opencode-workflows@localhost',
  }

  // Only typed Git plumbing overrides created by trusted call sites are
  // accepted. Arbitrary non-Git variables could re-enable dynamic loaders,
  // alternate executables, or shell startup behavior.
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
    if (allowedGitVars.has(key)) env[key] = value
  }

  return env
}
