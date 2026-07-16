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

import { tool as pluginTool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import {
  getWorkflowForSession,
  allMandatoryGatesPassed,
  archiveCompletedWorkflow,
  getPendingGates,
  getNextPhase,
  updateState,
  bindSessionToWorkflow,
  clearSessionBinding,
  clearWorkflowBindings,
  readState,
  writeSessionMarker,
  createInitialState,
  ACTIVE_DIR,
} from "../lib/state.ts"
import { PHASE_ORDER } from "../lib/mode-rules.ts"
import path from "node:path"
import { log } from "../lib/logger.ts"
import type { GateStatus, WorkflowState } from "../lib/types.ts"

interface SessionArgs {
  sessionId?: string
  workflowId?: string
}

function authoritativeSessionID(args: SessionArgs, context: ToolContext): string {
  if (args.sessionId !== undefined && args.sessionId !== context.sessionID) {
    throw new Error("sessionId must match the current tool session")
  }
  return context.sessionID
}

function workflowForTool(sessionID: string, workflowID?: string) {
  const active = getWorkflowForSession(sessionID)
  if (active && workflowID && active.state.workflow_id !== workflowID) {
    throw new Error(`Workflow ${workflowID} is not bound to the current session`)
  }
  return active
}

function isWorkflowController(state: WorkflowState, sessionID: string): boolean {
  return state.owner?.current_session_id === sessionID
}

function formatTaskIDs(state: WorkflowState): string {
  const taskIDs = Object.entries(state.task_ids || {})
  return taskIDs.length > 0
    ? taskIDs.map(([name, id]) => `${name}=${id}`).join(', ')
    : 'none'
}

function formatWorktreeOwnership(state: WorkflowState, worktree: string): string {
  if (!state.owner) return `unrecorded; current worktree=${worktree}`
  return [
    `root session=${state.owner.root_session_id}`,
    `current session=${state.owner.current_session_id}`,
    state.owner.project_id ? `project=${state.owner.project_id}` : '',
    `worktree=${state.owner.directory || worktree}`,
  ].filter(Boolean).join(', ')
}

export const WorkflowEnforcer: Plugin = async ({ client, worktree, project }) => {
  const z = pluginTool.schema

  // Stop-guard counters (replaces file-based counters from Claude Code hooks)
  const stopCounters = new Map<string, number>()
  const staleTrackers = new Map<string, { updated_at: string; count: number }>()
  const childSessions = new Set<string>()

  return {
    // Event handler for session lifecycle and message tracking
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        const { id, parentID } = event.properties.info
        if (!parentID) return
        childSessions.add(id)
        const parentWorkflow = getWorkflowForSession(parentID)
        if (parentWorkflow) {
          bindSessionToWorkflow(id, parentWorkflow.path, parentWorkflow.state.workflow_id)
        }
        return
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        clearSessionBinding(sessionID)
        stopCounters.delete(sessionID)
        staleTrackers.delete(sessionID)
        childSessions.delete(sessionID)
        return
      }

      // Session status: idle -> advisory warning if gates incomplete
      if (event.type === 'session.status' && event.properties.status.type === 'idle') {
        const sessionID = event.properties.sessionID

        const active = getWorkflowForSession(sessionID)
        if (!active) return

        if (!allMandatoryGatesPassed(active.state)) {
          const pending = getPendingGates(active.state)
          const names = pending.map(g => g.name).join(', ')
          log('enforcer', `Advisory: session ${sessionID} idle with pending gates: ${names}`)
        }
      }

      // Text parts carry the current message text in OpenCode 1.17.20.
      if (event.type === 'message.part.updated' && event.properties.part.type === 'text') {
        const { sessionID, text } = event.properties.part
        if (!text) return

        // Detect verdict patterns in messages
        const upperContent = text.toUpperCase()
        if (upperContent.includes('VERDICT: PASS') || upperContent.includes('VERDICT: FAIL') ||
            upperContent.includes('APPROVED') || upperContent.includes('REJECTED')) {
          log('enforcer', `Verdict detected in session ${sessionID}`)
        }
      }
    },

    // Inject workflow context into ALL agent system prompts (including child sessions)
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return
        const active = getWorkflowForSession(input.sessionID)
        if (!active) return

        const state = active.state
        const pending = getPendingGates(state)
        const nextPhase = getNextPhase(state)

        const context = [
          `--- WORKFLOW CONTEXT (AUTHORITATIVE - use these values, do NOT infer or guess) ---`,
          `Workflow ID: ${state.workflow_id}`,
          `Workflow Type: ${state.workflow_type}`,
          `Mode: ${state.mode?.current || 'standard'}`,
          `Current Phase: ${state.phase?.current || 'unknown'}`,
          `Completed Phases: ${(state.phase?.completed || []).join(', ') || 'none'}`,
          `Pending Gates: ${pending.map(g => g.name).join(', ') || 'none'}`,
          nextPhase ? `Next Phase: ${nextPhase}` : 'All phases complete',
          `State File: ${active.path}`,
          state.org_file ? `Org File: ${state.org_file}` : '',
          state.workflow?.description ? `Description: ${state.workflow.description}` : '',
          ``,
          `IMPORTANT: When referencing this workflow, you MUST use the exact Workflow ID above.`,
          `Do NOT invent, guess, or substitute a different workflow ID.`,
          `--- END WORKFLOW CONTEXT ---`,
        ].filter(Boolean).join('\n')

        output.system.push(context)
      } catch {
        /* non-critical */
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const active = getWorkflowForSession(input.sessionID)
      if (!active) return

      const state = active.state
      output.context.push([
        'Preserve this authoritative workflow state across compaction:',
        `Workflow ID: ${state.workflow_id}`,
        `Current phase: ${state.phase?.current || 'unknown'}`,
        `Pending gates: ${getPendingGates(state).map(gate => gate.name).join(', ') || 'none'}`,
        `State path: ${active.path}`,
        `Task IDs: ${formatTaskIDs(state)}`,
        `Worktree ownership: ${formatWorktreeOwnership(state, worktree)}`,
      ].join('\n'))
    },

    // Custom tools for agents to use
    tool: {
      workflow_check_completion: pluginTool({
        description: "Check if workflow can be completed. Returns pending gates and completion status. Must be called before ending a workflow.",
        args: {
          sessionId: z.string().optional().describe("Legacy session ID; when supplied it must match the current session"),
          workflowId: z.string().optional().describe("Expected workflow ID; it must match the current session binding"),
        },
        async execute(args, context) {
          const sessionID = authoritativeSessionID(args, context)
          const active = workflowForTool(sessionID, args.workflowId)

          if (!active) {
            return JSON.stringify({ canComplete: true, pendingGates: [], reason: "No active workflow" })
          }

          const { state } = active
          if (!isWorkflowController(state, sessionID)) {
            return JSON.stringify({
              canComplete: false,
              pendingGates: getPendingGates(state),
              reason: 'Only the workflow controller session can complete this workflow',
            })
          }

          if (allMandatoryGatesPassed(state)) {
            const archived = archiveCompletedWorkflow(active.path)
            if (!archived) {
              return JSON.stringify({
                canComplete: false,
                pendingGates: [],
                reason: 'All gates passed, but workflow archival failed or the completed target already exists',
              })
            }
            // Reset counters on successful completion check
            stopCounters.delete(sessionID)
            staleTrackers.delete(sessionID)
            clearWorkflowBindings(active.path)
            log('enforcer', `Completion check PASSED for ${state.workflow_id}`)
            return JSON.stringify({
              canComplete: true,
              pendingGates: [],
              reason: "All mandatory gates passed",
              archived,
            })
          }

          // Count repeated checks for diagnostics, but never bypass mandatory gates.
          const counter = (stopCounters.get(sessionID) || 0) + 1
          stopCounters.set(sessionID, counter)

          // Layer 3: Staleness detection
          const currentUpdatedAt = state.updated_at || ''
          const stale = staleTrackers.get(sessionID)
          let staleCount = 0
          if (stale && stale.updated_at === currentUpdatedAt) {
            staleCount = stale.count + 1
          }
          staleTrackers.set(sessionID, { updated_at: currentUpdatedAt, count: staleCount })

          if (staleCount >= 3) log('enforcer', `Workflow state unchanged across ${staleCount + 1} completion checks`)

          const pending = getPendingGates(state)
          const nextPhase = getNextPhase(state)
          log('enforcer', `Completion blocked: ${pending.map(g => g.name).join(', ')} (${counter}/5)`)

          return JSON.stringify({
            canComplete: false,
            pendingGates: pending,
            reason: `Workflow "${state.workflow_id}" has incomplete gates: ${pending.map(g => g.name).join(', ')}. ${nextPhase ? `Next: ${nextPhase}` : ''} (check ${counter})`
          })
        }
      }),

      workflow_update_gate: pluginTool({
        description: "Update a workflow gate status after an agent completes. Call this after each agent finishes.",
        args: {
          sessionId: z.string().optional().describe("Legacy session ID; when supplied it must match the current session"),
          gateName: z.string().describe("Gate name (e.g., 'planning', 'code_review')"),
          status: z.enum(["pending", "in_progress", "passed", "failed", "skipped"]).describe("New gate status"),
          agentType: z.string().optional().describe("Agent type that completed (e.g., 'reviewer')"),
          workflowId: z.string().optional().describe("Expected workflow ID; it must match the current session binding"),
        },
        async execute(args, context) {
          const sessionID = authoritativeSessionID(args, context)
          const active = workflowForTool(sessionID, args.workflowId)
          if (!active) return "No active workflow found"
          if (!isWorkflowController(active.state, sessionID)) {
            return "Only the workflow controller session can update gates"
          }

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
            stopCounters.delete(sessionID)
            log('enforcer', `Gate "${args.gateName}" passed (agent: ${args.agentType})`)
          }

          return updated ? `Gate "${args.gateName}" updated to ${args.status}` : "Failed to update gate"
        }
      }),

      workflow_bind_session: pluginTool({
        description: "Bind the current session to a workflow. Creates .state.json tracking file if given an .org path. Call this at workflow start.",
        args: {
          sessionId: z.string().optional().describe("Legacy session ID; when supplied it must match the current session"),
          workflowPath: z.string().describe("Path to the workflow .org file or .state.json file"),
          workflowId: z.string().optional().describe("Workflow ID (e.g., wf-2026-02-26-001)"),
          workflowType: z.string().optional().describe("Workflow type (feature, bugfix, refactor, figma, e2e)"),
          mode: z.string().optional().describe("Execution mode (standard, turbo, eco, thorough, swarm)"),
          phases: z.array(z.string()).optional().describe("Ordered list of gate names (e.g., ['planning', 'implementation', 'code_review', ...])")
        },
        async execute(args, context) {
          const sessionID = authoritativeSessionID(args, context)
          if (!args.workflowPath || typeof args.workflowPath !== 'string') {
            return "Error: workflowPath is required. Provide the path to the workflow .org or .state.json file."
          }
          let statePath = path.isAbsolute(args.workflowPath)
            ? args.workflowPath
            : path.resolve(context.directory, args.workflowPath)
          let createdState = false

          // If path points to an org/md file, create or find the .state.json sidecar
          if (statePath.endsWith('.org') || statePath.endsWith('.md')) {
            const derivedStatePath = statePath.replace(/\.(org|md)$/, '.state.json')

            // Try to read existing state first
            const existingState = readState(derivedStatePath)
            if (existingState) {
              statePath = derivedStatePath
            } else {
              // Create initial state alongside the org file
              const created = createInitialState(
                statePath,
                args.workflowId || path.basename(statePath, path.extname(statePath)),
                args.workflowType || 'unknown',
                args.mode || 'standard',
                args.phases || PHASE_ORDER,
              )
              if (created) {
                statePath = created
                createdState = true
              } else {
                log('enforcer', `Failed to create .state.json for ${statePath}`)
                return "Failed to create workflow state file"
              }
            }
          }

          let state = readState(statePath)
          if (!state) return "Failed to read workflow state file"
          if (args.workflowId && state.workflow_id !== args.workflowId) {
            return `Workflow ID mismatch: state contains ${state.workflow_id}`
          }
          const workflowId = state.workflow_id
          if (!state.owner && !createdState) {
            return "Existing ownerless workflow requires workflow_resume_session from a fresh root session"
          }
          if (state.owner?.current_session_id && state.owner.current_session_id !== sessionID) {
            return "Workflow is controlled by another session; use workflow_resume_session from a fresh session"
          }
          const owned = updateState(statePath, current => {
            current.owner = {
              root_session_id: current.owner?.root_session_id || sessionID,
              current_session_id: sessionID,
              project_id: current.owner?.project_id || (project as { id?: string })?.id,
              directory: path.resolve(worktree),
            }
            current.status = 'running'
            return current
          })
          if (!owned) return "Failed to record workflow ownership"
          state = owned

          const success = bindSessionToWorkflow(sessionID, statePath, workflowId)
          if (success) writeSessionMarker(sessionID)

          log('enforcer', `Session ${sessionID} bound to workflow ${workflowId} at ${statePath}`)
          return success
            ? `Session bound to workflow ${workflowId} (state: ${statePath})`
            : "Failed to bind session"
        }
      }),

      workflow_resume_session: pluginTool({
        description: "Securely transfer an active manual workflow to the current fresh session after explicit approval.",
        args: {
          workflowPath: z.string().describe("Absolute path to the selected active .state.json file"),
          workflowId: z.string().describe("Expected workflow ID"),
        },
        async execute(args, context) {
          if (childSessions.has(context.sessionID)) {
            return "Resume handoff is restricted to root sessions, not Task child sessions"
          }
          if (typeof (client as any)?.session?.get === 'function') {
            try {
              const result = await (client as any).session.get({
                path: { id: context.sessionID },
                query: { directory: context.directory },
                throwOnError: true,
              })
              const info = result?.data ?? result
              if (info?.parentID) return "Resume handoff is restricted to root sessions, not Task child sessions"
            } catch {
              return "Unable to verify that the current session is a root session"
            }
          }
          if (getWorkflowForSession(context.sessionID)) {
            return "Resume requires a fresh session without an inherited or existing workflow binding"
          }
          const statePath = path.resolve(args.workflowPath)
          if (path.dirname(statePath) !== path.resolve(ACTIVE_DIR)) {
            return "Resume is restricted to the active workflow directory"
          }
          const state = readState(statePath)
          if (!state || state.workflow_id !== args.workflowId || state.status === 'completed') {
            return "Active workflow state was not found or did not match the requested ID"
          }
          await context.ask({
            permission: 'workflow_resume',
            patterns: [args.workflowId],
            always: [],
            metadata: {
              workflowId: args.workflowId,
              previousSession: state.owner?.current_session_id ?? null,
              nextSession: context.sessionID,
            },
          })
          const updated = updateState(statePath, current => {
            current.owner = {
              root_session_id: current.owner?.root_session_id || context.sessionID,
              current_session_id: context.sessionID,
              project_id: current.owner?.project_id || (project as { id?: string })?.id,
              directory: path.resolve(worktree),
            }
            current.status = 'running'
            return current
          })
          if (!updated || !bindSessionToWorkflow(context.sessionID, statePath, args.workflowId)) {
            return "Failed to transfer workflow ownership"
          }
          writeSessionMarker(context.sessionID)
          return `Workflow ${args.workflowId} resumed in the current session`
        },
      }),

      workflow_get_state: pluginTool({
        description: "Get the current workflow state for a session.",
        args: {
          sessionId: z.string().optional().describe("Legacy session ID; when supplied it must match the current session"),
          workflowId: z.string().optional().describe("Expected workflow ID; it must match the current session binding"),
        },
        async execute(args, context) {
          const sessionID = authoritativeSessionID(args, context)
          const active = workflowForTool(sessionID, args.workflowId)
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
      })
    }
  }
}

export default WorkflowEnforcer
