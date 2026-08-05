# Delegated Workflows

A delegated workflow combines the manual supervisor, native OpenCode review agents, external Claude Code or Antigravity CLI processes, and managed Git worktrees. It is distinct from direct `/delegate` prompts and from SDK-backed swarm sessions.

## Entry Point

```text
/workflow delegate Implement a modular change in isolated worktrees
```

The supervisor follows the manual workflow lifecycle and uses delegation tools for plan decomposition, process execution, result collection, review, merge, and cleanup. Gate state is still updated through the manual workflow enforcer.

## Pipeline

1. A native `wf-architect` Task produces a plan.
2. `delegation_decompose` parses task boundaries and routes each task.
3. `delegation_init_files` can create provider context files when approved and missing.
4. `delegation_execute_batch` queues provider CLI processes in isolated worktrees.
5. `delegation_await_batch` waits for queued and running processes.
6. `delegation_collect_results` returns output, changed files, and diff summaries.
7. Native `wf-reviewer-deep` Tasks review each task result.
8. The supervisor records each verdict with `delegation_record_review`; failed tasks can be rerun in a new worktree with `delegation_redelegate`.
9. Only successfully executed tasks with a recorded passing review are checkpointed and merged with `delegation_merge_task`.
10. `delegation_cleanup` removes only safely removable worktrees.
11. Manual quality and completion gates run on the combined result.

The supervisor must persist native Task IDs for the planner and reviewers. Re-review should resume the same reviewer with its saved `task_id`; an external re-delegation attempt is a separate CLI process and worktree.

## Routing

The orchestrator supports `claude` and `gemini` routing tokens. The `gemini` token executes Antigravity CLI (`agy`), not Gemini CLI. Routing is configured in `workflows.json`:

```json
{
  "delegation": {
    "claude": {},
    "gemini": {},
    "fallback_order": [],
    "routing": {
      "ui_patterns": [],
      "default_provider": "claude"
    },
    "auto_init_files": false
  }
}
```

No external CLI model is pinned in `workflows.json`. A task explicitly tagged `code` routes to Claude; `ui` routes to Antigravity. Otherwise, configured UI word patterns route to Antigravity and unmatched tasks use `default_provider`. With an empty pattern list, descriptions do not route to Antigravity automatically.

Both CLIs use their current default model unless an execution task supplies an optional provider-native `model` alias. This keeps version-sensitive aliases out of repository defaults and persistent workflow configuration.

## Permissions

Before a batch starts, the orchestrator requests:

- `edit` for delegated changes
- `worktree` for managed worktree operations
- `delegation` for each external provider
- `delegation_unsafe` when a configured unsafe provider mode would be used

Unsafe flags are removed unless the matching unsafe permission was explicitly granted. Antigravity worktree tasks use its non-interactive `accept-edits` mode after the batch's edit and delegation permissions are approved; `dangerously-skip-permissions` still requires the separate unsafe approval. Provider CLIs run with `shell: false` and with their working directory set to the managed worktree.

The init-file tool separately requests Task and edit permission. It never overwrites an existing provider context file. Review generated context before allowing it in a public repository; repository-specific private assistant notes should remain outside public version control.

## Worktree Safety

Each initial task receives:

```text
<config-dir>/workflows/runtime/worktrees/<project-hash>/delegate-<identity-hash>
delegate/<workflow-id>/<task-id>
```

Task and workflow identifiers are validated as safe slugs. The project path must be the Git worktree root, worktree paths must remain inside the managed directory, and branch names are validated by Git.

### Merge

`delegation_merge_task` performs these checks:

1. The task process is complete and its managed worktree exists.
2. The requested target branch is a valid local branch checked out in the target worktree.
3. The target worktree is clean. Managed worktrees live outside the repository and require no cleanliness exception.
4. All task edits, including untracked files, are checkpointed in the task worktree.
5. The delegation branch tip matches the clean task worktree HEAD.
6. External execution succeeded without timeout or cancellation.
7. The owning supervisor recorded a passing review.
8. The target is the batch's authorized feature branch.
9. The branch contains changes to merge.
10. The target remains clean immediately before merge.

The merge uses `--no-ff`. On conflict, the manager reports unmerged paths and attempts `git merge --abort`. It does not leave an intentional partial merge.

Checkpoint commits use a local synthetic identity, disable signing, and skip hooks inside the isolated task worktree. This ensures the merge operates on a complete snapshot; it is not a substitute for review or target-branch checks.

Privileged Git operations pin a root-owned executable whose full parent path is not group/world-writable and reject executables inside the startup worktree. When the startup `PATH` cannot provide that boundary, set `OPENCODE_WORKFLOWS_GIT_EXECUTABLE` to an operator-selected absolute system Git path before starting OpenCode.

### Cleanup

Normal cleanup is a one-shot operation scoped to one exact session-owned batch. It removes a worktree only when it is clean and its exact delegation branch tip appears in a merge commit on the current target history. It retains dirty, unmerged, mismatched, or unverified worktrees for manual recovery, then releases the in-memory batch so stale paths cannot claim later worktrees. Cleanup also refuses to run while that batch still has queued or running tasks, or when the current session no longer owns the batch after restart.

Re-delegation creates a uniquely suffixed worktree and preserves prior attempts for inspection.

## Persistence Boundary

The manual workflow state and Git worktrees persist. The orchestrator's active process batches are held in plugin memory. Restarting OpenCode does not reconstruct an in-flight delegation batch, so inspect preserved worktrees and manual state before deciding whether to rerun, review, merge, or clean up.

This differs from swarm batch persistence and automatic DAG reconciliation.

## Configuration

Supported delegation settings include:

- Per-provider CLI timeout and permission mode
- Process concurrency
- Combined stdout/stderr cap through `max_output_bytes`
- UI routing patterns and default provider
- Provider fallback order for direct delegation
- Review iteration limit
- Init-file preference

Keep these values in `workflows.json`. Provider model aliases are request-scoped: pass one through `/delegate ask ... --model`, `delegate_run.model`, `exec-worktree --model`, or a delegated task's optional `model` field. Run `npm run validate:config` after editing the repository template or `node install.mjs --doctor` for an installed configuration.

## Direct Delegation

For a prompt that does not need worktrees, merge, or workflow gates, use `/delegate` instead:

```text
/delegate status --auth
/delegate ask auto Review the current diff
/delegate followup <run-id> Recheck the highest-risk finding
```

See [External CLI Delegation](./external-cli-delegation.md).

## Related Documentation

- [Workflow System](../WORKFLOWS.md#delegated-worktrees)
- [Review System](./review-system.md)
- [Swarm Mode](./swarm-mode.md)
