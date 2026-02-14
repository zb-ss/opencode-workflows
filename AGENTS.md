# Agent Reference

Complete documentation for all 30 agents in OpenCode Workflows v2.0.

## Primary Agents (9)

### org-planner

Creates detailed architectural development plans as org-mode files.

- **Model**: high tier (GPT-4.1, Gemini 3 Pro)
- **Temperature**: 0.1
- **Permissions**: Write to `plans/*.org` only

**When to Use**:
- Planning new features
- Architecting complex systems
- Breaking down large projects

**Key Features**:
- Hierarchical task breakdowns
- TODO states, priorities, tags
- Saves to `plans/` with timestamps
- Focuses on *what* and *why*, not *how*

**Usage**:
```bash
/plan implement OAuth authentication
opencode run --agent org-planner "refactor payment module"
```

---

### step-planner

Interactive question-based planning through sequential thinking.

- **Model**: high tier
- **Temperature**: 0.1
- **Permissions**: Write, edit, bash (ask)

**When to Use**:
- Exploring unclear requirements
- Collaborative planning sessions
- Iterative plan refinement

**Key Features**:
- Asks strategic questions one at a time
- Iteratively refines understanding
- Includes complexity scores (0-10)
- Produces org-mode plans

**Usage**:
```bash
opencode run --agent step-planner "design notification system"
```

---

### discussion

Technical advisor for Q&A, brainstorming, code exploration. Read-only.

- **Model**: mid tier (GLM-5, MiniMax)
- **Temperature**: 0.7
- **Permissions**: Read, grep, glob only

**When to Use**:
- Understanding existing code
- Exploring technical options
- Architecture discussions
- Learning codebase patterns

**Key Features**:
- No modifications (safe exploration)
- Multiple perspectives with pros/cons
- Suggests next agent to use

**Usage**:
```bash
opencode run --agent discussion "explain auth flow"
opencode run --agent discussion "Redis vs Memcached?"
```

---

### editor

Meticulous code changes with manual approval for every modification.

- **Model**: mid tier
- **Temperature**: 0.3
- **Permissions**: All tools → ask

**When to Use**:
- Critical production code
- Changes requiring oversight
- Learning how changes work
- High-stakes refactoring

**Key Features**:
- Prompts before every operation
- Incremental, small changes
- Communicates intent clearly
- Works through plans systematically

**Usage**:
```bash
opencode run --agent editor "implement auth plan from plans/2025-02-09-auth.org"
```

---

### focused-build

Fast, focused implementation without exploration or temporary artifacts.

- **Model**: mid tier
- **Temperature**: 0.2
- **Permissions**: Write/edit allowed, markdown requires approval

**When to Use**:
- Quick feature implementation
- Bug fixes
- Refactoring
- Prototyping

**Key Features**:
- Direct implementation, minimal exploration
- Auto-cleanup: `test-*`, `temp-*`, `scratch-*`, `debug-*`
- Never creates summary markdown
- Enforces CONVENTIONS.md
- Updates README.md only when new features added

**Usage**:
```bash
opencode run --agent focused-build "add email validation to signup"
opencode run --agent focused-build "fix null pointer in profile"
```

---

### debug

Systematic bug hunting using scientific method. Cleans up all debug artifacts.

- **Model**: mid tier
- **Temperature**: 0.4
- **Permissions**: Write/edit allowed, git bisect allowed

**When to Use**:
- Hard-to-reproduce bugs
- Performance issues
- Regression hunting
- Systematic debugging

**Key Features**:
- Scientific method: reproduce → gather → hypothesize → test → fix
- Minimal changes addressing root cause
- Cleans up ALL debug artifacts
- Git bisect support

**Usage**:
```bash
opencode run --agent debug "users can't login with @ in username"
opencode run --agent debug "dashboard slow with 1000+ items"
```

---

### supervisor

Orchestrates multi-step automated workflows from start to finish.

- **Model**: high tier
- **Temperature**: 0.2
- **Permissions**: Full access (with safety guards)

**When to Use**:
- Automated feature development
- Figma-to-code workflows
- Bug fix pipelines
- Refactoring workflows
- E2E test generation

**Key Features**:
- Manages workflow state in org files
- Invokes specialized agents sequentially or in parallel
- Handles errors with pause/resume
- Desktop notifications
- Supports interruption and resumption

**Usage**:
```bash
/workflow feature Add JWT authentication
/workflow e2e http://localhost:3000 "Test checkout"
```

---

### figma-builder

Translates Figma designs into pixel-perfect frontend code via Figma REST API.

- **Model**: mid tier
- **Temperature**: 0.2
- **MCP Tools**: Figma API, Context7
- **Permissions**: Write/edit allowed

**When to Use**:
- Building UI from Figma designs
- Design system implementation
- Pixel-perfect prototypes

**Key Features**:
- Fetches design data via Figma REST API
- Analyzes colors, spacing, typography
- Exports images/icons
- Accessibility-first (WCAG AA minimum)
- Design tokens for styling
- Mobile-first responsive CSS

**Setup**:
```bash
echo "YOUR_TOKEN" > ~/.secrets/figma-access-token
chmod 600 ~/.secrets/figma-access-token
```

**Usage**:
```bash
/workflow figma https://figma.com/file/ABC/Design?node-id=1:2 Dashboard header
```

---

### web-tester

E2E testing and accessibility auditing with Playwright.

- **Model**: mid tier
- **MCP Tools**: Playwright, Chrome DevTools
- **Permissions**: Write/edit allowed, browser commands allowed

**When to Use**:
- E2E test creation
- Visual regression testing
- Accessibility compliance checks
- Browser automation

**Key Features**:
- Writes and runs Playwright tests
- Visual regression with screenshots
- WCAG AA accessibility checks
- Keyboard navigation verification

**Usage**:
```bash
opencode run --agent web-tester "test login flow"
```

---

## Workflow Agents (21)

### architect

System design and architectural planning.

- **Tier**: high
- **Used By**: thorough, swarm
- **Gates**: planning

**Features**:
- Comprehensive system design
- Technology selection
- Database schema design
- API contract definition
- Identifies design patterns

---

### architect-lite

Quick architecture decisions for standard features.

- **Tier**: mid
- **Used By**: turbo, standard
- **Gates**: planning

**Features**:
- Fast architectural decisions
- Standard patterns
- Quick tech stack selection

---

### executor

Implementation with built-in review cycles.

- **Tier**: mid
- **Used By**: standard, thorough
- **Gates**: implementation

**Features**:
- Implements according to plan
- Self-reviews after major changes
- Iterates based on feedback
- Validates syntax/linting

---

### executor-lite

Fast implementation without extensive review.

- **Tier**: low
- **Used By**: eco, turbo
- **Gates**: implementation

**Features**:
- Quick implementation
- Basic validation only
- Optimized for speed

---

### reviewer

Full code review against plan and conventions.

- **Tier**: mid
- **Used By**: standard
- **Gates**: implementation_review, final_review
- **Max Iterations**: 3

**Features**:
- Zero-tolerance review (PASS requires 0 issues)
- [ISSUE-N] tracking format
- Checks code quality, security, tests
- Auto-escalates after max iterations

---

### reviewer-lite

Quick quality check for basic issues.

- **Tier**: low
- **Used By**: eco, turbo
- **Gates**: final_review
- **Max Iterations**: 2

**Features**:
- Fast review cycle
- Focuses on critical issues
- Basic security checks

---

### reviewer-deep

Deep analysis for critical code.

- **Tier**: high
- **Used By**: thorough
- **Gates**: implementation_review, testing_review, security_review
- **Max Iterations**: 5

**Features**:
- Comprehensive analysis
- Architecture review
- Performance analysis
- Advanced security checks

---

### security

Comprehensive security audit.

- **Tier**: mid
- **Used By**: standard
- **Gates**: security_audit

**Features**:
- OWASP Top 10 checks
- Input validation review
- Auth/authz analysis
- Dependency vulnerability scan

---

### security-lite

Basic security checks.

- **Tier**: low
- **Used By**: eco
- **Gates**: security_audit

**Features**:
- Quick security scan
- Common vulnerability patterns
- Basic input validation check

---

### security-deep

Advanced security analysis.

- **Tier**: high
- **Used By**: thorough
- **Gates**: security_review

**Features**:
- Cryptography review
- Advanced threat modeling
- Side-channel analysis
- Supply chain security

---

### perf-lite

Quick performance check.

- **Tier**: low
- **Used By**: eco, turbo
- **Gates**: performance_check

**Features**:
- Obvious performance issues
- N+1 query detection
- Large file operations
- Basic optimization suggestions

---

### perf-reviewer

Comprehensive performance optimization.

- **Tier**: high
- **Used By**: thorough
- **Gates**: performance_review

**Features**:
- Profiling analysis
- Database query optimization
- Caching strategy
- Load testing recommendations

---

### test-writer

Unit and integration test generation.

- **Tier**: mid
- **Used By**: all modes
- **Gates**: testing

**Features**:
- Follows project test conventions
- Meaningful tests, not just coverage
- Edge cases and error handling
- Integration test scenarios

---

### e2e-explorer

Application structure mapping via BFS traversal.

- **Tier**: mid
- **Used By**: e2e workflow
- **Phase**: exploration

**Features**:
- Crawls application starting from root URL
- Breadth-first search traversal
- Identifies pages, forms, interactive elements
- Generates `app-map.json`

**Output Example**:
```json
{
  "pages": [
    { "url": "/login", "forms": [...], "buttons": [...] }
  ]
}
```

---

### e2e-generator

Playwright test generation with accessibility-first selectors.

- **Tier**: mid
- **Used By**: e2e workflow
- **Phase**: generation

**Features**:
- Reads `app-map.json`
- Generates test files per page/feature
- Enforces selector priority: getByRole > getByLabel > getByPlaceholder > getByText > getByTestId
- CSS selectors and XPath FORBIDDEN
- Creates happy path and error scenarios

**Selector Priority**:
1. `getByRole()` - ARIA roles
2. `getByLabel()` - Form labels
3. `getByPlaceholder()` - Input placeholders
4. `getByText()` - Visible text
5. `getByTestId()` - data-testid (last resort)

---

### e2e-reviewer

Test validation: flakiness detection and anti-pattern checks.

- **Tier**: mid
- **Used By**: e2e workflow
- **Phase**: validation

**Features**:
- Runs each test 3x to detect flakiness
- Checks for anti-patterns:
  - CSS selector usage (CRITICAL)
  - XPath selector usage (CRITICAL)
  - Hardcoded waits (MAJOR)
  - Missing assertions (MAJOR)
- Reports using [ISSUE-N] format

**Flakiness Detection**:
- 3/3 pass → stable
- 2/3 pass → flaky (MAJOR issue)
- 1/3 pass → very flaky (CRITICAL issue)

---

### quality-gate

Final quality checks before workflow completion.

- **Tier**: mid
- **Used By**: all modes
- **Gates**: quality_gate

**Features**:
- Runs full test suite
- Checks code coverage
- Validates no skipped tests
- Linting/syntax validation
- Final PASS/FAIL verdict

---

### completion-guard

Post-workflow validation and cleanup.

- **Tier**: mid
- **Used By**: all modes
- **Gates**: completion

**Features**:
- Verifies workflow objectives met
- Checks all gates passed
- Validates clean git status (if applicable)
- Archives workflow state

---

### explorer

Codebase exploration for understanding structure.

- **Tier**: low
- **Used By**: all modes
- **Gates**: exploration (optional)

**Features**:
- Maps directory structure
- Identifies dependencies
- Finds entry points
- Detects frameworks/libraries

---

### codebase-analyzer

Deep dependency and structure analysis.

- **Tier**: mid
- **Used By**: thorough
- **Gates**: analysis

**Features**:
- Dependency graph generation
- Circular dependency detection
- Dead code identification
- Module coupling analysis

---

### doc-writer

Documentation generation.

- **Tier**: low
- **Used By**: all modes (optional)
- **Gates**: documentation

**Features**:
- Generates README updates
- API documentation
- Code comments
- Architecture diagrams (mermaid)

---

## Agent Selection Guide

```
Task Type                          → Agent
─────────────────────────────────────────────
Planning complex feature           → org-planner
Planning with questions            → step-planner
Understanding code                 → discussion
Quick feature                      → focused-build
Critical production change         → editor
Bug investigation                  → debug
Automated workflow                 → supervisor
Figma to code                      → figma-builder
E2E testing                        → web-tester
```

```
Workflow Mode                      → Agents Used
─────────────────────────────────────────────
eco                               → architect-lite, executor-lite, reviewer-lite, security-lite
turbo                             → architect-lite, executor-lite, 3x architect (parallel)
standard                          → architect, executor, reviewer, security, test-writer
thorough                          → architect, executor, reviewer-deep, security-deep, perf-reviewer
swarm                             → architect, 4x executor (parallel), 3x architect (parallel)
```

## Permission System

Agents use YAML frontmatter for permissions:

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

**Levels**:
- `allow` - No approval needed
- `ask` - Prompts user
- `deny` - Completely blocked

## Model Tier Assignment

Configure in `opencode.jsonc`:

```jsonc
{
  "workflows": {
    "model_tiers": {
      "low": "gemini/3-flash",
      "mid": "glm-5",
      "high": "openai/gpt-4.1"
    }
  }
}
```

Agents automatically use their assigned tier model with fallback chain.

## See Also

- [docs/model-compatibility.md](./docs/model-compatibility.md) - Model configuration
- [docs/review-system.md](./docs/review-system.md) - Zero-tolerance review protocol
- [docs/swarm-mode.md](./docs/swarm-mode.md) - Parallel execution
- [docs/e2e-testing.md](./docs/e2e-testing.md) - E2E testing pipeline
- [WORKFLOWS.md](./WORKFLOWS.md) - Workflow guide
