export interface QueueSnapshot {
  pending: number
  running: number
}

interface QueueEntry<T, R> {
  item: T
  key: string
  run: (item: T) => Promise<R>
  onStart?: () => void
  resolve: (result: R) => void
  reject: (error: unknown) => void
}

export class DrainingQueue<T, R> {
  private readonly pending: Array<QueueEntry<T, R>> = []
  private readonly activeByKey = new Map<string, number>()
  private readonly idleWaiters = new Set<() => void>()
  private active = 0

  constructor(
    private readonly globalLimit: number,
    private readonly limits: Record<string, number> = {},
  ) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1) {
      throw new Error('global queue limit must be a positive integer')
    }
  }

  enqueue(item: T, key: string, run: (item: T) => Promise<R>, onStart?: () => void): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.pending.push({ item, key, run, onStart, resolve, reject })
      this.drain()
    })
  }

  snapshot(): QueueSnapshot {
    return { pending: this.pending.length, running: this.active }
  }

  cancelPending(reason: Error): void {
    for (const entry of this.pending.splice(0)) entry.reject(reason)
    this.notifyIdle()
  }

  async whenIdle(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0) return
    await new Promise<void>(resolve => this.idleWaiters.add(resolve))
  }

  private canStart(entry: QueueEntry<T, R>): boolean {
    if (this.active >= this.globalLimit) return false
    const keyLimit = this.limits[entry.key] ?? this.globalLimit
    return (this.activeByKey.get(entry.key) ?? 0) < keyLimit
  }

  private drain(): void {
    let started = true
    while (started) {
      started = false
      const index = this.pending.findIndex((entry) => this.canStart(entry))
      if (index === -1) return

      const [entry] = this.pending.splice(index, 1)
      this.active++
      this.activeByKey.set(entry.key, (this.activeByKey.get(entry.key) ?? 0) + 1)
      started = true

      try {
        entry.onStart?.()
      } catch (error) {
        this.active = Math.max(0, this.active - 1)
        this.activeByKey.set(entry.key, Math.max(0, (this.activeByKey.get(entry.key) ?? 1) - 1))
        entry.reject(error)
        continue
      }
      void Promise.resolve().then(() => entry.run(entry.item)).then(entry.resolve, entry.reject).finally(() => {
        this.active = Math.max(0, this.active - 1)
        this.activeByKey.set(entry.key, Math.max(0, (this.activeByKey.get(entry.key) ?? 1) - 1))
        this.drain()
        this.notifyIdle()
      })
    }
  }

  private notifyIdle(): void {
    if (this.pending.length > 0 || this.active > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
