---
description: Resume an interrupted workflow
agent: supervisor
model_tier: mid
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

   Resolve the config directory: run `echo $HOME` then use `<HOME>/.config/opencode`.
   Scan `<HOME>/.config/opencode/workflows/active/` for `.state.json` files.
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
   - Execution mode from `mode.current`
   - Companion `.org` file path from `org_file`

   Also read the `.org` file for human-readable context:
   - Previous outputs/artifacts from step properties
   - Any error context from Error Log section

3. **Report Status to User**
   
   Show:
   - Workflow title and ID
   - Current step and its status
   - What happened (if FAILED)
   - What will happen when resumed

4. **Handle Based on Status**
   
   If current step is FAILED:
   - Ask: "The previous attempt failed. Ready to retry? (yes/no)"
   - On yes: reset step to IN-PROGRESS and retry
   - On no: keep paused
   
   If current step is IN-PROGRESS:
   - This means it was interrupted mid-execution
   - Ask: "Step was interrupted. Restart from beginning? (yes/no)"
   - On yes: restart the step
   - On no: keep paused
   
   If current step is PENDING:
   - Normal case, start the step

5. **Continue Execution**
   
   - Update workflow state file
   - Execute the current step
   - Continue with remaining steps
   - Follow same protocol as /workflow for completions and errors

Begin by finding and reporting active workflow status.
