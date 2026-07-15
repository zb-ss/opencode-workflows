import fs from 'node:fs'
import path from 'node:path'

import { isPathInside } from './paths.ts'
import type { ValidationOperation } from './validation-types.ts'

function environmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return source[name] ?? Object.entries(source)
    .find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1]
}

function trustedHostPath(target: string): boolean {
  const owner = process.getuid?.()
  const root = path.parse(target).root
  const segments = path.relative(root, target).split(path.sep).filter(Boolean)
  const isTrusted = (stat: fs.Stats) => (
    (stat.mode & 0o022) === 0
    && (owner === undefined || stat.uid === 0 || stat.uid === owner)
  )
  if (!isTrusted(fs.statSync(root))) return false
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    if (!isTrusted(fs.statSync(current))) return false
  }
  return true
}

export function validationDirectory(worktree: string, configuredDirectory: string): string {
  if (path.posix.isAbsolute(configuredDirectory) || path.win32.isAbsolute(configuredDirectory)) {
    throw new Error('validation working directory must be relative to the workflow worktree')
  }
  const root = path.resolve(worktree)
  const target = path.resolve(root, configuredDirectory)
  if (!isPathInside(root, target)) throw new Error('validation working directory is outside the workflow worktree')
  return target
}

export function trustedExecutable(
  configuredExecutable: string,
  source: NodeJS.ProcessEnv,
  worktree: string,
): { executable: string; searchPath: string } {
  if (!path.isAbsolute(configuredExecutable)) {
    throw new Error('validation executable must be an operator-configured absolute path')
  }
  const configuredPath = environmentValue(source, 'PATH') ?? ''
  const lexicalRoot = path.resolve(worktree)
  const realRoot = fs.realpathSync(lexicalRoot)
  const directories: string[] = []

  for (const entry of configuredPath.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue
    const lexicalDirectory = path.resolve(entry)
    if (isPathInside(lexicalRoot, lexicalDirectory)) continue
    try {
      const realDirectory = fs.realpathSync(lexicalDirectory)
      if (isPathInside(realRoot, realDirectory)
        || !fs.statSync(realDirectory).isDirectory()
        || !trustedHostPath(realDirectory)) continue
      if (!directories.includes(realDirectory)) directories.push(realDirectory)
    } catch {
      // Missing and inaccessible PATH entries are not executable authority.
    }
  }

  fs.accessSync(configuredExecutable, fs.constants.X_OK)
  const executable = fs.realpathSync(configuredExecutable)
  const stat = fs.statSync(executable)
  if (!stat.isFile() || isPathInside(realRoot, executable) || !trustedHostPath(executable)) {
    throw new Error('validation executable path is not a trusted external regular file')
  }
  return { executable, searchPath: directories.join(path.delimiter) }
}

export function validationEnvironment(
  operation: ValidationOperation,
  source: NodeJS.ProcessEnv,
  searchPath: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const required = platform === 'win32' ? ['PATHEXT', 'SystemRoot', 'TEMP', 'TMP'] : []
  const environment = Object.fromEntries([...new Set([...required, ...operation.environment])]
    .map((name) => [name, environmentValue(source, name)])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  environment.PATH = searchPath
  return environment
}
