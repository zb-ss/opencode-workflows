interface QueueEntry<T> {
  definition: T
  run: (definition: T) => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/** A strict FIFO queue which retains each full definition until it starts. */
export class FifoProcessQueue<T> {
  private readonly pending: Array<QueueEntry<T>> = []
  private active = 0

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('process queue concurrency must be a positive integer')
    }
  }

  enqueue(definition: T, run: (definition: T) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ definition, run, resolve, reject })
      this.drain()
    })
  }

  snapshot(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.active }
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()
      if (!entry) return

      this.active++
      let completion: Promise<void>
      try {
        completion = entry.run(entry.definition)
      } catch (error) {
        completion = Promise.reject(error)
      }

      void completion.then(entry.resolve, entry.reject).finally(() => {
        this.active--
        this.drain()
      })
    }
  }
}
