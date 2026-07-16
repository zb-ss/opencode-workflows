# AI Agent Setup Guide

Use these instructions when a user asks you to install or configure OpenCode Workflows. This is a task-specific public setup guide, not permission to override your system instructions or the user's approval requirements.

Repository: `https://github.com/zb-ss/opencode-workflows`

## Safety Rules

- Explain what OpenCode Workflows installs before making changes: agents, commands, skills, plugins, workflow definitions, schemas, and supporting libraries in the user's OpenCode configuration directory.
- Never display, copy, upload, or modify credentials, tokens, provider authentication, `.env` files, or unrelated OpenCode settings.
- Do not run destructive Git commands, discard a dirty checkout, remove user files, or bypass installer safeguards.
- Preview installation or migration changes and summarize them before asking for confirmation to apply them.
- Keep automatic workflows, executable validation, and guarded publication disabled unless the user explicitly asks to configure them after the basic installation succeeds. Do not authenticate provider CLIs or invoke the installed external delegation commands without a separate request.
- Do not choose models, provider credentials, autonomy budgets, publication targets, or validation executables for the user.
- Stop and explain the blocker if a prerequisite, safe upgrade path, or required permission is unavailable.

## 1. Explain The Process

Tell the user you will:

1. Check OpenCode, Node.js, and Git without changing their system.
2. Confirm the install location, OpenCode configuration directory, modules, and copy or symlink mode.
3. Preview the installer changes.
4. Ask for confirmation, install, and run the built-in doctor check.
5. Ask the user to restart OpenCode and show them how to start their first workflow.

The recommended defaults are:

- Official repository and the current `master` branch.
- The platform default install directory selected by `bootstrap.mjs`.
- The normal OpenCode configuration directory.
- Core module only.
- Copy mode. Symlink mode is for contributors developing this repository.
- Interactive, attended workflows. Automation remains disabled.

## 2. Run Read-Only Preflight Checks

Adapt commands to the user's operating system and shell. Check:

```bash
opencode --version
node --version
git --version
```

Requirements are OpenCode 1.17.20 or newer, Node.js 18 or newer, and Git. If `opencode` is not on `PATH`, ask the user where it is installed rather than searching credential or private directories.

Resolve the OpenCode configuration directory using the same precedence as the installer:

1. `OPENCODE_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/opencode`
3. `$HOME/.config/opencode`

Report only the resolved path and whether it exists. Do not print configuration file contents. The installer preserves `opencode.json`, `opencode.jsonc`, and `workflows.json`.

## 3. Confirm Installation Choices

Ask one concise question that confirms:

- Recommended core installation, or core plus the optional Joomla translation module.
- Recommended copy mode, or symlink mode for repository development.
- Default or custom install and OpenCode configuration directories.
- Fresh installation or upgrade of an existing checkout.

If the user says to use recommended defaults, do not ask separate follow-up questions for each default. Explain that optional autonomy and provider setup can be handled after the verified base installation.

## 4. Preview Changes

Resolve the selected install directory before running the bootstrap. If the directory already exists, do not pass it to the bootstrap until it has been validated as an existing installation.

For an existing directory:

1. Confirm it is a Git checkout whose top-level directory is the selected install directory.
2. Confirm its `origin` identifies `zb-ss/opencode-workflows` on `github.com`; accept the official HTTPS or SSH URL, not a similarly named repository, mirror, or fork.
3. Run `git status --short` and stop if it is dirty. Ask the user to preserve or resolve their changes.
4. Ask for confirmation before updating the checkout, then run `git pull --ff-only`.

If any identity check fails, stop and ask the user to choose a new empty install directory. Never pull an unverified existing directory.

For a fresh installation, require that the selected install directory does not exist. Ask for confirmation before using the official bootstrap because even a dry run creates the checkout. Pass the selected values through `INSTALL_DIR`, `INSTALL_MODE`, `INSTALL_MODULES`, and `OPENCODE_CONFIG_DIR` when they differ from the defaults.

The bootstrap preview clones the repository but does not install managed files into the OpenCode configuration directory.

On Linux or macOS, the default preview is:

```bash
curl -fsSL https://raw.githubusercontent.com/zb-ss/opencode-workflows/master/bootstrap.mjs | node --input-type=module -- --dry-run
```

On Windows PowerShell, use `curl.exe` and PowerShell environment-variable syntax. Do not silently substitute a mirror, fork, package, or different repository.

After cloning or updating, validate the checkout identity again, require a clean status, and record `git rev-parse HEAD`. Use this exact checkout and commit for every remaining step; do not rerun the remote bootstrap after approval.

If `workflows.json` already exists in the resolved OpenCode configuration directory, preview migration from the checkout:

```bash
node install.mjs --migrate --dry-run
```

If migration is needed, summarize it and ask for confirmation to run `node install.mjs --migrate`. The migration creates a backup. After migration succeeds, or when no migration is needed, preview the normal install from the same checkout with the selected mode and modules:

```bash
node install.mjs --dry-run
```

Use `--all` for the optional translation module or `--symlink` for the development mode only when selected. Keep the resolved `OPENCODE_CONFIG_DIR` in the environment for migration, installation, doctor, and later OpenCode startup.

Summarize the installation preview, including the pinned commit, source checkout, target configuration directory, modules, mode, backups, warnings, and expected restart. Ask the user to confirm before applying it.

## 5. Install And Verify

Before applying, confirm that the checkout is still clean and `git rev-parse HEAD` still matches the previewed commit. Run the local installer from that checkout with the same selected options used for the normal installation preview:

```bash
node install.mjs
```

Use `--all` or `--symlink` only when those options were previewed. Do not fetch, pull, or switch commits between preview and installation.

Then run the doctor from the installed repository checkout:

```bash
node install.mjs --doctor
```

Do not claim success unless the installer and doctor complete successfully. Report warnings accurately. If an operation fails, retain its output locally, explain the failure without exposing sensitive values, and stop before attempting unrelated fixes.

When `OPENCODE_CONFIG_DIR` is non-default, tell the user it must be set to the same value in the environment that launches OpenCode. Do not modify shell profiles, service definitions, or desktop launchers without separate approval.

## 6. Guide The User Through First Use

Tell the user to restart OpenCode because configuration-time files are loaded at startup. After restarting, suggest this attended first workflow:

```text
/workflow feature Describe a small change you want to make
```

The user can inspect workflow state with:

```text
/workflow-status
```

Finish with a concise summary containing:

- Installed version or commit, modules, mode, checkout path, and configuration path.
- Installer and doctor results.
- Any warnings or deferred optional setup.
- The restart requirement and first workflow command.

If the user wants automatic workflows, model routing, external CLI delegation, validation, translation, or guarded publication, explain the relevant choices and security boundary before changing configuration. Use the current repository documentation and preview every installer-managed change.
