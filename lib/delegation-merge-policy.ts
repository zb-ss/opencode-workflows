/** Returns why a delegated task must not be merged, or null when the merge is allowed. */
export function delegationMergeError(input: {
  completed: boolean
  exitCode: number | null
  aborted: boolean
  timedOut: boolean
  executionError: string | null
  taskStatus: string | null
  targetBranch: string
  featureBranch: string
}): string | null {
  if (!input.completed) return 'Task is still running'
  if (input.exitCode !== 0 || input.aborted || input.timedOut || input.executionError) {
    return 'Task did not complete successfully'
  }
  if (input.taskStatus !== 'passed') return 'Task requires a recorded passing review before merge'
  if (input.targetBranch !== input.featureBranch) return `Merge target must be the authorized feature branch ${input.featureBranch}`
  return null
}
