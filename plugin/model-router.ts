/**
 * OpenCode Model Router Plugin
 *
 * Adds session-scoped, advisory model routing context.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { getWorkflowForSession } from "../lib/state.ts"
import { getPreferredTier } from "../lib/mode-rules.ts"

export const ModelRouter: Plugin = async () => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return
        const active = getWorkflowForSession(input.sessionID)
        if (!active) return

        const mode = active.state.mode?.current
        if (!mode) return

        const preferred = getPreferredTier(mode)
        output.system.push(`[WORKFLOW MODE: ${mode}] Preferred model tier: ${preferred}. Route agents accordingly.`)
      } catch {
        /* non-critical */
      }
    }
  }
}

export default ModelRouter
