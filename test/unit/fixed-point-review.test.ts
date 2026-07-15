import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  FixedPointReviewCoordinator,
  parseStructuredReview,
  selectReviewers,
  type FixedPointRuntime,
} from '../../lib/fixed-point-review.ts'
import {
  correctionResultJsonSchema,
  structuredReviewResultJsonSchema,
} from '../../lib/fixed-point-contracts.ts'
import type {
  AwaitBatchResult,
  CancelTaskResult,
  CollectBatchResult,
  SpawnBatchInput,
  SpawnBatchResult,
} from '../../lib/swarm-runtime.ts'
import { WorkflowConfigSchema } from '../../lib/workflow-config.ts'

interface BatchResponse {
  cancelDelayMs?: number
  cancelFails?: boolean
  collectNever?: boolean
  outputs?: Record<string, string>
  statuses?: NonNullable<AwaitBatchResult['results']>
  timedOut?: boolean
}

class FakeRuntime implements FixedPointRuntime {
  readonly spawned: SpawnBatchInput[] = []
  readonly cancelled: Array<{ batchId: string; taskId: string; timeoutMs?: number }> = []
  private readonly batches = new Map<string, BatchResponse>()

  constructor(private readonly responses: BatchResponse[]) {}

  spawnBatch(input: SpawnBatchInput): SpawnBatchResult {
    const response = this.responses.shift()
    if (!response) throw new Error('unexpected batch')
    this.spawned.push(input)
    this.batches.set(input.batchId, response)
    return { batchId: input.batchId, spawned: input.tasks.length, queued: 0, details: [], queuedTasks: [] }
  }

  async awaitBatch(_callerSessionId: string, batchId: string): Promise<AwaitBatchResult> {
    const response = this.batches.get(batchId)!
    if (response.timedOut) return { batchId, completed: false, timedOut: true }
    return {
      batchId,
      completed: true,
      results: response.statuses ?? Object.fromEntries(
        Object.keys(response.outputs ?? {}).map((id) => [id, 'completed']),
      ),
    }
  }

  async collectResults(
    _callerSessionId: string,
    batchId: string,
    _maximum?: number,
    signal?: AbortSignal,
  ): Promise<CollectBatchResult> {
    if (this.batches.get(batchId)!.collectNever) {
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error('aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return { batchId, results: this.batches.get(batchId)!.outputs ?? {} }
  }

  async cancelTask(
    _callerSessionId: string,
    batchId: string,
    taskId: string,
    timeoutMs?: number,
  ): Promise<CancelTaskResult> {
    const delay = this.batches.get(batchId)?.cancelDelayMs
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    this.cancelled.push({ batchId, taskId, timeoutMs })
    if (this.batches.get(batchId)?.cancelFails) {
      return { task_id: taskId, cancelled: false, terminal: false, error: 'abort failed' }
    }
    return { task_id: taskId, cancelled: true, terminal: true }
  }
}

function reviewConfig(maxIterations = 3, batchTimeoutMs = 1000) {
  return WorkflowConfigSchema.parse({
    review_loop: {
      enabled: true,
      max_iterations: maxIterations,
      batch_timeout_ms: batchTimeoutMs,
      max_result_bytes: 10_000,
      correction_agent: 'wf-executor',
      correction_focus: 'Correct every issue without weakening safeguards.',
      reviewers: [
        {
          id: 'functional',
          agent: 'wf-reviewer-deep',
          always: true,
          risk_tags: [],
          focus: 'Review functional correctness.',
        },
        {
          id: 'security',
          agent: 'wf-security-deep',
          always: false,
          risk_tags: ['security'],
          focus: 'Review security risks.',
        },
      ],
    },
  }).review_loop
}

function pass(summary = 'Accepted', resolvedIssueIds: string[] = []): string {
  return JSON.stringify({ verdict: 'pass', summary, issues: [], resolved_issue_ids: resolvedIssueIds })
}

function fail(id = 'issue-1', summary = 'Issue remains', resolvedIssueIds: string[] = []): string {
  return JSON.stringify({
    verdict: 'fail',
    summary,
    issues: [{
      id,
      severity: 'major',
      summary: 'Incorrect behavior',
      location: 'src/example.ts:1',
      remediation: 'Correct the behavior and add a regression test.',
    }],
    resolved_issue_ids: resolvedIssueIds,
  })
}

function corrected(...ids: string[]): string {
  return JSON.stringify({
    status: 'corrected',
    summary: 'Proposed a scoped correction',
    resolved_issue_ids: ids,
    edits: [{ path: 'src/example.ts', content: 'export const corrected = true\n' }],
  })
}

function input(riskTags: string[] = []) {
  return {
    callerSessionId: 'caller',
    directory: '/project',
    summary: 'Implement the requested behavior.',
    changedFiles: ['src/example.ts'],
    riskTags,
    authorizeReads: async () => {},
    authorizeReviewers: async () => {},
    authorizeCorrectionAgent: async () => {},
    authorizeEdits: async (_paths: string[]) => {},
  }
}

function coordinator(
  runtime: FakeRuntime,
  config = reviewConfig(),
  options: ConstructorParameters<typeof FixedPointReviewCoordinator>[2] = {},
): FixedPointReviewCoordinator {
  return new FixedPointReviewCoordinator(runtime, config, {
    loadChangedFiles: async () => ['src/example.ts'],
    loadCorrectionSources: () => [{ path: 'src/example.ts', content: 'export const corrected = false\n' }],
    loadReviewSnapshots: () => ({
      sources: [{ path: 'src/example.ts', content: 'export const corrected = false\n' }],
      identities: {
        'src/example.ts': { kind: 'file', mode: 0o644, sha256: 'initial', size: 31 },
      },
    }),
    snapshotFiles: () => ({
      'src/example.ts': { kind: 'file', mode: 0o644, sha256: 'initial', size: 31 },
    }),
    ...options,
  })
}

describe('fixed-point review contracts', () => {
  it('strictly validates structured review output', () => {
    assert.deepEqual(parseStructuredReview(pass(), 1000), {
      verdict: 'pass',
      summary: 'Accepted',
      issues: [],
      resolved_issue_ids: [],
    })
    assert.throws(() => parseStructuredReview('VERDICT: PASS', 1000), /one JSON object/)
    assert.throws(
      () => parseStructuredReview(JSON.stringify({ verdict: 'pass', summary: 'ok', issues: [], resolved_issue_ids: [], extra: true }), 1000),
      /structured contract.*Unrecognized key/,
    )
    assert.throws(
      () => parseStructuredReview(JSON.stringify({ verdict: 'fail', summary: 'no', issues: [], resolved_issue_ids: [] }), 1000),
      /structured contract.*expected array to have >=1 items/,
    )
    assert.throws(
      () => parseStructuredReview(JSON.stringify({ verdict: 'pass', summary: 'password=supersecret', issues: [], resolved_issue_ids: [] }), 1000),
      /credential-like content/,
    )
  })

  it('selects always-on and risk-matched reviewers only', () => {
    const config = reviewConfig()
    assert.deepEqual(selectReviewers(config, []).map((reviewer) => reviewer.id), ['functional'])
    assert.deepEqual(selectReviewers(config, ['security']).map((reviewer) => reviewer.id), ['functional', 'security'])
    assert.throws(() => selectReviewers(config, ['performance']), /not configured/)
  })

  it('keeps public structured-result schemas aligned with runtime string constraints', () => {
    const AjvConstructor = Ajv2020 as unknown as new (options: object) => {
      compile(schema: object): (input: unknown) => boolean
    }
    const ajv = new AjvConstructor({ strict: true })
    const reviewSchema = JSON.parse(fs.readFileSync(path.resolve('schema/structured-review-result.schema.json'), 'utf8'))
    const correctionSchema = JSON.parse(fs.readFileSync(path.resolve('schema/review-correction-result.schema.json'), 'utf8'))
    assert.deepEqual(reviewSchema, structuredReviewResultJsonSchema())
    assert.deepEqual(correctionSchema, correctionResultJsonSchema())
    const validateReview = ajv.compile(reviewSchema)
    const validateCorrection = ajv.compile(correctionSchema)
    const invalidReviews = [
      { verdict: 'pass', summary: '   ', issues: [], resolved_issue_ids: [] },
      { verdict: 'pass', summary: 'ok\0hidden', issues: [], resolved_issue_ids: [] },
    ]
    for (const candidate of invalidReviews) {
      assert.equal(validateReview(candidate), false)
      assert.throws(() => parseStructuredReview(JSON.stringify(candidate), 1000))
    }
    assert.equal(validateCorrection({
      status: 'corrected',
      summary: 'Proposed correction',
      resolved_issue_ids: ['functional:issue-1'],
      edits: [{ path: 'src/example.ts', content: 'bad\0content' }],
    }), false)
    assert.equal(validateCorrection({
      status: 'blocked',
      summary: '   ',
      required_action: 'Attend the correction',
    }), false)
  })
})

describe('FixedPointReviewCoordinator', () => {
  it('accepts a first-round unanimous pass', async () => {
    const runtime = new FakeRuntime([{ outputs: { functional: pass(), security: pass() } }])
    const result = await coordinator(runtime).run(input(['security']))

    assert.equal(result.status, 'accepted')
    assert.equal(result.iterations, 1)
    assert.deepEqual(result.selected_reviewers, ['functional', 'security'])
    assert.match(result.accepted_snapshot_sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.equal(runtime.spawned.length, 1)
  })

  it('corrects failures and requires a fresh passing review round', async () => {
    const runtime = new FakeRuntime([
      { outputs: { functional: fail(), security: pass() } },
      { outputs: { correction: corrected('functional:issue-1') } },
      { outputs: { functional: pass('Fixed', ['issue-1']), security: pass() } },
    ])
    const applied: Array<{ directory: string; edits: unknown }> = []
    const authorized: string[][] = []
    let correctionAgentAuthorizations = 0
    const reviewInput = input(['security'])
    reviewInput.authorizeCorrectionAgent = async () => { correctionAgentAuthorizations++ }
    reviewInput.authorizeEdits = async (paths) => { authorized.push(paths) }
    const result = await coordinator(runtime, reviewConfig(), {
      applyEdits: (directory, edits) => { applied.push({ directory, edits }) },
    }).run(reviewInput)

    assert.equal(result.status, 'accepted')
    assert.equal(result.iterations, 2)
    assert.equal(result.history[0].correction?.status, 'corrected')
    assert.deepEqual(result.history[0].correction?.changed_files, ['src/example.ts'])
    assert.equal(correctionAgentAuthorizations, 1)
    assert.deepEqual(authorized, [['src/example.ts']])
    assert.equal(applied.length, 1)
    const correctionTask = runtime.spawned[1].tasks[0]
    assert.deepEqual(runtime.spawned[0].tasks.map((task) => task.permission), [
      [{ permission: '*', pattern: '*', action: 'deny' }],
      [{ permission: '*', pattern: '*', action: 'deny' }],
    ])
    assert.ok(correctionTask.permission)
    assert.equal(correctionTask.permission.some((rule) => rule.permission === 'edit' && rule.action === 'allow'), false)
    assert.equal(correctionTask.permission.some((rule) => rule.permission === 'bash' && rule.action === 'allow'), false)
    assert.deepEqual(correctionTask.permission[0], { permission: '*', pattern: '*', action: 'deny' })
    assert.equal(correctionTask.permission.length, 1)
    assert.equal(runtime.spawned.length, 3)
  })

  it('rejects a repeat reviewer that silently drops a prior issue', async () => {
    const runtime = new FakeRuntime([
      { outputs: { functional: fail() } },
      { outputs: { correction: corrected('functional:issue-1') } },
      { outputs: { functional: pass() } },
    ])

    await assert.rejects(
      coordinator(runtime, reviewConfig(), { applyEdits: () => {} }).run(input()),
      /invalid prior-issue disposition/,
    )
    assert.match(runtime.spawned[2].tasks[0].prompt, /issue-1/)
  })

  it('stops when the same sourced issue IDs reach a fixed point', async () => {
    const runtime = new FakeRuntime([
      { outputs: { functional: fail() } },
      { outputs: { correction: corrected('functional:issue-1') } },
      { outputs: { functional: fail('issue-1', 'Still present') } },
    ])
    const result = await coordinator(runtime, reviewConfig(), { applyEdits: () => {} }).run(input())

    assert.equal(result.status, 'stalled')
    assert.equal(result.iterations, 2)
    assert.deepEqual(result.unresolved_issues.map((issue) => issue.key), ['functional:issue-1'])
  })

  it('stops on a correction blocker or the configured iteration limit', async () => {
    const blockedRuntime = new FakeRuntime([
      { outputs: { functional: fail() } },
      { outputs: { correction: JSON.stringify({
        status: 'blocked',
        summary: 'Needs an operator decision',
        required_action: 'Approve the incompatible behavior change',
      }) } },
    ])
    const blocked = await coordinator(blockedRuntime).run(input())
    assert.equal(blocked.status, 'blocked')

    const exhaustedRuntime = new FakeRuntime([{ outputs: { functional: fail() } }])
    const exhausted = await coordinator(exhaustedRuntime, reviewConfig(1)).run(input())
    assert.equal(exhausted.status, 'exhausted')
  })

  it('cancels every task when a batch times out', async () => {
    const runtime = new FakeRuntime([{ timedOut: true }])
    await assert.rejects(
      coordinator(runtime).run(input(['security'])),
      /timed out/,
    )
    assert.deepEqual(runtime.cancelled.map((entry) => entry.taskId).sort(), ['functional', 'security'])
    assert.deepEqual(runtime.cancelled.map((entry) => entry.timeoutMs), [1000, 1000])
  })

  it('keeps result collection inside the configured batch deadline', async () => {
    const runtime = new FakeRuntime([{ outputs: { functional: pass() }, collectNever: true }])

    await assert.rejects(
      coordinator(runtime, reviewConfig(3, 20)).run(input()),
      /timed out/,
    )
    assert.deepEqual(runtime.cancelled.map((entry) => entry.taskId), ['functional'])
  })

  it('rejects correction proposals outside the original changed-file scope', async () => {
    const runtime = new FakeRuntime([
      { outputs: { functional: fail() } },
      { outputs: { correction: JSON.stringify({
        status: 'corrected',
        summary: 'Attempted an unrelated edit',
        resolved_issue_ids: ['functional:issue-1'],
        edits: [{ path: 'src/unrelated.ts', content: 'unsafe\n' }],
      }) } },
    ])

    await assert.rejects(
      coordinator(runtime, reviewConfig(), { applyEdits: () => {} }).run(input()),
      /outside the changed-file scope/,
    )
  })

  it('rejects caller-declared files absent from the authoritative worktree status', async () => {
    const runtime = new FakeRuntime([])

    await assert.rejects(
      coordinator(runtime, reviewConfig(), { loadChangedFiles: async () => [] }).run(input()),
      /changed-file scope does not match authoritative worktree status \(1 unexpected, 0 omitted\)/,
    )
    assert.equal(runtime.spawned.length, 0)
  })

  it('does not load snapshots or spawn reviewers when read authorization is denied', async () => {
    const runtime = new FakeRuntime([])
    let loaded = false
    const reviewInput = input()
    reviewInput.authorizeReads = async () => { throw new Error('read denied') }

    await assert.rejects(
      coordinator(runtime, reviewConfig(), {
        loadReviewSnapshots: () => {
          loaded = true
          throw new Error('snapshot should not load')
        },
      }).run(reviewInput),
      /read denied/,
    )
    assert.equal(loaded, false)
    assert.equal(runtime.spawned.length, 0)
  })

  it('rejects review scopes that omit an authoritative changed file', async () => {
    const runtime = new FakeRuntime([])

    await assert.rejects(
      coordinator(runtime, reviewConfig(), {
        loadChangedFiles: async () => ['src/example.ts', 'src/omitted.ts'],
      }).run(input()),
      (error: Error) => {
        assert.match(error.message, /changed-file scope does not match authoritative worktree status \(0 unexpected, 1 omitted\)/)
        assert.doesNotMatch(error.message, /src\/omitted\.ts/)
        return true
      },
    )
    assert.equal(runtime.spawned.length, 0)
  })

  it('rechecks authoritative changed-file scope before acceptance', async () => {
    const runtime = new FakeRuntime([{ outputs: { functional: pass() } }])
    let calls = 0

    await assert.rejects(
      coordinator(runtime, reviewConfig(), {
        loadChangedFiles: async () => (++calls === 1
          ? ['src/example.ts']
          : ['src/example.ts', 'src/new-change.ts']),
      }).run(input()),
      /scope changed during fixed-point review/,
    )
  })

  it('rejects same-path content changes before acceptance', async () => {
    const runtime = new FakeRuntime([{ outputs: { functional: pass() } }])

    await assert.rejects(
      coordinator(runtime, reviewConfig(), {
        snapshotFiles: () => ({
          'src/example.ts': {
            kind: 'file',
            mode: 0o644,
            sha256: 'changed',
            size: 10,
          },
        }),
      }).run(input()),
      /content changed during fixed-point review/,
    )
  })

  it('rejects cross-file changes between whole-set identity passes', async () => {
    const runtime = new FakeRuntime([{ outputs: { functional: pass() } }])
    const changedFiles = ['src/a.ts', 'src/b.ts']
    let snapshots = 0
    const reviewed = Object.fromEntries(changedFiles.map((file) => [file, {
      kind: 'file' as const,
      mode: 0o644,
      sha256: `${file}-reviewed`,
      size: 10,
    }]))

    await assert.rejects(
      new FixedPointReviewCoordinator(runtime, reviewConfig(), {
        loadChangedFiles: async () => changedFiles,
        loadReviewSnapshots: () => ({
          sources: changedFiles.map((file) => ({ path: file, content: `// ${file}\n` })),
          identities: reviewed,
        }),
        snapshotFiles: () => {
          snapshots++
          return snapshots === 1
            ? reviewed
            : { ...reviewed, 'src/a.ts': { ...reviewed['src/a.ts'], sha256: 'src/a.ts-changed' } }
        },
      }).run({ ...input(), changedFiles }),
      /content changed while finalizing fixed-point review/,
    )
  })

  it('accepts an unchanged UTF-8 BOM source with an exact byte identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-point-bom-'))
    fs.mkdirSync(path.join(directory, 'src'))
    fs.writeFileSync(path.join(directory, 'src', 'example.ts'), '\uFEFFexport const value = true\n')
    const runtime = new FakeRuntime([{ outputs: { functional: pass() } }])

    try {
      const result = await new FixedPointReviewCoordinator(runtime, reviewConfig(), {
        loadChangedFiles: async () => ['src/example.ts'],
      }).run({ ...input(), directory })
      assert.equal(result.status, 'accepted')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks correction when bounded source loading detects credential-like content', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-point-sensitive-'))
    fs.mkdirSync(path.join(directory, 'src'))
    fs.writeFileSync(path.join(directory, 'src', 'example.ts'), 'const password = "supersecret"\n')
    const runtime = new FakeRuntime([{ outputs: { functional: fail() } }])

    try {
      await assert.rejects(
        new FixedPointReviewCoordinator(runtime, reviewConfig(), {
          loadChangedFiles: async () => ['src/example.ts'],
        }).run({ ...input(), directory }),
        /unavailable to bounded fixed-point review/,
      )
      assert.equal(runtime.spawned.length, 0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('omits protected and oversized correction sources before spawning a correction agent', async (context) => {
    await context.test('protected control file', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-point-protected-'))
      fs.writeFileSync(path.join(directory, 'package.json'), '{}\n')
      const runtime = new FakeRuntime([{ outputs: { functional: fail() } }])
      try {
        const result = await new FixedPointReviewCoordinator(runtime, reviewConfig(), {
          loadChangedFiles: async () => ['package.json'],
        }).run({ ...input(), directory, changedFiles: ['package.json'] })
        assert.equal(result.status, 'blocked')
        assert.equal(runtime.spawned.length, 1)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })

    await context.test('oversized sparse source file', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-point-oversized-'))
      fs.mkdirSync(path.join(directory, 'src'))
      const target = path.join(directory, 'src', 'example.ts')
      fs.writeFileSync(target, '')
      fs.truncateSync(target, 100_000)
      const runtime = new FakeRuntime([{ outputs: { functional: fail() } }])
      try {
        await assert.rejects(
          new FixedPointReviewCoordinator(runtime, reviewConfig(), {
            loadChangedFiles: async () => ['src/example.ts'],
          }).run({ ...input(), directory }),
          /unavailable to bounded fixed-point review/,
        )
        assert.equal(runtime.spawned.length, 0)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })
  })

  it('applies scoped source replacements through the bounded file transport', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-point-correction-'))
    fs.mkdirSync(path.join(directory, 'src'))
    const target = path.join(directory, 'src', 'example.ts')
    fs.writeFileSync(target, 'export const corrected = false\n')
    const runtime = new FakeRuntime([
      { outputs: { functional: fail() } },
      { outputs: { correction: corrected('functional:issue-1') } },
      { outputs: { functional: pass('Accepted', ['issue-1']) } },
    ])

    try {
      const result = await new FixedPointReviewCoordinator(runtime, reviewConfig(), {
        loadChangedFiles: async () => ['src/example.ts'],
      }).run({
        ...input(),
        directory,
      })
      assert.equal(result.status, 'accepted')
      assert.equal(fs.readFileSync(target, 'utf8'), 'export const corrected = true\n')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('awaits cancellation before a timed-out batch settles', async () => {
    const runtime = new FakeRuntime([{ timedOut: true, cancelDelayMs: 20 }])
    const pending = coordinator(runtime, reviewConfig(3, 5)).run(input())
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(runtime.cancelled.length, 0)

    await assert.rejects(pending, /timed out/)
    assert.deepEqual(runtime.cancelled.map((entry) => entry.taskId), ['functional'])
  })

  it('reports non-terminal children when cancellation fails', async () => {
    const runtime = new FakeRuntime([{ timedOut: true, cancelFails: true }])

    await assert.rejects(
      coordinator(runtime, reviewConfig(3, 5)).run(input()),
      /remain non-terminal.*functional: abort failed/,
    )
    assert.deepEqual(runtime.cancelled.map((entry) => entry.taskId), ['functional'])
  })
})
