import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"

interface ExtractedString {
  key: string | null
  value: string
  line: number
  type: "translated" | "hardcoded"
  pattern: string
  context: string
  hasPlaceholders: boolean
  placeholders: string[]
}

// Patterns for different frameworks
const patterns = {
  joomla: {
    translated: [
      // PHP patterns - Joomla 4+
      { regex: /Text::_\(\s*['"]([^'"]+)['"]\s*\)/g, name: "Text::_" },
      { regex: /Text::sprintf\(\s*['"]([^'"]+)['"]/g, name: "Text::sprintf" },
      { regex: /Text::plural\(\s*['"]([^'"]+)['"]/g, name: "Text::plural" },
      // Legacy Joomla 3
      { regex: /JText::_\(\s*['"]([^'"]+)['"]\s*\)/g, name: "JText::_" },
      { regex: /JText::sprintf\(\s*['"]([^'"]+)['"]/g, name: "JText::sprintf" },
      // JavaScript patterns
      { regex: /Joomla\.JText\._\(\s*['"]([^'"]+)['"]\s*\)/g, name: "Joomla.JText._" },
      { regex: /Joomla\.Text\._\(\s*['"]([^'"]+)['"]\s*\)/g, name: "Joomla.Text._" }
    ]
  },
  laravel: {
    translated: [
      { regex: /__\(\s*['"]([^'"]+)['"]/g, name: "__" },
      { regex: /trans\(\s*['"]([^'"]+)['"]/g, name: "trans" },
      { regex: /@lang\(\s*['"]([^'"]+)['"]/g, name: "@lang" }
    ]
  },
  symfony: {
    translated: [
      { regex: /->trans\(\s*['"]([^'"]+)['"]/g, name: "trans" },
      { regex: /\|trans/g, name: "|trans" }
    ]
  },
  vue: {
    translated: [
      { regex: /\$t\(\s*['"]([^'"]+)['"]\s*\)/g, name: "$t" },
      { regex: /\{\{\s*\$t\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, name: "{{ $t }}" },
      { regex: /v-t="'([^']+)'"/g, name: "v-t" }
    ]
  }
}

// Placeholder patterns
const placeholderPatterns = [
  /%s/g,           // String
  /%d/g,           // Integer
  /%f/g,           // Float
  /%\d+\$s/g,      // Positional string (%1$s, %2$s)
  /%\d+\$d/g,      // Positional integer
  /%%/g,           // Escaped percent
  /\{[^}]+\}/g     // Named placeholders {name}
]

function extractPlaceholders(value: string): string[] {
  const found: string[] = []
  for (const pattern of placeholderPatterns) {
    const matches = value.match(pattern)
    if (matches) {
      found.push(...matches)
    }
  }
  return [...new Set(found)]
}

function findContext(lines: string[], lineNumber: number): string {
  // Look for function/method context
  const searchStart = Math.max(0, lineNumber - 50)
  
  for (let i = lineNumber - 1; i >= searchStart; i--) {
    const line = lines[i]
    
    // PHP function
    const phpFunc = line.match(/function\s+(\w+)\s*\(/i)
    if (phpFunc) return `${phpFunc[1]}()`
    
    // PHP method in class
    const phpMethod = line.match(/(?:public|private|protected)\s+function\s+(\w+)/i)
    if (phpMethod) return `${phpMethod[1]}()`
    
    // JavaScript function
    const jsFunc = line.match(/(?:function\s+)?(\w+)\s*[:=]\s*function\s*\(/i)
    if (jsFunc) return `${jsFunc[1]}()`
    
    // Vue method
    const vueMethod = line.match(/^\s*(\w+)\s*\(\s*\)\s*\{/i)
    if (vueMethod) return `${vueMethod[1]}()`
    
    // Arrow function
    const arrowFunc = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/i)
    if (arrowFunc) return `${arrowFunc[1]}()`
  }
  
  return "unknown"
}

export default tool({
  description: "Extract i18n strings from code files. Finds both already-translated strings (using Text::_() etc) and identifies the translation patterns used.",
  args: {
    filePath: tool.schema.string().describe("Path to the file to extract strings from"),
    startLine: tool.schema.number().optional().describe("Start line for chunk processing (1-based)"),
    endLine: tool.schema.number().optional().describe("End line for chunk processing"),
    framework: tool.schema.enum(["joomla", "laravel", "symfony", "vue"]).default("joomla").describe("Framework to use for pattern matching")
  },
  async execute(args) {
    const { filePath, startLine, endLine, framework = "joomla" } = args

    // Validate file exists
    if (!existsSync(filePath)) {
      return JSON.stringify({
        success: false,
        error: `File not found: ${filePath}`
      }, null, 2)
    }

    // Read file content
    const content = readFileSync(filePath, "utf-8")
    const allLines = content.split("\n")

    // Determine which lines to process
    const start = startLine ? startLine - 1 : 0
    const end = endLine ? endLine : allLines.length
    const linesToProcess = allLines.slice(start, end)
    const lineOffset = start

    const extracted: ExtractedString[] = []
    const frameworkPatterns = patterns[framework as keyof typeof patterns]

    if (!frameworkPatterns) {
      return JSON.stringify({
        success: false,
        error: `Unknown framework: ${framework}. Supported: joomla, laravel, symfony, vue`
      }, null, 2)
    }

    // Process each line
    for (let i = 0; i < linesToProcess.length; i++) {
      const line = linesToProcess[i]
      const actualLineNumber = lineOffset + i + 1

      // Check translated patterns
      for (const pattern of frameworkPatterns.translated) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
        let match

        while ((match = regex.exec(line)) !== null) {
          const key = match[1]
          const placeholders = extractPlaceholders(key)

          // Check if we already have this key (avoid duplicates in same chunk)
          const exists = extracted.find(e => e.key === key && e.line === actualLineNumber)
          if (!exists) {
            extracted.push({
              key,
              value: key, // For translated strings, key is stored, actual value is in INI
              line: actualLineNumber,
              type: "translated",
              pattern: pattern.name,
              context: findContext(allLines, actualLineNumber),
              hasPlaceholders: placeholders.length > 0,
              placeholders
            })
          }
        }
      }
    }

    // Sort by line number
    extracted.sort((a, b) => a.line - b.line)

    // Calculate summary
    const translated = extracted.filter(e => e.type === "translated")
    const withPlaceholders = extracted.filter(e => e.hasPlaceholders)

    // Get unique keys
    const uniqueKeys = [...new Set(extracted.map(e => e.key).filter(Boolean))]

    return JSON.stringify({
      success: true,
      filePath,
      framework,
      range: {
        start: startLine ?? 1,
        end: endLine ?? allLines.length,
        linesProcessed: linesToProcess.length
      },
      strings: extracted,
      summary: {
        total: extracted.length,
        translated: translated.length,
        hardcoded: 0, // Use i18n-hardcode-finder for this
        withPlaceholders: withPlaceholders.length,
        uniqueKeys: uniqueKeys.length
      },
      uniqueKeys
    }, null, 2)
  }
})
