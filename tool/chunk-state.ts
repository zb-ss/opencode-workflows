import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"

interface ChunkData {
  id: number
  startLine: number
  endLine: number
  status: "pending" | "completed" | "failed"
  completedAt?: string
  failedAt?: string
  error?: string
  extractedData?: unknown
}

interface ChunkState {
  filePath: string
  totalLines: number
  totalChunks: number
  chunkSize: number
  overlap: number
  createdAt: string
  updatedAt: string
  chunks: ChunkData[]
}

export default tool({
  description: "Update chunk processing state. Use to mark chunks as completed/failed and track progress across sessions.",
  args: {
    stateFile: tool.schema.string().describe("Path to the state file created by file-chunker"),
    action: tool.schema.enum(["complete", "fail", "reset", "status"]).describe("Action to perform: complete (mark done), fail (mark failed), reset (reset to pending), status (get current status)"),
    chunkId: tool.schema.number().optional().describe("Chunk ID to update (required for complete/fail/reset on single chunk)"),
    error: tool.schema.string().optional().describe("Error message when marking as failed"),
    data: tool.schema.string().optional().describe("JSON string of extracted data to store with the chunk")
  },
  async execute(args) {
    const { stateFile, action, chunkId, error } = args

    // Validate state file exists
    if (!existsSync(stateFile)) {
      return JSON.stringify({
        success: false,
        error: `State file not found: ${stateFile}`
      }, null, 2)
    }

    // Read state file
    const state: ChunkState = JSON.parse(readFileSync(stateFile, "utf-8"))

    // Handle status action
    if (action === "status") {
      const completed = state.chunks.filter(c => c.status === "completed")
      const failed = state.chunks.filter(c => c.status === "failed")
      const pending = state.chunks.filter(c => c.status === "pending")

      const progress = state.totalChunks > 0 
        ? Math.round((completed.length / state.totalChunks) * 100) 
        : 0

      return JSON.stringify({
        success: true,
        action: "status",
        filePath: state.filePath,
        totalChunks: state.totalChunks,
        completed: completed.map(c => c.id),
        failed: failed.map(c => ({ id: c.id, error: c.error })),
        pending: pending.map(c => c.id),
        progress: `${progress}%`,
        nextPendingChunk: pending.length > 0 ? pending[0].id : null,
        summary: {
          completedCount: completed.length,
          failedCount: failed.length,
          pendingCount: pending.length
        }
      }, null, 2)
    }

    // For other actions, chunkId may be required
    if (action !== "reset" && chunkId === undefined) {
      return JSON.stringify({
        success: false,
        error: `chunkId is required for action: ${action}`
      }, null, 2)
    }

    // Handle reset action (can reset single chunk or all)
    if (action === "reset") {
      if (chunkId !== undefined) {
        // Reset single chunk
        const chunk = state.chunks.find(c => c.id === chunkId)
        if (!chunk) {
          return JSON.stringify({
            success: false,
            error: `Chunk ${chunkId} not found`
          }, null, 2)
        }
        chunk.status = "pending"
        delete chunk.completedAt
        delete chunk.failedAt
        delete chunk.error
        delete chunk.extractedData
      } else {
        // Reset all chunks
        state.chunks.forEach(chunk => {
          chunk.status = "pending"
          delete chunk.completedAt
          delete chunk.failedAt
          delete chunk.error
          delete chunk.extractedData
        })
      }

      state.updatedAt = new Date().toISOString()
      writeFileSync(stateFile, JSON.stringify(state, null, 2))

      return JSON.stringify({
        success: true,
        action: "reset",
        chunkId: chunkId ?? "all",
        message: chunkId !== undefined ? `Chunk ${chunkId} reset to pending` : "All chunks reset to pending"
      }, null, 2)
    }

    // Find the chunk
    const chunk = state.chunks.find(c => c.id === chunkId)
    if (!chunk) {
      return JSON.stringify({
        success: false,
        error: `Chunk ${chunkId} not found. Valid range: 1-${state.totalChunks}`
      }, null, 2)
    }

    // Handle complete action
    if (action === "complete") {
      chunk.status = "completed"
      chunk.completedAt = new Date().toISOString()
      delete chunk.failedAt
      delete chunk.error

      // Store extracted data if provided
      if (args.data) {
        try {
          chunk.extractedData = JSON.parse(args.data)
        } catch {
          chunk.extractedData = args.data
        }
      }

      state.updatedAt = new Date().toISOString()
      writeFileSync(stateFile, JSON.stringify(state, null, 2))

      // Calculate progress
      const completedCount = state.chunks.filter(c => c.status === "completed").length
      const progress = Math.round((completedCount / state.totalChunks) * 100)

      // Find next pending chunk
      const nextPending = state.chunks.find(c => c.status === "pending")

      return JSON.stringify({
        success: true,
        action: "complete",
        chunkId,
        progress: `${progress}%`,
        completedCount,
        totalChunks: state.totalChunks,
        nextPendingChunk: nextPending?.id ?? null,
        isComplete: completedCount === state.totalChunks
      }, null, 2)
    }

    // Handle fail action
    if (action === "fail") {
      chunk.status = "failed"
      chunk.failedAt = new Date().toISOString()
      chunk.error = error ?? "Unknown error"
      delete chunk.completedAt

      state.updatedAt = new Date().toISOString()
      writeFileSync(stateFile, JSON.stringify(state, null, 2))

      // Find next pending chunk (skip failed ones)
      const nextPending = state.chunks.find(c => c.status === "pending")

      return JSON.stringify({
        success: true,
        action: "fail",
        chunkId,
        error: chunk.error,
        nextPendingChunk: nextPending?.id ?? null,
        message: `Chunk ${chunkId} marked as failed`
      }, null, 2)
    }

    return JSON.stringify({
      success: false,
      error: `Unknown action: ${action}`
    }, null, 2)
  }
})
