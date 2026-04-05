/**
 * Git Worktree Manager for Delegation Orchestration
 *
 * Manages git worktree lifecycle: create, list, merge, discard, cleanup.
 * Used by the delegation orchestrator to isolate CLI task execution.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WorktreeState, DelegationProvider } from './types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Parse the branch name that is checked out in a given worktree path.
 * Reads `.git/HEAD` inside the worktree directory (git writes a regular file
 * there, not a directory, for linked worktrees).
 */
function readWorktreeBranch(worktreePath: string): string {
  try {
    // git worktree list --porcelain already gives us the branch; this is a
    // convenience for callers that only have the path.
    const head = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8').trim()
    // .git in a linked worktree is a file like: "gitdir: ../../.git/worktrees/<name>"
    // Resolve the actual gitdir and read HEAD from there.
    const gitdirLine = head.startsWith('gitdir:') ? head.slice('gitdir:'.length).trim() : null
    if (!gitdirLine) return ''
    const gitdir = path.resolve(worktreePath, gitdirLine)
    const headContent = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim()
    return headContent.startsWith('ref: refs/heads/')
      ? headContent.slice('ref: refs/heads/'.length)
      : headContent
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the worktrees base directory for a project.
 * Creates it and adds it to .gitignore if it does not already exist.
 */
export function getWorktreeDir(projectRoot: string): string {
  const worktreeDir = path.join(projectRoot, '.worktrees')

  if (!fs.existsSync(worktreeDir)) {
    fs.mkdirSync(worktreeDir, { recursive: true })
    console.error(`[worktree-manager] created worktrees dir: ${worktreeDir}`)
  }

  // Ensure .worktrees is ignored
  const gitignorePath = path.join(projectRoot, '.gitignore')
  try {
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : ''
    const lines = existing.split('\n').map(l => l.trim())
    if (!lines.includes('.worktrees') && !lines.includes('.worktrees/')) {
      const entry = existing.endsWith('\n') || existing === ''
        ? '.worktrees/\n'
        : '\n.worktrees/\n'
      fs.appendFileSync(gitignorePath, entry, 'utf8')
      console.error('[worktree-manager] added .worktrees/ to .gitignore')
    }
  } catch (err) {
    console.error(`[worktree-manager] warning: could not update .gitignore: ${err}`)
  }

  return worktreeDir
}

/**
 * Create a new git worktree for a delegation task.
 *
 * Worktree path : <projectRoot>/.worktrees/delegate-<taskId>
 * Branch        : delegate/<workflowId>/<taskId>
 *
 * Returns a WorktreeState on success, null on failure.
 */
export function createWorktree(
  projectRoot: string,
  taskId: string,
  baseBranch: string,
  workflowId: string,
  provider: DelegationProvider = 'claude',
): WorktreeState | null {
  const worktreeDir = getWorktreeDir(projectRoot)
  const worktreePath = path.join(worktreeDir, `delegate-${taskId}`)
  const branchName = `delegate/${workflowId}/${taskId}`

  try {
    exec(
      `git worktree add -b ${branchName} ${worktreePath} ${baseBranch}`,
      projectRoot,
    )
    console.error(`[worktree-manager] created worktree: ${worktreePath} on branch ${branchName}`)

    const state: WorktreeState = {
      name: `delegate-${taskId}`,
      path: worktreePath,
      branch: branchName,
      task_id: taskId,
      provider,
      status: 'active',
      created_at: new Date().toISOString(),
      merged_at: null,
    }
    return state
  } catch (err) {
    console.error(`[worktree-manager] failed to create worktree for task ${taskId}: ${err}`)
    return null
  }
}

/**
 * Remove a worktree and delete its branch.
 *
 * Returns true on success, false on failure.
 */
export function removeWorktree(projectRoot: string, worktreePath: string): boolean {
  // Determine branch before removing the worktree
  const branch = readWorktreeBranch(worktreePath)

  try {
    exec(`git worktree remove ${worktreePath} --force`, projectRoot)
    console.error(`[worktree-manager] removed worktree: ${worktreePath}`)
  } catch (err) {
    console.error(`[worktree-manager] failed to remove worktree ${worktreePath}: ${err}`)
    return false
  }

  if (branch) {
    try {
      exec(`git branch -D ${branch}`, projectRoot)
      console.error(`[worktree-manager] deleted branch: ${branch}`)
    } catch (err) {
      // Non-fatal — branch may already be gone
      console.error(`[worktree-manager] warning: could not delete branch ${branch}: ${err}`)
    }
  }

  return true
}

/**
 * List all active delegation worktrees for a project.
 *
 * Parses `git worktree list --porcelain` and filters to paths matching
 * `.worktrees/delegate-*`.
 */
export function listWorktrees(projectRoot: string): WorktreeState[] {
  const worktreeDir = path.join(projectRoot, '.worktrees')

  let raw: string
  try {
    raw = exec('git worktree list --porcelain', projectRoot)
  } catch (err) {
    console.error(`[worktree-manager] failed to list worktrees: ${err}`)
    return []
  }

  // Each worktree block is separated by a blank line
  const blocks = raw.split(/\n\n+/).filter(Boolean)
  const result: WorktreeState[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const worktree: Partial<WorktreeState> & { worktree?: string } = {}

    for (const line of lines) {
      if (line.startsWith('worktree ')) worktree.worktree = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) worktree.branch = line.slice('branch refs/heads/'.length)
    }

    const wPath = worktree.worktree ?? ''
    if (!wPath.startsWith(worktreeDir) || !path.basename(wPath).startsWith('delegate-')) {
      continue
    }

    const name = path.basename(wPath)
    const taskId = name.replace(/^delegate-/, '')
    const branch = worktree.branch ?? ''

    // Derive provider from branch name if possible (delegate/<workflowId>/<taskId>)
    // We cannot know the provider just from the branch, so default to 'claude'.
    const state: WorktreeState = {
      name,
      path: wPath,
      branch,
      task_id: taskId,
      provider: 'claude',
      status: 'active',
      created_at: '',
      merged_at: null,
    }
    result.push(state)
  }

  return result
}

/**
 * Merge a worktree branch into a target branch using --no-ff.
 *
 * Returns success flag, list of conflicted files (if any), and the merge
 * commit hash (if the merge succeeded).
 */
export function mergeWorktree(
  projectRoot: string,
  worktreePath: string,
  targetBranch: string,
): { success: boolean; conflicts: string[]; merge_commit: string | null } {
  const failure = (conflicts: string[] = []) => ({ success: false, conflicts, merge_commit: null })

  // Determine the branch checked out in the worktree
  const branch = readWorktreeBranch(worktreePath)
  if (!branch) {
    console.error(`[worktree-manager] could not determine branch for worktree ${worktreePath}`)
    return failure()
  }

  // Check whether the worktree has any changes vs its base
  let diffStat = ''
  try {
    diffStat = exec(`git -C ${worktreePath} diff --stat HEAD`)
  } catch {
    // If HEAD doesn't exist yet (fresh worktree with no commits) diffStat stays ''
  }

  // Also check for commits ahead of the base branch
  let aheadCount = 0
  try {
    const aheadOutput = exec(
      `git -C ${worktreePath} rev-list --count HEAD ^${targetBranch}`,
    )
    aheadCount = parseInt(aheadOutput, 10) || 0
  } catch {
    // Ignore — may not have a common ancestor yet
  }

  if (!diffStat && aheadCount === 0) {
    console.error(`[worktree-manager] worktree ${worktreePath} has no changes; skipping merge`)
    return { success: true, conflicts: [], merge_commit: null }
  }

  // Extract taskId from branch name for the merge commit message
  const taskId = branch.split('/').pop() ?? branch

  // Switch to target branch in the main worktree
  try {
    exec(`git checkout ${targetBranch}`, projectRoot)
  } catch (err) {
    console.error(`[worktree-manager] failed to checkout ${targetBranch}: ${err}`)
    return failure()
  }

  // Attempt merge
  try {
    exec(
      `git merge --no-ff ${branch} -m "merge: delegate/${taskId}"`,
      projectRoot,
    )
  } catch (err) {
    // Merge failed — collect conflicted files and abort
    console.error(`[worktree-manager] merge conflict on branch ${branch}: ${err}`)

    let conflicts: string[] = []
    try {
      const statusOut = exec('git status --porcelain', projectRoot)
      conflicts = statusOut
        .split('\n')
        .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD'))
        .map(l => l.slice(3).trim())
        .filter(Boolean)
    } catch {
      // Best-effort
    }

    try {
      exec('git merge --abort', projectRoot)
    } catch {
      // Best-effort
    }

    return failure(conflicts)
  }

  // Capture merge commit hash
  let mergeCommit: string | null = null
  try {
    mergeCommit = exec('git rev-parse HEAD', projectRoot)
  } catch {
    // Non-fatal
  }

  console.error(`[worktree-manager] merged ${branch} into ${targetBranch}: ${mergeCommit}`)
  return { success: true, conflicts: [], merge_commit: mergeCommit }
}

/**
 * Discard a worktree without merging (calls removeWorktree).
 */
export function discardWorktree(projectRoot: string, worktreePath: string): boolean {
  console.error(`[worktree-manager] discarding worktree: ${worktreePath}`)
  return removeWorktree(projectRoot, worktreePath)
}

/**
 * Return the working status of a worktree.
 *
 * - changed_files: list of files with uncommitted changes (from `git status --porcelain`)
 * - diff_stat    : human-readable diff stat vs HEAD
 * - has_changes  : true when changed_files is non-empty
 */
export function getWorktreeStatus(worktreePath: string): {
  changed_files: string[]
  diff_stat: string
  has_changes: boolean
} {
  let changed_files: string[] = []
  let diff_stat = ''

  try {
    const statusOut = exec(`git -C ${worktreePath} status --porcelain`)
    changed_files = statusOut
      .split('\n')
      .filter(Boolean)
      .map(l => l.slice(3).trim())
      .filter(Boolean)
  } catch (err) {
    console.error(`[worktree-manager] failed to get status for ${worktreePath}: ${err}`)
  }

  try {
    diff_stat = exec(`git -C ${worktreePath} diff --stat HEAD`)
  } catch {
    // HEAD may not exist for a freshly created worktree
  }

  return {
    changed_files,
    diff_stat,
    has_changes: changed_files.length > 0,
  }
}

/**
 * Remove all stale delegation worktrees, optionally filtered to those whose
 * branch name contains the given workflowId.
 *
 * Returns the number of worktrees successfully removed.
 */
export function cleanupStaleWorktrees(projectRoot: string, workflowId?: string): number {
  const worktrees = listWorktrees(projectRoot)
  let removed = 0

  for (const wt of worktrees) {
    if (workflowId && !wt.branch.includes(workflowId)) {
      continue
    }

    const ok = removeWorktree(projectRoot, wt.path)
    if (ok) {
      removed++
    } else {
      console.error(`[worktree-manager] failed to remove stale worktree: ${wt.path}`)
    }
  }

  console.error(`[worktree-manager] cleanup complete: removed ${removed} worktree(s)`)
  return removed
}
