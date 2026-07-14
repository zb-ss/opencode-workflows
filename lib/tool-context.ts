import type { ToolContext } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { lstatSync, readlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

type Access = "read" | "edit"

interface AuthorizePathOptions {
  kind?: "file" | "directory"
  recursive?: boolean
}

function normalizePattern(path: string): string {
  return path.replaceAll("\\", "/")
}

function containsPath(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
}

function canonicalizePath(path: string, symlinkDepth = 0): string {
  if (symlinkDepth > 40) {
    throw new Error(`Too many symbolic links while resolving path: ${path}`)
  }

  const absolutePath = resolve(path)
  const root = parse(absolutePath).root
  const segments = relative(root, absolutePath).split(sep).filter(Boolean)
  let currentPath = root

  for (let i = 0; i < segments.length; i++) {
    const candidate = join(currentPath, segments[i])
    let stats
    try {
      stats = lstatSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        return resolve(candidate, ...segments.slice(i + 1))
      }
      throw error
    }

    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(candidate), readlinkSync(candidate))
      return canonicalizePath(resolve(target, ...segments.slice(i + 1)), symlinkDepth + 1)
    }
    currentPath = candidate
  }

  return currentPath
}

async function requestExternalDirectory(
  context: ToolContext,
  target: string,
  root: string,
  kind: "file" | "directory",
): Promise<void> {
  if (containsPath(root, target)) return

  const parentDir = kind === "directory" ? target : dirname(target)
  const pattern = normalizePattern(join(parentDir, "*"))
  await context.ask({
    permission: "external_directory",
    patterns: [pattern],
    always: [pattern],
    metadata: { filepath: target, parentDir },
  })
  throwIfAborted(context)
}

async function requestAccess(
  context: ToolContext,
  target: string,
  root: string,
  access: Access,
  recursive: boolean,
): Promise<void> {
  const relativePath = normalizePattern(relative(root, target) || ".")
  const pattern = recursive ? `${relativePath.replace(/\/$/, "")}/**` : relativePath
  await context.ask({
    permission: access,
    patterns: [pattern],
    always: [pattern],
    metadata: { filepath: target },
  })
  throwIfAborted(context)
}

export function resolveToolPath(context: ToolContext, inputPath: string): string {
  return resolve(context.directory, inputPath)
}

export async function authorizeToolPath(
  context: ToolContext,
  inputPath: string,
  access: Access,
  options: AuthorizePathOptions = {},
): Promise<string> {
  throwIfAborted(context)

  const kind = options.kind ?? "file"
  const lexicalRoot = resolve(context.worktree)
  const lexicalPath = resolveToolPath(context, inputPath)

  await requestExternalDirectory(context, lexicalPath, lexicalRoot, kind)
  await requestAccess(context, lexicalPath, lexicalRoot, access, options.recursive ?? false)

  const canonicalRoot = canonicalizePath(lexicalRoot)
  const canonicalPath = canonicalizePath(lexicalPath)
  if (canonicalPath !== lexicalPath || canonicalRoot !== lexicalRoot) {
    await requestExternalDirectory(context, canonicalPath, canonicalRoot, kind)
    await requestAccess(context, canonicalPath, canonicalRoot, access, options.recursive ?? false)
  }

  throwIfAborted(context)
  return canonicalPath
}

export function getSessionTempDir(context: ToolContext, scope: string): string {
  const sessionHash = createHash("sha256").update(context.sessionID).digest("hex").slice(0, 16)
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, "-")
  return join(tmpdir(), "opencode-workflows", sessionHash, safeScope)
}

export function throwIfAborted(context: ToolContext): void {
  if (!context.abort.aborted) return
  if (context.abort.reason instanceof Error) throw context.abort.reason

  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  throw error
}

export async function abortCheckpoint(context: ToolContext, index: number, interval = 128): Promise<void> {
  throwIfAborted(context)
  if (index % interval !== 0) return

  await new Promise<void>((resolveCheckpoint) => setImmediate(resolveCheckpoint))
  throwIfAborted(context)
}
