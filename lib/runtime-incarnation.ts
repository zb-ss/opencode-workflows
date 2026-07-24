import { randomUUID } from 'node:crypto'

/** Shared by every epic-writing plugin loaded in this OpenCode process. */
export const WORKFLOW_RUNTIME_INCARNATION = `opencode-runtime-${randomUUID()}`
