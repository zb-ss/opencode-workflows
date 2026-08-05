import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { computeSandboxedMergeTree } from '../../lib/git-merge-sandbox.ts'

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fileSnapshot(root: string, current = root, output: Record<string, number> = {}): Record<string, number> {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) fileSnapshot(root, fullPath, output)
    else if (entry.isFile()) output[path.relative(root, fullPath)] = fs.statSync(fullPath).size
  }
  return output
}

describe('Git executable trust boundary', () => {
  it('skips an untrusted Git shim present before module import, including when running as root', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sandbox-path-'))
    const marker = path.join(directory, 'executed')
    const shim = path.join(directory, 'git')
    try {
      fs.writeFileSync(shim, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o700 })
      const moduleUrl = new URL('../../lib/git-sandbox.ts', import.meta.url).href
      const tsxImport = import.meta.resolve('tsx')
      const script = `
        import(${JSON.stringify(moduleUrl)}).then(
          module => process.exit(module.trustedGitExecutable().startsWith('/proc/') ? 0 : 2),
          () => process.exit(3),
        )
      `
      const result = spawnSync(process.execPath, ['--import', tsxImport, '--input-type=module', '--eval', script], {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}${path.delimiter}/bin${path.delimiter}/usr/bin` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('discovers a trusted Git executable when the process starts at the filesystem root', () => {
    const moduleUrl = new URL('../../lib/git-sandbox.ts', import.meta.url).href
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `/usr/bin${path.delimiter}/bin` }
    delete environment.OPENCODE_WORKFLOWS_GIT_EXECUTABLE
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval',
      `import(${JSON.stringify(moduleUrl)}).then(module => module.trustedGitExecutable() ? process.exit(0) : process.exit(2), () => process.exit(3))`,
    ], {
      cwd: path.parse(process.cwd()).root,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(result.status, 0, result.stderr)
  })

  it('keeps generated merge objects inside the private merge sandbox', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'git-merge-objects-'))
    const repository = path.join(parent, 'repository')
    fs.mkdirSync(repository)
    try {
      git(repository, ['init', '--initial-branch=main'])
      git(repository, ['config', 'user.name', 'Sandbox Test'])
      git(repository, ['config', 'user.email', 'sandbox@example.com'])
      fs.mkdirSync(path.join(repository, 'dir'))
      fs.writeFileSync(path.join(repository, 'dir', 'a.txt'), 'base-a\n')
      fs.writeFileSync(path.join(repository, 'dir', 'b.txt'), 'base-b\n')
      git(repository, ['add', '.'])
      git(repository, ['commit', '-m', 'base'])
      git(repository, ['checkout', '-b', 'source'])
      fs.writeFileSync(path.join(repository, 'dir', 'b.txt'), 'source-b\n')
      git(repository, ['commit', '-am', 'source'])
      const source = git(repository, ['rev-parse', 'HEAD'])
      git(repository, ['checkout', 'main'])
      fs.writeFileSync(path.join(repository, 'dir', 'a.txt'), 'target-a\n')
      git(repository, ['commit', '-am', 'target'])
      const target = git(repository, ['rev-parse', 'HEAD'])
      const objectDirectory = git(repository, ['rev-parse', '--git-path', 'objects'])
      const before = fileSnapshot(path.resolve(repository, objectDirectory))

      const merged = computeSandboxedMergeTree(repository, target, source)

      assert.match(merged.tree_oid!, /^[a-f0-9]{40,64}$/)
      assert.ok(merged.generated_objects.length >= 2)
      assert.deepEqual(fileSnapshot(path.resolve(repository, objectDirectory)), before)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
