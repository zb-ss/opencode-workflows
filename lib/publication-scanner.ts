import { createHash } from 'node:crypto'

import {
  BUILT_IN_SENSITIVE_CONTENT_RULES,
  hasHighEntropyToken,
} from './sensitive-content.ts'
import {
  publicationMarkerIssues,
  type PublicationMarkerContract,
} from './publication-marker-policy.mjs'

export type PublicationFindingCategory =
  | 'credential'
  | 'high_entropy'
  | 'internal_marker'
  | 'private_key'
  | 'prohibited_path'
  | 'token'
  | 'unsupported_content'

export type PublicationSourceKind =
  | 'bytes'
  | 'git_blob'
  | 'git_commit'
  | 'git_object'
  | 'git_path'
  | 'path'
  | 'text'

export interface PublicationFinding {
  rule_id: string
  category: PublicationFindingCategory
  source_kind: PublicationSourceKind
  location_identity: string
  fingerprint: string
}

export type PublicationInternalMarker = PublicationMarkerContract

export interface PublicationScanSource {
  kind: PublicationSourceKind
  location_identity: string
}

export interface PublicationScanOptions {
  max_findings: number
  source: PublicationScanSource
  internal_markers?: readonly PublicationInternalMarker[]
}

export class PublicationFindingOverflowError extends Error {
  constructor() {
    super('publication finding limit exceeded')
    this.name = 'PublicationFindingOverflowError'
  }
}

const ROOT_ASSISTANT_CONTEXT_NAMES = new Set([
  '.aider.conf.yml',
  '.aider.conf.yaml',
  '.clinerules',
  '.cursorrules',
  '.windsurfrules',
  'agents.md',
  'ai_context.md',
  'claude.md',
  'cline.md',
  'cody.md',
  'copilot.md',
  'copilot-instructions.md',
  'cursor.md',
  'gemini.md',
  'windsurf.md',
])
const PRIVATE_ASSISTANT_DIRECTORIES = new Set([
  '.agents',
  '.aider',
  '.amazonq',
  '.augment',
  '.claude',
  '.cline',
  '.continue',
  '.copilot',
  '.cursor',
  '.gemini',
  '.kilocode',
  '.kiro',
  '.opencode',
  '.qodo',
  '.qwen',
  '.roo',
  '.tabnine',
  '.trae',
  '.windsurf',
])

const PRIVATE_KEY_FILE_NAMES = /^(?:id_(?:dsa|ecdsa|ed25519|rsa)|.*(?:^|[-_.])private[-_.]?key)(?:\.(?:bak|backup|key|old|p12|p8|pem|pfx))?$/i
const PRIVATE_KEY_EXTENSIONS = /\.(?:key|p12|p8|pfx)$/i
const BACKUP_EXTENSION = /(?:\.bak|\.backup|\.old|\.orig|\.save|\.swp|~)$/i
const SECRET_BEARING_NAME = /(?:^|[-_.])(?:credential|credentials|password|passwd|secret|secrets|token|tokens)(?:[-_.]|$)/i

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function validateOptions(options: PublicationScanOptions): void {
  if (!Number.isSafeInteger(options.max_findings) || options.max_findings < 0) {
    throw new Error('publication max_findings must be a non-negative safe integer')
  }
  if (!options.source || typeof options.source.location_identity !== 'string') {
    throw new Error('publication scan source is required')
  }
  if (publicationMarkerIssues(options.internal_markers ?? []).length > 0) {
    throw new Error('publication internal marker configuration is invalid')
  }
}

function safeLocationIdentity(source: PublicationScanSource): string {
  if (/^[A-Za-z0-9][A-Za-z0-9:._@-]{0,255}$/.test(source.location_identity)) {
    return source.location_identity
  }
  return `${source.kind}:${sha256(source.location_identity)}`
}

class FindingCollector {
  readonly findings: PublicationFinding[] = []
  private readonly identities = new Set<string>()
  private readonly locationIdentity: string

  constructor(
    private readonly options: PublicationScanOptions,
    private readonly contentIdentity: string,
  ) {
    this.locationIdentity = safeLocationIdentity(options.source)
  }

  add(rule_id: string, category: PublicationFindingCategory): void {
    const identity = `${rule_id}\0${category}`
    if (this.identities.has(identity)) return
    if (this.findings.length >= this.options.max_findings) throw new PublicationFindingOverflowError()
    this.identities.add(identity)
    this.findings.push({
      rule_id,
      category,
      source_kind: this.options.source.kind,
      location_identity: this.locationIdentity,
      fingerprint: sha256(JSON.stringify([
        'publication-finding-v1',
        rule_id,
        category,
        this.options.source.kind,
        this.locationIdentity,
        this.contentIdentity,
      ])),
    })
  }
}

function scanTextInto(value: string, options: PublicationScanOptions, collector: FindingCollector): void {
  for (const rule of BUILT_IN_SENSITIVE_CONTENT_RULES) {
    if (rule.pattern.test(value)) collector.add(rule.rule_id, rule.category)
  }
  if (hasHighEntropyToken(value)) collector.add('token.high_entropy', 'high_entropy')

  for (const marker of options.internal_markers ?? []) {
    const isPresent = marker.case_sensitive
      ? value.includes(marker.literal)
      : value.toLocaleLowerCase('en-US').includes(marker.literal.toLocaleLowerCase('en-US'))
    if (isPresent) collector.add(`internal_marker.${marker.id}`, 'internal_marker')
  }
}

export function scanPublicationText(value: string, options: PublicationScanOptions): PublicationFinding[] {
  validateOptions(options)
  if (typeof value !== 'string') throw new Error('publication text must be a string')
  const collector = new FindingCollector(options, sha256(value))
  scanTextInto(value, options, collector)
  return collector.findings
}

function isGitLfsPointer(value: string): boolean {
  const normalized = value.replace(/\r\n/g, '\n')
  return normalized.startsWith('version https://git-lfs.github.com/spec/v1\n')
    && /\noid sha256:[0-9a-f]{64}\n/.test(`${normalized}\n`)
    && /\nsize [0-9]+\n/.test(`${normalized}\n`)
}

function isSubmoduleMetadata(value: string): boolean {
  return /^\s*\[submodule\s+["'][^\r\n]+["']\s*\]\s*$/im.test(value)
    && /^\s*(?:path|url)\s*=/im.test(value)
}

function hasOpaqueControlCharacters(value: string): boolean {
  return /[\u0001-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
}

function hasPathControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value)
}

export function scanPublicationBytes(value: Uint8Array, options: PublicationScanOptions): PublicationFinding[] {
  validateOptions(options)
  if (!(value instanceof Uint8Array)) throw new Error('publication bytes must be a Uint8Array')
  const collector = new FindingCollector(options, sha256(value))
  if (value.includes(0)) {
    collector.add('unsupported_content.nul', 'unsupported_content')
    return collector.findings
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)
  } catch {
    collector.add('unsupported_content.invalid_utf8', 'unsupported_content')
    return collector.findings
  }
  if (hasOpaqueControlCharacters(text)) {
    collector.add('unsupported_content.control_characters', 'unsupported_content')
    return collector.findings
  }
  if (isGitLfsPointer(text)) {
    collector.add('unsupported_content.git_lfs_pointer', 'unsupported_content')
    return collector.findings
  }
  if (isSubmoduleMetadata(text)) {
    collector.add('unsupported_content.submodule_metadata', 'unsupported_content')
    return collector.findings
  }
  scanTextInto(text, options, collector)
  return collector.findings
}

function normalizedPublicationPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
}

function isAssistantRulePath(lowerPath: string, segments: string[]): boolean {
  if (segments.length === 1 && ROOT_ASSISTANT_CONTEXT_NAMES.has(lowerPath)) return true
  if (segments.some(segment => PRIVATE_ASSISTANT_DIRECTORIES.has(segment))) return true
  if (lowerPath === '.github/copilot-instructions.md') return true
  if (/^\.github\/instructions\/[^/]+\.instructions\.md$/.test(lowerPath)) return true
  return /^(?:\.cursor|\.windsurf|\.roo)\/rules\//.test(lowerPath)
}

export function scanPublicationPath(value: string, options: PublicationScanOptions): PublicationFinding[] {
  validateOptions(options)
  if (typeof value !== 'string') throw new Error('publication path must be a string')
  const normalized = normalizedPublicationPath(value)
  const collector = new FindingCollector(options, sha256(normalized))
  scanTextInto(normalized, options, collector)

  const lowerPath = normalized.toLocaleLowerCase('en-US')
  const segments = lowerPath.split('/').filter(Boolean)
  const basename = segments.at(-1) ?? ''
  if (normalized.length === 0 || hasPathControlCharacters(normalized) || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || segments.includes('.') || segments.includes('..')) {
    collector.add('unsupported_content.malformed_path', 'unsupported_content')
  }
  if (segments.some(segment => segment.startsWith('.env'))) {
    collector.add('prohibited_path.environment_file', 'prohibited_path')
  }
  if (segments.some(segment => segment === '.creds' || segment.startsWith('.creds.'))) {
    collector.add('prohibited_path.credentials_file', 'prohibited_path')
  }
  const basenameWithoutBackup = basename.replace(BACKUP_EXTENSION, '')
  if (PRIVATE_KEY_FILE_NAMES.test(basename)
    || PRIVATE_KEY_EXTENSIONS.test(basename)
    || (BACKUP_EXTENSION.test(basename) && PRIVATE_KEY_EXTENSIONS.test(basenameWithoutBackup))) {
    collector.add('prohibited_path.private_key_file', 'prohibited_path')
  }
  if (BACKUP_EXTENSION.test(basename) && (SECRET_BEARING_NAME.test(basename) || basename.startsWith('.env'))) {
    collector.add('prohibited_path.secret_backup', 'prohibited_path')
  }
  if (isAssistantRulePath(lowerPath, segments)) {
    collector.add('prohibited_path.assistant_context', 'prohibited_path')
  }
  if (lowerPath === '.gitmodules') {
    collector.add('unsupported_content.submodule_metadata_path', 'unsupported_content')
  }
  return collector.findings
}
