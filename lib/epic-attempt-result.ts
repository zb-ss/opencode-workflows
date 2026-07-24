import { z } from 'zod'

import { safePositiveInteger } from './automation-policy-contracts.ts'
import { stableCanonicalJson } from './epic-canonical-json.ts'

export const MAX_EPIC_RESULT_TEXT_LENGTH = 4096
export const MAX_EPIC_REVIEW_ISSUES = 128
export const MAX_EPIC_REVIEW_ISSUE_PATH_LENGTH = 1024

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BoundedTextSchema = z.string().min(1).max(MAX_EPIC_RESULT_TEXT_LENGTH).refine(value => !value.includes('\0'))

const ReviewReadyResultSchema = z.object({
  status: z.literal('review_ready'),
  summary: BoundedTextSchema,
}).strict()

const FailedResultSchema = z.object({
  status: z.literal('failed'),
  summary: BoundedTextSchema,
  failure_classification: z.enum(['transport', 'contract', 'semantic']),
}).strict()

const BlockedResultSchema = z.object({
  status: z.literal('blocked'),
  summary: BoundedTextSchema,
  reason: BoundedTextSchema,
}).strict()

export const EpicExecutorResultSchema = z.union([
  ReviewReadyResultSchema,
  FailedResultSchema,
  BlockedResultSchema,
])

export const EpicReviewIssueSchema = z.object({
  issue_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  message: BoundedTextSchema,
  path: z.string().min(1).max(MAX_EPIC_REVIEW_ISSUE_PATH_LENGTH).refine(value => !value.includes('\0')).nullable(),
  line: safePositiveInteger.nullable(),
  recommendation: BoundedTextSchema.nullable(),
}).strict()

export const EpicReviewerResultSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  summary: BoundedTextSchema,
  issues: z.array(EpicReviewIssueSchema).max(MAX_EPIC_REVIEW_ISSUES),
}).strict().superRefine((result, context) => {
  if (result.verdict === 'pass' && result.issues.length !== 0) {
    context.addIssue({ code: 'custom', path: ['issues'], message: 'passing review must contain zero issues' })
  }
  if (result.verdict === 'fail' && result.issues.length === 0) {
    context.addIssue({ code: 'custom', path: ['issues'], message: 'failed review requires at least one issue' })
  }
})

export type EpicExecutorResult = z.infer<typeof EpicExecutorResultSchema>
export type EpicReviewIssue = z.infer<typeof EpicReviewIssueSchema>
export type EpicReviewerResult = z.infer<typeof EpicReviewerResultSchema>

function assertResultBytes(result: unknown, maximumBytes: number | undefined): void {
  if (maximumBytes === undefined) return
  const maximum = safePositiveInteger.parse(maximumBytes)
  if (Buffer.byteLength(stableCanonicalJson(result), 'utf8') > maximum) {
    throw new Error(`structured epic result exceeds the ${maximum}-byte limit`)
  }
}

export function parseEpicExecutorResult(input: unknown, maximumBytes?: number): EpicExecutorResult {
  const result = EpicExecutorResultSchema.parse(input)
  assertResultBytes(result, maximumBytes)
  return result
}

export function parseEpicReviewerResult(input: unknown, maximumBytes?: number): EpicReviewerResult {
  const result = EpicReviewerResultSchema.parse(input)
  assertResultBytes(result, maximumBytes)
  return result
}
