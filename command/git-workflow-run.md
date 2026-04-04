---
description: Actions ops: /git-workflow-run [list|run|view|watch|logs]
agent: build
---

Manage GitHub Actions using `gh workflow` and `gh run`.

## Arguments

$ARGUMENTS

Format: `[list|run|view|watch|logs] [args...]`

- `list`
- `run <workflow> [--ref <branch>]`
- `view [run_id]`
- `watch <run_id>`
- `logs <run_id>`

Default action: `list`.

## Instructions

1. Validate prerequisites:
   - `gh --version`
   - `gh auth status`
2. Parse action.

### list
- Run `gh workflow list` and return concise table.

### run
1. Verify workflow exists (`gh workflow list`, `gh workflow view <workflow>`).
2. Trigger: `gh workflow run <workflow> [--ref <branch>]`.
3. Fetch latest run for that workflow:
   - `gh run list --workflow <workflow> --limit 1 --json databaseId,status,conclusion,url`
4. Return run details and suggest `/git-workflow-run watch <run_id>`.

### view
- Without run_id: `gh run list --limit 5`
- With run_id: `gh run view <run_id>`

### watch
- Run `gh run watch <run_id>`.

### logs
- Run `gh run view <run_id> --log-failed` first; if insufficient, use `--log`.

## Important

- For long-running watch commands, stream and report completion state.
- If workflow or run is missing, show available options in the error message.
