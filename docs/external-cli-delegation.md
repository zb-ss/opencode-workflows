# External CLI Delegation

External CLI delegation runs an installed `claude` or `gemini` executable in headless mode. It does not use OpenCode's native Task tool and does not create a worktree unless the explicit worktree command or delegated workflow tools are used.

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

An unknown authentication state is a warning, not proof of readiness. Complete any interactive provider login outside the headless run.

## Provider Selection

`auto` uses `delegation.default_provider` when configured, then the configured fallback order. If no order is configured, the direct runner uses its supported providers in its built-in order. An explicit provider can disable fallback through the direct tool.

Per-provider model values are CLI aliases, not OpenCode provider/model IDs:

```json
{
  "delegation": {
    "claude": {},
    "gemini": {},
    "fallback_order": []
  }
}
```

Omitting a model lets the provider CLI choose its default. A request-level `--model` overrides the configured alias for that run.

## Invocation And Permissions

Processes are spawned as argument arrays with `shell: false` in the current authorized directory. Claude prompts use a `--` separator. Gemini receives the prompt through its prompt option. Timeouts and OpenCode abort signals terminate the child process.

Every external run requests `delegation` permission. A configured Claude skip-permission mode or Gemini auto-approval mode requires a separate `delegation_unsafe` decision. Unsupported permission-mode strings are ignored with a warning.

Do not treat worktree isolation as a replacement for provider permission controls. Direct `/delegate ask` runs in the current directory and can modify it if the external CLI and its approved mode permit edits.

## Run Records

Runs are scoped to the current OpenCode session and stored below:

```text
<config-dir>/workflows/runtime/sessions/<session-hash>/external-cli-delegation/
```

The private run record contains provider attempts, status, timing, a prompt hash and bounded preview, response data, warnings, output file references, and a resume token when available. Private per-attempt stdout and stderr files are capped by `delegation.max_output_bytes`; bounded copies are returned in tool output. Public tool responses omit resume tokens, raw provider JSON, executable paths, and private output paths.

Run IDs from another current session are not readable. Importing a legacy run record requires an explicit legacy delegation permission.

## Follow-Up

Claude follow-up uses provider-native resume when the prior successful run contains a safe resume token and native resume is preferred. Gemini has no session-based resume in this integration.

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
