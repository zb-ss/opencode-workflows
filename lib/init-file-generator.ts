/**
 * Init File Generator for Delegation Orchestration (Static Fallback)
 *
 * Generates CLAUDE.md and GEMINI.md files using static project stack detection.
 * This is the OFFLINE FALLBACK — the primary path uses LLM-based generation
 * via the delegation-orchestrator plugin (delegation_init_files tool).
 *
 * Used when: LLM generation fails, no OpenCode session is available,
 * or for quick non-interactive init file creation.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { DelegationProvider } from './types.ts'

// ---------------------------------------------------------------------------
// Stack Detection
// ---------------------------------------------------------------------------

export interface ProjectStack {
  languages: string[]
  frameworks: string[]
  build_tools: string[]
  test_tools: string[]
}

/**
 * Read and parse a JSON file safely. Returns null on any error.
 */
function readJson(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Check for presence of files relative to projectRoot.
 */
function exists(projectRoot: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(projectRoot, ...parts))
}

/**
 * Collect unique, sorted values from an array.
 */
function uniq(arr: string[]): string[] {
  return [...new Set(arr)].sort()
}

/**
 * Detect languages by scanning file extensions in top-level and src/ directories.
 */
function detectLanguages(projectRoot: string): string[] {
  const langs: string[] = []

  const extMap: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.php': 'PHP',
    '.py': 'Python',
    '.rs': 'Rust',
    '.go': 'Go',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.rb': 'Ruby',
    '.cs': 'C#',
    '.cpp': 'C++',
    '.c': 'C',
    '.swift': 'Swift',
    '.vue': 'Vue',
    '.svelte': 'Svelte',
  }

  const scanDirs = [projectRoot]
  const srcDir = path.join(projectRoot, 'src')
  if (fs.existsSync(srcDir)) scanDirs.push(srcDir)

  const seen = new Set<string>()
  for (const dir of scanDirs) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      const lang = extMap[ext]
      if (lang && !seen.has(lang)) {
        seen.add(lang)
        langs.push(lang)
      }
    }
  }

  return uniq(langs)
}

/**
 * Detect frameworks from npm dependencies.
 */
function detectNpmFrameworks(deps: Record<string, string>): string[] {
  const all = Object.keys(deps)
  const frameworks: string[] = []

  const checks: Array<[string | RegExp, string]> = [
    ['react', 'React'],
    ['react-dom', 'React'],
    ['vue', 'Vue'],
    ['@angular/core', 'Angular'],
    ['next', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['svelte', 'Svelte'],
    ['@sveltejs/kit', 'SvelteKit'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['koa', 'Koa'],
    ['hono', 'Hono'],
    ['@nestjs/core', 'NestJS'],
    ['@remix-run/react', 'Remix'],
    ['gatsby', 'Gatsby'],
    ['astro', 'Astro'],
    ['solid-js', 'SolidJS'],
    ['electron', 'Electron'],
    ['tailwindcss', 'Tailwind CSS'],
  ]

  for (const [pkg, label] of checks) {
    if (typeof pkg === 'string' ? all.includes(pkg) : pkg.test(all.join('\n'))) {
      if (!frameworks.includes(label)) frameworks.push(label)
    }
  }

  return frameworks
}

/**
 * Detect frameworks from composer.json require.
 */
function detectComposerFrameworks(require: Record<string, string>): string[] {
  const frameworks: string[] = []
  const pkgs = Object.keys(require)

  if (pkgs.some(p => p.startsWith('laravel/'))) frameworks.push('Laravel')
  if (pkgs.some(p => p.startsWith('symfony/'))) frameworks.push('Symfony')
  if (pkgs.some(p => p.startsWith('joomla/'))) frameworks.push('Joomla')
  if (pkgs.includes('cakephp/cakephp')) frameworks.push('CakePHP')
  if (pkgs.includes('codeigniter4/framework')) frameworks.push('CodeIgniter')
  if (pkgs.includes('slim/slim')) frameworks.push('Slim')
  if (pkgs.includes('yiisoft/yii2')) frameworks.push('Yii2')

  return frameworks
}

/**
 * Detect build tools from project root manifest indicators.
 */
function detectBuildTools(projectRoot: string, pkgScripts: Record<string, string>): string[] {
  const tools: string[] = []

  if (exists(projectRoot, 'vite.config.ts') || exists(projectRoot, 'vite.config.js')) tools.push('Vite')
  if (exists(projectRoot, 'webpack.config.js') || exists(projectRoot, 'webpack.config.ts')) tools.push('Webpack')
  if (exists(projectRoot, 'rollup.config.js') || exists(projectRoot, 'rollup.config.mjs')) tools.push('Rollup')
  if (exists(projectRoot, 'esbuild.config.js') || 'esbuild' in pkgScripts) tools.push('esbuild')
  if (exists(projectRoot, 'turbo.json')) tools.push('Turborepo')
  if (exists(projectRoot, 'nx.json')) tools.push('Nx')
  if (exists(projectRoot, 'Makefile')) tools.push('Make')
  if (exists(projectRoot, 'docker-compose.yml') || exists(projectRoot, 'docker-compose.yaml')) tools.push('Docker Compose')
  if (exists(projectRoot, 'Dockerfile')) tools.push('Docker')
  if (exists(projectRoot, 'pom.xml')) tools.push('Maven')
  if (exists(projectRoot, 'build.gradle') || exists(projectRoot, 'build.gradle.kts')) tools.push('Gradle')
  if (exists(projectRoot, 'Cargo.toml')) tools.push('Cargo')
  if (exists(projectRoot, 'go.mod')) tools.push('Go modules')

  // tsc
  if (exists(projectRoot, 'tsconfig.json')) tools.push('TypeScript compiler')

  return uniq(tools)
}

/**
 * Detect test tools from project root and npm/composer deps.
 */
function detectTestTools(
  projectRoot: string,
  pkgDeps: Record<string, string>,
  composerDeps: Record<string, string>,
): string[] {
  const tools: string[] = []

  const npmTestChecks: Array<[string, string]> = [
    ['jest', 'Jest'],
    ['vitest', 'Vitest'],
    ['mocha', 'Mocha'],
    ['jasmine', 'Jasmine'],
    ['@playwright/test', 'Playwright'],
    ['cypress', 'Cypress'],
    ['@testing-library/react', 'Testing Library'],
    ['ava', 'Ava'],
    ['tap', 'Tap'],
  ]

  for (const [pkg, label] of npmTestChecks) {
    if (pkg in pkgDeps) tools.push(label)
  }

  if ('phpunit/phpunit' in composerDeps) tools.push('PHPUnit')
  if ('pestphp/pest' in composerDeps) tools.push('Pest')
  if (exists(projectRoot, 'pytest.ini') || exists(projectRoot, 'pyproject.toml')) {
    const pyproj = readJson(path.join(projectRoot, 'pyproject.toml'))
    // pyproject.toml is TOML, not JSON — just check file existence as a hint
    if (exists(projectRoot, 'pytest.ini') || exists(projectRoot, 'conftest.py')) tools.push('pytest')
  }
  if (exists(projectRoot, 'Gemfile')) {
    const gemfile = safeReadText(path.join(projectRoot, 'Gemfile'))
    if (gemfile.includes('rspec')) tools.push('RSpec')
    if (gemfile.includes('minitest')) tools.push('Minitest')
  }

  return uniq(tools)
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Detect the full project stack from manifest files and file extensions.
 */
export function detectProjectStack(projectRoot: string): ProjectStack {
  const pkgJson = readJson(path.join(projectRoot, 'package.json'))
  const composerJson = readJson(path.join(projectRoot, 'composer.json'))

  const pkgDeps: Record<string, string> = {
    ...((pkgJson?.dependencies as Record<string, string>) ?? {}),
    ...((pkgJson?.devDependencies as Record<string, string>) ?? {}),
  }
  const pkgScripts: Record<string, string> = (pkgJson?.scripts as Record<string, string>) ?? {}
  const composerDeps: Record<string, string> = {
    ...((composerJson?.require as Record<string, string>) ?? {}),
    ...((composerJson?.['require-dev'] as Record<string, string>) ?? {}),
  }

  const frameworks: string[] = [
    ...detectNpmFrameworks(pkgDeps),
    ...detectComposerFrameworks(composerDeps),
  ]

  // Additional manifest-based language hints
  const languages = detectLanguages(projectRoot)
  if (exists(projectRoot, 'Cargo.toml') && !languages.includes('Rust')) languages.push('Rust')
  if (exists(projectRoot, 'go.mod') && !languages.includes('Go')) languages.push('Go')
  if (exists(projectRoot, 'pyproject.toml') && !languages.includes('Python')) languages.push('Python')
  if (exists(projectRoot, 'Gemfile') && !languages.includes('Ruby')) languages.push('Ruby')
  if (exists(projectRoot, 'pom.xml') && !languages.includes('Java')) languages.push('Java')
  if (exists(projectRoot, 'composer.json') && !languages.includes('PHP')) languages.push('PHP')

  return {
    languages: uniq(languages),
    frameworks: uniq(frameworks),
    build_tools: detectBuildTools(projectRoot, pkgScripts),
    test_tools: detectTestTools(projectRoot, pkgDeps, composerDeps),
  }
}

// ---------------------------------------------------------------------------
// Content Generation
// ---------------------------------------------------------------------------

/**
 * Resolve a human-readable project name from manifests or directory name.
 */
function resolveProjectName(projectRoot: string): string {
  const pkgJson = readJson(path.join(projectRoot, 'package.json'))
  if (typeof pkgJson?.name === 'string' && pkgJson.name.trim()) {
    return pkgJson.name.trim()
  }
  const composerJson = readJson(path.join(projectRoot, 'composer.json'))
  if (typeof composerJson?.name === 'string' && composerJson.name.trim()) {
    // composer names are vendor/package — use the package part
    const parts = (composerJson.name as string).split('/')
    return parts[parts.length - 1].trim()
  }
  return path.basename(projectRoot)
}

/**
 * List top-level directories with simple heuristic descriptions.
 */
function describeTopLevelDirs(projectRoot: string): Array<{ dir: string; desc: string }> {
  const descMap: Record<string, string> = {
    src: 'Application source code',
    lib: 'Shared libraries / utilities',
    app: 'Application core (framework entry points)',
    pages: 'Page-level components / routes',
    components: 'Reusable UI components',
    hooks: 'Custom React / Vue hooks',
    store: 'State management',
    styles: 'Global styles and theme',
    assets: 'Static assets (images, fonts)',
    public: 'Publicly served static files',
    dist: 'Build output (generated)',
    build: 'Build output or scripts',
    tests: 'Test suites',
    test: 'Test suites',
    __tests__: 'Jest/Vitest test suites',
    spec: 'Test specifications',
    docs: 'Documentation',
    scripts: 'Development / automation scripts',
    config: 'Configuration files',
    resources: 'Templates, views, lang files (Laravel)',
    routes: 'Route definitions',
    database: 'Migrations and seeders',
    migrations: 'Database migrations',
    api: 'API routes / handlers',
    server: 'Server-side code',
    client: 'Client-side code',
    packages: 'Monorepo packages',
    plugins: 'Plugin definitions',
    types: 'TypeScript type declarations',
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor')
    .map(e => ({ dir: e.name, desc: descMap[e.name] ?? '' }))
    .filter(e => e.desc !== '')  // only emit dirs we can describe meaningfully
    .slice(0, 12)
}

/**
 * Extract useful npm script commands (install/build/test/lint).
 */
function resolveNpmCommands(projectRoot: string): {
  install: string
  build: string
  test: string
  lint: string
} {
  const pkgJson = readJson(path.join(projectRoot, 'package.json'))
  const scripts: Record<string, string> = (pkgJson?.scripts as Record<string, string>) ?? {}
  const hasPm = (pm: string) => exists(projectRoot, `${pm}-lock.yaml`) || exists(projectRoot, `${pm}.lock`)
  const pm = hasPm('pnpm') ? 'pnpm' : hasPm('yarn') ? 'yarn' : 'npm'
  const run = pm === 'npm' ? 'npm run' : pm

  const pick = (candidates: string[]): string => {
    const found = candidates.find(c => c in scripts)
    return found ? `${run} ${found}` : ''
  }

  return {
    install: `${pm} install`,
    build: pick(['build', 'compile', 'bundle']),
    test: pick(['test', 'test:unit', 'test:run', 'spec']),
    lint: pick(['lint', 'lint:fix', 'check']),
  }
}

/**
 * Build the Development section content lines.
 */
function buildDevelopmentSection(projectRoot: string): string[] {
  const lines: string[] = []
  const pkgJson = readJson(path.join(projectRoot, 'package.json'))
  const composerJson = readJson(path.join(projectRoot, 'composer.json'))

  if (pkgJson) {
    const cmds = resolveNpmCommands(projectRoot)
    lines.push(`- **Install**: \`${cmds.install}\``)
    if (cmds.build) lines.push(`- **Build**: \`${cmds.build}\``)
    if (cmds.test) lines.push(`- **Test**: \`${cmds.test}\``)
    if (cmds.lint) lines.push(`- **Lint**: \`${cmds.lint}\``)
  }

  if (composerJson) {
    lines.push('- **Install (PHP)**: `composer install`')
    const composerScripts = Object.keys((composerJson.scripts as Record<string, unknown>) ?? {})
    if (composerScripts.includes('test')) lines.push('- **Test (PHP)**: `composer test`')
    if (composerScripts.includes('cs-fix')) lines.push('- **Code style**: `composer cs-fix`')
  }

  if (exists(projectRoot, 'Makefile')) {
    lines.push('- **Make targets**: run `make help` (if available) or inspect `Makefile`')
  }

  if (exists(projectRoot, 'Cargo.toml')) {
    lines.push('- **Build**: `cargo build`')
    lines.push('- **Test**: `cargo test`')
  }

  if (exists(projectRoot, 'go.mod')) {
    lines.push('- **Build**: `go build ./...`')
    lines.push('- **Test**: `go test ./...`')
  }

  if (exists(projectRoot, 'pyproject.toml') || exists(projectRoot, 'requirements.txt')) {
    lines.push('- **Install (Python)**: `pip install -e .` or `pip install -r requirements.txt`')
    if (exists(projectRoot, 'pytest.ini') || exists(projectRoot, 'conftest.py')) {
      lines.push('- **Test**: `pytest`')
    }
  }

  return lines
}

/**
 * Generate the full markdown init-file content for a given provider and project.
 */
export function generateInitContent(provider: DelegationProvider, projectRoot: string): string {
  const cliName = provider === 'claude' ? 'Claude Code' : 'Antigravity CLI'
  const stack = detectProjectStack(projectRoot)
  const projectName = resolveProjectName(projectRoot)
  const topDirs = describeTopLevelDirs(projectRoot)
  const devLines = buildDevelopmentSection(projectRoot)

  const lines: string[] = []

  lines.push(`<!-- Auto-generated by OpenCode Workflows. Edit freely. -->`)
  lines.push(`# ${projectName}`)
  lines.push(``)
  lines.push(`> This file provides project context to ${cliName}.`)
  lines.push(``)

  // Project Overview
  lines.push(`## Project Overview`)
  lines.push(``)
  if (stack.languages.length > 0) {
    lines.push(`- **Languages**: ${stack.languages.join(', ')}`)
  }
  if (stack.frameworks.length > 0) {
    lines.push(`- **Frameworks**: ${stack.frameworks.join(', ')}`)
  }
  if (stack.build_tools.length > 0) {
    lines.push(`- **Build tools**: ${stack.build_tools.join(', ')}`)
  }
  if (stack.test_tools.length > 0) {
    lines.push(`- **Test tools**: ${stack.test_tools.join(', ')}`)
  }
  if (stack.languages.length === 0 && stack.frameworks.length === 0) {
    lines.push(`- Stack could not be auto-detected. Update this file manually.`)
  }
  lines.push(``)

  // Directory Structure
  if (topDirs.length > 0) {
    lines.push(`## Directory Structure`)
    lines.push(``)
    for (const { dir, desc } of topDirs) {
      lines.push(`- \`${dir}/\` — ${desc}`)
    }
    lines.push(``)
  }

  // Development
  lines.push(`## Development`)
  lines.push(``)
  if (devLines.length > 0) {
    lines.push(...devLines)
  } else {
    lines.push(`- Refer to project README for setup instructions.`)
  }
  lines.push(``)

  // Conventions
  lines.push(`## Conventions`)
  lines.push(``)
  if (exists(projectRoot, 'CONVENTIONS.md')) {
    lines.push(`- See \`CONVENTIONS.md\` for coding conventions.`)
  }
  if (exists(projectRoot, '.editorconfig')) {
    lines.push(`- \`.editorconfig\` defines editor settings (indentation, line endings, etc.).`)
  }
  if (exists(projectRoot, 'CONTRIBUTING.md')) {
    lines.push(`- See \`CONTRIBUTING.md\` for contribution guidelines.`)
  }
  if (
    !exists(projectRoot, 'CONVENTIONS.md') &&
    !exists(projectRoot, '.editorconfig') &&
    !exists(projectRoot, 'CONTRIBUTING.md')
  ) {
    lines.push(`- No convention files detected. Add CONVENTIONS.md to document project conventions.`)
  }
  lines.push(``)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnsureInitFileResult {
  created: boolean
  path: string
  content: string | null
}

/**
 * Ensure that the provider's init file (CLAUDE.md or GEMINI.md) exists in
 * projectRoot. Never overwrites an existing file.
 *
 * Returns { created: true, path, content } when the file was generated,
 * or { created: false, path, content: null } when it already existed.
 */
export function ensureInitFile(
  provider: DelegationProvider,
  projectRoot: string,
): EnsureInitFileResult {
  const fileName = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'
  const filePath = path.join(projectRoot, fileName)

  if (fs.existsSync(filePath)) {
    return { created: false, path: filePath, content: null }
  }

  const content = generateInitContent(provider, projectRoot)
  fs.writeFileSync(filePath, content, 'utf-8')

  return { created: true, path: filePath, content }
}
