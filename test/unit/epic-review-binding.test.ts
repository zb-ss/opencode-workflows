import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EPIC_REVIEW_EVIDENCE_CONTRACT_VERSION,
  canonicalEpicReviewEvidence,
  computeEpicReviewEvidenceDigest,
  deriveEpicWorktreeIdentity,
  type EpicReviewEvidenceInput,
} from '../../lib/epic-contracts.ts'

const SHA = (character: string) => character.repeat(64)
const OID = (character: string) => character.repeat(40)

function evidence(): EpicReviewEvidenceInput {
  return {
    epic_id: 'epic-example',
    item_id: 'item-a',
    attempt_id: 'attempt-1',
    review_id: 'review-1',
    worktree_evidence: {
      ...deriveEpicWorktreeIdentity('epic-example', 'item-a', 'attempt-1'),
      base_commit: OID('0'),
      worktree_path_sha256: SHA('1'),
      worktree_directory_dev: '1',
      worktree_directory_ino: '2',
      git_common_directory_sha256: SHA('2'),
      git_common_directory_dev: '3',
      git_common_directory_ino: '4',
    },
    checkpoint_commit: OID('1'),
    checkpoint_tree_sha256: SHA('3'),
    patch_sha256: SHA('4'),
    reviewer_session_id: 'review-session-example',
    reviewer_agent: 'reviewer-example',
    reviewer_model: 'example/reviewer',
    review_result: {
      verdict: 'fail',
      summary: 'One issue.',
      issues: [{ issue_id: 'ISSUE-1', severity: 'medium', message: 'Fix the behavior.', path: 'lib/example.ts', line: 10, recommendation: 'Use the checked value.' }],
    },
  }
}

describe('epic canonical review binding', () => {
  it('is deterministic and injects the contract version itself', () => {
    const input = evidence()
    const reordered = {
      review_result: input.review_result,
      reviewer_model: input.reviewer_model,
      reviewer_agent: input.reviewer_agent,
      reviewer_session_id: input.reviewer_session_id,
      patch_sha256: input.patch_sha256,
      checkpoint_tree_sha256: input.checkpoint_tree_sha256,
      checkpoint_commit: input.checkpoint_commit,
      worktree_evidence: input.worktree_evidence,
      attempt_id: input.attempt_id,
      review_id: input.review_id,
      item_id: input.item_id,
      epic_id: input.epic_id,
    }
    assert.equal(computeEpicReviewEvidenceDigest(input), computeEpicReviewEvidenceDigest(reordered))
    assert.equal(canonicalEpicReviewEvidence(input).contract_version, EPIC_REVIEW_EVIDENCE_CONTRACT_VERSION)
  })

  it('changes when checkpoint, patch, reviewer, worktree, identity, or result evidence is tampered', () => {
    const input = evidence()
    const original = computeEpicReviewEvidenceDigest(input)
    const mutations: EpicReviewEvidenceInput[] = [
      { ...input, checkpoint_commit: OID('2') },
      { ...input, checkpoint_tree_sha256: SHA('5') },
      { ...input, patch_sha256: SHA('6') },
      { ...input, reviewer_session_id: 'other-review-session' },
      { ...input, reviewer_agent: 'other-reviewer' },
      { ...input, reviewer_model: 'example/other-reviewer' },
      { ...input, review_id: 'review-2' },
      { ...input, worktree_evidence: { ...input.worktree_evidence, base_commit: OID('3') } },
      { ...input, review_result: { ...input.review_result, verdict: 'pass', summary: 'Passed.', issues: [] } },
    ]
    for (const mutation of mutations) assert.notEqual(computeEpicReviewEvidenceDigest(mutation), original)
  })

  it('rejects mismatched worktree identity and caller-supplied digest fields', () => {
    const input = evidence()
    assert.throws(() => computeEpicReviewEvidenceDigest({ ...input, item_id: 'item-b' }), /worktree item ID/)
    assert.throws(() => computeEpicReviewEvidenceDigest({ ...input, evidence_digest: SHA('9') } as EpicReviewEvidenceInput), /[Uu]nrecognized key/)
  })
})
