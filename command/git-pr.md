---
description: Create PR: /git-pr <head_branch> [base_branch]
agent: build
---

Create a GitHub pull request using `gh`.

## Arguments

$ARGUMENTS

Format: `<head_branch> [base_branch]`

- `head_branch` required
- `base_branch` optional (default to `main`, fallback to `master`)

## Instructions

1. Verify prerequisites:
   - `gh --version`
   - `gh auth status`
2. Verify branch existence:
   - `git branch --list <head_branch>`
   - `git branch --list <base_branch>` (when provided)
3. Determine base branch when not provided:
   - Prefer `main`, fallback `master`.
4. Check commits to merge:
   - `git log <base_branch>..<head_branch> --oneline`
   - If none, report and stop.
5. Generate PR title/body from commit history and diff summary.
6. Create PR:
   - `gh pr create --base <base_branch> --head <head_branch> --title "..." --body "..."`
7. Return PR URL.

## Body format

Use this structure:

```markdown
## Summary
- ...

## Changes
- ...

## Testing
- [ ] Tested locally
- [ ] Relevant tests pass
```

## Important

- Keep wording professional and code-focused.
- No AI attribution.
- If PR already exists, return the existing URL instead of creating a duplicate.
