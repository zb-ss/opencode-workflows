/**
 * OpenCode Workflow Notifications Plugin
 * 
 * Sends desktop notifications for workflow events using notify-send (Linux).
 * 
 * Events handled:
 * - session.idle: Detects workflow step completions
 * - message.part.updated: Tracks workflow progress markers
 * 
 * Notification types:
 * - Step completed: Informational notification
 * - Workflow completed: Success notification with summary
 * - Step failed: Critical notification requiring attention
 */

import { tool as pluginTool, type Plugin } from "@opencode-ai/plugin"
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getWorkflowForSession, allMandatoryGatesPassed } from '../lib/state.ts'
import type { GateStatus } from '../lib/types.ts'
import { log } from '../lib/logger.ts'

const execFileAsync = promisify(execFile)

interface WorkflowEvent {
  type: 'step_complete' | 'workflow_complete' | 'step_failed' | 'workflow_paused' | 'gate_transition'
  workflowId?: string
  workflowTitle?: string
  stepName?: string
  message?: string
  gate?: string
  fromStatus?: string
  toStatus?: string
}

/**
 * Parse workflow events from session messages
 * The supervisor agent includes markers in its output that we can detect
 */
function parseWorkflowEvent(text: string): WorkflowEvent | null {
  // Step completion marker: "✓ Step N completed: <name>"
  const stepCompleteMatch = text.match(/✓\s*Step\s+\d+\s+completed:\s*(.+)/i)
  if (stepCompleteMatch) {
    return {
      type: 'step_complete',
      stepName: stepCompleteMatch[1].trim()
    }
  }

  // Workflow completion marker: "Workflow completed:"
  const workflowCompleteMatch = text.match(/Workflow completed:\s*(.+)/i)
  if (workflowCompleteMatch) {
    return {
      type: 'workflow_complete',
      workflowTitle: workflowCompleteMatch[1].trim()
    }
  }

  // Step failure marker: "Step N failed:" or "✗ Step"
  const stepFailedMatch = text.match(/(?:Step\s+\d+\s+failed|✗\s*Step):\s*(.+)/i)
  if (stepFailedMatch) {
    return {
      type: 'step_failed',
      message: stepFailedMatch[1].trim()
    }
  }

  // Gate verdict patterns: "VERDICT: PASS" / "VERDICT: FAIL"
  const verdictPassMatch = text.match(/VERDICT:\s*PASS(?:\s*[-:]\s*(.+))?/i)
  if (verdictPassMatch) {
    return {
      type: 'gate_transition',
      gate: verdictPassMatch[1]?.trim() || 'unknown',
      toStatus: 'passed',
      message: `Gate passed: ${verdictPassMatch[1]?.trim() || 'unknown'}`
    }
  }

  const verdictFailMatch = text.match(/VERDICT:\s*FAIL(?:\s*[-:]\s*(.+))?/i)
  if (verdictFailMatch) {
    return {
      type: 'gate_transition',
      gate: verdictFailMatch[1]?.trim() || 'unknown',
      toStatus: 'failed',
      message: `Gate failed: ${verdictFailMatch[1]?.trim() || 'unknown'}`
    }
  }

  // Workflow paused marker
  const pausedMatch = text.match(/Workflow paused|intervention needed/i)
  if (pausedMatch) {
    return {
      type: 'workflow_paused',
      message: 'Workflow paused - intervention needed'
    }
  }

  return null
}

/**
 * Send desktop notification using notify-send
 */
async function sendNotification(
  title: string,
  body: string,
  urgency: 'low' | 'normal' | 'critical' = 'normal',
  icon: string = 'dialog-information'
): Promise<void> {
  try {
    const safeTitle = title || 'OpenCode Notification'
    const safeBody = body || ''

    await execFileAsync('notify-send', [
      `--urgency=${urgency}`,
      `--icon=${icon}`,
      safeTitle,
      safeBody,
    ])
  } catch (error) {
    log('notifications', `Failed to send desktop notification: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Main plugin export
 */
export const WorkflowNotifications: Plugin = async () => {
  const z = pluginTool.schema

  // Track seen events to avoid duplicate notifications
  const seenEvents = new Map<string, Set<string>>()
  const lastGateStates = new Map<string, Map<string, GateStatus>>()

  function sessionEvents(sessionID: string): Set<string> {
    let events = seenEvents.get(sessionID)
    if (!events) {
      events = new Set<string>()
      seenEvents.set(sessionID, events)
    }
    return events
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        seenEvents.delete(sessionID)
        lastGateStates.delete(sessionID)
        return
      }

      // Handle session idle events - check for gate transitions
      if (event.type === "session.idle") {
        try {
          const sessionID = event.properties.sessionID
          const active = getWorkflowForSession(sessionID)
          if (active) {
            const { state } = active
            const events = sessionEvents(sessionID)
            let gateStates = lastGateStates.get(sessionID)
            if (!gateStates) {
              gateStates = new Map<string, GateStatus>()
              lastGateStates.set(sessionID, gateStates)
            }

            for (const [gateName, gate] of Object.entries(state.gates || {})) {
              const prev = gateStates.get(gateName)
              if (prev && prev !== gate.status) {
                // Gate transition detected
                const eventKey = `gate-${gateName}-${gate.status}-${state.updated_at}`
                if (!events.has(eventKey)) {
                  events.add(eventKey)

                  if (gate.status === 'passed') {
                    await sendNotification('Workflow Gate Passed', `${gateName} passed`, 'normal', 'emblem-default')
                  } else if (gate.status === 'failed') {
                    await sendNotification('Workflow Gate Failed', `${gateName} failed - iteration ${gate.iteration}`, 'critical', 'dialog-error')
                  }
                }
              }
              gateStates.set(gateName, gate.status)
            }

            // Check if all gates just passed
            if (allMandatoryGatesPassed(state)) {
              const completeKey = `workflow-complete-${state.workflow_id}`
              if (!events.has(completeKey)) {
                events.add(completeKey)
                await sendNotification('Workflow Complete', `${state.workflow_id} - all gates passed`, 'normal', 'emblem-default')
              }
            }
          }
        } catch {
          // Gate detection is best-effort
        }
      }

      // Text parts contain the current message text in OpenCode 1.17.20.
      if (event.type === "message.part.updated" && event.properties.part.type === 'text') {
        const part = event.properties.part
        const active = getWorkflowForSession(part.sessionID)
        if (!active) return

        // Parse the message for workflow events
        const workflowEvent = parseWorkflowEvent(part.text)
        if (!workflowEvent) return

        const events = sessionEvents(part.sessionID)
        const eventKey = `${part.messageID}:${part.id}:${workflowEvent.type}`
        if (events.has(eventKey)) return
        events.add(eventKey)

        // Clean up old entries (keep last 100 per session)
        if (events.size > 100) {
          const entries = Array.from(events)
          entries.slice(0, 50).forEach(entry => events.delete(entry))
        }

        // Send appropriate notification
        switch (workflowEvent.type) {
          case 'step_complete':
            await sendNotification(
              'OpenCode Workflow',
              `Step completed: ${workflowEvent.stepName}`,
              'normal',
              'dialog-information'
            )
            break

          case 'workflow_complete':
            await sendNotification(
              'OpenCode Workflow Complete',
              workflowEvent.workflowTitle || 'Workflow finished successfully',
              'normal',
              'emblem-default'  // checkmark icon
            )
            break

          case 'step_failed':
            await sendNotification(
              'OpenCode Workflow - Action Required',
              workflowEvent.message || 'A step has failed',
              'critical',
              'dialog-error'
            )
            break

          case 'workflow_paused':
            await sendNotification(
              'OpenCode Workflow Paused',
              'Human intervention required',
              'critical',
              'dialog-warning'
            )
            break

          case 'gate_transition': {
            const isPassed = workflowEvent.toStatus === 'passed'
            await sendNotification(
              isPassed ? 'Workflow Gate Passed' : 'Workflow Gate Failed',
              workflowEvent.message || `Gate ${workflowEvent.gate || 'unknown'} ${isPassed ? 'passed' : 'failed'}`,
              isPassed ? 'normal' : 'critical',
              isPassed ? 'emblem-default' : 'dialog-error'
            )
            break
          }
        }
      }
    },

    // Custom tool for manual notifications and gate events from supervisor
    tool: {
      workflow_notify: pluginTool({
        description: "Send a workflow notification to the desktop. Can also announce gate transitions.",
        args: {
          title: z.string().describe("Notification title"),
          message: z.string().describe("Notification message"),
          urgency: z.enum(["low", "normal", "critical"]).optional().describe("Notification urgency level"),
          gate: z.string().optional().describe("Gate name if this is a gate transition notification"),
          gateStatus: z.enum(["passed", "failed", "in_progress", "skipped"]).optional().describe("New gate status"),
        },
        async execute(args, context) {
          const title = args?.title || 'OpenCode Workflow'
          const message = args?.message || 'Notification'
          const urgency = (args?.urgency || 'normal') as 'low' | 'normal' | 'critical'

          const notificationPattern = `${title}: ${message}`
          await context.ask({
            permission: 'workflow_notify',
            patterns: [notificationPattern],
            always: [notificationPattern],
            metadata: { sessionID: context.sessionID, title, urgency, gate: args.gate },
          })

          // If gate info provided, use appropriate icon
          let icon = 'dialog-information'
          if (args?.gate) {
            if (args.gateStatus === 'passed') icon = 'emblem-default'
            else if (args.gateStatus === 'failed') icon = 'dialog-error'
            else if (args.gateStatus === 'in_progress') icon = 'dialog-information'
          }

          await sendNotification(title, message, urgency, icon)
          return `Notification sent: ${title} - ${message}`
        }
      })
    }
  }
}

// Default export for OpenCode plugin system
export default WorkflowNotifications
