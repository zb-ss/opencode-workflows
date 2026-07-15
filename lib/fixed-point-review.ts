import crypto from 'node:crypto'
import path from 'node:path'

import type { PermissionRule } from './autonomy-policy.ts'
import type { BoundedFileIdentity } from './bounded-file-transport.ts'
import {
  FixedPointBatchRunner,
  type FixedPointRuntime,
} from './fixed-point-batch-runner.ts'
import {
  boundedString,
  enabledReviewLoop,
  parseCorrection,
  parseStructuredReview,
  selectReviewers,
  type ConfiguredReviewer,
  type CorrectionEdit,
  type EnabledReviewLoopConfig,
  type ReviewLoopConfig,
  type SourcedReviewIssue,
  type StructuredReviewResult,
} from './fixed-point-contracts.ts'
import { correctionPrompt, reviewPrompt } from './fixed-point-prompts.ts'
import {
  applyCorrectionEdits,
  correctionSources,
  reviewSnapshots,
  snapshotFiles,
  type BoundedSourceSnapshot,
  type ReviewSnapshotBundle,
} from './fixed-point-snapshots.ts'
import { isPathInside } from './paths.ts'
import { acquireProjectReviewLease } from './project-mutation-lease.ts'
import type { SwarmTask } from './types.ts'

export { parseStructuredReview, selectReviewers } from './fixed-point-contracts.ts'
export type { FixedPointRuntime } from './fixed-point-batch-runner.ts'
export type {
  SourcedReviewIssue,
  StructuredReviewIssue,
  StructuredReviewResult,
} from './fixed-point-contracts.ts'

const MAX_AGGREGATE_REVIEW_ISSUES = 100

export interface FixedPointReviewInput {
  callerSessionId: string
  directory: string
  summary: string
  changedFiles: string[]
  riskTags: string[]
  workflowContext?: string
  signal?: AbortSignal
  authorizeReads?: (paths: string[]) => Promise<void>
  authorizeReviewers?: (reviewers: Array<{ id: string; agent: string }>) => Promise<void>
  authorizeCorrectionAgent?: (agent: string) => Promise<void>
  authorizeEdits?: (paths: string[]) => Promise<void>
}

interface FixedPointReviewCoordinatorOptions {
  applyEdits?: (directory: string, edits: CorrectionEdit[], sources: BoundedSourceSnapshot[]) => void
  loadChangedFiles?: (directory: string) => Promise<string[]>
  loadCorrectionSources?: (directory: string, changedFiles: string[], maximumBytes: number) => BoundedSourceSnapshot[]
  loadReviewSnapshots?: (directory: string, changedFiles: string[], maximumBytes: number) => ReviewSnapshotBundle
  snapshotFiles?: (directory: string, changedFiles: string[]) => Record<string, BoundedFileIdentity>
}

interface CorrectionResult {
  status: 'corrected' | 'blocked'
  summary: string
  resolved_issue_ids?: string[]
  required_action?: string
  changed_files?: string[]
}

interface ReviewRoundResult {
  history: FixedPointReviewHistory
  issues: SourcedReviewIssue[]
}

export interface FixedPointReviewHistory {
  iteration: number
  review_batch_id: string
  reviews: Record<string, { verdict: 'pass' | 'fail'; issue_count: number; summary: string }>
  correction_batch_id?: string
  correction?: CorrectionResult
}

export interface FixedPointReviewResult {
  status: 'accepted' | 'exhausted' | 'stalled' | 'blocked'
  iterations: number
  selected_reviewers: string[]
  unresolved_issues: SourcedReviewIssue[]
  history: FixedPointReviewHistory[]
  accepted_snapshot_sha256?: string
}

function validateInput(input: FixedPointReviewInput): void {
  boundedString(input.summary, 'review summary input', 20_000)
  if (input.changedFiles.length === 0 || input.changedFiles.length > 500) {
    throw new Error('changedFiles must contain between 1 and 500 paths')
  }
  const root = path.resolve(input.directory)
  const uniqueFiles = new Set<string>()
  for (const [index, file] of input.changedFiles.entries()) {
    boundedString(file, `changed file ${index + 1}`, 1000)
    const target = path.resolve(root, file)
    if (path.isAbsolute(file) || path.normalize(file) !== file || target === root || !isPathInside(root, target)) {
      throw new Error(`changed file must be relative to the review directory: ${file}`)
    }
    if (uniqueFiles.has(file)) throw new Error(`changed files must be unique: ${file}`)
    uniqueFiles.add(file)
  }
}

function fixedPointPermissions(): PermissionRule[] {
  return [{ permission: '*', pattern: '*', action: 'deny' }]
}

function issueSignature(issues: SourcedReviewIssue[]): string {
  return issues.map((issue) => issue.key).sort().join('\n')
}

function identitySetDigest(identities: Record<string, BoundedFileIdentity>): string {
  const canonical = Object.entries(identities).sort(([left], [right]) => left.localeCompare(right))
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function taskOutput(results: Record<string, string>, taskId: string): string {
  const output = results[taskId]
  if (typeof output !== 'string' || output === '') throw new Error(`fixed-point task returned no output: ${taskId}`)
  return output
}

export class FixedPointReviewCoordinator {
  private readonly batchRunner: FixedPointBatchRunner
  private readonly applyEdits: (directory: string, edits: CorrectionEdit[], sources: BoundedSourceSnapshot[]) => void
  private readonly loadChangedFiles: (directory: string) => Promise<string[]>
  private readonly loadCorrectionSources: (
    directory: string,
    changedFiles: string[],
    maximumBytes: number,
  ) => BoundedSourceSnapshot[]
  private readonly loadReviewSnapshots: (
    directory: string,
    changedFiles: string[],
    maximumBytes: number,
  ) => ReviewSnapshotBundle
  private readonly snapshotFiles: (
    directory: string,
    changedFiles: string[],
  ) => Record<string, BoundedFileIdentity>

  constructor(
    runtime: FixedPointRuntime,
    private readonly config: ReviewLoopConfig,
    options: FixedPointReviewCoordinatorOptions = {},
  ) {
    this.batchRunner = new FixedPointBatchRunner(runtime)
    this.applyEdits = options.applyEdits ?? applyCorrectionEdits
    this.loadCorrectionSources = options.loadCorrectionSources ?? correctionSources
    this.loadReviewSnapshots = options.loadReviewSnapshots ?? reviewSnapshots
    this.snapshotFiles = options.snapshotFiles ?? snapshotFiles
    this.loadChangedFiles = options.loadChangedFiles ?? (async () => {
      throw new Error('fixed-point review requires an authoritative changed-file provider')
    })
  }

  async run(input: FixedPointReviewInput): Promise<FixedPointReviewResult> {
    if (!this.config.enabled) throw new Error('review loop is disabled in workflows.json')
    const config = enabledReviewLoop(this.config)
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('The operation was aborted')
    validateInput(input)
    const release = acquireProjectReviewLease(input.directory)
    try {
      return await this.runWithLease(input, config)
    } finally {
      release()
    }
  }

  private async runWithLease(
    input: FixedPointReviewInput,
    config: EnabledReviewLoopConfig,
  ): Promise<FixedPointReviewResult> {
    const trustedChangedFiles = new Set(await this.loadChangedFiles(input.directory))
    const untrustedFiles = input.changedFiles.filter((file) => !trustedChangedFiles.has(file))
    const omittedFiles = [...trustedChangedFiles].filter((file) => !input.changedFiles.includes(file))
    if (untrustedFiles.length > 0 || omittedFiles.length > 0) {
      throw new Error(
        `changed-file scope does not match authoritative worktree status (${untrustedFiles.length} unexpected, ${omittedFiles.length} omitted)`,
      )
    }
    const reviewers = selectReviewers(config, input.riskTags)
    const maxIterations = config.max_iterations
    const timeoutMs = config.batch_timeout_ms
    const maxResultBytes = config.max_result_bytes
    if (!input.authorizeReads) throw new Error('fixed-point review requires explicit per-file read authorization')
    await input.authorizeReads(input.changedFiles)
    let reviewSnapshots = this.loadReviewSnapshots(input.directory, input.changedFiles, maxResultBytes)
    let reviewSourceSnapshots = reviewSnapshots.sources
    if (reviewSourceSnapshots.length !== input.changedFiles.length) {
      throw new Error('one or more changed files are unavailable to bounded fixed-point review')
    }
    let expectedIdentities = reviewSnapshots.identities
    if (!input.authorizeReviewers) throw new Error('fixed-point review requires explicit reviewer authorization')
    await input.authorizeReviewers(reviewers.map((reviewer) => ({ id: reviewer.id, agent: reviewer.agent })))
    const history: FixedPointReviewHistory[] = []
    let previousSignature: string | null = null
    let previousIssues: SourcedReviewIssue[] = []
    let unresolvedIssues: SourcedReviewIssue[] = []

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const round = await this.runReviewRound(
        input,
        reviewers,
        reviewSourceSnapshots,
        previousIssues,
        iteration,
        timeoutMs,
        maxResultBytes,
      )
      unresolvedIssues = round.issues
      const iterationHistory = round.history
      history.push(iterationHistory)

      if (unresolvedIssues.length === 0) {
        await this.assertChangedFileScope(input, expectedIdentities)
        return {
          status: 'accepted',
          iterations: iteration,
          selected_reviewers: reviewers.map((reviewer) => reviewer.id),
          unresolved_issues: [],
          history,
          accepted_snapshot_sha256: identitySetDigest(expectedIdentities),
        }
      }

      const signature = issueSignature(unresolvedIssues)
      if (signature === previousSignature) {
        return this.result('stalled', iteration, reviewers, unresolvedIssues, history)
      }
      if (iteration === maxIterations) {
        return this.result('exhausted', iteration, reviewers, unresolvedIssues, history)
      }

      const corrected = await this.runCorrectionRound(
        input,
        config,
        unresolvedIssues,
        iterationHistory,
        iteration,
        timeoutMs,
        maxResultBytes,
      )
      if (!corrected) {
        return this.result('blocked', iteration, reviewers, unresolvedIssues, history)
      }
      reviewSnapshots = this.loadReviewSnapshots(input.directory, input.changedFiles, maxResultBytes)
      reviewSourceSnapshots = reviewSnapshots.sources
      expectedIdentities = reviewSnapshots.identities
      if (reviewSourceSnapshots.length !== input.changedFiles.length) {
        throw new Error('one or more changed files became unavailable to bounded fixed-point review')
      }
      previousIssues = unresolvedIssues
      previousSignature = signature
    }

    throw new Error('review loop ended without a terminal result')
  }

  private async runReviewRound(
    input: FixedPointReviewInput,
    reviewers: ConfiguredReviewer[],
    sources: BoundedSourceSnapshot[],
    previousIssues: SourcedReviewIssue[],
    iteration: number,
    timeoutMs: number,
    maximumResultBytes: number,
  ): Promise<ReviewRoundResult> {
    const batchId = this.batchId('review', iteration)
    const tasks = reviewers.map((reviewer): SwarmTask => ({
      id: reviewer.id,
      agent: reviewer.agent,
      permission: fixedPointPermissions(),
      prompt: reviewPrompt(
        reviewer,
        input.summary,
        input.changedFiles,
        sources,
        previousIssues.filter((issue) => issue.source === reviewer.id),
        iteration,
      ),
    }))
    const outputs = await this.batchRunner.run(input, batchId, tasks, timeoutMs, maximumResultBytes)
    const parsed = Object.fromEntries(reviewers.map((reviewer) => [
      reviewer.id,
      parseStructuredReview(taskOutput(outputs, reviewer.id), maximumResultBytes),
    ])) as Record<string, StructuredReviewResult>
    for (const reviewer of reviewers) {
      const priorIds = new Set(previousIssues
        .filter((issue) => issue.source === reviewer.id)
        .map((issue) => issue.id))
      const result = parsed[reviewer.id]
      const accountedIds = new Set([
        ...result.issues.map((issue) => issue.id).filter((id) => priorIds.has(id)),
        ...result.resolved_issue_ids,
      ])
      const unknownResolved = result.resolved_issue_ids.filter((id) => !priorIds.has(id))
      const omittedPrior = [...priorIds].filter((id) => !accountedIds.has(id))
      if (unknownResolved.length > 0 || omittedPrior.length > 0) {
        throw new Error(`reviewer ${reviewer.id} returned an invalid prior-issue disposition`)
      }
    }
    const issues = reviewers.flatMap((reviewer) => parsed[reviewer.id].issues.map((issue) => ({
      ...issue,
      source: reviewer.id,
      key: `${reviewer.id}:${issue.id}`,
    })))
    if (issues.length > MAX_AGGREGATE_REVIEW_ISSUES) {
      throw new Error(`review round exceeds ${MAX_AGGREGATE_REVIEW_ISSUES} aggregate issues`)
    }
    return {
      issues,
      history: {
        iteration,
        review_batch_id: batchId,
        reviews: Object.fromEntries(reviewers.map((reviewer) => [reviewer.id, {
          verdict: parsed[reviewer.id].verdict,
          issue_count: parsed[reviewer.id].issues.length,
          summary: parsed[reviewer.id].summary,
        }])),
      },
    }
  }

  private async runCorrectionRound(
    input: FixedPointReviewInput,
    config: EnabledReviewLoopConfig,
    issues: SourcedReviewIssue[],
    history: FixedPointReviewHistory,
    iteration: number,
    timeoutMs: number,
    maximumResultBytes: number,
  ): Promise<boolean> {
    const sources = this.loadCorrectionSources(input.directory, input.changedFiles, maximumResultBytes)
    if (sources.length === 0) {
      history.correction = {
        status: 'blocked',
        summary: 'No changed files are eligible for bounded automatic correction.',
        required_action: 'Correct the protected, deleted, oversized, or credential-bearing files through an attended workflow.',
      }
      return false
    }
    if (!input.authorizeCorrectionAgent) throw new Error('fixed-point correction requires explicit correction-agent authorization')
    await input.authorizeCorrectionAgent(config.correction_agent)
    const batchId = this.batchId('correction', iteration)
    const task: SwarmTask = {
      id: 'correction',
      agent: config.correction_agent,
      permission: fixedPointPermissions(),
      prompt: correctionPrompt(config.correction_focus, input.summary, input.changedFiles, sources, issues, iteration),
    }
    const outputs = await this.batchRunner.run(input, batchId, [task], timeoutMs, maximumResultBytes)
    const correction = parseCorrection(
      taskOutput(outputs, 'correction'),
      maximumResultBytes,
      new Set(issues.map((issue) => issue.key)),
      new Set(sources.map((source) => source.path)),
    )
    history.correction_batch_id = batchId
    if (correction.status === 'blocked') {
      history.correction = correction
      return false
    }
    if (!input.authorizeEdits) throw new Error('fixed-point correction requires explicit per-file edit authorization')
    await input.authorizeEdits(correction.edits.map((edit) => edit.path))
    this.applyEdits(input.directory, correction.edits, sources)
    history.correction = {
      status: 'corrected',
      summary: correction.summary,
      resolved_issue_ids: correction.resolved_issue_ids,
      changed_files: correction.edits.map((edit) => edit.path),
    }
    return true
  }

  private async assertChangedFileScope(
    input: FixedPointReviewInput,
    expectedIdentities: Record<string, BoundedFileIdentity>,
  ): Promise<void> {
    const authoritativeBefore = new Set(await this.loadChangedFiles(input.directory))
    const firstIdentities = this.snapshotFiles(input.directory, input.changedFiles)
    const secondIdentities = this.snapshotFiles(input.directory, input.changedFiles)
    const authoritativeAfter = new Set(await this.loadChangedFiles(input.directory))
    const unexpected = input.changedFiles.filter((file) => !authoritativeBefore.has(file) || !authoritativeAfter.has(file))
    const omitted = [...new Set([...authoritativeBefore, ...authoritativeAfter])]
      .filter((file) => !input.changedFiles.includes(file))
    if (unexpected.length > 0
      || omitted.length > 0
      || authoritativeBefore.size !== authoritativeAfter.size) {
      throw new Error('authoritative changed-file scope changed during fixed-point review')
    }
    if (JSON.stringify(firstIdentities) !== JSON.stringify(secondIdentities)) {
      throw new Error('authoritative changed-file content changed while finalizing fixed-point review')
    }
    if (JSON.stringify(secondIdentities) !== JSON.stringify(expectedIdentities)) {
      throw new Error('authoritative changed-file content changed during fixed-point review')
    }
  }

  private result(
    status: Exclude<FixedPointReviewResult['status'], 'accepted'>,
    iterations: number,
    reviewers: ConfiguredReviewer[],
    unresolvedIssues: SourcedReviewIssue[],
    history: FixedPointReviewHistory[],
  ): FixedPointReviewResult {
    return {
      status,
      iterations,
      selected_reviewers: reviewers.map((reviewer) => reviewer.id),
      unresolved_issues: unresolvedIssues,
      history,
    }
  }

  private batchId(kind: string, iteration: number): string {
    return `fixed-review-${kind}-${iteration}-${crypto.randomUUID().slice(0, 8)}`
  }
}
