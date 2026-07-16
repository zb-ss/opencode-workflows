# Swarm Mode

Swarm runs independent OpenCode subagent sessions concurrently through `@opencode-ai/sdk`. It is not a CLI process fallback, does not invoke Claude Code or Antigravity executables, and does not create Git worktrees.

## Tools

| Tool | Behavior |
|---|---|
| `swarm_spawn_batch` | Requests Task permission for each agent, creates a caller-owned batch, and enqueues its tasks |
| `swarm_await_batch` | Waits for all tasks using lifecycle events, staleness timers, and one status reconciliation |
| `swarm_collect_results` | Reads the last assistant text from every batch session |
| `swarm_cancel_task` | Aborts one running session or cancels one queued task |
| `swarm_spawn_validation` | Starts functional, security, and quality validation tasks |
| `swarm_review_fixed_point` | Selects configured reviewers by risk tag and runs structured review/correction rounds |

A batch task contains an ID, installed agent name, complete prompt, and optional OpenCode provider/model ID. The caller's bound manual workflow context is prepended when available.

## Concurrency

`swarm_config` in `workflows.json` controls the runtime queue:

```json
{
  "swarm_config": {
    "default_concurrency": 4,
    "provider_concurrency": {
      "provider": 2
    },
    "stale_timeout_ms": 180000,
    "progress_timeout_ms": 600000
  }
}
```

These are example values. Omit optional settings to use runtime defaults. Provider limits are keyed by the provider prefix of an explicitly supplied task model. A task without a model uses the general `unknown` provider bucket and inherits OpenCode's runtime model.

The FIFO draining queue starts queued work whenever both the global and provider slots allow it. No provider list is built into configuration validation.

## Persistence

Batch state is stored privately below the caller session's runtime directory. On plugin restart:

- Completed and failed task state is retained.
- Queued tasks remain paused until the owner reauthorizes them.
- Starting tasks without a child session return to queued.
- Running child sessions are restored and tracked without starting new work.
- The first wait reauthorizes agents and the working directory, resumes the batch, and performs status reconciliation.

Subsequent lifecycle events mark sessions completed or failed. A no-progress timeout distinguishes sessions that never produce output from sessions that stop progressing after output begins.

## Cancellation

`swarm_cancel_task` is scoped to the current caller session and batch. A running child session is aborted before its queue slot is released. A queued task can be cancelled without creating a session. Terminal tasks are not cancelled again.

Disposing the plugin releases in-memory waiters and queue controls; persisted state remains available for restoration.

## Safe Use

Swarm sessions use the same configured working directory unless the caller supplies another authorized directory. Use it for independent reads, reviews, tests, or edits that cannot collide. It does not isolate simultaneous file writes.

For isolated external edits, use [Delegated Workflows](./delegated-workflows.md). For dependency-aware stage scheduling, use the [automatic DAG](../WORKFLOWS.md#automatic-dag-lifecycle). A manual workflow in `swarm` mode may call swarm tools, but selecting the mode alone does not make every gate parallel.

## Typical Sequence

1. Decompose work into independent tasks.
2. Call `swarm_spawn_batch` once with a unique batch ID.
3. Call `swarm_await_batch` for that batch.
4. Confirm the batch is complete.
5. Call `swarm_collect_results` and evaluate each result.
6. Cancel or retry failures explicitly; do not infer success from session creation.

The validation helper creates separate functional, security, and quality sessions. Its tool description requires all validation results to pass; it does not implement majority voting.

The fixed-point helper is configured under `review_loop` in `workflows.json`. It always reviews the plugin project root and does not accept a subtree working directory. Caller-supplied risk tags select from configured reviewers; callers cannot supply agents, prompts, limits, or iteration counts, and caller-declared project-relative changed paths must exactly match the repository-wide worktree-status snapshot. Every selected reviewer must pass in one fresh round. After a review batch completes, a tool-denied correction agent may propose complete replacements only from bounded, secret-scanned source snapshots. The coordinator rechecks content, requests per-file edit authority, and applies approved source or documentation replacements before re-review, so no model session receives correction write authority. Individual batches retain normal swarm persistence, while automatic restart of the multi-batch coordinator is reserved for the durable queue roadmap phase.

## Related Documentation

- [Workflow System](../WORKFLOWS.md#swarm-runtime)
- [Agent Reference](./agents.md)
- [Review System](./review-system.md)
- [Validation And Fixed-Point Review](./validation-and-fixed-point-review.md)
