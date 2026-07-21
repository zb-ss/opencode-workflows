import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MAX_BOUNDED_IO_BYTES, configuredCandidates, transformModelMetadata } from '../install.mjs'
import {
  MAX_BOUNDED_IO_BYTES as RUNTIME_MAX_BOUNDED_IO_BYTES,
  MAX_REVIEW_ITERATIONS,
  MAX_REVIEW_RESULT_BYTES,
  MAX_VALIDATION_OUTPUT_BYTES,
  MAX_VALIDATION_RUNS_PER_WORKFLOW,
  MAX_VALIDATION_TIMEOUT_MS,
} from '../lib/workflow-config.ts'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INSTALLER = path.join(REPO_ROOT, 'install.mjs')
const temporaryRoots = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function createFixture(version = '1.17.20') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-workflows-test-'))
  temporaryRoots.push(root)
  const configDir = path.join(root, 'config')
  const otherConfigHome = path.join(root, 'other-config')
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  const opencodePath = path.join(binDir, 'opencode')
  const npmPath = path.join(binDir, 'npm')
  fs.writeFileSync(opencodePath, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 })
  fs.writeFileSync(npmPath, '#!/bin/sh\nif [ "$FAKE_NPM_FAIL" = "1" ]; then exit 7; fi\nexit 0\n', { mode: 0o755 })

  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: otherConfigHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  }
  return { root, configDir, otherConfigHome, env }
}

function runInstaller(fixture, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: REPO_ROOT,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  })
}

function workflowConfig() {
  return {
    $schema: './schema/workflows.schema.json',
    schema_version: 1,
    model_tiers: {
      low: [],
      mid: ['provider/primary'],
      high: [],
    },
    agent_models: {},
    agent_variants: { 'wf-executor': 'balanced' },
    fallback_order: ['provider/fallback'],
    default_mode: 'standard',
    automation: { enabled: false },
    experimental_capabilities: {
      background_subagents: 'disabled',
      native_workspaces: 'disabled',
      plugin_v2: 'disabled',
      mcp_code_mode: 'disabled',
      references: 'disabled',
    },
  }
}

describe('production model materialization helpers', () => {
  it('normalizes ordered candidates and materializes the configured variant', () => {
    const config = workflowConfig()
    config.agent_models['wf-executor'] = [
      { model: 'provider/specific', variant: 'precise' },
      'provider/secondary',
    ]
    assert.deepEqual(configuredCandidates(config, 'wf-executor', 'mid'), [
      { model: 'provider/specific', variant: 'precise' },
      { model: 'provider/secondary', variant: 'balanced' },
      { model: 'provider/fallback', variant: 'balanced' },
    ])

    const result = transformModelMetadata('---\nmodel_tier: mid\nmode: subagent\n---\n', 'wf-executor', config, 'materialize')
    assert.match(result.content, /^model: "provider\/specific"$/m)
    assert.match(result.content, /^variant: "precise"$/m)
    assert.doesNotMatch(result.content, /model_tier:/)
  })

  it('uses runtime inheritance by default without emitting model-bound variant metadata', () => {
    const result = transformModelMetadata(
      '---\nmodel_tier: mid\nmode: subagent\n---\n',
      'wf-executor',
      workflowConfig(),
    )
    assert.doesNotMatch(result.content, /model_tier:|^model:/m)
    assert.doesNotMatch(result.content, /^variant:/m)
  })
})

describe('installer subprocess', () => {
  it('updates only autonomy with private writes, numbered backups, and dry-run support', () => {
    const fixture = createFixture()
    const config = workflowConfig()
    config.custom_preserved_data = { nested: ['unchanged'] }
    const original = `${JSON.stringify(config, null, 2)}\n`
    const configPath = path.join(fixture.configDir, 'workflows.json')
    fs.writeFileSync(configPath, original, { mode: 0o644 })

    const dryRun = runInstaller(fixture, ['--autonomy', 'bounded', '--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout)
    assert.match(dryRun.stdout, /automatic-stage permission handling only/)
    assert.equal(fs.readFileSync(configPath, 'utf8'), original)
    assert.equal(fs.existsSync(`${configPath}.backup`), false)

    const applied = runInstaller(fixture, ['--autonomy', 'bounded'])
    assert.equal(applied.status, 0, applied.stderr || applied.stdout)
    assert.match(applied.stdout, /does not enable automation|automation and budgets are unchanged/)
    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(updated.automation.autonomy, 'bounded')
    assert.equal(updated.automation.enabled, false)
    assert.equal(Object.hasOwn(updated.automation, 'max_sessions'), false)
    assert.deepEqual(updated.custom_preserved_data, config.custom_preserved_data)
    assert.equal(fs.readFileSync(`${configPath}.backup`, 'utf8'), original)
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(`${configPath}.backup`).mode & 0o777, 0o600)

    const second = runInstaller(fixture, ['--autonomy', 'interactive'])
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.equal(fs.existsSync(`${configPath}.backup.1`), true)
    assert.equal(fs.statSync(`${configPath}.backup.1`).mode & 0o777, 0o600)
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).automation.autonomy, 'interactive')
  })

  it('rejects invalid autonomy profiles and missing or malformed installed configs', () => {
    const missingFixture = createFixture()
    const missing = runInstaller(missingFixture, ['--autonomy', 'bounded'])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /No workflows\.json found/)

    const malformedFixture = createFixture()
    fs.writeFileSync(path.join(malformedFixture.configDir, 'workflows.json'), '{not-json')
    const malformed = runInstaller(malformedFixture, ['--autonomy', 'bounded'])
    assert.notEqual(malformed.status, 0)
    assert.match(malformed.stderr, /Cannot parse workflows\.json/)

    const invalidFixture = createFixture()
    fs.writeFileSync(path.join(invalidFixture.configDir, 'workflows.json'), `${JSON.stringify(workflowConfig())}\n`)
    const invalid = runInstaller(invalidFixture, ['--autonomy', 'unrestricted'])
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Invalid autonomy profile/)
  })

  it('adds safe autonomy, publication, and epic defaults only when migration is already changing the config', () => {
    const currentFixture = createFixture()
    const currentPath = path.join(currentFixture.configDir, 'workflows.json')
    const current = workflowConfig()
    current.model_tiers.mid = [{ model: 'provider/primary' }]
    current.fallback_order = [{ model: 'provider/fallback' }]
    const currentContent = `${JSON.stringify(current, null, 2)}\n`
    fs.writeFileSync(currentPath, currentContent)
    const unchanged = runInstaller(currentFixture, ['--migrate'])
    assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout)
    assert.match(unchanged.stdout, /already current/)
    assert.equal(fs.readFileSync(currentPath, 'utf8'), currentContent)
    assert.equal(fs.existsSync(`${currentPath}.backup`), false)
    assert.equal(Object.hasOwn(JSON.parse(currentContent), 'publication'), false)
    assert.equal(Object.hasOwn(JSON.parse(currentContent), 'epic'), false)

    const legacyFixture = createFixture()
    const legacyPath = path.join(legacyFixture.configDir, 'workflows.json')
    fs.writeFileSync(legacyPath, `${JSON.stringify(workflowConfig(), null, 2)}\n`)
    const preview = runInstaller(legacyFixture, ['--migrate', '--dry-run'])
    assert.equal(preview.status, 0, preview.stderr || preview.stdout)
    assert.match(preview.stdout, /initialize disabled publication and epic defaults/)
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(legacyPath, 'utf8')), 'publication'), false)
    const migrated = runInstaller(legacyFixture, ['--migrate'])
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout)
    const migratedLegacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
    assert.equal(migratedLegacy.automation.autonomy, 'interactive')
    assert.deepEqual(migratedLegacy.publication, { enabled: false, internal_markers: [], targets: {} })
    assert.deepEqual(migratedLegacy.epic, { enabled: false })

    const preservedFixture = createFixture()
    const preservedPath = path.join(preservedFixture.configDir, 'workflows.json')
    const preservedConfig = workflowConfig()
    preservedConfig.publication = {
      enabled: false,
      internal_markers: [{ id: 'internal', literal: 'internal-only', case_sensitive: false }],
      targets: { draft: { display_name: 'Draft destination' } },
    }
    fs.writeFileSync(preservedPath, `${JSON.stringify(preservedConfig, null, 2)}\n`)
    const preservedMigration = runInstaller(preservedFixture, ['--migrate'])
    assert.equal(preservedMigration.status, 0, preservedMigration.stderr || preservedMigration.stdout)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(preservedPath, 'utf8')).publication,
      preservedConfig.publication,
    )

    const budgetFixture = createFixture()
    const budgetPath = path.join(budgetFixture.configDir, 'workflows.json')
    const budgetConfig = workflowConfig()
    budgetConfig.model_tiers.mid = [{ model: 'provider/primary' }]
    budgetConfig.fallback_order = [{ model: 'provider/fallback' }]
    budgetConfig.automation = {
      enabled: true,
      autonomy: 'interactive',
      max_parallel_sessions: 1,
      max_sessions: 2,
      max_attempts_per_stage: 2,
      max_wall_time_ms: 1000,
      max_input_tokens: 500,
      max_output_tokens: 250,
      max_cost_usd: null,
    }
    fs.writeFileSync(budgetPath, `${JSON.stringify(budgetConfig, null, 2)}\n`)
    const budgetMigration = runInstaller(budgetFixture, ['--migrate'])
    assert.equal(budgetMigration.status, 0, budgetMigration.stderr || budgetMigration.stdout)
    const migratedBudget = JSON.parse(fs.readFileSync(budgetPath, 'utf8')).automation
    assert.equal(migratedBudget.max_bounded_read_bytes, 0)
    assert.equal(migratedBudget.max_bounded_write_bytes, 0)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(budgetPath, 'utf8')).publication,
      { enabled: false, internal_markers: [], targets: {} },
    )
  })

  it('keeps bounded I/O safety caps consistent across runtime and schemas', () => {
    assert.equal(MAX_BOUNDED_IO_BYTES, RUNTIME_MAX_BOUNDED_IO_BYTES)
    const workflowSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schema', 'workflows.schema.json'), 'utf8'))
    const stateSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schema', 'workflow-state.schema.json'), 'utf8'))
    const configured = workflowSchema.properties.automation.properties
    const persisted = stateSchema.properties.budget.properties.limits.properties
    for (const field of ['max_bounded_read_bytes', 'max_bounded_write_bytes']) {
      assert.equal(configured[field].maximum, MAX_BOUNDED_IO_BYTES)
      assert.equal(persisted[field].maximum, MAX_BOUNDED_IO_BYTES)
    }
    const validationOperation = workflowSchema.$defs.validationOperation.properties
    assert.equal(validationOperation.timeout_ms.maximum, MAX_VALIDATION_TIMEOUT_MS)
    assert.equal(validationOperation.max_output_bytes.maximum, MAX_VALIDATION_OUTPUT_BYTES)
    assert.equal(workflowSchema.properties.validation_broker.properties.max_runs_per_workflow.maximum, MAX_VALIDATION_RUNS_PER_WORKFLOW)
    assert.equal(persisted.max_validation_runs.maximum, MAX_VALIDATION_RUNS_PER_WORKFLOW)
    assert.equal(workflowSchema.properties.review_loop.properties.max_iterations.maximum, MAX_REVIEW_ITERATIONS)
    assert.equal(workflowSchema.properties.review_loop.properties.batch_timeout_ms.maximum, MAX_VALIDATION_TIMEOUT_MS)
    assert.equal(workflowSchema.properties.review_loop.properties.max_result_bytes.maximum, MAX_REVIEW_RESULT_BYTES)
  })

  it('describes autonomy as automatic-stage permission handling only in help output', () => {
    const fixture = createFixture()
    const result = runInstaller(fixture, ['--help'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /--autonomy <profile>/)
    assert.match(result.stdout, /automatic-stage permission handling/)
    assert.match(result.stdout, /does not\s+enable automation/)
  })

  it('installs, diagnoses, migrates, reinstalls, and safely uninstalls in isolation', () => {
    const fixture = createFixture()
    const opencodeConfig = `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', username: 'Example User' }, null, 2)}\n`
    const workflowsConfig = `${JSON.stringify(workflowConfig(), null, 2)}\n`
    fs.writeFileSync(path.join(fixture.configDir, 'opencode.json'), opencodeConfig)
    fs.writeFileSync(path.join(fixture.configDir, 'workflows.json'), workflowsConfig)

    const installed = runInstaller(fixture)
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)
    assert.match(installed.stdout, /Model strategy: runtime inheritance/)
    assert.match(installed.stdout, /Restart OpenCode/)
    assert.equal(fs.existsSync(fixture.otherConfigHome), false, 'OPENCODE_CONFIG_DIR must win over XDG_CONFIG_HOME')

    const executorPath = path.join(fixture.configDir, 'agents', 'wf-executor.md')
    const executor = fs.readFileSync(executorPath, 'utf8')
    assert.doesNotMatch(executor, /model_tier:|^model:/m)
    assert.doesNotMatch(executor, /^variant:/m)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'commands', 'workflow.md')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'commands', 'workflow-auto.md')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'command')), false)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'plugins', 'external-cli-delegation.ts')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'plugins', 'auto-workflow.ts')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'tools', 'delegate_command.ts')), false)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'workflow', 'development.json')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'schema', 'workflows.schema.json')), true)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'schema', 'workflow-definition.schema.json')), true)
    assert.equal(fs.readFileSync(path.join(fixture.configDir, 'opencode.json'), 'utf8'), opencodeConfig)
    assert.equal(fs.readFileSync(path.join(fixture.configDir, 'workflows.json'), 'utf8'), workflowsConfig)

    const manifestPath = path.join(fixture.configDir, '.opencode-workflows-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.schema_version, 2)
    assert.equal(manifest.package.name, 'opencode-workflows')
    assert.equal(manifest.target.config_dir, fixture.configDir)
    assert.equal(manifest.install.model_strategy, 'runtime')
    assert.ok(manifest.files.every((record) => typeof record.path === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)))
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(fixture.configDir, 'workflows', 'active')).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(fixture.configDir, 'opencode-workflows.env')).mode & 0o777, 0o600)

    const doctor = runInstaller(fixture, ['--doctor'])
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout)
    assert.match(doctor.stdout, /PASS workflows.json schema/)
    assert.match(doctor.stdout, /SKIP capability background_subagents is disabled/)

    const conventionsPath = path.join(fixture.configDir, 'CONVENTIONS.md')
    fs.appendFileSync(conventionsPath, '\nLocal conventions remain active.\n')
    const secondInstall = runInstaller(fixture)
    assert.equal(secondInstall.status, 0, secondInstall.stderr || secondInstall.stdout)
    assert.equal(fs.existsSync(`${executorPath}.backup`), false, 'owned files should update without backups')
    assert.match(fs.readFileSync(conventionsPath, 'utf8'), /Local conventions remain active/)
    assert.equal(fs.existsSync(`${conventionsPath}.backup`), false, 'modified user guidance should remain active')
    assert.equal(fs.readFileSync(path.join(fixture.configDir, 'opencode.json'), 'utf8'), opencodeConfig)
    assert.equal(fs.readFileSync(path.join(fixture.configDir, 'workflows.json'), 'utf8'), workflowsConfig)

    const legacyWorkflowConfig = JSON.parse(workflowsConfig)
    legacyWorkflowConfig.delegation = {
      claude: { model: 'stale-claude-alias', timeout_ms: 10000 },
      gemini: { model: 'stale-gemini-alias', timeout_ms: 10000 },
    }
    fs.writeFileSync(
      path.join(fixture.configDir, 'workflows.json'),
      `${JSON.stringify(legacyWorkflowConfig, null, 2)}\n`,
    )
    fs.chmodSync(path.join(fixture.configDir, 'workflows.json'), 0o600)
    const migrated = runInstaller(fixture, ['--migrate'])
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout)
    const migratedConfig = JSON.parse(fs.readFileSync(path.join(fixture.configDir, 'workflows.json'), 'utf8'))
    assert.deepEqual(migratedConfig.model_tiers.mid, [{ model: 'provider/primary' }])
    assert.deepEqual(migratedConfig.fallback_order, [{ model: 'provider/fallback' }])
    assert.deepEqual(migratedConfig.delegation, {
      claude: { timeout_ms: 10000 },
      gemini: { timeout_ms: 10000 },
    })
    assert.deepEqual(migratedConfig.publication, { enabled: false, internal_markers: [], targets: {} })
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'workflows.json.backup')), true)
    assert.equal(fs.statSync(path.join(fixture.configDir, 'workflows.json')).mode & 0o777, 0o600)

    const stalePath = path.join(fixture.configDir, 'commands', 'stale.md')
    fs.writeFileSync(stalePath, 'user-owned\n')
    const staleManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    staleManifest.files.push({
      path: 'commands/stale.md',
      source: 'command/stale.md',
      mode: 'copy',
      sha256: '0'.repeat(64),
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`)
    const ownershipInstall = runInstaller(fixture)
    assert.equal(ownershipInstall.status, 0, ownershipInstall.stderr || ownershipInstall.stdout)
    assert.match(ownershipInstall.stderr, /ownership could not be verified/)
    assert.equal(fs.readFileSync(stalePath, 'utf8'), 'user-owned\n')

    fs.appendFileSync(executorPath, '\nuser modification\n')
    const uninstalled = runInstaller(fixture, ['--uninstall'])
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout)
    assert.match(uninstalled.stdout, /Restart OpenCode/)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'plugins', 'external-cli-delegation.ts')), false)
    assert.equal(fs.existsSync(executorPath), true, 'modified managed files must be preserved')
    assert.equal(fs.existsSync(stalePath), true, 'unverified stale files must be preserved')
    assert.equal(fs.readFileSync(path.join(fixture.configDir, 'opencode.json'), 'utf8'), opencodeConfig)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.configDir, 'workflows.json'), 'utf8')), migratedConfig)
    assert.equal(fs.existsSync(manifestPath), false)
  })

  it('returns nonzero when dependency installation fails', () => {
    const fixture = createFixture()
    const result = runInstaller(fixture, [], { FAKE_NPM_FAIL: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Dependency installation failed/)
  })

  it('fails doctor when a required runtime capability is unavailable', () => {
    const fixture = createFixture()
    const config = workflowConfig()
    config.experimental_capabilities.native_workspaces = 'required'
    fs.writeFileSync(path.join(fixture.configDir, 'workflows.json'), `${JSON.stringify(config, null, 2)}\n`)

    const installed = runInstaller(fixture)
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)

    const doctor = runInstaller(fixture, ['--doctor'], { OPENCODE_EXPERIMENTAL_WORKSPACES: '0' })
    assert.notEqual(doctor.status, 0)
    assert.match(doctor.stderr, /Required capability native_workspaces is unavailable/)
  })

  it('backs up unverified manifest-owned singular files before installing plural replacements', () => {
    const fixture = createFixture()
    fs.writeFileSync(path.join(fixture.configDir, 'workflows.json'), `${JSON.stringify(workflowConfig(), null, 2)}\n`)
    const singularDirectory = path.join(fixture.configDir, 'command')
    const singularPath = path.join(singularDirectory, 'workflow.md')
    const singularSkillDirectory = path.join(fixture.configDir, 'skill', 'example')
    fs.mkdirSync(singularDirectory, { recursive: true })
    fs.mkdirSync(singularSkillDirectory, { recursive: true })
    fs.writeFileSync(singularPath, 'locally modified legacy command\n')
    fs.writeFileSync(path.join(singularSkillDirectory, 'SKILL.md'), 'legacy skill\n')
    fs.writeFileSync(path.join(fixture.configDir, '.opencode-workflows-manifest.json'), JSON.stringify({
      schema_version: 1,
      files: [singularPath, singularSkillDirectory],
    }))

    const result = runInstaller(fixture)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(fs.existsSync(singularPath), false)
    const backupDirectory = path.join(fixture.configDir, '.opencode-workflows-backups')
    assert.equal(fs.existsSync(backupDirectory), true, `${result.stdout}\n${result.stderr}`)
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'command__workflow.md.backup'), 'utf8'), 'locally modified legacy command\n')
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'skill__example.backup', 'SKILL.md'), 'utf8'), 'legacy skill\n')
    assert.equal(fs.existsSync(singularSkillDirectory), false)
    assert.equal(fs.existsSync(path.join(fixture.configDir, 'commands', 'workflow.md')), true)
  })

  it('refuses managed writes through symlinked config subdirectories', () => {
    const fixture = createFixture()
    const outside = path.join(fixture.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(fixture.configDir, 'agents'), 'dir')

    const result = runInstaller(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Managed parent must not be a symbolic link/)
    assert.deepEqual(fs.readdirSync(outside), [])
  })

  it('validates workflow runtime directories before recursive creation', () => {
    const fixture = createFixture()
    const outside = path.join(fixture.root, 'outside-workflows')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(fixture.configDir, 'workflows'), 'dir')

    const result = runInstaller(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Managed parent must not be a symbolic link/)
    assert.deepEqual(fs.readdirSync(outside), [])
  })

  it('materializes models only when the legacy flag is explicit', () => {
    const fixture = createFixture()
    fs.writeFileSync(path.join(fixture.configDir, 'workflows.json'), `${JSON.stringify(workflowConfig(), null, 2)}\n`)
    const result = runInstaller(fixture, ['--materialize-models'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const executor = fs.readFileSync(path.join(fixture.configDir, 'agents', 'wf-executor.md'), 'utf8')
    assert.match(executor, /^model: "provider\/primary"$/m)
    assert.match(executor, /^variant: "balanced"$/m)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(fixture.configDir, '.opencode-workflows-manifest.json'), 'utf8')).install.model_strategy,
      'materialize',
    )
  })

  it('rejects old OpenCode versions and warns for newer versions', () => {
    const oldFixture = createFixture('1.17.19')
    const oldResult = runInstaller(oldFixture, ['--dry-run'])
    assert.notEqual(oldResult.status, 0)
    assert.match(oldResult.stderr, /1\.17\.20 or newer is required/)

    const newFixture = createFixture('1.18.0')
    const newResult = runInstaller(newFixture, ['--dry-run'])
    assert.equal(newResult.status, 0, newResult.stderr || newResult.stdout)
    assert.match(newResult.stderr, /newer than the tested version 1\.17\.20/)
  })
})
