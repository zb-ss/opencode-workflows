# External CLI Delegation

Use OpenCode Workflows to delegate prompts to official provider CLIs in headless mode.

Supported providers:
- Claude Code CLI (`claude`)
- Gemini CLI (`gemini`)

## Why this exists

- Keep provider-native auth and usage boundaries
- Reuse existing subscriptions/credentials through official CLIs
- Integrate delegated outputs into workflow sessions with traceability

## Command

```bash
/delegate status [provider]
/delegate status [provider] --auth
/delegate ask <provider|auto> <prompt>
/delegate followup <run-id> <prompt>
/delegate runs [limit]
/delegate show <run-id>
```

## Typical flow

1. Validate setup:

```bash
/delegate status
# Full auth probe (may be slower depending on provider CLI behavior)
/delegate status --auth
```

2. Ask a provider (or auto fallback):

```bash
/delegate ask auto "Summarize architecture and security risks"
```

3. Continue from prior output:

```bash
/delegate followup <run-id> "Focus only on high-severity risks"
```

4. Inspect recent runs:

```bash
/delegate runs 10
/delegate show <run-id>
```

## Readiness and warnings

Delegation tools are warning-first by default:
- Missing binary -> warning with install guidance
- Auth appears missing -> warning with interactive login guidance
- Unknown auth state -> warning to verify manually
- Timeout/command failure -> structured error in run output

Workflows should not crash solely because delegation is unavailable.

## Follow-up behavior

`/delegate followup` attempts provider-native resume when a resume token is available from previous run metadata.

If no token is available, it falls back to stateless follow-up by prepending prior context. The fallback is explicitly reported in warnings.

## Security notes

- Commands are spawned without shell interpolation (`shell: false`).
- Run metadata is stored locally under:
  - `~/.config/opencode/workflows/context/delegation/runs/*.json`
- Prompts and responses are truncated for storage safety.

## Caveats

- CLI flags can vary across provider versions; keep CLIs up to date.
- First-time OAuth login may require opening a browser.
- For CI/non-interactive environments, use provider-supported API key or enterprise auth modes.
