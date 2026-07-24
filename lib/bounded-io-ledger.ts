import crypto from 'node:crypto'

export type BoundedIoKind = 'read' | 'write'

export interface BoundedIoReservation {
  size(): number
  adjust(bytes: number): Promise<void>
  commit(): Promise<void>
  cancel(): Promise<void>
}

interface ActiveReservation {
  id: string
  kind: BoundedIoKind
  bytes: number
  closed: boolean
}

interface BoundedIoBudget {
  limits: {
    max_bounded_read_bytes: number | null
    max_bounded_write_bytes: number | null
  }
  usage: {
    bounded_read_bytes: number
    bounded_write_bytes: number
  }
}

export class BoundedIoLedger {
  private readonly reservations = new Map<string, ActiveReservation>()

  constructor(
    private readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly budget: () => BoundedIoBudget,
    private readonly persist: () => void,
    private readonly assertReservable: () => void,
  ) {}

  reserve(kind: BoundedIoKind, requestedBytes?: number): Promise<BoundedIoReservation> {
    return this.serialize(async () => {
      this.assertReservable()
      if (requestedBytes !== undefined && (!Number.isInteger(requestedBytes) || requestedBytes < 0)) {
        throw new Error('bounded I/O reservation must be a non-negative integer')
      }
      const budget = this.budget()
      const usageKey = this.usageKey(kind)
      const limit = this.limit(budget, kind)
      const remaining = limit === null ? Math.max(0, requestedBytes ?? 0) : Math.max(0, limit - budget.usage[usageKey])
      const reserved = requestedBytes ?? remaining
      if (limit !== null && reserved > remaining) throw new Error(`bounded ${kind} byte budget exhausted`)
      this.updateUsage(budget, usageKey, budget.usage[usageKey] + reserved)
      const active: ActiveReservation = { id: crypto.randomUUID(), kind, bytes: reserved, closed: false }
      this.reservations.set(active.id, active)
      return {
        size: () => active.bytes,
        adjust: (bytes) => this.adjust(active, bytes),
        commit: () => this.commit(active),
        cancel: () => this.cancel(active),
      }
    })
  }

  private adjust(active: ActiveReservation, bytes: number): Promise<void> {
    return this.serialize(async () => {
      this.assertReservable()
      if (!Number.isInteger(bytes) || bytes < 0) throw new Error('bounded I/O adjustment must be a non-negative integer')
      const current = this.active(active)
      const budget = this.budget()
      const usageKey = this.usageKey(current.kind)
      const nextUsage = budget.usage[usageKey] - current.bytes + bytes
      if (nextUsage < 0) throw new Error('bounded I/O reservation exceeds recorded usage')
      const limit = this.limit(budget, current.kind)
      if (limit !== null && nextUsage > limit) {
        throw new Error(`bounded ${current.kind} byte budget exhausted`)
      }
      this.updateUsage(budget, usageKey, nextUsage)
      current.bytes = bytes
    })
  }

  private cancel(active: ActiveReservation): Promise<void> {
    return this.serialize(async () => {
      this.assertReservable()
      const current = this.reservations.get(active.id)
      if (!current || current.closed) return
      const budget = this.budget()
      const usageKey = this.usageKey(current.kind)
      if (current.bytes > budget.usage[usageKey]) throw new Error('bounded I/O reservation exceeds recorded usage')
      this.updateUsage(budget, usageKey, budget.usage[usageKey] - current.bytes)
      current.closed = true
      this.reservations.delete(current.id)
    })
  }

  private commit(active: ActiveReservation): Promise<void> {
    return this.serialize(async () => {
      this.assertReservable()
      const current = this.reservations.get(active.id)
      if (!current || current.closed) return
      current.closed = true
      this.reservations.delete(current.id)
    })
  }

  private active(input: ActiveReservation): ActiveReservation {
    const active = this.reservations.get(input.id)
    if (!active || active.closed) throw new Error('bounded I/O reservation is closed')
    return active
  }

  private usageKey(kind: BoundedIoKind): 'bounded_read_bytes' | 'bounded_write_bytes' {
    return kind === 'read' ? 'bounded_read_bytes' : 'bounded_write_bytes'
  }

  private limit(budget: BoundedIoBudget, kind: BoundedIoKind): number | null {
    return kind === 'read' ? budget.limits.max_bounded_read_bytes : budget.limits.max_bounded_write_bytes
  }

  private updateUsage(
    budget: BoundedIoBudget,
    key: 'bounded_read_bytes' | 'bounded_write_bytes',
    value: number,
  ): void {
    const previous = budget.usage[key]
    budget.usage[key] = value
    try {
      this.persist()
    } catch (error) {
      budget.usage[key] = previous
      throw error
    }
  }
}
