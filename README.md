# OpenCode Workflows

OpenCode Workflows installs agents, commands, skills, plugins, workflow definitions, schemas, and supporting libraries into an [OpenCode](https://opencode.ai) configuration directory. It supports manual gate-driven workflows, opt-in declarative workflow automation, native OpenCode subagents, SDK-backed swarm batches, and direct Claude or Gemini CLI delegation.

These are separate execution paths. Installing the project does not enable unattended workflow automation or external CLI execution by default.

## Requirements

- OpenCode 1.17.20 or newer
- Node.js 18 or newer
- Git for bootstrap installation and delegated worktrees
- Optional: authenticated `claude` or `gemini` executables for external CLI delegation
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

## Installer Commands

```bash
node install.mjs                         # Install core in copy mode
node install.mjs --symlink               # Symlink unchanged files for development
node install.mjs --all                   # Install core and translation module
node install.mjs --module translate      # Add translation to the core install
node install.mjs --materialize-models    # Bake configured model candidates into frontmatter
node install.mjs --doctor                # Check version, schema, manifest, ownership, and capabilities
node install.mjs --migrate               # Normalize legacy workflows.json data
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
| Native subagent | OpenCode Task tool | Calling agent | OpenCode task/session ID | One agent task, resumed with the same `task_id` |
| Swarm batch | `swarm_*` tools | SDK session runtime | Session-scoped batch state | Parallel independent OpenCode subagent sessions |
| Direct external delegation | `/delegate` or `delegate_*` tools | Provider CLI process | Session-scoped run records and output logs | One-off Claude or Gemini CLI prompts and follow-ups |
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

```text
/workflow-auto development Implement the requested change --mode=standard
/workflow-auto e2e Verify the checkout flow --mode=thorough
/workflow-auto-resume
```

Before enabling automation, configure every required budget in `workflows.json`: child sessions, parallel sessions, attempts per stage, wall time, input tokens, output tokens, and cost. `max_cost_usd` may be `null`; the field is still required.

The engine validates a fixed JSON schema, rejects dependency cycles and unsupported fields, routes stage roles through the selected mode, and accepts only structured stage results. It does not generate or execute arbitrary workflow code. Stage agents can edit the project only through their own OpenCode permissions, and session- or process-spawning tools are blocked so every child session remains budgeted and cancellable.

State is written atomically below the selected config directory. After a plugin or OpenCode restart, saved workflows are restored without launching new stages. `/workflow-auto-resume` explicitly reauthorizes agents, reconciles child sessions, refreshes budgets, and resumes scheduling. Runtime tools also expose status, capability reporting, and cancellation for the workflow owned by the current session.

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
- Swarm sessions share their configured working directory; use only independent tasks unless worktrees are managed separately.
- Delegated merges require successful execution, a recorded passing review, the authorized feature branch, and a clean target worktree. Task changes are checkpointed in the isolated worktree and merged with a non-fast-forward merge. Failed merges are aborted, and normal cleanup retains dirty or unmerged worktrees.

Review permission requests before allowing them. The supplied `opencode.jsonc.template` asks or denies destructive Git and shell patterns, but project and agent configuration may add stricter rules.

## Documentation

- [Workflow System](./WORKFLOWS.md)
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
