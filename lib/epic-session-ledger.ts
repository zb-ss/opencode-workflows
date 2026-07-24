import type { EpicUsageDelta } from './epic-accounting.ts'

export interface EpicUsageObservation extends EpicUsageDelta {
  response_id: string
}

/**
 * Process-private message accounting. Durable counters are intentionally not
 * refunded when this ledger is lost on restart.
 */
export class EpicSessionLedger {
  private readonly observations = new Map<string, EpicUsageDelta>()

  delta(session_id: string, observation: EpicUsageObservation): EpicUsageDelta | null {
    const key = `${session_id}\0${observation.response_id}`
    const previous = this.observations.get(key)
    const current = {
      input_tokens: observation.input_tokens,
      output_tokens: observation.output_tokens,
      cost_usd: observation.cost_usd,
    }
    if (!previous) {
      this.observations.set(key, current)
      return current
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
    this.observations.set(key, current)
    return delta.input_tokens === 0 && delta.output_tokens === 0 && delta.cost_usd === 0 ? null : delta
  }

  clear(session_id: string): void {
    for (const key of this.observations.keys()) {
      if (key.startsWith(`${session_id}\0`)) this.observations.delete(key)
    }
  }
}
