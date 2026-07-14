# Coding Conventions (Core Rules)

## Philosophy
1. **Maintainability & Readability** - Code should be easy to understand, modify, and debug
2. **Performance & Security First** - Non-negotiable. State trade-offs explicitly
3. **Leverage the Framework** - Use built-in features before custom solutions
4. **Explicit > Implicit** - Avoid magic. Behavior should be clear from reading code

## SOLID Principles (Always Apply)
- **SRP**: One responsibility per class/method
- **OCP**: Open for extension, closed for modification
- **LSP**: Subtypes must be substitutable for base types
- **ISP**: Small, specific interfaces over large ones
- **DIP**: Depend on abstractions, not concretions

## Universal Naming Conventions
| Element | Style | Example |
|---------|-------|---------|
| Classes, Interfaces, Traits | `PascalCase` | `UserService`, `OrderRepositoryInterface` |
| Methods | `camelCase` | `getUserById()`, `calculateTotal()` |
| Variables, Arguments, Array Keys | `snake_case` | `$user_id`, `['first_name' => 'John']` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_USERS`, `API_TIMEOUT` |
| Database Tables & Columns | `snake_case` | `user_orders`, `created_at` |
| Booleans | Question form | `$is_valid`, `hasPermission()` |

## Security Fundamentals (Never Skip)
- **Input Validation**: Validate ALL incoming data using framework tools
- **SQL Injection**: Use ORM/Query Builder with parameter binding. Never concatenate user input
- **XSS Prevention**: Escape ALL output in HTML using framework templating
- **CSRF Protection**: Use framework CSRF tokens for state-changing requests
- **File Uploads**: Validate types, sizes, names. Store outside webroot
- **Dependencies**: Keep updated. Run `composer audit` / `npm audit`

## Error Handling
- Use Exceptions for exceptional situations, not control flow
- Catch specific exceptions, not base `\Exception` unless re-throwing
- Never use error suppression (`@`)
- Log errors with context using framework logging

## Clean Code Essentials
- Functions/methods: under 20-30 lines, single purpose
- Meaningful names - code should be self-documenting
- Avoid deep nesting - use guard clauses
- DRY - encapsulate reusable logic
- Comments explain *why*, not *what*
- Remove dead/commented-out code

## Git Commits
- Follow conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`
- Keep commits small and focused on single logical change
- Use feature branches

## Configuration
- Use `.env` for environment-specific values
- NEVER commit credentials to repository

## Public Repository Hygiene

Treat every tracked file, commit message, issue, pull request, review, test fixture, and release note as public and permanent.

- Do not commit private assistant context such as root `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, editor rules, or assistant-specific directories.
- Keep private assistant context outside the repository and expose it locally through ignored symlinks when a tool requires a root file.
- Put contributor-facing guidance in tracked documentation, separate from private working memory.
- Never publish credentials, secret-bearing backups, customer or private project names, infrastructure identifiers, internal hostnames, real incident details, private coordination IDs, or internal dashboard links.
- Use neutral names and addresses in tests, fixtures, comments, commits, and documentation.
- Before publishing, inspect the staged diff and full commit range, scan for sensitive markers, and verify private context and credential files are ignored and untracked.
- If private context was previously tracked, remove it going forward and extend `.gitignore`. Do not rewrite public history solely for context-file cleanup.

## Configurable Values

Do not hardcode values that drift with providers, environments, operations, or business policy. This includes model IDs, provider lists, fallback chains, endpoints, quotas, timeouts, retries, schedules, feature flags, prices, and user-facing policy text.

Prefer runtime settings, then environment variables, then release configuration. Use source constants only for true protocol, security, or language invariants. Tests may pin values when the exact fixture is essential to the assertion.

## Verification

- Run type checks, configuration validation, focused tests, and the relevant full suite.
- Execute new scripts, installers, migrations, cron jobs, and cleanup utilities at least once; syntax checks alone are insufficient.
- Verify frontend and HTTP-surface changes in a browser when browser tooling and a runnable environment are available.
- Report what was verified and state any environment, credential, or infrastructure limitation explicitly.

## MCP Server Usage
- Use Context7 MCP to match library versions
- Use latest library versions and verify dependency compatibility
- Prefer the `gh` CLI for GitHub issues, pull requests, checks, releases, and workflow runs

## Skill Loading
Load relevant skills when working on framework-specific code:
- **PHP general**: `php-conventions` (strict types, OOP, docs)
- **Laravel**: `laravel-conventions`
- **Joomla 4/5**: `joomla-conventions`
- **Joomla 3.x legacy**: `joomla3-legacy` (JFactory, non-namespaced MVC)
- **Symfony**: `symfony-conventions`
- **Vue 3**: `vue-conventions` (Composition API, Pinia)
- **Vue 2.x legacy**: `vue2-legacy` (Options API, Vuex)
- **Architecture/refactoring**: `solid-principles`
- **REST APIs**: `api-design`
- **Optimization**: `performance-guide`

## Critical Rule
**DO NOT MAKE ASSUMPTIONS** - If unsure or data is missing, ASK QUESTIONS
