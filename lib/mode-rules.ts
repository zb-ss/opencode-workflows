/**
 * Mode constraint definitions and agent-to-gate mappings.
 * Ported from Claude Code plugin hooks/lib/mode-rules.js
 * with model names replaced by abstract tiers.
 */

import type { ModelTier, TierConstraints } from './types.ts';

/**
 * Tier constraints per mode.
 * forbidden: tiers that CANNOT be used in this mode
 * preferred: the default tier for this mode
 */
export const TIER_CONSTRAINTS: Record<string, TierConstraints> = {
  eco: {
    forbidden: ['high'],
    preferred: 'low',
    description: 'Budget-conscious, low tier only',
  },
  turbo: {
    forbidden: ['high'],
    preferred: 'low',
    description: 'Speed-first, no high tier',
  },
  standard: {
    forbidden: [],
    preferred: 'mid',
    description: 'Balanced, mid tier default',
  },
  thorough: {
    forbidden: [],
    preferred: 'mid',
    description: 'Quality-first, high tier for reviews',
  },
  swarm: {
    forbidden: [],
    preferred: 'mid',
    description: 'Parallel execution, high tier for validation',
  },
};

/**
 * Maps agent type to gate names in the state file.
 * Used by workflow-enforcer plugin to update gate status.
 */
export const AGENT_GATE_MAP: Record<string, string> = {
  'architect': 'planning',
  'architect-lite': 'planning',
  'executor': 'implementation',
  'executor-lite': 'implementation',
  'reviewer': 'code_review',
  'reviewer-lite': 'code_review',
  'reviewer-deep': 'code_review',
  'security': 'security_review',
  'security-lite': 'security_review',
  'security-deep': 'security_review',
  'test-writer': 'tests',
  'quality-gate': 'quality_gate',
  'completion-guard': 'completion_guard',
  'perf-reviewer': 'performance',
  'perf-lite': 'performance',
  'doc-writer': 'documentation',
  'codebase-analyzer': 'codebase_analysis',
  'explorer': 'exploration',
  'e2e-explorer': 'e2e_exploration',
  'e2e-generator': 'e2e_generation',
  'e2e-reviewer': 'e2e_validation',
};

/**
 * Canonical phase ordering for standard workflows.
 */
export const PHASE_ORDER: string[] = [
  'planning',
  'implementation',
  'code_review',
  'security_review',
  'tests',
  'quality_gate',
  'completion_guard',
];

/**
 * E2E testing workflow phase ordering.
 */
export const E2E_PHASE_ORDER: string[] = [
  'setup',
  'e2e_exploration',
  'e2e_generation',
  'e2e_validation',
  'quality_gate',
  'completion_guard',
];

/**
 * Check if a tier is forbidden for a given mode.
 */
export function isTierForbidden(mode: string, tier: ModelTier): boolean {
  const constraints = TIER_CONSTRAINTS[mode];
  if (!constraints) return false;
  return constraints.forbidden.includes(tier);
}

/**
 * Get the gate name for an agent type.
 */
export function getGateForAgent(agentType: string): string | null {
  return AGENT_GATE_MAP[agentType] ?? null;
}

/**
 * Get the preferred tier for a mode.
 */
export function getPreferredTier(mode: string): ModelTier {
  const constraints = TIER_CONSTRAINTS[mode];
  return constraints ? constraints.preferred : 'mid';
}
