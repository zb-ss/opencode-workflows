# OpenCode Workflows

A collection of agents, commands, skills, plugins, tools, and workflow templates for [OpenCode](https://github.com/sst/opencode).

> **Note:** Plans and workflow state are stored as [org-mode](https://orgmode.org/) files. While any text editor can read them, you'll get the best experience with Emacs — collapsible headings, TODO state cycling, timestamps, and native org support. VS Code users can install the [Org Mode extension](https://marketplace.visualstudio.com/items?itemName=vscode-org-mode.org-mode) for basic support.

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- [Node.js](https://nodejs.org/) v18+

### One-Liner

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
```

**Windows (PowerShell):**
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
node install.mjs                       # Install core with symlinks (default)
node install.mjs --copy                # Install core with file copies
node install.mjs --all                 # Install everything (core + translate)
node install.mjs --module translate    # Add the translate module
node install.mjs --dry-run             # Preview without making changes
node install.mjs --uninstall           # Remove all installed files
node install.mjs --help                # Show help
```

### Modules

| Module | Contents | Default |
|--------|----------|---------|
| **core** | 12 agents, 6 commands, 13 skills, 1 plugin, CONVENTIONS.md | Yes |
| **translate** | 3 agents, 2 commands, 8 tools, 1 plugin (Joomla i18n) | No |

### Post-Install

1. Edit `~/.config/opencode/opencode.jsonc` to configure MCP servers and API keys
2. Start OpenCode and verify agents are available

### Updating

- **Symlink mode** (default): `git pull` — changes propagate automatically
- **Copy mode**: `git pull && node install.mjs --copy`

### Uninstalling

```bash
node install.mjs --uninstall
```

Removes all installed symlinks/copies and the manifest. Your `opencode.jsonc` is never removed.

---

## What's Included

### Agents

| Agent | Purpose |
|-------|---------|
| **org-planner** | Creates development plans as org-mode files |
| **step-planner** | Interactive question-based planning |
| **discussion** | Technical Q&A, brainstorming (read-only) |
| **editor** | Code changes with manual approval for each edit |
| **focused-build** | Fast implementation, auto-cleanup of temp files |
| **debug** | Systematic bug hunting with scientific method |
| **review** | Code review against plans and conventions |
| **test-writer** | Unit and integration test generation |
| **web-tester** | E2E testing with Playwright/Chrome DevTools |
| **security-auditor** | OWASP Top 10 vulnerability analysis |
| **supervisor** | Orchestrates multi-step automated workflows |
| **figma-builder** | Pixel-perfect UI from Figma designs via REST API |

**Translate module** adds: `translation-planner`, `translation-coder`, `translation-reviewer`

See [AGENTS.md](./AGENTS.md) for detailed documentation on each agent.

### Commands

| Command | Description |
|---------|-------------|
| `/plan` | Create a development plan (invokes org-planner) |
| `/workflow` | Start an automated workflow (feature, figma, bug-fix, refactor, translate) |
| `/workflow-resume` | Resume an interrupted workflow |
| `/workflow-status` | Show status of active workflows |
| `/commit` | Commit staged changes with conventional commit message |
| `/pr` | Create a pull request |

**Translate module** adds: `/translate-auto`, `/translate-view`

### Skills

| Skill | Scope |
|-------|-------|
| php-conventions | Strict types, OOP, PSR standards |
| laravel-conventions | Eloquent, controllers, validation, services |
| symfony-conventions | Services, Doctrine, Twig, forms |
| joomla-conventions | Joomla 4/5 MVC, services, plugins |
| joomla3-legacy | Joomla 3.x JFactory, non-namespaced MVC |
| vue-conventions | Vue 3 Composition API, Pinia, TypeScript |
| vue2-legacy | Vue 2 Options API, Vuex, mixins |
| typescript-conventions | Strict mode, type patterns, Node.js/Deno |
| python-conventions | Type hints, pytest, async patterns |
| bash-conventions | Error handling, portability, shellcheck |
| solid-principles | SOLID with PHP/TypeScript examples |
| api-design | RESTful patterns, HTTP standards, versioning |
| performance-guide | PHP, JS, database, caching optimization |

### Workflow Templates

| Template | Steps |
|----------|-------|
| feature-development | Plan > Implement > Review > Test > Security > Commit |
| figma-to-code | Design Analysis > Build > Review > Test > A11y > Commit |
| bug-fix | Investigate > Plan Fix > Implement > Review > Test > Commit |
| refactor | Analyze > Plan > Implement > Review > Test > Commit |
| joomla-translation | Scan > Process Views > Review > Commit (translate module) |

See [WORKFLOWS.md](./WORKFLOWS.md) for workflow usage guide.

### Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| workflow-init.sh | UserPromptSubmit | Creates workflow org file from template |
| workflow-update.sh | PostToolUse | Updates org file with step results |
| workflow-permission-check.sh | PreToolUse | Blocks dangerous commands, auto-allows safe ones |

Hooks are **not** installed by the installer. Copy them to your OpenCode hooks directory manually if you want to use them.

### Translate Module Tools

| Tool | Purpose |
|------|---------|
| i18n-hardcode-finder | Find hardcoded strings in PHP/JS/Vue |
| i18n-convert | Convert strings to i18n calls with syntax validation |
| i18n-extract | Extract existing translated strings |
| i18n-verify | Verify translation completeness |
| ini-builder | Create/validate/sort INI language files |
| file-chunker | Split large files into processable chunks |
| chunk-reader | Read specific file chunks |
| chunk-state | Track chunk processing progress |

---

## Agent Selection

```
Need to...
├── Understand/Learn/Discuss?     → discussion
├── Plan a feature/change?        → org-planner (or /plan)
├── Build UI from Figma?          → figma-builder
├── Find and fix a bug?           → debug
├── Implement with review?        → editor (asks approval)
├── Implement fast & clean?       → focused-build (no artifacts)
└── Implement quickly?            → build (default, no prompts)
```

---

## Project Structure

```
opencode-workflows/
├── agent/           # Agent definitions (.md with YAML frontmatter)
├── command/         # Custom slash commands
├── skill/           # Coding convention skills
├── plugin/          # OpenCode plugins (TypeScript)
├── tool/            # Custom tools for translation (TypeScript)
├── templates/       # Workflow org-mode templates
├── hooks/           # Optional shell hooks
├── plans/           # Runtime: generated plan files (gitignored)
├── workflows/       # Runtime: workflow state (gitignored)
│   ├── active/
│   └── completed/
├── install.mjs      # Cross-platform installer
├── CONVENTIONS.md   # Coding standards (installed to config dir)
├── AGENTS.md        # Detailed agent documentation
└── WORKFLOWS.md     # Workflow usage guide
```

---

## Customization

### Modifying Agents

Agent files use YAML frontmatter for configuration:

```markdown
---
description: My custom agent
model: anthropic/claude-sonnet-4-5
temperature: 0.3
permission:
  edit: ask
  bash:
    "npm test": allow
    "*": ask
---

Your system prompt here...
```

In symlink mode, edit files directly in this repo. Changes take effect immediately.

### Creating New Agents

Add a `.md` file to `agent/` and re-run the installer (or create it directly in `~/.config/opencode/agent/`).

### Adding Workflow Templates

Add an `.org` file to `templates/`. The supervisor agent will pick it up automatically.

---

## License

MIT. Built for [OpenCode](https://github.com/sst/opencode).
