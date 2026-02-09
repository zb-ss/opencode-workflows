#!/usr/bin/env node

// OpenCode Workflows — remote bootstrap installer
//
// Linux/macOS:
//   curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
//
// Windows (PowerShell):
//   curl.exe -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module
//
// Environment variables:
//   INSTALL_DIR=~/my/path  — custom clone location
//   INSTALL_MODE=copy      — copy files instead of symlinks
//   INSTALL_MODULES=all    — install all modules including translate

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const REPO = "https://github.com/zb-ss/opencode-workflows.git";
const isWindows = platform() === "win32";

// Default install location: platform-appropriate
function defaultDir() {
  if (isWindows) {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "opencode-workflows");
  }
  return join(homedir(), ".local", "share", "opencode-workflows");
}

const log = (msg) => console.log(`\x1b[36m>\x1b[0m ${msg}`);
const err = (msg) => {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
};

// --- Preflight checks ---

// Node.js version
const [major] = process.versions.node.split(".").map(Number);
if (major < 18) err(`Node.js 18+ required (found ${process.versions.node})`);

// Git available
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  err("git is required but not found in PATH");
}

// --- Resolve install directory ---

const installDir = process.env.INSTALL_DIR || defaultDir();

if (existsSync(installDir)) {
  // Already cloned — pull latest
  log(`Updating existing install at ${installDir}`);
  try {
    execFileSync("git", ["-C", installDir, "pull", "--ff-only"], { stdio: "inherit" });
  } catch {
    err(`Failed to update ${installDir}. Resolve manually or remove it and retry.`);
  }
} else {
  log(`Cloning into ${installDir}`);
  execFileSync("git", ["clone", REPO, installDir], { stdio: "inherit" });
}

// --- Run installer ---

const args = [];
// Windows defaults to copy mode (symlinks require Developer Mode or admin)
if (process.env.INSTALL_MODE === "copy" || (isWindows && process.env.INSTALL_MODE !== "symlink")) {
  args.push("--copy");
}
if (process.env.INSTALL_MODULES === "all") args.push("--all");

log("Running installer...");
try {
  execFileSync("node", [join(installDir, "install.mjs"), ...args], {
    stdio: "inherit",
    cwd: installDir,
  });
} catch {
  err("Installer failed. Check the output above for details.");
}

log("Done! Run `opencode` to get started.");
