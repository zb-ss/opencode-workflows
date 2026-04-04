#!/usr/bin/env node

/**
 * OpenCode Workflows Installer
 *
 * Cross-platform installer that places agents, commands, skills, plugins,
 * tools, and config files into ~/.config/opencode/ via symlinks or copies.
 *
 * Usage:
 *   node install.mjs                       # Install core (symlink mode)
 *   node install.mjs --copy                # Install core (copy mode)
 *   node install.mjs --runtime-models      # Keep model selection in opencode.jsonc
 *   node install.mjs --all                 # Install core + translate
 *   node install.mjs --module translate    # Add translate module
 *   node install.mjs --uninstall           # Remove all installed files
 *   node install.mjs --dry-run             # Preview actions
 *   node install.mjs --help                # Show usage
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Module definitions
// ---------------------------------------------------------------------------

const MODULES = {
  core: {
    agents_primary: [
      "primary/supervisor.md",
      "primary/delegator.md",
      "primary/editor.md",
      "primary/focused-build.md",
      "primary/debug.md",
      "primary/org-planner.md",
      "primary/step-planner.md",
      "primary/discussion.md",
      "primary/web-tester.md",
      "primary/figma-builder.md",
    ],
    agents_workflow: [
      "workflow/architect.md",
      "workflow/architect-lite.md",
      "workflow/executor.md",
      "workflow/executor-lite.md",
      "workflow/reviewer.md",
      "workflow/reviewer-lite.md",
      "workflow/reviewer-deep.md",
      "workflow/security.md",
      "workflow/security-lite.md",
      "workflow/security-deep.md",
      "workflow/test-writer.md",
      "workflow/quality-gate.md",
      "workflow/completion-guard.md",
      "workflow/codebase-analyzer.md",
      "workflow/perf-reviewer.md",
      "workflow/perf-lite.md",
      "workflow/doc-writer.md",
      "workflow/explorer.md",
      "workflow/e2e-explorer.md",
      "workflow/e2e-generator.md",
      "workflow/e2e-reviewer.md",
    ],
    commands: [
      "plan.md",
      "delegate.md",
      "git-commit.md",
      "git-pr.md",
      "git-pr-checkout.md",
      "git-pr-review.md",
      "git-pr-merge.md",
      "git-release.md",
      "git-issue.md",
      "git-browse.md",
      "git-workflow-run.md",
      "workflow.md",
      "workflow-resume.md",
      "workflow-status.md",
    ],
    skills: [
      "php-conventions",
      "laravel-conventions",
      "symfony-conventions",
      "vue-conventions",
      "vue2-legacy",
      "joomla-conventions",
      "joomla3-legacy",
      "solid-principles",
      "api-design",
      "performance-guide",
      "typescript-conventions",
      "bash-conventions",
      "python-conventions",
    ],
    tools: [
      "delegate_command.ts",
    ],
    plugins: [
      "workflow-notifications.ts",
      "workflow-enforcer.ts",
      "file-validator.ts",
      "model-router.ts",
      "swarm-manager.ts",
      "package.json",
    ],
    modes: [
      "eco.json",
      "turbo.json",
      "standard.json",
      "thorough.json",
      "swarm.json",
    ],
    lib: [
      "types.ts",
      "logger.ts",
      "state.ts",
      "model-registry.ts",
      "mode-rules.ts",
    ],
    templates: [
      "feature-development.org",
      "bug-fix.org",
      "refactor.org",
      "figma-to-code.org",
      "e2e-testing.org",
    ],
    rootFiles: ["CONVENTIONS.md"],
  },
  translate: {
    agents: [
      "translation-planner.md",
      "translation-coder.md",
      "translation-reviewer.md",
    ],
    commands: ["translate-auto.md", "translate-view.md"],
    tools: [
      "i18n-hardcode-finder.ts",
      "i18n-convert.ts",
      "i18n-extract.ts",
      "i18n-verify.ts",
      "ini-builder.ts",
      "file-chunker.ts",
      "chunk-reader.ts",
      "chunk-state.ts",
    ],
    plugins: ["translation-workflow.ts"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.dirname(new URL(import.meta.url).pathname);

function getConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

const MANIFEST_NAME = ".opencode-workflows-manifest.json";
const ENV_FILE_NAME = "opencode-workflows.env";

/** Remove old timestamped backups from previous installer versions */
function cleanupLegacyBackups(target) {
  try {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const legacyPrefix = `${base}.backup.`;

    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(legacyPrefix)) {
        removePath(path.join(dir, entry));
      }
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Normalize old timestamped backups across config dir.
 * Keeps at most one backup per base path as `<target>.backup`.
 */
function normalizeLegacyBackups(configDir, dryRun) {
  const actions = [];

  if (!fs.existsSync(configDir)) return actions;

  /** @type {Map<string, Array<{path: string, mtimeMs: number}>>} */
  const groups = new Map();

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const marker = ".backup.";
      const idx = entry.name.indexOf(marker);
      if (idx === -1) continue;

      const baseName = entry.name.slice(0, idx);
      if (!baseName) continue;

      let mtimeMs = 0;
      try {
        mtimeMs = fs.lstatSync(fullPath).mtimeMs;
      } catch {
        // ignore stat failures
      }

      const basePath = path.join(dir, baseName);
      if (!groups.has(basePath)) groups.set(basePath, []);
      groups.get(basePath).push({ path: fullPath, mtimeMs });
    }
  }

  walk(configDir);

  for (const [basePath, entries] of groups.entries()) {
    const canonical = `${basePath}.backup`;
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const canonicalExists = fs.existsSync(canonical);
    let startDeleteAt = 0;

    if (!canonicalExists && entries.length > 0) {
      const latest = entries[0];
      if (dryRun) {
        actions.push({ action: "backup-normalize", from: latest.path, to: canonical, dryRun: true });
      } else {
        fs.renameSync(latest.path, canonical);
        actions.push({ action: "backup-normalize", from: latest.path, to: canonical });
      }
      startDeleteAt = 1;
    }

    for (let i = startDeleteAt; i < entries.length; i++) {
      const legacy = entries[i].path;
      if (dryRun) {
        actions.push({ action: "backup-clean", target: legacy, dryRun: true });
      } else if (removePath(legacy)) {
        actions.push({ action: "backup-clean", target: legacy });
      }
    }
  }

  return actions;
}

/**
 * Load full workflow configuration from workflows.json.
 * Checks: 1) config dir workflows.json, 2) repo template as fallback.
 * Returns the full config object including model_tiers, agent_models, swarm_config, etc.
 */
function loadWorkflowConfig() {
  const configDir = getConfigDir();
  const candidates = [
    path.join(configDir, "workflows.json"),
    path.join(REPO_ROOT, "workflows.json.template"),
  ];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const config = JSON.parse(raw);
      if (config.model_tiers) {
        // Build resolved tier map (first model in each tier array)
        const model_tiers = {};
        for (const [tier, models] of Object.entries(config.model_tiers)) {
          if (Array.isArray(models) && models.length > 0) {
            model_tiers[tier] = models;
          }
        }

        if (Object.keys(model_tiers).length > 0) {
          console.log(`Workflow config loaded from: ${candidate}`);
          for (const [tier, models] of Object.entries(model_tiers)) {
            console.log(`  ${tier}: ${models[0]}`);
          }

          const agentModels = config.agent_models || {};
          const activeAgentModels = {};
          for (const [key, val] of Object.entries(agentModels)) {
            // Skip comment/example keys
            if (!key.startsWith('_')) {
              activeAgentModels[key] = val;
            }
          }

          return {
            model_tiers,
            agent_models: activeAgentModels,
            fallback_order: config.fallback_order || [],
            default_mode: config.default_mode || 'standard',
            swarm_config: config.swarm_config || {},
          };
        }
      }
    } catch {
      // try next candidate
    }
  }

  console.warn("Warning: No workflows.json found. Agents will not have model: set.");
  return null;
}

/**
 * Resolve the concrete model to use for a given agent and tier.
 * Priority: per-agent override in agent_models > first model in tier array.
 * Returns null if neither is available.
 */
function resolveModelForAgent(agentName, tier, config) {
  // 1. Check per-agent override (skip keys starting with '_')
  const agentModels = config.agent_models || {};
  if (agentName && agentModels[agentName]) {
    const model = agentModels[agentName];
    // Validate model string: must be provider/model-name format, no newlines or YAML-breaking chars
    const MODEL_SAFE_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:@-]+$/;
    if (typeof model === 'string' && MODEL_SAFE_RE.test(model)) {
      return model;
    } else if (typeof model === 'string') {
      console.warn(`  Warning: Invalid or unsafe model format for agent '${agentName}': '${model}' (must match provider/model-name)`);
    }
  }
  // 2. Fall back to tier
  const tiers = config.model_tiers || {};
  if (tier && tiers[tier] && tiers[tier].length > 0) {
    return tiers[tier][0];
  }
  return null;
}

/**
 * Install a file that needs model_tier resolution, replacing model_tier:
 * with model: from config. Always copies (never symlinks) because content
 * is transformed. Used for both agent and command files.
 *
 * @param {string} source - Source file path
 * @param {string} target - Target file path
 * @param {object|null} config - Full workflow config from loadWorkflowConfig()
 * @param {boolean} dryRun - Preview mode
 * @param {string|null} agentName - Agent name for per-agent model override lookup
 * @param {"resolve"|"strip"} modelStrategy - resolve tier to model, or strip tier for runtime config
 */
function installWithModelResolution(source, target, config, dryRun, agentName = null, modelStrategy = "resolve") {
  const actions = [];

  if (!fs.existsSync(source)) {
    actions.push({ action: "skip", source, target, reason: "source missing" });
    return actions;
  }

  const mode = modelStrategy === "strip" ? "strip" : "resolve";

  const raw = fs.readFileSync(source, "utf-8");
  const hasModelTier = /^(model_tier:\s*)(low|mid|high)\s*$/m.test(raw);

  let content = raw;
  let note = mode === "strip"
    ? (hasModelTier ? "model tier stripped" : "runtime model passthrough")
    : (hasModelTier ? "model tier resolved" : "runtime model passthrough");

  if (mode === "resolve") {
    if (config) {
      // Replace model_tier: <tier> with model: <resolved_model>
      content = content.replace(
        /^(model_tier:\s*)(low|mid|high)\s*$/m,
        (_, _prefix, tier) => {
          const resolvedModel = resolveModelForAgent(agentName, tier, config);
          if (resolvedModel) {
            // Log per-agent overrides
            const agentModels = config.agent_models || {};
            if (agentName && agentModels[agentName] === resolvedModel) {
              console.log(`  -> ${agentName}: ${resolvedModel} (per-agent override)`);
            }
            return `model: ${resolvedModel}`;
          }
          return `model_tier: ${tier}`;
        }
      );
    } else if (hasModelTier) {
      note = "model tier unresolved (no workflows config)";
    }
  } else {
    // Remove model_tier line so OpenCode runtime model/agent config controls model selection.
    content = content.replace(/^[ \t]*model_tier:\s*(low|mid|high)\s*\r?\n/m, "");
  }

  if (dryRun) {
    actions.push({ action: "copy", source, target, dryRun: true, note });
    return actions;
  }

  const backup = backupIfNeeded(target);
  if (backup) {
    actions.push({ action: "backup", original: target, backup });
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  removePath(target);

  fs.writeFileSync(target, content);
  actions.push({ action: "copy", source, target, note });
  return actions;
}



/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Check if a path is a symlink pointing into our repo */
function isOurSymlink(target) {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false;
    const resolved = fs.realpathSync(target);
    return resolved.startsWith(REPO_ROOT);
  } catch {
    return false;
  }
}

/** Back up a file/dir that isn't ours before overwriting */
function backupIfNeeded(target) {
  try {
    fs.lstatSync(target);
  } catch {
    return null; // doesn't exist, nothing to back up
  }

  cleanupLegacyBackups(target);

  if (isOurSymlink(target)) return null; // our own symlink, safe to replace

  // Keep exactly one backup per target path.
  const backup = `${target}.backup`;
  removePath(backup);
  fs.renameSync(target, backup);
  return backup;
}

/** Remove a single installed path (file or dir, symlink or real) */
function removePath(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(target);
    } else if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install logic
// ---------------------------------------------------------------------------

function installFile(source, target, mode, dryRun) {
  const actions = [];

  if (!fs.existsSync(source)) {
    actions.push({ action: "skip", source, target, reason: "source missing" });
    return actions;
  }

  const backup = dryRun ? null : backupIfNeeded(target);
  if (backup) {
    actions.push({ action: "backup", original: target, backup });
  }

  const isDir = fs.statSync(source).isDirectory();

  if (dryRun) {
    actions.push({
      action: mode === "symlink" ? "symlink" : "copy",
      source,
      target,
      dryRun: true,
    });
    return actions;
  }

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Remove existing before creating
  removePath(target);

  if (mode === "symlink") {
    const symlinkType = isDir && process.platform === "win32" ? "junction" : undefined;
    fs.symlinkSync(source, target, symlinkType);
    actions.push({ action: "symlink", source, target });
  } else {
    if (isDir) {
      copyDirSync(source, target);
    } else {
      fs.copyFileSync(source, target);
    }
    actions.push({ action: "copy", source, target });
  }

  return actions;
}

function buildFileList(modules) {
  const files = [];
  const configDir = getConfigDir();

  for (const mod of modules) {
    const def = MODULES[mod];
    if (!def) {
      console.error(`Unknown module: ${mod}`);
      process.exit(1);
    }

    // Handle agents_primary: agent/primary/{name} -> agent/{basename}
    // Marked as isAgent for model_tier resolution during install
    if (def.agents_primary) {
      for (const f of def.agents_primary) {
        const basename = path.basename(f);
        files.push({
          source: path.join(REPO_ROOT, "agent", f),
          target: path.join(configDir, "agents", basename),
          isAgent: true,
        });
      }
    }

    // Handle agents_workflow: agent/workflow/{name} -> agent/wf-{basename}
    if (def.agents_workflow) {
      for (const f of def.agents_workflow) {
        const basename = path.basename(f);
        const targetName = `wf-${basename}`;
        files.push({
          source: path.join(REPO_ROOT, "agent", f),
          target: path.join(configDir, "agents", targetName),
          isAgent: true,
        });
      }
    }

    // Legacy agents support (translate module)
    if (def.agents) {
      for (const f of def.agents) {
        files.push({
          source: path.join(REPO_ROOT, "agent", f),
          target: path.join(configDir, "agents", f),
          isAgent: true,
        });
      }
    }

    // Commands need model_tier resolution (like agents)
    if (def.commands) {
      for (const f of def.commands) {
        files.push({
          source: path.join(REPO_ROOT, "command", f),
          target: path.join(configDir, "command", f),
          needsModelResolution: true,
        });
      }
    }

    if (def.skills) {
      for (const d of def.skills) {
        files.push({
          source: path.join(REPO_ROOT, "skill", d),
          target: path.join(configDir, "skill", d),
        });
      }
    }

    // OpenCode loads plugins from "plugins/" (plural)
    if (def.plugins) {
      for (const f of def.plugins) {
        files.push({
          source: path.join(REPO_ROOT, "plugin", f),
          target: path.join(configDir, "plugins", f),
        });
      }
    }

    if (def.modes) {
      for (const f of def.modes) {
        files.push({
          source: path.join(REPO_ROOT, "mode", f),
          target: path.join(configDir, "mode", f),
        });
      }
    }

    if (def.lib) {
      for (const f of def.lib) {
        files.push({
          source: path.join(REPO_ROOT, "lib", f),
          target: path.join(configDir, "lib", f),
        });
      }
    }

    if (def.templates) {
      for (const f of def.templates) {
        files.push({
          source: path.join(REPO_ROOT, "templates", f),
          target: path.join(configDir, "templates", f),
        });
      }
    }

    // Tools import @opencode-ai/plugin at runtime and must resolve from the config
    // directory's node_modules. Always copy (never symlink) to avoid resolution issues.
    if (def.tools) {
      for (const f of def.tools) {
        files.push({
          source: path.join(REPO_ROOT, "tool", f),
          target: path.join(configDir, "tool", f),
          forceCopy: true,
        });
      }
    }

    if (def.rootFiles) {
      for (const f of def.rootFiles) {
        files.push({
          source: path.join(REPO_ROOT, f),
          target: path.join(configDir, f),
        });
      }
    }
  }

  return files;
}

function install(modules, mode, dryRun, options = {}) {
  const modelStrategy = options.modelStrategy === "strip" ? "strip" : "resolve";
  const configDir = getConfigDir();
  const files = buildFileList(modules);
  const allActions = [];
  const installedTargets = [];
  const previousManifestPath = path.join(configDir, MANIFEST_NAME);
  let previousManagedTargets = [];

  if (fs.existsSync(previousManifestPath)) {
    try {
      const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, "utf-8"));
      if (Array.isArray(previousManifest.files)) {
        previousManagedTargets = previousManifest.files;
      }
    } catch {
      // best-effort; ignore invalid manifest
    }
  }

  console.log(`\nInstalling modules: ${modules.join(", ")}`);
  console.log(`Mode: ${mode}`);
  console.log(
    `Model strategy: ${modelStrategy === "resolve" ? "resolve model_tier from workflows.json" : "runtime models from opencode.jsonc (no materialization)"}`
  );
  console.log(`Config dir: ${configDir}`);
  if (dryRun) console.log("(dry run — no changes will be made)\n");
  else console.log();

  // Normalize legacy timestamped backups before install.
  const backupCleanupActions = normalizeLegacyBackups(configDir, dryRun);
  allActions.push(...backupCleanupActions);

  // Load workflow config only when model tier resolution is enabled.
  const workflowConfig = modelStrategy === "resolve" ? loadWorkflowConfig() : null;

  // Install each file
  for (const { source, target, isAgent, needsModelResolution, forceCopy } of files) {
    // Files with model_tier use copy + resolution (never symlinked)
    let actions;
    if (isAgent || needsModelResolution) {
      // Derive agent name from target basename without extension
      const agentName = path.basename(target, '.md') || null;
      actions = installWithModelResolution(source, target, workflowConfig, dryRun, agentName, modelStrategy);
    } else {
      // Tools with runtime imports must be copied so they resolve from config dir
      actions = installFile(source, target, forceCopy ? "copy" : mode, dryRun);
    }
    allActions.push(...actions);
    for (const a of actions) {
      if (a.action === "symlink" || a.action === "copy") {
        installedTargets.push(a.target);
      }
    }
  }

  // opencode.jsonc — copy only if neither .jsonc nor .json exists
  const opconfigJsonc = path.join(configDir, "opencode.jsonc");
  const opconfigJson = path.join(configDir, "opencode.json");
  const opconfigTarget = fs.existsSync(opconfigJsonc) ? opconfigJsonc : opconfigJson;
  const opconfigExists = fs.existsSync(opconfigJsonc) || fs.existsSync(opconfigJson);
  const opconfigSource = path.join(REPO_ROOT, "opencode.jsonc.template");
  if (!opconfigExists && fs.existsSync(opconfigSource)) {
    const newTarget = path.join(configDir, "opencode.jsonc");
    if (dryRun) {
      allActions.push({
        action: "copy",
        source: opconfigSource,
        target: newTarget,
        dryRun: true,
        note: "opencode.jsonc (from template, first install only)",
      });
    } else {
      fs.mkdirSync(path.dirname(newTarget), { recursive: true });
      fs.copyFileSync(opconfigSource, newTarget);
      allActions.push({
        action: "copy",
        source: opconfigSource,
        target: newTarget,
        note: "opencode.jsonc (from template, first install only)",
      });
      installedTargets.push(newTarget);
    }
  } else if (opconfigExists) {
    allActions.push({
      action: "skip",
      target: opconfigTarget,
      reason: "already exists (not overwritten)",
    });
    installedTargets.push(opconfigTarget);
  }

  // workflows.json — copy only if it doesn't exist yet
  const wfConfigTarget = path.join(configDir, "workflows.json");
  const wfConfigSource = path.join(REPO_ROOT, "workflows.json.template");
  if (!fs.existsSync(wfConfigTarget) && fs.existsSync(wfConfigSource)) {
    if (dryRun) {
      allActions.push({
        action: "copy",
        source: wfConfigSource,
        target: wfConfigTarget,
        dryRun: true,
        note: "workflows.json (from template, first install only)",
      });
    } else {
      fs.mkdirSync(path.dirname(wfConfigTarget), { recursive: true });
      fs.copyFileSync(wfConfigSource, wfConfigTarget);
      allActions.push({
        action: "copy",
        source: wfConfigSource,
        target: wfConfigTarget,
        note: "workflows.json (from template, first install only)",
      });
      installedTargets.push(wfConfigTarget);
    }
  } else if (fs.existsSync(wfConfigTarget)) {
    allActions.push({
      action: "skip",
      target: wfConfigTarget,
      reason: "already exists (not overwritten)",
    });
    installedTargets.push(wfConfigTarget);
  }

  // Ensure runtime directories exist in repo
  const runtimeDirs = [
    path.join(configDir, "plans"),
    path.join(configDir, "workflows", "active"),
    path.join(configDir, "workflows", "completed"),
  ];
  for (const dir of runtimeDirs) {
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      // Create .gitkeep if empty
      const gitkeep = path.join(dir, ".gitkeep");
      if (!fs.existsSync(gitkeep)) {
        fs.writeFileSync(gitkeep, "");
      }
    }
    allActions.push({ action: "mkdir", path: dir });
  }

  // Write environment file
  const envTarget = path.join(configDir, ENV_FILE_NAME);
  const envContent = `OPENCODE_WORKFLOWS_REPO=${REPO_ROOT}\n`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(envTarget), { recursive: true });
    fs.writeFileSync(envTarget, envContent);
    installedTargets.push(envTarget);
  }
  allActions.push({ action: "write", target: envTarget, content: envContent });

  // Remove stale managed files from previous installs (eg removed commands)
  const currentManaged = new Set(installedTargets);
  for (const oldTarget of previousManagedTargets) {
    if (currentManaged.has(oldTarget)) continue;

    const base = path.basename(oldTarget);
    if (
      base === "opencode.jsonc" ||
      base === "opencode.json" ||
      base === "workflows.json" ||
      base === ENV_FILE_NAME ||
      base === MANIFEST_NAME
    ) {
      continue;
    }

    if (dryRun) {
      allActions.push({ action: "remove", target: oldTarget, note: "stale managed file", dryRun: true });
      continue;
    }

    if (removePath(oldTarget)) {
      allActions.push({ action: "remove", target: oldTarget, note: "stale managed file" });
    }
  }

  // Write manifest
  if (!dryRun) {
    const manifest = {
      repo: REPO_ROOT,
      mode,
      modules,
      files: installedTargets,
      installedAt: new Date().toISOString(),
    };
    const manifestPath = path.join(configDir, MANIFEST_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    allActions.push({ action: "write", target: manifestPath });
  }

  // Install plugin dependencies (zod, etc.) so plugins can resolve imports.
  // In symlink mode, module resolution follows the symlink target path (the repo),
  // so we also install deps in the repo's plugin/ directory.
  // In copy mode, the config dir's node_modules suffice since files are local.
  const pluginsDir = path.join(configDir, "plugins");
  const pluginPkgJson = path.join(pluginsDir, "package.json");
  if (!dryRun && fs.existsSync(pluginPkgJson)) {
    // Always install in the config plugins dir
    try {
      execSync("npm install --no-audit --no-fund --silent", {
        cwd: pluginsDir,
        stdio: "pipe",
        timeout: 30000,
      });
      allActions.push({ action: "npm-install", path: pluginsDir });
    } catch (e) {
      console.warn(`Warning: npm install in ${pluginsDir} failed: ${e.message}`);
    }
    // In symlink mode, Bun resolves imports from the symlink target (the repo).
    // Install deps at both the repo root and plugin/ dir for reliable resolution.
    if (mode === "symlink") {
      for (const depDir of [REPO_ROOT, path.join(REPO_ROOT, "plugin")]) {
        const pkg = path.join(depDir, "package.json");
        if (!fs.existsSync(pkg)) continue;
        try {
          execSync("npm install --no-audit --no-fund --silent", {
            cwd: depDir,
            stdio: "pipe",
            timeout: 30000,
          });
          allActions.push({ action: "npm-install", path: depDir });
        } catch (e) {
          console.warn(`Warning: npm install in ${depDir} failed: ${e.message}`);
        }
      }
    }
  }

  // Print summary
  printSummary(allActions, modules, mode, dryRun, modelStrategy);
}

function uninstall(dryRun) {
  const configDir = getConfigDir();
  const manifestPath = path.join(configDir, MANIFEST_NAME);

  if (!fs.existsSync(manifestPath)) {
    console.error("No installation manifest found. Nothing to uninstall.");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const removed = [];
  const skipped = [];

  console.log(`\nUninstalling opencode-workflows...`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Installed files: ${manifest.files.length}`);
  if (dryRun) console.log("(dry run — no changes will be made)\n");
  else console.log();

  for (const target of manifest.files) {
    // Never remove opencode config
    if (path.basename(target) === "opencode.jsonc" || path.basename(target) === "opencode.json") {
      skipped.push({ target, reason: "opencode config is never removed" });
      continue;
    }

    if (dryRun) {
      removed.push({ action: "remove", target, dryRun: true });
      continue;
    }

    if (removePath(target)) {
      removed.push({ action: "remove", target });
    } else {
      skipped.push({ target, reason: "not found" });
    }
  }

  // Remove env file
  const envPath = path.join(configDir, ENV_FILE_NAME);
  if (!dryRun && fs.existsSync(envPath)) {
    fs.unlinkSync(envPath);
    removed.push({ action: "remove", target: envPath });
  }

  // Remove manifest itself
  if (!dryRun) {
    fs.unlinkSync(manifestPath);
    removed.push({ action: "remove", target: manifestPath });
  }

  // Clean up empty directories
  if (!dryRun) {
    for (const sub of ["agents", "command", "skill", "plugins", "plugin", "tool", "mode", "lib", "templates"]) {
      const dir = path.join(configDir, sub);
      try {
        const entries = fs.readdirSync(dir);
        if (entries.length === 0) {
          fs.rmdirSync(dir);
          removed.push({ action: "rmdir", target: dir });
        }
      } catch {
        // directory doesn't exist, that's fine
      }
    }
  }

  console.log(`Removed: ${removed.length} items`);
  for (const r of removed) {
    const label = dryRun ? "[dry-run] " : "";
    console.log(`  ${label}${r.action}: ${r.target}`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped: ${skipped.length} items`);
    for (const s of skipped) {
      console.log(`  ${s.target} (${s.reason})`);
    }
  }
  console.log("\nUninstall complete.");
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(actions, modules, mode, dryRun, modelStrategy = "resolve") {
  const symlinks = actions.filter((a) => a.action === "symlink");
  const copies = actions.filter((a) => a.action === "copy");
  const backups = actions.filter((a) => a.action === "backup");
  const backupNormalized = actions.filter((a) => a.action === "backup-normalize");
  const backupCleaned = actions.filter((a) => a.action === "backup-clean");
  const removed = actions.filter((a) => a.action === "remove");
  const skips = actions.filter((a) => a.action === "skip");
  const dirs = actions.filter((a) => a.action === "mkdir");

  const installed = symlinks.length + copies.length;

  console.log("─".repeat(50));
  console.log(dryRun ? "DRY RUN SUMMARY" : "INSTALL SUMMARY");
  console.log("─".repeat(50));

  if (backups.length > 0) {
    console.log(`\nBacked up: ${backups.length} existing files`);
    for (const b of backups) {
      console.log(`  ${b.original} → ${b.backup}`);
    }
  }

  const totalBackupCleanup = backupNormalized.length + backupCleaned.length;
  if (totalBackupCleanup > 0) {
    console.log(`\nLegacy backup cleanup: ${totalBackupCleanup} items`);
    for (const a of backupNormalized) {
      const prefix = dryRun ? "[dry-run] " : "";
      console.log(`  ${prefix}normalize: ${a.from} → ${a.to}`);
    }
    for (const a of backupCleaned) {
      const prefix = dryRun ? "[dry-run] " : "";
      console.log(`  ${prefix}remove: ${a.target}`);
    }
  }

  if (removed.length > 0) {
    console.log(`\nRemoved stale managed files: ${removed.length}`);
    for (const r of removed) {
      const prefix = dryRun ? "[dry-run] " : "";
      console.log(`  ${prefix}${r.target}`);
    }
  }

  console.log(`\nInstalled: ${installed} items (${mode} mode)`);
  for (const a of [...symlinks, ...copies]) {
    const label = a.note ? ` (${a.note})` : "";
    const prefix = dryRun ? "[dry-run] " : "";
    console.log(
      `  ${prefix}${a.action}: ${path.basename(a.source || a.target)}${label}`
    );
  }

  if (skips.length > 0) {
    console.log(`\nSkipped: ${skips.length} items`);
    for (const s of skips) {
      console.log(`  ${path.basename(s.target || s.source)} (${s.reason})`);
    }
  }

  if (dirs.length > 0) {
    console.log(`\nRuntime directories ensured: ${dirs.length}`);
    for (const d of dirs) {
      console.log(`  ${d.path}`);
    }
  }

  console.log("\n─".repeat(50));
  if (!dryRun) {
    console.log("Next steps:");
    console.log(`  1. Review/edit ${path.join(getConfigDir(), "opencode.jsonc")}`);
    if (modelStrategy === "resolve") {
      console.log(`  2. Configure model tiers in ${path.join(getConfigDir(), "workflows.json")}`);
    } else {
      console.log("  2. Configure runtime models in opencode.jsonc (model/small_model/agent.*.model)");
    }
    console.log("  3. Set up API keys in ~/.secrets/ as needed");
    console.log("  4. Start OpenCode and verify agents are available");
    if (mode === "symlink") {
      console.log(
        "\nTo update: just `git pull` — symlinks track most changes automatically."
      );
      console.log(
        "Note: tools are always copied. Re-run installer after tool changes."
      );
    } else {
      console.log(
        "\nTo update: `git pull && node install.mjs`"
      );
    }
    console.log("To uninstall: `node install.mjs --uninstall`");
  }
  console.log();
}

function printHelp() {
  console.log(`
OpenCode Workflows Installer

Usage:
  node install.mjs [options]

Options:
  --symlink           Use symlink mode instead of copies (for development only)
  --runtime-models    Do not materialize model_tier; use OpenCode runtime model config
  --no-model-resolve  Alias for --runtime-models
  --all               Install all modules (core + translate)
  --module <name>     Install a specific module (core, translate)
  --uninstall         Remove all installed files
  --dry-run           Preview actions without making changes
  --help              Show this help message

Modules:
  core       Primary agents, workflow agents, commands, skills, plugins,
             execution modes, libraries, templates, and conventions (default)
  translate  Joomla translation agents, commands, tools, and plugin

Features (core module):
  - Primary agents for interactive coding (supervisor, editor, etc.)
  - Workflow agents for autonomous execution (architect, executor, reviewer, etc.)
  - Multi-model execution modes (eco, standard, turbo, thorough, swarm)
  - Workflow templates (feature-development, bug-fix, refactor, e2e-testing)
  - TypeScript libraries for plugin development
  - Skills for framework-specific conventions

Examples:
  node install.mjs                       # Install core (copy mode, default)
  node install.mjs --symlink             # Install with symlinks (dev only)
  node install.mjs --runtime-models      # Keep model selection in opencode.jsonc
  node install.mjs --all                 # Install everything
  node install.mjs --module translate    # Add translate module
  node install.mjs --uninstall           # Remove installed files
  node install.mjs --dry-run --all       # Preview full install
`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const symlinkMode = args.includes("--symlink");
  const mode = symlinkMode ? "symlink" : "copy";
  const runtimeModels = args.includes("--runtime-models") || args.includes("--no-model-resolve");
  const modelStrategy = runtimeModels ? "strip" : "resolve";
  const doUninstall = args.includes("--uninstall");
  const installAll = args.includes("--all");

  if (doUninstall) {
    uninstall(dryRun);
    process.exit(0);
  }

  // Determine which modules to install
  let modules = ["core"];

  if (installAll) {
    modules = Object.keys(MODULES);
  } else {
    const modIdx = args.indexOf("--module");
    if (modIdx !== -1 && args[modIdx + 1]) {
      const requested = args[modIdx + 1];
      if (!MODULES[requested]) {
        console.error(`Unknown module: ${requested}`);
        console.error(`Available: ${Object.keys(MODULES).join(", ")}`);
        process.exit(1);
      }
      // If requesting a non-core module, include core too
      if (requested !== "core" && !modules.includes(requested)) {
        modules.push(requested);
      }
    }
  }

  install(modules, mode, dryRun, { modelStrategy });
}

main();
