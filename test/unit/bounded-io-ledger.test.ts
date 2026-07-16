import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BoundedIoLedger } from '../../lib/bounded-io-ledger.ts'

describe('BoundedIoLedger', () => {
  it('rechecks workflow authority when a queued reservation starts', async () => {
    let queue = Promise.resolve<unknown>(undefined)
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = queue.then(operation, operation)
      queue = result.catch(() => undefined)
      return result
    }
    let releaseBlocker!: () => void
    const blocker = serialize(() => new Promise<void>((resolve) => { releaseBlocker = resolve }))
    let isReservable = true
    const budget = {
      limits: { max_bounded_read_bytes: 10, max_bounded_write_bytes: 10 },
      usage: { bounded_read_bytes: 0, bounded_write_bytes: 0 },
    }
    const ledger = new BoundedIoLedger(
      serialize,
      () => budget,
      () => undefined,
      () => {
        if (!isReservable) throw new Error('workflow paused')
      },
    )

    await Promise.resolve()
    const pending = ledger.reserve('read', 1)
    isReservable = false
    releaseBlocker()
    await blocker

    await assert.rejects(pending, /workflow paused/)
    assert.equal(budget.usage.bounded_read_bytes, 0)
  })
})
