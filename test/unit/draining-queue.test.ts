import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DrainingQueue } from '../../lib/draining-queue.ts'

describe('DrainingQueue', () => {
  it('drains queued work in provider order without exceeding limits', async () => {
    const queue = new DrainingQueue<number, number>(2, { provider: 1 })
    const started: number[] = []
    const releases: Array<() => void> = []
    const run = (value: number) => new Promise<number>((resolve) => {
      started.push(value)
      releases.push(() => resolve(value))
    })

    const first = queue.enqueue(1, 'provider', run)
    const second = queue.enqueue(2, 'provider', run)
    const third = queue.enqueue(3, 'other', run)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(started, [1, 3])
    assert.deepEqual(queue.snapshot(), { pending: 1, running: 2 })

    releases[0]()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(started, [1, 3, 2])
    releases[1]()
    releases[2]()
    assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3])
  })

  it('returns to idle when a callback throws synchronously', async () => {
    const queue = new DrainingQueue<number, number>(1)
    const result = queue.enqueue(1, 'provider', () => { throw new Error('synchronous failure') })

    await assert.rejects(result, /synchronous failure/)
    await queue.whenIdle()
    assert.deepEqual(queue.snapshot(), { pending: 0, running: 0 })
  })
})
