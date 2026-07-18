# Validation And Fixed-Point Review

Phase 2 adds two opt-in capabilities: a typed validation broker for attended interactive automatic stages and a structured fixed-point review coordinator built on the existing swarm runtime. Neither capability enables automation, grants publication authority, or provides an operating-system sandbox.

## Validation Broker

`workflow_validation_run` accepts only a configured operation name. The operation definition in `workflows.json` owns every executable argument and limit:

```json
{
  "validation_broker": {
    "enabled": true,
    "max_runs_per_workflow": 10,
    "operations": {
      "typecheck": {
        "argv": ["/absolute/path/to/npm", "run", "typecheck"],
        "working_directory": ".",
        "permission_pattern": "npm run typecheck",
        "environment": [],
        "timeout_ms": 300000,
        "max_output_bytes": 1048576,
        "success_exit_codes": [0]
      }
    }
  }
}
```

The broker:

- Requires an operator-configured absolute executable path, resolves it to a canonical regular executable outside the worktree, then executes that path plus a fixed argv array with `shell: false`.
- Removes relative, missing, worktree-contained, group/world-writable, and foreign-owned entries from the child `PATH`, and passes only that sanitized path plus explicitly allowlisted environment-variable names. The canonical configured executable and its path components must likewise be root-owned or owned by the OpenCode process user without group/world write bits. `PATH` is child-process context, not executable selection authority.
- Opens the configured working directory after permission with no symbolic-link following, verifies its canonical worktree location, and keeps that descriptor anchored through process creation.
- Requires explicit `workflow_validation_run` authority from a routed interactive agent. Bounded stages cannot invoke executable validation because the broker does not provide an operating-system sandbox.
- Tells interactive automatic stages only the configured operation names through their trusted stage prompt, so agents do not need access to private configuration. Command arguments, paths, and environment policy remain private and execution still performs its own permission and budget checks.
- Enforces a persisted per-workflow run count before spawning the process.
- Rechecks cancellation after run-budget consumption; cancellation in that window is audited and returned without spawning a process.
- Kills the POSIX process group on timeout or caller cancellation. The broker fails closed on Windows because descendant termination cannot be guaranteed there.
- Caps combined returned stdout and stderr bytes while continuing to drain the process.
- Incrementally scans the complete drained output streams with boundary overlap, then marks the run failed and redacts retained output when credential-like signatures or high-entropy token detection match, including beyond the return cap.
- Writes a private mode-`0600` audit record below the stage session's runtime directory. The audit stores command metadata and SHA-256 hashes of the complete drained stdout and stderr streams, including bytes omitted from or redacted in the returned result, but not raw argv or output.

Validation commands execute repository code. Configure only reviewed operations, do not allowlist secret-bearing environment variables, keep sensitive values out of validation output, and treat content detection as defense in depth. A configured operation is narrower than shell access, but it is still executable authority and is not a network, filesystem, cgroup, or descendant-process sandbox. The broker therefore rejects bounded autonomy and runs only in an attended interactive workflow. Do not run validation concurrently with fixed-point review, and do not treat process-group termination as proof that deliberately detached descendants were contained.

Configuration is loaded when the plugin starts. Restart OpenCode after changing operations, permissions, or limits. Existing automatic workflows retain their persisted validation-run usage; resume does not reset it.

## Fixed-Point Review

`swarm_review_fixed_point` uses `review_loop` configuration rather than caller-supplied agent names or iteration limits:

```json
{
  "review_loop": {
    "enabled": true,
    "max_iterations": 3,
    "batch_timeout_ms": 300000,
    "max_result_bytes": 1048576,
    "correction_agent": "wf-executor",
    "correction_focus": "Propose complete scoped file replacements for every reported issue.",
    "reviewers": [
      {
        "id": "functional",
        "agent": "wf-reviewer-deep",
        "always": true,
        "risk_tags": [],
        "focus": "Review functional correctness and requirement completeness."
      },
      {
        "id": "security",
        "agent": "wf-security-deep",
        "always": false,
        "risk_tags": ["security"],
        "focus": "Review authorization, injection, data exposure, and unsafe execution."
      }
    ]
  }
}
```

Always-on reviewers run for every invocation. Additional reviewers run only when the caller supplies a matching configured risk tag. Unknown risk tags fail instead of silently skipping coverage. Fixed-point review always runs at the plugin project root; it does not accept a narrower working directory. The supplied project-relative changed-file set must exactly match an authoritative repository-wide OpenCode worktree-status snapshot captured before review and rechecked before acceptance; extra and omitted paths both fail. The coordinator requests read authority for every authoritative changed file before loading source content. Each bounded source snapshot and its type, mode, size, and SHA-256 identity are then captured together through one descriptor-anchored read, refreshed together after coordinator-owned corrections, and rechecked before acceptance so same-path content changes fail. A project review lease excludes other plugin-owned fixed-point runs and bounded workflow writes, while two complete identity passes detect cross-file instability before acceptance. The coordinator requests Task authority for selected reviewers only after scope and read authorization, and requests correction-agent authority only when a correction batch is required. One configured batch deadline covers both child completion and result retrieval, cancellation is awaited before a failed batch settles, and non-terminal children are reported by task ID as a cleanup failure rather than silently ignored.

Every reviewer must return one object conforming to `schema/structured-review-result.schema.json`. A pass contains no issues; a failure contains stable issue IDs, severity, impact, optional location, and remediation. On later rounds, each reviewer receives its own prior findings and must classify every prior ID as still present or directly verified in `resolved_issue_ids`; silent disappearance and invented resolutions fail the round. Reviewers and the correction agent run in v2 sessions with a wildcard permission deny and no filesystem or execution tools. The coordinator supplies capped changed-file snapshots read through the bounded transport, including its sensitive-path and credential-content checks; files unavailable through that transport require attended review. Reviewer and correction output is also rejected when credential-like content is detected. On failure, the correction agent receives the eligible snapshots and sourced IDs such as `security:auth-check`; its result must conform to `schema/review-correction-result.schema.json` and may propose only complete replacements for supplied snapshots.

The coordinator validates every proposed path against the immutable worktree-status scope and the bounded-write policy, rechecks that source content has not changed, and requests explicit per-file edit authority before changing the worktree. Sensitive files, hidden paths, dependency manifests, lockfiles, CI files, assistant controls, deleted files, oversized files, and other host-executed configuration remain outside automatic correction. Approved source or documentation replacements use descriptor-anchored atomic writes. The correction result returned in review history lists changed paths but omits proposed file content. A fresh review round is still required after those replacements are applied.

The loop stops with:

| Status | Meaning |
|---|---|
| `accepted` | Every selected reviewer passed in the same fresh review round; `accepted_snapshot_sha256` identifies the exact reviewed path-and-content identity set |
| `stalled` | The same sourced issue-ID set remained after a correction round |
| `exhausted` | The configured review-round limit ended with unresolved issues |
| `blocked` | The correction agent reported a missing capability or operator decision |
| `failed` | A batch timed out, a child failed, or structured output was invalid |

There is no majority vote and no pass inferred from missing prose. Review and read-only correction-proposal batches use the persistent swarm queue, but the multi-batch coordinator itself is not resumed automatically after a plugin restart. Durable unattended queue recovery remains a later roadmap phase.

## Related Documentation

- [Autonomous Workflows](./autonomous-workflows.md)
- [Review System](./review-system.md)
- [Swarm Mode](./swarm-mode.md)
- [Workflow System](../WORKFLOWS.md)
