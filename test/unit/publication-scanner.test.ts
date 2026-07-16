import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PublicationFindingOverflowError,
  scanPublicationBytes,
  scanPublicationPath,
  scanPublicationText,
  type PublicationScanOptions,
} from '../../lib/publication-scanner.ts'
import { containsSensitiveContent } from '../../lib/sensitive-content.ts'

function options(
  kind: PublicationScanOptions['source']['kind'] = 'text',
  location_identity = 'fixture:1',
  max_findings = 20,
): PublicationScanOptions {
  return { max_findings, source: { kind, location_identity } }
}

describe('publication scanner', () => {
  it('preserves the compatibility predicate and reports structured built-in findings', () => {
    const synthetic = 'password=exampleCredential123'
    assert.equal(containsSensitiveContent(synthetic), true)
    assert.equal(containsSensitiveContent('ordinary documentation'), false)

    const findings = scanPublicationText(synthetic, options())
    assert.equal(findings.some(finding => finding.rule_id === 'credential.secret_assignment'), true)
    assert.deepEqual(Object.keys(findings[0]).sort(), [
      'category',
      'fingerprint',
      'location_identity',
      'rule_id',
      'source_kind',
    ])
    assert.doesNotMatch(JSON.stringify(findings), /exampleCredential123/)
    assert.match(findings[0].fingerprint, /^[0-9a-f]{64}$/)
  })

  it('detects quoted, spaced, escaped, and unquoted credential assignments', () => {
    const credentials = [
      'password = "correct horse battery staple"',
      "passphrase = 'correct horse battery staple'",
      'password = correct-horse-battery-staple',
      '{"client_secret": "correct horse battery staple"}',
      String.raw`password="correct \"horse\" battery staple"`,
      'DB_PASSWORD=hunter2',
      'DATABASE_PASSWORD="short secret"',
      'const databasePassword = "short secret"',
      'AWS_SECRET_ACCESS_KEY=short-secret',
      'OAUTH_CLIENT_SECRET="short secret"',
    ]
    for (const [index, credential] of credentials.entries()) {
      assert.equal(containsSensitiveContent(credential), true, credential)
      assert.equal(scanPublicationText(
        credential,
        options('text', `credential:${index}`),
      ).some(finding => finding.category === 'credential'), true, credential)
    }
  })

  it('detects a quoted credential even when its value exceeds the bounded matcher', () => {
    const oversized = `DATABASE_PASSWORD="${'a'.repeat(16_384)}"`
    assert.equal(containsSensitiveContent(oversized), true)
    assert.equal(scanPublicationText(oversized, options()).some(finding => (
      finding.rule_id === 'credential.assignment_double_quoted'
    )), true)
  })

  it('uses source, location, rule, and full-content identity in fingerprints', () => {
    const first = scanPublicationText('prefix password=exampleCredential123', options('text', 'message:1'))[0]
    const moved = scanPublicationText('prefix password=exampleCredential123', options('text', 'message:2'))[0]
    const changed = scanPublicationText('other password=exampleCredential123', options('text', 'message:1'))[0]

    assert.notEqual(first.fingerprint, moved.fingerprint)
    assert.notEqual(first.fingerprint, changed.fingerprint)
  })

  it('matches operator markers without exposing their literals', () => {
    const marker = 'Synthetic Internal Project'
    const findings = scanPublicationText('synthetic internal project notes', {
      ...options(),
      internal_markers: [{ id: 'project-name', literal: marker, case_sensitive: false }],
    })

    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule_id, 'internal_marker.project-name')
    assert.equal(findings[0].category, 'internal_marker')
    assert.doesNotMatch(JSON.stringify(findings).toLowerCase(), /synthetic internal project/)
  })

  it('detects prohibited paths but allows the public AI context document', () => {
    const prohibited = [
      '.env.production',
      'config/.creds',
      'keys/id_ed25519',
      'config/server.key',
      'credentials.backup',
      'AGENTS.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/private.mdc',
      '.claude/settings.local.json',
      '.opencode/private-config.json',
      'packages/.gemini/context.md',
      'packages/.agents/skills/internal/SKILL.md',
    ]
    for (const publicationPath of prohibited) {
      assert.ok(scanPublicationPath(publicationPath, options('path', 'path:fixture')).length > 0, publicationPath)
    }
    assert.deepEqual(scanPublicationPath('docs/AI_CONTEXT.md', options('path', 'path:public-doc')), [])
  })

  it('rejects opaque bytes, LFS pointers, and submodule metadata as unsupported', () => {
    const nul = scanPublicationBytes(Buffer.from([0x61, 0x00, 0x62]), options('bytes'))
    const invalid = scanPublicationBytes(Buffer.from([0xc3, 0x28]), options('bytes'))
    const controls = scanPublicationBytes(Buffer.from([0x01, 0x02, 0x03, 0x04]), options('bytes'))
    const lfs = scanPublicationBytes(Buffer.from([
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${'0'.repeat(64)}`,
      'size 12',
      '',
    ].join('\n')), options('bytes'))
    const submodule = scanPublicationBytes(Buffer.from([
      '[submodule "vendor/example"]',
      '\tpath = vendor/example',
      '\turl = https://example.com/example/repository.git',
    ].join('\n')), options('bytes'))

    for (const findings of [nul, invalid, controls, lfs, submodule]) {
      assert.equal(findings.length, 1)
      assert.equal(findings[0].category, 'unsupported_content')
    }
  })

  it('allows only tab, line feed, and carriage return from the C0 and C1 control ranges', () => {
    const allowed = new Set([0x09, 0x0a, 0x0d])
    for (let codePoint = 0; codePoint <= 0x9f; codePoint += 1) {
      if (codePoint > 0x1f && codePoint < 0x7f) continue
      const findings = scanPublicationBytes(
        Buffer.from(`before${String.fromCodePoint(codePoint)}after`),
        options('bytes', `control:${codePoint}`),
      )
      assert.equal(
        findings.some(finding => finding.category === 'unsupported_content'),
        !allowed.has(codePoint),
        `U+${codePoint.toString(16).padStart(4, '0')}`,
      )
    }
  })

  it('rejects every C0 and C1 control character in publication paths', () => {
    for (let codePoint = 0; codePoint <= 0x9f; codePoint += 1) {
      if (codePoint > 0x1f && codePoint < 0x7f) continue
      const findings = scanPublicationPath(
        `src/before${String.fromCodePoint(codePoint)}after.ts`,
        options('path', `path-control:${codePoint}`),
      )
      assert.equal(
        findings.some(finding => finding.rule_id === 'unsupported_content.malformed_path'),
        true,
        `U+${codePoint.toString(16).padStart(4, '0')}`,
      )
    }
  })

  it('detects high-entropy tokens and fails closed when findings overflow', () => {
    const entropy = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5zA7cD9eF2gH4jK6'
    assert.equal(scanPublicationText(entropy, options()).some(finding => (
      finding.category === 'high_entropy'
    )), true)
    assert.throws(
      () => scanPublicationText('password=exampleCredential123', options('text', 'fixture:limit', 0)),
      PublicationFindingOverflowError,
    )
  })
})
