---
description: Create release: /git-release <version> [--draft|--prerelease]
agent: build
---

Create a release tag + GitHub release notes via `gh release`.

## Arguments

$ARGUMENTS

Format: `<version> [--draft] [--prerelease] [--target <branch>]`

## Instructions

1. Validate prerequisites:
   - `gh --version`
   - `gh auth status`
   - `git fetch --tags`
2. Validate version/tag:
   - If missing `v` prefix, keep user input as-is (do not rewrite silently).
   - Check for existing tag: `git tag -l "<version>"`
   - Check for existing release: `gh release view <version>`
   - If exists, stop.
3. Find previous tag:
   - `git describe --tags --abbrev=0` (best effort)
4. Collect commits since previous tag (or recent history when none):
   - `git log <previous_tag>..HEAD --pretty=format:"%h %s" --no-merges`
5. Group entries into sections: Features, Bug Fixes, Performance, Docs, Refactor, Other.
6. Build markdown notes with compare link when previous tag exists.
7. Create release:
   - `gh release create <version> --title "<version>" --notes "<notes>" [flags]`
8. Return release URL.

## Important

- Keep changelog concise and scannable.
- Highlight breaking changes if detected (`!:` or `BREAKING CHANGE`).
