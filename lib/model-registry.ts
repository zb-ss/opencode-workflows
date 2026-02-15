/**
 * Model capability database and tier resolution.
 * Maps model IDs to capabilities and resolves abstract tiers
 * to concrete models based on user configuration.
 */

import type { ModelCapability, ModelTier, WorkflowUserConfig } from './types.ts';

export const MODEL_REGISTRY: Record<string, ModelCapability> = {
  'glm-5':          { id: 'glm-5', provider: 'zhipu', tier: 'high', contextWindow: 200_000, apiFormat: 'openai', costTier: 'standard' },
  'minimax-m2.5':   { id: 'minimax-m2.5', provider: 'minimax', tier: 'high', contextWindow: 200_000, apiFormat: 'openai', costTier: 'budget' },
  'gemini-3-pro':   { id: 'gemini-3-pro', provider: 'google', tier: 'high', contextWindow: 1_000_000, apiFormat: 'google', costTier: 'standard' },
  'gemini-3-flash': { id: 'gemini-3-flash', provider: 'google', tier: 'mid', contextWindow: 1_000_000, apiFormat: 'google', costTier: 'budget' },
  'gpt-4.1':        { id: 'gpt-4.1', provider: 'openai', tier: 'high', contextWindow: 1_000_000, apiFormat: 'openai', costTier: 'premium' },
  'gpt-4.1-mini':   { id: 'gpt-4.1-mini', provider: 'openai', tier: 'mid', contextWindow: 1_000_000, apiFormat: 'openai', costTier: 'budget' },
  'gpt-4.1-nano':   { id: 'gpt-4.1-nano', provider: 'openai', tier: 'low', contextWindow: 1_000_000, apiFormat: 'openai', costTier: 'budget' },
};

/**
 * Resolve an abstract tier to a concrete model ID using user configuration.
 * Falls back to first model in the tier's list from user config.
 */
export function getModelForTier(tier: ModelTier, userConfig?: WorkflowUserConfig): string | null {
  if (!userConfig?.model_tiers) return null;
  const models = userConfig.model_tiers[tier];
  return models && models.length > 0 ? models[0] : null;
}

/**
 * Get ordered fallback chain for a model from user configuration.
 */
export function getFallbackChain(modelId: string, userConfig?: WorkflowUserConfig): string[] {
  if (!userConfig?.fallback_order) return [modelId];
  // Start with the requested model, then add fallbacks that aren't duplicates
  const chain = [modelId];
  for (const fallback of userConfig.fallback_order) {
    if (!chain.includes(fallback)) {
      chain.push(fallback);
    }
  }
  return chain;
}

/**
 * Check if content should be chunked for a given model based on context window.
 * Returns true if estimated tokens exceed 80% of the model's context window.
 */
export function shouldChunkForModel(modelId: string, estimatedTokens: number): boolean {
  const capability = MODEL_REGISTRY[modelId];
  if (!capability) return false;
  return estimatedTokens > capability.contextWindow * 0.8;
}

/**
 * Look up a model's capabilities from the registry.
 */
export function getModelCapability(modelId: string): ModelCapability | null {
  return MODEL_REGISTRY[modelId] ?? null;
}
