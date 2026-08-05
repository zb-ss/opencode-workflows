# Durable Queue

The durable queue provides multiprocess scheduler authority for long-running automatic workflows. It is opt-in, root-owned, and disabled by default. It uses a fencing lease to guarantee at most one authoritative scheduler per configuration directory, with monotonically increasing fencing generations that reject stale writers after takeover.

## Enablement

Copy the `_example_queue` from `workflows.json.template` into `queue`, choose the concurrency, lease, and retry limits, then restart OpenCode. No provider or model is selected by default.

The queue requires `automation.enabled = true` to dispatch workflow stages. The queue manages scheduling authority; the automatic workflow engine handles stage execution, budgets, and structured results.

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `max_concurrent_workflows` | Yes | Maximum workflows running simultaneously |
| `lease_duration_ms` | Yes | Fencing lease lifetime before expiry allows takeover |
| `renewal_interval_ms` | Yes | How often the lease is renewed (must be less than lease_duration_ms) |
| `recovery_attempt_limit` | Yes | Maximum classified retry attempts before the record remains paused |
| `retry_policy` | Yes | Per-class retry ceilings (transport, contract, semantic, no-progress) with backoff |
| `rate_windows` | No | Whole-workflow admission limits per time window |

## Lifecycle

1. **Enqueue**: `queue_enqueue` creates a workflow record with `queued` status and fencing generation from the active lease.
2. **Lease**: The scheduler acquires a fencing lease and transitions `queued` workflows to `leased` under the concurrency limit.
3. **Running**: The automatic workflow engine dispatches stages for `leased` workflows.
4. **Completion**: Workflows transition to `completed`, `failed`, or `cancelled`.
5. **Pause/Resume**: `queue_pause` and `queue_resume` transition workflows with exact CAS evidence.
6. **Recovery**: `queue_recover` rebuilds the index, reconciles launch intents, and transitions ambiguous launches to `paused` for attended resolution.

## Owner Tools

All tools require verified root-session context. Mutating and recovery tools also require explicit authorization:

- `queue_enqueue` — Add a workflow to the queue
- `queue_status` — Overall queue status (lease, counts by status)
- `queue_workflow_status` — Single workflow status by ID
- `queue_pause` — Pause a workflow with CAS
- `queue_resume` — Resume a paused workflow with CAS
- `queue_cancel` — Cancel a workflow with CAS
- `queue_delete` — Delete a terminal workflow record and reclaim its retained storage
- `queue_recover` — Trigger attended recovery with former-runtime confirmation
- `queue_collect` — Bounded summaries of all workflows

Mutations of an existing workflow record (`queue_pause`, `queue_resume`, `queue_cancel`, and `queue_delete`) require `expected_revision` and `expected_generation` from the latest status. Enqueue creates a new record, while attended recovery reconciles the complete queue under a newly acquired fencing lease. Stale record mutations fail rather than rebasing silently. Terminal records remain available for inspection until `queue_delete` removes them; delete old terminal records before the bounded queue reaches its storage limit.

## Budgets

Per-workflow budgets (sessions, tokens, cost, active time, calendar age) are enforced by the `automation` configuration, not the queue. The queue manages scheduling authority; the automatic workflow engine handles stage execution and budgets. Configure `automation.max_sessions`, `automation.max_input_tokens`, `automation.max_cost_usd`, etc. when enabling the queue.

## Rate Windows

Rate windows limit whole-workflow admissions, not individual child-session or provider requests. Counters are crash-idempotent (persisted to files) and reset automatically when the window elapses:

```json
{
  "rate_windows": [
    { "window_ms": 60000, "max_requests": 50 }
  ]
}
```

## Retry Policy

Retry policy is a safety control with separate ceilings per failure class:

- `transport` — definitive dispatch or infrastructure failure before workflow execution, using exponential backoff
- `contract` — invalid queue launch prerequisites detected before child execution
- `semantic` — an automatic workflow reaches a failed outcome, including exhausted stage-result failures
- `no_progress` — a conservative ceiling on consecutive classified whole-workflow retries

Ambiguous launches are never retried automatically and always pause for attended reconciliation.
The durable queue has no trusted cross-attempt artifact that can prove partial progress, so every classified whole-workflow retry conservatively increments the consecutive no-progress counter. Normal owner pause/resume cycles are unclassified and do not consume retry or recovery ceilings.

## Recovery

After a plugin or process restart, the persisted fencing lease requires attended recovery:

1. Call `queue_status` to check the lease state.
2. Confirm the former runtime has terminated.
3. Call `queue_recover` with `former_runtime_terminated: true`.
4. Recovery rebuilds the index, reconciles launch intents, and transitions ambiguous launches to `paused`.

The fencing lease ensures a stale scheduler cannot enqueue work, reserve capacity, or update policies after losing authority.

## Platform Assumptions

- POSIX filesystem with atomic `rename` and `O_EXCL` across processes
- `fsync` honored by the underlying storage
- Local filesystem only (not NFS)
- Same-UID ownership for lease and record files
