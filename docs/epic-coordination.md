# Epic Coordination

Epic coordination runs a dependency graph through isolated Git worktrees, exact checkpoint review, and guarded integration. It is opt-in, root-owned, attended after restart, and disabled by default. It is not a durable queue or a multiprocess scheduler.

## Enablement

Copy `_example_epic` from `workflows.json.template` into `epic`, choose the executor and reviewer agents and model tiers, set every retry and runtime limit, then restart OpenCode. The selected tiers must resolve to configured model candidates. Provider concurrency comes from `swarm_config` and is frozen into the epic when it starts.

`max_result_bytes` must be at least 8192 bytes so the mandatory executor and reviewer prompt envelopes can be validated before any child session is created.

No provider, model, retry limit, timeout, or budget is selected by the runtime. Keep `epic.enabled` false until the complete policy has been reviewed.

## Lifecycle

Only the owning root session can use epic tools. Mutating operations require the exact `revision`, `state_sha256`, and `ownership_generation` returned by the latest status. Stale calls fail rather than rebasing silently.

1. `epic_start` validates the graph and policy, requests root authorization for both agents, persists the epic, and schedules dependency-ready items.
2. `epic_await` waits for the in-process scheduler to become quiescent. `epic_status` returns a redacted operational projection, while `epic_collect` returns bounded item summaries and changed paths.
3. Each executor session is durably reserved before child creation. Successful output is checkpointed in its isolated worktree.
4. The coordinator scans authored patch bytes and changed paths, marks the patch as untrusted data, and sends the exact checkpoint to the configured reviewer. Passing review requires zero issues and is bound to the checkpoint, patch, reviewer session, agent, and model.
5. `epic_integrate` persists an exact intent before computing and publishing a merge. Publication uses Git ref compare-and-swap. The event records both the pre-publication target and the resulting integration commit.
6. `epic_cleanup` removes only clean, identity-bound worktrees whose reviewed checkpoint is already integrated.

Dependencies become schedulable only after their predecessors are integrated, not merely reviewed.

## Budget Modes

Budgets are optional and independently scoped to an item or the whole epic. Omitting a dimension means `not_configured`; a limit of zero blocks the first reservation or observation. Do not use placeholder limits to represent an unmetered subscription.

### Unbudgeted Subscription

Omit `budgets` from `epic_start`. Session, token, active-time, and calendar-age telemetry remains visible, but those dimensions do not stop execution. Concurrency, attempt ceilings, strict review, patch scanning, worktree isolation, and integration compare-and-swap remain mandatory safety controls.

### Selective Limits

Pass only limits the operator intends to enforce. For example, an epic session cap can bound executor and reviewer launches while leaving token and cost dimensions unconfigured:

```json
{
  "budgets": [
    {
      "dimension": "sessions",
      "scope": "epic",
      "item_id": null,
      "limit": 12
    }
  ]
}
```

An executor and its reviewer consume separate session reservations. Item limits cannot loosen an applicable epic limit.

### Metered API Use

Configure `input_tokens`, `output_tokens`, or `cost_usd` only when the connected runtime provides authoritative measurements. Missing token or cost evidence pauses a metered epic rather than treating unknown usage as zero. A cost budget is rejected at start unless every selected provider has trustworthy cost-reporting capability.

The standard plugin does not infer cost capability from provider or model names. If the host cannot supply explicit trustworthy capability evidence, cost budgets remain unavailable while the other dimensions continue to work.

## Time Semantics

- `active_time_ms` advances only while work is active. Paused time is excluded, and checkpoints make long-running usage durable.
- `calendar_age_ms` is derived from creation time and continues while paused.
- Omitting either dimension leaves it unbudgeted while telemetry remains available.

## Retries

Semantic, contract, and transport failures have separate ceilings. Transport retries use the configured backoff. Repeated identical progress trees trigger the no-progress breaker. The frozen per-item attempt limit remains the final ceiling.

Failed reviewer issues are persisted with the exact review and supplied to the next executor as bounded, explicitly untrusted revision input. An executor `blocked` result pauses for an owner decision instead of consuming semantic retries.

Ambiguous launches are never retried automatically. An explicit attended `epic_resume` may requeue them only when `former_runtime_terminated` is true. This confirmation is a safety assertion that the previous process cannot still produce accepted work.

## Pause And Recovery

`epic_pause` and `epic_cancel` abort active children and inspect their status. Conclusively terminated work is cancelled safely. Unknown termination becomes an explicit executor or reviewer ambiguity.

After a plugin or OpenCode restart, the persisted runtime incarnation requires attended recovery:

1. Call `epic_status` and retain its exact CAS fields.
2. Confirm the former runtime has terminated.
3. Call `epic_resume` with `former_runtime_terminated: true`.
4. Recovery validates worktree identity, settles active children conservatively, closes active-time intervals, advances ownership generation, and reauthorizes both agents before scheduling.

If integration may have published, recovery checks the branch head, both parents, and a freshly recomputed merge tree before accepting the result. A mismatch remains paused for attended investigation. Do not delete retained worktrees or retry an ambiguous integration blindly.

## Integration Outcomes

- A clean result advances the integration ref atomically and records hash-chained evidence.
- A content conflict records safe relative paths and retains the source worktree for repair.
- A known pre-publication refusal clears the intent and pauses as `integration_undispatched`; a fresh owner-authorized `epic_integrate` call may retry it.
- An uncertain publication or post-publication state settlement pauses as `integration_ambiguous` and retains the intent for recovery.

## Policy Changes

`epic_budget_update` adds, removes, or tightens one limit. Numeric increases require `epic_budget_extend`, a separate extension ID, and durable extension evidence. Both operations are root-only, one-shot authorized, and bound to exact state CAS fields. They do not reset usage, attempts, creation time, or active-time history.

## Operational Boundary

Epic coordination is process-local and attended after restart. It does not provide leases, takeover, global queue capacity, stale-worker fencing, or unattended ambiguous-launch recovery. Those capabilities require a separate durable-queue implementation that is not yet available.

Git worktrees isolate branches and provenance but are not operating-system sandboxes. Executor and reviewer agents still require appropriately restricted OpenCode permission profiles.
