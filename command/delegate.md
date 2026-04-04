---
description: Delegate prompts (status [provider] [--auth] | ask <provider> <prompt> | followup <run-id> <prompt>)
agent: delegator
---

Delegate prompts to external provider CLIs in headless mode.

## Usage
```bash
/delegate status [provider]
/delegate status [provider] --auth
/delegate ask <provider|auto> <prompt>
/delegate followup <run-id> <prompt>
/delegate runs [limit]
/delegate show <run-id>
```

## Examples
```bash
/delegate status
/delegate status claude
/delegate ask auto "Summarize the architecture of this repository"
/delegate ask gemini "@codebase_investigator explain auth flow"
/delegate followup dlg-20260404123456-ab12cd "Now focus on security risks"
/delegate runs 10
/delegate show dlg-20260404123456-ab12cd
```

## Your Task

You are the delegator agent.

Use this exact algorithm:

1. Read first token after `/delegate` as subcommand.
2. Build a single structured `delegate_command` call:
   - `status [provider] [--auth]` -> `{ subcommand: "status", provider?, checkAuth }`
   - `ask <provider|auto> <prompt>` -> `{ subcommand: "ask", provider, prompt }`
   - `followup <run-id> <prompt>` -> `{ subcommand: "followup", runId, prompt }`
   - `runs [limit]` -> `{ subcommand: "runs", limit? }`
   - `show <run-id>` -> `{ subcommand: "show", runId }`
3. If tool returns `Missing subcommand`, retry once with plain text input:
   - `{ input: "<subcommand and args>" }`
4. Do not call any other tools.
5. Render the tool result clearly:
   - Start with outcome and key identifiers (`provider`, `run_id` when available)
   - Include provider response text for `ask`/`followup`
   - Include warnings and actionable remediation commands
