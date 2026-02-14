# Model Compatibility

OpenCode Workflows v2.0 is model-agnostic, supporting multiple LLM providers through a tiered system.

## Supported Models

### GLM-5 (Zhipu AI)
- **Model ID**: `glm-5`
- **Strengths**: Fast inference, good for code generation
- **Weaknesses**: Limited context window (128k)
- **Tier**: mid

### MiniMax M2.5
- **Model ID**: `minimax/m2.5`
- **Strengths**: Strong reasoning, multilingual
- **Weaknesses**: Slower response times
- **Tier**: mid/high

### Gemini 3 Pro
- **Model ID**: `gemini/3-pro`
- **Strengths**: Large context (1M tokens), multimodal
- **Weaknesses**: Rate limits on free tier
- **Tier**: high

### Gemini 3 Flash
- **Model ID**: `gemini/3-flash`
- **Strengths**: Fast, cost-effective
- **Weaknesses**: Less capable reasoning
- **Tier**: low/mid

### GPT-4.1
- **Model ID**: `openai/gpt-4.1`
- **Strengths**: Best reasoning, strong code generation
- **Weaknesses**: Expensive, rate limits
- **Tier**: high

## Model Tier System

### Low Tier (Cost-Effective)
Used for: Lightweight tasks, exploration, simple fixes

**Models**: Gemini 3 Flash, GLM-5 (fast mode)

**Agents**: explorer, executor-lite, reviewer-lite, security-lite, perf-lite

### Mid Tier (Balanced)
Used for: Standard implementation, review, testing

**Models**: GLM-5, MiniMax M2.5, Gemini 3 Pro

**Agents**: executor, reviewer, architect-lite, e2e-explorer, e2e-generator

### High Tier (Premium Quality)
Used for: Complex architecture, deep analysis, critical review

**Models**: GPT-4.1, Gemini 3 Pro, MiniMax M2.5

**Agents**: architect, reviewer-deep, security-deep, perf-reviewer, e2e-reviewer

## Configuration

Configure model tiers in `opencode.jsonc`:

```jsonc
{
  "workflows": {
    "model_tiers": {
      "low": "gemini/3-flash",
      "mid": "glm-5",
      "high": "openai/gpt-4.1"
    },
    "fallback_chain": ["high", "mid", "low"]
  }
}
```

## Fallback Chain

If a model fails or is unavailable, workflows automatically fall back:

1. Try configured tier model (e.g., `high` → `gpt-4.1`)
2. If unavailable, try next tier in fallback chain
3. Continue until success or all tiers exhausted
4. Report error if all models fail

**Example**: `high` tier agent → GPT-4.1 rate limited → falls back to `mid` tier (GLM-5)

## Model-Specific Quirks

### GLM-5
- **Token limit**: Be aggressive with context trimming
- **Tool use**: Prefers single tool calls over batches
- **Code formatting**: May omit language tags in code blocks

### MiniMax M2.5
- **Response time**: 5-15s typical, up to 30s for complex tasks
- **Streaming**: Limited streaming support
- **Context**: Strong long-context handling (200k+)

### Gemini 3 Flash
- **Speed**: Sub-second response for simple queries
- **Reliability**: May skip validation steps in thorough mode
- **Cost**: Best tokens-per-dollar ratio

### Gemini 3 Pro
- **Context**: Excellent 1M token window
- **Multimodal**: Can process screenshots, diagrams
- **Quota**: Free tier has daily limits

### GPT-4.1
- **Quality**: Most reliable for complex reasoning
- **Cost**: 10-20x more expensive than mid-tier
- **Rate limits**: 500 RPM standard tier

## Best Practices

### 1. Match Tier to Task Complexity
```
Simple bug fix → low tier
Feature implementation → mid tier
Architecture design → high tier
```

### 2. Use Fallback Chains Strategically
```jsonc
// For reliability (cost-conscious)
"fallback_chain": ["mid", "high", "low"]

// For quality (cost-tolerant)
"fallback_chain": ["high", "mid", "low"]

// For speed (development)
"fallback_chain": ["low", "mid", "high"]
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
**Symptom**: `Error: Model glm-5 not configured`

**Solution**: Add model to `opencode.jsonc` MCP servers section

### Rate Limit Exceeded
**Symptom**: `Error: Rate limit exceeded for openai/gpt-4.1`

**Solution**: Fallback chain will handle automatically, or wait and retry

### Context Length Exceeded
**Symptom**: `Error: Input exceeds 128k token limit`

**Solution**: Use model with larger context (Gemini 3 Pro) or enable aggressive trimming

### Inconsistent Output Format
**Symptom**: Agent skips required sections in output

**Solution**: Use higher-tier model or add explicit format validation

## Adding New Models

To add a new model:

1. Configure MCP server in `opencode.jsonc`
2. Add to tier configuration
3. Test with sample workflow
4. Document quirks in this file

Example:
```jsonc
{
  "mcpServers": {
    "my-new-model": {
      "endpoint": "https://api.provider.com/v1",
      "apiKey": "${MY_MODEL_API_KEY}"
    }
  },
  "workflows": {
    "model_tiers": {
      "mid": "my-new-model/large-v1"
    }
  }
}
```
