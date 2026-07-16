---
description: "Inspect guarded-publication artifacts: /publication-status [artifact-id]"
agent: supervisor
model_tier: low
subtask: false
---

Inspect local guarded-publication artifacts and execution outcomes for the automatic workflow owned by this root session.

Input: `$ARGUMENTS`

Accept either no argument or one artifact UUID. Call `workflow_publication_status` exactly once. Report ready, blocked, expired, succeeded, and ambiguous states accurately. A persisted `dispatching` event is an ambiguous external outcome after restart; never describe it as failed or retry it automatically.
