---
description: Create a pull request using gh CLI
agent: build
model: google/gemini-3-flash-preview

---

# Create Pull Request

Create a pull request using the GitHub CLI (`gh`).

## Arguments

$ARGUMENTS

**Format:** `<head_branch> [base_branch]`

- `head_branch` - Branch containing your changes (required)
- `base_branch` - Branch to merge into (optional, defaults to main/master)

## Examples

```
/pr feature/user-auth
/pr feature/user-auth develop
/pr fix/login-bug main
```

## Current Git Status

!`git status -s`

## Recent Commits on Current Branch

!`git log --oneline -10`

## Instructions

1. **Verify branches exist:**
   ```bash
   git branch --list <head_branch>
   git branch --list <base_branch>
   ```

2. **Check if head branch has commits ahead of base:**
   ```bash
   git log <base_branch>..<head_branch> --oneline
   ```

3. **Generate PR title and description:**
   - Analyze commits between base and head
   - Create concise title from the changes
   - Write description summarizing:
     - What changed
     - Why it changed
     - Any testing done

4. **Create the PR:**
   ```bash
   gh pr create --base <base_branch> --head <head_branch> --title "<title>" --body "<description>"
   ```

5. **Report the PR URL** to the user

## PR Description Format

```markdown
## Summary

Brief description of what this PR does.

## Changes

- Change 1
- Change 2
- Change 3

## Testing

- [ ] Tested locally
- [ ] Unit tests pass
- [ ] Manual testing completed
```

## Important

- Do NOT add any AI/LLM attribution or co-author lines
- Do NOT mention Claude, Anthropic, or any AI tool
- Keep the description professional and focused on the code changes
- If the PR already exists, report the existing PR URL instead

## Error Handling

- If `gh` is not installed: "Error: GitHub CLI (gh) is required. Install from https://cli.github.com"
- If not authenticated: "Error: Run 'gh auth login' first"
- If branch doesn't exist: "Error: Branch '<branch>' not found"
- If no commits to merge: "Error: No commits between <base> and <head>"
