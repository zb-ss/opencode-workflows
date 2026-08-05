import type { EpicUsageDelta } from './epic-accounting.ts'

export interface EpicUsageObservation extends EpicUsageDelta {
  response_id: string
}

export interface PendingEpicUsageDelta {
  delta: EpicUsageDelta
  commit(): void
}

/**
 * Process-private message accounting. Durable counters are intentionally not
 * refunded when this ledger is lost on restart.
 */
export class EpicSessionLedger {
  private readonly observations = new Map<string, EpicUsageDelta>()

  prepare(session_id: string, observation: EpicUsageObservation): PendingEpicUsageDelta | null {
    const key = `${session_id}\0${observation.response_id}`
    const previous = this.observations.get(key)
    const current = {
      input_tokens: observation.input_tokens,
      output_tokens: observation.output_tokens,
      cost_usd: observation.cost_usd,
    }
    if (!previous) {
      return {
        delta: current,
        commit: () => { this.observations.set(key, current) },
      }
    }
    if (current.input_tokens < previous.input_tokens
      || current.output_tokens < previous.output_tokens
      || current.cost_usd < previous.cost_usd) {
      return null
    }
    const delta = {
      input_tokens: current.input_tokens - previous.input_tokens,
      output_tokens: current.output_tokens - previous.output_tokens,
      cost_usd: current.cost_usd - previous.cost_usd,
    }
    if (delta.input_tokens === 0 && delta.output_tokens === 0 && delta.cost_usd === 0) return null
    return {
      delta,
      commit: () => { this.observations.set(key, current) },
    }
  }

  clear(session_id: string): void {
    for (const key of this.observations.keys()) {
      if (key.startsWith(`${session_id}\0`)) this.observations.delete(key)
    }
  }
}
