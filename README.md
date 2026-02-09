# OpenCode Workflows

A public, installable collection of agents, commands, skills, plugins, tools, and workflow templates for [OpenCode](https://github.com/sst/opencode).

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- [Node.js](https://nodejs.org/) v18+

### Quick Install

```bash
git clone https://github.com/YOUR_USERNAME/opencode-workflows.git
cd opencode-workflows
node install.mjs
```

This installs the **core** module (agents, commands, skills, plugins) via symlinks into `~/.config/opencode/`.

### Install Options

```bash
# Install core module with symlinks (default)
node install.mjs

# Install core module with file copies
node install.mjs --copy

# Install everything (core + Joomla translation tools)
node install.mjs --all

# Add the translate module to an existing install
node install.mjs --module translate

# Preview what will be installed without making changes
node install.mjs --dry-run

# Remove all installed files
node install.mjs --uninstall

# Show help
node install.mjs --help
```

### Modules

| Module | Contents | Installed by default |
|--------|----------|---------------------|
| **core** | 12 agents, 6 commands, 13 skills, 1 plugin, CONVENTIONS.md | Yes |
| **translate** | 3 agents, 2 commands, 8 tools, 1 plugin (Joomla i18n) | No (`--all` or `--module translate`) |

### Post-Install

1. Review and edit `~/.config/opencode/opencode.json` — configure API keys and MCP servers
2. Set up API keys in `~/.secrets/` as needed (GitHub, Figma, Slack, etc.)
3. Start OpenCode and verify agents are available

### Updating

- **Symlink mode** (default): just `git pull` — symlinks track repo changes automatically
- **Copy mode**: `git pull && node install.mjs --copy`

### Uninstalling

```bash
node install.mjs --uninstall
```

This removes all installed symlinks/copies and the manifest file. Your `opencode.json` is never removed.

---

## Overview

This repository contains specialized agents for different development workflows. Each agent has specific capabilities, permissions, and purposes designed to work together in a controlled, step-by-step development process.

## Available Agents

### 1. org-planner (Primary Agent)

**Purpose**: Creates detailed, architectural-level development plans saved as org-mode files.

**Key Features**:
- Acts as an expert architect providing direction
- Creates hierarchical task breakdowns with TODO states
- Includes priorities, time estimates, and tags
- Saves plans to `plans/` with date prefixes
- Focuses on *what* needs to change and *why*, not *how*

**Configuration**:
- **Mode**: Primary
- **Model**: `openai/gpt-5-codex`
- **Temperature**: 0.3 (low for structured, consistent output)
- **Permissions**: 
  - ✅ Write: Only to `plans/*.org`
  - ❌ Edit: Disabled
  - ❌ Bash: Disabled
  - ✅ Read: Enabled

**When to Use**:
- Planning new features or refactors
- Breaking down complex tasks
- Creating implementation roadmaps
- Documenting architecture decisions
- Before starting any significant development work

**Usage Examples**:
```bash
# Using custom command
opencode run --command plan "implement OAuth authentication with Google"

# Direct agent invocation
opencode run --agent org-planner "refactor payment processing module"

# From TUI
opencode
> /plan add real-time notifications with WebSockets
```

**Output Format**:
Plans are saved as: `YYYY-MM-DD-descriptive-name.org`

Example: `2024-11-01-oauth-authentication-google.org`

**Plan Structure**:
```org
#+TITLE: Feature Name
#+AUTHOR: OpenCode Planning Agent
#+DATE: 2024-11-01
#+FILETAGS: :project:planning:

* Overview
[High-level description]

* Goals
- [ ] Goal 1
- [ ] Goal 2

* TODO [#A] Task Category 1
SCHEDULED: <2024-11-01>
** TODO Subtask 1.1
** TODO Subtask 1.2

* Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

* Notes
[Additional context]
```

---

### 2. discussion (Primary Agent)

**Purpose**: Technical advisor for discussions, Q&A, brainstorming, and learning.

**Key Features**:
- Conversational and thoughtful interaction style
- Can explore code but makes no modifications
- Researches documentation when needed
- Provides multiple perspectives with pros/cons
- Educational focus on explaining the "why"

**Configuration**:
- **Mode**: Primary
- **Model**: `anthropic/claude-sonnet-4-20250514`
- **Temperature**: 0.7 (higher for conversational tone)
- **Permissions**:
  - ❌ Write: Disabled
  - ❌ Edit: Disabled
  - ❌ Bash: Disabled
  - ✅ Read: Enabled
  - ✅ WebFetch: Enabled
  - ✅ Grep/Glob: Enabled
  - ✅ Task: Enabled (for delegation)

**When to Use**:
- Understanding existing codebases
- Exploring architectural options
- Learning about design patterns
- Getting explanations of technical concepts
- Brainstorming solutions before implementation
- Code reviews (analysis only, not modifications)

**Usage Examples**:
```bash
opencode run --agent discussion "explain the current authentication flow"
opencode run --agent discussion "what are the pros and cons of using Redis vs Memcached?"
opencode run --agent discussion "how does our payment processing work?"
```

**What It Won't Do**:
- Create implementation plans (use `org-planner`)
- Make code changes (use `editor` or `build`)
- Execute commands (read-only mode)

**Delegation Suggestions**:
The discussion agent will suggest switching to:
- `org-planner` - for creating plans
- `editor` - for careful implementation with approval
- `build` - for fast implementation
- `review` - for code reviews

---

### 3. editor (Primary Agent)

**Purpose**: Meticulous implementation of code changes with manual approval for every modification.

**Key Features**:
- Incremental, small changes one at a time
- Clear communication before and after each change
- Always reads files before editing for context
- Waits for approval before proceeding (enforced by `ask` permissions)
- Suggests verification steps after changes

**Configuration**:
- **Mode**: Primary
- **Model**: `anthropic/claude-sonnet-4-20250514`
- **Temperature**: 0.3 (low for precision)
- **Permissions**:
  - ⚠️ Write: **ASK** (prompts before every file creation)
  - ⚠️ Edit: **ASK** (prompts before every file modification)
  - ⚠️ Bash: **ASK** (prompts before every command)
    - npm/yarn/pnpm/bun: ASK
    - git: ASK
    - composer: ASK
    - all others: ASK
  - ✅ Read/Grep/Glob: Enabled

**When to Use**:
- Implementing changes where you want full control
- Working on critical or sensitive code
- Learning codebases by seeing changes step-by-step
- When you want to approve each modification
- Implementing from a detailed plan file

**Usage Examples**:
```bash
# Implement from a plan
opencode run --agent editor "implement the authentication plan from plans/2024-11-01-auth.org"

# Make specific changes
opencode run --agent editor "add input validation to the user registration form"

# Work through plan tasks
opencode run --agent editor "implement task 2.1 from the plan: add OAuth token refresh"
```

**Workflow**:
1. **Before each change**: "I'm going to [action] in [file] to [reason]"
2. **Approval prompt**: You approve or reject
3. **After approval**: "Applied change to [file]. [Brief explanation]"
4. **Between changes**: "Next, I'll [action]. Ready to proceed?"
5. **After completion**: "Changes complete. Suggested verification: [steps]"

**Working with Plans**:
The editor can read org-mode plan files and work through tasks systematically:
- Announces which task it's working on
- Breaks tasks into implementation steps
- Applies changes incrementally with approval
- Tracks progress mentally (doesn't modify the org file)

**Error Recovery**:
If a change fails:
1. Explains what went wrong
2. Suggests a fix or alternative
3. Offers to revert if needed
4. Learns from the error

---

### 4. focused-build (Primary Agent)

**Purpose**: Laser-focused implementation without exploration, documentation pollution, or temporary file artifacts.

**Key Features**:
- Fast, direct implementation with minimal exploration
- Automatic cleanup of temporary test files
- Only updates README.md and agent/*.md when features change
- Concise communication style
- Enforces code quality from CONVENTIONS.md
- No creation of temporary markdown documentation

**Configuration**:
- **Mode**: Primary
- **Model**: `anthropic/claude-sonnet-4-5`
- **Temperature**: 0.2 (very low for focused execution)
- **Permissions**:
  - ✅ Write/Edit: **ALLOW** (fast execution)
  - ⚠️ Markdown Files: **ASK** (prevents pollution)
  - ✅ README.md: **ALLOW**
  - ✅ agent/*.md: **ALLOW**
  - ⚠️ Git Commit: **ASK**
  - ❌ Sudo: **DENY**

**Strict Rules**:
1. **Never creates**: SUMMARY.md, CHANGES.md, IMPLEMENTATION.md, NOTES.md, or any temporary markdown files
2. **Always removes**: test-*.*, temp-*.*, scratch-*.*, debug-*.* files after completion
3. **Only updates docs** when: New features added, agent behavior changed, or conflicting information exists
4. **Preserves**: Official test files in tests/, __tests__/, spec/ directories

**When to Use**:
- Building new features without exploration
- Quick implementations where scope is clear
- Refactoring existing code
- Bug fixes that don't need discussion
- When you want clean execution without artifacts

**When NOT to Use**:
- Need to explore/understand codebase first → use `discussion`
- Complex feature requiring plan → use `org-planner` then `editor`
- Critical code requiring approval → use `editor`
- Want to discuss approaches → use `discussion`

**Usage Examples**:
```bash
# Direct implementation
opencode run --agent focused-build "add email validation to signup form"

# Bug fix
opencode run --agent focused-build "fix null pointer in user profile component"

# Feature implementation (when scope is clear)
opencode run --agent focused-build "implement password reset flow"
```

**Communication Style**:
```
✓ Task complete: Added email validation
Changes: src/components/SignupForm.vue, src/utils/validation.ts
Verified: Unit tests passing
Cleaned: test-validation.ts, temp-form.vue
```

**Cleanup Protocol**:
After each task, automatically removes:
- `test-*.{js,ts,php,vue,py}` (temporary test files)
- `temp-*.{js,ts,php,vue,py}` (temporary code files)
- `scratch-*.*` (scratch files)
- `debug-*.*` (debug files)

**Quality Standards**:
- Follows CONVENTIONS.md strictly (SOLID, security, performance)
- Uses framework features first (Laravel/Joomla/Symfony/Vue)
- Applies strict typing (PHP `declare(strict_types=1)`, TypeScript)
- Validates input, escapes output, uses prepared statements
- No exploration tangents or scope creep

---

### 5. debug (Primary Agent)

**Purpose**: Systematic bug hunting and root cause analysis through scientific method without codebase pollution.

**Key Features**:
- Methodical debugging workflow: Reproduce → Isolate → Hypothesize → Test → Fix
- Scientific approach to bug investigation
- Creates temporary debug artifacts during investigation, removes all after
- Evidence-based hypothesis testing
- Regression prevention verification
- Root cause focus (not symptom fixing)

**Configuration**:
- **Mode**: Primary
- **Model**: `anthropic/claude-sonnet-4-5`
- **Temperature**: 0.4 (balanced for creative hypothesis generation + focused execution)
- **Permissions**:
  - ✅ Write/Edit: **ALLOW** (fast debugging)
  - ✅ Debug Files: **ALLOW** (debug-*.*, reproduce-*.*)
  - ⚠️ Markdown Files: **ASK** (prevents pollution)
  - ✅ Git Bisect: **ALLOW** (finding regression points)
  - ⚠️ Git Commit: **ASK**
  - ❌ Sudo: **DENY**

**Debugging Workflow**:
1. **Reproduction**: Create minimal, reliable reproduction case
2. **Information Gathering**: Logs, git history, stack traces, code reading
3. **Hypothesis Formation**: 2-3 testable theories about root cause
4. **Hypothesis Testing**: Iteratively test with debug logging/isolation tests
5. **Fix Implementation**: Apply minimal fix addressing root cause
6. **Cleanup**: Remove ALL debug artifacts (debug-*.*, reproduce-*.*, console.log, etc.)
7. **Verification**: Regression tests + original bug fixed

**Debugging Techniques**:
- Log analysis (structured debug logging)
- Git bisection (finding when bug introduced)
- Binary search (code isolation)
- Comparison testing (working vs broken)
- Minimal reproduction cases
- Rubber duck debugging (explaining to clarify)

**When to Use**:
- Bug reports or unexpected behavior
- Production issues needing investigation
- Intermittent failures needing root cause analysis
- Performance problems needing profiling
- Memory leaks or resource issues
- Test failures needing diagnosis

**When NOT to Use**:
- Implementing new features → use `focused-build` or `editor`
- Exploring codebase → use `discussion`
- Planning refactors → use `org-planner`
- Quick fixes where cause is obvious → use `focused-build`

**Usage Examples**:
```bash
# Bug investigation
opencode run --agent debug "users can't login with @ symbol in username"

# Production issue
opencode run --agent debug "checkout process fails intermittently on Firefox"

# Performance problem
opencode run --agent debug "dashboard loads slowly with 1000+ items"

# Test failure
opencode run --agent debug "test suite failing after recent merge"
```

**Communication Style**:
```
🔍 Analyzing: auth/LoginController.php validation logic
💡 Hypothesis: Email regex doesn't properly escape @ symbol
🧪 Testing: Created reproduce-login-bug.test.ts
✓ Confirmed: Regex treats @ as special character
🔧 Fix: Escaped special chars in validation pattern
✓ Verified: All 127 tests passing, reproduction case passes
🧹 Cleaned: debug-validation.ts, reproduce-login-bug.test.ts
```

**Cleanup Protocol**:
Automatically removes before completion:
- `debug-*.{js,ts,php,vue,py,log}`
- `reproduce-*.{js,ts,php,vue,py}`
- `temp-*.{js,ts,php,vue,py}`
- All `console.log`, `var_dump`, `dd()`, `print()` statements
- Temporary comments with DEBUG, FIXME, XXX
- Temporary log files

**Quality Standards**:
- Scientific method: Every hypothesis must be tested
- Root cause focus: Fix the cause, not the symptom
- Regression prevention: Verify no other functionality broken
- Minimal invasiveness: Smallest change that fixes root cause
- Evidence-based: No guessing, no shotgun debugging
- Clean finish: Zero artifacts left in codebase

**Integration with Git**:
```bash
# Find when bug was introduced
git bisect start
git bisect bad HEAD
git bisect good v1.2.0
# Agent tests each commit automatically

# Investigate specific file history
git log -p --follow src/auth/LoginController.php
git blame src/auth/LoginController.php -L 45,55
```

---

### 6. figma-builder (Primary Agent)

**Purpose**: Translates Figma designs into pixel-perfect, production-ready frontend code using the Figma REST API.

**Key Features**:
- Fetches design data and screenshots directly from Figma via REST API
- Builds layouts with 1:1 visual fidelity to designs
- Uses design tokens and existing component library
- Accessibility-first approach (WCAG AA minimum)
- Performance optimized (lazy loading, WebP images)
- Strict TypeScript typing for all components
- Mobile-first responsive design

**Configuration**:
- **Mode**: Primary
- **Model**: `anthropic/claude-sonnet-4-5`
- **Temperature**: 0.2 (low for precision)
- **MCP Tools**:
  - ✅ Context7: Documentation lookup for frameworks
  - ✅ GitHub: Repository operations
- **API Access**:
  - ✅ Figma REST API: Uses Personal Access Token from `~/.secrets/figma-access-token`
- **Permissions**:
  - ✅ Write/Edit: **ALLOW** (fast implementation)
  - ⚠️ Bash (npm/yarn/pnpm/bun): **ASK**
  - ✅ Read/Grep/Glob: Enabled

**Figma REST API Workflow** (NEVER SKIP):
1. **Extract IDs**: Parse FILE_ID and NODE_ID from Figma URL
2. **Fetch Design Data**: `GET /v1/files/{file_id}/nodes?ids={node_id}`
3. **Get Screenshot**: `GET /v1/images/{file_id}?ids={node_id}&format=png&scale=2`
4. **Analyze Structure**: Parse JSON for colors, spacing, typography, layout
5. **Download Assets**: Export images/icons via Images API if needed
6. **Translate to Project**: Convert to project's design system and conventions
7. **Validate**: Verify 1:1 visual parity with Figma screenshot

**When to Use**:
- Implementing UI from Figma designs
- Building new components from design specs
- Creating responsive layouts
- Converting design mockups to code
- Ensuring pixel-perfect design fidelity

**When NOT to Use**:
- No Figma design available → use `focused-build` or `editor`
- Backend/API work → use `focused-build` or `editor`
- Bug fixes not related to UI → use `debug`
- Exploring design options → use `discussion`

**Usage Examples**:
```bash
# Build from Figma design (provide full Figma URL)
opencode run --agent figma-builder "implement this design: https://www.figma.com/file/abc123/MyDesign?node-id=123:456"

# Build component from Figma
opencode run --agent figma-builder "create ProductCard from https://www.figma.com/proto/xyz/Design?node-id=789:012"

# Responsive layout
opencode run --agent figma-builder "build dashboard layout from Figma with mobile/tablet/desktop breakpoints"
```

**Asset Handling Rules**:
- **Extract images** from Figma using Images API (`format=png` or `format=svg`)
- **Export icons as SVGs** from Figma (DO NOT import new icon packages)
- **Optimize images**: WebP format, lazy loading, appropriate sizes
- **Store assets** in project's assets directory with proper naming
- **Use design tokens** for colors, spacing, typography (extract from Figma variables)

**Code Quality Standards**:
- Semantic HTML (`<header>`, `<nav>`, `<main>`, `<section>`)
- Design tokens for all styling (no hardcoded values)
- Reuse existing components before creating new ones
- TypeScript types for all props and state
- WCAG AA accessibility minimum
- Keyboard navigation support
- Mobile-first responsive CSS

**Setup**:
See detailed setup guide: [`FIGMA-REST-API-SETUP.md`](./FIGMA-REST-API-SETUP.md)

Quick setup:
```bash
# 1. Create Personal Access Token at https://www.figma.com/settings
# 2. Save token
echo "YOUR_TOKEN" > ~/.secrets/figma-access-token
chmod 600 ~/.secrets/figma-access-token

# 3. Test with helper script
~/.config/opencode/figma-api-helper.sh all "https://www.figma.com/file/..."
```

**Communication Style**:
```
✓ Built LoginForm component from Figma design
Components: src/components/auth/LoginForm.vue
Design tokens: --color-primary-500, --spacing-4, --font-size-base
Accessibility: WCAG AA, keyboard nav, ARIA labels
Performance: Lazy loaded, WebP images, Lighthouse 95+
```

**Integration with Other Agents**:
- **org-planner**: Can create UI implementation plans
- **discussion**: Can explain design patterns and accessibility
- **editor**: Can make careful changes to existing components
- **web-tester**: Can write E2E tests for built components

---

### 7. build (Default Agent)

**Purpose**: Fast, autonomous development without approval prompts.

**Configuration**:
- Uses your global OpenCode configuration
- Full access to all tools (based on global settings)
- No special restrictions

**When to Use**:
- Trusted, routine changes
- Rapid prototyping
- When you're confident about the changes
- Working on non-critical code
- Time-sensitive fixes

**Usage**:
```bash
# Default agent (no flag needed)
opencode run "fix the login button alignment"

# Explicit
opencode run --agent build "add logging to the API endpoints"
```

---

## Recommended Workflows

### Workflow 1: Controlled Development (Most Thorough)

**Best for**: Complex features, critical code, learning

```bash
# Step 1: Plan
opencode run --command plan "add two-factor authentication"

# Step 2: Review Plan
cat plans/2024-11-01-two-factor-authentication.org

# Step 3: Implement with Approval
opencode run --agent editor "implement the 2FA plan"
# (Approve each change as you go)

# Step 4: Track Progress
# Open plan file in Emacs/VS Code and mark tasks as DONE
```

### Workflow 2: Explore Then Implement

**Best for**: Uncertain approaches, new technologies

```bash
# Step 1: Discuss and Explore
opencode run --agent discussion "what's the best approach for implementing rate limiting in our Express API?"

# Step 2: Create Plan
opencode run --command plan "implement Redis-based rate limiting with sliding window"

# Step 3: Implement Carefully
opencode run --agent editor "implement the rate limiting plan"
```

### Workflow 3: Focused Development (Clean & Fast)

**Best for**: Clear scope, no exploration needed, want clean repository

```bash
# Direct focused implementation
opencode run --agent focused-build "add email validation to signup form"

# With planning first
opencode run --command plan "implement caching layer"
opencode run --agent focused-build "implement the caching plan"

# Bug fix with cleanup
opencode run --agent focused-build "fix memory leak in user session handler"
```

**Benefits**:
- No temporary files left behind
- Only updates docs when necessary
- Concise, actionable output
- Fast execution without drift

### Workflow 4: Quick Development

**Best for**: Simple fixes, routine changes

```bash
# Option A: Plan first (recommended)
opencode run --command plan "add email validation to signup form"
opencode run --agent build "implement the validation plan"

# Option B: Direct implementation (faster but less controlled)
opencode run "add email validation to signup form"
```

### Workflow 5: Bug Investigation & Fix

**Best for**: Bugs, production issues, test failures, performance problems

```bash
# Direct debugging
opencode run --agent debug "users getting 500 error on checkout"

# Complex bug investigation
opencode run --agent debug "memory leak in long-running worker process"

# Test failure diagnosis
opencode run --agent debug "integration tests failing after migration"
```

**Workflow Steps**:
1. Agent reproduces bug reliably
2. Gathers evidence (logs, git history, stack traces)
3. Forms and tests hypotheses
4. Identifies root cause
5. Applies minimal fix
6. Verifies regression tests pass
7. Cleans up all debug artifacts
8. Reports findings

**Benefits**:
- Scientific, methodical approach
- Root cause identified (not just symptom fixed)
- Regression prevention
- Clean codebase (no debug artifacts left)
- Concise explanation of what was wrong

### Workflow 6: Figma-Driven UI Development

**Best for**: Building frontend from Figma designs, design system implementation

```bash
# Direct implementation from Figma
opencode run --agent figma-builder "build the user profile page from Figma node xyz789"

# With planning first (complex UI)
opencode run --command plan "implement dashboard layout from Figma"
opencode run --agent figma-builder "implement the dashboard plan using Figma designs"

# Component library from Figma
opencode run --agent figma-builder "create Button component variants from Figma design system"
```

**Workflow Steps**:
1. Agent fetches design context from Figma MCP
2. Gets screenshot for visual reference
3. Downloads required assets (images, icons)
4. Translates to project's design system
5. Builds with accessibility and performance
6. Validates against Figma design
7. Reports completion with metrics

**Benefits**:
- Pixel-perfect design fidelity
- Automatic asset handling from Figma
- Design tokens used consistently
- Accessibility built-in (WCAG AA)
- Performance optimized
- No manual asset downloads needed

### Workflow 7: Research → Plan → Implement

**Best for**: Learning new codebases, complex problems

```bash
# Step 1: Understand
opencode run --agent discussion "explain our current caching strategy and where Redis is used"

# Step 2: Explore
opencode run --agent discussion "how could we improve cache invalidation?"

# Step 3: Plan
opencode run --command plan "implement cache invalidation with Redis pub/sub"

# Step 4: Implement
opencode run --agent editor "implement the cache invalidation strategy"
```

---

## Custom Commands

### /plan Command

Quick shortcut to invoke the org-planner agent.

**Location**: `~/.config/opencode/command/plan.md`

**Usage**:
```bash
opencode run --command plan "your task description"

# From TUI
opencode
> /plan implement WebSocket notifications
```

**What It Does**:
- Invokes `org-planner` agent automatically
- Passes your description as the planning request
- Creates comprehensive development plan
- Saves to `plans/`

---

## Agent Selection Decision Tree

```
Need to...
├─ Understand/Learn/Discuss?
│  └─> discussion agent
│
├─ Plan a feature/change?
│  └─> org-planner agent (or /plan command)
│
├─ Build UI from Figma design?
│  └─> figma-builder agent (pixel-perfect layouts)
│
├─ Find and fix a bug?
│  └─> debug agent (systematic investigation)
│
├─ Implement with careful review?
│  └─> editor agent (asks for approval)
│
├─ Implement focused & clean?
│  └─> focused-build agent (fast, no artifacts)
│
└─ Implement quickly/standard?
   └─> build agent (default, no prompts)
```

---

## Permission System

### Permission Values

- **allow**: No approval needed - agent can act freely
- **ask**: Requires manual approval for each operation
- **deny**: Completely blocks the operation

### Permission Patterns

You can use glob patterns for fine-grained control:

```markdown
permission:
  edit:
    "src/*.ts": ask
    "tests/*": allow
    "*": deny
  bash:
    "npm test": allow
    "npm run build": allow
    "git *": ask
    "*": deny
```

### File Pattern Examples

```markdown
"*.sql": allow                    # All SQL files
"migrations/*": allow             # Everything in migrations/
"plans/*.org": allow  # Specific directory
"src/**/*.ts": ask                # All TypeScript files in src tree
"*": deny                         # Everything else (default deny)
```

---

## Org-Mode Integration

### Viewing Plans

**Emacs**:
```bash
emacs plans/2024-11-01-feature.org
```
- Use `C-c C-t` to cycle TODO states
- Use `C-c C-c` to toggle checkboxes
- Use `C-c C-s` to schedule tasks
- Use `C-c C-d` to set deadlines

**VS Code**:
- Install "Org Mode" extension
- Open .org files directly
- Basic TODO toggling support

**Plain Text Editor**:
- Any text editor works
- Manually change `TODO` to `DONE`
- Check off `[ ]` boxes as `[X]`

### TODO States

- `TODO` - Not started
- `IN-PROGRESS` - Currently working
- `DONE` - Completed
- `BLOCKED` - Waiting on dependency
- `CANCELLED` - No longer needed

### Priority Levels

- `[#A]` - High priority
- `[#B]` - Medium priority
- `[#C]` - Low priority

### Tags

Common tags in plans:
- `:backend:` - Backend code
- `:frontend:` - Frontend code
- `:api:` - API endpoints
- `:database:` - Database changes
- `:testing:` - Test implementation
- `:docs:` - Documentation
- `:security:` - Security-related
- `:performance:` - Performance optimization

---

## Tips & Best Practices

### 1. Always Plan Complex Changes
Use `org-planner` before implementing significant features. The plan serves as:
- Documentation of intent
- Checklist for implementation
- Reference for future developers

### 2. Use Discussion Agent When Uncertain
Before planning, use `discussion` to:
- Explore different approaches
- Understand existing code
- Learn about patterns and best practices

### 3. Use Editor Agent for Critical Code
Apply `editor` agent for:
- Security-sensitive code
- Data migrations
- API contract changes
- Production deployments

### 4. Keep Plans Updated
As you complete tasks:
- Mark items as `DONE` in the org file
- Add notes about implementation decisions
- Document any deviations from original plan

### 5. Archive Completed Plans
```bash
mkdir -p plans/archive
mv plans/2024-10-*.org plans/archive/
```

### 6. Model Override
Any agent can use any model:
```bash
opencode run --agent editor --model anthropic/claude-opus-4-20250514 "complex refactor"
```

### 7. Agent Switching
In TUI, use Tab to cycle through agents or type agent name directly.

---

## Customization

### Modifying Agents

Edit agent files in `~/.config/opencode/agent/`:

**Change Model**:
```markdown
---
model: anthropic/claude-opus-4-20250514
---
```

**Adjust Temperature**:
```markdown
---
temperature: 0.5  # 0.0 = deterministic, 1.0 = creative
---
```

**Modify Permissions**:
```markdown
---
permission:
  edit: deny
  bash: 
    "npm test": allow
    "*": ask
---
```

**Update Prompt**:
Edit the markdown content below the frontmatter.

### Creating New Agents

1. Create file: `~/.config/opencode/agent/my-agent.md`
2. Add frontmatter with configuration
3. Write system prompt
4. Restart OpenCode

Example:
```markdown
---
description: My custom agent
mode: primary
model: anthropic/claude-sonnet-4-20250514
temperature: 0.5
tools:
  write: true
  edit: true
---

Your custom instructions here...
```

---

## Troubleshooting

### Agent Not Available
1. Check file exists: `ls ~/.config/opencode/agent/`
2. Verify syntax: JSON frontmatter must be valid
3. Restart OpenCode

### Permission Errors
1. Check agent's permission configuration
2. Use `ask` instead of `deny` for testing
3. Review error message for specific denial reason

### Agent Using Wrong Model
1. Check agent frontmatter `model:` field
2. Override with `--model` flag
3. Verify model ID is correct for provider

### Plan Files Not Saving
1. Verify directory exists: `ls plans/`
2. Check org-planner permissions in frontmatter
3. Ensure path matches configuration

---

## Integration with Other Tools

### Git Integration
Agents can work with git (with approval):
```bash
opencode run --agent editor "commit changes with message 'Add authentication'"
```

### Testing Integration
Agents can run tests:
```bash
opencode run --agent editor "run tests after implementing the login feature"
```

### Asana Integration
With Asana MCP configured, agents can:
```bash
opencode run --agent discussion "summarize tasks in Asana Sprint 30 project"
opencode run --agent org-planner "create plan based on Asana task #123456"
```

---

## Security Considerations

### 1. Permission Boundaries
- `org-planner`: Can only write to plans directory
- `discussion`: Read-only, cannot modify anything
- `editor`: Asks for approval on every change

### 2. Sensitive Files
Add to agent permissions:
```markdown
permission:
  edit:
    "*.env": deny
    ".env.*": deny
    "secrets/*": deny
```

### 3. Dangerous Commands
```markdown
permission:
  bash:
    "rm -rf *": deny
    "sudo *": deny
    "curl * | bash": deny
```

### 4. Code Review
Always review changes before approving, especially:
- Authentication/authorization code
- Database migrations
- API endpoints
- File uploads
- Payment processing

---

## Performance Optimization

### 1. Model Selection
- Fast tasks: Use Haiku or smaller models
- Complex tasks: Use Sonnet or larger models
- Balance cost vs quality

### 2. Temperature Settings
- Structured output (plans): Low (0.1-0.3)
- Conversational: Medium (0.5-0.7)
- Creative brainstorming: High (0.8-1.0)

### 3. Context Management
- Use read selectively (not entire codebase)
- Plan before implementing (reduces iterations)
- Clear, specific prompts (reduces back-and-forth)

---

## Resources

### Documentation
- OpenCode Docs: https://opencode.ai/docs
- MCP Protocol: https://modelcontextprotocol.io
- Org-Mode: https://orgmode.org

### Local Docs
- Workflow Guide: `~/.config/opencode/WORKFLOW.md`
- Asana Setup: `~/.config/opencode/MCP-ASANA-OFFICIAL-SETUP.md`

### Support
- OpenCode GitHub: https://github.com/sst/opencode
- Report Issues: https://github.com/sst/opencode/issues

---

---

## Joomla Translation Workflow

A comprehensive system for translating Joomla components with automatic hardcoded string detection, conversion, and review.

### Overview

The translation workflow processes components **one view at a time** to ensure thoroughness and avoid LLM context overflow.

### Available Commands

| Command | Description |
|---------|-------------|
| `/translate-auto <path> <lang>` | **Recommended** - Fully automatic workflow with review loop |

### Plugin Tools (used automatically)

The workflow uses a plugin that provides these tools:

| Tool | Description |
|------|-------------|
| `workflow_translate_init` | Initialize workflow, scan component, create view queue |
| `workflow_translate_next` | Get next view to process |
| `workflow_translate_view_done` | Mark view as processed |
| `workflow_translate_review` | Submit review result (pass/fail) |
| `workflow_translate_status` | Get workflow status and progress |

### Quick Start (Automatic Mode)

```bash
# Run the fully automatic translation workflow
/translate-auto /path/to/administrator/components/com_mycomponent fr-CA
```

This will:
1. Scan the component and find all view files
2. For EACH view:
   - Detect all hardcoded strings
   - Convert to `Text::_()` calls
   - Update source INI (en-GB)
   - Translate to target language
   - **Review** - re-process if errors found (up to 3 attempts)
3. Generate final summary

### Manual Mode

If you prefer more control:

```bash
# Step 1: Create view queue
/workflow translate /path/to/com_lots fr-CA

# Step 2: Process each view one at a time
/translate-view next   # Process view 1
/translate-view next   # Process view 2
# ... repeat until all done
```

### Custom Tools

The translation system uses these custom tools:

| Tool | Purpose |
|------|---------|
| `i18n_hardcode_finder` | Find hardcoded strings in PHP/JS/Vue files |
| `i18n_convert` | Convert hardcoded strings to i18n calls |
| `i18n_extract` | Extract existing translated strings |
| `ini_builder` | Create/validate/compare INI language files |
| `file_chunker` | Split large files into processable chunks |
| `chunk_reader` | Read specific chunks |
| `chunk_state` | Track chunk processing progress |

### Translation Agents

| Agent | Role |
|-------|------|
| `translation-planner` | Scans component, creates view queue |
| `translation-coder` | Processes views, converts strings, translates |
| `translation-reviewer` | Validates conversions, checks for missed strings |

### Supported Languages

- `fr-CA` - French (Canadian) - uses OQLF terminology
- `fr-FR` - French (France)
- `es-ES` - Spanish (Spain)
- `es-MX` - Spanish (Mexico)
- `de-DE` - German
- `pt-BR` - Portuguese (Brazil)
- And more...

### French Canadian (fr-CA) Conventions

| English | Canadian French |
|---------|-----------------|
| email | courriel |
| upload | telecharger |
| download | telecharger |
| save | enregistrer |
| cancel | annuler |
| delete | supprimer |
| settings | parametres |

**Punctuation**: Space before `:` `;` `?` `!`
**Quotes**: Use guillemets (not "quotes")
**Formality**: Use formal "vous"

### Workflow State

State is tracked in JSON format by the plugin:
```
workflows/active/{workflow-id}/
└── workflow-state.json    # Complete state including all views
```

The state includes:
- Workflow metadata (component, languages, paths)
- List of all views with status (pending/processing/review/done/error)
- Attempt counts for retry logic
- Strings found/converted per view
- Error messages for failed views

### Troubleshooting

**Strings being missed?**
- The `i18n_hardcode_finder` tool has extensive patterns
- If patterns are still missing strings, they can be added to `tool/i18n-hardcode-finder.ts`

**View keeps failing review?**
- After 3 attempts, view is marked for manual fix
- Check the specific errors in the workflow state
- May need manual intervention for complex patterns

**Large files timing out?**
- Files >500 lines are automatically chunked
- Chunk size: 150 lines with 20-line overlap

---

## Changelog

### 2024-12-17
- Created comprehensive Joomla translation workflow
  - `/translate-auto` command for fully automatic processing
  - View-by-view processing to ensure thoroughness
  - Automatic review and retry loop (up to 3 attempts)
  - 7 custom tools for i18n operations
  - 3 specialized translation agents
  - Support for large files via chunking
  - French Canadian (fr-CA) OQLF terminology support

### 2024-11-25
- Created figma-builder agent for Figma-driven UI development
  - Integrates with Figma MCP server for design context and assets
  - Pixel-perfect implementation with 1:1 design fidelity
  - Accessibility-first approach (WCAG AA minimum)
  - Performance optimized (lazy loading, WebP images)
  - Uses design tokens and existing component library
  - Strict TypeScript typing for all components
  - Mobile-first responsive design
- Configured Figma MCP tools in opencode.json
  - Added figma_* tools globally (disabled by default)
  - Enabled for figma-builder agent specifically
  - Integrated with context7 and github tools

### 2024-11-20
- Created focused-build agent for clean, focused implementation
  - Prevents documentation pollution (no temporary markdown files)
  - Automatic cleanup of temporary test files
  - Only updates README/agent docs when features change
  - Low temperature (0.2) for focused execution
- Created debug agent for systematic bug investigation
  - Scientific debugging workflow (Reproduce → Hypothesize → Test → Fix)
  - Evidence-based hypothesis testing
  - Aggressive cleanup of debug artifacts
  - Regression prevention verification
  - Temperature 0.4 for balanced creativity + focus

### 2024-11-01
- Created org-planner agent with architect prompt
- Created discussion agent for technical conversations
- Created editor agent with ask permissions
- Added /plan custom command
- Set up org-mode integration with plans/
- Configured permissions for safe, controlled workflows

---

## License & Credits

These agents are custom configurations for OpenCode, an open-source project by SST.

OpenCode: https://github.com/sst/opencode
