---
description: Start an automated development workflow
agent: supervisor
model_tier: mid
---

Start a new automated workflow with configurable execution modes.

## Usage
```
/workflow <type> <description> [--mode=<mode>]
```

## Available Workflow Types
- `feature` - Full feature development (plan → implement → review → test → security)
- `figma` - Figma design to code (plan → implement → review → test → a11y)
- `bugfix` - Bug investigation and fix (investigate → plan → implement → review → test)
- `refactor` - Code refactoring (analyze → plan → implement → review → test)
- `translate` - Joomla component translation (scan → process views → review)

## Execution Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `standard` | Balanced approach (default) | General development |
| `turbo` | Maximum speed, lite agents | Prototypes, quick fixes |
| `eco` | Token-efficient, minimal overhead | Simple tasks, budget-conscious |
| `thorough` | Maximum quality, deep reviews | Production code, security-sensitive |
| `swarm` | Parallel execution, multi-validation | Large features, complex systems |

## Examples
```
/workflow feature Add user authentication with JWT tokens
/workflow feature Add payment processing --mode=thorough
/workflow feature swarm: Build notification system with email, SMS, push
/workflow bugfix Fix race condition in checkout --mode=turbo
/workflow refactor Extract validation logic --mode=eco
/workflow figma https://figma.com/file/xxx Dashboard header
/workflow translate ./com_mycomponent fr-CA
```

## Your Task

You are the supervisor agent. A new workflow has been requested.

**Raw input**: $ARGUMENTS

### Step 1: Parse the Input

Parse `$ARGUMENTS` using these rules in order:

1. **Extract the workflow type** — the FIRST word is always the type:
   `feature`, `bugfix`, `refactor`, `figma`, `translate`

2. **Detect the mode** — check for EITHER:
   - A `--mode=<mode>` flag anywhere in the input (remove it from description)
   - A keyword prefix right after the type: `swarm:`, `thorough:`, `careful:`, `production:`, `quick:`, `fast:`, `prototype:`, `eco:`, `simple:`, `minor:`
   - If neither found, use default mode from `workflows.json` (usually `standard`)

3. **Everything remaining** after removing type and mode is the **description**

**Parsing examples:**
| Input | Type | Mode | Description |
|-------|------|------|-------------|
| `feature Add auth` | feature | standard | Add auth |
| `feature --mode=swarm Add auth` | feature | swarm | Add auth |
| `feature swarm: Add auth` | feature | swarm | Add auth |
| `feature thorough: Add auth` | feature | thorough | Add auth |
| `bugfix Fix login --mode=turbo` | bugfix | turbo | Fix login |

### Step 2: Validate

- If the type is not recognized, list available types and ask for clarification
- If the mode is not recognized, list available modes and ask for clarification

### Step 3: Resolve Config Directory

**CRITICAL**: First, run `echo $HOME` to get the absolute home path. Then use it to build the config directory path:
```
<HOME>/.config/opencode
```
For example: `/home/zashboy/.config/opencode`

**NEVER use relative paths.** Always use the absolute path for all file reads below.

### Step 4: Load Mode Configuration

Read the mode config JSON file. Use the absolute path:
```bash
# If mode is "swarm":
cat <HOME>/.config/opencode/mode/swarm.json
```

Available mode files: `eco.json`, `turbo.json`, `standard.json`, `thorough.json`, `swarm.json`

The JSON contains:
- `agent_routing` — which agent to use for each phase (planning, implementation, code_review, etc.)
- `settings` — iteration limits, parallel execution flag, test requirements

### Step 5: Load Workflow Configuration

Read the workflow config:
```
<HOME>/.config/opencode/workflows.json
```
This contains `model_tiers` and `default_mode`.

### Step 6: Ask About Branch Strategy

Ask the user:
- Use current branch, or create `feature/<slug>` / `fix/<slug>`

### Step 7: Load Template & Create State

Read the workflow template using its absolute path:

| Type | Template Path |
|------|---------------|
| `feature` | `<HOME>/.config/opencode/templates/feature-development.org` |
| `bugfix` | `<HOME>/.config/opencode/templates/bug-fix.org` |
| `refactor` | `<HOME>/.config/opencode/templates/refactor.org` |
| `figma` | `<HOME>/.config/opencode/templates/figma-to-code.org` |
| `translate` | See Translation section below |

Create workflow state file in: `<HOME>/.config/opencode/workflows/active/`
Bind session with `workflow_bind_session`.

### Step 8: Execute

Follow the supervisor agent instructions for workflow execution.
Invoke agents using `@agent-name` syntax (e.g., `@wf-executor`, `@wf-reviewer`).
Use the agents from the mode config's `agent_routing` (Step 4), prefixed with `@wf-`.
Update the workflow state file after every action.

## Translation Workflow

For `translate` workflows, processing is **view-by-view** to prevent context overflow:

1. **Step 0**: Scan component, create view queue
2. **Step 1**: User runs `/translate-view next` for EACH view
3. **Step 2**: Final review after all views complete
4. **Step 3**: User commits

Arguments after type: `<component-path> <target-lang> [source-lang]`
- Source language defaults to `en-GB`
- Uses specialized agents: `@translation-planner`, `@translation-coder`, `@translation-reviewer`

Do NOT attempt to process all views in a single session.
