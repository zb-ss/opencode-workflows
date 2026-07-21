#!/usr/bin/env node

import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_BOUNDED_IO_BYTES } from './lib/workflow-limits.mjs'

export { MAX_BOUNDED_IO_BYTES }

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DATA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const MANIFEST_NAME = '.opencode-workflows-manifest.json'
const MANIFEST_VERSION = 2
const MIN_OPENCODE_VERSION = '1.17.20'
const ENV_FILE_NAME = 'opencode-workflows.env'
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const AUTONOMY_PROFILES = new Set(['interactive', 'bounded'])
const CAPABILITY_ENVIRONMENT = {
  background_subagents: 'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
  native_workspaces: 'OPENCODE_EXPERIMENTAL_WORKSPACES',
  mcp_code_mode: 'OPENCODE_EXPERIMENTAL_CODE_MODE',
  references: 'OPENCODE_EXPERIMENTAL_REFERENCES',
}

const PRIMARY_AGENTS = [
  'supervisor.md',
  'delegator.md',
  'editor.md',
  'focused-build.md',
  'debug.md',
  'org-planner.md',
  'step-planner.md',
  'discussion.md',
  'web-tester.md',
  'figma-builder.md',
]

const WORKFLOW_AGENTS = [
  'architect.md',
  'architect-lite.md',
  'executor.md',
  'executor-lite.md',
  'reviewer.md',
  'reviewer-lite.md',
  'reviewer-deep.md',
  'security.md',
  'security-lite.md',
  'security-deep.md',
  'test-writer.md',
  'quality-gate.md',
  'completion-guard.md',
  'codebase-analyzer.md',
  'perf-reviewer.md',
  'perf-lite.md',
  'doc-writer.md',
  'explorer.md',
  'e2e-explorer.md',
  'e2e-generator.md',
  'e2e-reviewer.md',
]

const TRANSLATION_AGENTS = [
  'translation-planner.md',
  'translation-coder.md',
  'translation-reviewer.md',
]

const TRANSLATION_TOOLS = new Set([
  'i18n-hardcode-finder.ts',
  'i18n-convert.ts',
  'i18n-extract.ts',
  'i18n-verify.ts',
  'ini-builder.ts',
  'file-chunker.ts',
  'chunk-reader.ts',
  'chunk-state.ts',
])

export function getConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(expandHome(env.OPENCODE_CONFIG_DIR))
  if (env.XDG_CONFIG_HOME) return path.resolve(expandHome(env.XDG_CONFIG_HOME), 'opencode')
  return path.join(os.homedir(), '.config', 'opencode')
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function pathExists(target) {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

function removePath(target) {
  try {
    const stat = fs.lstatSync(target)
    if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true })
    else fs.unlinkSync(target)
    return true
  } catch {
    return false
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/')
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(directory, 0o700) } catch {}
  return directory
}

function assertSafeManagedParent(configDir, target) {
  const lexicalRoot = path.resolve(configDir)
  const lexicalTarget = path.resolve(target)
  if (!isInside(lexicalRoot, lexicalTarget)) throw new Error(`Managed path escapes config directory: ${target}`)
  ensurePrivateDirectory(lexicalRoot)
  const canonicalRoot = fs.realpathSync(lexicalRoot)
  const parentRelative = path.relative(lexicalRoot, path.dirname(lexicalTarget))
  let current = lexicalRoot
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!pathExists(current)) break
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`Managed parent must not be a symbolic link: ${current}`)
    if (!stat.isDirectory()) throw new Error(`Managed parent is not a directory: ${current}`)
    if (!isInside(canonicalRoot, fs.realpathSync(current))) {
      throw new Error(`Managed parent resolves outside config directory: ${current}`)
    }
  }
}

function legacyBackupPath(configDir, target) {
  const relative = normalizeRelative(path.relative(configDir, target)).replaceAll('/', '__')
  return nextBackupPath(path.join(configDir, '.opencode-workflows-backups', relative))
}

function writeFileNoFollow(target, content, mode = 0o600, exclusive = false) {
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC)
    | (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(target, flags, mode)
  try {
    fs.writeFileSync(fd, content)
    try { fs.fchmodSync(fd, mode) } catch {}
  } finally {
    fs.closeSync(fd)
  }
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return []
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function addTree(files, sourceRoot, targetRoot, options = {}) {
  for (const source of walkFiles(sourceRoot)) {
    files.push({
      source,
      target: path.join(targetRoot, path.relative(sourceRoot, source)),
      ...options,
    })
  }
}

export function buildFileList(modules, configDir = getConfigDir()) {
  const files = []
  const hasCore = modules.includes('core')
  const hasTranslate = modules.includes('translate')

  if (hasCore) {
    for (const name of PRIMARY_AGENTS) {
      files.push({
        source: path.join(REPO_ROOT, 'agent', 'primary', name),
        target: path.join(configDir, 'agents', name),
        modelMetadata: true,
      })
    }
    for (const name of WORKFLOW_AGENTS) {
      files.push({
        source: path.join(REPO_ROOT, 'agent', 'workflow', name),
        target: path.join(configDir, 'agents', `wf-${name}`),
        modelMetadata: true,
      })
    }

    for (const source of walkFiles(path.join(REPO_ROOT, 'command'))) {
      const name = path.basename(source)
      if (!name.endsWith('.md') || name.startsWith('translate-')) continue
      files.push({ source, target: path.join(configDir, 'commands', name), modelMetadata: true })
    }

    for (const source of walkFiles(path.join(REPO_ROOT, 'plugin'))) {
      const name = path.basename(source)
      if (name === 'translation-workflow.ts' || name === 'package-lock.json' || source.includes(`${path.sep}node_modules${path.sep}`)) continue
      if (!name.endsWith('.ts') && name !== 'package.json') continue
      files.push({ source, target: path.join(configDir, 'plugins', name) })
    }

    addTree(files, path.join(REPO_ROOT, 'skill'), path.join(configDir, 'skills'))
    addTree(files, path.join(REPO_ROOT, 'mode'), path.join(configDir, 'mode'))
    addTree(files, path.join(REPO_ROOT, 'lib'), path.join(configDir, 'lib'))
    addTree(files, path.join(REPO_ROOT, 'templates'), path.join(configDir, 'templates'))
    addTree(files, path.join(REPO_ROOT, 'workflow'), path.join(configDir, 'workflow'))
    addTree(files, path.join(REPO_ROOT, 'schema'), path.join(configDir, 'schema'))

    const conventionsSource = path.join(REPO_ROOT, 'docs', 'conventions.md')
    if (fs.existsSync(conventionsSource)) {
      files.push({
        source: conventionsSource,
        target: path.join(configDir, 'CONVENTIONS.md'),
        preserveModified: true,
      })
    }
  }

  if (hasTranslate) {
    for (const name of TRANSLATION_AGENTS) {
      files.push({
        source: path.join(REPO_ROOT, 'agent', name),
        target: path.join(configDir, 'agents', name),
        modelMetadata: true,
      })
    }
    for (const name of ['translate-auto.md', 'translate-view.md']) {
      files.push({
        source: path.join(REPO_ROOT, 'command', name),
        target: path.join(configDir, 'commands', name),
        modelMetadata: true,
      })
    }
    for (const name of TRANSLATION_TOOLS) {
      files.push({
        source: path.join(REPO_ROOT, 'tool', name),
        target: path.join(configDir, 'tools', name),
        forceCopy: true,
      })
    }
    files.push({
      source: path.join(REPO_ROOT, 'plugin', 'translation-workflow.ts'),
      target: path.join(configDir, 'plugins', 'translation-workflow.ts'),
    })
  }

  const byTarget = new Map()
  for (const file of files) byTarget.set(path.resolve(file.target), file)
  return [...byTarget.values()]
}

function stripDocumentationKeys(value) {
  if (Array.isArray(value)) return value.map(stripDocumentationKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, child]) => [key, stripDocumentationKeys(child)]),
  )
}

function loadWorkflowConfig(configDir = getConfigDir()) {
  const candidates = [
    path.join(configDir, 'workflows.json'),
    path.join(REPO_ROOT, 'workflows.json.template'),
  ]
  for (const candidate of candidates) {
    try {
      return stripDocumentationKeys(JSON.parse(fs.readFileSync(candidate, 'utf8')))
    } catch {
      // Try the next source. Validation reports malformed user config separately.
    }
  }
  return {}
}

export function normalizeCandidate(candidate) {
  if (typeof candidate === 'string') return { model: candidate }
  if (!candidate || typeof candidate !== 'object') return null
  return { model: candidate.model, ...(candidate.variant ? { variant: candidate.variant } : {}) }
}

function isValidCandidate(candidate) {
  return Boolean(
    candidate
      && typeof candidate.model === 'string'
      && MODEL_ID_PATTERN.test(candidate.model)
      && (candidate.variant === undefined
        || (typeof candidate.variant === 'string' && VARIANT_PATTERN.test(candidate.variant))),
  )
}

export function configuredCandidates(config, agentName, tier) {
  const overrides = config?.agent_models && typeof config.agent_models === 'object'
    ? config.agent_models
    : {}
  const override = agentName && !agentName.startsWith('_') ? overrides[agentName] : undefined
  const tierCandidates = Array.isArray(config?.model_tiers?.[tier]) ? config.model_tiers[tier] : []
  const primary = override === undefined ? tierCandidates : Array.isArray(override) ? override : [override]
  const fallback = Array.isArray(config?.fallback_order) ? config.fallback_order : []
  const agentVariant = typeof config?.agent_variants?.[agentName] === 'string'
    ? config.agent_variants[agentName]
    : undefined
  const unique = new Map()

  for (const value of [...primary, ...fallback]) {
    const normalized = normalizeCandidate(value)
    if (!normalized) continue
    const candidate = agentVariant && !normalized.variant
      ? { ...normalized, variant: agentVariant }
      : normalized
    if (!isValidCandidate(candidate)) continue
    const key = `${candidate.model}\0${candidate.variant ?? ''}`
    if (!unique.has(key)) unique.set(key, candidate)
  }
  return [...unique.values()]
}

export function transformModelMetadata(raw, agentName, config, strategy = 'runtime') {
  const tierMatch = raw.match(/^[ \t]*model_tier:\s*(low|mid|high)\s*$/m)
  if (!tierMatch) return { content: raw, note: null, warning: null }
  const tier = tierMatch[1]
  const candidates = configuredCandidates(config, agentName, tier)
  const configuredVariant = typeof config?.agent_variants?.[agentName] === 'string'
    && VARIANT_PATTERN.test(config.agent_variants[agentName])
    ? config.agent_variants[agentName]
    : undefined

  if (strategy !== 'materialize') {
    return {
      content: raw.replace(/^[ \t]*model_tier:\s*(low|mid|high)\s*\r?\n?/m, ''),
      note: configuredVariant
        ? 'runtime model inheritance; configured variant retained for explicit model selection'
        : 'runtime model inheritance',
      warning: null,
    }
  }

  const selected = candidates[0]
  if (!selected) {
    return {
      content: raw.replace(/^[ \t]*model_tier:\s*(low|mid|high)\s*\r?\n?/m, ''),
      note: 'runtime model inheritance',
      warning: `No valid candidate configured for ${agentName} (${tier}); model was not materialized.`,
    }
  }
  const lines = [`model: ${JSON.stringify(selected.model)}`]
  if (selected.variant) lines.push(`variant: ${JSON.stringify(selected.variant)}`)
  return {
    content: raw.replace(/^[ \t]*model_tier:\s*(low|mid|high)\s*$/m, lines.join('\n')),
    note: 'model materialized from ordered candidates',
    warning: null,
  }
}

function parseVersion(output) {
  const match = String(output).match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1, 4).map(Number) : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function checkOpenCodeVersion() {
  const result = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) {
    return { ok: false, version: null, error: 'OpenCode was not found in PATH or did not report a version.' }
  }
  const version = parseVersion(`${result.stdout}\n${result.stderr}`)
  if (!version) return { ok: false, version: null, error: 'Could not parse the OpenCode version.' }

  const minimum = parseVersion(MIN_OPENCODE_VERSION)
  const comparison = compareVersions(version, minimum)
  const versionText = version.join('.')
  if (comparison < 0) {
    return {
      ok: false,
      version: versionText,
      error: `OpenCode ${MIN_OPENCODE_VERSION} or newer is required (found ${versionText}).`,
    }
  }
  return {
    ok: true,
    version: versionText,
    warning: comparison > 0
      ? `OpenCode ${versionText} is newer than the tested version ${MIN_OPENCODE_VERSION}. Run --doctor after upgrades.`
      : null,
  }
}

function readManifest(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME)
  if (!fs.existsSync(manifestPath)) return null
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function recordTarget(record, manifest, configDir) {
  if (typeof record === 'string') {
    const target = path.resolve(record)
    return isInside(configDir, target) ? target : null
  }
  if (!record || typeof record.path !== 'string') return null
  const root = typeof manifest?.target?.config_dir === 'string'
    ? path.resolve(manifest.target.config_dir)
    : configDir
  const target = path.resolve(root, record.path)
  return isInside(configDir, target) ? target : null
}

function manifestRecords(manifest, configDir) {
  if (!manifest || !Array.isArray(manifest.files)) return []
  return manifest.files.map((record) => ({ record, target: recordTarget(record, manifest, configDir) }))
    .filter((entry) => entry.target)
}

function isRepoSymlink(target, expectedSource = null) {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false
    const resolved = fs.realpathSync(target)
    if (expectedSource) return resolved === fs.realpathSync(expectedSource)
    return isInside(REPO_ROOT, resolved)
  } catch {
    return false
  }
}

function isOwnedRecord(target, record) {
  if (!pathExists(target)) return false
  if (typeof record === 'string') return isRepoSymlink(target) || matchesLegacySource(target)
  if (!record || typeof record.sha256 !== 'string') return false

  if (record.mode === 'symlink') {
    if (typeof record.source !== 'string') return false
    const source = path.resolve(REPO_ROOT, record.source)
    return isInside(REPO_ROOT, source) && isRepoSymlink(target, source)
  }
  try {
    return fs.lstatSync(target).isFile() && sha256File(target) === record.sha256
  } catch {
    return false
  }
}

function matchesLegacySource(target) {
  let relative = normalizeRelative(path.relative(getConfigDir(), target))
  const mappings = [
    ['command/', 'command/'],
    ['commands/', 'command/'],
    ['skill/', 'skill/'],
    ['skills/', 'skill/'],
    ['plugin/', 'plugin/'],
    ['plugins/', 'plugin/'],
    ['tool/', 'tool/'],
    ['tools/', 'tool/'],
    ['mode/', 'mode/'],
    ['lib/', 'lib/'],
    ['templates/', 'templates/'],
  ]
  for (const [prefix, sourcePrefix] of mappings) {
    if (!relative.startsWith(prefix)) continue
    const source = path.join(REPO_ROOT, sourcePrefix, relative.slice(prefix.length))
    try {
      return fs.statSync(source).isFile() && sha256File(source) === sha256File(target)
    } catch {
      return false
    }
  }
  return false
}

function nextBackupPath(target) {
  let candidate = `${target}.backup`
  let index = 1
  while (pathExists(candidate)) candidate = `${target}.backup.${index++}`
  return candidate
}

function prepareTarget(target, previousRecord, dryRun, actions) {
  if (!pathExists(target)) return
  if ((previousRecord && isOwnedRecord(target, previousRecord)) || isRepoSymlink(target)) {
    if (!dryRun) removePath(target)
    return
  }
  const backup = nextBackupPath(target)
  actions.push({ action: 'backup', target, backup, dryRun })
  if (!dryRun) fs.renameSync(target, backup)
}

function createRecord(configDir, source, target, mode) {
  return {
    path: normalizeRelative(path.relative(configDir, target)),
    source: source ? normalizeRelative(path.relative(REPO_ROOT, source)) : null,
    mode,
    sha256: sha256File(target),
  }
}

function installManagedFile(file, options) {
  const { configDir, mode, dryRun, previousByTarget, workflowConfig, modelStrategy, actions } = options
  if (!fs.existsSync(file.source)) {
    actions.push({ action: 'skip', target: file.target, reason: 'source missing' })
    return null
  }

  const previousRecord = previousByTarget.get(path.resolve(file.target))
  if (file.preserveModified && pathExists(file.target)
    && (!previousRecord || !isOwnedRecord(file.target, previousRecord))) {
    actions.push({ action: 'skip', target: file.target, reason: 'modified user guidance preserved' })
    return previousRecord ?? null
  }

  let content = null
  let note = null
  if (file.modelMetadata) {
    const raw = fs.readFileSync(file.source, 'utf8')
    const agentName = path.basename(file.target, path.extname(file.target))
    const transformed = transformModelMetadata(raw, agentName, workflowConfig, modelStrategy)
    if (transformed.content !== raw) content = transformed.content
    note = transformed.note
    if (transformed.warning) actions.push({ action: 'warning', message: transformed.warning })
  }

  const effectiveMode = content !== null || file.forceCopy || mode === 'copy' ? 'copy' : 'symlink'
  actions.push({ action: effectiveMode, source: file.source, target: file.target, note, dryRun })
  if (dryRun) return null

  assertSafeManagedParent(configDir, file.target)
  prepareTarget(file.target, previousRecord, false, actions)
  ensurePrivateDirectory(path.dirname(file.target))
  if (content !== null) writeFileNoFollow(file.target, content)
  else if (effectiveMode === 'copy') writeFileNoFollow(file.target, fs.readFileSync(file.source))
  else fs.symlinkSync(file.source, file.target)
  return createRecord(configDir, file.source, file.target, effectiveMode)
}

function installInitialConfig(source, target, dryRun, actions) {
  if (pathExists(target)) {
    actions.push({ action: 'skip', target, reason: 'user config preserved' })
    return
  }
  actions.push({ action: 'copy', source, target, note: 'first install only; never removed', dryRun })
  if (!dryRun) {
    assertSafeManagedParent(getConfigDir(), target)
    ensurePrivateDirectory(path.dirname(target))
    writeFileNoFollow(target, fs.readFileSync(source))
  }
}

function installGeneratedFile(target, content, options) {
  const { configDir, dryRun, previousByTarget, actions } = options
  actions.push({ action: 'write', target, dryRun })
  if (dryRun) return null
  assertSafeManagedParent(configDir, target)
  prepareTarget(target, previousByTarget.get(path.resolve(target)), false, actions)
  ensurePrivateDirectory(path.dirname(target))
  writeFileNoFollow(target, content)
  return createRecord(configDir, null, target, 'generated')
}

function removeStaleFiles(previousManifest, currentTargets, configDir, dryRun, actions) {
  for (const { record, target } of manifestRecords(previousManifest, configDir)) {
    if (currentTargets.has(path.resolve(target))) continue
    if (['opencode.json', 'opencode.jsonc', 'workflows.json'].includes(path.basename(target))) continue
    if (!pathExists(target)) continue
    if (!isOwnedRecord(target, record)) {
      const relative = normalizeRelative(path.relative(configDir, target))
      if (/^(command|skill|plugin|tool)\//.test(relative)) {
        const backup = legacyBackupPath(configDir, target)
        actions.push({ action: 'backup', target, backup, note: 'unverified legacy managed file', dryRun })
        if (!dryRun) {
          assertSafeManagedParent(configDir, target)
          assertSafeManagedParent(configDir, backup)
          ensurePrivateDirectory(path.dirname(backup))
          fs.renameSync(target, backup)
        }
        continue
      }
      actions.push({ action: 'warning', message: `Preserved stale file because ownership could not be verified: ${target}` })
      continue
    }
    actions.push({ action: 'remove', target, note: 'stale managed file', dryRun })
    if (!dryRun) {
      assertSafeManagedParent(configDir, target)
      removePath(target)
    }
  }
}

function runDependencies(mode, configDir, dryRun, actions) {
  const directories = [path.join(configDir, 'plugins')]
  if (mode === 'symlink') directories.push(REPO_ROOT, path.join(REPO_ROOT, 'plugin'))

  for (const directory of directories) {
    if (!fs.existsSync(path.join(directory, 'package.json'))) continue
    actions.push({ action: 'npm-install', target: directory, dryRun })
    if (dryRun) continue
    try {
      execFileSync('npm', [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-save',
        '--package-lock=false',
      ], {
        cwd: directory,
        stdio: 'pipe',
        timeout: Number(process.env.OPENCODE_WORKFLOWS_NPM_TIMEOUT_MS || 120000),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Dependency installation failed in ${directory}: ${detail}`)
    }
  }
}

function writeManifest(configDir, modules, mode, modelStrategy, records) {
  const manifest = {
    $schema: './schema/install-manifest.schema.json',
    schema_version: MANIFEST_VERSION,
    package: { name: PACKAGE_DATA.name, version: PACKAGE_DATA.version },
    target: { config_dir: configDir, platform: process.platform },
    install: {
      mode,
      modules,
      model_strategy: modelStrategy,
      installed_at: new Date().toISOString(),
    },
    files: records.sort((left, right) => left.path.localeCompare(right.path)),
  }
  const manifestPath = path.join(configDir, MANIFEST_NAME)
  assertSafeManagedParent(configDir, manifestPath)
  writeFileNoFollow(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

export function install(modules, mode, dryRun, options = {}) {
  const version = checkOpenCodeVersion()
  if (!version.ok) throw new Error(version.error)
  if (version.warning) console.warn(`Warning: ${version.warning}`)

  const configDir = getConfigDir()
  if (!dryRun) ensurePrivateDirectory(configDir)
  const modelStrategy = options.materializeModels ? 'materialize' : 'runtime'
  const files = buildFileList(modules, configDir)
  const workflowConfig = loadWorkflowConfig(configDir)
  const previousManifest = readManifest(configDir)
  const previousByTarget = new Map(
    manifestRecords(previousManifest, configDir).map(({ record, target }) => [path.resolve(target), record]),
  )
  const actions = []
  const records = []
  const plannedTargets = new Set(files.map((file) => path.resolve(file.target)))

  console.log(`Installing modules: ${modules.join(', ')}`)
  console.log(`Config dir: ${configDir}`)
  console.log(`Install mode: ${mode}`)
  console.log(`Model strategy: ${modelStrategy === 'runtime' ? 'runtime inheritance' : 'legacy materialization'}`)
  if (dryRun) console.log('Dry run: no changes will be made.')

  for (const file of files) {
    const record = installManagedFile(file, {
      configDir,
      mode,
      dryRun,
      previousByTarget,
      workflowConfig,
      modelStrategy,
      actions,
    })
    if (record) records.push(record)
  }

  const opencodeJson = path.join(configDir, 'opencode.json')
  const opencodeJsonc = path.join(configDir, 'opencode.jsonc')
  if (!fs.existsSync(opencodeJson) && !fs.existsSync(opencodeJsonc)) {
    installInitialConfig(path.join(REPO_ROOT, 'opencode.jsonc.template'), opencodeJsonc, dryRun, actions)
  } else {
    actions.push({ action: 'skip', target: fs.existsSync(opencodeJsonc) ? opencodeJsonc : opencodeJson, reason: 'user config preserved' })
  }
  installInitialConfig(
    path.join(REPO_ROOT, 'workflows.json.template'),
    path.join(configDir, 'workflows.json'),
    dryRun,
    actions,
  )

  for (const directory of [
    path.join(configDir, 'plans'),
    path.join(configDir, 'workflows', 'active'),
    path.join(configDir, 'workflows', 'completed'),
  ]) {
    const target = path.join(directory, '.gitkeep')
    if (!dryRun) {
      assertSafeManagedParent(configDir, target)
      ensurePrivateDirectory(directory)
    }
    plannedTargets.add(path.resolve(target))
    if (!pathExists(target)) {
      const record = installGeneratedFile(target, '', { configDir, dryRun, previousByTarget, actions })
      if (record) records.push(record)
    } else if (previousByTarget.has(path.resolve(target))) {
      records.push(previousByTarget.get(path.resolve(target)))
    }
  }

  const envTarget = path.join(configDir, ENV_FILE_NAME)
  plannedTargets.add(path.resolve(envTarget))
  const envRecord = installGeneratedFile(
    envTarget,
    `OPENCODE_WORKFLOWS_REPO=${REPO_ROOT}\n`,
    { configDir, dryRun, previousByTarget, actions },
  )
  if (envRecord) records.push(envRecord)

  for (const record of records) plannedTargets.add(path.resolve(configDir, record.path))
  removeStaleFiles(previousManifest, plannedTargets, configDir, dryRun, actions)

  let dependencyError = null
  try {
    runDependencies(mode, configDir, dryRun, actions)
  } catch (error) {
    dependencyError = error
  }

  if (!dryRun) {
    const manifestPath = writeManifest(configDir, modules, mode, modelStrategy, records)
    actions.push({ action: 'write', target: manifestPath })
  }

  printInstallSummary(actions, dryRun)
  if (dependencyError) throw dependencyError
  if (!dryRun) console.log('Restart OpenCode to load the installed agents, commands, skills, and plugins.')
}

function printInstallSummary(actions, dryRun) {
  const installed = actions.filter((action) => ['copy', 'symlink', 'write'].includes(action.action)).length
  const removed = actions.filter((action) => action.action === 'remove').length
  const skipped = actions.filter((action) => action.action === 'skip').length
  console.log(`\n${dryRun ? 'Dry run' : 'Install'} summary: ${installed} installed, ${removed} stale removed, ${skipped} preserved.`)
  for (const warning of actions.filter((action) => action.action === 'warning')) {
    console.warn(`Warning: ${warning.message}`)
  }
}

function validateWithScript(args) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'script', 'validate-config.mjs'), ...args], {
    encoding: 'utf8',
    shell: false,
  })
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  }
}

function environmentFlagEnabled(value) {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function diagnoseCapabilities(config, configDir, versionAvailable, failures, warnings) {
  const modes = config.experimental_capabilities || {}
  const availability = Object.fromEntries(
    Object.entries(CAPABILITY_ENVIRONMENT).map(([name, variable]) => {
      const explicit = process.env[variable]
      return [name, {
        available: environmentFlagEnabled(explicit ?? process.env.OPENCODE_EXPERIMENTAL),
        source: explicit === undefined ? 'OPENCODE_EXPERIMENTAL' : variable,
      }]
    }),
  )
  availability.plugin_v2 = {
    available: versionAvailable && fs.existsSync(path.join(configDir, 'plugins', 'auto-workflow.ts')),
    source: 'installed OpenCode plugin runtime',
  }

  for (const [name, status] of Object.entries(availability)) {
    const mode = modes[name] || 'disabled'
    if (mode === 'disabled') {
      console.log(`SKIP capability ${name} is disabled`)
    } else if (status.available) {
      console.log(`PASS capability ${name} is available (${mode})`)
    } else if (mode === 'required') {
      failures.push(`Required capability ${name} is unavailable; enable ${status.source}.`)
    } else {
      warnings.push(`Capability ${name} is unavailable in auto mode; enable ${status.source} to use it.`)
    }
  }
}

export function doctor() {
  const configDir = getConfigDir()
  const failures = []
  const warnings = []
  console.log(`OpenCode Workflows doctor\nConfig dir: ${configDir}`)

  const version = checkOpenCodeVersion()
  if (!version.ok) failures.push(version.error)
  else console.log(`PASS OpenCode version ${version.version}`)
  if (version.warning) warnings.push(version.warning)

  const workflowPath = path.join(configDir, 'workflows.json')
  let workflowConfig = null
  if (!fs.existsSync(workflowPath)) {
    failures.push('workflows.json is missing.')
  } else {
    const validation = validateWithScript(['--config', workflowPath])
    if (validation.ok) {
      console.log('PASS workflows.json schema')
      workflowConfig = loadWorkflowConfig(configDir)
    }
    else failures.push(validation.output || 'workflows.json validation failed.')
  }

  const manifestPath = path.join(configDir, MANIFEST_NAME)
  const manifest = readManifest(configDir)
  if (!manifest) {
    failures.push('Installation manifest is missing or invalid.')
  } else if (manifest.schema_version !== MANIFEST_VERSION) {
    failures.push(`Manifest schema ${manifest.schema_version ?? 'unknown'} is unsupported; reinstall to migrate it.`)
  } else {
    const validation = validateWithScript(['--manifest', manifestPath])
    if (!validation.ok) failures.push(validation.output || 'Manifest validation failed.')
    if (path.resolve(manifest.target?.config_dir || '') !== configDir) {
      failures.push('Manifest target does not match OPENCODE_CONFIG_DIR.')
    }
    const unowned = manifestRecords(manifest, configDir)
      .filter(({ record, target }) => pathExists(target) && !isOwnedRecord(target, record))
    if (unowned.length > 0) warnings.push(`${unowned.length} managed file(s) were modified and will be preserved.`)
    else console.log('PASS managed file ownership')
  }

  for (const legacy of ['command', 'skill', 'plugin', 'tool']) {
    if (fs.existsSync(path.join(configDir, legacy))) {
      warnings.push(`Legacy singular directory remains: ${legacy}/`)
    }
  }

  if (workflowConfig) diagnoseCapabilities(workflowConfig, configDir, version.ok, failures, warnings)

  for (const warning of warnings) console.warn(`WARN ${warning}`)
  for (const failure of failures) console.error(`FAIL ${failure}`)
  if (failures.length > 0) throw new Error(`Doctor found ${failures.length} failure(s).`)
  console.log(`Doctor passed with ${warnings.length} warning(s).`)
}

function migrateCandidate(value) {
  if (typeof value === 'string') return { value: { model: value }, changed: true }
  return { value, changed: false }
}

function migrateCandidateList(value) {
  if (!Array.isArray(value)) return { value, changed: false }
  let changed = false
  const migrated = value.map((candidate) => {
    const result = migrateCandidate(candidate)
    changed ||= result.changed
    return result.value
  })
  return { value: migrated, changed }
}

export function migrateWorkflowConfig(dryRun = false) {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, 'workflows.json')
  if (!fs.existsSync(filePath)) throw new Error(`No workflows.json found in ${configDir}.`)
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  let changed = false

  if (!config.$schema) {
    config.$schema = './schema/workflows.schema.json'
    changed = true
  }
  if (!config.schema_version) {
    config.schema_version = 1
    changed = true
  }
  if (!config.model_tiers) {
    config.model_tiers = { low: [], mid: [], high: [] }
    changed = true
  }
  for (const tier of ['low', 'mid', 'high']) {
    if (!config.model_tiers[tier]) {
      config.model_tiers[tier] = []
      changed = true
    }
    const result = migrateCandidateList(config.model_tiers[tier])
    config.model_tiers[tier] = result.value
    changed ||= result.changed
  }
  if (!config.agent_models) {
    config.agent_models = {}
    changed = true
  }
  for (const [agent, value] of Object.entries(config.agent_models)) {
    if (agent.startsWith('_')) continue
    const result = Array.isArray(value) ? migrateCandidateList(value) : migrateCandidate(value)
    config.agent_models[agent] = result.value
    changed ||= result.changed
  }
  const fallbacks = migrateCandidateList(config.fallback_order || [])
  config.fallback_order = fallbacks.value
  changed ||= fallbacks.changed
  if (!config.agent_variants) {
    config.agent_variants = {}
    changed = true
  }
  if (!config.automation) {
    config.automation = { enabled: false }
    changed = true
  }
  if (!config.experimental_capabilities) {
    config.experimental_capabilities = {}
    changed = true
  }
  for (const capability of ['background_subagents', 'native_workspaces', 'plugin_v2', 'mcp_code_mode', 'references']) {
    const current = config.experimental_capabilities[capability]
    if (typeof current === 'boolean') {
      config.experimental_capabilities[capability] = current ? 'auto' : 'disabled'
      changed = true
    } else if (current === undefined) {
      config.experimental_capabilities[capability] = 'disabled'
      changed = true
    }
  }
  if (config.delegation && typeof config.delegation === 'object') {
    for (const provider of ['claude', 'gemini']) {
      const providerConfig = config.delegation[provider]
      if (providerConfig && typeof providerConfig === 'object' && 'model' in providerConfig) {
        delete providerConfig.model
        changed = true
      }
    }
  }

  if (config.automation?.enabled === true && typeof config.automation === 'object' && !Array.isArray(config.automation)) {
    for (const target of ['max_bounded_read_bytes', 'max_bounded_write_bytes']) {
      if (config.automation[target] === undefined) {
        config.automation[target] = 0
        changed = true
      }
    }
  }

  // Loading supplies these defaults without rewriting user configuration. A migration
  // persists them only when another normalization has already made a write necessary.
  if (changed && config.automation && typeof config.automation === 'object'
    && !Array.isArray(config.automation) && config.automation.autonomy === undefined) {
    config.automation.autonomy = 'interactive'
  }
  if (changed && config.publication === undefined) {
    config.publication = { enabled: false, internal_markers: [], targets: {} }
  }
  if (changed && config.epic === undefined) {
    config.epic = { enabled: false }
  }

  if (!changed) {
    console.log('workflows.json is already current; no migration needed.')
    return
  }
  if (dryRun) {
    console.log('Migration would normalize workflow candidates, capability flags, bounded byte budgets, and delegation settings; when absent, it would also initialize disabled publication and epic defaults.')
    return
  }

  const originalMode = fs.statSync(filePath).mode & 0o777
  const backupPath = writeJsonConfigWithBackup(configDir, filePath, config, originalMode)
  console.log(`Migrated ${filePath}`)
  console.log(`Original preserved at ${backupPath}`)
  console.log('Restart OpenCode to load the migrated workflow configuration.')
}

function writeJsonConfigWithBackup(configDir, filePath, value, mode = 0o600) {
  const backupPath = nextBackupPath(filePath)
  const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`
  assertSafeManagedParent(configDir, filePath)
  assertSafeManagedParent(configDir, backupPath)
  writeFileNoFollow(backupPath, fs.readFileSync(filePath), 0o600, true)
  try {
    writeFileNoFollow(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, mode, true)
    fs.renameSync(temporaryPath, filePath)
    try { fs.chmodSync(filePath, mode) } catch {}
  } finally {
    if (pathExists(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
  return backupPath
}

export function configureAutonomy(profile, dryRun = false) {
  if (!AUTONOMY_PROFILES.has(profile)) {
    throw new Error(`Invalid autonomy profile: ${profile}. Expected interactive or bounded.`)
  }

  const configDir = getConfigDir()
  const filePath = path.join(configDir, 'workflows.json')
  if (!pathExists(filePath)) throw new Error(`No workflows.json found in ${configDir}.`)
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`workflows.json must be a regular file: ${filePath}`)
  }

  let config
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse workflows.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('workflows.json must contain a JSON object.')
  }
  if (!config.automation || typeof config.automation !== 'object' || Array.isArray(config.automation)) {
    throw new Error('workflows.json automation must be an object; no settings were changed.')
  }
  if (config.automation.autonomy === profile) {
    console.log(`Autonomy is already ${profile}; no changes needed.`)
    return
  }

  config.automation.autonomy = profile
  if (dryRun) {
    console.log(`[dry-run] Would set automation.autonomy to ${profile} in ${filePath}.`)
    console.log('Autonomy configures automatic-stage permission handling only; automation and budgets are unchanged.')
    return
  }

  const backupPath = writeJsonConfigWithBackup(configDir, filePath, config)
  console.log(`Set automation.autonomy to ${profile} in ${filePath}.`)
  console.log(`Original preserved at ${backupPath}`)
  console.log('Autonomy configures automatic-stage permission handling only; automation and budgets are unchanged.')
  console.log('Restart OpenCode to load the updated workflow configuration.')
}

export function uninstall(dryRun = false) {
  const configDir = getConfigDir()
  const manifestPath = path.join(configDir, MANIFEST_NAME)
  const manifest = readManifest(configDir)
  if (!manifest) throw new Error('No valid installation manifest found. Nothing was removed.')

  let removed = 0
  let preserved = 0
  for (const { record, target } of manifestRecords(manifest, configDir)) {
    if (['opencode.json', 'opencode.jsonc', 'workflows.json'].includes(path.basename(target))) {
      preserved += 1
      continue
    }
    if (!pathExists(target)) continue
    if (!isOwnedRecord(target, record)) {
      console.warn(`Warning: Preserved modified or unverified file: ${target}`)
      preserved += 1
      continue
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}remove ${target}`)
    if (!dryRun) {
      assertSafeManagedParent(configDir, target)
      removePath(target)
    }
    removed += 1
  }

  if (!dryRun) {
    assertSafeManagedParent(configDir, manifestPath)
    removePath(manifestPath)
  }
  for (const relative of [
    'agents', 'commands', 'skills', 'plugins', 'tools', 'mode', 'lib', 'templates', 'workflow', 'schema',
    path.join('workflows', 'active'), path.join('workflows', 'completed'), 'plans',
  ]) {
    const directory = path.join(configDir, relative)
    try {
      if (!dryRun) {
        assertSafeManagedParent(configDir, path.join(directory, '.managed-child'))
        if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
      }
    } catch {
      // Missing and non-empty directories are intentionally retained.
    }
  }
  console.log(`Uninstall complete: ${removed} removed, ${preserved} preserved.`)
  if (!dryRun) console.log('Restart OpenCode to unload the removed agents, commands, skills, and plugins.')
}

function printHelp() {
  console.log(`OpenCode Workflows Installer

Usage:
  node install.mjs [options]

Options:
  --copy                 Copy files (default)
  --symlink              Symlink unchanged files for development
  --materialize-models   Legacy mode: bake configured model candidates into frontmatter
  --all                  Install core and translation modules
  --module <name>        Install core or translation module
  --doctor               Validate version, config, manifest, and managed files
  --migrate              Migrate model candidates, capability flags, and delegation settings
  --autonomy <profile>   Set automatic-stage permission handling to interactive or
                         bounded only; does not
                         enable automation or create/change automation budgets
  --uninstall            Safely remove owned installed files; preserve user configs
  --dry-run              Preview install, autonomy, migration, or uninstall actions
  --help                 Show this help

Runtime model inheritance is the default. Candidate availability and variants are
validated against OpenCode's live config.providers catalog by runtime integrations.
Restart OpenCode after install, migration, or uninstall.`)
}

function parseCli(args) {
  const knownFlags = new Set([
    '--copy', '--symlink', '--materialize-models', '--all', '--doctor', '--migrate',
    '--uninstall', '--dry-run', '--help', '-h', '--runtime-models', '--no-model-resolve',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--module' || arg === '--autonomy') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} requires a value.`)
      index += 1
      continue
    }
    if (!knownFlags.has(arg)) throw new Error(`Unknown option: ${arg}`)
  }
}

export function main(args = process.argv.slice(2)) {
  parseCli(args)
  if (args.includes('--help') || args.includes('-h')) return printHelp()
  const dryRun = args.includes('--dry-run')
  const actions = ['--doctor', '--migrate', '--autonomy', '--uninstall'].filter((flag) => args.includes(flag))
  if (actions.length > 1) throw new Error(`${actions.join(', ')} cannot be combined.`)
  if (args.includes('--doctor')) return doctor()
  if (args.includes('--migrate')) return migrateWorkflowConfig(dryRun)
  if (args.includes('--autonomy')) {
    const autonomyIndex = args.indexOf('--autonomy')
    const allowedIndexes = new Set([autonomyIndex, autonomyIndex + 1])
    const unsupported = args.filter((arg, index) => arg !== '--dry-run' && !allowedIndexes.has(index))
    if (unsupported.length > 0 || args.lastIndexOf('--autonomy') !== autonomyIndex) {
      throw new Error('--autonomy can only be combined with --dry-run.')
    }
    return configureAutonomy(args[autonomyIndex + 1], dryRun)
  }
  if (args.includes('--uninstall')) return uninstall(dryRun)

  const modules = ['core']
  if (args.includes('--all')) modules.push('translate')
  const moduleIndex = args.indexOf('--module')
  if (moduleIndex !== -1) {
    const requested = args[moduleIndex + 1]
    if (!['core', 'translate'].includes(requested)) throw new Error(`Unknown module: ${requested}`)
    if (!modules.includes(requested)) modules.push(requested)
  }
  return install(
    modules,
    args.includes('--symlink') ? 'symlink' : 'copy',
    dryRun,
    { materializeModels: args.includes('--materialize-models') },
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
