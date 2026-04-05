---
description: Commit staged changes: /git-commit [context]
agent: build
---

Create a git commit for currently staged changes using Conventional Commits.

## Arguments

$ARGUMENTS

If arguments are provided, treat them as additional context for commit message wording.

## Instructions

1. Run `git status --short` and `git diff --staged`.
2. If nothing is staged, stop and tell the user to stage files first.
3. Infer commit type/scope from staged diff only.
4. Create a concise conventional commit message:
   - `<type>(<scope>): <description>`
   - Use scope only when obvious
   - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `style`
5. Run `git commit -m "<message>"`.
6. Report success/failure and resulting commit SHA.

## Important

- Do not push.
- Do not change file contents.
- Do not add AI attribution.
