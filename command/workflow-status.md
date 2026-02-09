---
description: Show status of active workflows
agent: supervisor
model: anthropic/claude-sonnet-4-5
---

Display the status of active workflows.

## Usage
```
/workflow-status [workflow-id]
```

Without workflow-id: shows all active workflows
With workflow-id: shows detailed status of specific workflow

## Examples
```
/workflow-status
/workflow-status wf-2025-12-06-001
```

## Your Task

You are the supervisor agent. Report workflow status.

**Requested ID**: $ARGUMENTS (may be empty)

### Instructions

1. **Find Workflows**
   
   List all `.org` files in `workflows/active/`
   
   If $ARGUMENTS is empty: report on all
   If $ARGUMENTS specifies ID: find and report on that one

2. **For Each Workflow, Extract**:
   
   From the org file headers:
   - #+TITLE: workflow title
   - #+WORKFLOW_ID: unique identifier
   - #+WORKFLOW_TYPE: type (feature/figma/etc)
   - #+STATUS: current status
   - #+CURRENT_STEP: which step is active
   - #+BRANCH: git branch
   - :CREATED: timestamp
   - :LAST_UPDATED: timestamp

3. **Parse Step Status**
   
   For each step section (* TODO/IN-PROGRESS/DONE):
   - Name and status
   - Timestamps if available
   - Any output summary

4. **Generate Status Report**

   **Summary View (multiple workflows)**:
   ```
   Active Workflows: 2

   1. Feature: Add user authentication
      ID: wf-2025-12-06-001
      Status: IN-PROGRESS
      Step: 3/7 (Implementation)
      Branch: feature/user-auth
      Last activity: 10 minutes ago

   2. Figma: Dashboard header
      ID: wf-2025-12-06-002
      Status: PAUSED
      Step: 2/6 (Implementation) - FAILED
      Branch: feature/dashboard
      Last activity: 2 hours ago
   ```

   **Detailed View (single workflow)**:
   ```
   Workflow: Feature Development - Add user authentication
   ID: wf-2025-12-06-001
   Type: feature
   Status: IN-PROGRESS
   Branch: feature/user-auth
   Started: 2025-12-06 10:30
   Last Updated: 2025-12-06 14:22

   Progress:
   [X] Step 1: Planning - DONE (15m)
       Output: plans/2025-12-06-user-auth.org
   [X] Step 2: Implementation - DONE (2h 15m)
       Changes: 12 files modified
   [>] Step 3: Broad Review - IN-PROGRESS (started 10m ago)
   [ ] Step 4: Test Writing - PENDING
   [ ] Step 5: E2E Testing - PENDING
   [ ] Step 6: Security Audit - PENDING
   [ ] Step 7: Final Commit - PENDING

   Recent Log:
   [14:22] Step 2 completed - implementation finished
   [14:25] Step 3 started - broad review

   To resume if paused: /workflow-resume wf-2025-12-06-001
   ```

5. **Handle Edge Cases**
   
   - No active workflows: "No active workflows. Start one with /workflow <type> <description>"
   - Workflow ID not found: "Workflow not found. Active workflows: [list]"

Report the status now.
