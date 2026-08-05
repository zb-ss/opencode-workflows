import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hashIdentifier } from './identifier-hash.ts'

export { hashIdentifier } from './identifier-hash.ts'

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

function privateDirectoryWithoutSymlinks(directory: string, create: boolean): string {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let current = parsed.root
  const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : null
  const isProtected = (identity: fs.Stats): boolean => {
    const trustedOwner = runtimeUid === null || identity.uid === 0 || identity.uid === runtimeUid
    return trustedOwner && (identity.mode & 0o022) === 0
  }
  const rootIdentity = fs.lstatSync(current)
  let parentIsProtected = isProtected(rootIdentity)
  let parentIsSticky = (rootIdentity.mode & 0o1000) !== 0
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let identity: fs.Stats
    try {
      identity = fs.lstatSync(current)
      if (!parentIsProtected && !parentIsSticky) {
        throw new Error(`private directory path traverses an untrusted writable parent: ${path.dirname(current)}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) throw error
      if (!parentIsProtected) {
        throw new Error(`private directory path has an untrusted writable parent: ${path.dirname(current)}`)
      }
      fs.mkdirSync(current, { mode: 0o700 })
      identity = fs.lstatSync(current)
    }
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw new Error(`private directory path contains a non-directory or symbolic link: ${current}`)
    }
    parentIsProtected = isProtected(identity)
    parentIsSticky = (identity.mode & 0o1000) !== 0
  }
  if (!parentIsProtected) throw new Error(`private directory path is not protected from replacement: ${resolved}`)
  if (create) fs.chmodSync(resolved, 0o700)
  return resolved
}

export function ensurePrivateDirectoryWithoutSymlinks(directory: string): string {
  return privateDirectoryWithoutSymlinks(directory, true)
}

export function assertPrivateDirectoryWithoutSymlinks(directory: string): string {
  return privateDirectoryWithoutSymlinks(directory, false)
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
