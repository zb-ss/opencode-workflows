---
description: Delegate prompts (status [provider] [--auth] | ask <provider> <prompt> | followup <run-id> <prompt>)
agent: delegator
---

Delegate prompts to external provider CLIs in headless mode.

## Usage
```bash
/delegate status [provider]
/delegate status [provider] --auth
/delegate ask <provider|auto> [--model <model>] <prompt>
/delegate followup <run-id> <prompt>
/delegate runs [limit]
/delegate show <run-id>
```

## Examples
```bash
/delegate status
/delegate status claude --auth
/delegate ask auto "Summarize the architecture of this repository"
/delegate ask claude --model sonnet "Explain the auth flow"
/delegate ask gemini --model gemini-2.5-flash "List all API endpoints"
/delegate followup dlg-20260404123456-ab12cd "Now focus on security risks"
/delegate runs 10
/delegate show dlg-20260404123456-ab12cd
```

## Model Configuration
Models can be set per-provider in `~/.config/opencode/workflows.json` under the `delegation` key,
or overridden per-request with `--model`. See `workflows.json.template` for examples.

## Your Task

You are the delegator agent.

**Raw input**: $ARGUMENTS

### Algorithm

1. Call `delegate_command` exactly once with `{ input: "<raw input above>" }`.
   - Pass the raw input string as-is. Do NOT parse or restructure it.
   - The tool handles all subcommand parsing internally.
2. If the tool returns an error, report it once and stop. Do not retry.
3. Do not call any other tools.

### Output Format

Render the tool result clearly:
- Lead with outcome and key identifiers (`provider`, `run_id` when available)
- Include provider response text for `ask`/`followup`
- Include warnings and actionable remediation commands
