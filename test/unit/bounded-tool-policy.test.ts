import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  assertBoundedToolPaths,
  isBoundedStageTool,
} from '../../lib/bounded-tool-policy.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('bounded tool policy', () => {
  it('allows only reviewed side-effect-free and direct-write tools', () => {
    for (const toolName of [
      'workflow_bounded_list', 'workflow_bounded_read', 'workflow_bounded_write',
      'todoread', 'todowrite',
    ]) {
      assert.equal(isBoundedStageTool(toolName), true)
    }
    for (const toolName of [
      'glob', 'list', 'read', 'apply_patch', 'edit', 'write', 'grep', 'lsp', 'skill', 'patch', 'bash', 'webfetch', 'question', 'task',
      'deploy', 'database_query', 'delegate_run', 'workflow_validation_run',
    ]) {
      assert.equal(isBoundedStageTool(toolName), false)
    }
  })

  it('rejects external, sensitive, protected, and symlinked paths', () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-tool-paths-'))
    temporaryDirectories.push(worktree)
    const directory = path.join(worktree, 'app')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(worktree, '.env'), 'SECRET=test\n')
    fs.writeFileSync(path.join(directory, 'source.ts'), 'export const value = true\n')
    fs.symlinkSync(path.join(worktree, '.env'), path.join(directory, 'safe-name.txt'))

    assert.doesNotThrow(() => assertBoundedToolPaths('workflow_bounded_list', { path: '.' }, worktree, directory))
    assert.doesNotThrow(() => assertBoundedToolPaths(
      'workflow_bounded_list',
      { path: worktree },
      worktree,
      directory,
    ))
    assert.doesNotThrow(() => assertBoundedToolPaths('workflow_bounded_read', { path: 'source.ts' }, worktree, directory))
    assert.doesNotThrow(() => assertBoundedToolPaths(
      'workflow_bounded_write',
      { path: 'source.ts' },
      worktree,
      directory,
    ))
    assert.throws(
      () => assertBoundedToolPaths('workflow_bounded_read', { path: '../.env' }, worktree, directory),
      /sensitive file/,
    )
    assert.throws(
      () => assertBoundedToolPaths('workflow_bounded_read', { path: 'nested/.env.local' }, worktree, directory),
      /sensitive file/,
    )
    assert.throws(
      () => assertBoundedToolPaths('workflow_bounded_read', { path: path.join(worktree, '.env') }, worktree, directory),
      /sensitive file/,
    )
    assert.throws(
      () => assertBoundedToolPaths('workflow_bounded_read', { path: 'safe-name.txt' }, worktree, directory),
      /symbolic link/,
    )
    assert.throws(
      () => assertBoundedToolPaths('workflow_bounded_write', { path: '/tmp/outside.txt' }, worktree, directory),
      /outside the worktree/,
    )
    for (const sensitive of [
      '.authinfo', '.creds', '.npmrc', '.netrc', '.pgpass', 'application.properties', 'auth.json',
      'credentials.json', 'private.pem', 'vault-token', 'wp-config.php',
    ]) {
      fs.writeFileSync(path.join(directory, sensitive), 'secret\n')
      assert.throws(
        () => assertBoundedToolPaths('workflow_bounded_read', { path: sensitive }, worktree, directory),
        /sensitive file/,
      )
    }
    for (const protectedPath of [
      '.git/hooks/pre-commit',
      '.opencode/plugin/unsafe.ts',
      '.github/workflows/ci.yml',
      '.github/actions/check/action.yml',
      '.lintstagedrc.js',
      '.vscode/tasks.json',
      '.prettierrc.js',
      'AGENTS.md',
      'bitbucket-pipelines.yml',
      'CMakeLists.txt',
      'go.mod',
      'package.json',
      'package-lock.json',
      'prettier.config.js',
      'requirements.txt',
    ]) {
      assert.throws(
        () => assertBoundedToolPaths('workflow_bounded_write', { path: protectedPath }, worktree, directory),
        /protected control or sensitive file/,
      )
    }
  })
})
