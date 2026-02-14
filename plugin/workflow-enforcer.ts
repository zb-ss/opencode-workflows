/**
 * OpenCode Workflow Enforcer Plugin
 *
 * Core enforcement plugin replacing 4 Claude Code hooks:
 * - stop-guard.js (completion blocking)
 * - subagent-stop-track.js (gate tracking)
 * - session-start.js (context injection)
 * - task-completed-gate.js (task completion guard)
 *
 * Custom tools:
 * - workflow_check_completion: 3-layer stop guard
 * - workflow_update_gate: Gate state update
 * - workflow_bind_session: Session-workflow binding
 * - workflow_get_state: Read workflow state
 */

import type { Plugin } from "@opencode-ai/plugin"
import {
  getWorkflowForSession,
  allMandatoryGatesPassed,
  getPendingGates,
  getNextPhase,
  updateState,
  bindSessionToWorkflow,
  readState,
  findActiveStates,
  findOrphanedOrgFiles,
  writeSessionMarker,
} from "../lib/state.ts"
import { getGateForAgent, PHASE_ORDER } from "../lib/mode-rules.ts"
import { log } from "../lib/logger.ts"
import type { GateStatus } from "../lib/types.ts"

export const WorkflowEnforcer: Plugin = async ({ client, directory }) => {
  // Stop-guard counters (replaces file-based counters from Claude Code hooks)
  const stopCounters = new Map<string, number>()
  const staleTrackers = new Map<string, { updated_at: string; count: number }>()

  return {
    // Event handler for session lifecycle and message tracking
    event: async ({ event }) => {
      // Session status: idle -> advisory warning if gates incomplete
      if (event.type === 'session.status' && event.properties?.type === 'idle') {
        const sessionId = event.properties?.sessionID
        if (!sessionId) return

        const active = getWorkflowForSession(sessionId)
        if (!active) return

        if (!allMandatoryGatesPassed(active.state)) {
          const pending = getPendingGates(active.state)
          const names = pending.map(g => g.name).join(', ')
          log('enforcer', `Advisory: session ${sessionId} idle with pending gates: ${names}`)
        }
      }

      // Message updated: detect agent completion patterns
      if (event.type === 'message.updated') {
        const content = event.properties?.content || ''
        const sessionId = event.properties?.sessionID
        if (!sessionId || !content) return

        // Detect verdict patterns in messages
        const upperContent = content.toUpperCase()
        if (upperContent.includes('VERDICT: PASS') || upperContent.includes('VERDICT: FAIL') ||
            upperContent.includes('APPROVED') || upperContent.includes('REJECTED')) {
          log('enforcer', `Verdict detected in session ${sessionId}`)
        }
      }
    },

    // Inject workflow context into agent system prompts
    "experimental.chat.system.transform": async ({ agent, output }) => {
      try {
        const states = findActiveStates()
        if (states.length === 0) return

        const active = states[0]
        const state = active.state
        const pending = getPendingGates(state)
        const nextPhase = getNextPhase(state)

        const context = [
          `\n\n--- WORKFLOW CONTEXT ---`,
          `Workflow: ${state.workflow_id} (${state.workflow_type})`,
          `Mode: ${state.mode?.current || 'standard'}`,
          `Phase: ${state.phase?.current || 'unknown'}`,
          `Pending gates: ${pending.map(g => g.name).join(', ') || 'none'}`,
          nextPhase ? `Next phase: ${nextPhase}` : 'All phases complete',
          `--- END WORKFLOW CONTEXT ---\n`,
        ].join('\n')

        output.system = (output.system || '') + context
      } catch {
        /* non-critical */
      }
    },

    // Custom tools for agents to use
    tool: {
      workflow_check_completion: {
        description: "Check if workflow can be completed. Returns pending gates and completion status. Must be called before ending a workflow.",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Current session ID" }
          },
          required: ["sessionId"]
        },
        async execute(args: { sessionId: string }) {
          const { sessionId } = args
          const active = getWorkflowForSession(sessionId)

          if (!active) {
            return JSON.stringify({ canComplete: true, pendingGates: [], reason: "No active workflow" })
          }

          const { state } = active

          if (allMandatoryGatesPassed(state)) {
            // Reset counters on successful completion check
            stopCounters.delete(sessionId)
            staleTrackers.delete(sessionId)
            log('enforcer', `Completion check PASSED for ${state.workflow_id}`)
            return JSON.stringify({ canComplete: true, pendingGates: [], reason: "All mandatory gates passed" })
          }

          // 3-layer safety: check counters
          const counter = (stopCounters.get(sessionId) || 0) + 1
          stopCounters.set(sessionId, counter)

          // Layer 2: Max 5 consecutive blocks
          if (counter >= 5) {
            log('enforcer', `Safety valve: ${counter} blocks, allowing completion`)
            stopCounters.delete(sessionId)
            return JSON.stringify({ canComplete: true, pendingGates: [], reason: "Safety valve triggered after 5 blocks" })
          }

          // Layer 3: Staleness detection
          const currentUpdatedAt = state.updated_at || ''
          const stale = staleTrackers.get(sessionId)
          let staleCount = 0
          if (stale && stale.updated_at === currentUpdatedAt) {
            staleCount = stale.count + 1
          }
          staleTrackers.set(sessionId, { updated_at: currentUpdatedAt, count: staleCount })

          if (staleCount >= 3) {
            log('enforcer', `Stale detected: ${staleCount} checks, allowing completion`)
            stopCounters.delete(sessionId)
            staleTrackers.delete(sessionId)
            return JSON.stringify({ canComplete: true, pendingGates: [], reason: "Staleness detected, allowing completion" })
          }

          // Block
          const pending = getPendingGates(state)
          const nextPhase = getNextPhase(state)
          log('enforcer', `Completion blocked: ${pending.map(g => g.name).join(', ')} (${counter}/5)`)

          return JSON.stringify({
            canComplete: false,
            pendingGates: pending,
            reason: `Workflow "${state.workflow_id}" has incomplete gates: ${pending.map(g => g.name).join(', ')}. ${nextPhase ? `Next: ${nextPhase}` : ''} (Block ${counter}/5)`
          })
        }
      },

      workflow_update_gate: {
        description: "Update a workflow gate status after an agent completes. Call this after each agent finishes.",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Current session ID" },
            gateName: { type: "string", description: "Gate name (e.g., 'planning', 'code_review')" },
            status: { type: "string", enum: ["pending", "in_progress", "passed", "failed", "skipped"], description: "New gate status" },
            agentType: { type: "string", description: "Agent type that completed (e.g., 'reviewer')" }
          },
          required: ["sessionId", "gateName", "status"]
        },
        async execute(args: { sessionId: string; gateName: string; status: string; agentType?: string }) {
          const active = getWorkflowForSession(args.sessionId)
          if (!active) return "No active workflow found"

          const updated = updateState(active.path, (state) => {
            if (!state.gates) state.gates = {}
            if (!state.gates[args.gateName]) {
              state.gates[args.gateName] = { status: 'pending', iteration: 0 }
            }

            const gate = state.gates[args.gateName]
            gate.iteration = (gate.iteration || 0) + 1
            gate.status = args.status as GateStatus

            // Advance phase on pass
            if (args.status === 'passed' && state.phase) {
              const completed = state.phase.completed || []
              const remaining = state.phase.remaining || []

              if (!completed.includes(args.gateName)) completed.push(args.gateName)
              state.phase.completed = completed

              const idx = remaining.indexOf(args.gateName)
              if (idx !== -1) remaining.splice(idx, 1)
              state.phase.remaining = remaining

              state.phase.current = remaining.length > 0 ? remaining[0] : 'completed'
            }

            // Add log entry
            if (!state.agent_log) state.agent_log = []
            state.agent_log.push({
              timestamp: new Date().toISOString(),
              agent_type: args.agentType || 'unknown',
              gate: args.gateName,
              verdict: args.status,
              iteration: gate.iteration,
              agent_id: null,
            })

            return state
          })

          if (updated && args.status === 'passed') {
            // Reset stop counter on progress
            stopCounters.delete(args.sessionId)
            log('enforcer', `Gate "${args.gateName}" passed (agent: ${args.agentType})`)
          }

          return updated ? `Gate "${args.gateName}" updated to ${args.status}` : "Failed to update gate"
        }
      },

      workflow_bind_session: {
        description: "Bind the current session to a workflow. Call this at workflow start.",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Current session ID" },
            workflowPath: { type: "string", description: "Path to the workflow .state.json file" }
          },
          required: ["sessionId", "workflowPath"]
        },
        async execute(args: { sessionId: string; workflowPath: string }) {
          const state = readState(args.workflowPath)
          const workflowId = state?.workflow_id || null

          const success = bindSessionToWorkflow(args.sessionId, args.workflowPath, workflowId)
          writeSessionMarker(args.sessionId)

          log('enforcer', `Session ${args.sessionId} bound to workflow ${workflowId}`)
          return success ? `Session bound to workflow ${workflowId}` : "Failed to bind session"
        }
      },

      workflow_get_state: {
        description: "Get the current workflow state for a session.",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Current session ID" }
          },
          required: ["sessionId"]
        },
        async execute(args: { sessionId: string }) {
          const active = getWorkflowForSession(args.sessionId)
          if (!active) return JSON.stringify({ active: false })

          return JSON.stringify({
            active: true,
            workflow_id: active.state.workflow_id,
            mode: active.state.mode?.current,
            phase: active.state.phase,
            gates: active.state.gates,
            pending: getPendingGates(active.state).map(g => g.name),
          })
        }
      }
    }
  }
}

export default WorkflowEnforcer
