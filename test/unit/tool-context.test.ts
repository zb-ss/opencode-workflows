import type { ToolContext } from "@opencode-ai/plugin"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, it } from "node:test"
import fileChunker from "../../tool/file-chunker.ts"
import i18nExtract from "../../tool/i18n-extract.ts"
import iniBuilder from "../../tool/ini-builder.ts"

interface PermissionRequest {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

const tempDirectories: string[] = []

function createTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function createContext(
  directory: string,
  ask: (request: PermissionRequest) => Promise<void>,
  abort: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    sessionID: "session-test",
    messageID: "message-test",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort,
    metadata() {},
    ask,
  }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("custom tool context handling", () => {
  it("does not mutate when edit authorization is denied", async () => {
    const worktree = createTempDirectory("tool-context-denied-")
    const outputFile = join(worktree, "nested", "messages.ini")
    const requests: PermissionRequest[] = []
    const context = createContext(worktree, async (request) => {
      requests.push(request)
      if (request.permission === "edit") throw new Error("permission denied")
    })

    await assert.rejects(
      iniBuilder.execute({
        action: "create",
        filePath: "nested/messages.ini",
        strings: JSON.stringify([{ key: "COM_EXAMPLE_TITLE", value: "Example" }]),
        sort: true,
      }, context),
      /permission denied/,
    )

    assert.deepEqual(requests.map((request) => request.permission), ["edit"])
    assert.equal(existsSync(outputFile), false)
    assert.equal(existsSync(dirname(outputFile)), false)
  })

  it("requests external_directory before reading an outside path", async () => {
    const worktree = createTempDirectory("tool-context-worktree-")
    const outsideDirectory = createTempDirectory("tool-context-outside-")
    const outsideFile = join(outsideDirectory, "view.php")
    writeFileSync(outsideFile, "<?php echo Text::_('COM_EXAMPLE_TITLE');\n", "utf-8")

    const requests: PermissionRequest[] = []
    const context = createContext(worktree, async (request) => {
      requests.push(request)
    })

    const result = JSON.parse(await i18nExtract.execute({
      filePath: outsideFile,
      framework: "joomla",
    }, context) as string) as { success: boolean; filePath: string }

    assert.equal(result.success, true)
    assert.equal(result.filePath, outsideFile)
    assert.deepEqual(requests.map((request) => request.permission), ["external_directory", "read"])
    assert.deepEqual(requests[0].patterns, [join(outsideDirectory, "*").replaceAll("\\", "/")])
  })

  it("canonicalizes an in-worktree symlink and authorizes its outside target", async () => {
    const worktree = createTempDirectory("tool-context-symlink-")
    const outsideDirectory = createTempDirectory("tool-context-symlink-target-")
    const outsideFile = join(outsideDirectory, "view.php")
    const linkedFile = join(worktree, "linked.php")
    writeFileSync(outsideFile, "<?php echo Text::_('COM_EXAMPLE_TITLE');\n", "utf-8")
    symlinkSync(outsideFile, linkedFile)

    const requests: PermissionRequest[] = []
    const context = createContext(worktree, async (request) => {
      requests.push(request)
    })

    const result = JSON.parse(await i18nExtract.execute({
      filePath: "linked.php",
      framework: "joomla",
    }, context) as string) as { success: boolean; filePath: string }

    assert.equal(result.success, true)
    assert.equal(result.filePath, outsideFile)
    assert.deepEqual(requests.map((request) => request.permission), ["read", "external_directory", "read"])
  })

  it("does not write through a dangling symlink when external access is denied", async () => {
    const worktree = createTempDirectory("tool-context-dangling-")
    const outsideDirectory = createTempDirectory("tool-context-dangling-target-")
    const outsideFile = join(outsideDirectory, "messages.ini")
    symlinkSync(outsideFile, join(worktree, "messages.ini"))

    const requests: PermissionRequest[] = []
    const context = createContext(worktree, async (request) => {
      requests.push(request)
      if (request.permission === "external_directory") throw new Error("external access denied")
    })

    await assert.rejects(
      iniBuilder.execute({
        action: "create",
        filePath: "messages.ini",
        strings: JSON.stringify([{ key: "COM_EXAMPLE_TITLE", value: "Example" }]),
        sort: true,
      }, context),
      /external access denied/,
    )

    assert.deepEqual(requests.map((request) => request.permission), ["edit", "external_directory"])
    assert.equal(existsSync(outsideFile), false)
  })

  it("stops an aborted long-running call before creating state", async () => {
    const worktree = createTempDirectory("tool-context-abort-")
    const sourceFile = join(worktree, "large.txt")
    const outputDirectory = join(worktree, "state")
    writeFileSync(sourceFile, Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n"), "utf-8")

    const controller = new AbortController()
    const requests: PermissionRequest[] = []
    const context = createContext(worktree, async (request) => {
      requests.push(request)
      if (request.permission === "read") setTimeout(() => controller.abort(), 0)
    }, controller.signal)

    await assert.rejects(
      fileChunker.execute({
        filePath: "large.txt",
        chunkSize: 1,
        overlap: 0,
        outputDir: "state",
      }, context),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    )

    assert.deepEqual(requests.map((request) => request.permission), ["read"])
    assert.equal(existsSync(outputDirectory), false)
  })
})
