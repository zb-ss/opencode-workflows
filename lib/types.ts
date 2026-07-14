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
  schema_version?: number;
  revision?: number;
  workflow_id: string;
  workflow_type: string;
  phase: WorkflowPhase;
  gates: Record<string, GateState>;
  agent_log: AgentLogEntry[];
  mode: WorkflowMode;
  updated_at: string;
  created_at?: string;
  status?: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  driver?: 'manual' | 'automatic' | 'external_cli';
  owner?: {
    root_session_id: string;
    current_session_id: string;
    project_id?: string;
    directory?: string;
  };
  task_ids?: Record<string, string>;
  stages?: Record<string, WorkflowStageState>;
  budget?: WorkflowBudgetState | null;
  org_file?: string;
  workflow?: {
    type?: string;
    description?: string;
  };
}

export interface WorkflowStageState {
  status: 'pending' | 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
  attempt: number;
  task_id: string | null;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: unknown | null;
  error: string | null;
}

export interface WorkflowBudgetState {
  limits: {
    max_sessions: number;
    max_parallel_sessions: number;
    max_attempts_per_stage: number;
    max_wall_time_ms: number;
    max_input_tokens: number;
    max_output_tokens: number;
    max_cost_usd: number | null;
  };
  usage: {
    sessions: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    started_at: string;
  };
}

export interface SessionBinding {
  session_id: string;
  workflow_path: string;
  workflow_id: string | null;
  bound_at: string;
  project_directory?: string;
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
  plans_dir?: string;
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

// ---------------------------------------------------------------------------
// Delegation Orchestration Types
// ---------------------------------------------------------------------------

export type DelegationProvider = 'claude' | 'gemini'
export type DelegationTaskTag = 'code' | 'ui'
export type DelegationTaskStatus = 'pending' | 'executing' | 'reviewing' | 'passed' | 'failed' | 'merged'

export interface DelegationTask {
  id: string
  description: string
  tag: DelegationTaskTag
  provider: DelegationProvider
  prompt: string
  files: string[]
  worktree_name: string | null
  status: DelegationTaskStatus
  attempt: number
  max_attempts: number
  review_feedback: string | null
  run_id: string | null
  session_id: string | null
  worktree_path: string | null
  branch_name: string | null
  created_at: string
  updated_at: string
}

export interface DelegationPlan {
  workflow_id: string
  feature_branch: string
  tasks: DelegationTask[]
  max_parallel: number
  created_at: string
}

export interface WorktreeState {
  name: string
  path: string
  branch: string
  task_id: string
  provider: DelegationProvider
  status: 'active' | 'completed' | 'failed' | 'merged' | 'discarded'
  created_at: string
  merged_at: string | null
}

export interface DelegationRoutingConfig {
  ui_patterns: string[]
  default_provider: DelegationProvider
}

export interface DelegationProviderConfig {
  model?: string
  timeout_ms?: number
  permission_mode?: string
}

export interface DelegationOrchestratorConfig {
  claude: DelegationProviderConfig
  gemini: DelegationProviderConfig
  max_parallel: number
  routing: DelegationRoutingConfig
  fallback_order: DelegationProvider[]
  max_review_iterations: number
  auto_init_files: boolean
  max_output_bytes: number
}

export const DELEGATE_PHASE_ORDER: string[] = [
  'planning',
  'decomposition',
  'execution',
  'review',
  'merge',
  'quality_gate',
  'completion_guard',
]
