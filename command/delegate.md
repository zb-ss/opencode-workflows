---
description: Delegate prompts (status [provider] [--auth] | ask <provider> [--model <alias>] <prompt> | followup <run-id> <prompt>)
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
/delegate ask claude --model <claude-model-alias> "Explain the auth flow"
/delegate ask gemini "List all API endpoints with Antigravity"
/delegate ask gemini --model <agy-model-alias> "Review the current UI"
/delegate followup dlg-20260404123456-ab12cd "Now focus on security risks"
/delegate runs 10
/delegate show dlg-20260404123456-ab12cd
```

## Model Selection
Delegation uses each CLI's current default model. To select a model manually for one run, pass the provider-native alias with `--model`. For Antigravity aliases, run `agy models`. Do not add model pins to `workflows.json`.

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
