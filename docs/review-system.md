# Review System

Review behavior is defined by the selected agent prompt, mode routing, and workflow driver. The workflow enforcer tracks gate status; it does not parse a review response and pass a gate automatically.

## Reviewer Contract

The standard `wf-reviewer`, `wf-reviewer-lite`, and `wf-reviewer-deep` agents use a strict contract:

- `VERDICT: PASS` only when no issue requiring a change remains.
- `VERDICT: FAIL` when at least one issue remains.
- Findings use stable issue identifiers so correction and re-review can refer to the same defect.
- Findings should include a repository-relative file and line when applicable, impact, and an actionable correction.

Typical format:

```text
[ISSUE-1] [MAJOR] Incorrect authorization check - src/example.ts:42 - Validate ownership before mutation
```

Security, E2E, quality-gate, and completion-guard agents have role-specific output contracts. Do not replace those contracts with majority voting or infer their result from the absence of prose.

## Manual Review Loop

In a manual workflow:

1. The supervisor starts a reviewer through the native Task tool.
2. It stores the returned reviewer Task ID separately from the implementation Task ID.
3. It marks the review gate based on the review's direct verdict and evidence.
4. On failure, it resumes the original implementation task with its `task_id` and the complete issue list.
5. It resumes the original reviewer task with the reviewer's `task_id` and updated evidence.
6. It records each gate update through `workflow_update_gate`.

A correction is not complete merely because files changed. The relevant checks must be rerun, and the reviewer must explicitly resolve or supersede each prior issue.

Mode files define review and security iteration guidance. They route `eco` and `turbo` to lite reviewers, `standard` to the standard reviewer, and `thorough` or `swarm` to deep reviewers. The exact limits remain in `mode/*.json`; documentation does not duplicate them.

## Automatic Stage Results

Automatic DAG sessions do not use the manual `VERDICT:` parser. Every stage must return one JSON object:

```json
{
  "status": "passed",
  "summary": "Directly verified result",
  "details": ["Optional evidence"]
}
```

The engine validates the object strictly. Invalid JSON or unsupported fields fail the attempt. `retryable: false` makes the stage terminally failed; otherwise the stage can be retried within budget. Failed dependencies block downstream stages, and the workflow completes only when all required stages pass.

## Swarm Validation

`swarm_spawn_validation` creates functional, security, and quality review sessions. All results are expected to pass. The runtime does not calculate a two-out-of-three consensus and does not convert assistant prose into a combined verdict; the caller must collect and evaluate every result.

`swarm_review_fixed_point` is the structured alternative. It selects only configured always-on and risk-matched reviewers, binds the caller's changed-file list to authoritative path and content identities, and supplies bounded secret-scanned snapshots to tool-denied reviewer sessions. One tool-denied correction agent proposes complete replacements for that immutable scope. The coordinator rechecks source content, requests per-file edit authority, and applies approved source or documentation replacements through the bounded file transport before starting a fresh review round. Each repeat reviewer must explicitly retain or resolve every prior issue ID. It returns `accepted` only when every selected reviewer passes in the same round and two whole-set identity passes remain stable under the project review lease. Repeated issue IDs, iteration exhaustion, correction blockers, invalid or credential-bearing output, child failure, and timeout remain explicit non-pass outcomes.

## Delegated Worktree Review

External CLI task output is not trusted for merge by itself. The manual delegated workflow sends each worktree diff to a native deep reviewer. Failed tasks can be re-delegated into a new preserved attempt. Only reviewed tasks should be passed to the checkpoint-and-merge tool.

The merge tool verifies Git state and containment, not product correctness. Quality and completion gates still run after approved task branches are combined.

## Completion Enforcement

For manual workflows, `workflow_check_completion` returns false while any non-skipped gate is not passed. Repeated checks do not waive a gate. The completion guard should verify original requirements, executable checks, unresolved TODOs, and review evidence before the supervisor calls that tool.

For automatic workflows, terminal status is computed from required stage states. Cancellation, budget pause, and failed dependencies are explicit states rather than review verdicts.

## Related Documentation

- [Workflow System](../WORKFLOWS.md)
- [Swarm Mode](./swarm-mode.md)
- [Delegated Workflows](./delegated-workflows.md)
- [E2E Testing](./e2e-testing.md)
- [Validation And Fixed-Point Review](./validation-and-fixed-point-review.md)
