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
 *   node install.mjs --all                 # Install core + translate
 *   node install.mjs --module translate    # Add translate module
 *   node install.mjs --uninstall           # Remove all installed files
 *   node install.mjs --dry-run             # Preview actions
 *   node install.mjs --help                # Show usage
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Module definitions
// ---------------------------------------------------------------------------

const MODULES = {
  core: {
    agents: [
      "org-planner.md",
      "discussion.md",
      "editor.md",
      "focused-build.md",
      "debug.md",
      "review.md",
      "test-writer.md",
      "web-tester.md",
      "security-auditor.md",
      "supervisor.md",
      "step-planner.md",
      "figma-builder.md",
    ],
    commands: [
      "plan.md",
      "workflow.md",
      "workflow-resume.md",
      "workflow-status.md",
      "commit.md",
      "pr.md",
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
    plugins: ["workflow-notifications.ts"],
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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

  if (isOurSymlink(target)) return null; // our own symlink, safe to replace

  const backup = `${target}.backup.${timestamp()}`;
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

    if (def.agents) {
      for (const f of def.agents) {
        files.push({
          source: path.join(REPO_ROOT, "agent", f),
          target: path.join(configDir, "agent", f),
        });
      }
    }

    if (def.commands) {
      for (const f of def.commands) {
        files.push({
          source: path.join(REPO_ROOT, "command", f),
          target: path.join(configDir, "command", f),
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

    if (def.plugins) {
      for (const f of def.plugins) {
        files.push({
          source: path.join(REPO_ROOT, "plugin", f),
          target: path.join(configDir, "plugin", f),
        });
      }
    }

    if (def.tools) {
      for (const f of def.tools) {
        files.push({
          source: path.join(REPO_ROOT, "tool", f),
          target: path.join(configDir, "tool", f),
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

function install(modules, mode, dryRun) {
  const configDir = getConfigDir();
  const files = buildFileList(modules);
  const allActions = [];
  const installedTargets = [];

  console.log(`\nInstalling modules: ${modules.join(", ")}`);
  console.log(`Mode: ${mode}`);
  console.log(`Config dir: ${configDir}`);
  if (dryRun) console.log("(dry run — no changes will be made)\n");
  else console.log();

  // Install each file
  for (const { source, target } of files) {
    const actions = installFile(source, target, mode, dryRun);
    allActions.push(...actions);
    for (const a of actions) {
      if (a.action === "symlink" || a.action === "copy") {
        installedTargets.push(a.target);
      }
    }
  }

  // opencode.json — copy only if it doesn't exist
  const opconfigTarget = path.join(configDir, "opencode.json");
  const opconfigSource = path.join(REPO_ROOT, "opencode.json.template");
  if (!fs.existsSync(opconfigTarget) && fs.existsSync(opconfigSource)) {
    if (dryRun) {
      allActions.push({
        action: "copy",
        source: opconfigSource,
        target: opconfigTarget,
        dryRun: true,
        note: "opencode.json (from template, first install only)",
      });
    } else {
      fs.mkdirSync(path.dirname(opconfigTarget), { recursive: true });
      fs.copyFileSync(opconfigSource, opconfigTarget);
      allActions.push({
        action: "copy",
        source: opconfigSource,
        target: opconfigTarget,
        note: "opencode.json (from template, first install only)",
      });
      installedTargets.push(opconfigTarget);
    }
  } else if (fs.existsSync(opconfigTarget)) {
    allActions.push({
      action: "skip",
      target: opconfigTarget,
      reason: "already exists (not overwritten)",
    });
  }

  // Ensure runtime directories exist in repo
  const runtimeDirs = [
    path.join(REPO_ROOT, "plans"),
    path.join(REPO_ROOT, "workflows", "active"),
    path.join(REPO_ROOT, "workflows", "completed"),
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

  // Print summary
  printSummary(allActions, modules, mode, dryRun);
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
    // Never remove opencode.json
    if (path.basename(target) === "opencode.json") {
      skipped.push({ target, reason: "opencode.json is never removed" });
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
    for (const sub of ["agent", "command", "skill", "plugin", "tool"]) {
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

function printSummary(actions, modules, mode, dryRun) {
  const symlinks = actions.filter((a) => a.action === "symlink");
  const copies = actions.filter((a) => a.action === "copy");
  const backups = actions.filter((a) => a.action === "backup");
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
    console.log(`  1. Review/edit ${path.join(getConfigDir(), "opencode.json")}`);
    console.log("  2. Set up API keys in ~/.secrets/ as needed");
    console.log("  3. Start OpenCode and verify agents are available");
    if (mode === "symlink") {
      console.log(
        "\nTo update: just `git pull` — symlinks track repo changes automatically."
      );
    } else {
      console.log(
        "\nTo update: `git pull && node install.mjs --copy`"
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
  --copy              Use copy mode instead of symlinks (default: symlink)
  --all               Install all modules (core + translate)
  --module <name>     Install a specific module (core, translate)
  --uninstall         Remove all installed files
  --dry-run           Preview actions without making changes
  --help              Show this help message

Modules:
  core       Agents, commands, skills, plugins for general development (default)
  translate  Joomla translation agents, commands, tools, and plugin

Examples:
  node install.mjs                       # Install core with symlinks
  node install.mjs --copy                # Install core with copies
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
  const copyMode = args.includes("--copy");
  const mode = copyMode ? "copy" : "symlink";
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

  install(modules, mode, dryRun);
}

main();
