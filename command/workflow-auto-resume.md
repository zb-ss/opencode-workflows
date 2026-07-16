---
description: "Resume the automatic workflow owned by this session"
agent: supervisor
model_tier: mid
subtask: false
---

Resume only the declarative automatic workflow owned by the current OpenCode session.

Call `workflow_auto_resume` with no guessed session ID or filesystem path. The tool reloads the saved definition and state, refreshes configured budgets, asks permission for routed child agents, reconciles existing child sessions, and deterministically schedules eligible stages. Report the returned JSON status. If no automatic workflow belongs to this session, say so; do not fall back to manual `/workflow-resume`.
