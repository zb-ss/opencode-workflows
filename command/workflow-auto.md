---
description: "Start opt-in automatic workflow: /workflow-auto <development|e2e> <task> [--mode=<mode>]"
agent: supervisor
model_tier: mid
subtask: false
---

Start an explicitly requested declarative automatic workflow.

Input: `$ARGUMENTS`

Parse the first word as `development` or `e2e`. Parse an optional `--mode=eco|turbo|standard|thorough|swarm`; everything else is the task. If the type or task is missing, ask for it. Do not invoke the manual `/workflow` flow and do not create child tasks yourself.

Call `workflow_auto_start` exactly once with the parsed `workflow_type`, `task`, and optional `mode`. The tool validates the DAG, checks `automation.enabled`, requests child-task permissions, saves session-owned definition/state files, and starts eligible stages. Report its JSON result, including any paused or disabled reason.
