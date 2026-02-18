/**
 * Shared type definitions for OpenCode Workflows v2.
 * All plugins and lib modules import from here.
 */

// Gate status lifecycle: pending -> in_progress -> passed|failed|skipped
export type GateStatus = 'pending' | 'in_progress' | 'passed' | 'failed' | 'skipped';

export interface GateState {
  status: GateStatus;
  iteration: number;
}

export interface AgentLogEntry {
  timestamp: string;
  agent_type: string;
  gate: string;
  verdict: string;
  iteration: number;
  agent_id: string | null;
}

export interface WorkflowPhase {
  current: string;
  completed: string[];
  remaining: string[];
}

export interface WorkflowMode {
  current: string;
}

export interface WorkflowState {
  workflow_id: string;
  workflow_type: string;
  phase: WorkflowPhase;
  gates: Record<string, GateState>;
  agent_log: AgentLogEntry[];
  mode: WorkflowMode;
  updated_at: string;
  org_file?: string;
  workflow?: {
    type?: string;
    description?: string;
  };
}

export interface SessionBinding {
  session_id: string;
  workflow_path: string;
  workflow_id: string | null;
  bound_at: string;
}

export interface SessionMarker {
  session_id: string;
  timestamp: string;
}

export type ModelTier = 'low' | 'mid' | 'high';
export type ApiFormat = 'openai' | 'google';
export type CostTier = 'budget' | 'standard' | 'premium';

export interface ModelCapability {
  id: string;
  provider: string;
  tier: ModelTier;
  contextWindow: number;
  apiFormat: ApiFormat;
  costTier: CostTier;
}

export interface TierConstraints {
  forbidden: ModelTier[];
  preferred: ModelTier;
  description: string;
}

export interface ModeEscalation {
  review_after: number;
  review_escalate_to: string;
  security_after: number;
  security_escalate_to: string;
}

export interface SwarmConfig {
  max_parallel_executors: number;
  max_parallel_reviewers: number;
  max_parallel_security: number;
  validation_architects: number;
}

export interface ModeSettings {
  max_review_iterations: number;
  max_security_iterations: number;
  max_quality_gate_iterations: number;
  max_completion_guard_iterations: number;
  parallel_execution: boolean;
  test_required: boolean;
  escalation?: ModeEscalation;
  swarm?: SwarmConfig;
}

export interface ModeConfig {
  name: string;
  description: string;
  agent_routing: Record<string, string>;
  model_tiers: { forbidden: ModelTier[] };
  settings: ModeSettings;
}

/**
 * OpenCode Plugin input type (from @opencode-ai/plugin).
 * Provided to every plugin function.
 */
export interface PluginInput {
  client: any; // SDK client
  project: any;
  directory: string;
  worktree: string;
  serverUrl: string;
  $: any; // BunShell
}

/**
 * Swarm mode parallel execution settings from workflows.json.
 * Controls concurrency limits, staleness detection, and polling intervals.
 */
export interface SwarmUserConfig {
  default_concurrency?: number;
  stale_timeout_ms?: number;
  poll_interval_ms?: number;
  provider_concurrency?: Record<string, number>;
  progress_timeout_ms?: number;
}

/**
 * Workflow user config from workflows.json.
 */
export interface WorkflowUserConfig {
  model_tiers: {
    low: string[];
    mid: string[];
    high: string[];
  };
  agent_models?: Record<string, string>;
  fallback_order: string[];
  default_mode: string;
  swarm_config?: SwarmUserConfig;
}

/**
 * A session actively tracked by the swarm manager.
 * Used for concurrency management and staleness detection.
 */
export interface TrackedSession {
  sessionId: string;
  taskId: string;
  agent: string;
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  lastMessageCount: number;
  lastProgressAt: number;
}

/**
 * Result from workflow_check_completion tool.
 */
export interface CompletionCheckResult {
  canComplete: boolean;
  pendingGates: Array<{ name: string; status: GateStatus; iteration: number }>;
  reason?: string;
}

/**
 * Swarm batch task definition.
 */
export interface SwarmTask {
  id: string;
  agent: string;
  prompt: string;
  model?: string;
}

/**
 * Swarm batch tracking.
 */
export interface SwarmBatch {
  batchId: string;
  sessions: Map<string, { sessionId: string; taskId: string; status: string }>;
  createdAt: string;
}
