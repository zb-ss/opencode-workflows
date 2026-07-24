import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_EPIC_RESULT_TEXT_LENGTH,
  MAX_EPIC_REVIEW_ISSUES,
  parseEpicExecutorResult,
  parseEpicReviewerResult,
} from '../../lib/epic-contracts.ts'

const SHA = (character: string) => character.repeat(64)

describe('epic structured attempt results', () => {
  it('parses each strict executor result variant', () => {
    const reviewReady = parseEpicExecutorResult({
      status: 'review_ready',
      summary: 'Ready for review.',
    })
    assert.equal(reviewReady.status, 'review_ready')
    assert.equal(parseEpicExecutorResult({ status: 'failed', summary: 'Contract mismatch.', failure_classification: 'contract' }).status, 'failed')
    assert.equal(parseEpicExecutorResult({ status: 'blocked', summary: 'Blocked.', reason: 'Missing prerequisite.' }).status, 'blocked')
  })

  it('rejects malformed, oversized, unpaired, and unknown executor data', () => {
    assert.throws(() => parseEpicExecutorResult({ status: 'failed', summary: '', failure_classification: 'semantic' }))
    assert.throws(() => parseEpicExecutorResult({ status: 'failed', summary: 'x'.repeat(MAX_EPIC_RESULT_TEXT_LENGTH + 1), failure_classification: 'semantic' }))
    assert.throws(() => parseEpicExecutorResult({ status: 'failed', summary: 'Failed.', failure_classification: 'semantic', progress_commit: '1'.repeat(40) }))
    assert.throws(() => parseEpicExecutorResult({ status: 'blocked', summary: 'Blocked.', reason: 'Reason.', extra: true }))
    assert.throws(() => parseEpicExecutorResult({ status: 'blocked', summary: 'Blocked.', reason: 'Reason.' }, 10), /byte limit/)
  })

  it('accepts pass or fail reviewer results with bounded structured issues', () => {
    assert.deepEqual(parseEpicReviewerResult({ verdict: 'pass', summary: 'No issues.', issues: [] }).issues, [])
    const failed = parseEpicReviewerResult({
      verdict: 'fail',
      summary: 'One issue.',
      issues: [{
        issue_id: 'ISSUE-1', severity: 'high', message: 'Incorrect behavior.', path: 'lib/example.ts', line: 12, recommendation: 'Apply the documented rule.',
      }],
    })
    assert.equal(failed.issues[0]!.severity, 'high')
  })

  it('rejects malformed reviewer results and caps issue arrays and fields', () => {
    const issue = { issue_id: 'ISSUE-1', severity: 'low', message: 'Issue.', path: null, line: null, recommendation: null }
    assert.throws(() => parseEpicReviewerResult({ verdict: 'passed', summary: 'Wrong enum.', issues: [] }))
    assert.throws(() => parseEpicReviewerResult({ verdict: 'fail', summary: 'Contradictory.', issues: [] }), /at least one issue/)
    assert.throws(() => parseEpicReviewerResult({ verdict: 'pass', summary: 'Contradictory.', issues: [issue] }), /zero issues/)
    assert.throws(() => parseEpicReviewerResult({ verdict: 'pass', summary: 'Unknown.', issues: [], digest: SHA('1') }))
    assert.throws(() => parseEpicReviewerResult({ verdict: 'fail', summary: 'Too many.', issues: Array.from({ length: MAX_EPIC_REVIEW_ISSUES + 1 }, () => issue) }))
    assert.throws(() => parseEpicReviewerResult({ verdict: 'fail', summary: 'Bad issue.', issues: [{ ...issue, message: 'x'.repeat(MAX_EPIC_RESULT_TEXT_LENGTH + 1) }] }))
  })
})
