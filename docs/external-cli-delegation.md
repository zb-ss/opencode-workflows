# External CLI Delegation

External CLI delegation runs an installed `claude` or Antigravity `agy` executable in headless mode. The public `gemini` provider token routes Gemini-model work to Antigravity; it does not invoke the enterprise-only Gemini CLI. This path does not use OpenCode's native Task tool and does not create a worktree unless the explicit worktree command or delegated workflow tools are used.

## Commands

```text
/delegate status [claude|gemini] [--auth]
/delegate ask <claude|gemini|auto> [--model <cli-alias>] <prompt>
/delegate followup <run-id> <prompt>
/delegate runs [limit]
/delegate show <run-id>
```

The `/delegate` command passes its raw input to `delegate_command`. The plugin also exposes direct tools:

- `delegate_preflight`
- `delegate_run`
- `delegate_followup`
- `delegate_get_run`
- `delegate_list_runs`

Use direct tools when another agent needs structured arguments and results.

## Readiness

`/delegate status` checks that selected binaries exist and can report a version. Add `--auth` to perform provider-specific authentication probes. The `delegate_preflight` tool checks authentication by default unless its caller disables that probe.

Install Antigravity CLI from its [official documentation](https://antigravity.google/docs/cli-overview), run `agy` once to authenticate, and use `agy models` to inspect aliases accepted by the installed version.

An unknown authentication state is a warning, not proof of readiness. Complete any interactive provider login outside the headless run.

## Provider Selection

`auto` uses `delegation.default_provider` when configured, then the configured fallback order. If no order is configured, the direct runner uses its supported providers in its built-in order. An explicit provider can disable fallback through the direct tool.

Provider configuration contains runtime controls, not model pins:

```json
{
  "delegation": {
    "claude": {},
    "gemini": {},
    "fallback_order": []
  }
}
```

Normal delegation omits `--model` and lets the provider CLI choose its current default. Manual request-level selection remains available through `/delegate ask ... --model`, `delegate_run.model`, `exec-worktree --model`, or a delegated batch task's optional `model` field. Values are provider-native aliases, not OpenCode provider/model IDs.

## Invocation And Permissions

Processes are spawned as argument arrays with `shell: false` in the current authorized directory. Claude prompts use a `--` separator. Antigravity receives the prompt through `agy --print`. Timeouts and OpenCode abort signals terminate the child process.

Every external run requests `delegation` permission. A configured `dangerously-skip-permissions` mode for Claude or Antigravity requires a separate `delegation_unsafe` decision. Unsupported permission-mode strings are ignored with a warning.

Do not treat worktree isolation as a replacement for provider permission controls. Direct `/delegate ask` preserves Antigravity's default execution mode. The explicit `exec-worktree` path uses `accept-edits` only inside its approved managed worktree.

## Run Records

Runs are scoped to the current OpenCode session and stored below:

```text
<config-dir>/workflows/runtime/sessions/<session-hash>/external-cli-delegation/
```

The private run record contains provider attempts, status, timing, a prompt hash and bounded preview, response data, warnings, output file references, and a resume token when available. Private per-attempt stdout and stderr files are capped by `delegation.max_output_bytes`; bounded copies are returned in tool output. Public tool responses omit resume tokens, raw provider JSON, executable paths, and private output paths.

Run IDs from another current session are not readable. Importing a legacy run record requires an explicit legacy delegation permission.

## Follow-Up

Claude follow-up uses provider-native resume when the prior successful run contains a safe resume token and native resume is preferred. Antigravity follow-up remains stateless in this integration.

When native resume is unavailable, the plugin creates a stateless prompt from a bounded prior prompt preview, a bounded prior response excerpt, and the new request. The result explicitly reports stateless fallback.

## Failure Results

Failures are classified rather than inferred as success from process exit alone. Categories include missing binary, timeout, authentication, rate limit, unavailable model, invalid request, unsupported flag, provider error, storage failure, and empty output.

Fallback stops at the first successful provider or after all allowed attempts fail. Each attempt remains in the run record.

## Worktree Command

The low-level `exec-worktree` delegate subcommand can create one managed worktree and execute a provider there. Full plan, review, checkpoint, merge, and cleanup behavior belongs to [Delegated Workflows](./delegated-workflows.md), which uses the delegation orchestrator rather than this one-off path.

## Related Documentation

- [Delegated Workflows](./delegated-workflows.md)
- [Model Compatibility](./model-compatibility.md)
- [Workflow System](../WORKFLOWS.md#external-cli-delegation)
