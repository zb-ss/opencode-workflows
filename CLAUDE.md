# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCode Workflows v2.0 is a multi-agent automation framework for [OpenCode](https://opencode.ai). It orchestrates development workflows (feature, bug-fix, refactor, figma, e2e, translate) through 30 specialized agents, 5 execution modes, and 4 enforcement plugins. Designed to be model-agnostic — works with any LLM provider.

## Installation & Development

```bash
node install.mjs                  # Install core module via symlinks
node install.mjs --copy           # Install via file copies
node install.mjs --all            # Core + translate module
node install.mjs --module translate
node install.mjs --dry-run        # Preview without changes
node install.mjs --uninstall      # Remove all installed files
```

Installs into `~/.config/opencode/` (agents, commands, skills, plugins, modes). Symlink mode means edits to source files take effect immediately. No build step required.

Plugin dependency: `@opencode-ai/sdk` (see `plugin/package.json`).

## Architecture

### Core Flow

```
User → /workflow <type> <description> [--mode=<mode>]
  → supervisor agent parses & loads mode config (mode/*.json)
  → loads org-mode template (templates/*.org)
  → creates .state.json sidecar (WorkflowState)
  → iterates gates: planning → implementation → review → testing → security → quality_gate → completion
  → each gate: spawn agent → wait → validate → update state → next gate
```

### Key Directories

| Directory | Contents | Format |
|-----------|----------|--------|
| `agent/primary/` | 9 primary agents (user-facing) | Markdown + YAML frontmatter |
| `agent/workflow/` | 21 workflow agents (subagents) | Markdown + YAML frontmatter |
| `command/` | 6 slash commands | Markdown + YAML frontmatter |
| `skill/` | 13 coding convention skills | Markdown with SKILL.md |
| `plugin/` | 4 enforcement plugins | TypeScript |
| `mode/` | 5 execution mode configs | JSON |
| `templates/` | 6 workflow org-mode templates | Org-mode |
| `lib/` | Shared utilities (state, types, model routing) | TypeScript |

### Agent File Format

Agents are markdown files with YAML frontmatter declaring `model_tier` (low/mid/high), `mode` (primary/subagent), `temperature`, `steps`, and `permission` rules. The markdown body contains agent instructions and prompt templates.

### Plugin System

Plugins (`plugin/*.ts`) use the `@opencode-ai/plugin` API and provide:
- **workflow-enforcer.ts**: Gate enforcement, session binding, completion guards, and **system prompt injection** — injects authoritative workflow ID/phase/paths into every agent's system prompt via `experimental.chat.system.transform`. Custom tools: `workflow_check_completion`, `workflow_update_gate`, `workflow_bind_session`, `workflow_get_state`
- **swarm-manager.ts**: Parallel execution with concurrency management. **Prepends workflow context** (ID, paths, phase) to every spawned agent's prompt so child sessions have correct metadata. Custom tools: `swarm_spawn_batch`, `swarm_await_batch`, `swarm_spawn_validation`, `swarm_collect_results`
- **model-router.ts**: Enforces mode-based tier constraints via `permission.ask` hook
- **file-validator.ts**: Pre-flight file validation

### State Management

Each workflow has two files in `~/.config/opencode/workflows/active/`:
- `<id>.org` — human-readable org-mode file (created by supervisor)
- `<id>.state.json` — machine-readable tracking (auto-created by `workflow_bind_session`)

The `.state.json` conforms to `WorkflowState` (defined in `lib/types.ts`). Gate lifecycle: `pending → in_progress → passed|failed|skipped`. The `workflow_bind_session` tool auto-creates the `.state.json` sidecar when given an `.org` path.

### Model Tier System

User configures `~/.config/opencode/workflows.json`. Resolution priority: `agent_models` per-agent override > `model_tiers` tier array > `fallback_order`. The installer reads this config and bakes the resolved `model:` into each installed agent file (replacing `model_tier:`). **Changing `workflows.json` requires re-running `node install.mjs`** to take effect. Note: active `agent_models` entries (without `_example_` prefix) always override tier defaults.

### Execution Modes

| Mode | Review Iterations | Parallel | Agent Routing |
|------|-------------------|----------|---------------|
| eco | 2 | No | *-lite variants |
| turbo | 3 | No | 3x architect validation |
| standard | 3 | No | Full agents (default) |
| thorough | 5 | No | *-deep variants |
| swarm | 3 | Yes | 4x executor, 3x architect |

### Zero-Tolerance Review

Reviewers report issues as `[ISSUE-N] [SEVERITY] description - file:line - fix`. VERDICT: PASS requires zero issues of any severity. Failed reviews trigger fix → re-review cycles up to the mode's max iterations, then auto-escalate.

## Conventions

- Types are centralized in `lib/types.ts` — all plugins and lib modules import from there
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`
- Agent names use kebab-case with `-lite` and `-deep` suffixes for tier variants
- Mode configs define `agent_routing` mapping gate names to agent names
- Templates use org-mode with `:PROPERTIES:` drawers for step metadata
- The installer manifest tracks installed files for clean uninstall
