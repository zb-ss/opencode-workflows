# Workflow System Guide

Complete guide to OpenCode Workflows v2.0 automated workflow system.

## Overview

OpenCode workflows automate multi-step development processes by orchestrating specialized agents through defined gates. Workflows maintain state in org-mode files, support interruption/resumption, and provide desktop notifications.

**Key Features**:
- 5 execution modes (eco, turbo, standard, thorough, swarm)
- 6 workflow templates
- Zero-tolerance review system
- Parallel execution (swarm mode)
- Multi-workflow session binding

## Workflow Lifecycle

### 1. Start
```bash
/workflow <type> <description>
```

**Supervisor**:
- Validates workflow type
- Asks about branch strategy
- Creates `.state.json` sidecar file
- Binds workflow to current session
- Loads workflow template
- Initializes first gate

### 2. Execute Steps

Each gate represents a phase:
```
Gate: planning
├── Invoke: architect agent
├── Wait for completion
├── Update state file
└── Proceed to next gate or fail
```

**Gate Types**:
- `planning` - Architecture, design
- `implementation` - Code changes
- `implementation_review` - Review of implementation
- `testing` - Test generation/execution
- `testing_review` - Review of tests
- `security_audit` - Security checks
- `security_review` - Deep security analysis
- `performance_check` - Performance validation
- `performance_review` - Optimization analysis
- `quality_gate` - Final checks
- `completion` - Cleanup, archival

### 3. Review

Each implementation gate followed by review gate:
```
implementation (executor)
  ↓
implementation_review (reviewer)
  ↓ PASS
testing (test-writer)
  ↓
testing_review (reviewer)
  ↓ PASS
Continue...
```

**Zero-Tolerance Review**:
- PASS requires ZERO issues
- Reviewer reports [ISSUE-N] [SEVERITY] format
- Executor fixes all issues
- Re-review until PASS or max iterations
- Auto-escalate after max iterations

### 4. Complete

**Supervisor**:
- Runs completion-guard
- Archives workflow state to `completed/`
- Unbinds from session
- Sends completion notification
- Optionally creates commit

## Execution Modes

### Eco Mode

**Profile**: Fast, basic quality, minimal cost

**Gates**:
1. `planning` - architect-lite
2. `implementation` - executor-lite
3. `final_review` - reviewer-lite (2 iterations max)
4. `security_audit` - security-lite
5. `quality_gate` - quality-gate

**Use Cases**:
- Prototypes
- Experiments
- Non-critical features
- Learning/exploration

**Configuration**:
```json
{
  "name": "eco",
  "gates": [
    { "name": "planning", "agent": "architect-lite", "tier": "mid" },
    { "name": "implementation", "agent": "executor-lite", "tier": "low" },
    { "name": "final_review", "agent": "reviewer-lite", "tier": "low" },
    { "name": "security_audit", "agent": "security-lite", "tier": "low" },
    { "name": "quality_gate", "agent": "quality-gate", "tier": "mid" }
  ],
  "parallel_execution": false
}
```

---

### Turbo Mode

**Profile**: Fastest, standard quality, 3-architect validation

**Gates**:
1. `planning` - architect-lite
2. `implementation` - executor-lite
3. `validation` - 3x architect (parallel consensus)
4. `testing` - test-writer
5. `quality_gate` - quality-gate

**Use Cases**:
- Quick features
- Time-sensitive fixes
- Standard production code
- When speed matters

**3-Architect Validation**:
```
Spawn 3 architects in parallel
  ↓
Each reviews independently
  ↓
Aggregate results
  ↓
Apply consensus (2/3 must PASS)
```

**Configuration**:
```json
{
  "name": "turbo",
  "gates": [
    { "name": "planning", "agent": "architect-lite", "tier": "mid" },
    { "name": "implementation", "agent": "executor-lite", "tier": "low" },
    { "name": "validation", "agent": "architect", "tier": "high", "parallel": 3 },
    { "name": "testing", "agent": "test-writer", "tier": "mid" },
    { "name": "quality_gate", "agent": "quality-gate", "tier": "mid" }
  ],
  "parallel_execution": false
}
```

---

### Standard Mode

**Profile**: Balanced speed and quality

**Gates**:
1. `planning` - architect
2. `implementation` - executor
3. `implementation_review` - reviewer (3 iterations max)
4. `testing` - test-writer
5. `testing_review` - reviewer
6. `security_audit` - security
7. `quality_gate` - quality-gate

**Use Cases**:
- Production features
- Standard development
- Balanced cost/quality
- Most common mode

**Configuration**:
```json
{
  "name": "standard",
  "gates": [
    { "name": "planning", "agent": "architect", "tier": "high" },
    { "name": "implementation", "agent": "executor", "tier": "mid" },
    { "name": "implementation_review", "agent": "reviewer", "tier": "mid" },
    { "name": "testing", "agent": "test-writer", "tier": "mid" },
    { "name": "testing_review", "agent": "reviewer", "tier": "mid" },
    { "name": "security_audit", "agent": "security", "tier": "mid" },
    { "name": "quality_gate", "agent": "quality-gate", "tier": "mid" }
  ],
  "parallel_execution": false
}
```

---

### Thorough Mode

**Profile**: Maximum quality, comprehensive analysis

**Gates**:
1. `planning` - architect
2. `codebase_analysis` - codebase-analyzer
3. `implementation` - executor
4. `implementation_review` - reviewer-deep (5 iterations max)
5. `testing` - test-writer
6. `testing_review` - reviewer-deep
7. `security_review` - security-deep
8. `performance_review` - perf-reviewer
9. `quality_gate` - quality-gate

**Use Cases**:
- Critical production systems
- Security-sensitive features
- Payment/auth systems
- High-stakes refactoring

**Configuration**:
```json
{
  "name": "thorough",
  "gates": [
    { "name": "planning", "agent": "architect", "tier": "high" },
    { "name": "codebase_analysis", "agent": "codebase-analyzer", "tier": "mid" },
    { "name": "implementation", "agent": "executor", "tier": "mid" },
    { "name": "implementation_review", "agent": "reviewer-deep", "tier": "high" },
    { "name": "testing", "agent": "test-writer", "tier": "mid" },
    { "name": "testing_review", "agent": "reviewer-deep", "tier": "high" },
    { "name": "security_review", "agent": "security-deep", "tier": "high" },
    { "name": "performance_review", "agent": "perf-reviewer", "tier": "high" },
    { "name": "quality_gate", "agent": "quality-gate", "tier": "mid" }
  ],
  "parallel_execution": false
}
```

---

### Swarm Mode

**Profile**: Fastest with excellent quality, parallel execution

**Gates**:
1. `planning` - architect
2. `implementation_batch` - 4x executor (parallel)
3. `validation` - 3x architect (parallel consensus)
4. `testing` - test-writer
5. `quality_gate` - quality-gate

**Use Cases**:
- Large modular features
- Independent parallel work
- When speed + quality both matter
- Multiple independent components

**Parallel Execution**:
```
Batch 1: [executor, executor, executor, executor]
  ↓ wait for all
Validation: [architect, architect, architect]
  ↓ consensus (2/3 PASS)
Continue...
```

**Requirements**:
- `@opencode-ai/sdk` installed
- Tasks can be split into independent units
- No shared state modifications

**Configuration**:
```json
{
  "name": "swarm",
  "gates": [
    { "name": "planning", "agent": "architect", "tier": "high" },
    { "name": "implementation_batch", "agent": "executor", "tier": "mid", "parallel": 4 },
    { "name": "validation", "agent": "architect", "tier": "high", "parallel": 3 },
    { "name": "testing", "agent": "test-writer", "tier": "mid" },
    { "name": "quality_gate", "agent": "quality-gate", "tier": "mid" }
  ],
  "parallel_execution": true,
  "max_parallel_agents": 4
}
```

---

## Mode Selection Guide

| Scenario | Recommended Mode |
|----------|------------------|
| Quick prototype | eco |
| Time-critical fix | turbo |
| Standard feature | standard |
| Payment integration | thorough |
| Auth system | thorough |
| Large modular feature | swarm |
| Refactoring | standard or thorough |
| Bug fix | eco or standard |
| E2E test generation | standard |
| Figma to code | standard |

## Workflow Templates

### 1. Feature Development

**Template**: `templates/feature-development.org`

**Description**: Complete feature development pipeline

**Steps**:
```
planning → implementation → implementation_review →
testing → testing_review → security_audit → quality_gate → completion
```

**Usage**:
```bash
/workflow feature Add JWT authentication with refresh tokens
```

**Supported Modes**: All

---

### 2. Figma to Code

**Template**: `templates/figma-to-code.org`

**Description**: Pixel-perfect UI from Figma designs

**Steps**:
```
planning (design analysis) → implementation (figma-builder) →
design_review → e2e_testing → accessibility_audit → quality_gate → completion
```

**Usage**:
```bash
/workflow figma https://figma.com/file/ABC/Design?node-id=1:2 Dashboard header
```

**Supported Modes**: standard, thorough

---

### 3. Bug Fix

**Template**: `templates/bug-fix.org`

**Description**: Systematic bug investigation and resolution

**Steps**:
```
investigation (debug) → planning (fix strategy) →
implementation → implementation_review → testing → quality_gate → completion
```

**Usage**:
```bash
/workflow bug-fix "Users can't login with special characters"
```

**Supported Modes**: All

---

### 4. Refactor

**Template**: `templates/refactor.org`

**Description**: Safe refactoring with comprehensive validation

**Steps**:
```
codebase_analysis → planning → implementation →
implementation_review → testing_review → quality_gate → completion
```

**Usage**:
```bash
/workflow refactor "Extract user service from controller"
```

**Supported Modes**: standard, thorough

---

### 5. E2E Testing

**Template**: `templates/e2e-testing.org`

**Description**: 6-phase Playwright test generation

**Steps**:
```
setup → exploration (e2e-explorer) → generation (e2e-generator) →
validation (e2e-reviewer) → quality_gate → completion
```

**Usage**:
```bash
/workflow e2e http://localhost:3000 "Test checkout flow"
```

**Supported Modes**: All

**Phases**:
1. **Setup**: Install Playwright, create config
2. **Exploration**: BFS crawl, generate app-map.json
3. **Generation**: Create tests with accessibility-first selectors
4. **Validation**: Run 3x, detect flakiness, check anti-patterns
5. **Quality Gate**: Full suite validation
6. **Completion**: Archive and report

---

### 6. Joomla Translation (Optional)

**Template**: `templates/joomla-translation.org`

**Description**: i18n conversion for Joomla components

**Steps**:
```
planning (translation-planner - scan views) →
implementation (translation-coder - process views) →
review (translation-reviewer) → quality_gate → completion
```

**Usage**:
```bash
/translate-auto com_mycomponent fr-CA
```

**Supported Modes**: standard

**Requires**: translate module installed

---

## Gate Enforcement System

### Gate Definition

Each gate defines:
- Agent to invoke
- Model tier
- Parallelism (1 or N)
- Required inputs
- Expected outputs
- Success criteria

**Example**:
```json
{
  "name": "implementation_review",
  "agent": "reviewer",
  "tier": "mid",
  "parallel": 1,
  "max_iterations": 3,
  "required_inputs": ["implementation_files"],
  "expected_outputs": ["verdict", "issues"],
  "success_criteria": "verdict === 'PASS'"
}
```

### Gate Execution Flow

```
1. Load gate configuration
2. Validate required inputs present
3. Spawn agent session(s)
   - Single agent: spawn 1
   - Parallel: spawn N simultaneously
4. Wait for completion
5. Validate outputs
6. Check success criteria
7. Update state file
8. Proceed or fail
```

### Parallel Gate Execution

**Single Agent**:
```typescript
const result = await spawnAgent({ agent: 'reviewer', ... })
```

**Parallel Batch**:
```typescript
const results = await swarm_spawn_batch({
  agents: [
    { name: 'architect', ... },
    { name: 'architect', ... },
    { name: 'architect', ... }
  ]
})

// Apply consensus
const consensus = applyConsensus(results, '2/3')
```

### Gate Failure Handling

**On Failure**:
1. Log error to workflow state
2. Pause workflow
3. Send critical notification
4. Wait for user intervention
5. User fixes issue
6. User runs `/workflow-resume`
7. Retry failed gate

**Retry Logic**:
```
Attempt 1: Execute gate
  ↓ FAIL
Attempt 2: Retry with fixes
  ↓ FAIL
Attempt 3: Final retry
  ↓ FAIL (max iterations)
Escalate to higher tier agent or manual intervention
```

## State Management

### State File Format

**Location**: `~/.claude/workflows/<session-id>/.state.json`

**Structure**:
```json
{
  "workflow_id": "wf-2026-02-14-001",
  "type": "feature-development",
  "mode": "standard",
  "status": "in_progress",
  "current_gate": "implementation_review",
  "branch": "feature/jwt-auth",
  "session_id": "sess-abc123",
  "started_at": "2026-02-14T10:30:00Z",
  "updated_at": "2026-02-14T10:45:00Z",
  "gates": [
    {
      "name": "planning",
      "status": "completed",
      "agent": "architect",
      "started_at": "2026-02-14T10:30:00Z",
      "completed_at": "2026-02-14T10:35:00Z",
      "outputs": { "plan_file": "plans/2026-02-14-jwt-auth.org" }
    },
    {
      "name": "implementation",
      "status": "completed",
      "agent": "executor",
      "started_at": "2026-02-14T10:35:00Z",
      "completed_at": "2026-02-14T10:42:00Z",
      "outputs": { "files_modified": [...] }
    },
    {
      "name": "implementation_review",
      "status": "in_progress",
      "agent": "reviewer",
      "started_at": "2026-02-14T10:42:00Z",
      "iteration": 1,
      "max_iterations": 3
    }
  ],
  "errors": []
}
```

### Sidecar Files

Each workflow creates `.state.json` in workflow directory:
```
~/.claude/workflows/
├── sess-abc123/
│   ├── .state.json          # Workflow state
│   ├── 2026-02-14-jwt-auth.org  # Human-readable org file
│   └── logs/                # Detailed logs
└── sess-def456/
    └── .state.json
```

### Session Binding

**Multi-Workflow Support**: Multiple workflows can run simultaneously in different sessions.

**Binding Protocol**:
1. User starts workflow in session A: `/workflow feature ...`
2. Create `.state.json` with `session_id: "sess-A"`
3. Session A owns this workflow
4. User starts another workflow in session B: `/workflow e2e ...`
5. Create separate `.state.json` with `session_id: "sess-B"`
6. Both workflows run independently

**Commands**:
```bash
# In session A
/workflow feature Add auth

# In session B (different terminal)
/workflow e2e http://localhost:3000

# Check status of all
/workflow-status

# Resume specific workflow
/workflow-resume wf-2026-02-14-001
```

## Workflow Commands

### /workflow

Start automated workflow.

**Syntax**:
```bash
/workflow <type> <description>
```

**Parameters**:
- `type`: feature, figma, bug-fix, refactor, e2e, translate (optional module)
- `description`: What to build/test/fix

**Examples**:
```bash
/workflow feature Add JWT authentication
/workflow figma https://figma.com/... Dashboard header
/workflow bug-fix "Login fails with special chars"
/workflow refactor "Extract payment service"
/workflow e2e http://localhost:3000 "Test checkout"
```

**Behavior**:
1. Validate workflow type exists
2. Ask branch strategy (current/new/specify)
3. Create state file and bind to session
4. Load template gates
5. Execute first gate
6. Update state after each gate
7. Send notifications on events

---

### /workflow-resume

Resume paused or interrupted workflow.

**Syntax**:
```bash
/workflow-resume [workflow-id]
```

**Parameters**:
- `workflow-id` (optional): Specific workflow to resume. Omit for most recent in current session.

**Examples**:
```bash
/workflow-resume                    # Resume most recent
/workflow-resume wf-2026-02-14-001  # Resume specific
```

**Use Cases**:
- After Ctrl+C interruption
- After fixing error that caused failure
- After lunch break during long workflow

**Behavior**:
1. Find workflow by ID or session
2. Load state from `.state.json`
3. Show current gate and status
4. Ask for confirmation
5. Resume from current gate

---

### /workflow-status

Show status of active workflows.

**Syntax**:
```bash
/workflow-status [workflow-id]
```

**Parameters**:
- `workflow-id` (optional): Specific workflow. Omit for all active.

**Examples**:
```bash
/workflow-status                    # Show all
/workflow-status wf-2026-02-14-001  # Show specific
```

**Displays**:
- Workflow ID, title, type, mode
- Current gate and status
- Progress through all gates
- Last activity timestamp
- Any errors

**Output Example**:
```
Active Workflows:

[wf-2026-02-14-001] Add JWT authentication (feature-development, standard)
├── Session: sess-abc123
├── Branch: feature/jwt-auth
├── Status: in_progress
├── Current Gate: implementation_review (iteration 1/3)
├── Progress: 2/7 gates completed
├── Last Activity: 3 minutes ago
└── Errors: none

[wf-2026-02-14-002] Test checkout flow (e2e-testing, standard)
├── Session: sess-def456
├── Status: in_progress
├── Current Gate: validation
├── Progress: 3/6 gates completed
└── Last Activity: 1 minute ago
```

---

## Branch Management

When starting workflow, supervisor asks:

```
Current branch: main
Git status: clean

How should I handle branching?
1. Use current branch (main)
2. Create new feature branch (feature/jwt-auth)
3. Specify custom branch name: ____
```

**Recommendations**:
- **Option 1**: Quick fixes, hotfixes, working on feature branch already
- **Option 2**: New features (auto-generated name from description)
- **Option 3**: Specific naming convention required

**Auto-Generated Branch Names**:
```
/workflow feature Add JWT auth
  → feature/jwt-auth

/workflow bug-fix "Login fails"
  → fix/login-fails

/workflow refactor "Extract service"
  → refactor/extract-service
```

## Notifications

Desktop notifications via `notify-send` (Linux) or equivalent:

**Events**:
- ✓ Step completion (normal priority)
- ✓ Workflow completion (normal priority)
- ✗ Step failure (critical priority)
- ⏸ Workflow paused (critical priority)

**Example**:
```
✓ OpenCode Workflow
Step 'implementation' completed successfully
(wf-2026-02-14-001)
```

```
✗ OpenCode Workflow - FAILURE
Step 'implementation_review' failed with 3 issues
View details and fix, then /workflow-resume
(wf-2026-02-14-001)
```

## Troubleshooting

### Workflow Not Starting

**Symptom**: `/workflow` command does nothing

**Solutions**:
1. Verify supervisor agent exists: `ls ~/.config/opencode/agent/supervisor.md`
2. Check OpenCode config: `opencode --help`
3. Ensure workflow directories exist: `mkdir -p ~/.claude/workflows`
4. Check for conflicting workflows in session

### Workflow Stuck

**Symptom**: Gate shows `in_progress` for long time

**Solutions**:
1. Check if agent is running (view session activity)
2. Interrupt (Ctrl+C) and resume
3. Check `.state.json` for error details
4. View logs in workflow directory

### Gate Failure Loop

**Symptom**: Review fails repeatedly with same issues

**Solutions**:
1. Check if executor is actually fixing issues
2. Verify fixes are being applied to correct files
3. Escalate to higher tier reviewer
4. Manual intervention if max iterations reached

### Notifications Not Appearing

**Symptom**: No desktop notifications

**Solutions**:
1. Install `notify-send`: `sudo apt install libnotify-bin`
2. Check plugin exists: `ls ~/.config/opencode/plugin/workflow-notifications.ts`
3. Test manually: `notify-send "Test" "Message"`

## Best Practices

### 1. Start Simple
Begin with eco or standard mode to learn workflow system.

### 2. Use Appropriate Mode
Don't use thorough mode for simple tasks. Match mode to criticality.

### 3. Monitor Progress
Keep workflow state file visible in another window.

### 4. Fix Issues Promptly
When review fails, fix all issues before resuming (don't skip MINOR issues).

### 5. Leverage Swarm for Modular Work
If task can be split into 3-4 independent parts, use swarm mode.

### 6. Archive Completed Workflows
Completed workflows serve as development logs. Consider committing them to repo.

## Configuration

Configure model tiers in `~/.config/opencode/workflows.json`:

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

Review iterations and swarm settings are configured per-mode in `mode/*.json`, not here.

## See Also

- [AGENTS.md](./AGENTS.md) - Agent reference
- [docs/model-compatibility.md](./docs/model-compatibility.md) - Model configuration
- [docs/review-system.md](./docs/review-system.md) - Zero-tolerance review
- [docs/swarm-mode.md](./docs/swarm-mode.md) - Parallel execution
- [docs/e2e-testing.md](./docs/e2e-testing.md) - E2E testing pipeline
