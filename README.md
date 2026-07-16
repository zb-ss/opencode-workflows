# OpenCode Workflows

OpenCode Workflows installs agents, commands, skills, plugins, workflow definitions, schemas, and supporting libraries into an [OpenCode](https://opencode.ai) configuration directory. It supports manual gate-driven workflows, opt-in declarative workflow automation, native OpenCode subagents, SDK-backed swarm batches, and direct Claude Code or Antigravity CLI delegation.

These are separate execution paths. Installing the project does not enable unattended workflow automation or external CLI execution by default.

## Requirements

- OpenCode 1.17.20 or newer
- Node.js 18 or newer
- Git for bootstrap installation and delegated worktrees
- Optional: authenticated `claude` or Antigravity `agy` executables for external CLI delegation; the `gemini` routing token invokes `agy`
- Optional: the translation module for Joomla localization workflows

## Install

Bootstrap the current release:

```bash
curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
```

Or install from a clone:

```bash
git clone https://github.com/zb-ss/opencode-workflows.git
cd opencode-workflows
node install.mjs --dry-run
node install.mjs
node install.mjs --doctor
```

The installer uses copy mode by default. It creates plural OpenCode directories such as `agents/`, `commands/`, `skills/`, `plugins/`, and `tools/`; a doctor warning identifies legacy singular directories.

OpenCode configuration is resolved in this order:

1. `OPENCODE_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/opencode`
3. `$HOME/.config/opencode`

Set `OPENCODE_CONFIG_DIR` in the environment used by both the installer and OpenCode when using a non-default location:

```bash
export OPENCODE_CONFIG_DIR="/path/to/opencode-config"
node install.mjs
node install.mjs --doctor
```

The bootstrap also accepts `INSTALL_DIR`, `INSTALL_MODE=copy|symlink`, and `INSTALL_MODULES=all` or a comma-separated module list.

Restart OpenCode after installation, migration, uninstallation, plugin changes, agent changes, workflow configuration changes, or capability environment changes. OpenCode loads configuration-time files when it starts.

After restarting, `/workflow feature <task>` starts the normal gate-driven workflow and `/workflow-status` reports its state. External CLI delegation is optional; run `/delegate status --auth` before relying on it.

## Upgrade An Existing Installation

From the existing repository checkout, preview and apply configuration migration before reinstalling managed files:

```bash
git pull --ff-only
node install.mjs --migrate --dry-run
node install.mjs --migrate
node install.mjs
node install.mjs --doctor
```

Migration preserves the original configuration beside `workflows.json` as a `.backup` file, adding a numeric suffix when needed. Review the dry-run output and commit or otherwise preserve intentional local repository changes before pulling. Restart OpenCode after the doctor check passes.

## Installer Commands

```bash
node install.mjs                         # Install core in copy mode
node install.mjs --symlink               # Symlink unchanged files for development
node install.mjs --all                   # Install core and translation module
node install.mjs --module translate      # Add translation to the core install
node install.mjs --materialize-models    # Bake configured model candidates into frontmatter
node install.mjs --doctor                # Check version, schema, manifest, ownership, and capabilities
node install.mjs --migrate               # Normalize legacy workflows.json data
node install.mjs --autonomy bounded      # Select bounded automatic-stage permissions
node install.mjs --autonomy interactive  # Restore attended permission handling
node install.mjs --uninstall             # Remove only verified installer-owned files
node install.mjs --migrate --dry-run     # Preview a migration
node install.mjs --uninstall --dry-run   # Preview an uninstall
```

`--dry-run` also previews a normal install. Existing user configuration is preserved. The installer backs up conflicting unmanaged targets, tracks installed files in a manifest, removes only verified stale managed files, and preserves modified or unverified files during uninstall. Unverified singular files claimed by an older installer manifest are moved to backups before plural replacements are activated, preventing duplicate command or plugin loading without discarding local changes. `opencode.json`, `opencode.jsonc`, and `workflows.json` are not removed.

Symlink mode is intended for repository development. Files whose model metadata must be transformed, and translation tools that require copies, are still copied.

## Verify The Repository

Install development dependencies and run the complete repository check:

```bash
npm install
npm run verify
```

Individual checks are available as:

```bash
npm run typecheck
npm run validate:config
npm test
npm run test:unit
npm run test:integration
```

## Execution Paths

| Path | Entry point | Driver | Persistence | Intended use |
|---|---|---|---|---|
| Manual workflow | `/workflow`, `/workflow-resume`, `/workflow-status` | Supervisor agent | Org file, state sidecar, session binding, saved Task IDs | User-visible gate orchestration with explicit completion checks |
| Automatic workflow | `/workflow-auto`, `/workflow-auto-resume` | Declarative DAG engine | Session-owned definition and state | Opt-in deterministic scheduling of installed `development` or `e2e` DAGs |
| Guarded publication | `/publication-preview`, `/publication-execute`, `/publication-status` | Root-side publication broker | Immutable artifacts, one-shot claims, hash-chained execution events | Attended publication through an operator-configured trusted publisher |
| Native subagent | OpenCode Task tool | Calling agent | OpenCode task/session ID | One agent task, resumed with the same `task_id` |
| Swarm batch | `swarm_*` tools | SDK session runtime | Session-scoped batch state | Parallel independent OpenCode subagent sessions |
| Direct external delegation | `/delegate` or `delegate_*` tools | Provider CLI process | Session-scoped run records and output logs | One-off Claude Code or Antigravity prompts and follow-ups |
| Delegated workflow | `/workflow delegate ...` | Manual supervisor plus delegation tools | Manual workflow state; worktrees preserve task changes | Reviewed external CLI changes in isolated git worktrees |
| Translation workflow | `/translate-auto`, `/translate-view` | Translation plugin and specialist agents | Session-owned workflow state | View-by-view Joomla language conversion |

See [WORKFLOWS.md](./WORKFLOWS.md) for lifecycle, gate, budget, capability, and cancellation details.

## Manual Workflows

```text
/workflow feature Add request validation
/workflow bugfix Fix duplicate form submission --mode=thorough
/workflow delegate Split a modular change across isolated worktrees
/workflow-status
/workflow-resume
```

The supervisor creates workflow state, binds it to the current OpenCode session, invokes installed `wf-*` agents with the native Task tool, and updates each gate. A returned Task ID is stored under `task_ids` and reused with `task_id` for corrections or interrupted work. Fresh-session resume uses the permission-gated `workflow_resume_session` handoff; inherited child bindings cannot take controller ownership. `workflow_check_completion` refuses completion while a mandatory gate remains incomplete and archives both state and org files after all gates pass.

Manual enforcement tracks and checks state; it does not autonomously run the next gate. The supervisor remains responsible for invoking agents, recording Task IDs, updating gates, and handling archive or branch actions.

## Automatic Workflows

Automatic workflow driving is disabled by default. It supports only the installed `development` and `e2e` JSON DAGs:

```bash
node install.mjs --autonomy bounded --dry-run
node install.mjs --autonomy bounded
```

These commands update only `automation.autonomy` in an existing `workflows.json`. Configure `automation.enabled: true` and every required budget separately, then restart OpenCode and start the workflow:

```text
/workflow-auto development Implement the requested change --mode=standard
/workflow-auto e2e Verify the checkout flow --mode=thorough
/workflow-auto-resume
```

Before enabling automation, configure child-session, parallel-session, attempt, wall-time, input-token, output-token, bounded-read-byte, bounded-write-byte, and cost budgets in `workflows.json`. `max_cost_usd` may be `null`; the field is still required. Bounded file I/O atomically reserves complete serialized read/list responses against `max_bounded_read_bytes` and written UTF-8 content against `max_bounded_write_bytes`, independently of normal model-token accounting. Each bounded byte limit is capped at 16 MiB.

`workflows.json.template` includes a complete inactive `_example_automation` object. Replace the active `automation` object with reviewed values from that example rather than enabling automation with missing limits. The numbers are illustrative safety budgets, not defaults selected for a repository or provider account.

`node install.mjs --migrate` initializes missing bounded byte budgets to `0`; it never infers byte authority from token limits. Choose explicit nonzero values before using bounded file tools.

`automation.autonomy` accepts `interactive` or `bounded`; `interactive` is the default. Interactive mode retains each child agent's effective permission rules. Bounded mode preflights routed Task permissions so they cannot prompt, then builds child rules over a wildcard deny. Only explicit `allow` rules can enable plugin-owned filtered-list, exact-file read, direct-write, or todo tools; `ask` and `deny` remain denied. Built-in glob/list/read/edit/write/apply-patch, grep, LSP, Bash, executable validation, network fetch, external-directory access, global skills, questions, nested Task calls, unsafe delegation, and unreviewed runtime tools are denied. Listing and reads use approved source/document types and credential protections; direct writes atomically replace targets without invoking OpenCode formatters and reject hidden paths and listed host-executed controls. Content scanning is defense in depth, so do not expose worktrees containing credentials or sensitive data. A stage must return `blocked` when required information or authority is unavailable; parallel siblings are aborted and resume does not bypass the missing authority. Treat child-provided blocker text as untrusted and never supply secrets or weaken safeguards because it requested them.

The engine validates a fixed JSON schema, rejects dependency cycles and unsupported fields, routes stage roles through the selected mode, and accepts only structured stage results. It does not generate or execute arbitrary workflow code. Session- or process-spawning tools are blocked so every child session remains budgeted and cancellable.

Bounded mode is an OpenCode permission profile, not an OS sandbox, and provides no general shell or executable validation. Attended interactive workflows may opt into a POSIX validation broker that executes named, fixed-argv operations with an operator-pinned absolute executable, descriptor-anchored worktree containment, persisted run counts, timeout/output limits, cancellation, credential-output redaction, and private full-stream audit hashes. It does not contain deliberately detached descendants, so operators must not overlap validation with fixed-point review. The swarm plugin also offers an opt-in fixed-point review tool with configured reviewer selection, strict JSON verdicts, status-bound changed-file scope, tool-denied correction proposals over bounded source snapshots, authorized source-file replacement, and explicit accepted/stalled/exhausted/blocked outcomes.

After an automatic workflow completes, guarded publication can create an immutable preview for a configured target, scan every commit, blob, tree, and changed path reachable from the publication head, pin exact Git, publisher, and target identities, and invoke the fixed trusted publisher only after fresh revalidation and separate one-shot approval. Protected targets require an additional approval; blocked or ambiguous executions are never retried automatically. See [Validation And Fixed-Point Review](./docs/validation-and-fixed-point-review.md), [Guarded Publication](./docs/guarded-publication.md), and [Autonomous Workflows](./docs/autonomous-workflows.md).

The inactive `_example_publication` object in `workflows.json.template` contains every required policy field. Replace its repository-specific paths, refs, URL, marker, limits, and publisher before enabling it. The publisher is a separately compiled, operator-controlled native adapter; the guarded-publication guide documents its exact request and acknowledgment protocol.

State is written atomically below the selected config directory, including the autonomy profile selected at start. That profile is immutable for the workflow lifetime; changing `workflows.json` affects only new workflows. Older version-1 states without a profile are normalized to `interactive`. After a plugin or OpenCode restart, saved workflows are restored without launching new stages. `/workflow-auto-resume` reauthorizes agents under the persisted profile, reconciles child sessions, refreshes budgets, and retries eligible blocked paths while retaining accumulated usage and attempts. Runtime tools also expose status, capability reporting, and cancellation for the workflow owned by the current session.

## Models

Runtime model inheritance is the installer default. During installation, `model_tier` metadata is removed from installed agents and commands, so OpenCode's merged `model`, `small_model`, and per-agent model configuration remains authoritative. Variant metadata is emitted only with a concrete model because variants are model-specific.

Use `--materialize-models` only when concrete frontmatter is required. It selects the first configured candidate for the agent or tier and writes `model` plus an optional `variant`. If no valid candidate exists, the installer leaves the model inherited and reports a warning.

`workflows.json.template` contains no provider or model defaults. Candidate validation checks syntax and schema. Runtime catalog helpers query OpenCode's live `config.providers` response instead of maintaining a provider/model matrix or inferring capabilities from model names. See [Model Compatibility](./docs/model-compatibility.md).

## Capabilities

Optional OpenCode integrations are configured under `experimental_capabilities` with `disabled`, `auto`, or `required` modes. Inspect the loaded runtime with the `workflow_capabilities` tool.

Environment-backed capabilities use these exact variables:

- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`
- `OPENCODE_EXPERIMENTAL_WORKSPACES`
- `OPENCODE_EXPERIMENTAL_CODE_MODE`
- `OPENCODE_EXPERIMENTAL_REFERENCES`

When a capability-specific variable is absent, detection falls back to OpenCode's broad `OPENCODE_EXPERIMENTAL` flag. An explicitly false capability-specific value overrides the broad flag.

Plugin v2 availability is detected from the loaded plugin runtime rather than an environment variable. `required` blocks automatic start or resume when unavailable; `auto` marks detected support active without blocking when absent; `disabled` keeps the capability inactive. These settings do not write unknown keys into `opencode.json` and do not set environment variables for you.

## Permissions And Safety

- Native Task, automatic DAG, and swarm calls request `task` permission for each routed agent.
- Direct external processes request `delegation`; configured unsafe provider flags require separate `delegation_unsafe` approval.
- Delegated worktree operations request `worktree` and edit permission before creating or merging changes.
- Translation paths outside the current worktree request `external_directory` plus read or edit permission.
- Automatic workflows are owned by the starting session and exact directory/worktree context.
- Guarded publication requires the completed workflow's root session, immutable preview digest, effective one-shot `ask` authority, and a separate external-side-effect approval.
- Bounded autonomy removes child permission prompts but does not grant denied authority; blocked is an expected safe outcome.
- Swarm sessions share their configured working directory; use only independent tasks unless worktrees are managed separately.
- Delegated merges require successful execution, a recorded passing review, the authorized feature branch, and a clean target worktree. Task changes are checkpointed in the isolated worktree and merged with a non-fast-forward merge. Failed merges are aborted, and normal cleanup retains dirty or unmerged worktrees.

Review permission requests before allowing them. The supplied `opencode.jsonc.template` asks or denies destructive Git and shell patterns, but project and agent configuration may add stricter rules.

## Documentation

- [Workflow System](./WORKFLOWS.md)
- [Autonomous Workflows](./docs/autonomous-workflows.md)
- [Validation And Fixed-Point Review](./docs/validation-and-fixed-point-review.md)
- [Guarded Publication](./docs/guarded-publication.md)
- [Agent Reference](./docs/agents.md)
- [Coding Conventions](./docs/conventions.md)
- [Model Compatibility](./docs/model-compatibility.md)
- [Review System](./docs/review-system.md)
- [Swarm Mode](./docs/swarm-mode.md)
- [Delegated Workflows](./docs/delegated-workflows.md)
- [External CLI Delegation](./docs/external-cli-delegation.md)
- [E2E Testing](./docs/e2e-testing.md)

## License

MIT
