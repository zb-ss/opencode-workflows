# Model Compatibility

OpenCode Workflows is model-agnostic. Any LLM provider that supports tool use and can be configured as an MCP server will work. The tier system routes agents to cost-appropriate models — you choose which models fill each tier.

## Tested Providers

We aim to run these workflows reliably across major providers. The following have been tested and confirmed working:

| Provider | Tested Models | Notes |
|----------|---------------|-------|
| **Zhipu AI** | GLM-5 | Good balance of speed and capability |
| **MiniMax** | M2.5 | Strong reasoning, excellent long-context |
| **Google** | Gemini 3 Pro, Gemini 3 Flash | Large context windows, fast inference |
| **OpenAI** | GPT-5.2, GPT-5.3 Codex | Strong reasoning, higher cost |

New model versions from these providers (and others) should work without changes. If you encounter issues with a specific model, file an issue.

## Model Tier System

The tier system maps agents to cost/capability levels. You assign your preferred models to each tier:

### Low Tier (Cost-Effective)
Used for: Lightweight tasks, exploration, simple fixes

**Agents**: explorer, executor-lite, reviewer-lite, security-lite, perf-lite

### Mid Tier (Balanced)
Used for: Standard implementation, review, testing

**Agents**: executor, reviewer, architect-lite, e2e-explorer, e2e-generator

### High Tier (Premium Quality)
Used for: Complex architecture, deep analysis, critical review

**Agents**: architect, reviewer-deep, security-deep, perf-reviewer, e2e-reviewer

## Configuration

Configure model tiers in `~/.config/opencode/workflows.json`. Each tier is an array — first model is preferred, rest are fallbacks:

```json
{
  "model_tiers": {
    "low":  ["your-provider/fast-model"],
    "mid":  ["your-provider/balanced-model"],
    "high": ["your-provider/best-model"]
  },
  "fallback_order": ["your-provider/balanced-model", "your-provider/fast-model"],
  "default_mode": "standard"
}
```

**Example with specific models:**
```json
{
  "model_tiers": {
    "low":  ["google/gemini-3-flash", "minimax/m2.5"],
    "mid":  ["minimax/m2.5", "zhipu/glm-5", "google/gemini-3-pro"],
    "high": ["zhipu/glm-5", "google/gemini-3-pro", "openai/gpt-5.2"]
  },
  "fallback_order": ["minimax/m2.5", "zhipu/glm-5", "google/gemini-3-pro"],
  "default_mode": "standard"
}
```

## Fallback Chain

If a model fails or is unavailable, workflows automatically fall back:

1. Try configured tier model
2. If unavailable, try next tier in fallback chain
3. Continue until success or all tiers exhausted
4. Report error if all models fail

## Known Model Quirks

These are behaviors observed during testing. Your experience may vary across versions.

### Zhipu AI (GLM series)
- May prefer single tool calls over batches
- Aggressive context trimming recommended for smaller context windows
- May omit language tags in code blocks

### MiniMax (M series)
- Response times of 5-15s typical, up to 30s for complex tasks
- Strong long-context handling (200k+)
- Limited streaming support in some configurations

### Google (Gemini series)
- Flash variants are fast but may skip validation steps in thorough mode
- Pro variants have excellent context windows (1M tokens)
- Free tier has daily quota limits

### OpenAI (GPT series)
- Most reliable for complex reasoning tasks
- Higher cost (10-20x more than mid-tier alternatives)
- Standard tier rate limits apply (check your plan)

## Best Practices

### 1. Match Tier to Task Complexity
```
Simple bug fix → low tier
Feature implementation → mid tier
Architecture design → high tier
```

### 2. Use Fallback Order Strategically
```json
// For reliability (cost-conscious)
"fallback_order": ["minimax/m2.5", "zhipu/glm-5", "google/gemini-3-pro"]

// For quality (cost-tolerant)
"fallback_order": ["openai/gpt-5.2", "zhipu/glm-5", "minimax/m2.5"]

// For speed (development)
"fallback_order": ["google/gemini-3-flash", "minimax/m2.5"]
```

### 3. Override Per-Workflow
```bash
# Force high-tier model for critical workflow
opencode run --mode thorough --tier high "refactor authentication system"
```

### 4. Monitor Token Usage
```bash
# View usage stats
opencode workflows stats --by-model
```

## Troubleshooting

### Model Unavailable Error
**Symptom**: `Error: Model not configured`

**Solution**: Add model to `opencode.jsonc` MCP servers and `workflows.json` tiers

### Rate Limit Exceeded
**Symptom**: `Error: Rate limit exceeded`

**Solution**: Fallback chain will handle automatically, or wait and retry

### Context Length Exceeded
**Symptom**: `Error: Input exceeds token limit`

**Solution**: Use model with larger context or enable aggressive trimming

### Inconsistent Output Format
**Symptom**: Agent skips required sections in output

**Solution**: Use higher-tier model or add explicit format validation

## Adding New Models

Any model that supports tool use works. To add one:

1. Configure MCP server in `opencode.jsonc` (or `opencode.json`)
2. Add the model to a tier in `workflows.json`
3. Test with a sample workflow
4. Optionally document quirks in this file

**opencode.jsonc** (MCP server):
```jsonc
{
  "mcp": {
    "my-provider": {
      "type": "local",
      "enabled": true,
      "command": ["my-provider-mcp-server"],
      "environment": { "API_KEY": "your-key" }
    }
  }
}
```

**workflows.json** (model tier):
```json
{
  "model_tiers": {
    "mid": ["my-provider/model-name", "existing-fallback"]
  }
}
```
