/**
 * OpenCode Translation Workflow Plugin
 * 
 * Provides custom tools and commands for Joomla component translation.
 * Orchestrates view-by-view processing with automatic review and retry.
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "fs"
import { join, basename, dirname } from "path"
import { homedir } from "os"

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

interface WorkflowState {
  id: string
  componentPath: string
  componentName: string
  targetLanguage: string
  sourceLanguage: string
  sourceIniPath: string
  targetIniPath: string
  created: string
  updated: string
  status: "scanning" | "processing" | "complete" | "error"
  currentViewIndex: number
  views: ViewInfo[]
  totalStringsConverted: number
  totalErrors: number
}

// Helper functions
function getRepoRoot(): string {
  // 1. Check environment variable
  if (process.env.OPENCODE_WORKFLOWS_REPO) {
    return process.env.OPENCODE_WORKFLOWS_REPO
  }

  // 2. Resolve via symlink: this file's real location → up 2 dirs = repo root
  try {
    const thisFile = new URL(import.meta.url).pathname
    const realPath = realpathSync(thisFile)
    const candidate = dirname(dirname(realPath))
    if (existsSync(join(candidate, "install.mjs"))) {
      return candidate
    }
  } catch {
    // fall through
  }

  // 3. Try reading env file from config dir
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
  const envFile = join(configDir, "opencode-workflows.env")
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8")
    const match = content.match(/^OPENCODE_WORKFLOWS_REPO=(.+)$/m)
    if (match) return match[1].trim()
  }

  // 4. Fallback: assume CWD is the repo (for development)
  return process.cwd()
}

function getWorkflowDir(): string {
  return join(getRepoRoot(), "workflows", "active")
}

function getWorkflowStatePath(workflowId: string): string {
  const baseDir = join(getWorkflowDir(), workflowId)
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
  return join(baseDir, "workflow-state.json")
}

function loadWorkflowState(workflowId: string): WorkflowState | null {
  const statePath = getWorkflowStatePath(workflowId)
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8"))
  }
  return null
}

function saveWorkflowState(state: WorkflowState): void {
  const statePath = getWorkflowStatePath(state.id)
  state.updated = new Date().toISOString()
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function findActiveWorkflow(): string | null {
  const activeDir = getWorkflowDir()
  if (!existsSync(activeDir)) return null
  
  const dirs = readdirSync(activeDir)
    .filter(d => d.includes("-translate-"))
    .sort()
    .reverse()
  
  return dirs.length > 0 ? dirs[0] : null
}

function generateWorkflowId(componentName: string): string {
  const date = new Date().toISOString().split("T")[0].replace(/-/g, "")
  return `${date}-translate-${componentName}`
}

function getComponentName(componentPath: string): string {
  const match = componentPath.match(/com_(\w+)/i)
  return match ? match[1] : basename(componentPath).replace("com_", "")
}

function findViewFiles(componentPath: string): ViewInfo[] {
  const views: ViewInfo[] = []
  
  function scanDir(dir: string, baseDir: string) {
    if (!existsSync(dir)) return
    
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          scanDir(fullPath, baseDir)
        } else if (entry.name.endsWith(".php")) {
          const relativePath = fullPath.replace(baseDir + "/", "")
          // Skip backup files
          const isBackup = /\.(bak|backup|old)\.php$/i.test(entry.name) ||
                          /Old\.php$/i.test(entry.name) ||
                          /_backup\.php$/i.test(entry.name) ||
                          /\.bak$/i.test(entry.name)
          
          if (!isBackup && (relativePath.includes("tmpl/") || relativePath.includes("layouts/"))) {
            try {
              const content = readFileSync(fullPath, "utf-8")
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
                stringsConverted: 0
              })
            } catch (e) {
              // Skip unreadable files
            }
          }
        }
      }
    } catch (e) {
      // Skip unreadable directories
    }
  }
  
  scanDir(componentPath, componentPath)
  views.sort((a, b) => b.lines - a.lines) // Largest first
  
  return views
}

function findLanguageFile(componentPath: string, componentName: string, lang: string): string {
  const possiblePaths = [
    join(dirname(componentPath), "..", "language", lang, `${lang}.com_${componentName}.ini`),
    join(componentPath, "..", "..", "language", lang, `${lang}.com_${componentName}.ini`),
  ]
  
  for (const p of possiblePaths) {
    if (existsSync(p)) return p
  }
  
  return possiblePaths[0] // Default path
}

export const TranslationWorkflowPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      // Initialize a new translation workflow
      workflow_translate_init: tool({
        description: "Initialize a new Joomla translation workflow. Scans component and creates view queue.",
        args: {
          componentPath: tool.schema.string().describe("Absolute path to the Joomla component"),
          targetLanguage: tool.schema.string().describe("Target language code (e.g., fr-CA)"),
          sourceLanguage: tool.schema.string().default("en-GB").describe("Source language code")
        },
        async execute(args) {
          const { componentPath, targetLanguage, sourceLanguage = "en-GB" } = args
          
          if (!existsSync(componentPath)) {
            return JSON.stringify({ success: false, error: `Component not found: ${componentPath}` })
          }
          
          const componentName = getComponentName(componentPath)
          const workflowId = generateWorkflowId(componentName)
          
          // Check for existing workflow
          const existing = loadWorkflowState(workflowId)
          if (existing && existing.status !== "complete") {
            return JSON.stringify({
              success: true,
              resumed: true,
              workflowId,
              message: `Resuming existing workflow`,
              progress: {
                total: existing.views.length,
                done: existing.views.filter(v => v.status === "done").length,
                pending: existing.views.filter(v => v.status === "pending").length
              }
            })
          }
          
          // Scan for views
          const views = findViewFiles(componentPath)
          if (views.length === 0) {
            return JSON.stringify({ success: false, error: "No view files found" })
          }
          
          const state: WorkflowState = {
            id: workflowId,
            componentPath,
            componentName,
            targetLanguage,
            sourceLanguage,
            sourceIniPath: findLanguageFile(componentPath, componentName, sourceLanguage),
            targetIniPath: findLanguageFile(componentPath, componentName, targetLanguage),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            status: "processing",
            currentViewIndex: 0,
            views,
            totalStringsConverted: 0,
            totalErrors: 0
          }
          
          saveWorkflowState(state)
          
          return JSON.stringify({
            success: true,
            workflowId,
            componentName,
            targetLanguage,
            sourceLanguage,
            sourceIniPath: state.sourceIniPath,
            targetIniPath: state.targetIniPath,
            views: views.map(v => ({
              path: v.relativePath,
              lines: v.lines,
              needsChunking: v.needsChunking
            })),
            totalViews: views.length,
            message: `Workflow created. ${views.length} views to process.`
          }, null, 2)
        }
      }),
      
      // Get next view to process
      workflow_translate_next: tool({
        description: "Get the next view to process in the translation workflow.",
        args: {
          workflowId: tool.schema.string().optional().describe("Workflow ID (auto-detects if not provided)")
        },
        async execute(args) {
          const workflowId = args.workflowId || findActiveWorkflow()
          if (!workflowId) {
            return JSON.stringify({ success: false, error: "No active workflow found" })
          }
          
          const state = loadWorkflowState(workflowId)
          if (!state) {
            return JSON.stringify({ success: false, error: `Workflow not found: ${workflowId}` })
          }
          
          // Find next pending or error view
          const nextView = state.views.find(v => v.status === "pending" || v.status === "error")
          
          if (!nextView) {
            // Check if all done
            const allDone = state.views.every(v => v.status === "done")
            if (allDone) {
              state.status = "complete"
              saveWorkflowState(state)
              return JSON.stringify({
                success: true,
                complete: true,
                message: "All views processed!",
                summary: {
                  totalViews: state.views.length,
                  stringsConverted: state.totalStringsConverted,
                  errors: state.totalErrors
                }
              })
            }
            return JSON.stringify({ success: false, error: "No views ready to process" })
          }
          
          // Mark as processing
          nextView.status = "processing"
          nextView.attempts++
          state.currentViewIndex = state.views.indexOf(nextView)
          saveWorkflowState(state)
          
          // Build chunking instructions if needed
          const chunkingInstructions = nextView.needsChunking ? {
            required: true,
            reason: `File has ${nextView.lines} lines (>500), MUST use chunking`,
            steps: [
              `1. file_chunker(filePath="${nextView.path}", chunkSize=150, overlap=20)`,
              `2. For EACH chunk (1 to N): i18n_hardcode_finder(filePath="${nextView.path}", startLine=X, endLine=Y)`,
              `3. Combine all findings, remove duplicates from overlaps`,
              `4. Convert ALL strings found with i18n_convert`,
              `5. DO NOT skip or defer this file - process it completely`
            ]
          } : {
            required: false,
            reason: `File has ${nextView.lines} lines (<500), can process directly`
          }
          
          // Build explicit instruction block to prevent file confusion
          const explicitInstructions = [
            "========================================",
            "MANDATORY TARGET FILE - NO SUBSTITUTIONS",
            "========================================",
            `EXACT PATH: ${nextView.path}`,
            `COMPONENT: com_${state.componentName}`,
            `VIEW: ${nextView.relativePath}`,
            "",
            "YOU MUST:",
            `1. Read EXACTLY: ${nextView.path}`,
            `2. Process ONLY: ${nextView.path}`,
            `3. Convert strings in: ${nextView.path}`,
            "",
            "YOU MUST NOT:",
            "- Process any other component (com_lots, com_auction, etc.)",
            "- Process any other view file",
            "- Search for alternative files",
            "========================================"
          ].join("\n")
          
          return JSON.stringify({
            success: true,
            CRITICAL_TARGET_FILE: nextView.path,
            CRITICAL_COMPONENT: `com_${state.componentName}`,
            explicitInstructions,
            workflowId: state.id,
            componentName: state.componentName,
            targetLanguage: state.targetLanguage,
            sourceLanguage: state.sourceLanguage,
            sourceIniPath: state.sourceIniPath,
            targetIniPath: state.targetIniPath,
            view: {
              path: nextView.path,
              relativePath: nextView.relativePath,
              lines: nextView.lines,
              needsChunking: nextView.needsChunking,
              attempt: nextView.attempts,
              previousErrors: nextView.errors
            },
            chunking: chunkingInstructions,
            progress: {
              current: state.views.indexOf(nextView) + 1,
              total: state.views.length,
              done: state.views.filter(v => v.status === "done").length
            },
            warning: nextView.needsChunking 
              ? "LARGE FILE: You MUST use file_chunker. DO NOT skip or defer this file."
              : null
          }, null, 2)
        }
      }),
      
      // Mark view processing complete
      workflow_translate_view_done: tool({
        description: "Mark a view as processed. Call this after processing a view. IMPORTANT: You MUST actually process the file - skipping or deferring large files is NOT allowed.",
        args: {
          workflowId: tool.schema.string().describe("Workflow ID"),
          viewPath: tool.schema.string().describe("Path to the view that was processed"),
          stringsFound: tool.schema.number().describe("Number of hardcoded strings found"),
          stringsConverted: tool.schema.number().describe("Number of strings successfully converted"),
          errors: tool.schema.string().optional().describe("JSON array of error messages, if any")
        },
        async execute(args) {
          const state = loadWorkflowState(args.workflowId)
          if (!state) {
            return JSON.stringify({ success: false, error: `Workflow not found: ${args.workflowId}` })
          }
          
          const view = state.views.find(v => 
            v.path === args.viewPath || v.relativePath === args.viewPath
          )
          if (!view) {
            return JSON.stringify({ success: false, error: `View not found: ${args.viewPath}` })
          }
          
          // ALWAYS REJECT large files with 0 strings - they must be processed with chunking
          if (view.needsChunking && args.stringsFound === 0) {
            return JSON.stringify({
              success: false,
              error: `REJECTED: Large file (${view.lines} lines) cannot have 0 hardcoded strings. You MUST process this file using chunking. Large Joomla view files always contain hardcoded strings (labels, buttons, headings, etc).`,
              action: "reprocess_with_chunking",
              instructions: {
                step1: `file_chunker(filePath="${view.path}", chunkSize=150, overlap=20)`,
                step2: "For EACH chunk returned, call i18n_hardcode_finder with startLine and endLine parameters",
                step3: "Combine all findings from all chunks",
                step4: "Convert ALL hardcoded strings found with i18n_convert",
                step5: "Call workflow_translate_view_done with actual counts"
              },
              hint: "If after thorough chunked processing you truly find 0 strings, report stringsFound=1 with a note explaining the file was fully processed."
            })
          }
          
          // REJECT large files with suspiciously low string count (< 5 strings per 500 lines)
          const expectedMinStrings = Math.floor(view.lines / 100) // At least 1 per 100 lines
          if (view.needsChunking && args.stringsFound < expectedMinStrings) {
            return JSON.stringify({
              success: false,
              error: `REJECTED: Large file (${view.lines} lines) reported only ${args.stringsFound} strings. Expected at least ${expectedMinStrings}. Did you process ALL chunks?`,
              action: "reprocess_with_chunking",
              instructions: {
                step1: `file_chunker(filePath="${view.path}", chunkSize=150, overlap=20)`,
                step2: "Process EVERY chunk with i18n_hardcode_finder(startLine, endLine)",
                step3: "Do NOT skip any chunks",
                step4: "Report combined total from ALL chunks"
              }
            })
          }
          
          view.stringsFound = args.stringsFound
          view.stringsConverted = args.stringsConverted
          view.lastProcessed = new Date().toISOString()
          
          if (args.errors) {
            try {
              view.errors = JSON.parse(args.errors)
            } catch {
              view.errors = [args.errors]
            }
          }
          
          // Move to review status
          view.status = "review"
          state.totalStringsConverted += args.stringsConverted
          saveWorkflowState(state)
          
          return JSON.stringify({
            success: true,
            message: "View marked for review",
            view: view.relativePath,
            stringsConverted: args.stringsConverted,
            needsReview: true
          })
        }
      }),
      
      // Submit review result
      workflow_translate_review: tool({
        description: "Submit review result for a processed view. Pass or fail.",
        args: {
          workflowId: tool.schema.string().describe("Workflow ID"),
          viewPath: tool.schema.string().describe("Path to the view that was reviewed"),
          passed: tool.schema.boolean().describe("Whether the review passed"),
          issues: tool.schema.string().optional().describe("JSON array of issues found (if failed)")
        },
        async execute(args) {
          const state = loadWorkflowState(args.workflowId)
          if (!state) {
            return JSON.stringify({ success: false, error: `Workflow not found: ${args.workflowId}` })
          }
          
          const view = state.views.find(v => 
            v.path === args.viewPath || v.relativePath === args.viewPath
          )
          if (!view) {
            return JSON.stringify({ success: false, error: `View not found: ${args.viewPath}` })
          }
          
          // REJECT passing review for large files with 0 strings
          if (args.passed && view.needsChunking && view.stringsConverted === 0) {
            return JSON.stringify({
              success: false,
              error: `REJECTED: Cannot pass review for large file (${view.lines} lines) with 0 strings converted. Large files typically have many hardcoded strings. You must process this file using chunking. Use file_chunker to split it, then i18n_hardcode_finder on each chunk.`,
              action: "reprocess_with_chunking"
            })
          }
          
          // Warn about suspiciously low counts
          if (args.passed && view.needsChunking && view.stringsConverted < 20) {
            // Don't reject, but add a warning
            console.warn(`WARNING: Large file (${view.lines} lines) has only ${view.stringsConverted} strings. This may indicate incomplete processing.`)
          }
          
          if (args.passed) {
            view.status = "done"
            view.errors = []
            saveWorkflowState(state)
            
            const remaining = state.views.filter(v => v.status !== "done").length
            const allDone = remaining === 0
            
            if (allDone) {
              state.status = "complete"
              saveWorkflowState(state)
            }
            
            return JSON.stringify({
              success: true,
              passed: true,
              viewComplete: true,
              workflowComplete: allDone,
              remaining,
              message: allDone 
                ? "All views complete! Workflow finished."
                : `View passed. ${remaining} views remaining.`
            })
          } else {
            // Review failed
            if (args.issues) {
              try {
                view.errors = JSON.parse(args.issues)
              } catch {
                view.errors = [args.issues]
              }
            }
            
            state.totalErrors++
            
            // Check max attempts
            if (view.attempts >= 3) {
              view.status = "error" // Keep as error, skip this view
              saveWorkflowState(state)
              return JSON.stringify({
                success: true,
                passed: false,
                maxAttemptsReached: true,
                message: `View failed after 3 attempts. Marked for manual fix.`,
                errors: view.errors
              })
            }
            
            // Will retry
            view.status = "error" // Will be picked up by next call
            saveWorkflowState(state)
            
            return JSON.stringify({
              success: true,
              passed: false,
              willRetry: true,
              attempt: view.attempts,
              maxAttempts: 3,
              message: `Review failed. Will retry (attempt ${view.attempts}/3).`,
              issues: view.errors
            })
          }
        }
      }),
      
      // Get workflow status
      workflow_translate_status: tool({
        description: "Get the current status of a translation workflow.",
        args: {
          workflowId: tool.schema.string().optional().describe("Workflow ID (auto-detects if not provided)")
        },
        async execute(args) {
          const workflowId = args.workflowId || findActiveWorkflow()
          if (!workflowId) {
            return JSON.stringify({ success: false, error: "No active workflow found" })
          }
          
          const state = loadWorkflowState(workflowId)
          if (!state) {
            return JSON.stringify({ success: false, error: `Workflow not found: ${workflowId}` })
          }
          
          const done = state.views.filter(v => v.status === "done").length
          const pending = state.views.filter(v => v.status === "pending").length
          const error = state.views.filter(v => v.status === "error").length
          const processing = state.views.filter(v => v.status === "processing" || v.status === "review").length
          
          return JSON.stringify({
            success: true,
            workflowId: state.id,
            componentName: state.componentName,
            targetLanguage: state.targetLanguage,
            status: state.status,
            progress: {
              total: state.views.length,
              done,
              pending,
              error,
              processing,
              percentComplete: Math.round((done / state.views.length) * 100)
            },
            stringsConverted: state.totalStringsConverted,
            totalErrors: state.totalErrors,
            views: state.views.map(v => ({
              path: v.relativePath,
              lines: v.lines,
              status: v.status,
              attempts: v.attempts,
              stringsConverted: v.stringsConverted
            }))
          }, null, 2)
        }
      })
    }
  }
}
