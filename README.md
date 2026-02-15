# OpenCode Workflows

A comprehensive collection of agents, commands, skills, plugins, and workflow templates for [OpenCode](https://opencode.ai).

> **Note**: This is v2.0 - a breaking rewrite with multi-model support, swarm execution, and zero-tolerance review system.

## Features

- **30 Agents**: 9 primary + 21 workflow specialists
- **5 Execution Modes**: eco, turbo, standard, thorough, swarm
- **4 Enforcement Plugins**: workflow-enforcer, file-validator, model-router, swarm-manager
- **Zero-Tolerance Review**: [ISSUE-N] tracking with auto-escalation
- **Model-Agnostic**: GLM-5, MiniMax M2.5, Gemini 3 Pro/Flash, GPT-4.1
- **E2E Testing Pipeline**: 6-phase Playwright workflow with accessibility-first selectors
- **Parallel Execution**: SDK-based swarm mode for 3-5x speed improvement
- **13 Skills**: PHP, Laravel, Vue, Joomla, Symfony, API design, and more
- **6 Commands, 6 Templates**: Complete automation toolkit

## Quick Start

```bash
git clone https://github.com/zb-ss/opencode-workflows.git ~/projects/opencode-workflows
cd ~/projects/opencode-workflows
node install.mjs
```

## Execution Modes

| Mode | Speed | Quality | Parallel | Reviewers | Use Case |
|------|-------|---------|----------|-----------|----------|
| **eco** | Fast | Basic | No | reviewer-lite | Prototypes, experiments |
| **turbo** | Fastest | Standard | No | 3x architect | Quick features, non-critical |
| **standard** | Medium | Good | No | reviewer | Production features |
| **thorough** | Slow | Excellent | No | reviewer-deep | Critical, security-sensitive |
| **swarm** | Fastest | Excellent | Yes (4x) | 3x architect | Large, modular projects |

## Agents

### Primary Agents (9)

| Agent | Purpose | Model Tier |
|-------|---------|------------|
| **org-planner** | Creates org-mode development plans | high |
| **step-planner** | Interactive question-based planning | high |
| **discussion** | Technical Q&A, read-only exploration | mid |
| **editor** | Meticulous code changes with approval | mid |
| **focused-build** | Fast implementation, auto-cleanup | mid |
| **debug** | Systematic bug hunting | mid |
| **supervisor** | Orchestrates multi-step workflows | high |
| **figma-builder** | Pixel-perfect UI from Figma | mid |
| **web-tester** | E2E testing with Playwright | mid |

### Workflow Agents (21)

| Agent | Role | Tier | Used By |
|-------|------|------|---------|
| architect | System design, planning | high | thorough, swarm |
| architect-lite | Quick architecture decisions | mid | turbo, standard |
| executor | Implementation with review cycles | mid | standard, thorough |
| executor-lite | Fast implementation | low | eco, turbo |
| reviewer | Full code review | mid | standard |
| reviewer-lite | Quick quality check | low | eco, turbo |
| reviewer-deep | Deep analysis | high | thorough |
| security | Security audit | mid | standard |
| security-lite | Basic security check | low | eco |
| security-deep | Advanced security analysis | high | thorough |
| perf-lite | Performance check | low | eco |
| perf-reviewer | Performance optimization | high | thorough |
| test-writer | Unit/integration test generation | mid | all modes |
| e2e-explorer | Application structure mapping (BFS) | mid | e2e workflow |
| e2e-generator | Playwright test generation | mid | e2e workflow |
| e2e-reviewer | Test validation (flakiness, anti-patterns) | mid | e2e workflow |
| quality-gate | Final quality checks | mid | all modes |
| completion-guard | Post-workflow validation | mid | all modes |
| explorer | Codebase exploration | low | all modes |
| codebase-analyzer | Dependency and structure analysis | mid | thorough |
| doc-writer | Documentation generation | low | all modes |

## Configuration

Customize `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "workflows": {
    "model_tiers": {
      "low": "gemini/3-flash",
      "mid": "glm-5",
      "high": "openai/gpt-4.1"
    },
    "fallback_chain": ["high", "mid", "low"],
    "swarm": {
      "enabled": true,
      "max_parallel_agents": 4
    },
    "review": {
      "zero_tolerance": true,
      "max_iterations": {
        "lite": 2,
        "standard": 3,
        "deep": 5
      }
    }
  }
}
```

## Documentation

- [Model Compatibility](./docs/model-compatibility.md) - Multi-model setup, tier configuration, fallback chains
- [Review System](./docs/review-system.md) - Zero-tolerance protocol, [ISSUE-N] format, escalation
- [Swarm Mode](./docs/swarm-mode.md) - Parallel execution, SDK spawning, 3-architect validation
- [E2E Testing](./docs/e2e-testing.md) - 6-phase Playwright pipeline, selector priority, flakiness detection
- [AGENTS.md](./AGENTS.md) - Comprehensive agent reference
- [WORKFLOWS.md](./WORKFLOWS.md) - Workflow lifecycle, mode selection, templates

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Create development plan (org-planner) |
| `/workflow` | Start automated workflow (feature, figma, bug-fix, refactor, e2e) |
| `/workflow-resume` | Resume interrupted workflow |
| `/workflow-status` | Show workflow status |
| `/commit` | Commit with conventional commit message |
| `/pr` | Create pull request |

**Translate module** (optional): `/translate-auto`, `/translate-view`

## Skills

| Skill | Scope |
|-------|-------|
| php-conventions | Strict types, OOP, PSR standards |
| laravel-conventions | Eloquent, services, validation |
| symfony-conventions | Doctrine, Twig, services |
| joomla-conventions | Joomla 4/5 MVC, plugins |
| joomla3-legacy | Joomla 3.x legacy patterns |
| vue-conventions | Vue 3 Composition API, Pinia |
| vue2-legacy | Vue 2 Options API, Vuex |
| typescript-conventions | Strict mode, type patterns |
| python-conventions | Type hints, pytest, async |
| bash-conventions | Shellcheck, portability |
| solid-principles | SOLID with code examples |
| api-design | RESTful patterns, versioning |
| performance-guide | Optimization strategies |

## Templates

| Template | Phases | Modes |
|----------|--------|-------|
| feature-development | Plan → Implement → Review → Test → Security | All |
| figma-to-code | Design → Build → Review → E2E → A11y | Standard, Thorough |
| bug-fix | Investigate → Fix → Review → Test | All |
| refactor | Analyze → Plan → Implement → Review | Standard, Thorough |
| e2e-testing | Setup → Explore → Generate → Validate → QA | All |
| joomla-translation | Scan → Process → Review (translate module) | Standard |

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) installed
- [Node.js](https://nodejs.org/) v18+

### One-Liner

**Linux/macOS**:
```bash
curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
```

**Windows (PowerShell)**:
```powershell
curl.exe -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
```

### Manual Install

```bash
git clone https://github.com/zb-ss/opencode-workflows.git
cd opencode-workflows
node install.mjs
```

Both methods install the **core** module via symlinks into `~/.config/opencode/`. On Windows, copy mode is used by default since symlinks require Developer Mode.

### Install Options

```bash
node install.mjs                  # Core (symlinks)
node install.mjs --copy           # Core (copies)
node install.mjs --all            # Core + translate module
node install.mjs --dry-run        # Preview
node install.mjs --uninstall      # Remove
```

### Bootstrap Environment Variables

The bootstrap installer supports the following environment variables:

- `INSTALL_DIR=~/my/path` — Custom clone location (default: `~/.local/share/opencode-workflows`)
- `INSTALL_MODE=copy` — Copy files instead of symlinks
- `INSTALL_MODULES=all` — Install all modules including translate

Example:
```bash
INSTALL_DIR=~/projects/opencode-workflows curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
```

### Post-Install

1. Review/edit `~/.config/opencode/opencode.jsonc` for model tiers and API keys
2. Start OpenCode and verify agents are available

### Updating

- **Symlink mode** (default): `git pull` — changes propagate automatically
- **Copy mode**: `git pull && node install.mjs --copy`

### Uninstalling

```bash
node install.mjs --uninstall
```

Removes all installed symlinks/copies and the manifest. Your `opencode.jsonc` is never removed.

### Modules

| Module | Contents | Default |
|--------|----------|---------|
| **core** | 30 agents, 6 commands, 13 skills, 4 plugins | Yes |
| **translate** | 3 agents, 2 commands, 8 tools (Joomla i18n) | No |

## Examples

### Feature Development (Standard Mode)
```bash
/workflow feature Add JWT authentication with refresh tokens
```

**Flow**:
1. Architect: Design auth system
2. Executor: Implement with review cycles
3. Reviewer: Code review (zero-tolerance)
4. Test-writer: Unit/integration tests
5. Security: OWASP audit
6. Completion-guard: Final check

### E2E Testing Workflow
```bash
/workflow e2e http://localhost:3000 "Test checkout flow"
```

**Flow**:
1. Explorer: BFS crawl, generate app-map.json
2. Generator: Create Playwright tests (accessibility-first selectors)
3. Reviewer: Run 3x, detect flakiness, check anti-patterns
4. Quality-gate: Final validation

### Swarm Mode (Parallel)
```bash
opencode run --mode swarm "Implement shopping cart feature"
```

**Flow**:
1. Architect: Break into 4 independent tasks
2. Executors (4x parallel): Implement simultaneously
3. Architects (3x parallel): Validate by consensus
4. Quality-gate: Final check

**Time**: ~1/3 of sequential mode

## Project Structure

```
opencode-workflows/
├── agent/
│   ├── primary/            # 9 primary agents
│   └── workflow/           # 21 workflow agents
├── command/                # 6 slash commands
├── skill/                  # 13 coding conventions
├── plugin/                 # 4 enforcement plugins
├── mode/                   # 5 execution mode configs
├── templates/              # 6 workflow templates
├── tool/                   # Translation tools (optional)
├── docs/                   # Comprehensive documentation
├── install.mjs             # Cross-platform installer
├── opencode.jsonc.template # Configuration template
├── CONVENTIONS.md          # Coding standards
├── AGENTS.md               # Agent reference
└── WORKFLOWS.md            # Workflow guide
```

## Customization

### Modify Agents

Edit agent files directly (symlink mode):
```bash
vim agent/workflow/executor.md
```

Changes take effect immediately.

### Add New Agent

```bash
cp agent/workflow/executor.md agent/workflow/my-custom-agent.md
# Edit, then
node install.mjs  # Re-symlink
```

### Create Mode

```bash
vim mode/my-mode.json
```

```json
{
  "name": "my-mode",
  "description": "Custom execution mode",
  "gates": ["architect-lite", "executor", "reviewer"],
  "parallel_execution": false,
  "model_tier": "mid"
}
```

## License

MIT. Built for [OpenCode](https://opencode.ai).

## Contributing

1. Fork the repo
2. Create feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -m "feat: add my feature"`
4. Push: `git push origin feature/my-feature`
5. Create pull request

## Changelog

### v2.0 (2026-02-14)
- Breaking rewrite with multi-model support
- Added 21 workflow specialist agents
- Implemented 5 execution modes
- Zero-tolerance review system with [ISSUE-N] tracking
- SDK-based swarm mode for parallel execution
- 6-phase E2E testing pipeline
- Model tier system with fallback chains
- 4 enforcement plugins

### v1.0 (2025-12-06)
- Initial release
- 12 agents, 6 commands, 13 skills
- Basic workflow system
- Translation module
