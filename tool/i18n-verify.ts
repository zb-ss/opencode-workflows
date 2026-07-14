import { tool, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { basename, join } from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { abortCheckpoint, authorizeToolPath, throwIfAborted } from "../lib/tool-context.ts"

const execFileAsync = promisify(execFile)

interface MissingKey {
  key: string
  file: string
  line: number
  context: string
}

interface OrphanKey {
  key: string
  iniFile: string
}

interface VerifyResult {
  success: boolean
  phpFiles: number
  totalCalls: number
  uniqueKeys: number
  missingInSource: MissingKey[]
  missingInTarget: MissingKey[]
  orphanKeysSource: OrphanKey[]
  orphanKeysTarget: OrphanKey[]
  summary: string
}

// Parse INI file and return key-value map
function parseIniFile(filePath: string, context: ToolContext): Map<string, string> {
  const keys = new Map<string, string>()
  if (!existsSync(filePath)) return keys
  
  const content = readFileSync(filePath, "utf-8")
  const lines = content.split("\n")
  
  for (let i = 0; i < lines.length; i++) {
    if (i % 128 === 0) throwIfAborted(context)
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue
    
    const match = trimmed.match(/^([A-Z][A-Z0-9_]+)\s*=\s*"(.*)"\s*$/)
    if (match) {
      keys.set(match[1], match[2])
    }
  }
  
  return keys
}

// Extract all Text::_() calls from PHP files
async function extractTextCalls(
  componentPath: string,
  context: ToolContext,
): Promise<Map<string, { files: string[], lines: number[] }>> {
  const calls = new Map<string, { files: string[], lines: number[] }>()
  
  try {
    // Find all PHP files in the component
    const { stdout: result } = await execFileAsync(
      "grep",
      ["-rn", "-E", "--include=*.php", "Text::_|JText::_|Joomla\\.JText\\._|Joomla\\.Text\\._", "--", componentPath],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, signal: context.abort },
    )
    
    const lines = result.split("\n").filter(l => l.trim())
    
    for (let i = 0; i < lines.length; i++) {
      await abortCheckpoint(context, i)
      const line = lines[i]
      // Format: file:linenum:content
      const match = line.match(/^([^:]+):(\d+):(.+)$/)
      if (!match) continue
      
      const [, file, lineNum, content] = match
      
      // Extract all keys from this line
      const keyMatches = content.matchAll(/(?:Text::_|JText::_)\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)
      for (const keyMatch of keyMatches) {
        const key = keyMatch[1]
        if (!calls.has(key)) {
          calls.set(key, { files: [], lines: [] })
        }
        const entry = calls.get(key)!
        if (!entry.files.includes(file)) {
          entry.files.push(file)
          entry.lines.push(parseInt(lineNum))
        }
      }
      
      // Also check for JavaScript Joomla.JText._() calls
      const jsKeyMatches = content.matchAll(/Joomla\.(?:J)?Text\._\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)
      for (const keyMatch of jsKeyMatches) {
        const key = keyMatch[1]
        if (!calls.has(key)) {
          calls.set(key, { files: [], lines: [] })
        }
        const entry = calls.get(key)!
        if (!entry.files.includes(file)) {
          entry.files.push(file)
          entry.lines.push(parseInt(lineNum))
        }
      }
    }
  } catch {
    throwIfAborted(context)
    // Ignore errors, return what we found
  }
  
  return calls
}

// Find orphan keys (in INI but not used in PHP)
function findOrphanKeys(
  iniKeys: Map<string, string>, 
  usedKeys: ReadonlyMap<string, unknown>,
  componentPrefix: string,
  context: ToolContext,
): string[] {
  const orphans: string[] = []
  
  let index = 0
  for (const key of iniKeys.keys()) {
    if (index++ % 128 === 0) throwIfAborted(context)
    // Only check component-specific keys (not JOOMLA core keys)
    if (key.startsWith(componentPrefix) && !usedKeys.has(key)) {
      orphans.push(key)
    }
  }
  
  return orphans
}

export default tool({
  description: "Verify all Text::_() calls have matching INI keys. Finds missing translations and orphan keys.",
  args: {
    componentPath: tool.schema.string().describe("Path to Joomla component"),
    sourceIni: tool.schema.string().optional().describe("Path to source INI (en-GB). Auto-detected if not provided."),
    targetIni: tool.schema.string().optional().describe("Path to target INI. Auto-detected if not provided."),
    targetLanguage: tool.schema.string().optional().describe("Target language code (e.g., fr-CA). Default: fr-CA")
  },
  async execute(args, context: ToolContext): Promise<string> {
    const componentPath = await authorizeToolPath(context, args.componentPath, "read", {
      kind: "directory",
      recursive: true,
    })
    const targetLang = args.targetLanguage || "fr-CA"
    
    if (!existsSync(componentPath)) {
      return JSON.stringify({ success: false, error: `Component not found: ${componentPath}` })
    }
    
    // Detect component name
    const componentMatch = componentPath.match(/com_(\w+)/i)
    const componentName = componentMatch ? componentMatch[1] : basename(componentPath).replace("com_", "")
    const componentPrefix = `COM_${componentName.toUpperCase()}`
    
    // Find INI files
    const basePath = componentPath.replace(/\/components\/com_\w+.*$/, "")
    
    const sourceIniPath = await authorizeToolPath(
      context,
      args.sourceIni || join(basePath, `language/en-GB/en-GB.com_${componentName}.ini`),
      "read",
    )
    const targetIniPath = await authorizeToolPath(
      context,
      args.targetIni || join(basePath, `language/${targetLang}/${targetLang}.com_${componentName}.ini`),
      "read",
    )
    
    // Parse INI files
    const sourceKeys = parseIniFile(sourceIniPath, context)
    const targetKeys = parseIniFile(targetIniPath, context)
    
    // Extract all Text::_() calls from PHP files
    const usedKeys = await extractTextCalls(componentPath, context)
    
    // Find missing keys
    const missingInSource: MissingKey[] = []
    const missingInTarget: MissingKey[] = []
    
    let usageIndex = 0
    for (const [key, usage] of usedKeys.entries()) {
      await abortCheckpoint(context, usageIndex++)
      // Skip Joomla core keys (J* prefix)
      if (key.startsWith("J") && !key.startsWith(componentPrefix)) continue
      
      if (!sourceKeys.has(key)) {
        missingInSource.push({
          key,
          file: usage.files[0],
          line: usage.lines[0],
          context: `Used in ${usage.files.length} file(s)`
        })
      }
      
      if (!targetKeys.has(key) && sourceKeys.has(key)) {
        missingInTarget.push({
          key,
          file: usage.files[0],
          line: usage.lines[0],
          context: `Source value: "${sourceKeys.get(key)?.substring(0, 50)}..."`
        })
      }
    }
    
    // Find orphan keys (in INI but not used)
    const orphanSource = findOrphanKeys(sourceKeys, usedKeys, componentPrefix, context)
    const orphanTarget = findOrphanKeys(targetKeys, usedKeys, componentPrefix, context)
    
    // Build summary
    const issues: string[] = []
    if (missingInSource.length > 0) {
      issues.push(`${missingInSource.length} keys used in PHP but missing in en-GB INI`)
    }
    if (missingInTarget.length > 0) {
      issues.push(`${missingInTarget.length} keys missing translation in ${targetLang}`)
    }
    if (orphanSource.length > 0) {
      issues.push(`${orphanSource.length} orphan keys in en-GB (defined but not used)`)
    }
    
    const result: VerifyResult = {
      success: missingInSource.length === 0 && missingInTarget.length === 0,
      phpFiles: new Set([...usedKeys.values()].flatMap(u => u.files)).size,
      totalCalls: usedKeys.size,
      uniqueKeys: usedKeys.size,
      missingInSource,
      missingInTarget: missingInTarget.slice(0, 50), // Limit output
      orphanKeysSource: orphanSource.slice(0, 20).map(k => ({ key: k, iniFile: sourceIniPath })),
      orphanKeysTarget: orphanTarget.slice(0, 20).map(k => ({ key: k, iniFile: targetIniPath })),
      summary: issues.length === 0 
        ? `OK: All ${usedKeys.size} keys verified in both INI files`
        : `ISSUES: ${issues.join("; ")}`
    }
    
    return JSON.stringify(result, null, 2)
  }
})
