export interface ModelCandidate {
  model: string
  variant?: string
}

export type ConfiguredModelCandidate = string | ModelCandidate

export interface CatalogModel {
  variants: ReadonlySet<string>
  status?: string
  context?: number
}

export type ModelCatalog = ReadonlyMap<string, CatalogModel>

export interface CandidateDiagnostic {
  candidate: ModelCandidate
  available: boolean
  reason: 'available' | 'model_unavailable' | 'variant_unavailable'
  available_variants?: string[]
}

export interface ModelSelectionResult {
  selected: ModelCandidate | null
  diagnostics: CandidateDiagnostic[]
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function normalizeModelCandidate(candidate: ConfiguredModelCandidate): ModelCandidate {
  return typeof candidate === 'string' ? { model: candidate } : { ...candidate }
}

export function validateModelCandidate(candidate: ConfiguredModelCandidate): ModelCandidate {
  const normalized = normalizeModelCandidate(candidate)
  if (!MODEL_ID_PATTERN.test(normalized.model)) {
    throw new Error(`invalid model identifier: ${normalized.model}`)
  }
  if (normalized.variant !== undefined && !VARIANT_PATTERN.test(normalized.variant)) {
    throw new Error(`invalid model variant: ${normalized.variant}`)
  }
  return normalized
}

export function uniqueModelCandidates(candidates: readonly ConfiguredModelCandidate[]): ModelCandidate[] {
  const unique = new Map<string, ModelCandidate>()
  for (const configured of candidates) {
    const candidate = validateModelCandidate(configured)
    const key = `${candidate.model}\0${candidate.variant ?? ''}`
    if (!unique.has(key)) unique.set(key, candidate)
  }
  return [...unique.values()]
}

/**
 * Select the first configured model and variant present in the live catalog.
 * Every rejected candidate is retained as a diagnostic so callers can explain
 * the exact fallback decision without inferring capability from model names.
 */
export function selectAvailableModelCandidate(
  candidates: readonly ConfiguredModelCandidate[],
  catalog: ModelCatalog,
): ModelSelectionResult {
  const diagnostics: CandidateDiagnostic[] = []

  for (const candidate of uniqueModelCandidates(candidates)) {
    const model = catalog.get(candidate.model)
    if (!model) {
      diagnostics.push({ candidate, available: false, reason: 'model_unavailable' })
      continue
    }

    if (candidate.variant && !model.variants.has(candidate.variant)) {
      diagnostics.push({
        candidate,
        available: false,
        reason: 'variant_unavailable',
        available_variants: [...model.variants].sort(),
      })
      continue
    }

    diagnostics.push({ candidate, available: true, reason: 'available' })
    return { selected: candidate, diagnostics }
  }

  return { selected: null, diagnostics }
}

/** Build an availability catalog from OpenCode's config.providers response. */
export function modelCatalogFromProviders(response: unknown): Map<string, CatalogModel> {
  const payload = unwrapProviderPayload(response)
  const catalog = new Map<string, CatalogModel>()

  for (const provider of payload.providers) {
    if (!provider || typeof provider !== 'object') continue
    const providerRecord = provider as Record<string, unknown>
    const providerId = typeof providerRecord.id === 'string' ? providerRecord.id : null
    if (!providerId) continue

    const models = providerRecord.models
    const entries = Array.isArray(models)
      ? models.map((model) => [undefined, model] as const)
      : models && typeof models === 'object'
        ? Object.entries(models as Record<string, unknown>)
        : []

    for (const [key, value] of entries) {
      if (!value || typeof value !== 'object') continue
      const model = value as Record<string, unknown>
      const modelId = typeof model.id === 'string' ? model.id : key
      if (!modelId) continue

      const variants = new Set<string>()
      if (model.variants && typeof model.variants === 'object') {
        for (const [name, options] of Object.entries(model.variants as Record<string, unknown>)) {
          const isDisabled = Boolean(
            options && typeof options === 'object' && (options as Record<string, unknown>).disabled === true,
          )
          if (!isDisabled) variants.add(name)
        }
      }

      const limit = model.limit && typeof model.limit === 'object'
        ? model.limit as Record<string, unknown>
        : null
      catalog.set(`${providerId}/${modelId}`, {
        variants,
        ...(typeof model.status === 'string' ? { status: model.status } : {}),
        ...(typeof limit?.context === 'number' ? { context: limit.context } : {}),
      })
    }
  }

  return catalog
}

/** Query OpenCode's merged live provider/model configuration when a client is available. */
export async function loadLiveModelCatalog(
  client: any,
  directory?: string,
): Promise<Map<string, CatalogModel>> {
  if (!client?.config?.providers) {
    throw new Error('OpenCode runtime client does not expose config.providers')
  }
  const response = await client.config.providers({
    ...(directory ? { query: { directory } } : {}),
    throwOnError: true,
  })
  return modelCatalogFromProviders(response)
}

export async function selectAvailableModelCandidateFromClient(
  candidates: readonly ConfiguredModelCandidate[],
  client: any,
  directory?: string,
): Promise<ModelSelectionResult> {
  return selectAvailableModelCandidate(candidates, await loadLiveModelCatalog(client, directory))
}

export function shouldChunkForModel(
  modelId: string,
  estimatedTokens: number,
  catalog: ModelCatalog,
  utilization = 0.8,
): boolean {
  const context = catalog.get(modelId)?.context
  return context !== undefined && estimatedTokens > context * utilization
}

export function extractProvider(modelId: string): string | null {
  const separator = modelId.indexOf('/')
  return separator > 0 ? modelId.slice(0, separator).toLowerCase() : null
}

function unwrapProviderPayload(response: unknown): { providers: unknown[] } {
  if (!response || typeof response !== 'object') return { providers: [] }
  const record = response as Record<string, unknown>
  const payload = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : record
  return { providers: Array.isArray(payload.providers) ? payload.providers : [] }
}
