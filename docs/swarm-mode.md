# Swarm Mode - Parallel Execution

Swarm mode enables parallel workflow execution using multiple concurrent OpenCode sessions for massive speed improvements.

## Overview

**Standard Mode**: Sequential agent invocation (1 agent at a time)
**Swarm Mode**: Parallel agent spawning (up to 4 agents per batch)

**Speed Improvement**: 3-5x faster for workflows with independent parallel steps

## Architecture

### SDK-Based Session Spawning

Swarm mode uses `@opencode-ai/sdk` to spawn parallel sessions:

```typescript
import { createSession } from '@opencode-ai/sdk';

// Spawn 3 parallel reviewers
const sessions = await Promise.all([
  createSession({ agent: 'architect', prompt: 'Review backend' }),
  createSession({ agent: 'architect', prompt: 'Review frontend' }),
  createSession({ agent: 'architect', prompt: 'Review database' })
]);
```

### Batch Execution Pattern

Maximum 4 parallel agents per batch to avoid resource exhaustion:

```typescript
// Batch 1: 4 agents
[executor, executor, executor, executor]
  ↓ wait for all to complete
// Batch 2: 3 agents
[executor, executor, executor]
  ↓ wait for all to complete
// Batch 3: validation
[architect, architect, architect]
```

## 3-Architect Validation Pattern

Swarm mode uses **3 parallel architects** for validation:

1. Spawn 3 identical architect sessions
2. Each reviews independently
3. Aggregate results
4. Apply consensus logic (2/3 must pass)

**Why 3?**
- **Fault tolerance**: 1 can fail, still get consensus
- **Bias reduction**: Catches issues missed by individual reviewers
- **Balanced cost**: More than 3 has diminishing returns

## Swarm Tools

### `swarm_spawn_batch`

Spawn multiple agents in parallel.

**Parameters**:
- `agents`: Array of agent configs
- `max_parallel`: Maximum concurrent sessions (default: 4)

**Example**:
```typescript
swarm_spawn_batch({
  agents: [
    { name: 'executor', prompt: 'Implement user auth', context: { ... } },
    { name: 'executor', prompt: 'Implement API endpoints', context: { ... } },
    { name: 'executor', prompt: 'Implement database schema', context: { ... } }
  ],
  max_parallel: 3
})
```

**Returns**: Session IDs for tracking

### `swarm_await_batch`

Wait for batch completion and collect results.

**Parameters**:
- `session_ids`: Array of session IDs from spawn
- `timeout`: Maximum wait time in ms (default: 300000 = 5min)

**Example**:
```typescript
const results = await swarm_await_batch({
  session_ids: ['sess-1', 'sess-2', 'sess-3'],
  timeout: 300000
})
```

**Returns**:
```typescript
{
  completed: [
    { session_id: 'sess-1', status: 'success', output: '...' },
    { session_id: 'sess-2', status: 'success', output: '...' }
  ],
  failed: [
    { session_id: 'sess-3', status: 'error', error: 'timeout' }
  ]
}
```

## CLI Fallback

If SDK is unavailable, swarm mode falls back to CLI spawning:

```bash
# Sequential fallback
opencode run --agent executor "task 1" &
opencode run --agent executor "task 2" &
opencode run --agent executor "task 3" &
wait
```

**Limitations**:
- Less efficient (separate processes)
- No shared context between sessions
- Harder to aggregate results

**Detection**:
```typescript
if (await isSdkAvailable()) {
  // Use SDK-based swarm
} else {
  console.warn('SDK unavailable, falling back to CLI spawning')
  // Use CLI fallback
}
```

## When to Use Swarm Mode

### Good Use Cases

**1. Independent parallel work**
```
Feature: E-commerce checkout
├── Executor 1: Implement cart logic
├── Executor 2: Implement payment integration
└── Executor 3: Implement order confirmation

All 3 can work simultaneously (no dependencies)
```

**2. Parallel validation**
```
Review phase:
├── Architect 1: Review architecture
├── Architect 2: Review security
└── Architect 3: Review performance

All 3 review the same code independently
```

**3. Large codebases with modular tasks**
```
Refactor monolith:
├── Batch 1: [auth module, api module, db module, utils module]
├── Batch 2: [frontend components (3 executors)]
└── Batch 3: [validation by 3 architects]
```

### Bad Use Cases

**1. Sequential dependencies**
```
❌ Don't use swarm:
Step 1: Design database schema
Step 2: Implement models (depends on step 1)
Step 3: Implement controllers (depends on step 2)
```

**2. Shared state modifications**
```
❌ Don't use swarm:
- Multiple agents editing the same file
- Migrations that must run in order
- Git operations on same branch
```

**3. Simple tasks**
```
❌ Don't use swarm:
- Single-file bug fix
- Small feature (<100 lines)
- Quick refactoring

Overhead > benefit for small tasks
```

## Modes That Use Swarm

### Swarm Mode (Primary)
```json
{
  "name": "swarm",
  "parallel_execution": true,
  "batch_size": 4,
  "validation_pattern": "3-architect"
}
```

**Workflow**:
1. Architect: Design plan (single agent)
2. Executors: Implement in parallel batches
3. 3 Architects: Validate in parallel
4. Quality Gate: Final check

### Turbo Mode (Partial Swarm)
```json
{
  "name": "turbo",
  "parallel_execution": false,
  "validation_pattern": "3-architect"
}
```

**Workflow**:
1. Architect-lite: Quick plan
2. Executor: Sequential implementation
3. 3 Architects: Parallel validation (swarm for this step only)

## Configuration

Configure swarm behavior in `opencode.jsonc`:

```jsonc
{
  "workflows": {
    "swarm": {
      "enabled": true,
      "max_parallel_agents": 4,
      "validation_consensus": "2/3",
      "sdk_path": "/path/to/@opencode-ai/sdk",
      "fallback_to_cli": true,
      "timeout_per_agent": 300000
    }
  }
}
```

## Example: Full Swarm Workflow

### Scenario: E-commerce Feature

**Task**: Implement shopping cart with checkout

### Step 1: Planning (Single Agent)
```
architect → Creates task breakdown:
  - Task 1: Cart state management (frontend)
  - Task 2: Cart API endpoints (backend)
  - Task 3: Checkout UI (frontend)
  - Task 4: Payment integration (backend)
```

### Step 2: Parallel Implementation (Batch)
```typescript
// Batch 1: 4 executors in parallel
swarm_spawn_batch({
  agents: [
    { name: 'executor', prompt: 'Implement cart state management' },
    { name: 'executor', prompt: 'Implement cart API endpoints' },
    { name: 'executor', prompt: 'Implement checkout UI' },
    { name: 'executor', prompt: 'Implement payment integration' }
  ]
})

// Wait for all 4 to complete
const batch1_results = await swarm_await_batch({ ... })
```

### Step 3: 3-Architect Validation
```typescript
// 3 architects review in parallel
swarm_spawn_batch({
  agents: [
    { name: 'architect', prompt: 'Review cart implementation' },
    { name: 'architect', prompt: 'Review cart implementation' },
    { name: 'architect', prompt: 'Review cart implementation' }
  ]
})

// Wait and aggregate
const reviews = await swarm_await_batch({ ... })

// Apply consensus (2/3 must pass)
if (reviews.filter(r => r.verdict === 'PASS').length >= 2) {
  console.log('Validation passed by consensus')
} else {
  console.log('Validation failed, aggregating issues...')
}
```

### Step 4: Quality Gate (Single Agent)
```
quality-gate → Final checks:
  - All tests pass
  - No linting errors
  - Documentation complete
```

**Total time**: ~1/3 of sequential mode

## Troubleshooting

### Session Spawn Failures

**Symptom**: `Error: Failed to spawn session`

**Solutions**:
1. Check SDK installation: `npm list @opencode-ai/sdk`
2. Verify API key configuration
3. Check resource limits (file descriptors, memory)
4. Enable CLI fallback

### Timeout Errors

**Symptom**: `Error: Session timeout after 300000ms`

**Solutions**:
1. Increase timeout: `timeout_per_agent: 600000`
2. Reduce batch size: `max_parallel_agents: 2`
3. Split task into smaller chunks

### Consensus Failures

**Symptom**: All 3 architects return FAIL

**Solutions**:
1. Check quality of implementation (likely genuine issues)
2. Review aggregated issues from all 3
3. Fix and re-run validation batch

### Resource Exhaustion

**Symptom**: System slow, high memory usage

**Solutions**:
1. Reduce batch size: `max_parallel_agents: 2`
2. Add batch delays: `delay_between_batches: 5000`
3. Monitor system resources: `htop`, `nvidia-smi`

## Best Practices

### 1. Design for Parallelism
Break tasks into independent units before starting swarm workflow.

### 2. Balance Batch Sizes
- **4 agents**: Good for most systems
- **2 agents**: Conservative, low-resource systems
- **6+ agents**: Overkill, diminishing returns

### 3. Use Consensus Wisely
3-architect validation is expensive. Reserve for:
- Critical production code
- Security-sensitive features
- Complex architectural decisions

### 4. Handle Failures Gracefully
```typescript
const results = await swarm_await_batch({ ... })

// Check for failures
const failed = results.failed.length
if (failed > 0) {
  // Retry failed sessions individually
  for (const session of results.failed) {
    await retry_session(session.session_id)
  }
}
```

### 5. Monitor Progress
```typescript
// Poll for progress updates
const interval = setInterval(async () => {
  const status = await get_batch_status(session_ids)
  console.log(`Progress: ${status.completed}/${status.total}`)
}, 5000)
```

## Performance Metrics

Real-world speedups (from internal testing):

| Workflow Type | Sequential | Swarm | Speedup |
|---------------|------------|-------|---------|
| 4-module feature | 45 min | 15 min | 3x |
| Large refactor (8 files) | 60 min | 18 min | 3.3x |
| Full E2E suite generation | 90 min | 22 min | 4.1x |
| Parallel validation (3 architects) | 30 min | 12 min | 2.5x |

**Cost vs Speed Tradeoff**: Swarm mode uses 3-4x more tokens but completes 3-4x faster.

## See Also

- [docs/model-compatibility.md](./model-compatibility.md) - Model configuration for swarm agents
- [docs/review-system.md](./review-system.md) - 3-architect consensus validation
- [WORKFLOWS.md](../WORKFLOWS.md) - Mode selection guide
