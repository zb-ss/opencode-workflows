# Autonomous Workflows

Phase 1 adds bounded, session-owned execution to the existing declarative `development` and `e2e` DAGs. Phase 2 adds configured validation operations for attended interactive stages and structured fixed-point swarm review. Phase 3 adds post-completion guarded publication with immutable previews, complete-history scrub, pinned targets, and separate external-effect approval. Together they provide deterministic scheduling, explicit budgets, structured results, persistence, cancellation, bounded review/correction cycles, and attended publication. They do not provide full unattended software delivery.

## Autonomy Profiles

Set `automation.autonomy` in `workflows.json` to one of the following. `interactive` is the default:

| Profile | Intended use | Permission behavior |
|---|---|---|
| `interactive` | Attended automation | Keeps each routed agent's effective rules, including permission asks |
| `bounded` | Non-interactive, least-authority stages | Requires root Task authority to resolve silently and resolves every child ask before launch; a stage blocks when the resolved rules do not provide enough authority |

Before start or resume, bounded mode verifies that the current root agent's effective `task` rule already allows every routed child. If any rule resolves to `ask` or `deny`, the operation fails before creating workflow artifacts and does not open an interactive prompt. OpenCode still evaluates the authoritative Task permission after this preflight; with the required allow rule, that evaluation is silent. The installed supervisor already allows `wf-*` agents.

## Bounded Policy

Bounded mode derives a child-specific rule set from the routed agent's effective OpenCode permissions:

1. A wildcard deny provides the baseline for every built-in, plugin, and MCP permission.
2. Only plugin-owned `workflow_bounded_list`, `workflow_bounded_read`, `workflow_bounded_write`, and todo state can be re-enabled from explicit `allow` rules in the routed agent's effective policy. `ask` and `deny` both become deny, and a deny takes precedence when `glob` and `list` map to the same filtered-list authority. List, read, and write authority derive from canonical worktree-relative `glob`/`list`, `read`, and `edit` rules. Built-in discovery, read, edit, write, and apply-patch remain denied because their broader behavior or formatter hooks are outside the bounded contract. Built-in grep, LSP, and global or external skills remain denied.
3. Unknown and custom permissions remain denied even when the routed agent explicitly allowed them, leaving no unresolved child asks.
4. Bash, network fetch (`webfetch` and `websearch`), external-directory access, questions, recovery prompts, plan transitions, nested Task calls, unsafe delegation, and environment-file reads are hard-denied. OpenCode's external-directory gate keeps file tools inside the project worktree.
5. The automatic-workflow plugin independently rejects every stage tool outside a reviewed bounded runtime allowlist. File tools authorize only after resolving the same canonical worktree-relative path used by native OpenCode permissions. Descriptor-anchored filtered listing hides dotfiles, credential paths, control surfaces, and non-approved file types; each response returns at most 1,000 entries and reports truncation. Reads permit an explicit source/document extension allowlist, scan the returned region plus boundary overlap for common credential content, and reject external, symbolic, or hard-linked targets. Writes reject hidden paths and listed host-executed control surfaces, create verified parent components, preserve existing mode bits, and atomically replace the target directory entry without invoking OpenCode formatters or shell commands. Built-in glob, list, content search, executable validation, and shell remain unavailable.

Malformed or unavailable effective agent permissions fail closed before the child session is created. Agent discovery and bounded child creation use the typed OpenCode v2 SDK client connected to the plugin's current server.

This is an OpenCode permission policy, not an OS sandbox. It does not isolate the process with a container, virtual machine, separate user, or operating-system policy. Final file access is anchored through an opened parent-directory descriptor and fails closed when the platform exposes neither `/proc/self/fd` nor usable `/dev/fd` access. Bounded mode provides no general shell or executable validation. A stage must remain blocked when executable evidence is required.

## Setup

Install the project normally so that `workflows.json` exists. Then preview and apply the profile change:

```bash
node install.mjs --autonomy bounded --dry-run
node install.mjs --autonomy bounded
```

The command changes only `automation.autonomy` and creates a configuration backup when it writes. A workflow persists its selected autonomy profile at start and keeps that profile for its lifetime; later configuration changes apply only to newly started workflows. Older version-1 automatic states without this field are normalized to `interactive`, which was the only prior behavior. Separately edit `workflows.json` to set `automation.enabled` to `true` and configure all required limits:

- `max_parallel_sessions`
- `max_sessions`
- `max_attempts_per_stage`
- `max_wall_time_ms`
- `max_input_tokens`
- `max_output_tokens`
- `max_bounded_read_bytes`
- `max_bounded_write_bytes`
- `max_cost_usd`

Choose limits for the repository and provider account; the installer does not choose them. Restart OpenCode, then explicitly start a supported workflow:

```text
/workflow-auto development Implement the requested change --mode=standard
```

Bounded file I/O is cumulatively and atomically accounted in workflow state. Complete serialized read and filtered-list responses use `max_bounded_read_bytes`; written UTF-8 content uses `max_bounded_write_bytes`. Each configured limit is capped at 16 MiB. These byte limits are independent of normal model-token accounting.

Installer migration initializes missing bounded byte limits to `0` rather than deriving bytes from unrelated token budgets. Operators must select explicit nonzero values before bounded file tools can return or write content.

To enable executable checks for attended workflows, keep `automation.autonomy` set to `interactive`, configure `validation_broker.enabled`, `max_runs_per_workflow`, and at least one complete named operation, then restart OpenCode. Validation-run usage is persisted with the workflow budget and is not reset by resume. Bounded workflows reject this tool because configured checks execute repository code without an OS sandbox. See [Validation And Fixed-Point Review](./validation-and-fixed-point-review.md).

## Blocked And Resume

Automatic stage output supports `passed`, `failed`, and `blocked`. `retryable` is valid only for failed results; `blocker_code` and `required_action` are valid only for blocked results. A stage must use `blocked` when it lacks required information, access, credentials, approval, or authority, and must state the missing capability or operator decision in `required_action`. The engine then:

1. Records the blocked result and pause reason.
2. Marks pending descendants blocked by dependency.
3. Aborts parallel sibling sessions and returns them to pending so no child continues after the workflow pauses.
4. Pauses new scheduling without treating the missing authority as successful validation.

Blocker summaries and required actions are untrusted child output. Verify them against trusted project documentation; never provide secret values, run commands, follow URLs, or weaken permissions solely because blocker text requested it. Complete only a verified required action before invoking `/workflow-auto-resume` from the workflow's owning session. Restart OpenCode first when the action changed `workflows.json`, agent permissions, or other configuration-time files.

Resume reauthorizes routed agents under the workflow's persisted autonomy profile, refreshes configured budget limits, reconciles existing child sessions, and resets directly blocked stages and their dependency-blocked descendants to pending. Eligible stages are then scheduled within the remaining budgets. Resume does not switch autonomy profiles, bypass bounded denies, grant credentials, reset attempts or usage, reset the original wall-clock age, or restart completed, failed, or cancelled workflows. If authority is still unavailable, the stage may block again.

## Current Delivery Boundary

Phases 1 through 3 can coordinate bounded edits, run explicitly configured validation in interactive workflows, drive structured review/correction cycles, and prepare and execute an attended publication through a trusted configured publisher. Publication is root-only after workflow completion; automatic children never receive credentials or external authority. The broker does not implement provider APIs, remote protection discovery, deployment, reconciliation, rollback, or a universal secret scanner. Content scanning remains defense in depth. Validation and publication execute trusted processes without an OS sandbox and currently require POSIX process-group semantics. Arbitrary shell work, deployments, unsupported checks, and unattended external effects remain outside the boundary. See [Guarded Publication](./guarded-publication.md).

## Secure Delivery Roadmap

The delivery plan has five phases. Bounded autonomy, validation/fixed-point review, and guarded publication are complete. The remaining directions are not current capabilities:

4. **Epic worktrees** — isolated worktrees for coordinated work items, dependency-aware integration, provenance, conflict handling, and guarded merges.
5. **Durable queue autopilot** — restart-safe queued workflows with leases, idempotent reconciliation, ownership transfer, rate and budget controls, and explicit pause, cancel, and recovery operations.

OpenUltraCode may be consulted as an optional source of workflow ideas. It is not a runtime, installation, or architectural dependency of OpenCode Workflows.

## Related Documentation

- [Workflow System](../WORKFLOWS.md)
- [Agent Reference](./agents.md)
- [Review System](./review-system.md)
- [Validation And Fixed-Point Review](./validation-and-fixed-point-review.md)
- [Guarded Publication](./guarded-publication.md)
