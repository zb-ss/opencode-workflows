---
description: Checkout PR: /git-pr-checkout <pr_number|url|branch>
agent: build
---

Checkout a pull request branch locally for review/testing.

## Arguments

$ARGUMENTS

Format: `<pr_number|url|branch>`

## Instructions

1. Verify prerequisites:
   - `gh --version`
   - `gh auth status`
2. Check working tree:
   - `git status --porcelain`
3. If working tree is dirty, stash automatically with:
   - `git stash push -m "opencode: auto-stash before gh pr checkout"`
   - Mention stash in final output.
4. Resolve PR number from argument:
   - If numeric: use directly.
   - If URL: parse PR number.
   - If branch: resolve via `gh pr list --head <branch> --json number,title,url`.
5. Run `gh pr checkout <pr_number>`.
6. Show concise PR details:
   - `gh pr view <pr_number> --json number,title,author,state,reviewDecision,url`
7. Report success and suggest next commands:
   - `gh pr diff <pr_number>`
   - `gh pr checks <pr_number>`

## Important

- Do not drop user local changes; stash before checkout when needed.
- If PR cannot be resolved, clearly report the reason.
