import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { withLock, withLockAsync } from './fencing-lease.ts'
import { sandboxedGitArgs, sandboxedGitEnv, trustedGitExecutable } from './git-sandbox.ts'

function lockDirectory(projectRoot: string): string {
  const canonicalRoot = fs.realpathSync(projectRoot)
  const commonPath = execFileSync(
    trustedGitExecutable(),
    sandboxedGitArgs(['rev-parse', '--git-common-dir'], canonicalRoot),
    { cwd: canonicalRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: sandboxedGitEnv() },
  ).trim()
  const commonDirectory = fs.realpathSync(path.isAbsolute(commonPath) ? commonPath : path.resolve(canonicalRoot, commonPath))
  const commonIdentity = fs.statSync(commonDirectory, { bigint: true })
  if (!commonIdentity.isDirectory()) throw new Error('Git common directory is not a directory')
  return commonDirectory
}

export function withRepositoryOperationLock<T>(projectRoot: string, operation: () => T): T {
  return withLock(lockDirectory(projectRoot), operation)
}

export async function withRepositoryOperationLockAsync<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return await withLockAsync(lockDirectory(projectRoot), operation)
}
