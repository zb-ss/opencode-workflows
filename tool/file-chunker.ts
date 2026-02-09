import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { basename, dirname, join } from "path"
import { createHash } from "crypto"
import { tmpdir } from "os"

export default tool({
  description: "Split large files into processable chunks with state tracking. Essential for processing files over 500 lines that would overwhelm LLM context windows.",
  args: {
    filePath: tool.schema.string().describe("Absolute path to the file to chunk"),
    chunkSize: tool.schema.number().default(150).describe("Number of lines per chunk (default: 150)"),
    overlap: tool.schema.number().default(20).describe("Number of overlapping lines between chunks for context (default: 20)"),
    outputDir: tool.schema.string().optional().describe("Directory to store state file (default: os.tmpdir()/opencode-chunks)")
  },
  async execute(args) {
    const { filePath, chunkSize = 150, overlap = 20 } = args
    const outputDir = args.outputDir || join(tmpdir(), "opencode-chunks")

    // Validate file exists
    if (!existsSync(filePath)) {
      return JSON.stringify({
        success: false,
        error: `File not found: ${filePath}`
      }, null, 2)
    }

    // Read file content
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    const totalLines = lines.length

    // Calculate chunks
    const chunks: Array<{
      id: number
      startLine: number
      endLine: number
      status: "pending" | "completed" | "failed"
      preview: string
    }> = []

    let startLine = 1
    let chunkId = 1

    while (startLine <= totalLines) {
      const endLine = Math.min(startLine + chunkSize - 1, totalLines)
      
      // Get preview (first 80 chars of first non-empty line in chunk)
      const chunkLines = lines.slice(startLine - 1, endLine)
      const firstNonEmpty = chunkLines.find(l => l.trim().length > 0) || ""
      const preview = firstNonEmpty.substring(0, 80).trim()

      chunks.push({
        id: chunkId,
        startLine,
        endLine,
        status: "pending",
        preview: preview + (firstNonEmpty.length > 80 ? "..." : "")
      })

      // Move to next chunk with overlap
      startLine = endLine - overlap + 1
      
      // Prevent infinite loop if overlap >= chunkSize
      if (startLine <= chunks[chunks.length - 1].startLine) {
        startLine = endLine + 1
      }
      
      chunkId++
    }

    // Create output directory if needed
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    // Generate state file name based on file path hash
    const fileHash = createHash("md5").update(filePath).digest("hex").substring(0, 8)
    const fileName = basename(filePath).replace(/[^a-zA-Z0-9]/g, "-")
    const stateFileName = `${fileName}-${fileHash}-state.json`
    const stateFilePath = `${outputDir}/${stateFileName}`

    // Create state object
    const state = {
      filePath,
      totalLines,
      totalChunks: chunks.length,
      chunkSize,
      overlap,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chunks
    }

    // Write state file
    writeFileSync(stateFilePath, JSON.stringify(state, null, 2))

    return JSON.stringify({
      success: true,
      filePath,
      totalLines,
      totalChunks: chunks.length,
      chunkSize,
      overlap,
      stateFile: stateFilePath,
      chunks: chunks.map(c => ({
        id: c.id,
        startLine: c.startLine,
        endLine: c.endLine,
        lines: c.endLine - c.startLine + 1,
        status: c.status,
        preview: c.preview
      }))
    }, null, 2)
  }
})
