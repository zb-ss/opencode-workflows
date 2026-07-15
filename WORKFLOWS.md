# Workflow System

OpenCode Workflows provides related but distinct orchestration mechanisms. This guide describes their current runtime boundaries and state transitions.

## Choose A Driver

| Driver | Starts with | Executes work through | Continues automatically |
|---|---|---|---|
| Manual workflow | `/workflow` | Supervisor calls the native Task tool and workflow tools | No; the supervisor advances each gate |
| Automatic DAG | `/workflow-auto` | Plugin creates SDK child sessions from an installed JSON DAG | Yes, while enabled, authorized, within budget, loaded, and not blocked |
| Native Task | A Task tool call | One OpenCode subagent | Only within that task; reuse `task_id` to continue it |
| Swarm | `swarm_spawn_batch` | Parallel SDK child sessions | The queue drains within configured limits |
| External CLI | `/delegate` or `delegate_run` | A `claude` or Antigravity `agy` child process | No; each run or follow-up is explicit |

Manual and automatic workflows do not share a state format. `/workflow-resume` never resumes an automatic DAG, and `/workflow-auto-resume` never falls back to a manual workflow.

## Configuration Directory

Runtime and installer code resolve the OpenCode configuration directory in this order:

1. `OPENCODE_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/opencode`
3. `$HOME/.config/opencode`

This guide calls that location `<config-dir>`. The installer writes plural directories including:

```text
<config-dir>/agents/
<config-dir>/commands/
<config-dir>/skills/
<config-dir>/plugins/
<config-dir>/tools/
<config-dir>/mode/
<config-dir>/workflow/
<config-dir>/schema/
<config-dir>/workflows/
```

Use the same `OPENCODE_CONFIG_DIR` when installing, running `--doctor`, and starting OpenCode. Restart OpenCode after changing configuration-time files or environment flags.

## Manual Lifecycle

The `/workflow` command is an agent-driven protocol, not a background scheduler. Its command definition exposes `feature`, `bugfix`, `refactor`, `figma`, `translate`, and `delegate` flows. Installed template files also provide the gate content used by the supervisor.

### Start

```text
/workflow feature Add request validation --mode=standard
```

The supervisor is instructed to:

1. Parse the workflow type and mode.
2. Load the selected mode's `agent_routing` and settings.
3. Ask how to handle the Git branch.
4. Create an org file under `<config-dir>/workflows/active/`.
5. Call `workflow_bind_session` with that org path, workflow ID, type, mode, and ordered gates.
6. Invoke the routed `wf-*` agents and update each gate.

`workflow_bind_session` creates a `.state.json` sidecar when given an org or Markdown path. State is accepted only below `<config-dir>/workflows/`. A private binding below `<config-dir>/workflows/runtime/sessions/<session-hash>/` associates the state with the exact OpenCode session.

The initial manual state includes:

- Workflow ID and type
- `driver: "manual"`
- Current, completed, and remaining phases
- Gate status and iteration data
- Mode
- Agent log
- `task_ids` for native Task resumption
- Org file path

### Run A Gate

For each gate the supervisor should:

1. Mark it `in_progress` with `workflow_update_gate`.
2. Call the native Task tool with an explicit `subagent_type`, such as `wf-executor`.
3. Read the returned `<task id="...">` and persist it under the gate's `task_ids` entry.
4. Mark the gate `passed`, `failed`, or `skipped` based on direct evidence.
5. Pause and report failures rather than silently bypassing the gate.

The enforcer injects bound workflow context into agent system prompts and preserves workflow identity during compaction. Native Task children inherit a read-only binding for context; only the current controller session can mutate gates or complete the workflow, and completion clears all propagated bindings. Idle-session events produce advisory logs when gates remain incomplete. They do not launch work or forcibly keep a session running.

### Native Task Resumption

A native Task ID belongs to one OpenCode subagent invocation. Continue the same agent and context by passing both the same `subagent_type` and stored `task_id`:

```json
{
  "description": "Continue the implementation gate",
  "prompt": "Address the recorded review findings and rerun focused checks.",
  "subagent_type": "wf-executor",
  "task_id": "<saved-task-id>"
}
```

Do not reuse a Task ID with a different subagent type. Start a new task only for separate work or when the previous task cannot be resumed, then replace the saved ID.

### Completion Gate

`workflow_check_completion` is the authoritative manual completion check. It returns `canComplete: false` until every non-skipped gate has passed. Repeated checks never bypass pending gates. A successful controller check atomically archives the state sidecar and companion org file under `<config-dir>/workflows/completed/`, then clears every propagated session binding.

The plugin does not perform a commit or branch action. Notifications and any later repository action remain explicit supervisor or user operations under normal OpenCode permissions.

### Status And Resume

```text
/workflow-status
/workflow-status <workflow-id>
/workflow-resume
/workflow-resume <workflow-id>
```

Manual resume reads active state and its companion org file. For a failed or interrupted gate, the supervisor should offer to continue the stored Task ID. If no Task ID exists, it should ask before starting a replacement.

Session bindings are exact. A workflow state discovered by `/workflow-resume` must be transferred with the permission-gated `workflow_resume_session` tool before enforcement tools can update it. Ordinary binding cannot transfer controller ownership, and inherited child bindings are ineligible for resume handoff.

## Manual Modes

Mode JSON files route roles to installed workflow agents. Manual iteration and parallelism guidance also lives in each mode's `settings`.

| Mode | Current routing intent |
|---|---|
| `eco` | Lite planning, implementation, review, security, and performance agents |
| `turbo` | Speed-oriented lite routing with reduced iteration limits |
| `standard` | Standard planner, executor, reviewer, security, and test routing |
| `thorough` | Deep code and security review with larger iteration limits |
| `swarm` | Deep review routing plus parallel swarm guidance |
| `delegate` | Manual planning, external CLI execution, review, merge, and completion routing |

The mode files do not pin provider model IDs. Runtime model behavior is described in [Model Selection](#model-selection).

## Automatic DAG Lifecycle

Automatic workflow driving is a separate opt-in plugin path. It accepts only installed declarative definitions named `development` and `e2e`.

### Choose Autonomy And Enable Budgets

`automation.autonomy` controls permission handling inside automatic child sessions. `interactive` is the default:

| Profile | Child-session behavior |
|---|---|
| `interactive` | Keeps the routed agent's effective permission rules, including asks; use for attended runs |
| `bounded` | Requires routed root Task permissions to resolve silently, resolves every child ask, and fails closed when authority is unavailable |

For an existing installation, preview and apply bounded autonomy with these separate commands:

```bash
node install.mjs --autonomy bounded --dry-run
node install.mjs --autonomy bounded
```

The autonomy command requires an existing `workflows.json`. It changes only `automation.autonomy`; it does not install files, enable automation, or create or change budgets.

`automation.enabled` defaults to `false`. When it is `true`, every budget field is required:

```json
{
  "automation": {
    "enabled": true,
    "autonomy": "bounded",
    "max_parallel_sessions": 2,
    "max_sessions": 12,
    "max_attempts_per_stage": 2,
    "max_wall_time_ms": 3600000,
    "max_input_tokens": 250000,
    "max_output_tokens": 80000,
    "max_bounded_read_bytes": 1048576,
    "max_bounded_write_bytes": 1048576,
    "max_cost_usd": null
  }
}
```

These values are examples, not defaults. Select limits for the project and provider account. The schema requires positive session, attempt, and wall-time limits; token limits may be zero; cost may be a non-negative number or `null`. Restart OpenCode after changing the autonomy profile, budgets, enabled state, or agent permissions. The engine persists the autonomy profile at workflow start and does not change it on resume; a configuration change applies only to newly started workflows.

### Start

```text
/workflow-auto development Implement the requested change --mode=standard
/workflow-auto e2e Exercise the requested browser flow --mode=thorough
```

The command calls `workflow_auto_start` once. The tool:

1. Confirms automation is enabled.
2. Detects capabilities and rejects unavailable `required` capabilities.
3. Loads and validates the installed definition.
4. Loads role routing from the selected mode.
5. Authorizes `task` permission for every routed agent used by the definition. Bounded mode first proves each decision is already `allow`, so authorization cannot prompt.
6. Persists a copy of the validated definition and initial state.
7. Starts dependency-ready stages up to the parallel-session budget.

Only `eco`, `turbo`, `standard`, `thorough`, and `swarm` are accepted automatic modes. `delegate` is not an automatic DAG mode.

The DAG validator accepts only declared stage fields, safe identifiers, known model tiers, existing dependencies, and acyclic graphs. Definitions are data; the engine does not generate or evaluate arbitrary workflow code.

### Installed DAGs

`development` follows this dependency structure:

```text
planning -> implementation -> code_review ----\
                           -> security_review  +-> quality_gate -> completion_guard
                           -> tests -----------/
```

`e2e` follows:

```text
setup -> e2e_exploration -> e2e_generation -> e2e_validation
      -> quality_gate -> completion_guard
```

Each stage runs in a child OpenCode session with a routed `wf-*` agent. Native Task, swarm, external delegation, and nested automatic-workflow tools are blocked inside stage sessions so sessions, processes, tokens, cost, and cancellation remain under engine control. The final assistant response must be one JSON object matching the stage result contract. Invalid output is an attempt failure. A failed result is retried unless it explicitly sets `retryable: false` or exhausts the configured attempt budget.

### Bounded Permission Resolution

Before creating a bounded child session, the adapter uses the typed OpenCode v2 SDK client to load the routed agent's effective permissions and produces a rule set containing no `ask` actions:

- A wildcard deny covers every built-in, plugin, and MCP permission by default.
- Only plugin-owned `workflow_bounded_list`, `workflow_bounded_read`, `workflow_bounded_write`, and todo state can be re-enabled from effective agent rules. List, read, and write authority derive from canonical worktree-relative `glob`/`list`, `read`, and `edit` rules. Built-in discovery, read, edit, write, and apply-patch remain denied because their broader behavior or formatter hooks are outside the bounded contract. Built-in grep, LSP, and global or external skills remain denied.
- Existing denies in those categories remain denied. Only explicit allows remain allowed; asks become deny.
- Unknown and custom permissions remain denied even when the agent explicitly allowed them.
- Bash, `webfetch`, `websearch`, external-directory access, questions, recovery prompts, plan transitions, nested Task calls, unsafe delegation, and environment-file reads are hard-denied.
- The automatic-workflow plugin independently rejects every unreviewed tool inside bounded stages, including built-in discovery/reading/editing, content search, LSP, validation or general processes, network, custom, Skill, Task, swarm, delegation, and nested automatic-workflow tools. Only explicit source-policy allows can enable a plugin-owned tool; `ask` and `deny` remain denied. Plugin-owned file tools authorize only the resolved canonical worktree-relative target. Descriptor-anchored filtered listing hides dotfiles, credential paths, control surfaces, and non-approved file types, returns at most 1,000 entries, and reports truncation. Reads use an explicit source/document extension allowlist, scan returned content and boundary overlap for common token formats and high-entropy values, and reject external, symbolic, or hard-linked targets. Writes reject hidden paths and listed host-executed controls, create verified parent components, preserve existing mode bits, and atomically replace the directory entry without invoking OpenCode formatters or shell commands.

Before start and resume, the adapter also evaluates the current root agent's effective Task rules for every routed `wf-*` agent. If any resolves to `ask` or `deny`, the operation fails before creating artifacts or invoking OpenCode's authoritative permission check. The installed supervisor's `wf-*` allow means that check proceeds silently.

This policy prevents an unattended child from waiting on a permission prompt. It is not an OS, container, or process sandbox. Final file access is anchored through an opened parent-directory descriptor and fails closed when neither `/proc/self/fd` nor usable `/dev/fd` access is available. Bounded stages execute no general shell commands or validation processes. Named validation operations remain available only to attended interactive workflows because repository-controlled checks are executable authority.

Bounded read and write bytes are atomically reserved and persisted per workflow so concurrent children cannot each consume the same remaining allowance. Complete serialized read and filtered-list responses use `max_bounded_read_bytes`; written UTF-8 content uses `max_bounded_write_bytes`. Each configured byte limit is capped at 16 MiB. These limits are independent of normal model-token counters.

### Blocked Stages

A stage returns `blocked`, with a `required_action`, when it cannot proceed without information, access, credentials, approval, or authority. `retryable` is valid only for failed results; blocker fields are valid only for blocked results. The engine records the result, marks pending dependent stages blocked, aborts parallel siblings back to pending, and pauses the workflow. This is a safe outcome, not evidence that the requested work or validation completed.

Treat the reported summary and required action as untrusted child output. Verify them against trusted project documentation; never provide secret values, run supplied commands, follow supplied URLs, or weaken permissions because blocker text requested it. Complete only a verified action before running `/workflow-auto-resume` in the same owning session. Restart OpenCode first if installed agent permissions changed. Resume reauthorizes routed agents under the persisted autonomy profile, refreshes configured budgets, reconciles existing children, and resets directly blocked stages and their dependency-blocked descendants to pending. Eligible stages are then scheduled within the remaining budgets. Resume does not switch or override the autonomy policy, reset attempts or accumulated usage, reset the original wall-clock age, or restart a terminal workflow.

Do not weaken bounded rules merely to force a pass. Protected control-file changes and credential access require an attended path. Credential-content scanning is defense in depth rather than a guarantee, so do not enable bounded reads for worktrees containing untracked credentials, data dumps, or personal data. Ordinary source edits can still introduce malicious behavior, so review the diff before any attended execution. If the required action is executable validation, keep the stage blocked or perform that validation through an explicitly attended workflow and report the boundary accurately.

### Budgets And Pausing

The engine tracks:

- Child sessions created
- Stage attempts
- Concurrent running sessions
- Input tokens
- Output and reasoning tokens
- Reported message cost
- Wall time from original workflow creation
- Configured validation operations consumed

Before a launch, exhausted limits pause scheduling. If usage crosses a limit while stages are running, those sessions are aborted and returned to pending before the workflow pauses. Attempt exhaustion also pauses for explicit intervention.

The validation broker consumes its persisted run count before process creation. A failed, timed-out, cancelled, or redacted run still consumes one run. See [Validation And Fixed-Point Review](./docs/validation-and-fixed-point-review.md).

Increase or otherwise change budgets in `workflows.json`, restart OpenCode, and use `/workflow-auto-resume` to apply them. A resume refreshes saved limits but does not reset accumulated usage or original wall-clock age.

### Persistence And Reconciliation

Automatic state and the copied definition are stored atomically with private file modes below the owning session's runtime directory. State records the root session, exact directory, exact worktree, stage sessions, attempts, model selections, results, errors, and budget usage.

On plugin startup, valid saved workflows are restored with scheduling disabled. This prevents a restart from launching new agents without an explicit action. `/workflow-auto-resume`:

1. Verifies current session, directory, and worktree ownership.
2. Reauthorizes routed agents.
3. Reconciles saved child session IDs with OpenCode session status.
4. Collects completed structured results.
5. Resumes deterministic scheduling.

The `workflow_auto_status` tool reports the current session's automatic workflow. The `workflow_auto_cancel` tool aborts running child sessions, marks pending stages blocked, and sets the workflow to `cancelled`. Terminal workflows are not restarted by resume.

## Capability Modes

Capabilities are configured in `experimental_capabilities`:

| Mode | Behavior |
|---|---|
| `disabled` | Capability remains inactive even if runtime support is available |
| `auto` | Capability is active when detected; absence does not block automatic start or resume |
| `required` | Capability is active when detected; absence blocks automatic start or resume |

Environment-backed detection uses:

| Capability | Environment variable |
|---|---|
| `background_subagents` | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` |
| `native_workspaces` | `OPENCODE_EXPERIMENTAL_WORKSPACES` |
| `mcp_code_mode` | `OPENCODE_EXPERIMENTAL_CODE_MODE` |
| `references` | `OPENCODE_EXPERIMENTAL_REFERENCES` |

Truthy values are `1`, `true`, `yes`, and `on`, case-insensitively. `plugin_v2` has no environment flag. The live plugin reports it available because the v2 plugin runtime successfully loaded the plugin. Installer `--doctor` performs a static check based on the compatible OpenCode version and installed automatic-workflow plugin.

If a capability-specific variable is absent, detection falls back to `OPENCODE_EXPERIMENTAL`. An explicitly false capability-specific value overrides the broad flag.

Use `workflow_capabilities` for the loaded runtime report. Capability settings currently report and gate availability; they do not modify OpenCode configuration, set environment variables, or replace the workflow's existing SDK scheduling. Restart OpenCode after changing a capability mode or environment variable.

## Model Selection

### Default: Runtime Inheritance

The installer strips repository-only `model_tier` metadata by default. Installed agents and commands then inherit OpenCode's merged runtime model configuration. This is also the behavior of the legacy `--runtime-models` and `--no-model-resolve` aliases.

### Explicit Materialization

`node install.mjs --materialize-models` resolves the ordered candidates for each agent:

1. `agent_models[agent]`, when present
2. The agent's `model_tiers[tier]`
3. `fallback_order`

Candidates can be a provider/model string or an object with `model` and `variant`. `agent_variants[agent]` supplies a variant when the candidate does not. Variants are sent only with a concrete model. The installer writes only the first valid configured candidate; it does not probe provider credentials.

No provider/model list is bundled. Schema validation checks candidate shape. Runtime catalog code queries OpenCode's live `config.providers` response and reports unavailable models or variants without model-name heuristics. Keep configured IDs aligned with the catalog exposed by the OpenCode installation.

## Swarm Runtime

Swarm is parallel OpenCode child-session execution, not external CLI delegation and not automatic DAG scheduling by itself.

The main tools are:

- `swarm_spawn_batch`: authorize agents and enqueue tasks
- `swarm_await_batch`: wait for event-driven completion with a timeout
- `swarm_collect_results`: retrieve final assistant text after completion
- `swarm_cancel_task`: abort one task and release its queue slot
- `swarm_spawn_validation`: create functional, security, and quality review tasks
- `swarm_review_fixed_point`: bind changed files to worktree status, collect tool-denied scoped correction proposals, and run strict re-review rounds

Global and per-provider concurrency come from `swarm_config`. Provider slots are derived from an explicitly supplied task model's provider prefix; tasks without one use the general queue. Queue state is persisted per caller session and restored paused after restart. The next `swarm_await_batch` call reauthorizes agents and the working directory before resuming queued work and reconciling running sessions; lifecycle events and staleness timers then drive completion.

Swarm tasks normally share a working directory. Parallelize only work that can safely share that directory, or use a separate worktree mechanism. Fixed-point reviewers run concurrently, but their single tool-denied correction-proposal task starts only after the review batch completes; the coordinator supplies bounded source snapshots, requests per-file edit authority, and applies validated scoped replacements before re-review. See [Swarm Mode](./docs/swarm-mode.md) and [Validation And Fixed-Point Review](./docs/validation-and-fixed-point-review.md).

## External CLI Delegation

Direct delegation executes official `claude` or Antigravity `agy` binaries as argv-only child processes. The compatible `gemini` routing token invokes `agy`; Gemini CLI is not used. This path is separate from native OpenCode subagents.

```text
/delegate status --auth
/delegate ask auto Summarize the current diff
/delegate ask gemini --model <agy-model-alias> Review the UI flow
/delegate followup <run-id> Check the security implications
/delegate runs
/delegate show <run-id>
```

The plugin requests `delegation` permission before execution. Unsafe provider modes are used only when configured and separately approved through `delegation_unsafe`. Models are not pinned in workflow configuration; an optional request-scoped alias can be passed manually. Runs are session-scoped, store bounded response data in JSON, and cap private stdout/stderr files according to `delegation.max_output_bytes`. Claude follow-up uses an internal native resume token when available; otherwise follow-up is stateless and includes a bounded excerpt of prior context.

See [External CLI Delegation](./docs/external-cli-delegation.md).

## Delegated Worktrees

`/workflow delegate ...` combines the manual supervisor, external provider processes, native OpenCode review agents, and managed Git worktrees.

Worktrees are created below the private workflow runtime, grouped by a hash of the canonical repository path, on validated `delegate/<workflow-id>/<task-id>` branches. Before merge, the manager:

1. Requires the target branch to be checked out in the target worktree.
2. Requires the target worktree to be clean; managed worktrees live outside the repository.
3. Checkpoints every task change inside the delegated worktree.
4. Verifies the task branch tip and worktree are a clean committed snapshot.
5. Refuses a no-op merge unless explicitly allowed by the library caller.
6. Uses a non-fast-forward merge and aborts on conflict.

Normal cleanup removes only clean worktrees whose exact branch tip is demonstrably merged. Dirty, unmerged, mismatched, or out-of-root paths are retained. Delegation batches are in memory; a plugin restart does not reconstruct an in-flight orchestrator batch, although Git worktrees preserve task changes for inspection.

See [Delegated Workflows](./docs/delegated-workflows.md).

## Translation Workflow

Install the optional module with `node install.mjs --all`. The translation plugin creates a session-owned Joomla workflow state under `<config-dir>/workflows/active/` and binds it to the exact session, directory, and worktree.

The flow is view-by-view:

1. `workflow_translate_init` validates and scans a component.
2. `workflow_translate_next` selects a pending or retryable view.
3. The coder inspects and converts only that view.
4. `workflow_translate_view_done` records observed counts and moves it to review.
5. `workflow_translate_review` passes the view or returns it to the error queue.
6. `workflow_translate_status` reports progress.

PHP view files in `tmpl/` and `layouts/` are considered; common backup names are excluded. Files over the plugin's line threshold require chunked inspection. Source language defaults to `en-GB`; target and component paths are explicit. Paths outside the current worktree require `external_directory` authorization, and edits require normal OpenCode edit permission.

Use `/translate-auto <component-path> <target-language>` for the orchestration command or `/translate-view` for focused work. See the installed command definitions for arguments.

## Permissions Summary

| Operation | Permission request |
|---|---|
| Native or automatic subagent | `task` for the routed agent |
| Swarm task | `task` for each distinct agent |
| Direct provider process | `delegation` |
| Unsafe provider flag | `delegation_unsafe` |
| Delegated worktree operation | `worktree`, plus edit or delegation as applicable |
| Path outside the worktree | `external_directory` |
| Translation read or write | `read` or `edit`, plus external-directory approval when applicable |

OpenCode permission rules remain authoritative. Workflow state does not grant filesystem, shell, task, or external process access.

For the Phase 1 autonomy boundary and planned secure delivery capabilities, see [Autonomous Workflows](./docs/autonomous-workflows.md).

## Diagnostics

```bash
node install.mjs --doctor
npm run validate:config
npm run typecheck
npm test
```

`--doctor` checks the minimum OpenCode version, installed `workflows.json` schema, installation manifest schema and target, managed-file ownership, legacy singular directories, and configured capability availability. Use `node install.mjs --migrate --dry-run` before normalizing an older workflow config.

For a manual workflow, use `/workflow-status` and inspect its active state. For an automatic workflow, use `workflow_auto_status`; after a restart, use `/workflow-auto-resume` rather than starting another workflow in the same session.

## Related Documentation

- [Agent Reference](./docs/agents.md)
- [Autonomous Workflows](./docs/autonomous-workflows.md)
- [Model Compatibility](./docs/model-compatibility.md)
- [Review System](./docs/review-system.md)
- [Swarm Mode](./docs/swarm-mode.md)
- [Delegated Workflows](./docs/delegated-workflows.md)
- [External CLI Delegation](./docs/external-cli-delegation.md)
- [E2E Testing](./docs/e2e-testing.md)
