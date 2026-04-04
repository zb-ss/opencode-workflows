---
description: Issue ops: /git-issue [create|view|list|close] [args]
agent: build
---

Manage GitHub issues with `gh issue`.

## Arguments

$ARGUMENTS

Format: `[create|view|list|close] [args...]`

- `create [title]`
- `view <number>`
- `list`
- `close <number>`

Default action: `create`.

## Instructions

1. Validate prerequisites:
   - `gh --version`
   - `gh auth status`
2. Parse action from arguments.

### create
1. If title missing, infer from user context or use a concise placeholder and note it.
2. Generate a structured issue body (bug/feature/general template based on title/context).
3. Run:
   - `gh issue create --title "<title>" --body "<body>"`
4. Return issue URL.

### view
- Run `gh issue view <number> --comments` and summarize key details.

### list
- Run `gh issue list --state open --limit 20` and present concise list.

### close
- Run `gh issue close <number> --reason completed` and report result.

## Important

- Keep issue text actionable and concise.
- If permissions are missing, report exact next step (`gh auth login` or repo access).
