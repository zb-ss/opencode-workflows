import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import { TranslationWorkflowPlugin } from "../../plugin/translation-workflow.ts"

interface PermissionRequest {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

interface TestEnvironment {
  configDirectory: string
  worktree: string
  componentPath: string
  viewPath: string
}

const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
const temporaryDirectories: string[] = []

function createEnvironment(lines = 3): TestEnvironment {
  const configDirectory = mkdtempSync(join(tmpdir(), "translation-workflow-config-"))
  const worktree = mkdtempSync(join(tmpdir(), "translation-workflow-worktree-"))
  temporaryDirectories.push(configDirectory, worktree)
  process.env.OPENCODE_CONFIG_DIR = configDirectory

  const componentPath = join(worktree, "administrator", "components", "com_example")
  const viewPath = join(componentPath, "tmpl", "items", "default.php")
  mkdirSync(join(componentPath, "tmpl", "items"), { recursive: true })
  const content = ["<?php", ...Array.from({ length: lines - 1 }, (_, index) => `// line ${index + 2}`)].join("\n")
  writeFileSync(viewPath, content, "utf8")
  return { configDirectory, worktree, componentPath, viewPath }
}

function context(
  environment: TestEnvironment,
  sessionID: string,
  ask: (request: PermissionRequest) => Promise<void> = async () => {},
  abort: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: "test-agent",
    directory: environment.worktree,
    worktree: environment.worktree,
    abort,
    metadata() {},
    ask,
  }
}

async function tools() {
  const hooks = await TranslationWorkflowPlugin({} as PluginInput)
  assert.ok(hooks.tool)
  return hooks.tool
}

async function initialize(environment: TestEnvironment, toolContext: ToolContext) {
  const pluginTools = await tools()
  const result = JSON.parse(await pluginTools.workflow_translate_init.execute({
    componentPath: environment.componentPath,
    targetLanguage: "fr-CA",
    sourceLanguage: "en-GB",
  }, toolContext) as string) as { success: boolean; workflowId: string }
  assert.equal(result.success, true)
  return { pluginTools, result }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
})

describe("translation workflow ToolContext state", () => {
  it("isolates workflows by the exact caller session", async () => {
    const environment = createEnvironment()
    const sessionA = context(environment, "session-a")
    const { pluginTools, result } = await initialize(environment, sessionA)

    const ownerStatus = JSON.parse(await pluginTools.workflow_translate_status.execute(
      { workflowId: result.workflowId },
      sessionA,
    ) as string) as { success: boolean }
    const unboundStatus = JSON.parse(await pluginTools.workflow_translate_status.execute(
      {},
      context(environment, "session-b"),
    ) as string) as { success: boolean; error: string }
    const otherStatus = JSON.parse(await pluginTools.workflow_translate_status.execute(
      { workflowId: result.workflowId },
      context(environment, "session-b"),
    ) as string) as { success: boolean; error: string }

    assert.equal(ownerStatus.success, true)
    assert.deepEqual(unboundStatus, { success: false, error: "No active workflow found" })
    assert.equal(otherStatus.success, false)
    assert.equal(otherStatus.error, `Workflow not found: ${result.workflowId}`)
  })

  it("does not write state when edit permission is denied", async () => {
    const environment = createEnvironment()
    const requests: PermissionRequest[] = []
    const deniedContext = context(environment, "session-denied", async (request) => {
      requests.push(request)
      if (request.permission === "edit") throw new Error("edit denied")
    })
    const pluginTools = await tools()

    await assert.rejects(
      pluginTools.workflow_translate_init.execute({
        componentPath: environment.componentPath,
        targetLanguage: "fr-CA",
        sourceLanguage: "en-GB",
      }, deniedContext),
      /edit denied/,
    )

    assert.ok(requests.some((request) => request.permission === "external_directory"))
    assert.ok(requests.some((request) => request.permission === "read"))
    assert.ok(requests.some((request) => request.permission === "edit"))
    assert.equal(existsSync(join(environment.configDirectory, "workflows")), false)
  })

  it("honors abort during a recursive component scan without writing state", async () => {
    const environment = createEnvironment(2)
    for (let index = 0; index < 100; index++) {
      const directory = join(environment.componentPath, "layouts", `group-${index}`)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "default.php"), `<?php // ${index}\n`, "utf8")
    }

    const controller = new AbortController()
    let scheduledAbort = false
    const abortingContext = context(environment, "session-abort", async (request) => {
      if (!scheduledAbort && request.permission === "read") {
        scheduledAbort = true
        setTimeout(() => controller.abort(), 0)
      }
    }, controller.signal)
    const pluginTools = await tools()

    await assert.rejects(
      pluginTools.workflow_translate_init.execute({
        componentPath: environment.componentPath,
        targetLanguage: "fr-CA",
        sourceLanguage: "en-GB",
      }, abortingContext),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    )

    assert.equal(existsSync(join(environment.configDirectory, "workflows")), false)
  })

  it("writes private unified state only below the OpenCode config directory", async () => {
    const environment = createEnvironment()
    await initialize(environment, context(environment, "session-location"))

    const activeDirectory = join(environment.configDirectory, "workflows", "active")
    const stateFiles = readdirSync(activeDirectory).filter((file) => file.endsWith(".state.json"))
    assert.equal(stateFiles.length, 1)
    assert.equal(existsSync(join(environment.worktree, "workflows")), false)

    const statePath = join(activeDirectory, stateFiles[0])
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      workflow_type: string
      owner: { root_session_id: string; current_session_id: string; directory: string; worktree: string }
    }
    assert.equal(state.workflow_type, "joomla-translation")
    assert.equal(state.owner.root_session_id, "session-location")
    assert.equal(state.owner.current_session_id, "session-location")
    assert.equal(state.owner.directory, environment.worktree)
    assert.equal(state.owner.worktree, environment.worktree)
    if (process.platform !== "win32") assert.equal(statSync(statePath).mode & 0o777, 0o600)
  })

  it("accepts an honestly processed large view with zero strings", async () => {
    const environment = createEnvironment(501)
    const toolContext = context(environment, "session-zero")
    const { pluginTools, result } = await initialize(environment, toolContext)

    const next = JSON.parse(await pluginTools.workflow_translate_next.execute(
      { workflowId: result.workflowId },
      toolContext,
    ) as string) as { success: boolean; view: { path: string; needsChunking: boolean } }
    assert.equal(next.success, true)
    assert.equal(next.view.needsChunking, true)

    const done = JSON.parse(await pluginTools.workflow_translate_view_done.execute({
      workflowId: result.workflowId,
      viewPath: next.view.path,
      stringsFound: 0,
      stringsConverted: 0,
    }, toolContext) as string) as { success: boolean }
    assert.equal(done.success, true)

    const review = JSON.parse(await pluginTools.workflow_translate_review.execute({
      workflowId: result.workflowId,
      viewPath: next.view.path,
      passed: true,
    }, toolContext) as string) as { success: boolean; workflowComplete: boolean }
    assert.equal(review.success, true)
    assert.equal(review.workflowComplete, true)

    const status = JSON.parse(await pluginTools.workflow_translate_status.execute(
      { workflowId: result.workflowId },
      toolContext,
    ) as string) as { success: boolean; status: string; stringsConverted: number }
    assert.equal(status.success, true)
    assert.equal(status.status, "complete")
    assert.equal(status.stringsConverted, 0)
  })
})
