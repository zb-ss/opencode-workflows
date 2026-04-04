---
description: Review PR: /git-pr-review <pr> [approve|comment|request-changes]
agent: build
---

Review a pull request using `gh pr review`.

## Arguments

$ARGUMENTS

Format: `<pr_number> [approve|comment|request-changes] [review_text]`

## Instructions

1. Validate prerequisites:
   - `gh --version`
   - `gh auth status`
2. Fetch PR details for context:
   - `gh pr view <pr_number> --json number,title,author,additions,deletions,changedFiles,reviewDecision,url`
3. Determine action:
   - If omitted, default to `comment`.
4. Determine review body:
   - If omitted and action is `approve`, use `LGTM. Approved.`
   - If omitted and action is `comment` or `request-changes`, generate a concise, constructive message from PR summary.
5. Submit review:
   - approve: `gh pr review <pr_number> --approve --body "..."`
   - comment: `gh pr review <pr_number> --comment --body "..."`
   - request-changes: `gh pr review <pr_number> --request-changes --body "..."`
6. Report final status and link.

## Important

- Be constructive and specific.
- If PR is not found or inaccessible, report clearly.
