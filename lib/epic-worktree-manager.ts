import { sha256Hex } from './canonical-json.ts'
import { z } from 'zod'

import { isSafeIdentifier } from './safe-identifier.ts'
import { hashIdentifier } from './paths.ts'
import {
  createManagedWorktree,
  inspectManagedWorktree,
  managedCommitIsAncestor,
  managedCommitIsRetainedByAnotherBranch,
  removeManagedWorktree,
  type ManagedWorktreeSnapshot,
} from './worktree-manager.ts'

const FULL_BRANCH_PREFIX = 'refs/heads/'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const INODE_PATTERN = /^\d+$/

export interface EpicWorktreeIdentity {
  epic_id: string
  item_id: string
  attempt_id: string
  worktree_name: string
  branch_name: string
}

export interface EpicWorktreeEvidence extends EpicWorktreeIdentity {
  base_commit: string
  worktree_path_sha256: string
  worktree_directory_dev: string
  worktree_directory_ino: string
  git_common_directory_sha256: string
  git_common_directory_dev: string
  git_common_directory_ino: string
}

export interface EpicAttemptWorktree {
  path: string
  evidence: EpicWorktreeEvidence
  changed_files: string[]
  diff_stat: string
  has_changes: boolean
  has_conflicts: boolean
  head_commit: string
}

export const EpicWorktreeEvidenceSchema: z.ZodType<EpicWorktreeEvidence> = z.object({
  epic_id: z.string(),
  item_id: z.string(),
  attempt_id: z.string(),
  worktree_name: z.string().regex(/^epic-[a-f0-9]{24}$/),
  branch_name: z.string(),
  base_commit: z.string().regex(GIT_OID_PATTERN),
  worktree_path_sha256: z.string().regex(SHA256_PATTERN),
  worktree_directory_dev: z.string().regex(INODE_PATTERN),
  worktree_directory_ino: z.string().regex(INODE_PATTERN),
  git_common_directory_sha256: z.string().regex(SHA256_PATTERN),
  git_common_directory_dev: z.string().regex(INODE_PATTERN),
  git_common_directory_ino: z.string().regex(INODE_PATTERN),
}).strict().superRefine((evidence, context) => {
  try {
    const identity = deriveEpicWorktreeIdentity(evidence.epic_id, evidence.item_id, evidence.attempt_id)
    if (identity.worktree_name !== evidence.worktree_name) context.addIssue({ code: 'custom', path: ['worktree_name'], message: 'worktree name does not match canonical identity' })
    if (identity.branch_name !== evidence.branch_name) context.addIssue({ code: 'custom', path: ['branch_name'], message: 'branch name does not match canonical identity' })
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid epic worktree identity' })
  }
})

export function parseEpicWorktreeEvidence(input: unknown): EpicWorktreeEvidence {
  return EpicWorktreeEvidenceSchema.parse(input)
}

function assertIdentityPart(value: string, label: string): void {
  if (!isSafeIdentifier(value)) throw new Error(`${label} is not a safe identifier`)
}

function shortBranch(branch: string): string {
  if (!branch.startsWith(FULL_BRANCH_PREFIX)) throw new Error('epic base branch must be a full local branch ref')
  return branch.slice(FULL_BRANCH_PREFIX.length)
}

export function deriveEpicWorktreeIdentity(epicId: string, itemId: string, attemptId: string): EpicWorktreeIdentity {
  assertIdentityPart(epicId, 'epic ID')
  assertIdentityPart(itemId, 'item ID')
  assertIdentityPart(attemptId, 'attempt ID')
  const identity = `${epicId}\0${itemId}\0${attemptId}`
  return {
    epic_id: epicId,
    item_id: itemId,
    attempt_id: attemptId,
    worktree_name: `epic-${hashIdentifier(identity)}`,
    branch_name: `epic/${epicId}/${itemId}/${attemptId}`,
  }
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
