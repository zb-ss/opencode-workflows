/**
 * OpenCode Translation Workflow Plugin
 *
 * Provides session-owned Joomla translation workflows backed by private,
 * atomic state below the OpenCode configuration directory.
 */

import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

import { getConfigDir, getSessionRuntimeDir, isPathInside } from "../lib/paths.ts"
import { abortCheckpoint, throwIfAborted } from "../lib/tool-context.ts"

interface ViewInfo {
  path: string
  relativePath: string
  lines: number
  needsChunking: boolean
  status: "pending" | "processing" | "review" | "error" | "done"
  attempts: number
  errors: string[]
  stringsFound: number
  stringsConverted: number
  lastProcessed?: string
}

interface TranslationData {
  componentPath: string
  componentName: string
  targetLanguage: string
  sourceLanguage: string
  sourceIniPath: string
  targetIniPath: string
  status: "scanning" | "processing" | "complete" | "error"
  currentViewIndex: number
  views: ViewInfo[]
  totalStringsConverted: number
  totalErrors: number
}

interface TranslationWorkflowState {
  schema_version: 1
  revision: number
  workflow_id: string
  workflow_type: "joomla-translation"
  phase: {
    current: string
    completed: string[]
    remaining: string[]
  }
  gates: Record<string, { status: "pending" | "passed"; iteration: number }>
  agent_log: never[]
  mode: { current: string }
  owner: {
    root_session_id: string
    current_session_id: string
    directory: string
    worktree: string
  }
  created_at: string
  updated_at: string
  status: "running" | "completed" | "failed"
  driver: "automatic"
  translation: TranslationData
}

interface TranslationBinding {
  session_id: string
  workflow_id: string
  workflow_path: string
  directory: string
  worktree: string
  project_directory: string
  bound_at: string
}

interface InvocationIdentity {
  sessionId: string
  directory: string
  worktree: string
}

type PathAccess = "read" | "edit"

interface AuthorizePathOptions {
  kind?: "file" | "directory"
  recursive?: boolean
}

function normalizePattern(value: string): string {
  return value.replaceAll("\\", "/")
}

function canonicalizePath(inputPath: string, symlinkDepth = 0): string {
  if (symlinkDepth > 40) {
    throw new Error(`Too many symbolic links while resolving path: ${inputPath}`)
  }

  const absolutePath = resolve(inputPath)
  const root = parse(absolutePath).root
  const segments = relative(root, absolutePath).split(sep).filter(Boolean)
  let currentPath = root

  for (let index = 0; index < segments.length; index++) {
    const candidate = join(currentPath, segments[index])
    try {
      const stats = lstatSync(candidate)
      if (stats.isSymbolicLink()) {
        const target = resolve(dirname(candidate), readlinkSync(candidate))
        return canonicalizePath(resolve(target, ...segments.slice(index + 1)), symlinkDepth + 1)
      }
      currentPath = candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        return resolve(candidate, ...segments.slice(index + 1))
      }
      throw error
    }
  }

  return currentPath
}

function invocationIdentity(context: ToolContext): InvocationIdentity {
  throwIfAborted(context)

  let worktree: string
  let directory: string
  try {
    worktree = realpathSync(context.worktree)
    directory = realpathSync(context.directory)
  } catch {
    throw new Error("ToolContext directory and worktree must exist")
  }

  if (!isPathInside(worktree, directory)) {
    throw new Error("ToolContext directory is outside the ToolContext worktree")
  }

  return { sessionId: context.sessionID, directory, worktree }
}

async function requestPathPermissions(
  context: ToolContext,
  target: string,
  root: string,
  accesses: PathAccess[],
  options: AuthorizePathOptions,
): Promise<void> {
  const kind = options.kind ?? "file"
  if (!isPathInside(root, target)) {
    const parentDirectory = kind === "directory" ? target : dirname(target)
    const pattern = normalizePattern(join(parentDirectory, "*"))
    await context.ask({
      permission: "external_directory",
      patterns: [pattern],
      always: [pattern],
      metadata: { filepath: target, parentDir: parentDirectory },
    })
    throwIfAborted(context)
  }

  const relativePath = normalizePattern(relative(root, target) || ".")
  const pattern = options.recursive ? `${relativePath.replace(/\/$/, "")}/**` : relativePath
  for (const access of accesses) {
    throwIfAborted(context)
    await context.ask({
      permission: access,
      patterns: [pattern],
      always: [pattern],
      metadata: { filepath: target },
    })
  }
  throwIfAborted(context)
}

async function authorizePath(
  context: ToolContext,
  identity: InvocationIdentity,
  inputPath: string,
  accesses: PathAccess[],
  options: AuthorizePathOptions = {},
): Promise<string> {
  throwIfAborted(context)

  const lexicalPath = resolve(identity.directory, inputPath)
  await requestPathPermissions(context, lexicalPath, identity.worktree, accesses, options)

  const canonicalPath = canonicalizePath(lexicalPath)
  if (canonicalPath !== lexicalPath) {
    await requestPathPermissions(context, canonicalPath, identity.worktree, accesses, options)
  }

  throwIfAborted(context)
  return canonicalPath
}

function activeDirectory(): string {
  return join(getConfigDir(), "workflows", "active")
}

function bindingPath(sessionId: string): string {
  return join(getSessionRuntimeDir(sessionId), "binding.json")
}

async function authorizeStatePath(
  context: ToolContext,
  identity: InvocationIdentity,
  statePath: string,
  accesses: PathAccess[],
): Promise<string> {
  const lexicalActiveDirectory = resolve(activeDirectory())
  const lexicalStatePath = resolve(statePath)
  if (!isPathInside(lexicalActiveDirectory, lexicalStatePath) || !lexicalStatePath.endsWith(".state.json")) {
    throw new Error("Translation workflow state path is outside the active workflow directory")
  }

  const authorizedPath = await authorizePath(context, identity, lexicalStatePath, accesses)
  const canonicalActiveDirectory = canonicalizePath(lexicalActiveDirectory)
  if (!isPathInside(canonicalActiveDirectory, authorizedPath)) {
    throw new Error("Translation workflow state resolves outside the active workflow directory")
  }
  return authorizedPath
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // POSIX permissions are not available on every filesystem.
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensurePrivateDirectory(dirname(filePath))
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    renameSync(temporaryPath, filePath)
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // POSIX permissions are not available on every filesystem.
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch {
    return null
  }
}

function assertBindingOwner(binding: TranslationBinding, identity: InvocationIdentity): void {
  if (
    binding.session_id !== identity.sessionId
    || binding.directory !== identity.directory
    || binding.worktree !== identity.worktree
  ) {
    throw new Error("Translation workflow binding belongs to a different ToolContext")
  }
}

function assertStateOwner(state: TranslationWorkflowState, identity: InvocationIdentity): void {
  if (
    state.owner?.root_session_id !== identity.sessionId
    || state.owner.current_session_id !== identity.sessionId
    || state.owner.directory !== identity.directory
    || state.owner.worktree !== identity.worktree
  ) {
    throw new Error("Translation workflow belongs to a different ToolContext")
  }
}

function saveWorkflowState(statePath: string, state: TranslationWorkflowState): void {
  state.updated_at = new Date().toISOString()
  state.revision++
  atomicWriteJson(statePath, state)
}

function completeWorkflow(state: TranslationWorkflowState): void {
  state.translation.status = "complete"
  state.status = "completed"
  state.phase = {
    current: "complete",
    completed: ["translation"],
    remaining: [],
  }
  state.gates.translation = {
    status: "passed",
    iteration: state.gates.translation.iteration + 1,
  }
}

function generateWorkflowId(
  componentName: string,
  componentPath: string,
  targetLanguage: string,
  sourceLanguage: string,
  identity: InvocationIdentity,
): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const safeComponentName = componentName.replace(/[^a-zA-Z0-9_-]/g, "-") || "component"
  const identityHash = createHash("sha256")
    .update([identity.sessionId, identity.worktree, componentPath, targetLanguage, sourceLanguage].join("\0"))
    .digest("hex")
    .slice(0, 12)
  return `${date}-translate-${safeComponentName}-${identityHash}`
}

function getComponentName(componentPath: string): string {
  const match = componentPath.match(/com_([a-zA-Z0-9_]+)/i)
  return match ? match[1] : basename(componentPath).replace(/^com_/i, "")
}

function isBackupFile(fileName: string): boolean {
  return /\.(bak|backup|old)\.php$/i.test(fileName)
    || /Old\.php$/i.test(fileName)
    || /_backup\.php$/i.test(fileName)
}

async function findViewFiles(componentPath: string, context: ToolContext): Promise<ViewInfo[]> {
  const views: ViewInfo[] = []
  let scannedEntries = 0

  async function scanDirectory(directory: string): Promise<void> {
    await abortCheckpoint(context, scannedEntries++, 32)

    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      throwIfAborted(context)
      return
    }

    for (const entry of entries) {
      await abortCheckpoint(context, scannedEntries++, 32)
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await scanDirectory(fullPath)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith(".php") || isBackupFile(entry.name)) continue
      const relativePath = normalizePattern(relative(componentPath, fullPath))
      if (!relativePath.includes("tmpl/") && !relativePath.includes("layouts/")) continue

      try {
        throwIfAborted(context)
        const content = readFileSync(fullPath, "utf8")
        const lines = content.split("\n").length
        views.push({
          path: fullPath,
          relativePath,
          lines,
          needsChunking: lines > 500,
          status: "pending",
          attempts: 0,
          errors: [],
          stringsFound: 0,
          stringsConverted: 0,
        })
      } catch {
        throwIfAborted(context)
      }
    }
  }

  await scanDirectory(componentPath)
  throwIfAborted(context)
  views.sort((left, right) => right.lines - left.lines)
  return views
}

async function findLanguageFile(
  componentPath: string,
  componentName: string,
  language: string,
  context: ToolContext,
  identity: InvocationIdentity,
): Promise<string> {
  const possiblePaths = [
    join(dirname(componentPath), "..", "language", language, `${language}.com_${componentName}.ini`),
    join(componentPath, "..", "..", "language", language, `${language}.com_${componentName}.ini`),
  ]

  let defaultPath = ""
  for (let index = 0; index < possiblePaths.length; index++) {
    await abortCheckpoint(context, index, 1)
    const authorizedPath = await authorizePath(context, identity, possiblePaths[index], ["read"])
    if (index === 0) defaultPath = authorizedPath
    if (existsSync(authorizedPath)) return authorizedPath
  }
  return defaultPath
}

async function loadBoundWorkflow(
  context: ToolContext,
  identity: InvocationIdentity,
  workflowId: string | undefined,
  writable: boolean,
): Promise<{ state: TranslationWorkflowState; statePath: string } | null> {
  const authorizedBindingPath = await authorizePath(
    context,
    identity,
    bindingPath(identity.sessionId),
    ["read", ...(writable ? ["edit" as const] : [])],
  )
  const binding = readJson<TranslationBinding>(authorizedBindingPath)
  if (!binding) return null
  assertBindingOwner(binding, identity)
  if (workflowId && binding.workflow_id !== workflowId) return null

  const statePath = await authorizeStatePath(
    context,
    identity,
    binding.workflow_path,
    ["read", ...(writable ? ["edit" as const] : [])],
  )
  const state = readJson<TranslationWorkflowState>(statePath)
  if (!state || state.workflow_id !== binding.workflow_id || state.workflow_type !== "joomla-translation") return null
  assertStateOwner(state, identity)
  return { state, statePath }
}

function parseMessages(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
  } catch {
    return [value]
  }
}

function findView(state: TranslationWorkflowState, viewPath: string, context: ToolContext): ViewInfo | null {
  for (const view of state.translation.views) {
    throwIfAborted(context)
    if (view.path === viewPath || view.relativePath === viewPath) return view
  }
  return null
}

function viewCounts(state: TranslationWorkflowState, context: ToolContext): Record<ViewInfo["status"], number> {
  const counts: Record<ViewInfo["status"], number> = {
    pending: 0,
    processing: 0,
    review: 0,
    error: 0,
    done: 0,
  }
  for (const view of state.translation.views) {
    throwIfAborted(context)
    counts[view.status]++
  }
  return counts
}

export const TranslationWorkflowPlugin: Plugin = async () => {
  return {
    tool: {
    workflow_translate_init: tool({
      description: "Initialize a new Joomla translation workflow. Scans component and creates view queue.",
      args: {
        componentPath: tool.schema.string().describe("Absolute path to the Joomla component"),
        targetLanguage: tool.schema.string().describe("Target language code (e.g., fr-CA)"),
        sourceLanguage: tool.schema.string().default("en-GB").describe("Source language code"),
      },
      async execute(args, context: ToolContext) {
        const identity = invocationIdentity(context)
        const sourceLanguage = args.sourceLanguage ?? "en-GB"
        const componentPath = await authorizePath(
          context,
          identity,
          args.componentPath,
          ["read"],
          { kind: "directory", recursive: true },
        )

        if (!existsSync(componentPath) || !statSync(componentPath).isDirectory()) {
          return JSON.stringify({ success: false, error: `Component not found: ${componentPath}` })
        }

        const componentName = getComponentName(componentPath)
        const workflowId = generateWorkflowId(
          componentName,
          componentPath,
          args.targetLanguage,
          sourceLanguage,
          identity,
        )
        const statePath = await authorizeStatePath(
          context,
          identity,
          join(activeDirectory(), `${workflowId}.state.json`),
          ["read", "edit"],
        )
        const authorizedBindingPath = await authorizePath(
          context,
          identity,
          bindingPath(identity.sessionId),
          ["read", "edit"],
        )

        const existing = readJson<TranslationWorkflowState>(statePath)
        if (existing) {
          assertStateOwner(existing, identity)
          if (
            existing.workflow_id === workflowId
            && existing.translation.componentPath === componentPath
            && existing.translation.targetLanguage === args.targetLanguage
            && existing.translation.sourceLanguage === sourceLanguage
            && existing.translation.status !== "complete"
          ) {
            atomicWriteJson(authorizedBindingPath, {
              session_id: identity.sessionId,
              workflow_id: workflowId,
              workflow_path: statePath,
              directory: identity.directory,
              worktree: identity.worktree,
              project_directory: identity.directory,
              bound_at: new Date().toISOString(),
            } satisfies TranslationBinding)
            const counts = viewCounts(existing, context)
            return JSON.stringify({
              success: true,
              resumed: true,
              workflowId,
              message: "Resuming existing workflow",
              progress: {
                total: existing.translation.views.length,
                done: counts.done,
                pending: counts.pending,
              },
            })
          }
        }

        const views = await findViewFiles(componentPath, context)
        if (views.length === 0) {
          return JSON.stringify({ success: false, error: "No view files found" })
        }

        const sourceIniPath = await findLanguageFile(
          componentPath,
          componentName,
          sourceLanguage,
          context,
          identity,
        )
        const targetIniPath = await findLanguageFile(
          componentPath,
          componentName,
          args.targetLanguage,
          context,
          identity,
        )
        throwIfAborted(context)

        const now = new Date().toISOString()
        const state: TranslationWorkflowState = {
          schema_version: 1,
          revision: 0,
          workflow_id: workflowId,
          workflow_type: "joomla-translation",
          phase: { current: "translation", completed: [], remaining: ["translation"] },
          gates: { translation: { status: "pending", iteration: 0 } },
          agent_log: [],
          mode: { current: "standard" },
          owner: {
            root_session_id: identity.sessionId,
            current_session_id: identity.sessionId,
            directory: identity.directory,
            worktree: identity.worktree,
          },
          created_at: now,
          updated_at: now,
          status: "running",
          driver: "automatic",
          translation: {
            componentPath,
            componentName,
            targetLanguage: args.targetLanguage,
            sourceLanguage,
            sourceIniPath,
            targetIniPath,
            status: "processing",
            currentViewIndex: 0,
            views,
            totalStringsConverted: 0,
            totalErrors: 0,
          },
        }

        atomicWriteJson(statePath, state)
        atomicWriteJson(authorizedBindingPath, {
          session_id: identity.sessionId,
          workflow_id: workflowId,
          workflow_path: statePath,
          directory: identity.directory,
          worktree: identity.worktree,
          project_directory: identity.directory,
          bound_at: now,
        } satisfies TranslationBinding)

        return JSON.stringify({
          success: true,
          workflowId,
          componentName,
          targetLanguage: args.targetLanguage,
          sourceLanguage,
          sourceIniPath,
          targetIniPath,
          views: views.map((view) => ({
            path: view.relativePath,
            lines: view.lines,
            needsChunking: view.needsChunking,
          })),
          totalViews: views.length,
          message: `Workflow created. ${views.length} views to process.`,
        }, null, 2)
      },
    }),

    workflow_translate_next: tool({
      description: "Get the next view to process in the translation workflow.",
      args: {
        workflowId: tool.schema.string().optional().describe("Workflow ID (uses the workflow bound to this session if omitted)"),
      },
      async execute(args, context: ToolContext) {
        const identity = invocationIdentity(context)
        const active = await loadBoundWorkflow(context, identity, args.workflowId, true)
        if (!active) {
          return JSON.stringify({
            success: false,
            error: args.workflowId ? `Workflow not found: ${args.workflowId}` : "No active workflow found",
          })
        }

        const { state, statePath } = active
        let nextView: ViewInfo | null = null
        for (const view of state.translation.views) {
          throwIfAborted(context)
          if (view.status === "pending" || view.status === "error") {
            nextView = view
            break
          }
        }

        if (!nextView) {
          const counts = viewCounts(state, context)
          if (counts.done === state.translation.views.length) {
            completeWorkflow(state)
            saveWorkflowState(statePath, state)
            return JSON.stringify({
              success: true,
              complete: true,
              message: "All views processed!",
              summary: {
                totalViews: state.translation.views.length,
                stringsConverted: state.translation.totalStringsConverted,
                errors: state.translation.totalErrors,
              },
            })
          }
          return JSON.stringify({ success: false, error: "No views ready to process" })
        }

        nextView.status = "processing"
        nextView.attempts++
        state.translation.currentViewIndex = state.translation.views.indexOf(nextView)
        saveWorkflowState(statePath, state)

        const chunkingInstructions = nextView.needsChunking ? {
          required: true,
          reason: `File has ${nextView.lines} lines (>500), use chunking to inspect it completely`,
          steps: [
            `1. file_chunker(filePath="${nextView.path}", chunkSize=150, overlap=20)`,
            `2. For each chunk, call i18n_hardcode_finder(filePath="${nextView.path}", startLine=X, endLine=Y)`,
            "3. Combine findings and remove overlap duplicates",
            "4. Convert the hardcoded strings actually found with i18n_convert",
            "5. Report the observed counts accurately; zero is valid when no hardcoded strings are found",
          ],
        } : {
          required: false,
          reason: `File has ${nextView.lines} lines (<500), can process directly`,
        }

        const explicitInstructions = [
          "========================================",
          "MANDATORY TARGET FILE - NO SUBSTITUTIONS",
          "========================================",
          `EXACT PATH: ${nextView.path}`,
          `COMPONENT: com_${state.translation.componentName}`,
          `VIEW: ${nextView.relativePath}`,
          "",
          "YOU MUST:",
          `1. Read EXACTLY: ${nextView.path}`,
          `2. Process ONLY: ${nextView.path}`,
          `3. Convert strings in: ${nextView.path}`,
          "4. Report only strings actually found and converted",
          "",
          "YOU MUST NOT:",
          "- Process another component",
          "- Process another view file",
          "- Search for alternative files",
          "========================================",
        ].join("\n")
        const counts = viewCounts(state, context)

        return JSON.stringify({
          success: true,
          CRITICAL_TARGET_FILE: nextView.path,
          CRITICAL_COMPONENT: `com_${state.translation.componentName}`,
          explicitInstructions,
          workflowId: state.workflow_id,
          componentName: state.translation.componentName,
          targetLanguage: state.translation.targetLanguage,
          sourceLanguage: state.translation.sourceLanguage,
          sourceIniPath: state.translation.sourceIniPath,
          targetIniPath: state.translation.targetIniPath,
          view: {
            path: nextView.path,
            relativePath: nextView.relativePath,
            lines: nextView.lines,
            needsChunking: nextView.needsChunking,
            attempt: nextView.attempts,
            previousErrors: nextView.errors,
          },
          chunking: chunkingInstructions,
          progress: {
            current: state.translation.currentViewIndex + 1,
            total: state.translation.views.length,
            done: counts.done,
          },
          warning: nextView.needsChunking
            ? "LARGE FILE: Use file_chunker and inspect every chunk before reporting the observed counts."
            : null,
        }, null, 2)
      },
    }),

    workflow_translate_view_done: tool({
      description: "Mark a view as processed after inspecting it, using the actual observed string counts.",
      args: {
        workflowId: tool.schema.string().describe("Workflow ID"),
        viewPath: tool.schema.string().describe("Path to the view that was processed"),
        stringsFound: tool.schema.number().describe("Number of hardcoded strings found, including zero"),
        stringsConverted: tool.schema.number().describe("Number of strings successfully converted, including zero"),
        errors: tool.schema.string().optional().describe("JSON array of error messages, if any"),
      },
      async execute(args, context: ToolContext) {
        const identity = invocationIdentity(context)
        const active = await loadBoundWorkflow(context, identity, args.workflowId, true)
        if (!active) {
          return JSON.stringify({ success: false, error: `Workflow not found: ${args.workflowId}` })
        }

        const { state, statePath } = active
        const view = findView(state, args.viewPath, context)
        if (!view) {
          return JSON.stringify({ success: false, error: `View not found: ${args.viewPath}` })
        }
        state.translation.totalStringsConverted += args.stringsConverted - view.stringsConverted
        view.stringsFound = args.stringsFound
        view.stringsConverted = args.stringsConverted
        view.lastProcessed = new Date().toISOString()
        if (args.errors) view.errors = parseMessages(args.errors)
        view.status = "review"
        saveWorkflowState(statePath, state)

        return JSON.stringify({
          success: true,
          message: "View marked for review",
          view: view.relativePath,
          stringsConverted: args.stringsConverted,
          needsReview: true,
        })
      },
    }),

    workflow_translate_review: tool({
      description: "Submit review result for a processed view. Pass or fail.",
      args: {
        workflowId: tool.schema.string().describe("Workflow ID"),
        viewPath: tool.schema.string().describe("Path to the view that was reviewed"),
        passed: tool.schema.boolean().describe("Whether the review passed"),
        issues: tool.schema.string().optional().describe("JSON array of issues found (if failed)"),
      },
      async execute(args, context: ToolContext) {
        const identity = invocationIdentity(context)
        const active = await loadBoundWorkflow(context, identity, args.workflowId, true)
        if (!active) {
          return JSON.stringify({ success: false, error: `Workflow not found: ${args.workflowId}` })
        }

        const { state, statePath } = active
        const view = findView(state, args.viewPath, context)
        if (!view) {
          return JSON.stringify({ success: false, error: `View not found: ${args.viewPath}` })
        }

        if (args.passed) {
          view.status = "done"
          view.errors = []
          const counts = viewCounts(state, context)
          const remaining = state.translation.views.length - counts.done
          const allDone = remaining === 0
          if (allDone) completeWorkflow(state)
          saveWorkflowState(statePath, state)

          return JSON.stringify({
            success: true,
            passed: true,
            viewComplete: true,
            workflowComplete: allDone,
            remaining,
            message: allDone ? "All views complete! Workflow finished." : `View passed. ${remaining} views remaining.`,
          })
        }

        if (args.issues) view.errors = parseMessages(args.issues)
        state.translation.totalErrors++
        view.status = "error"
        saveWorkflowState(statePath, state)

        if (view.attempts >= 3) {
          return JSON.stringify({
            success: true,
            passed: false,
            maxAttemptsReached: true,
            message: "View failed after 3 attempts. Marked for manual fix.",
            errors: view.errors,
          })
        }

        return JSON.stringify({
          success: true,
          passed: false,
          willRetry: true,
          attempt: view.attempts,
          maxAttempts: 3,
          message: `Review failed. Will retry (attempt ${view.attempts}/3).`,
          issues: view.errors,
        })
      },
    }),

    workflow_translate_status: tool({
      description: "Get the current status of a translation workflow.",
      args: {
        workflowId: tool.schema.string().optional().describe("Workflow ID (uses the workflow bound to this session if omitted)"),
      },
      async execute(args, context: ToolContext) {
        const identity = invocationIdentity(context)
        const active = await loadBoundWorkflow(context, identity, args.workflowId, false)
        if (!active) {
          return JSON.stringify({
            success: false,
            error: args.workflowId ? `Workflow not found: ${args.workflowId}` : "No active workflow found",
          })
        }

        const { state } = active
        const counts = viewCounts(state, context)
        const totalViews = state.translation.views.length
        return JSON.stringify({
          success: true,
          workflowId: state.workflow_id,
          componentName: state.translation.componentName,
          targetLanguage: state.translation.targetLanguage,
          status: state.translation.status,
          progress: {
            total: totalViews,
            done: counts.done,
            pending: counts.pending,
            error: counts.error,
            processing: counts.processing + counts.review,
            percentComplete: totalViews === 0 ? 0 : Math.round((counts.done / totalViews) * 100),
          },
          stringsConverted: state.translation.totalStringsConverted,
          totalErrors: state.translation.totalErrors,
          views: state.translation.views.map((view) => ({
            path: view.relativePath,
            lines: view.lines,
            status: view.status,
            attempts: view.attempts,
            stringsConverted: view.stringsConverted,
          })),
        }, null, 2)
      },
    }),
    },
  }
}
