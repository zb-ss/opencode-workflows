import { sha256Hex } from './canonical-json.ts'

import {
  deriveEpicWorktreeIdentity,
  parseEpicWorktreeEvidence,
  type EpicWorktreeEvidence,
  type EpicWorktreeIdentity,
} from './epic-worktree-contracts.ts'
import {
  createManagedWorktree,
  inspectManagedWorktree,
  managedCommitIsAncestor,
  managedCommitIsRetainedByAnotherBranch,
  removeManagedWorktree,
  type ManagedWorktreeSnapshot,
} from './worktree-manager.ts'

const FULL_BRANCH_PREFIX = 'refs/heads/'
export {
  deriveEpicWorktreeIdentity,
  EpicWorktreeEvidenceSchema,
  parseEpicWorktreeEvidence,
} from './epic-worktree-contracts.ts'
export type { EpicWorktreeEvidence, EpicWorktreeIdentity } from './epic-worktree-contracts.ts'

export interface EpicAttemptWorktree {
  path: string
  evidence: EpicWorktreeEvidence
  changed_files: string[]
  diff_stat: string
  has_changes: boolean
  has_conflicts: boolean
  head_commit: string
}

function shortBranch(branch: string): string {
  if (!branch.startsWith(FULL_BRANCH_PREFIX)) throw new Error('epic base branch must be a full local branch ref')
  return branch.slice(FULL_BRANCH_PREFIX.length)
}

function evidenceFromSnapshot(identity: EpicWorktreeIdentity, snapshot: ManagedWorktreeSnapshot): EpicWorktreeEvidence {
  return parseEpicWorktreeEvidence({
    ...identity,
    base_commit: snapshot.head_commit,
    worktree_path_sha256: sha256Hex(snapshot.path),
    worktree_directory_dev: snapshot.directory_dev,
    worktree_directory_ino: snapshot.directory_ino,
    git_common_directory_sha256: sha256Hex(snapshot.git_common_directory),
    git_common_directory_dev: snapshot.git_common_directory_dev,
    git_common_directory_ino: snapshot.git_common_directory_ino,
  })
}

function result(evidence: EpicWorktreeEvidence, snapshot: ManagedWorktreeSnapshot): EpicAttemptWorktree {
  return {
    path: snapshot.path,
    evidence,
    changed_files: snapshot.changed_files,
    diff_stat: snapshot.diff_stat,
    has_changes: snapshot.has_changes,
    has_conflicts: snapshot.has_conflicts,
    head_commit: snapshot.head_commit,
  }
}

export function createEpicAttemptWorktree(
  projectRoot: string,
  baseBranch: string,
  epicId: string,
  itemId: string,
  attemptId: string,
): EpicAttemptWorktree {
  const identity = deriveEpicWorktreeIdentity(epicId, itemId, attemptId)
  const snapshot = createManagedWorktree(
    projectRoot,
    shortBranch(baseBranch),
    identity.branch_name,
    identity.worktree_name,
  )
  return result(evidenceFromSnapshot(identity, snapshot), snapshot)
}

export function inspectEpicAttemptWorktree(
  projectRoot: string,
  worktreePath: string,
  evidence: EpicWorktreeEvidence,
): EpicAttemptWorktree {
  evidence = parseEpicWorktreeEvidence(evidence)
  const identity = deriveEpicWorktreeIdentity(evidence.epic_id, evidence.item_id, evidence.attempt_id)
  if (identity.worktree_name !== evidence.worktree_name || identity.branch_name !== evidence.branch_name) {
    throw new Error('epic worktree evidence does not match its canonical identity')
  }
  const snapshot = inspectManagedWorktree(projectRoot, worktreePath, evidence.worktree_name, evidence.branch_name)
  if (sha256Hex(snapshot.path) !== evidence.worktree_path_sha256
    || snapshot.directory_dev !== evidence.worktree_directory_dev
    || snapshot.directory_ino !== evidence.worktree_directory_ino
    || sha256Hex(snapshot.git_common_directory) !== evidence.git_common_directory_sha256
    || snapshot.git_common_directory_dev !== evidence.git_common_directory_dev
    || snapshot.git_common_directory_ino !== evidence.git_common_directory_ino) {
    throw new Error('epic worktree path, ownership, or inode identity changed')
  }
  if (!managedCommitIsAncestor(projectRoot, evidence.base_commit, snapshot.head_commit)) {
    throw new Error('epic worktree HEAD is not descended from its bound base commit')
  }
  return result(evidence, snapshot)
}

export function cleanupIntegratedEpicAttemptWorktree(
  projectRoot: string,
  worktreePath: string,
  evidence: EpicWorktreeEvidence,
  reviewedCheckpointCommit: string | null,
  integrationCommit: string | null,
): boolean {
  try {
    const inspected = inspectEpicAttemptWorktree(projectRoot, worktreePath, evidence)
    if (inspected.has_changes || inspected.has_conflicts
      || reviewedCheckpointCommit === null
      || integrationCommit === null
      || inspected.head_commit !== reviewedCheckpointCommit
      || !managedCommitIsAncestor(projectRoot, reviewedCheckpointCommit, integrationCommit)
      || !managedCommitIsRetainedByAnotherBranch(projectRoot, integrationCommit, evidence.branch_name)) return false
    removeManagedWorktree(projectRoot, worktreePath, evidence.worktree_name, evidence.branch_name)
    return true
  } catch (error) {
    console.error(`[epic-worktree-manager] refused cleanup: ${error}`)
    return false
  }
}
