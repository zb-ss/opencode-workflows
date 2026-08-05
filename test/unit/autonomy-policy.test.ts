import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluatePermissionRules,
  parsePermissionRules,
  resolveBoundedPermissionRules,
  type PermissionRule,
} from '../../lib/autonomy-policy.ts'

describe('bounded autonomy policy', () => {
  it('places reviewed built-ins over a default deny while preserving explicit denies', () => {
    const effective: PermissionRule[] = [
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'rm *', action: 'deny' },
      { permission: 'read', pattern: 'README.md', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'ask' },
      { permission: 'list', pattern: '*', action: 'ask' },
    ]

    const resolved = resolveBoundedPermissionRules(effective)

    assert.deepEqual(resolved[0], { permission: '*', pattern: '*', action: 'deny' })
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_read', 'README.md'), 'allow')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_list', '.'), 'deny')
    assert.equal(resolved.some((rule) => rule.action === 'ask'), false)
  })

  it('denies sensitive and unknown asks and appends non-interactive hard denies', () => {
    const resolved = resolveBoundedPermissionRules([
      { permission: 'read', pattern: '.env.local', action: 'ask' },
      { permission: 'external_directory', pattern: '/tmp/**', action: 'ask' },
      { permission: 'question', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'allow' },
      { permission: 'custom_unsafe', pattern: '*', action: 'allow' },
      { permission: 'doom_loop', pattern: '*', action: 'ask' },
    ])

    assert.equal(resolved.some((rule) => rule.action === 'ask'), false)
    for (const permission of ['read', 'external_directory', 'question', 'custom_unsafe', 'doom_loop']) {
      assert.equal(evaluatePermissionRules(resolved, permission, '*'), 'deny')
    }
    for (const permission of [
      'question', 'plan_enter', 'plan_exit', 'task', 'delegation_unsafe',
      'epic_start', 'epic_pause', 'epic_cancel', 'epic_resume', 'epic_redelegate', 'epic_integrate', 'epic_cleanup',
      'queue_enqueue', 'queue_pause', 'queue_resume', 'queue_cancel', 'queue_delete', 'queue_recover',
      'epic_budget_update', 'epic_budget_extend',
    ]) {
      assert.equal(resolved.some((rule) => (
        rule.permission === permission && rule.pattern === '*' && rule.action === 'deny'
      )), true)
    }
    assert.equal(resolved.some((rule) => (
      rule.permission === 'workflow_bounded_read' && rule.pattern === '**/.env*' && rule.action === 'deny'
    )), true)
    assert.equal(resolved.some((rule) => (
      rule.permission === 'bash' && rule.pattern === '*' && rule.action === 'deny'
    )), true)
  })

  it('makes bounded sessions default-deny for shell and network access', () => {
    const resolved = resolveBoundedPermissionRules([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: 'git diff*', action: 'allow' },
      { permission: 'webfetch', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
    ])

    assert.equal(resolved[0].permission, '*')
    assert.equal(resolved[0].action, 'deny')
    assert.equal(evaluatePermissionRules(resolved, 'bash', 'git diff --stat'), 'deny')
    assert.equal(resolved.at(-2)?.permission, 'webfetch')
    assert.equal(resolved.at(-2)?.action, 'deny')
    assert.equal(resolved.find((rule) => rule.permission === 'workflow_bounded_write')?.action, 'allow')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_write', 'source.ts'), 'allow')
    assert.equal(evaluatePermissionRules(resolved, 'custom_tool', '*'), 'deny')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_read', '.env.local'), 'deny')
    assert.equal(resolved.find((rule) => rule.permission === 'edit')?.action, 'deny')
  })

  it('evaluates effective permissions with OpenCode last-match wildcard semantics', () => {
    const rules: PermissionRule[] = [
      { permission: 'task', pattern: '*', action: 'allow' },
      { permission: 'task', pattern: 'wf-security*', action: 'deny' },
      { permission: 'bash', pattern: 'git status *', action: 'allow' },
    ]

    assert.equal(evaluatePermissionRules(rules, 'task', 'wf-executor'), 'allow')
    assert.equal(evaluatePermissionRules(rules, 'task', 'wf-security-deep'), 'deny')
    assert.equal(evaluatePermissionRules(rules, 'bash', 'git status'), 'allow')
    assert.equal(evaluatePermissionRules(rules, 'webfetch', 'https://example.com'), 'ask')
  })

  it('preserves path-specific edit denies for the bounded writer', () => {
    const resolved = resolveBoundedPermissionRules([
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: 'app/protected.ts', action: 'deny' },
    ])

    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_write', 'app/source.ts'), 'allow')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_write', 'app/protected.ts'), 'deny')
  })

  it('never upgrades ask or cross-namespace list denies', () => {
    const resolved = resolveBoundedPermissionRules([
      { permission: 'read', pattern: '*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'list', pattern: 'private', action: 'deny' },
      { permission: 'glob', pattern: '*', action: 'allow' },
    ])

    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_read', 'README.md'), 'deny')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_write', 'source.ts'), 'deny')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_list', 'public'), 'allow')
    assert.equal(evaluatePermissionRules(resolved, 'workflow_bounded_list', 'private'), 'deny')
  })

  it('maps wildcard ask and deny over reviewed tools without treating wildcard allow as authority', () => {
    const denied = resolveBoundedPermissionRules([
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: '*', pattern: '*', action: 'deny' },
    ])
    assert.equal(evaluatePermissionRules(denied, 'workflow_bounded_write', 'source.ts'), 'deny')

    const allowed = resolveBoundedPermissionRules([
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'workflow_validation_run', pattern: '*', action: 'allow' },
    ])
    assert.equal(evaluatePermissionRules(allowed, 'workflow_bounded_write', 'source.ts'), 'allow')
    assert.equal(evaluatePermissionRules(allowed, 'workflow_validation_run', 'npm test'), 'deny')
    assert.equal(evaluatePermissionRules(allowed, 'custom_tool', '*'), 'deny')
  })

  it('validates effective array and legacy object permission shapes', () => {
    assert.deepEqual(parsePermissionRules([{ permission: 'read', pattern: '*', action: 'allow' }]), [
      { permission: 'read', pattern: '*', action: 'allow' },
    ])
    assert.deepEqual(parsePermissionRules({
      edit: 'allow',
      bash: { '*': 'ask', 'git *': 'deny' },
    }), [
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git *', action: 'deny' },
    ])
    for (const malformed of [
      null,
      {},
      [],
      [{ permission: 'read', pattern: '*', action: 'sometimes' }],
      [{ permission: '', pattern: '*', action: 'allow' }],
      [{ permission: 'read', action: 'allow' }],
      [{ permission: 'read', pattern: '*', action: 'allow', extra: true }],
      { '': 'allow' },
      { bash: { '': 'ask' } },
    ]) {
      assert.throws(() => parsePermissionRules(malformed), /permission/)
    }
  })
})
