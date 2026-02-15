/**
 * OpenCode Model Router Plugin
 *
 * Enforces mode-based model tier constraints.
 * When a Task tool call targets a forbidden tier for the current mode,
 * denies the call with an explanation.
 *
 * Safety: after 3 denials of the same mode+tier combo, allows on 4th.
 *
 * Ported from Claude Code hooks/pre-task-route.js
 */

import type { Plugin } from "@opencode-ai/plugin"
import { getWorkflowForSession } from "../lib/state.ts"
import { isTierForbidden, getPreferredTier } from "../lib/mode-rules.ts"
import { getModelCapability } from "../lib/model-registry.ts"
import { log } from "../lib/logger.ts"
import type { ModelTier } from "../lib/types.ts"
import { findActiveStates } from "../lib/state.ts"

/** Infer tier from model name keywords when not in the registry */
const TIER_KEYWORDS: Record<string, ModelTier> = {
  'nano': 'low',
  'mini': 'low',
  'flash': 'mid',
  'pro': 'high',
  'opus': 'high',
  'sonnet': 'mid',
  'haiku': 'low',
}

function inferTier(modelId: string): ModelTier | null {
  // First try registry
  const capability = getModelCapability(modelId)
  if (capability) return capability.tier

  // Fallback to keyword inference
  const lower = modelId.toLowerCase()
  for (const [keyword, tier] of Object.entries(TIER_KEYWORDS)) {
    if (lower.includes(keyword)) return tier
  }
  return null
}

export const ModelRouter: Plugin = async ({ directory }) => {
  // Deny counter per session for safety override
  const denyCounters = new Map<string, Map<string, number>>()

  return {
    "permission.ask": async ({ tool, args, output }) => {
      // Only intercept Task tool calls
      if (tool !== 'task' && tool !== 'Task') return

      const sessionId = (args as any)?.sessionId || 'unknown'
      const active = getWorkflowForSession(sessionId)
      if (!active) return

      const mode = active.state.mode?.current
      if (!mode) return

      // Extract model from task args
      const requestedModel = (args as any)?.model
      if (!requestedModel) return

      // Look up model tier
      const tier = inferTier(requestedModel)
      if (!tier) return // Unknown model, allow

      // Check if tier is forbidden for mode
      if (!isTierForbidden(mode, tier)) return

      // Tier is forbidden - check deny counter
      const counterKey = `${mode}-${tier}`
      if (!denyCounters.has(sessionId)) denyCounters.set(sessionId, new Map())
      const sessionCounters = denyCounters.get(sessionId)!
      const count = (sessionCounters.get(counterKey) || 0) + 1
      sessionCounters.set(counterKey, count)

      // Safety override after 3 denials
      if (count > 3) {
        log('model-router', `Override: allowing ${requestedModel} (${tier}) in ${mode} mode after ${count} denials`)
        sessionCounters.set(counterKey, 0)
        return
      }

      // Deny
      const preferred = getPreferredTier(mode)
      const reason = `Mode "${mode}" forbids tier "${tier}" (model: ${requestedModel}). Use a "${preferred}" tier model instead. (Denial ${count}/3, override at 4)`
      log('model-router', `Denied ${requestedModel} in ${mode} mode (${count}/3)`)

      output.status = 'deny'
      output.reason = reason
    },

    "experimental.chat.system.transform": async ({ agent, output }) => {
      // Inject mode constraint reminder into supervisor prompt
      // Advisory only, the permission.ask hook does real enforcement
      try {
        const states = findActiveStates()
        if (states.length === 0) return

        const active = states[0]
        const mode = active.state.mode?.current
        if (!mode) return

        const preferred = getPreferredTier(mode)
        const modeInfo = `\n\n[WORKFLOW MODE: ${mode}] Preferred model tier: ${preferred}. Route agents accordingly.\n`
        output.system = (output.system || '') + modeInfo
      } catch {
        /* non-critical */
      }
    }
  }
}

export default ModelRouter
