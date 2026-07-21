export { stableCanonicalJson } from './epic-canonical-json.ts'
export {
  EPIC_BUDGET_DIMENSIONS,
  EPIC_SCHEMA_VERSION,
  EPIC_STATE_SCHEMA_ID,
  EpicAttemptSchema,
  EpicBudgetDimensionSchema,
  EpicBudgetExtensionSchema,
  EpicBudgetRecordSchema,
  EpicBudgetScopeSchema,
  EpicBudgetUpdateSchema,
  EpicIntegrationEventSchema,
  EpicItemSchema,
  EpicSchemaVersionError,
  EpicScopedUsageSchema,
  EpicValidationError,
} from './epic-contract-schemas.ts'
export type {
  EpicAttempt,
  EpicAttemptStatus,
  EpicBudgetDimension,
  EpicBudgetExtension,
  EpicBudgetRecord,
  EpicBudgetScope,
  EpicBudgetUpdate,
  EpicIdentity,
  EpicIntegrationEvent,
  EpicItem,
  EpicItemStatus,
  EpicScopedUsage,
  EpicState,
  EpicStatus,
} from './epic-contract-schemas.ts'
export {
  deriveEpicWorktreeIdentity,
  EpicWorktreeEvidenceSchema,
  parseEpicWorktreeEvidence,
} from './epic-worktree-contracts.ts'
export type { EpicWorktreeEvidence, EpicWorktreeIdentity } from './epic-worktree-contracts.ts'
export {
  epicBudgetDecision,
  effectiveEpicItemLimit,
  emptyAutomationUsageTelemetry,
  projectEpicBudgetStatus,
} from './epic-budget-usage.ts'
export type {
  EpicBudgetDecision,
  EpicBudgetDecisionCounts,
  EpicBudgetDimensionStatus,
  EpicBudgetStatus,
} from './epic-budget-usage.ts'
export {
  deterministicEpicOrder,
  EpicStateSchema,
  validateEpicDag,
  validateEpicGenesisState,
  validateEpicState,
  validateEpicTransitions,
} from './epic-dag-state-validation.ts'
export {
  computeDependencySnapshotDigest,
  computeEpicIdentityDigest,
  computeIntegrationEventDigest,
  projectIdentitySha256,
} from './epic-integration-digests.ts'
export {
  transitionEpicItemToConflicted,
  transitionEpicItemToIntegrated,
  validateEpicRecoveryTransition,
  validateEpicTransition,
} from './epic-transitions.ts'
export { EpicConfigSchema, parseEpicConfig } from './epic-policy.ts'
export type { EpicConfig, EpicOperationalLimits } from './epic-policy.ts'
