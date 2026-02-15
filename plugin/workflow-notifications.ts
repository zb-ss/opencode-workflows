/**
 * OpenCode Workflow Notifications Plugin
 * 
 * Sends desktop notifications for workflow events using notify-send (Linux).
 * 
 * Events handled:
 * - session.idle: Detects workflow step completions
 * - message.updated: Tracks workflow progress markers
 * 
 * Notification types:
 * - Step completed: Informational notification
 * - Workflow completed: Success notification with summary
 * - Step failed: Critical notification requiring attention
 */

import type { Plugin } from "@opencode-ai/plugin"
import { getActiveWorkflow, getPendingGates, allMandatoryGatesPassed } from '../lib/state.ts'
import type { GateStatus } from '../lib/types.ts'

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
  $: any,
  title: string,
  body: string,
  urgency: 'low' | 'normal' | 'critical' = 'normal',
  icon: string = 'dialog-information'
): Promise<void> {
  try {
    // Guard against undefined/null values
    const safeTitle = title || 'OpenCode Notification'
    const safeBody = body || ''
    
    // Escape special characters
    const escapedBody = safeBody.replace(/"/g, '\\"').replace(/\$/g, '\\$')
    const escapedTitle = safeTitle.replace(/"/g, '\\"').replace(/\$/g, '\\$')
    
    await $`notify-send "${escapedTitle}" "${escapedBody}" --urgency=${urgency} --icon=${icon}`
  } catch (error) {
    // Silently fail if notify-send is not available
    console.error('Failed to send notification:', error)
  }
}

/**
 * Main plugin export
 */
export const WorkflowNotifications: Plugin = async ({ $, client }) => {
  // Track seen events to avoid duplicate notifications
  const seenEvents = new Set<string>()
  // Track gate states for transition detection
  const lastGateStates = new Map<string, GateStatus>()

  return {
    event: async ({ event }) => {
      // Handle session idle events - check for gate transitions
      if (event.type === "session.idle") {
        try {
          const active = getActiveWorkflow()
          if (active) {
            const { state } = active
            for (const [gateName, gate] of Object.entries(state.gates || {})) {
              const prev = lastGateStates.get(gateName)
              if (prev && prev !== gate.status) {
                // Gate transition detected
                const eventKey = `gate-${gateName}-${gate.status}-${state.updated_at}`
                if (!seenEvents.has(eventKey)) {
                  seenEvents.add(eventKey)

                  if (gate.status === 'passed') {
                    await sendNotification($, 'Workflow Gate Passed', `${gateName} passed`, 'normal', 'emblem-default')
                  } else if (gate.status === 'failed') {
                    await sendNotification($, 'Workflow Gate Failed', `${gateName} failed - iteration ${gate.iteration}`, 'critical', 'dialog-error')
                  }
                }
              }
              lastGateStates.set(gateName, gate.status)
            }

            // Check if all gates just passed
            if (allMandatoryGatesPassed(state)) {
              const completeKey = `workflow-complete-${state.workflow_id}`
              if (!seenEvents.has(completeKey)) {
                seenEvents.add(completeKey)
                await sendNotification($, 'Workflow Complete', `${state.workflow_id} - all gates passed`, 'normal', 'emblem-default')
              }
            }
          }
        } catch {
          // Gate detection is best-effort
        }
      }

      // Handle message updates - detect workflow markers in real-time
      if (event.type === "message.updated") {
        const messageId = event.properties?.messageID
        const content = event.properties?.content || ''
        
        // Skip if we've already processed this message
        if (messageId && seenEvents.has(messageId)) {
          return
        }
        
        // Parse the message for workflow events
        const workflowEvent = parseWorkflowEvent(content)
        if (!workflowEvent) {
          return
        }

        // Mark as seen
        if (messageId) {
          seenEvents.add(messageId)
          
          // Clean up old entries (keep last 100)
          if (seenEvents.size > 100) {
            const entries = Array.from(seenEvents)
            entries.slice(0, 50).forEach(e => seenEvents.delete(e))
          }
        }

        // Send appropriate notification
        switch (workflowEvent.type) {
          case 'step_complete':
            await sendNotification(
              $,
              'OpenCode Workflow',
              `Step completed: ${workflowEvent.stepName}`,
              'normal',
              'dialog-information'
            )
            break

          case 'workflow_complete':
            await sendNotification(
              $,
              'OpenCode Workflow Complete',
              workflowEvent.workflowTitle || 'Workflow finished successfully',
              'normal',
              'emblem-default'  // checkmark icon
            )
            break

          case 'step_failed':
            await sendNotification(
              $,
              'OpenCode Workflow - Action Required',
              workflowEvent.message || 'A step has failed',
              'critical',
              'dialog-error'
            )
            break

          case 'workflow_paused':
            await sendNotification(
              $,
              'OpenCode Workflow Paused',
              'Human intervention required',
              'critical',
              'dialog-warning'
            )
            break

          case 'gate_passed':
          case 'gate_failed':
          case 'gate_transition': {
            const isPassed = workflowEvent.toStatus === 'passed' || workflowEvent.type === 'gate_passed'
            await sendNotification(
              $,
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
      workflow_notify: {
        description: "Send a workflow notification to the desktop. Can also announce gate transitions.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Notification title"
            },
            message: {
              type: "string",
              description: "Notification message"
            },
            urgency: {
              type: "string",
              enum: ["low", "normal", "critical"],
              description: "Notification urgency level"
            },
            gate: {
              type: "string",
              description: "Gate name if this is a gate transition notification"
            },
            gateStatus: {
              type: "string",
              enum: ["passed", "failed", "in_progress", "skipped"],
              description: "New gate status"
            }
          },
          required: ["title", "message"]
        },
        async execute(args: { title?: string; message?: string; urgency?: string; gate?: string; gateStatus?: string }) {
          const title = args?.title || 'OpenCode Workflow'
          const message = args?.message || 'Notification'
          const urgency = (args?.urgency || 'normal') as 'low' | 'normal' | 'critical'

          // If gate info provided, use appropriate icon
          let icon = 'dialog-information'
          if (args?.gate) {
            if (args.gateStatus === 'passed') icon = 'emblem-default'
            else if (args.gateStatus === 'failed') icon = 'dialog-error'
            else if (args.gateStatus === 'in_progress') icon = 'dialog-information'
          }

          await sendNotification($, title, message, urgency, icon)
          return `Notification sent: ${title} - ${message}`
        }
      }
    }
  }
}

// Default export for OpenCode plugin system
export default WorkflowNotifications
