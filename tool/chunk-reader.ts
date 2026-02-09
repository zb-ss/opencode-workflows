import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"

interface ChunkState {
  filePath: string
  totalLines: number
  totalChunks: number
  chunkSize: number
  overlap: number
  chunks: Array<{
    id: number
    startLine: number
    endLine: number
    status: string
  }>
}

export default tool({
  description: "Read a specific chunk from a file using state from file-chunker. Returns the chunk content with surrounding context.",
  args: {
    stateFile: tool.schema.string().describe("Path to the state file created by file-chunker"),
    chunkId: tool.schema.number().describe("The chunk ID to read (1-based)")
  },
  async execute(args) {
    const { stateFile, chunkId } = args

    // Validate state file exists
    if (!existsSync(stateFile)) {
      return JSON.stringify({
        success: false,
        error: `State file not found: ${stateFile}`
      }, null, 2)
    }

    // Read state file
    const state: ChunkState = JSON.parse(readFileSync(stateFile, "utf-8"))

    // Validate chunk ID
    const chunk = state.chunks.find(c => c.id === chunkId)
    if (!chunk) {
      return JSON.stringify({
        success: false,
        error: `Chunk ${chunkId} not found. Valid range: 1-${state.totalChunks}`
      }, null, 2)
    }

    // Validate source file exists
    if (!existsSync(state.filePath)) {
      return JSON.stringify({
        success: false,
        error: `Source file not found: ${state.filePath}`
      }, null, 2)
    }

    // Read source file
    const content = readFileSync(state.filePath, "utf-8")
    const lines = content.split("\n")

    // Extract chunk content (convert to 0-based index)
    const startIdx = chunk.startLine - 1
    const endIdx = chunk.endLine
    const chunkLines = lines.slice(startIdx, endIdx)

    // Get context from previous chunk (last 5 lines)
    let previousContext = ""
    if (chunkId > 1) {
      const prevChunk = state.chunks.find(c => c.id === chunkId - 1)
      if (prevChunk) {
        const prevEndIdx = prevChunk.endLine
        const prevStartIdx = Math.max(prevEndIdx - 5, prevChunk.startLine - 1)
        previousContext = lines.slice(prevStartIdx, prevEndIdx).join("\n")
      }
    }

    // Get context from next chunk (first 5 lines)
    let nextContext = ""
    if (chunkId < state.totalChunks) {
      const nextChunk = state.chunks.find(c => c.id === chunkId + 1)
      if (nextChunk) {
        const nextStartIdx = nextChunk.startLine - 1
        const nextEndIdx = Math.min(nextStartIdx + 5, nextChunk.endLine)
        nextContext = lines.slice(nextStartIdx, nextEndIdx).join("\n")
      }
    }

    // Build content with line numbers
    const numberedContent = chunkLines.map((line, idx) => {
      const lineNum = chunk.startLine + idx
      return `${String(lineNum).padStart(5, " ")} | ${line}`
    }).join("\n")

    return JSON.stringify({
      success: true,
      chunkId,
      filePath: state.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      totalLines: chunk.endLine - chunk.startLine + 1,
      status: chunk.status,
      navigation: {
        isFirst: chunkId === 1,
        isLast: chunkId === state.totalChunks,
        previousChunk: chunkId > 1 ? chunkId - 1 : null,
        nextChunk: chunkId < state.totalChunks ? chunkId + 1 : null,
        totalChunks: state.totalChunks
      },
      context: {
        previousChunkEnding: previousContext || "(start of file)",
        nextChunkStart: nextContext || "(end of file)"
      },
      content: numberedContent,
      rawContent: chunkLines.join("\n")
    }, null, 2)
  }
})
