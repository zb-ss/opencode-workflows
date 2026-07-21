import { z } from 'zod'

import { HASH_IDENTIFIER_HEX_LENGTH, hashIdentifier } from './identifier-hash.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const UINT64_MAX = 18_446_744_073_709_551_615n
const WORKTREE_NAME_PATTERN = new RegExp(`^epic-[a-f0-9]{${HASH_IDENTIFIER_HEX_LENGTH}}$`)

const EpicWorktreeIdentifierSchema = SafeIdentifierSchema.refine(
  value => !value.includes('..') && !value.endsWith('.') && !value.endsWith('.lock'),
  { message: 'must also be a valid Git ref component' },
)
const UInt64StringSchema = z.string().min(1).max(20).regex(/^\d+$/).refine(
  value => /^\d+$/.test(value) && BigInt(value) <= UINT64_MAX,
  { message: 'must fit an unsigned 64-bit integer' },
)

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

export function deriveEpicWorktreeIdentity(epicId: string, itemId: string, attemptId: string): EpicWorktreeIdentity {
  const parsePart = (value: string, label: string): string => {
    const parsed = EpicWorktreeIdentifierSchema.safeParse(value)
    if (!parsed.success) throw new Error(`${label} is not a safe identifier for a Git worktree`)
    return parsed.data
  }
  const epic_id = parsePart(epicId, 'epic ID')
  const item_id = parsePart(itemId, 'item ID')
  const attempt_id = parsePart(attemptId, 'attempt ID')
  const identity = `${epic_id}\0${item_id}\0${attempt_id}`
  return {
    epic_id,
    item_id,
    attempt_id,
    worktree_name: `epic-${hashIdentifier(identity)}`,
    branch_name: `epic/${epic_id}/${item_id}/${attempt_id}`,
  }
}

export const EpicWorktreeEvidenceSchema: z.ZodType<EpicWorktreeEvidence> = z.object({
  epic_id: EpicWorktreeIdentifierSchema,
  item_id: EpicWorktreeIdentifierSchema,
  attempt_id: EpicWorktreeIdentifierSchema,
  worktree_name: z.string().regex(WORKTREE_NAME_PATTERN),
  branch_name: z.string().min(1).max(5 + (3 * 64) + 2),
  base_commit: z.string().regex(GIT_OID_PATTERN),
  worktree_path_sha256: z.string().regex(SHA256_PATTERN),
  worktree_directory_dev: UInt64StringSchema,
  worktree_directory_ino: UInt64StringSchema,
  git_common_directory_sha256: z.string().regex(SHA256_PATTERN),
  git_common_directory_dev: UInt64StringSchema,
  git_common_directory_ino: UInt64StringSchema,
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
