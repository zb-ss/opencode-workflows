import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { withRepositoryOperationLock, withRepositoryOperationLockAsync } from '../../lib/repository-operation-lock.ts'

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('repository operation lock', { concurrency: false }, () => {
  it('serializes linked worktrees through their shared Git common directory', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-operation-lock-'))
    const root = path.join(parent, 'repository')
    const linked = path.join(parent, 'linked')
    const marker = path.join(parent, 'child-entered')
    const configDirectory = path.join(parent, 'config')
    const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    fs.mkdirSync(root)
    try {
      git(root, ['init', '--initial-branch=main'])
      git(root, ['config', 'user.name', 'Lock Test'])
      git(root, ['config', 'user.email', 'lock@example.com'])
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n')
      git(root, ['add', 'tracked.txt'])
      git(root, ['commit', '-m', 'initial'])
      git(root, ['worktree', 'add', '-b', 'linked', linked, 'main'])

      let child: ReturnType<typeof spawn> | null = null
      await withRepositoryOperationLockAsync(root, async () => {
        const script = `
          import fs from 'node:fs'
          import { withRepositoryOperationLock } from './lib/repository-operation-lock.ts'
          withRepositoryOperationLock(${JSON.stringify(linked)}, () => fs.writeFileSync(${JSON.stringify(marker)}, 'entered'))
        `
        child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
          cwd: process.cwd(),
          env: { ...process.env, OPENCODE_CONFIG_DIR: path.join(parent, 'different-config') },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        await new Promise(resolve => setTimeout(resolve, 250))
        assert.equal(fs.existsSync(marker), false)
      })

      const exitCode = await new Promise<number | null>(resolve => child!.once('close', resolve))
      assert.equal(exitCode, 0)
      assert.equal(fs.readFileSync(marker, 'utf8'), 'entered')
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does not let detached async context reuse an expired repository-lock ownership', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-operation-lock-detached-'))
    const root = path.join(parent, 'repository')
    const linked = path.join(parent, 'linked')
    const configDirectory = path.join(parent, 'config')
    const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    fs.mkdirSync(root)
    try {
      git(root, ['init', '--initial-branch=main'])
      git(root, ['config', 'user.name', 'Lock Test'])
      git(root, ['config', 'user.email', 'lock@example.com'])
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n')
      git(root, ['add', 'tracked.txt'])
      git(root, ['commit', '-m', 'initial'])
      git(root, ['worktree', 'add', '-b', 'linked', linked, 'main'])

      let releaseDetached!: () => void
      const detachedGate = new Promise<void>(resolve => { releaseDetached = resolve })
      let synchronousError = ''
      let asyncEntered = false
      let detached!: Promise<void>
      await withRepositoryOperationLockAsync(root, async () => {
        detached = (async () => {
          await detachedGate
          try { withRepositoryOperationLock(linked, () => undefined) }
          catch (error) { synchronousError = (error as Error & { code?: string }).code ?? '' }
          await withRepositoryOperationLockAsync(linked, async () => { asyncEntered = true })
        })()
      })

      await withRepositoryOperationLockAsync(root, async () => {
        releaseDetached()
        const deadline = Date.now() + 1_000
        while (!synchronousError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(synchronousError, 'lock_contended_in_process')
        assert.equal(asyncEntered, false)
      })
      await detached
      assert.equal(asyncEntered, true)
    } finally {
      if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
