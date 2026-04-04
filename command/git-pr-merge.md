---
description: Merge PR: /git-pr-merge <pr> [--squash|--rebase|--merge]
agent: build
---

Merge a pull request with merge strategy controls.

## Arguments

$ARGUMENTS

Format: `<pr_number> [--squash|--rebase|--merge] [--delete-branch]`

## Instructions

1. Validate prerequisites:
   - `gh --version`
   - `gh auth status`
2. Inspect PR merge state:
   - `gh pr view <pr_number> --json number,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url,title`
3. If not mergeable or checks/reviews are blocking, stop and report blocker.
4. Determine strategy:
   - Default `--merge` unless one explicit flag is provided.
5. Merge:
   - `gh pr merge <pr_number> <strategy> [--delete-branch]`
6. Report result with PR URL and mention branch deletion status.

## Important

- Do not force-merge around failed checks.
- Use exactly one merge strategy flag.
