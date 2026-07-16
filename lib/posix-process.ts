import fs from 'node:fs'
import path from 'node:path'

interface DetachedProcess {
  readonly pid?: number
  kill(signal: NodeJS.Signals): boolean
}

export function childDescriptorPath(descriptor: number): string {
  for (const directory of ['/proc/self/fd', '/dev/fd']) {
    try {
      if (fs.statSync(directory).isDirectory()) return path.join(directory, String(descriptor))
    } catch {
      // Try the next supported descriptor filesystem.
    }
  }
  throw new Error('process descriptor filesystem is unavailable')
}

export function terminateDetachedProcessGroup(
  child: DetachedProcess,
  label: string,
  platform: NodeJS.Platform = process.platform,
): Error | null {
  if (!child.pid) return new Error(`${label} process has no PID to terminate`)
  let groupError: unknown = null
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null
      groupError = error
    }
  }
  try {
    if (child.kill('SIGKILL')) return null
    throw new Error(`direct ${label} termination returned false`)
  } catch (error) {
    return groupError
      ? new AggregateError([groupError, error], `${label} process-group termination failed`)
      : (error instanceof Error ? error : new Error(String(error)))
  }
}
