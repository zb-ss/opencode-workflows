/**
 * OpenCode File Validator Plugin
 *
 * Validates edited files after tool execution.
 * Supports: TypeScript, PHP, Python, JSON, Org-mode tables.
 *
 * Ported from Claude Code hooks/validate-file.js
 * Security: path validation, no shell for JSON, proper argument escaping.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { log } from "../lib/logger.ts"

const DANGEROUS_PATTERNS = [
  /\.\.[\/\\]/,
  /[<>|"'`$(){}]/,
  /\0/,
  /^[\/\\]{2}/,
]

function validateFilePath(inputPath: string, directory: string): string | null {
  if (!inputPath || typeof inputPath !== 'string') return null

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(inputPath)) return null
  }

  try {
    const resolved = path.resolve(directory, inputPath)
    const tmpDir = os.tmpdir()
    const homeDir = os.homedir()
    const configDir = process.env.OPENCODE_CONFIG_DIR
      || path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'opencode')

    const allowedRoots = [
      path.resolve(directory),
      path.resolve(tmpDir),
      path.resolve(configDir),
    ]

    const isAllowed = allowedRoots.some(root => {
      const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep
      return resolved === root || resolved.startsWith(normalizedRoot)
    })

    if (!isAllowed) {
      if (path.dirname(resolved) === path.resolve(directory)) return resolved
      return null
    }

    return resolved
  } catch {
    return null
  }
}

function commandExists(cmd: string): boolean {
  try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which'
    const result = spawnSync(checkCmd, [cmd], {
      encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    })
    return result.status === 0
  } catch {
    return false
  }
}

function validateJson(file: string): string | null {
  try {
    const content = fs.readFileSync(file, 'utf8')
    JSON.parse(content)
    return null
  } catch (err) {
    if (err instanceof SyntaxError) {
      return `JSON error in ${path.basename(file)}: ${err.message}`
    }
    return null
  }
}

function runValidator(cmd: string, args: string[], file: string): Promise<string | null> {
  if (!commandExists(cmd === 'npx' ? 'npm' : cmd)) return Promise.resolve(null)

  return new Promise((resolve) => {
    const fileName = path.basename(file)
    const proc = spawn(cmd, args, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(file) || process.cwd(),
      shell: false,
    })

    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timeoutId = setTimeout(() => { proc.kill('SIGKILL'); resolve(null) }, 15000)

    proc.on('close', (code: number | null) => {
      clearTimeout(timeoutId)
      if (code !== 0) {
        const output = (stdout + stderr).trim()
        const relevant = output.split('\n')
          .filter((l: string) => l.includes(fileName) || l.toLowerCase().includes('error') || l.toLowerCase().includes('syntax'))
          .slice(0, 5).join('\n')
        resolve(relevant || null)
      } else {
        resolve(null)
      }
    })

    proc.on('error', () => { clearTimeout(timeoutId); resolve(null) })
  })
}

function alignTable(tableLines: string[], indent: string): string[] {
  const parsed = tableLines.map(line => {
    const stripped = line.replace(/^\s*/, '')
    if (/^\|[-+]+\|?\s*$/.test(stripped)) {
      return { type: 'separator' as const, cells: [] as string[] }
    }
    const cells = stripped.split('|')
    const inner = cells.slice(1, cells.length - 1).map(c => c.trim())
    return { type: 'data' as const, cells: inner }
  })

  const maxCols = parsed.reduce((max, row) =>
    row.type === 'data' ? Math.max(max, row.cells.length) : max, 0)

  if (maxCols === 0) return tableLines

  for (const row of parsed) {
    if (row.type === 'data') {
      while (row.cells.length < maxCols) row.cells.push('')
    }
  }

  const colWidths = new Array(maxCols).fill(0)
  for (const row of parsed) {
    if (row.type === 'data') {
      for (let c = 0; c < maxCols; c++) {
        colWidths[c] = Math.max(colWidths[c], row.cells[c].length)
      }
    }
  }
  for (let c = 0; c < maxCols; c++) {
    if (colWidths[c] < 1) colWidths[c] = 1
  }

  return parsed.map(row => {
    if (row.type === 'separator') {
      return indent + '|' + colWidths.map((w: number) => '-'.repeat(w + 2)).join('+') + '|'
    }
    return indent + '|' + row.cells.map((cell: string, c: number) => ' ' + cell.padEnd(colWidths[c]) + ' ').join('|') + '|'
  })
}

function alignOrgTables(file: string): void {
  try {
    const content = fs.readFileSync(file, 'utf8')
    const lines = content.split('\n')
    const result: string[] = []
    let i = 0

    while (i < lines.length) {
      if (/^(\s*)\|/.test(lines[i])) {
        const tableLines: string[] = []
        const indent = lines[i].match(/^(\s*)/)?.[1] || ''
        while (i < lines.length && /^(\s*)\|/.test(lines[i])) {
          tableLines.push(lines[i])
          i++
        }
        result.push(...alignTable(tableLines, indent))
      } else {
        result.push(lines[i])
        i++
      }
    }

    const newContent = result.join('\n')
    if (newContent !== content) {
      fs.writeFileSync(file, newContent, 'utf8')
    }
  } catch {
    /* cosmetic, never fail */
  }
}

function editedFilePaths(tool: string, args: Record<string, unknown>): string[] {
  const normalizedTool = tool.toLowerCase()
  if (!['edit', 'write', 'apply_patch'].includes(normalizedTool)) return []

  const files = new Set<string>()
  const directPath = args.filePath ?? args.file_path ?? args.path
  if (typeof directPath === 'string') files.add(directPath)

  if (normalizedTool === 'apply_patch') {
    const patchText = args.patchText ?? args.patch_text ?? args.patch
    if (typeof patchText === 'string') {
      const headerPattern = /^\*\*\* (Add|Update) File: (.+)$/gm
      for (const match of patchText.matchAll(headerPattern)) files.add(match[2].trim())

      const movePattern = /^\*\*\* Move to: (.+)$/gm
      for (const match of patchText.matchAll(movePattern)) files.add(match[1].trim())
    }
  }

  return [...files]
}

async function validateEditedFile(filePath: string, directory: string): Promise<string | null> {
  const validated = validateFilePath(filePath, directory)
  if (!validated || !fs.existsSync(validated)) return null

  const ext = path.extname(validated).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.tsx':
      return runValidator('npx', ['tsc', '--noEmit', '--skipLibCheck'], validated)
    case '.php':
      return runValidator('php', ['-l', validated], validated)
    case '.py': {
      const pythonCmd = commandExists('python3') ? 'python3' : 'python'
      return runValidator(pythonCmd, ['-m', 'py_compile', validated], validated)
    }
    case '.json':
      return validateJson(validated)
    case '.org':
      alignOrgTables(validated)
      return null
    default:
      return null
  }
}

export const FileValidator: Plugin = async ({ directory }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== 'file.edited') return
      const validationError = await validateEditedFile(event.properties.file, directory)
      if (validationError) {
        log('file-validator', validationError)
      }
    },

    "tool.execute.after": async (input, output) => {
      const files = editedFilePaths(input.tool, input.args || {})
      if (files.length === 0) return

      const warnings: string[] = []
      for (const filePath of files) {
        const validationError = await validateEditedFile(filePath, directory)
        if (validationError) warnings.push(validationError)
      }

      if (warnings.length > 0) {
        output.output += `\n\nValidation warning: ${warnings.join('\n')}`
      }
    }
  }
}

export default FileValidator
