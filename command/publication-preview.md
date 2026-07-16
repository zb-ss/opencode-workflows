---
description: "Preview guarded publication: /publication-preview <configured-target>"
agent: supervisor
model_tier: mid
subtask: false
---

Create a local guarded-publication preview for a completed automatic workflow.

Input: `$ARGUMENTS`

Require exactly one configured target identifier. If it is missing, report the syntax and stop. Call `workflow_publication_preview` exactly once. This performs no external side effect, but it must request preview authority, pin the source, publisher, and target identities, scan all Git history reachable from the publication head, and persist an immutable expiring artifact.

Report the exact returned target, refs, source object IDs, gates, scan counts, findings, expiry, `artifact_id`, and `artifact_sha256`. Findings are redacted metadata, not source excerpts. Do not execute a blocked artifact, modify configuration to bypass a gate, or call the execution tool automatically.
