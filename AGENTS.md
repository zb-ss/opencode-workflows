# Agents

Detailed documentation for each agent included in opencode-workflows.

---

## org-planner

Creates detailed, architectural-level development plans saved as org-mode files.

- **Model**: configurable (default: `anthropic/claude-opus-4-5`)
- **Temperature**: 0.1
- **Permissions**: Write to `plans/*.org` only. No edit, no bash.

**Features:**
- Expert architect providing direction to implementation agents
- Hierarchical task breakdowns with TODO states, priorities, and tags
- Saves plans to `plans/` with date prefixes (e.g., `2025-02-09-feature-name.org`)
- Focuses on *what* needs to change and *why*, not *how*

**Usage:**
```bash
/plan implement OAuth authentication with Google
opencode run --agent org-planner "refactor payment processing module"
```

---

## step-planner

Interactive question-based planning through sequential thinking.

- **Model**: configurable
- **Temperature**: 0.1
- **Permissions**: Write, edit, bash (ask)

**Features:**
- Asks strategic questions one at a time to build understanding
- Iteratively refines plans based on answers
- Includes complexity scores (0-10) for each task
- Produces org-mode plans like org-planner

---

## discussion

Technical advisor for Q&A, brainstorming, and code exploration. Read-only.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-20250514`)
- **Temperature**: 0.7
- **Permissions**: Read, grep, glob only. No write, edit, or bash.

**Features:**
- Explores code without making modifications
- Provides multiple perspectives with pros/cons
- Suggests which agent to switch to for implementation

**Usage:**
```bash
opencode run --agent discussion "explain the current authentication flow"
opencode run --agent discussion "pros and cons of Redis vs Memcached?"
```

---

## editor

Meticulous code changes with manual approval for every modification.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-20250514`)
- **Temperature**: 0.3
- **Permissions**: All tools set to **ask** (prompts before every operation)

**Features:**
- Incremental, small changes one at a time
- Communicates intent before and after each change
- Reads files before editing for full context
- Works through org-mode plan files systematically

**Usage:**
```bash
opencode run --agent editor "implement the authentication plan from plans/2025-02-09-auth.org"
opencode run --agent editor "add input validation to the registration form"
```

---

## focused-build

Fast, focused implementation without exploration or temporary file artifacts.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-5`)
- **Temperature**: 0.2
- **Permissions**: Write/edit allowed. Markdown files require approval. Sudo denied.

**Features:**
- Direct implementation with minimal exploration
- Auto-cleanup of `test-*`, `temp-*`, `scratch-*`, `debug-*` files
- Never creates temporary markdown (SUMMARY.md, CHANGES.md, etc.)
- Enforces CONVENTIONS.md quality standards

**Usage:**
```bash
opencode run --agent focused-build "add email validation to signup form"
opencode run --agent focused-build "fix null pointer in user profile component"
```

---

## debug

Systematic bug hunting through scientific method. Cleans up all debug artifacts.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-5`)
- **Temperature**: 0.4
- **Permissions**: Write/edit allowed. Git bisect allowed. Sudo denied.

**Debugging workflow:**
1. **Reproduce** — Create minimal reproduction case
2. **Gather** — Logs, git history, stack traces
3. **Hypothesize** — 2-3 testable theories
4. **Test** — Iteratively validate hypotheses
5. **Fix** — Minimal change addressing root cause
6. **Cleanup** — Remove ALL debug artifacts
7. **Verify** — Regression tests pass

**Usage:**
```bash
opencode run --agent debug "users can't login with @ symbol in username"
opencode run --agent debug "dashboard loads slowly with 1000+ items"
```

---

## review

Code review against plans and coding conventions.

- **Mode**: subagent (invoked by supervisor during workflows)
- **Permissions**: Read-only

**Features:**
- Verifies planned features are implemented
- Checks code quality, security, and test coverage
- Reports issues with severity levels

---

## test-writer

Generates unit and integration tests.

- **Mode**: subagent
- **Permissions**: Write, edit, bash allowed

**Features:**
- Follows project testing conventions
- Creates meaningful tests, not just line coverage
- Covers edge cases and error handling

---

## web-tester

E2E testing and accessibility auditing with browser tools.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-5`)
- **MCP Tools**: Playwright, Chrome DevTools, Context7
- **Permissions**: Write/edit allowed. Browser commands allowed.

**Features:**
- Writes and runs E2E tests with Playwright
- Visual regression testing with screenshots
- WCAG AA accessibility compliance checks
- Keyboard navigation verification

---

## security-auditor

Security vulnerability analysis following OWASP Top 10.

- **Mode**: subagent
- **Permissions**: Read, bash (limited)

**Features:**
- Input validation review
- Authentication/authorization analysis
- Data exposure risk assessment
- Dependency vulnerability scanning
- Reports findings with severity levels and remediation steps

---

## supervisor

Orchestrates multi-step automated workflows from start to finish.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-5`)
- **Temperature**: 0.2
- **Permissions**: Full access (with safety guards for destructive git operations)

**Features:**
- Manages workflow state in org-mode files
- Invokes specialized agents sequentially
- Handles errors gracefully with pause/resume
- Sends desktop notifications on completions and failures
- Supports interruption and resumption

**Invoked via:** `/workflow`, `/workflow-resume`, `/workflow-status`

See [WORKFLOWS.md](./WORKFLOWS.md) for workflow usage details.

---

## figma-builder

Translates Figma designs into pixel-perfect frontend code via the Figma REST API.

- **Model**: configurable (default: `anthropic/claude-sonnet-4-5`)
- **Temperature**: 0.2
- **MCP Tools**: Context7
- **Permissions**: Write/edit allowed. Package manager commands require approval.

**Workflow:**
1. Parse Figma URL for file and node IDs
2. Fetch design data via `GET /v1/files/{file_id}/nodes`
3. Get screenshot via `GET /v1/images/{file_id}`
4. Analyze colors, spacing, typography, layout from JSON
5. Export images/icons via Images API
6. Build components matching project's design system
7. Validate 1:1 visual parity

**Features:**
- Accessibility-first (WCAG AA minimum)
- Design tokens for all styling
- Mobile-first responsive CSS
- Semantic HTML structure

**Setup:**
```bash
# Save Figma Personal Access Token
echo "YOUR_TOKEN" > ~/.secrets/figma-access-token
chmod 600 ~/.secrets/figma-access-token
```

---

## Translation Agents (translate module)

### translation-planner

Scans Joomla components and creates a view queue for processing.

- **Mode**: subagent
- Does NOT process files — only scans and creates the queue
- Orders views by priority (edit views first, then lists, then others)

### translation-coder

Processes one view file at a time for i18n conversion.

- **Mode**: subagent
- Uses chunking for files > 500 lines
- Converts hardcoded strings to `Text::_()` calls
- Updates both source (en-GB) and target language INI files
- Validates PHP syntax after each conversion

### translation-reviewer

Validates translation conversions and checks for missed strings.

- **Mode**: subagent
- Re-reads processed files to verify completeness
- Fails review if large files report suspiciously few strings
- Up to 3 retry attempts before marking for manual fix

---

## Permission System

Agents use three permission levels in their frontmatter:

| Level | Behavior |
|-------|----------|
| **allow** | No approval needed |
| **ask** | Prompts user before each operation |
| **deny** | Completely blocked |

Permissions can use glob patterns for fine-grained control:

```yaml
permission:
  edit:
    "src/**/*.ts": ask
    "tests/*": allow
    "*": deny
  bash:
    "npm test": allow
    "git commit*": ask
    "*": deny
```
