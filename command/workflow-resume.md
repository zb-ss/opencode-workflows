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
   
   List workflow files in `workflows/active/`
   
   If $ARGUMENTS is empty:
   - If only one active workflow: use it
   - If multiple: show list and ask which to resume
   - If none: report "No active workflows found"
   
   If $ARGUMENTS specifies an ID:
   - Find matching workflow file
   - Report error if not found

2. **Load Workflow State**
   
   Read the workflow org file and extract:
   - Current step (CURRENT_STEP property or first non-DONE step)
   - Step status (FAILED, IN-PROGRESS, or PENDING)
   - Previous outputs/artifacts
   - Any error context from Error Log

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
