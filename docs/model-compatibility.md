# Model Compatibility

OpenCode Workflows does not ship a provider/model matrix. OpenCode's merged runtime configuration is authoritative, and the workflow template leaves model candidate arrays empty until the user configures them.

## Runtime Inheritance

Runtime inheritance is the default install strategy:

```bash
node install.mjs
```

The installer removes repository-only `model_tier` metadata from installed agents and commands. With no concrete `model` in their frontmatter, OpenCode applies its normal merged `model`, `small_model`, and per-agent model settings.

This strategy is appropriate when models are selected centrally in OpenCode and should change without reinstalling workflow files.

## Materialized Models

Use materialization only when installed frontmatter must contain a concrete model:

```bash
node install.mjs --materialize-models
```

Candidates are resolved in this order:

1. `agent_models[agent]`
2. `model_tiers[tier]`
3. `fallback_order`

A candidate may be a provider/model string or an object:

```json
{
  "model": "provider/model-id",
  "variant": "variant-name"
}
```

`agent_variants[agent]` supplies a variant only when the selected candidate does not already have one. The installer writes the first syntactically valid configured candidate. If none exists, it leaves model selection inherited and warns.

Materialization is an installation-time choice. Change `workflows.json`, rerun the installer, and restart OpenCode to update materialized frontmatter.

## Automatic Workflow Candidates

Automatic DAG stages declare a logical `model_tier`. The engine combines that tier with any per-agent override and fallback order. On repeated stage attempts it rotates through the resulting candidate list; when no candidate is configured, it omits the model and lets OpenCode inherit one.

The automatic engine's configured candidate list is separate from manual Task resumption. Resuming a native Task continues the existing OpenCode task and does not rematerialize its model.

## Discovery And Validation

The repository validates model IDs by shape: a provider segment, `/`, and a non-empty model segment. Variant names use a restricted identifier format. JSON schema validation and installer `--doctor` do not assume a specific provider or probe credentials.

Runtime catalog helpers query OpenCode's live `config.providers` response. They can:

- Build the set of currently exposed provider/model IDs
- Exclude disabled variants
- Report model or variant unavailability
- Read advertised context limits without inferring them from model names

This avoids hardcoded provider inventories and version-sensitive model capability tables. Configure only IDs and variants exposed by the OpenCode installation you are running.

## Configuration Shape

```json
{
  "model_tiers": {
    "low": [],
    "mid": [],
    "high": []
  },
  "agent_models": {},
  "agent_variants": {},
  "fallback_order": [],
  "default_mode": "standard"
}
```

Candidate order is significant. Duplicate model and variant pairs are removed while preserving the first occurrence.

## External CLI Models

External delegation never pins a model in `workflows.json`. Claude Code and Antigravity CLI use their current defaults unless a caller explicitly supplies a provider-native alias for one run through `--model`, `delegate_run.model`, or a delegated task's optional `model` field. These aliases are not OpenCode provider/model IDs.

Use each installed CLI as the source of truth before selecting an alias. For Antigravity, run `agy models`. Keeping aliases request-scoped prevents repository defaults and persistent configuration from breaking when provider catalogs change.

## Checks

```bash
npm run validate:config
node install.mjs --doctor
```

`npm run validate:config` validates repository templates, modes, workflow definitions, and schemas. `--doctor` validates the installed workflow config and installation manifest. Provider authentication is checked separately with `/delegate status --auth`; manually selected aliases are validated by the provider CLI when a run starts.

## Related Documentation

- [Workflow System](../WORKFLOWS.md#model-selection)
- [External CLI Delegation](./external-cli-delegation.md)
