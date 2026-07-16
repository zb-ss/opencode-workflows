---
description: "Resume workflow: /workflow-resume [workflow-id]"
agent: supervisor
model_tier: mid
subtask: false
---

Resume a paused or interrupted workflow.

## Usage
```
/workflow-resume [workflow-id]
```

Without workflow-id: resumes the most recent active workflow
With workflow-id: resumes the specified workflow

## Examples
```
/workflow-resume
/workflow-resume wf-2025-12-06-001
```

## Your Task

You are the supervisor agent. Resume an interrupted workflow.

**Requested ID**: $ARGUMENTS (may be empty)

### Instructions

1. **Find Active Workflow(s)**

   Resolve `<CONFIG_DIR>` from `OPENCODE_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/opencode`, otherwise `$HOME/.config/opencode`.
   Scan `<CONFIG_DIR>/workflows/active/` for `.state.json` files.
   These are the machine-readable tracking files — each has a companion `.org` file.

   If no `.state.json` files found, check for orphaned `.org` files (org files
   without a matching `.state.json`). If found, report them and suggest running
   `/workflow` to recreate the tracking state.

   If $ARGUMENTS is empty:
   - If only one active workflow: use it
   - If multiple: show list and ask which to resume
   - If none: report "No active workflows found"

   If $ARGUMENTS specifies an ID:
   - Find the matching `.state.json` file (check `workflow_id` field)
   - Report error if not found

2. **Load Workflow State**

   Read the `.state.json` file and extract:
   - Current phase from `phase.current`
   - Gate statuses from `gates` object
   - Stored Task IDs for each gate from `task_ids`, when present
   - Execution mode from `mode.current`
   - Companion `.org` file path from `org_file`

   Also read the `.org` file for human-readable context:
   - Previous outputs/artifacts from step properties
   - Any error context from Error Log section

   Before changing any gate or resuming any Task, call `workflow_resume_session` with the selected absolute `.state.json` path and exact workflow ID. This explicit permission-gated handoff must succeed. Do not call `workflow_bind_session` to take over an existing workflow, and do not continue from an inherited child-session binding.

3. **Report Status to User**
   
   Show:
   - Workflow title and ID
   - Current step and its status
   - What happened (if FAILED)
   - What will happen when resumed

4. **Handle Based on Status**
   
   If current step is FAILED:
   - Ask: "The previous attempt failed. Ready to retry? (yes/no)"
   - On yes: reset step to IN-PROGRESS and call the native Task tool with the gate's stored `task_id` plus a correction prompt
   - If no Task ID was persisted, start a new Task call and record the returned ID
   - On no: keep paused
   
   If current step is IN-PROGRESS:
   - This means it was interrupted mid-execution
   - If a Task ID is stored, ask: "Step was interrupted. Resume the existing task? (yes/no)"
   - On yes: call the native Task tool with the stored `task_id` and a concise continuation prompt
   - If no Task ID is stored, ask whether to restart the step with a new Task call and then record its returned ID
   - On no: keep paused
   
   If current step is PENDING:
   - Normal case, start the step

5. **Continue Execution**
   
   - Update workflow state file
   - Execute the current step with the native Task tool; never use an `@wf-*` mention
   - Preserve and reuse each gate's `task_id` for context-limit recovery and review corrections
   - Continue with remaining steps
   - Follow same protocol as /workflow for completions and errors

Begin by finding and reporting active workflow status.
