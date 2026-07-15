import { z } from 'zod'

import { containsSensitiveContent } from './sensitive-content.ts'
import {
  MAX_SAFE_IDENTIFIER_LENGTH,
  SAFE_IDENTIFIER_PATTERN,
  SAFE_IDENTIFIER_SOURCE,
  type WorkflowConfig,
} from './workflow-config.ts'

export type ReviewLoopConfig = WorkflowConfig['review_loop']
export type ConfiguredReviewer = ReviewLoopConfig['reviewers'][number]
export type EnabledReviewLoopConfig = ReviewLoopConfig & {
  enabled: true
  max_iterations: number
  batch_timeout_ms: number
  max_result_bytes: number
  correction_agent: string
  correction_focus: string
}

const SAFE_IDENTIFIER_BODY = SAFE_IDENTIFIER_SOURCE.slice(1, -1).replace('*', `{0,${MAX_SAFE_IDENTIFIER_LENGTH - 1}}`)
const SOURCED_ISSUE_ID_SOURCE = `^${SAFE_IDENTIFIER_BODY}:${SAFE_IDENTIFIER_BODY}$`
const boundedTextSchema = (maximum: number) => z.string().min(1).max(maximum).regex(/^(?=.*\S)[^\0]+$/)
const SafeIdentifierSchema = z.string().max(MAX_SAFE_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER_PATTERN)

const StructuredReviewIssueSchema = z.object({
  id: SafeIdentifierSchema,
  severity: z.enum(['critical', 'high', 'major', 'medium', 'minor', 'low']),
  summary: boundedTextSchema(4000),
  location: boundedTextSchema(1000).optional(),
  remediation: boundedTextSchema(4000),
}).strict()

const ResolvedReviewIdsSchema = z.array(SafeIdentifierSchema).max(100)
export const StructuredReviewResultSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('pass'),
    summary: boundedTextSchema(4000),
    issues: z.array(StructuredReviewIssueSchema).max(0),
    resolved_issue_ids: ResolvedReviewIdsSchema,
  }).strict(),
  z.object({
    verdict: z.literal('fail'),
    summary: boundedTextSchema(4000),
    issues: z.array(StructuredReviewIssueSchema).min(1).max(100),
    resolved_issue_ids: ResolvedReviewIdsSchema,
  }).strict(),
])

const CorrectionEditSchema = z.object({
  path: boundedTextSchema(1000),
  content: z.string().regex(/^[^\0]*$/),
}).strict()

export const CorrectionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('corrected'),
    summary: boundedTextSchema(4000),
    resolved_issue_ids: z.array(z.string().max((MAX_SAFE_IDENTIFIER_LENGTH * 2) + 1)
      .regex(new RegExp(SOURCED_ISSUE_ID_SOURCE))).min(1).max(100),
    edits: z.array(CorrectionEditSchema).min(1).max(500),
  }).strict(),
  z.object({
    status: z.literal('blocked'),
    summary: boundedTextSchema(4000),
    required_action: boundedTextSchema(4000),
  }).strict(),
])

export type StructuredReviewIssue = z.infer<typeof StructuredReviewIssueSchema>
export type StructuredReviewResult = z.infer<typeof StructuredReviewResultSchema>
export type CorrectionEdit = z.infer<typeof CorrectionEditSchema>
export type ParsedCorrectionResult = z.infer<typeof CorrectionResultSchema>

export interface SourcedReviewIssue extends StructuredReviewIssue {
  source: string
  key: string
}

export const STRUCTURED_REVIEW_RESULT_EXAMPLE = {
  verdict: 'fail',
  summary: 'directly verified conclusion',
  issues: [{
    id: 'stable-id',
    severity: 'major',
    summary: 'impact',
    location: 'optional relative file:line',
    remediation: 'required correction',
  }],
  resolved_issue_ids: ['prior-stable-id'],
} as const

export const CORRECTED_RESULT_EXAMPLE = {
  status: 'corrected',
  summary: 'what should change',
  resolved_issue_ids: ['reviewer-id:issue-id'],
  edits: [{ path: 'scoped/file.ts', content: 'complete replacement content' }],
} as const

export const BLOCKED_RESULT_EXAMPLE = {
  status: 'blocked',
  summary: 'why correction cannot proceed',
  required_action: 'missing capability or operator decision',
} as const

export function enabledReviewLoop(config: ReviewLoopConfig): EnabledReviewLoopConfig {
  if (!config.enabled
    || config.max_iterations === undefined
    || config.batch_timeout_ms === undefined
    || config.max_result_bytes === undefined
    || config.correction_agent === undefined
    || config.correction_focus === undefined) {
    throw new Error('fixed-point review requires a complete enabled review_loop configuration')
  }
  return config as EnabledReviewLoopConfig
}

export function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /\0/.test(value)) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function safeIdentifier(value: unknown, label: string): string {
  const identifier = boundedString(value, label, MAX_SAFE_IDENTIFIER_LENGTH)
  if (!SAFE_IDENTIFIER_PATTERN.test(identifier)) throw new Error(`${label} must be a safe identifier`)
  return identifier
}

function parseJson(text: string, maximumBytes: number, label: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error(`${label} exceeds configured result bytes`)
  if (containsSensitiveContent(text)) throw new Error(`${label} contains credential-like content`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} must be one JSON object without prose or fences`)
  }
}

export function parseStructuredReview(text: string, maximumBytes: number): StructuredReviewResult {
  const parsed = StructuredReviewResultSchema.safeParse(parseJson(text, maximumBytes, 'review result'))
  if (!parsed.success) throw new Error(`review result does not match the structured contract: ${parsed.error.issues[0]?.message}`)
  const issueIds = new Set(parsed.data.issues.map((issue) => issue.id))
  if (issueIds.size !== parsed.data.issues.length) throw new Error('duplicate review issue ID')
  if (new Set(parsed.data.resolved_issue_ids).size !== parsed.data.resolved_issue_ids.length) {
    throw new Error('resolved issue IDs must be unique')
  }
  if (parsed.data.resolved_issue_ids.some((id) => issueIds.has(id))) {
    throw new Error('resolved issue IDs must not also be reported as current issues')
  }
  return parsed.data
}

export function parseCorrection(
  text: string,
  maximumBytes: number,
  validIssueIds: Set<string>,
  validPaths: Set<string>,
): ParsedCorrectionResult {
  const parsed = CorrectionResultSchema.safeParse(parseJson(text, maximumBytes, 'correction result'))
  if (!parsed.success) throw new Error(`correction result does not match the structured contract: ${parsed.error.issues[0]?.message}`)
  if (parsed.data.status === 'blocked') return parsed.data
  if (parsed.data.edits.length > validPaths.size) {
    throw new Error('corrected result has more edits than scoped changed files')
  }
  const resolvedIds = new Set<string>()
  for (const id of parsed.data.resolved_issue_ids) {
    if (!validIssueIds.has(id)) throw new Error(`correction result references an unknown issue ID: ${id}`)
    if (resolvedIds.has(id)) throw new Error('correction result contains duplicate resolved issue IDs')
    resolvedIds.add(id)
  }
  const editPaths = new Set<string>()
  for (const edit of parsed.data.edits) {
    if (!validPaths.has(edit.path)) throw new Error(`correction edit is outside the changed-file scope: ${edit.path}`)
    if (editPaths.has(edit.path)) throw new Error(`correction result contains a duplicate edit path: ${edit.path}`)
    editPaths.add(edit.path)
  }
  return parsed.data
}

export function selectReviewers(config: ReviewLoopConfig, riskTags: string[]): ConfiguredReviewer[] {
  const uniqueRiskTags = new Set(riskTags.map((tag) => safeIdentifier(tag, 'risk tag')))
  if (uniqueRiskTags.size !== riskTags.length) throw new Error('risk tags must be unique')
  const configuredTags = new Set(config.reviewers.flatMap((reviewer) => reviewer.risk_tags))
  const unknownTags = [...uniqueRiskTags].filter((tag) => !configuredTags.has(tag))
  if (unknownTags.length > 0) throw new Error(`risk tags are not configured: ${unknownTags.join(', ')}`)
  const selected = config.reviewers.filter((reviewer) => (
    reviewer.always || reviewer.risk_tags.some((tag) => uniqueRiskTags.has(tag))
  ))
  if (selected.length === 0) throw new Error('review loop selected no reviewers')
  return selected
}

function addUniqueItems(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (record.properties && typeof record.properties === 'object') {
    const resolved = (record.properties as Record<string, unknown>).resolved_issue_ids
    if (resolved && typeof resolved === 'object') (resolved as Record<string, unknown>).uniqueItems = true
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach(addUniqueItems)
    else addUniqueItems(child)
  }
}

function publicSchema(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  addUniqueItems(generated)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    ...generated,
  }
}

export function structuredReviewResultJsonSchema(): Record<string, unknown> {
  const generated = publicSchema(
    StructuredReviewResultSchema,
    'https://opencode-workflows.example/schema/structured-review-result.schema.json',
    'Structured Fixed-Point Review Result',
  )
  const variants = generated.oneOf as Array<{ properties: Record<string, Record<string, unknown>> }>
  const reviewIssue = variants[0].properties.issues.items
  const resolvedIssueIds = variants[0].properties.resolved_issue_ids
  for (const variant of variants) {
    variant.properties.issues.items = { $ref: '#/$defs/reviewIssue' }
    variant.properties.resolved_issue_ids = { $ref: '#/$defs/resolvedIssueIds' }
  }
  generated.$defs = { reviewIssue, resolvedIssueIds }
  return generated
}

export function correctionResultJsonSchema(): Record<string, unknown> {
  return publicSchema(
    CorrectionResultSchema,
    'https://opencode-workflows.example/schema/review-correction-result.schema.json',
    'Fixed-Point Correction Result',
  )
}
