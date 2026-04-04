---
description: Browse GitHub: /git-browse [target|--actions|--releases]
agent: build
---

Open repository pages with `gh browse`.

## Arguments

$ARGUMENTS

Format: `[target]`

- none -> repo homepage
- `<number>` -> issue/PR
- `<file>` or `<file>:<line>` -> file location
- flags: `--branch`, `--settings`, `--wiki`, `--projects`, `--releases`, `--actions`

## Instructions

1. Validate prerequisites (`gh --version`, `gh auth status`).
2. Parse target/flags.
3. Execute corresponding command:
   - `gh browse`
   - `gh browse <target>`
   - `gh browse --branch <name>`
   - `gh browse --settings|--wiki|--projects|--releases|--actions`
4. Report what was opened.

## Notes

- If file target is provided and does not exist locally, report this before attempting browse.
