import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs"
import { dirname, basename, join } from "path"
import { execSync } from "child_process"
import { tmpdir } from "os"

interface ConversionResult {
  success: boolean
  filePath: string
  line: number
  originalCode: string
  newCode: string
  syntaxCheck: {
    valid: boolean
    errors: string[]
  }
  attemptedFix?: {
    tried: boolean
    newCode: string
    valid: boolean
  }
  keyToAdd: {
    key: string
    value: string
  }
  backup?: string
  rollback?: boolean
  flaggedForReview?: boolean
  message?: string
}

// Backup directory
const BACKUP_DIR = join(tmpdir(), "opencode-i18n-backups")

function createBackup(filePath: string, line: number): string {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true })
  }
  
  const timestamp = Date.now()
  const backupName = `${basename(filePath)}.${line}.${timestamp}.bak`
  const backupPath = `${BACKUP_DIR}/${backupName}`
  
  copyFileSync(filePath, backupPath)
  return backupPath
}

function checkPhpSyntax(filePath: string): { valid: boolean; errors: string[] } {
  try {
    execSync(`php -l "${filePath}" 2>&1`, { encoding: "utf-8" })
    return { valid: true, errors: [] }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const output = err.stdout || err.stderr || err.message || "Unknown error"
    const errors = output.split("\n").filter((line: string) => line.includes("error") || line.includes("Parse"))
    return { valid: false, errors }
  }
}

function escapeForPhp(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
}

function escapeForJs(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
}

// Different conversion strategies based on context
function convertHtmlLabel(line: string, text: string, key: string): string {
  // Pattern: >Text< inside HTML tag
  const pattern = new RegExp(`>\\s*${escapeRegex(text)}\\s*<`, "g")
  return line.replace(pattern, `><?php echo Text::_('${key}'); ?><`)
}

function convertPlaceholder(line: string, text: string, key: string): string {
  const pattern = new RegExp(`placeholder\\s*=\\s*["']${escapeRegex(text)}["']`, "gi")
  return line.replace(pattern, `placeholder="<?php echo Text::_('${key}'); ?>"`)
}

function convertTitle(line: string, text: string, key: string): string {
  const pattern = new RegExp(`title\\s*=\\s*["']${escapeRegex(text)}["']`, "gi")
  return line.replace(pattern, `title="<?php echo Text::_('${key}'); ?>"`)
}

function convertJsAlert(line: string, text: string, key: string): string {
  const pattern = new RegExp(`alert\\s*\\(\\s*["']${escapeRegex(text)}["']\\s*\\)`, "gi")
  return line.replace(pattern, `alert(Joomla.JText._('${key}'))`)
}

function convertJsConfirm(line: string, text: string, key: string): string {
  const pattern = new RegExp(`confirm\\s*\\(\\s*["']${escapeRegex(text)}["']\\s*\\)`, "gi")
  return line.replace(pattern, `confirm(Joomla.JText._('${key}'))`)
}

function convertAddNotification(line: string, text: string, key: string): string {
  // Pattern: addNotification(['Title', 'type', 'Message'])
  // We need to replace just the message part
  const escapedText = escapeRegex(text)
  const pattern = new RegExp(`(['"])${escapedText}\\1`, "g")
  return line.replace(pattern, `Joomla.JText._('${key}')`)
}

function convertJsPhpEmbed(line: string, text: string, key: string): string {
  // Convert hardcoded string in JavaScript to use TextHelper::js()
  // TextHelper::js() returns a JSON-encoded string WITH quotes, so we replace the quoted string entirely
  //
  // BEFORE: this.$store.dispatch('addNotification', ['Error', 'error', 'Something went wrong']);
  // AFTER:  this.$store.dispatch('addNotification', ['Error', 'error', <?php echo TextHelper::js('COM_AUCTION_JS_ERROR'); ?>]);
  //
  // BEFORE: alert('Are you sure?')  
  // AFTER:  alert(<?php echo TextHelper::js('COM_AUCTION_JS_CONFIRM'); ?>)
  //
  // The key insight: TextHelper::js() returns "translated text" (with double quotes and proper JSON escaping)
  // So we replace 'text' or "text" with <?php echo TextHelper::js('KEY'); ?> (no surrounding quotes needed)
  
  const escapedText = escapeRegex(text)
  
  // Try single-quoted string first
  const singlePattern = new RegExp(`'${escapedText}'`, "g")
  if (singlePattern.test(line)) {
    return line.replace(singlePattern, `<?php echo TextHelper::js('${key}'); ?>`)
  }
  
  // Try double-quoted string
  const doublePattern = new RegExp(`"${escapedText}"`, "g")
  if (doublePattern.test(line)) {
    return line.replace(doublePattern, `<?php echo TextHelper::js('${key}'); ?>`)
  }
  
  // Fallback - just try to find and replace the text with quotes around it
  return line.replace(new RegExp(`(['"])${escapedText}\\1`, "g"), `<?php echo TextHelper::js('${key}'); ?>`)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Try alternative conversion if first attempt fails syntax check
function tryAlternativeConversion(line: string, text: string, key: string, type: string): string | null {
  switch (type) {
    case "label":
    case "heading":
    case "button":
    case "message":
      // Try with echo shorthand
      const pattern1 = new RegExp(`>\\s*${escapeRegex(text)}\\s*<`, "g")
      const alt1 = line.replace(pattern1, `><?= Text::_('${key}') ?><`)
      if (alt1 !== line) return alt1
      
      // Try wrapping entire content
      return null
      
    case "placeholder":
      // Try with single quotes
      const pattern2 = new RegExp(`placeholder\\s*=\\s*["']${escapeRegex(text)}["']`, "gi")
      return line.replace(pattern2, `placeholder='<?php echo Text::_("${key}"); ?>'`)
      
    default:
      return null
  }
}

export default tool({
  description: "Convert a hardcoded string to an i18n call. Creates backup, applies conversion, validates PHP syntax, and can rollback on failure.",
  args: {
    filePath: tool.schema.string().describe("Path to the file to modify"),
    line: tool.schema.number().describe("Line number containing the hardcoded string (1-based)"),
    originalText: tool.schema.string().describe("The exact hardcoded text to replace"),
    keyName: tool.schema.string().describe("The i18n key to use (e.g., COM_LOTS_FIELD_NAME_LABEL)"),
    type: tool.schema.enum(["label", "placeholder", "tooltip", "heading", "button", "message", "js_alert", "js_confirm", "js_string", "js_php_embed", "option", "table_header"]).describe("Type of string being converted. Use 'js_php_embed' for strings in JavaScript that need PHP output with proper escaping."),
    framework: tool.schema.enum(["joomla", "laravel", "symfony", "vue"]).default("joomla").describe("Framework for conversion pattern"),
    dryRun: tool.schema.boolean().default(false).describe("If true, show what would change without modifying file")
  },
  async execute(args) {
    const { filePath, line, originalText, keyName, type, framework = "joomla", dryRun = false } = args

    if (!existsSync(filePath)) {
      return JSON.stringify({
        success: false,
        error: `File not found: ${filePath}`
      }, null, 2)
    }

    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    if (line < 1 || line > lines.length) {
      return JSON.stringify({
        success: false,
        error: `Invalid line number: ${line}. File has ${lines.length} lines.`
      }, null, 2)
    }

    const originalLine = lines[line - 1]
    
    // Check if the text exists on this line
    if (!originalLine.includes(originalText)) {
      return JSON.stringify({
        success: false,
        error: `Text "${originalText}" not found on line ${line}`,
        actualLine: originalLine.substring(0, 200)
      }, null, 2)
    }

    // Apply conversion based on type
    let newLine: string
    switch (type) {
      case "label":
      case "heading":
      case "button":
      case "message":
      case "option":
      case "table_header":
        newLine = convertHtmlLabel(originalLine, originalText, keyName)
        break
      case "placeholder":
        newLine = convertPlaceholder(originalLine, originalText, keyName)
        break
      case "tooltip":
        newLine = convertTitle(originalLine, originalText, keyName)
        break
      case "js_alert":
        newLine = convertJsAlert(originalLine, originalText, keyName)
        break
      case "js_confirm":
        newLine = convertJsConfirm(originalLine, originalText, keyName)
        break
      case "js_string":
        newLine = convertAddNotification(originalLine, originalText, keyName)
        break
      case "js_php_embed":
        // Use TextHelper::js() for safe JavaScript embedding
        // This prevents apostrophes in translations from breaking JS syntax
        newLine = convertJsPhpEmbed(originalLine, originalText, keyName)
        break
      default:
        newLine = convertHtmlLabel(originalLine, originalText, keyName)
    }

    // Check if conversion actually changed anything
    if (newLine === originalLine) {
      return JSON.stringify({
        success: false,
        error: "Conversion pattern did not match. Text may already be converted or has unexpected format.",
        originalCode: originalLine,
        text: originalText,
        type,
        flaggedForReview: true
      }, null, 2)
    }

    const result: ConversionResult = {
      success: true,
      filePath,
      line,
      originalCode: originalLine,
      newCode: newLine,
      syntaxCheck: { valid: true, errors: [] },
      keyToAdd: {
        key: keyName,
        value: originalText
      }
    }

    // If dry run, return without modifying
    if (dryRun) {
      return JSON.stringify({
        ...result,
        dryRun: true,
        message: "Dry run - no changes made"
      }, null, 2)
    }

    // Create backup
    const backupPath = createBackup(filePath, line)
    result.backup = backupPath

    // Apply change
    lines[line - 1] = newLine
    const newContent = lines.join("\n")
    writeFileSync(filePath, newContent)

    // Check PHP syntax (only for PHP files)
    if (filePath.endsWith(".php")) {
      const syntaxResult = checkPhpSyntax(filePath)
      result.syntaxCheck = syntaxResult

      if (!syntaxResult.valid) {
        // Try alternative conversion
        const alternative = tryAlternativeConversion(originalLine, originalText, keyName, type)
        
        if (alternative && alternative !== originalLine) {
          // Try the alternative
          lines[line - 1] = alternative
          writeFileSync(filePath, lines.join("\n"))
          
          const altSyntaxResult = checkPhpSyntax(filePath)
          
          result.attemptedFix = {
            tried: true,
            newCode: alternative,
            valid: altSyntaxResult.valid
          }
          
          if (altSyntaxResult.valid) {
            result.newCode = alternative
            result.syntaxCheck = altSyntaxResult
            result.message = "Initial conversion failed syntax check. Alternative conversion applied successfully."
            return JSON.stringify(result, null, 2)
          }
        }

        // Rollback to original
        copyFileSync(backupPath, filePath)
        result.rollback = true
        result.flaggedForReview = true
        result.success = false
        result.message = "Conversion failed syntax check. Original code restored. Manual review required."
        
        return JSON.stringify(result, null, 2)
      }
    }

    result.message = "Conversion successful"
    return JSON.stringify(result, null, 2)
  }
})
