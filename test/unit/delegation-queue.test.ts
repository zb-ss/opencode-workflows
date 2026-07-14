import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { delegationMergeError, FifoProcessQueue } from '../../plugin/delegation-orchestrator.ts'

interface TaskDefinition {
  id: string
  description: string
  files: string[]
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('delegation process queue', () => {
  it('retains complete definitions and drains queued tasks in FIFO order', async () => {
    const queue = new FifoProcessQueue<TaskDefinition>(2)
    const tasks: TaskDefinition[] = [
      { id: 'task-1', description: 'first', files: ['one.ts'] },
      { id: 'task-2', description: 'second', files: ['two.ts'] },
      { id: 'task-3', description: 'third', files: ['three.ts'] },
      { id: 'task-4', description: 'fourth', files: ['four.ts'] },
    ]
    const started: TaskDefinition[] = []
    const releases = new Map<string, () => void>()
    const run = (task: TaskDefinition) => new Promise<void>(resolve => {
      started.push(task)
      releases.set(task.id, resolve)
    })

    const completions = tasks.map(task => queue.enqueue(task, run))
    assert.deepEqual(started.map(task => task.id), ['task-1', 'task-2'])
    assert.deepEqual(queue.snapshot(), { pending: 2, running: 2 })

    releases.get('task-1')?.()
    await nextTurn()
    assert.deepEqual(started.map(task => task.id), ['task-1', 'task-2', 'task-3'])
    assert.deepEqual(started[2], tasks[2])

    releases.get('task-2')?.()
    await nextTurn()
    assert.deepEqual(started.map(task => task.id), ['task-1', 'task-2', 'task-3', 'task-4'])
    assert.deepEqual(started[3], tasks[3])

    releases.get('task-3')?.()
    releases.get('task-4')?.()
    await Promise.all(completions)
    assert.deepEqual(queue.snapshot(), { pending: 0, running: 0 })
  })

  it('contains no destructive redelegation or shell-interpolated process commands', () => {
    const orchestratorPath = fileURLToPath(new URL('../../plugin/delegation-orchestrator.ts', import.meta.url))
    const source = fs.readFileSync(orchestratorPath, 'utf8')

    assert.doesNotMatch(source, /reset\s+--hard/)
    assert.doesNotMatch(source, /clean\s+-[^\s]*f/)
    assert.doesNotMatch(source, /\bexec(?:File)?Sync\b/)
    assert.doesNotMatch(source, /shell:\s*true/)
    assert.doesNotMatch(source, /session\.cancel/)
  })

  it('requires successful execution, review approval, and the authorized target before merge', () => {
    const valid = {
      completed: true,
      exitCode: 0,
      aborted: false,
      timedOut: false,
      executionError: null,
      taskStatus: 'passed',
      targetBranch: 'feature/change',
      featureBranch: 'feature/change',
    }
    assert.equal(delegationMergeError(valid), null)
    assert.match(delegationMergeError({ ...valid, exitCode: 1 })!, /did not complete successfully/)
    assert.match(delegationMergeError({ ...valid, taskStatus: 'reviewing' })!, /recorded passing review/)
    assert.match(delegationMergeError({ ...valid, targetBranch: 'main' })!, /authorized feature branch/)
  })
})
