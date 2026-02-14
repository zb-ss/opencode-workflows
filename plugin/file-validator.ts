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

const DANGEROUS_PATTERNS = [
  /\.\.[\/\\]/,
  /[<>|"'`$(){}]/,
  /\0/,
  /^[\/\\]{2}/,
]

function validateFilePath(inputPath: string): string | null {
  if (!inputPath || typeof inputPath !== 'string') return null

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(inputPath)) return null
  }

  try {
    const resolved = path.resolve(inputPath)
    const cwd = process.cwd()
    const tmpDir = os.tmpdir()
    const homeDir = os.homedir()

    const allowedRoots = [
      path.resolve(cwd),
      path.resolve(tmpDir),
      path.resolve(path.join(homeDir, '.config', 'opencode')),
    ]

    const isAllowed = allowedRoots.some(root => {
      const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep
      return resolved === root || resolved.startsWith(normalizedRoot)
    })

    if (!isAllowed) {
      if (path.dirname(resolved) === path.resolve(cwd)) return resolved
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

export const FileValidator: Plugin = async ({ $ }) => {
  return {
    "tool.execute.after": async ({ tool, args, output }) => {
      // Only validate after edit/write operations
      const editTools = ['edit', 'write', 'Edit', 'Write']
      if (!editTools.includes(tool)) return

      const filePath = args?.file_path || args?.path
      if (!filePath) return

      const validated = validateFilePath(filePath)
      if (!validated) return

      const ext = path.extname(validated).toLowerCase()

      let validationError: string | null = null

      switch (ext) {
        case '.ts':
        case '.tsx':
          validationError = await runValidator('npx', ['tsc', '--noEmit', '--skipLibCheck'], validated)
          break
        case '.php':
          validationError = await runValidator('php', ['-l', validated], validated)
          break
        case '.py': {
          const pythonCmd = commandExists('python3') ? 'python3' : 'python'
          validationError = await runValidator(pythonCmd, ['-m', 'py_compile', validated], validated)
          break
        }
        case '.json':
          validationError = validateJson(validated)
          break
        case '.org':
          alignOrgTables(validated)
          break
      }

      if (validationError) {
        output.output = (output.output || '') + `\n\nValidation warning: ${validationError}`
      }
    }
  }
}

export default FileValidator
