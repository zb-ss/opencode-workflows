import { z } from 'zod'

import { sha256Hex, stableCanonicalJson } from './epic-canonical-json.ts'
import { EpicReviewerResultSchema, type EpicReviewerResult } from './epic-attempt-result.ts'
import { EpicWorktreeEvidenceSchema, type EpicWorktreeEvidence } from './epic-worktree-contracts.ts'
import { SafeIdentifierSchema } from './safe-identifier.ts'

export const EPIC_REVIEW_EVIDENCE_CONTRACT_VERSION = 1

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const BoundedModelSchema = z.string().min(1).max(4096).refine(value => !value.includes('\0'))

export const EpicReviewEvidenceInputSchema = z.object({
  epic_id: SafeIdentifierSchema,
  item_id: SafeIdentifierSchema,
  attempt_id: SafeIdentifierSchema,
  review_id: SafeIdentifierSchema,
  worktree_evidence: EpicWorktreeEvidenceSchema,
  checkpoint_commit: z.string().regex(GIT_OID_PATTERN),
  checkpoint_tree_sha256: z.string().regex(SHA256_PATTERN),
  patch_sha256: z.string().regex(SHA256_PATTERN),
  reviewer_session_id: SafeIdentifierSchema,
  reviewer_agent: SafeIdentifierSchema,
  reviewer_model: BoundedModelSchema,
  review_result: EpicReviewerResultSchema,
}).strict().superRefine((input, context) => {
  if (input.worktree_evidence.epic_id !== input.epic_id) {
    context.addIssue({ code: 'custom', path: ['worktree_evidence', 'epic_id'], message: 'worktree epic ID must match review evidence' })
  }
  if (input.worktree_evidence.item_id !== input.item_id) {
    context.addIssue({ code: 'custom', path: ['worktree_evidence', 'item_id'], message: 'worktree item ID must match review evidence' })
  }
  if (input.worktree_evidence.attempt_id !== input.attempt_id) {
    context.addIssue({ code: 'custom', path: ['worktree_evidence', 'attempt_id'], message: 'worktree attempt ID must match review evidence' })
  }
})

export type EpicReviewEvidenceInput = z.infer<typeof EpicReviewEvidenceInputSchema>

export interface CanonicalEpicReviewEvidence {
  contract_version: typeof EPIC_REVIEW_EVIDENCE_CONTRACT_VERSION
  epic_id: string
  item_id: string
  attempt_id: string
  review_id: string
  worktree_evidence: EpicWorktreeEvidence
  checkpoint_commit: string
  checkpoint_tree_sha256: string
  patch_sha256: string
  reviewer_session_id: string
  reviewer_agent: string
  reviewer_model: string
  review_result: EpicReviewerResult
}

export function canonicalEpicReviewEvidence(input: EpicReviewEvidenceInput): CanonicalEpicReviewEvidence {
  const parsed = EpicReviewEvidenceInputSchema.parse(input)
  return {
    contract_version: EPIC_REVIEW_EVIDENCE_CONTRACT_VERSION,
    epic_id: parsed.epic_id,
    item_id: parsed.item_id,
    attempt_id: parsed.attempt_id,
    review_id: parsed.review_id,
    worktree_evidence: parsed.worktree_evidence,
    checkpoint_commit: parsed.checkpoint_commit,
    checkpoint_tree_sha256: parsed.checkpoint_tree_sha256,
    patch_sha256: parsed.patch_sha256,
    reviewer_session_id: parsed.reviewer_session_id,
    reviewer_agent: parsed.reviewer_agent,
    reviewer_model: parsed.reviewer_model,
    review_result: parsed.review_result,
  }
}

/** Computes the final digest from validated evidence; no digest is accepted from callers. */
export function computeEpicReviewEvidenceDigest(input: EpicReviewEvidenceInput): string {
  return sha256Hex(stableCanonicalJson(canonicalEpicReviewEvidence(input)))
}
