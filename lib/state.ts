/**
 * Shared state management library for workflow hooks.
 * Provides atomic read/write for JSON state files and workflow queries.
 *
 * Security: Path validation prevents directory traversal.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import type { WorkflowState, SessionBinding, SessionMarker, GateState } from './types.js';

const xdg = process.env.XDG_CONFIG_HOME;
const CONFIG_DIR = xdg
  ? path.join(xdg, 'opencode')
  : path.join(os.homedir(), '.config', 'opencode');

export const WORKFLOWS_DIR = path.join(CONFIG_DIR, 'workflows');
export const ACTIVE_DIR = path.join(WORKFLOWS_DIR, 'active');
export const COMPLETED_DIR = path.join(WORKFLOWS_DIR, 'completed');

/**
 * Validate a file path to prevent traversal attacks.
 * Only allows paths under ~/.config/opencode/workflows/ or os.tmpdir().
 */
export function validatePath(inputPath: string | null | undefined): string | null {
  if (!inputPath || typeof inputPath !== 'string') return null;

  const dangerousPatterns = [
    /\.\.[\/\\]/,
    /[<>|"'`$(){}]/,
    /\0/,
    /^[\/\\]{2}/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(inputPath)) return null;
  }

  try {
    const resolved = path.resolve(inputPath);
    const allowedRoots = [
      path.resolve(WORKFLOWS_DIR),
      path.resolve(os.tmpdir()),
    ];

    const isAllowed = allowedRoots.some(root => {
      const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
      return resolved === root || resolved.startsWith(normalizedRoot);
    });

    return isAllowed ? resolved : null;
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
    return JSON.parse(content) as WorkflowState;
  } catch {
    return null;
  }
}

/**
 * Write a JSON state file atomically (write to .tmp then rename).
 * Returns true on success, false on error.
 */
export function writeState(statePath: string, obj: WorkflowState): boolean {
  const validated = validatePath(statePath);
  if (!validated) return false;

  const tmpPath = validated + '.tmp';
  try {
    const content = JSON.stringify(obj, null, 2) + '\n';
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, validated);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
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
 * Writes /tmp/workflow-session-marker-{sessionId}.json.
 */
export function writeSessionMarker(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  const markerPath = path.join(os.tmpdir(), `workflow-session-marker-${sessionId}.json`);
  try {
    const marker: SessionMarker = { session_id: sessionId, timestamp: new Date().toISOString() };
    const content = JSON.stringify(marker) + '\n';
    fs.writeFileSync(markerPath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind a session to a specific workflow.
 * Writes /tmp/workflow-binding-{sessionId}.json.
 */
export function bindSessionToWorkflow(
  sessionId: string,
  workflowPath: string,
  workflowId: string | null,
): boolean {
  if (!sessionId || !workflowPath) return false;
  const bindingPath = path.join(os.tmpdir(), `workflow-binding-${sessionId}.json`);
  try {
    const binding: SessionBinding = {
      session_id: sessionId,
      workflow_path: workflowPath,
      workflow_id: workflowId || null,
      bound_at: new Date().toISOString(),
    };
    const content = JSON.stringify(binding) + '\n';
    fs.writeFileSync(bindingPath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the workflow bound to a session.
 * Reads the binding file, loads the state, and returns { path, state }.
 * Falls back to getActiveWorkflow() if no binding exists.
 */
export function getWorkflowForSession(
  sessionId: string | null | undefined,
): { path: string; state: WorkflowState } | null {
  if (sessionId && typeof sessionId === 'string') {
    const bindingPath = path.join(os.tmpdir(), `workflow-binding-${sessionId}.json`);
    try {
      if (fs.existsSync(bindingPath)) {
        const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as SessionBinding;
        if (binding.workflow_path) {
          const state = readState(binding.workflow_path);
          if (state) {
            return { path: binding.workflow_path, state };
          }
        }
      }
    } catch {
      // Fall through to getActiveWorkflow()
    }
  }
  return getActiveWorkflow();
}

/**
 * Remove a session binding file.
 */
export function clearSessionBinding(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== 'string') return false;
  const bindingPath = path.join(os.tmpdir(), `workflow-binding-${sessionId}.json`);
  try {
    if (fs.existsSync(bindingPath)) {
      fs.unlinkSync(bindingPath);
    }
    return true;
  } catch {
    return false;
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
