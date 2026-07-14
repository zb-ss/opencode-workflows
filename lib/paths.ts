import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) {
    return path.resolve(expandHome(env.OPENCODE_CONFIG_DIR))
  }
  if (env.XDG_CONFIG_HOME) {
    return path.resolve(expandHome(env.XDG_CONFIG_HOME), 'opencode')
  }
  return path.join(os.homedir(), '.config', 'opencode')
}

export function getWorkflowsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), 'workflows')
}

export function getRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getWorkflowsDir(env), 'runtime')
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function getSessionRuntimeDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getRuntimeDir(env), 'sessions', hashIdentifier(sessionId))
}

export function ensurePrivateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Some filesystems do not expose POSIX permissions.
  }
  return directory
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function assertPathInside(root: string, target: string, label = 'path'): string {
  const resolved = path.resolve(target)
  if (!isPathInside(root, resolved)) {
    throw new Error(`${label} is outside the allowed root`)
  }
  return resolved
}
