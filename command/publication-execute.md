---
description: "Execute an exact guarded-publication artifact: /publication-execute <artifact-id> <artifact-sha256>"
agent: supervisor
model_tier: mid
subtask: false
---

Execute one exact ready guarded-publication artifact.

Input: `$ARGUMENTS`

Require exactly one artifact UUID and one 64-character lowercase SHA-256 digest. If either is missing or malformed, report the syntax and stop. Before calling any tool, restate that this operation can create an external side effect and that ambiguous outcomes are never retried automatically.

Call `workflow_publication_execute` exactly once with the supplied identifiers. The tool revalidates the source and target, requires effective one-shot `ask` authority, obtains a separate external-side-effect approval, and obtains an additional approval for configured protected targets. Report the durable outcome exactly. If it is `ambiguous`, direct the operator to reconcile the external target and use `/publication-status`; do not retry.
