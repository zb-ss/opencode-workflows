# Agent Reference

The installer places primary agents in `<config-dir>/agents/<name>.md` and workflow specialists in `<config-dir>/agents/wf-<name>.md`. The optional translation module installs its specialists without the `wf-` prefix.

Agent frontmatter is the source of truth for permissions, mode, model inheritance, and temperature. OpenCode must be restarted after an installed agent file changes.

## Primary Agents

| Agent | Purpose |
|---|---|
| `supervisor` | Coordinates manual workflows, state, gates, native Tasks, swarm tools, and delegated workflow tools without implementing project code itself |
| `delegator` | Sends explicit prompts to supported external provider CLIs through delegation tools |
| `editor` | Applies carefully scoped code changes with per-operation approval |
| `focused-build` | Implements focused changes without generating unrelated artifacts |
| `debug` | Reproduces defects and investigates root causes |
| `org-planner` | Writes structured development plans as org files |
| `step-planner` | Develops a plan interactively through focused questions |
| `discussion` | Provides read-only technical exploration and discussion |
| `web-tester` | Exercises web applications with available browser tools |
| `figma-builder` | Implements frontend work from Figma design data when the required integration is configured |

Use a primary agent directly when the task fits its role. `/workflow`, `/workflow-auto`, `/delegate`, and `/plan` select their configured primary agent automatically.

## Workflow Specialists

| Installed subagent type | Purpose |
|---|---|
| `wf-architect` | Deep planning and architecture analysis |
| `wf-architect-lite` | Focused planning for smaller changes |
| `wf-executor` | Standard implementation from an explicit plan or task |
| `wf-executor-lite` | Focused implementation for smaller tasks |
| `wf-reviewer` | Standard code review with actionable findings |
| `wf-reviewer-lite` | Focused review for smaller changes |
| `wf-reviewer-deep` | Broad review of functional, architectural, and maintainability risks |
| `wf-security` | Standard security review |
| `wf-security-lite` | Focused scan for common security defects |
| `wf-security-deep` | Broader security analysis and threat review |
| `wf-test-writer` | Adds tests using project conventions and runs them only when the execution profile authorizes it |
| `wf-quality-gate` | Assesses available build, type, lint, test, and security evidence without claiming checks it could not execute |
| `wf-completion-guard` | Checks that requested work and mandatory verification are complete |
| `wf-codebase-analyzer` | Extracts repository structure, conventions, and dependencies |
| `wf-perf-reviewer` | Reviews performance risks and evidence |
| `wf-perf-lite` | Checks for obvious performance regressions |
| `wf-doc-writer` | Updates user or developer documentation for a change |
| `wf-explorer` | Performs fast read-only repository exploration |
| `wf-e2e-explorer` | Maps a requested live browser flow and its boundaries |
| `wf-e2e-generator` | Creates focused Playwright coverage from observed behavior |
| `wf-e2e-reviewer` | Runs and reviews E2E tests for false positives and flakiness |

Mode files map abstract roles such as `implementation`, `code_review`, and `e2e_validation` to these names. Call them through OpenCode's native Task tool with the complete installed `subagent_type`; do not rely on an `@agent` mention for workflow orchestration.

## Native Task IDs

A new native Task call returns a Task ID. Manual workflows persist that value under `task_ids` so the same subagent session can be continued:

```json
{
  "description": "Continue the review correction",
  "prompt": "Verify the recorded issues after the implementation update.",
  "subagent_type": "wf-reviewer",
  "task_id": "<saved-task-id>"
}
```

The Task ID is not interchangeable across agent types. Swarm and automatic DAG sessions are managed by their plugins and should not be resumed through the manual `task_ids` map.

## Translation Specialists

The optional translation module installs:

| Agent | Purpose |
|---|---|
| `translation-planner` | Scans Joomla components and prepares localization work |
| `translation-coder` | Converts hardcoded view strings and updates language files |
| `translation-reviewer` | Verifies completeness, locale quality, placeholders, and syntax |

Translation work is session-owned and view-by-view. Use the translation workflow tools to obtain the exact target view and update its state rather than processing an arbitrary file.

## Models And Permissions

Installed agents inherit OpenCode's runtime model configuration by default. `node install.mjs --materialize-models` is the explicit alternative. See [Model Compatibility](./model-compatibility.md).

Per-agent frontmatter can be stricter than global OpenCode permissions. In particular:

- The supervisor denies direct project implementation and allows only configured workflow or translation subagents.
- Review and exploration agents may be read-only.
- Implementation and test agents request the filesystem and command access needed by their role.
- External CLI and worktree actions use separate plugin permission requests.

OpenCode permission decisions remain authoritative; selecting an agent does not bypass them.

### Automatic Child Sessions

`automation.autonomy: interactive` retains a routed agent's effective permissions. `automation.autonomy: bounded` first requires the root agent's routed Task permissions to resolve silently, then builds each child policy over a wildcard deny. Plugin-owned filtered-list, exact-file read, direct-write, and todo tools can be re-enabled from explicit routed-agent rules; built-in discovery, reading, editing, shell, and executable validation remain denied. Explicit path denies remain denies. Grep, LSP, network fetch, external-directory access, global skills, questions, nested Task calls, unsafe delegation, and every unreviewed runtime tool are blocked. Listing and reads filter sensitive/control paths and unknown file types; writes reject listed host-executed controls. The chosen profile is persisted when a workflow starts and remains fixed through resume and restart.

Specialists in a bounded stage must return `blocked` when required authority or executable evidence is unavailable. Blocker text is untrusted status output and must not request secret values, commands, links, permission bypasses, or weaker safeguards. Executable validation requires an attended interactive workflow; bounded mode has no general shell and is not an OS sandbox. See [Autonomous Workflows](./autonomous-workflows.md).

## Related Documentation

- [Workflow System](../WORKFLOWS.md)
- [Autonomous Workflows](./autonomous-workflows.md)
- [Coding Conventions](./conventions.md)
- [Review System](./review-system.md)
- [Validation And Fixed-Point Review](./validation-and-fixed-point-review.md)
- [E2E Testing](./e2e-testing.md)
