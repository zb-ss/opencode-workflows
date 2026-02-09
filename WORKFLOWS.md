# OpenCode Automated Workflows

This document explains how to use OpenCode's automated workflow system for development tasks.

## Overview

OpenCode workflows automate multi-step development processes by orchestrating specialized agents. Workflows maintain state in org-mode files, support interruption/resumption, and send desktop notifications.

**How Workflows Work:**
- Workflows run in your **main session** (the supervisor agent takes over)
- When supervisor asks questions, answer directly in the chat
- Supervisor invokes other agents (@org-planner, @editor, etc.) as needed
- To run multiple workflows, open multiple OpenCode instances in separate terminals

## Quick Start

### Start a Feature Development Workflow
```bash
/workflow feature Add user authentication with JWT tokens
```

### Start a Figma-to-Code Workflow
```bash
/workflow figma https://figma.com/file/xxx/Design?node-id=1:2 Dashboard header component
```

### Check Workflow Status
```bash
/workflow-status
```

### Resume an Interrupted Workflow
```bash
/workflow-resume
```

## Available Workflows

### 1. Feature Development (`feature`)

Complete feature development pipeline with planning, implementation, review, testing, and security audit.

**Usage:**
```bash
/workflow feature <description>
```

**Steps:**
1. **Planning** (org-planner) - Creates detailed development plan
2. **Implementation** (editor) - Implements with auto-review cycles
3. **Broad Review** (review) - Comprehensive code review against plan
4. **Test Writing** (test-writer) - Unit and integration tests
5. **E2E Testing** (web-tester) - Frontend testing if applicable
6. **Security Audit** (security-auditor) - OWASP Top 10 checks
7. **Final Commit** (supervisor) - Creates commit and archives workflow

**Example:**
```bash
/workflow feature Implement shopping cart with checkout flow
/workflow feature Add email notification system with queue processing
```

### 2. Figma to Code (`figma`)

Build pixel-perfect UI components from Figma designs with accessibility compliance.

**Usage:**
```bash
/workflow figma <figma-url> <description>
```

**Steps:**
1. **Design Analysis** (org-planner) - Analyzes Figma design, creates component plan
2. **Implementation** (figma-builder) - Builds components matching design
3. **Design Review** (review) - Verifies design fidelity
4. **E2E Testing** (web-tester) - Functional and visual testing
5. **Accessibility Audit** (web-tester) - WCAG AA compliance check
6. **Final Commit** (supervisor) - Creates commit and archives workflow

**Example:**
```bash
/workflow figma https://figma.com/file/ABC123/Design?node-id=1:2 Dashboard header
/workflow figma https://figma.com/design/XYZ789/App?node-id=45:67 User profile card
```

## Workflow Commands

### `/workflow <type> <description>`
Start a new automated workflow.

**Parameters:**
- `type` - Workflow type (`feature` or `figma`)
- `description` - What to build (for figma: include URL first)

**Behavior:**
1. Validates workflow type
2. Asks about branch strategy (current/new/specify)
3. Creates workflow state file in `workflows/active/`
4. Executes steps sequentially
5. Updates state file after each step
6. Sends notifications on completions/failures

### `/workflow-resume [workflow-id]`
Resume a paused or interrupted workflow.

**Parameters:**
- `workflow-id` (optional) - Specific workflow to resume. Omit to resume most recent.

**Behavior:**
1. Finds active workflows
2. Loads workflow state
3. Shows what will happen
4. Continues from current step

**Use Cases:**
- After interrupting OpenCode mid-workflow (Ctrl+C)
- After fixing an error that caused step failure
- After lunch break during long workflow

### `/workflow-status [workflow-id]`
Show status of active workflows.

**Parameters:**
- `workflow-id` (optional) - Specific workflow to show. Omit to show all.

**Displays:**
- Workflow title and type
- Current step and status
- Progress through all steps
- Last activity timestamp
- Any errors

## Workflow State Files

### Location
```
workflows/
├── active/          # Currently running workflows
├── completed/       # Archived finished workflows

templates/               # Workflow type definitions
├── bug-fix.org
├── feature-development.org
├── figma-to-code.org
├── joomla-translation.org
└── refactor.org
```

### State File Format
Each workflow creates an org-mode file with:
- Header properties (ID, type, branch, status)
- Step sections with status, timestamps, outputs
- Workflow log (audit trail)
- Error log (debugging info)

**Example:**
```
workflows/active/2025-12-06-user-auth.org
```

You can open this file in any text editor to see detailed progress.

## Agents Used in Workflows

| Agent | Role | Mode | Used In |
|-------|------|------|---------|
| **supervisor** | Orchestrates workflows | primary | All workflows (orchestrator) |
| **org-planner** | Creates development plans | primary | feature, figma (step 1) |
| **editor** | Implements code with review | primary | feature (step 2) |
| **figma-builder** | Builds UI from Figma | primary | figma (step 2) |
| **review** | Code review against plans | subagent | feature, figma (review steps) |
| **test-writer** | Writes unit/integration tests | primary | feature (step 4) |
| **web-tester** | E2E testing and a11y audits | primary | feature (step 5), figma (steps 4-5) |
| **security-auditor** | Security vulnerability analysis | primary | feature (step 6) |

All agents remain usable as primary agents for standalone tasks. The supervisor invokes them as needed during workflows.

## Branch Management

When starting a workflow, the supervisor will ask:

```
Current branch: main
Git status: clean

How should I handle branching?
1. Use current branch (main)
2. Create new feature branch (feature/<workflow-slug>)
3. Specify branch name: ____
```

**Recommendations:**
- **Option 1** - Use for quick fixes on current branch
- **Option 2** - Default for features (auto-generates branch name)
- **Option 3** - Use for specific naming conventions

## Notifications

Desktop notifications are sent via `notify-send` for:
- ✅ Step completions (normal priority)
- ✅ Workflow completions (normal priority)
- ❌ Step failures (critical priority)
- ⏸️ Workflow paused (critical priority)

**Plugin:** `~/.config/opencode/plugin/workflow-notifications.ts`

## Error Handling

### When a Step Fails
1. Workflow pauses automatically
2. Critical notification sent
3. Error details logged to workflow org file
4. User investigates and fixes issue
5. User runs `/workflow-resume` to retry

### Common Failure Scenarios

**Build/Test Failures:**
```bash
# After fixing the code issue
/workflow-resume
```

**Missing Dependencies:**
```bash
npm install <package>
# or
composer require <package>
/workflow-resume
```

**Git Conflicts:**
```bash
# Resolve conflicts manually
git add .
git commit
/workflow-resume
```

## Advanced Usage

### Viewing Workflow Progress
```bash
# Open the workflow state file
vim workflows/active/2025-12-06-my-feature.org

# Or use workflow-status
/workflow-status
```

### Multiple Active Workflows
You can have multiple workflows active simultaneously. Use workflow IDs to manage them:

```bash
/workflow-status                    # List all active
/workflow-status wf-2025-12-06-001  # Show specific
/workflow-resume wf-2025-12-06-001  # Resume specific
```

### Workflow Templates

Templates are defined in:
```
templates/
├── feature-development.org
└── figma-to-code.org
```

You can customize these templates to modify workflow steps, add new steps, or change agent assignments.

## Troubleshooting

### Workflow Not Starting
**Symptoms:** `/workflow` command does nothing or errors

**Solutions:**
1. Verify supervisor agent is available: `ls ~/.config/opencode/agent/supervisor.md`
2. Check OpenCode config is valid: `opencode --help`
3. Ensure workflow directories exist: `ls workflows/`

### Workflow Stuck on a Step
**Symptoms:** Step shows IN-PROGRESS for long time

**Solutions:**
1. Check if agent is actually running (check session activity)
2. Interrupt workflow (Ctrl+C) and resume
3. Check workflow org file for error details

### Notifications Not Appearing
**Symptoms:** No desktop notifications

**Solutions:**
1. Verify `notify-send` is installed: `which notify-send`
2. Check plugin is loaded: `ls ~/.config/opencode/plugin/workflow-notifications.ts`
3. Test manually: `notify-send "Test" "Message"`

### Agent Can't Access MCP Tools
**Symptoms:** Agent reports tool unavailable (Figma API, GitHub, etc.)

**Solutions:**
1. Check MCP servers are enabled in `opencode.json`
2. Verify API keys are configured in `~/.secrets/`
3. Check agent has tool permissions in `opencode.json`

## Related Files

### In this repo
- `agent/supervisor.md` — Workflow orchestrator agent
- `command/workflow.md` — Start workflows
- `command/workflow-resume.md` — Resume workflows
- `command/workflow-status.md` — Check status
- `plugin/workflow-notifications.ts` — Desktop notifications
- `templates/` — Workflow type templates (org-mode)

## Examples

### Example 1: Simple Feature
```bash
# Start workflow
/workflow feature Add API endpoint for user profile retrieval

# Workflow asks about branch
> 2. Create new feature branch

# Workflow proceeds through all steps automatically
# Notifications appear as steps complete
# Final notification when complete
```

### Example 2: Complex Feature with Interruption
```bash
# Start workflow
/workflow feature Implement payment processing with Stripe integration

# Work proceeds... then you need to leave
# Interrupt: Ctrl+C

# Later, resume
/workflow-resume

# Workflow continues from where it left off
```

### Example 3: Figma Component
```bash
# Start workflow
/workflow figma https://figma.com/file/ABC/Design?node-id=123:456 Product card component

# Supervisor fetches Figma data
# Planner creates component breakdown
# Figma-builder implements pixel-perfect
# Tests verify functionality
# Accessibility audit ensures WCAG AA
# Complete!
```

### Example 4: Handling Test Failures
```bash
# Workflow is in step 4 (test writing)
# Tests fail

# Check what failed
/workflow-status

# Fix the implementation issue
vim src/services/UserService.php

# Resume - will retry the failed step
/workflow-resume
```

## Best Practices

### 1. Start Small
Begin with simple features to learn the workflow system:
```bash
/workflow feature Add a simple hello world endpoint
```

### 2. Review Plans Before Implementation
After step 1 (planning), open the plan file to review before continuing:
```bash
vim plans/2025-12-06-my-feature.org
```

### 3. Use Descriptive Titles
Good descriptions help with organization:
```bash
# Good
/workflow feature Add JWT authentication with refresh tokens

# Less good
/workflow feature Add auth
```

### 4. Monitor Workflow Files
Keep an eye on the workflow org file to understand progress:
```bash
watch -n 5 cat workflows/active/2025-12-06-my-feature.org
```

### 5. Commit Workflow Artifacts
After completion, consider committing the workflow org file for documentation:
```bash
cp workflows/completed/2025-12-06-my-feature.org ./docs/development-log/
git add docs/development-log/2025-12-06-my-feature.org
git commit -m "docs: Add development log for user auth feature"
```

## See Also

- [AGENTS.md](./AGENTS.md) — Detailed agent documentation
- [CONVENTIONS.md](./CONVENTIONS.md) — Coding standards used by agents
- [OpenCode Docs](https://opencode.ai/docs)
