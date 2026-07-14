/**
 * Shared state management library for workflow hooks.
 * Provides atomic read/write for JSON state files and workflow queries.
 *
 * Security: Path validation prevents directory traversal.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { WorkflowState, SessionBinding, SessionMarker, GateState } from './types.js';
import { ensurePrivateDirectory, getConfigDir, getRuntimeDir, getSessionRuntimeDir, isPathInside } from './paths.ts';

const CONFIG_DIR = getConfigDir();

export const WORKFLOWS_DIR = path.join(CONFIG_DIR, 'workflows');
export const ACTIVE_DIR = path.join(WORKFLOWS_DIR, 'active');
export const COMPLETED_DIR = path.join(WORKFLOWS_DIR, 'completed');
export const PLANS_DIR = path.join(CONFIG_DIR, 'plans');

function sessionBindingPath(sessionId: string): string {
  return path.join(ensurePrivateDirectory(getSessionRuntimeDir(sessionId)), 'binding.json');
}

function sessionMarkerPath(sessionId: string): string {
  return path.join(ensurePrivateDirectory(getSessionRuntimeDir(sessionId)), 'identity.json');
}

/**
 * Validate a file path to prevent traversal attacks.
 * Only allows workflow state below the selected OpenCode config directory.
 */
export function validatePath(inputPath: string | null | undefined): string | null {
  if (!inputPath || typeof inputPath !== 'string') return null;

  if (inputPath.includes('\0')) return null;

  try {
    const resolved = path.resolve(inputPath);
    return isPathInside(WORKFLOWS_DIR, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Read a JSON state file. Returns null on any error.
 */
export function readState(statePath: string): WorkflowState | null {
  const validated = validatePath(statePath);
  if (!validated) return null;

  try {
    const content = fs.readFileSync(validated, 'utf8');
    const raw = JSON.parse(content);
    return normalizeState(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize state from different schema conventions.
 * The supervisor may create state with camelCase keys (workflowId, workflowType)
 * while the enforcer expects snake_case (workflow_id, workflow_type).
 * Also ensures required nested objects exist.
 */
function normalizeState(raw: Record<string, unknown>): WorkflowState {
  const state = raw as WorkflowState & Record<string, unknown>;

  // Normalize camelCase → snake_case field names
  if (!state.workflow_id && state.workflowId) {
    state.workflow_id = state.workflowId as string;
  }
  if (!state.workflow_type && state.workflowType) {
    state.workflow_type = state.workflowType as string;
  }
  if (!state.updated_at && state.updatedAt) {
    state.updated_at = state.updatedAt as string;
  }

  // Ensure phase object exists
  if (!state.phase || typeof state.phase !== 'object') {
    // Try to infer from delegatePhases or phases array
    const phases = (state.delegatePhases || state.phases || []) as string[];
    const gates = (state.gates || {}) as Record<string, { status: string }>;
    const completed = Object.entries(gates)
      .filter(([_, g]) => g.status === 'passed' || g.status === 'skipped')
      .map(([name]) => name);
    const remaining = phases.filter(p => !completed.includes(p));
    state.phase = {
      current: remaining[0] || completed[completed.length - 1] || 'unknown',
      completed,
      remaining,
    };
  }

  // Ensure gates object exists
  if (!state.gates) {
    state.gates = {};
  }

  // Ensure updated_at exists
  if (!state.updated_at) {
    state.updated_at = new Date().toISOString();
  }
  state.schema_version = state.schema_version || 1;
  state.revision = Number.isInteger(state.revision) ? state.revision : 0;
  state.task_ids = state.task_ids || {};
  state.status = state.status || 'running';
  state.driver = state.driver || 'manual';
  state.created_at = state.created_at || state.updated_at;

  return state;
}

/**
 * Write a JSON state file atomically (write to .tmp then rename).
 * Returns true on success, false on error.
 */
export function writeState(statePath: string, obj: WorkflowState): boolean {
  const validated = validatePath(statePath);
  if (!validated) return false;

  const tmpPath = `${validated}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const content = JSON.stringify(obj, null, 2) + '\n';
    fs.mkdirSync(path.dirname(validated), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, validated);
    try { fs.chmodSync(validated, 0o600); } catch {}
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/**
 * Create an initial .state.json for a new workflow.
 * Derives the state file path from the org file path by replacing the extension.
 * Returns the state file path on success, null on error.
 */
export function createInitialState(
  orgFilePath: string,
  workflowId: string,
  workflowType: string,
  mode: string,
  phases: string[],
): string | null {
  const stateFilePath = orgFilePath.replace(/\.(org|md)$/, '.state.json');

  const validated = validatePath(stateFilePath);
  if (!validated) return null;

  // Don't overwrite existing state
  if (fs.existsSync(validated)) return validated;

  const gates: Record<string, { status: 'pending'; iteration: number }> = {};
  for (const phase of phases) {
    gates[phase] = { status: 'pending', iteration: 0 };
  }

  const state: WorkflowState = {
    schema_version: 1,
    revision: 0,
    workflow_id: workflowId,
    workflow_type: workflowType,
    phase: {
      current: phases[0] || 'unknown',
      completed: [],
      remaining: [...phases],
    },
    gates,
    agent_log: [],
    mode: { current: mode },
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    status: 'running',
    driver: 'manual',
    task_ids: {},
    org_file: orgFilePath,
  };

  return writeState(validated, state) ? validated : null;
}

/**
 * Read-modify-write pattern. fn receives current state, returns new state.
 * Automatically updates updated_at. Returns new state or null on error.
 */
export function updateState(
  statePath: string,
  fn: (state: WorkflowState) => WorkflowState | null,
): WorkflowState | null {
  const current = readState(statePath);
  if (!current) return null;

  try {
    const updated = fn(current);
    if (!updated) return null;
    updated.updated_at = new Date().toISOString();
    updated.revision = (current.revision || 0) + 1;
    return writeState(statePath, updated) ? updated : null;
  } catch {
    return null;
  }
}

/**
 * Scan for active .state.json files.
 * Returns array of { path, state } sorted by updated_at descending.
 */
export function findActiveStates(): Array<{ path: string; state: WorkflowState }> {
  try {
    if (!fs.existsSync(ACTIVE_DIR)) return [];

    const files = fs.readdirSync(ACTIVE_DIR)
      .filter(f => f.endsWith('.state.json'));

    const states: Array<{ path: string; state: WorkflowState }> = [];
    for (const file of files) {
      const filePath = path.join(ACTIVE_DIR, file);
      const state = readState(filePath);
      if (state) {
        states.push({ path: filePath, state });
      }
    }

    states.sort((a, b) => {
      const dateA = new Date(a.state.updated_at || '1970-01-01').getTime();
      const dateB = new Date(b.state.updated_at || '1970-01-01').getTime();
      return dateB - dateA;
    });

    return states;
  } catch {
    return [];
  }
}

/**
 * Return the most recently updated active workflow.
 * Returns { path, state } or null.
 */
export function getActiveWorkflow(): { path: string; state: WorkflowState } | null {
  const states = findActiveStates();
  return states.length > 0 ? states[0] : null;
}

/**
 * Write a session marker file so skills can discover the session_id.
 * Writes a private marker below the configured workflow runtime directory.
 */
export function writeSessionMarker(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  const markerPath = sessionMarkerPath(sessionId);
  try {
    const marker: SessionMarker = { session_id: sessionId, timestamp: new Date().toISOString() };
    const content = JSON.stringify(marker) + '\n';
    fs.writeFileSync(markerPath, content, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind a session to a specific workflow.
 * Writes a private session binding below the workflow runtime directory.
 */
export function bindSessionToWorkflow(
  sessionId: string,
  workflowPath: string,
  workflowId: string | null,
): boolean {
  if (!sessionId || !workflowPath) return false;
  const bindingPath = sessionBindingPath(sessionId);
  try {
    const binding: SessionBinding = {
      session_id: sessionId,
      workflow_path: workflowPath,
      workflow_id: workflowId || null,
      bound_at: new Date().toISOString(),
    };
    const content = JSON.stringify(binding) + '\n';
    fs.writeFileSync(bindingPath, content, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the workflow bound to a session.
 * Reads the binding file, loads the state, and returns { path, state }.
 * Returns null when no exact session binding exists.
 */
export function getWorkflowForSession(
  sessionId: string | null | undefined,
): { path: string; state: WorkflowState } | null {
  if (sessionId && typeof sessionId === 'string') {
    const bindingPath = sessionBindingPath(sessionId);
    try {
      if (fs.existsSync(bindingPath)) {
        const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as SessionBinding;
        if (binding.workflow_path) {
          const state = readState(binding.workflow_path);
          if (state && state.status !== 'completed') {
            return { path: binding.workflow_path, state };
          }
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Remove a session binding file.
 */
export function clearSessionBinding(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  const bindingPath = sessionBindingPath(sessionId);
  try {
    if (fs.existsSync(bindingPath)) {
      fs.unlinkSync(bindingPath);
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove every session binding that references one workflow state file. */
export function clearWorkflowBindings(workflowPath: string): number {
  const validated = validatePath(workflowPath);
  if (!validated) return 0;
  const sessionsDirectory = path.join(getRuntimeDir(), 'sessions');
  if (!fs.existsSync(sessionsDirectory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(sessionsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bindingPath = path.join(sessionsDirectory, entry.name, 'binding.json');
    try {
      const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as SessionBinding;
      if (path.resolve(binding.workflow_path) !== validated) continue;
      fs.unlinkSync(bindingPath);
      removed++;
    } catch {
      // Missing or malformed bindings are ignored.
    }
  }
  return removed;
}

/** Move a completed manual workflow's state and companion org file together. */
export function archiveCompletedWorkflow(statePath: string): { state_path: string; org_path: string | null } | null {
  const validated = validatePath(statePath);
  if (!validated || path.dirname(validated) !== path.resolve(ACTIVE_DIR)) return null;
  const state = readState(validated);
  if (!state || !allMandatoryGatesPassed(state)) return null;
  if (!validated.endsWith('.state.json') || !state.org_file) return null;

  ensurePrivateDirectory(COMPLETED_DIR);
  const completedStatePath = path.join(COMPLETED_DIR, path.basename(validated));
  if (fs.existsSync(completedStatePath)) return null;

  const activeOrgPath = validatePath(state.org_file);
  if (!activeOrgPath || path.dirname(activeOrgPath) !== path.resolve(ACTIVE_DIR)) return null;
  const stateStem = path.basename(validated, '.state.json');
  const orgExtension = path.extname(activeOrgPath);
  if (!['.org', '.md'].includes(orgExtension) || path.basename(activeOrgPath, orgExtension) !== stateStem) return null;
  if (!fs.existsSync(activeOrgPath)) return null;
  const completedOrgPath = path.join(COMPLETED_DIR, path.basename(activeOrgPath));
  if (fs.existsSync(completedOrgPath)) return null;

  const completedState: WorkflowState = {
    ...state,
    status: 'completed',
    updated_at: new Date().toISOString(),
    org_file: completedOrgPath,
  };
  if (!writeState(completedStatePath, completedState)) return null;

  try {
    fs.renameSync(activeOrgPath, completedOrgPath);
    fs.unlinkSync(validated);
    return { state_path: completedStatePath, org_path: completedOrgPath };
  } catch {
    try { fs.unlinkSync(completedStatePath); } catch {}
    if (fs.existsSync(completedOrgPath) && !fs.existsSync(activeOrgPath)) {
      try { fs.renameSync(completedOrgPath, activeOrgPath); } catch {}
    }
    return null;
  }
}

/**
 * Check if all mandatory gates have passed.
 * Skipped gates are not mandatory.
 */
export function allMandatoryGatesPassed(state: WorkflowState | null): boolean {
  if (!state || !state.gates) return false;

  for (const [, gate] of Object.entries(state.gates)) {
    if (gate.status === 'skipped') continue;
    if (gate.status !== 'passed') return false;
  }
  return true;
}

/**
 * Get list of gates that are not yet passed or skipped.
 */
export function getPendingGates(
  state: WorkflowState | null,
): Array<{ name: string } & GateState> {
  if (!state || !state.gates) return [];

  return Object.entries(state.gates)
    .filter(([, gate]) => gate.status !== 'passed' && gate.status !== 'skipped')
    .map(([name, gate]) => ({ name, ...gate }));
}

/**
 * Determine the next phase based on remaining phases.
 */
export function getNextPhase(state: WorkflowState | null): string | null {
  if (!state || !state.phase) return null;
  const remaining = state.phase.remaining || [];
  return remaining.length > 0 ? remaining[0] : null;
}

/**
 * Compute a short SHA-256 checksum of the state for integrity verification.
 */
export function computeChecksum(state: WorkflowState | null): string | null {
  if (!state) return null;
  const content = JSON.stringify(state);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Find orphaned org files (org/md files without a corresponding .state.json).
 */
export function findOrphanedOrgFiles(): string[] {
  try {
    if (!fs.existsSync(ACTIVE_DIR)) return [];

    const files = fs.readdirSync(ACTIVE_DIR);
    const orgFiles = files.filter(f => f.endsWith('.org') || f.endsWith('.md'));
    const stateFiles = new Set(
      files.filter(f => f.endsWith('.state.json'))
        .map(f => f.replace('.state.json', ''))
    );

    return orgFiles.filter(f => {
      const base = f.replace(/\.(org|md)$/, '');
      return !stateFiles.has(base);
    }).map(f => path.join(ACTIVE_DIR, f));
  } catch {
    return [];
  }
}
