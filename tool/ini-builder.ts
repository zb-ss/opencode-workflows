import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"

interface IniString {
  key: string
  value: string
  section?: string
  comment?: string
}

interface ValidationError {
  line: number
  error: string
  key?: string
}

interface ValidationWarning {
  line: number
  warning: string
  key?: string
}

// Section categories for organizing INI files
const sectionOrder = [
  "UI Labels & Page Titles",
  "Form Fields",
  "Action Buttons",
  "Success Messages",
  "Error Messages",
  "Validation Messages",
  "JavaScript Messages",
  "Empty States",
  "Configuration Options",
  "Other"
]

function categorizeKey(key: string): string {
  const keyUpper = key.toUpperCase()
  
  if (keyUpper.includes("_TITLE") || keyUpper.includes("_HEADING") || keyUpper.includes("_VIEW_NAME")) {
    return "UI Labels & Page Titles"
  }
  if (keyUpper.includes("_FIELD_") || keyUpper.includes("_LABEL") || keyUpper.includes("_PLACEHOLDER") || keyUpper.includes("_TOOLTIP")) {
    return "Form Fields"
  }
  if (keyUpper.includes("_BTN_") || keyUpper.includes("_ACTION_") || keyUpper.includes("_BUTTON")) {
    return "Action Buttons"
  }
  if (keyUpper.includes("_SUCCESS") || keyUpper.includes("_SAVED") || keyUpper.includes("_CREATED") || keyUpper.includes("_UPDATED")) {
    return "Success Messages"
  }
  if (keyUpper.includes("_ERROR") || keyUpper.includes("_FAILED") || keyUpper.includes("_INVALID")) {
    return "Error Messages"
  }
  if (keyUpper.includes("_VALIDATION") || keyUpper.includes("_REQUIRED") || keyUpper.includes("_MUST_BE")) {
    return "Validation Messages"
  }
  if (keyUpper.includes("_JS_") || keyUpper.includes("_ALERT") || keyUpper.includes("_CONFIRM")) {
    return "JavaScript Messages"
  }
  if (keyUpper.includes("_EMPTY") || keyUpper.includes("_NO_") || keyUpper.includes("_NONE")) {
    return "Empty States"
  }
  if (keyUpper.includes("_CONFIG") || keyUpper.includes("_OPTION") || keyUpper.includes("_SETTING")) {
    return "Configuration Options"
  }
  
  return "Other"
}

function escapeIniValue(value: string): string {
  // INI values should be enclosed in double quotes
  // Escape internal double quotes with backslash
  return value
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/"/g, '\\"')     // Escape double quotes
}

function parseIniFile(content: string): { strings: Map<string, string>; sections: Map<string, string[]> } {
  const strings = new Map<string, string>()
  const sections = new Map<string, string[]>()
  let currentSection = "Other"
  
  const lines = content.split("\n")
  
  for (const line of lines) {
    const trimmed = line.trim()
    
    // Skip empty lines
    if (!trimmed) continue
    
    // Check for section comment
    if (trimmed.startsWith(";") && trimmed.includes("===")) {
      const sectionMatch = trimmed.match(/;\s*=+\s*\n?;\s*([^;=]+)\s*\n?;\s*=+/s)
      if (!sectionMatch) {
        // Try single line section marker
        const nextLine = lines[lines.indexOf(line) + 1]
        if (nextLine && nextLine.trim().startsWith(";")) {
          const possibleSection = nextLine.replace(/^;\s*/, "").trim()
          if (sectionOrder.includes(possibleSection)) {
            currentSection = possibleSection
          }
        }
      }
      continue
    }
    
    // Skip regular comments
    if (trimmed.startsWith(";")) continue
    
    // Parse key=value
    const match = trimmed.match(/^([A-Z][A-Z0-9_]+)\s*=\s*"(.*)"\s*$/)
    if (match) {
      const key = match[1]
      const value = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      
      strings.set(key, value)
      
      if (!sections.has(currentSection)) {
        sections.set(currentSection, [])
      }
      sections.get(currentSection)!.push(key)
    }
  }
  
  return { strings, sections }
}

function generateIniContent(strings: IniString[], sort: boolean = true): string {
  // Group by section
  const grouped = new Map<string, IniString[]>()
  
  for (const str of strings) {
    const section = str.section || categorizeKey(str.key)
    if (!grouped.has(section)) {
      grouped.set(section, [])
    }
    grouped.get(section)!.push(str)
  }
  
  // Build content
  const lines: string[] = [
    "; Joomla! Project",
    "; Copyright (C) " + new Date().getFullYear() + " Open Source Matters. All rights reserved.",
    "; License GNU General Public License version 2 or later",
    "; Note: All ini files need to be saved as UTF-8",
    ""
  ]
  
  // Output sections in order
  for (const sectionName of sectionOrder) {
    const sectionStrings = grouped.get(sectionName)
    if (!sectionStrings || sectionStrings.length === 0) continue
    
    // Sort within section if requested
    if (sort) {
      sectionStrings.sort((a, b) => a.key.localeCompare(b.key))
    }
    
    lines.push("; ============================================")
    lines.push(`; ${sectionName}`)
    lines.push("; ============================================")
    
    for (const str of sectionStrings) {
      if (str.comment) {
        lines.push(`; ${str.comment}`)
      }
      lines.push(`${str.key}="${escapeIniValue(str.value)}"`)
    }
    
    lines.push("")
  }
  
  return lines.join("\n")
}

function validateIniContent(content: string): { valid: boolean; errors: ValidationError[]; warnings: ValidationWarning[] } {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const seenKeys = new Set<string>()
  
  const lines = content.split("\n")
  
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const line = lines[i]
    const trimmed = line.trim()
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(";")) continue
    
    // Check format
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"(.*)"\s*$/)
    
    if (!match) {
      // Check for common errors
      if (trimmed.includes("=") && !trimmed.includes('"')) {
        errors.push({ line: lineNum, error: "Missing quotes around value", key: trimmed.split("=")[0] })
      } else if (trimmed.match(/^[A-Z]/)) {
        errors.push({ line: lineNum, error: "Invalid INI format. Expected: KEY=\"value\"" })
      }
      continue
    }
    
    const key = match[1]
    const value = match[2]
    
    // Check for duplicate keys
    if (seenKeys.has(key)) {
      errors.push({ line: lineNum, error: "Duplicate key", key })
    }
    seenKeys.add(key)
    
    // Check for empty values
    if (!value.trim()) {
      warnings.push({ line: lineNum, warning: "Empty value", key })
    }
    
    // Check for unescaped quotes
    const quoteCount = (value.match(/(?<!\\)"/g) || []).length
    if (quoteCount > 0) {
      errors.push({ line: lineNum, error: "Unescaped quote in value", key })
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

function compareIniFiles(sourceContent: string, targetContent: string): {
  missing: string[]
  extra: string[]
  placeholderMismatch: Array<{ key: string; source: string; target: string; issue: string }>
} {
  const sourceData = parseIniFile(sourceContent)
  const targetData = parseIniFile(targetContent)
  
  const missing: string[] = []
  const extra: string[] = []
  const placeholderMismatch: Array<{ key: string; source: string; target: string; issue: string }> = []
  
  // Find missing keys (in source but not in target)
  for (const key of sourceData.strings.keys()) {
    if (!targetData.strings.has(key)) {
      missing.push(key)
    }
  }
  
  // Find extra keys (in target but not in source)
  for (const key of targetData.strings.keys()) {
    if (!sourceData.strings.has(key)) {
      extra.push(key)
    }
  }
  
  // Check placeholder consistency
  const placeholderPattern = /%(?:\d+\$)?[sdfu]|%%|\{[^}]+\}/g
  
  for (const [key, sourceValue] of sourceData.strings) {
    const targetValue = targetData.strings.get(key)
    if (!targetValue) continue
    
    const sourcePlaceholders = (sourceValue.match(placeholderPattern) || []).sort()
    const targetPlaceholders = (targetValue.match(placeholderPattern) || []).sort()
    
    if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(targetPlaceholders)) {
      placeholderMismatch.push({
        key,
        source: sourceValue,
        target: targetValue,
        issue: `Source has [${sourcePlaceholders.join(", ")}], target has [${targetPlaceholders.join(", ")}]`
      })
    }
  }
  
  return { missing, extra, placeholderMismatch }
}

export default tool({
  description: "Build, validate, and compare Joomla INI language files. Supports creating new files, adding strings, validating format, and comparing source/target for translation completeness.",
  args: {
    action: tool.schema.enum(["create", "add", "validate", "diff"]).describe("Action: create (new file), add (append strings), validate (check format), diff (compare files)"),
    filePath: tool.schema.string().optional().describe("Path to INI file (required for add, validate)"),
    strings: tool.schema.string().optional().describe("JSON array of strings to add: [{key, value, section?, comment?}]"),
    sourceFile: tool.schema.string().optional().describe("Source language file for diff comparison"),
    targetFile: tool.schema.string().optional().describe("Target language file for diff comparison"),
    sort: tool.schema.boolean().default(true).describe("Sort keys alphabetically within sections")
  },
  async execute(args) {
    const { action, filePath, sourceFile, targetFile, sort = true } = args

    // Parse strings if provided
    let stringsArray: IniString[] = []
    if (args.strings) {
      try {
        stringsArray = JSON.parse(args.strings)
      } catch {
        return JSON.stringify({
          success: false,
          error: "Invalid JSON in strings parameter"
        }, null, 2)
      }
    }

    switch (action) {
      case "create": {
        if (stringsArray.length === 0) {
          return JSON.stringify({
            success: false,
            error: "strings parameter required for create action"
          }, null, 2)
        }

        const content = generateIniContent(stringsArray, sort)
        
        // If filePath provided, write to file
        if (filePath) {
          const dir = dirname(filePath)
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
          }
          writeFileSync(filePath, content, "utf-8")
          
          return JSON.stringify({
            success: true,
            action: "create",
            filePath,
            stats: {
              totalKeys: stringsArray.length,
              sections: [...new Set(stringsArray.map(s => s.section || categorizeKey(s.key)))].length
            }
          }, null, 2)
        }
        
        // Return content without writing
        return JSON.stringify({
          success: true,
          action: "create",
          content,
          stats: {
            totalKeys: stringsArray.length
          }
        }, null, 2)
      }

      case "add": {
        if (!filePath) {
          return JSON.stringify({
            success: false,
            error: "filePath required for add action"
          }, null, 2)
        }
        
        if (stringsArray.length === 0) {
          return JSON.stringify({
            success: false,
            error: "strings parameter required for add action"
          }, null, 2)
        }

        // Read existing file or start fresh
        let existingStrings: IniString[] = []
        const existingKeys = new Set<string>()
        
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8")
          const parsed = parseIniFile(content)
          
          for (const [key, value] of parsed.strings) {
            existingStrings.push({ key, value })
            existingKeys.add(key)
          }
        }
        
        // Add new strings (skip duplicates)
        let added = 0
        let skipped = 0
        
        for (const str of stringsArray) {
          if (existingKeys.has(str.key)) {
            skipped++
          } else {
            existingStrings.push(str)
            existingKeys.add(str.key)
            added++
          }
        }
        
        // Generate new content
        const newContent = generateIniContent(existingStrings, sort)
        
        // Ensure directory exists
        const dir = dirname(filePath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        
        writeFileSync(filePath, newContent, "utf-8")
        
        return JSON.stringify({
          success: true,
          action: "add",
          filePath,
          added,
          skipped,
          stats: {
            totalKeys: existingStrings.length
          }
        }, null, 2)
      }

      case "validate": {
        if (!filePath) {
          return JSON.stringify({
            success: false,
            error: "filePath required for validate action"
          }, null, 2)
        }
        
        if (!existsSync(filePath)) {
          return JSON.stringify({
            success: false,
            error: `File not found: ${filePath}`
          }, null, 2)
        }

        const content = readFileSync(filePath, "utf-8")
        const result = validateIniContent(content)
        const parsed = parseIniFile(content)
        
        return JSON.stringify({
          success: true,
          action: "validate",
          filePath,
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          stats: {
            totalKeys: parsed.strings.size,
            validKeys: parsed.strings.size - result.errors.filter(e => e.key).length,
            invalidKeys: result.errors.filter(e => e.key).length
          }
        }, null, 2)
      }

      case "diff": {
        if (!sourceFile || !targetFile) {
          return JSON.stringify({
            success: false,
            error: "sourceFile and targetFile required for diff action"
          }, null, 2)
        }
        
        if (!existsSync(sourceFile)) {
          return JSON.stringify({
            success: false,
            error: `Source file not found: ${sourceFile}`
          }, null, 2)
        }
        
        if (!existsSync(targetFile)) {
          return JSON.stringify({
            success: false,
            error: `Target file not found: ${targetFile}`
          }, null, 2)
        }

        const sourceContent = readFileSync(sourceFile, "utf-8")
        const targetContent = readFileSync(targetFile, "utf-8")
        
        const comparison = compareIniFiles(sourceContent, targetContent)
        const sourceData = parseIniFile(sourceContent)
        const targetData = parseIniFile(targetContent)
        
        return JSON.stringify({
          success: true,
          action: "diff",
          sourceFile,
          targetFile,
          missing: comparison.missing,
          extra: comparison.extra,
          placeholderMismatch: comparison.placeholderMismatch,
          stats: {
            sourceKeys: sourceData.strings.size,
            targetKeys: targetData.strings.size,
            missingCount: comparison.missing.length,
            extraCount: comparison.extra.length,
            placeholderIssues: comparison.placeholderMismatch.length,
            translationComplete: comparison.missing.length === 0 && comparison.placeholderMismatch.length === 0
          }
        }, null, 2)
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`
        }, null, 2)
    }
  }
})
