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
})
