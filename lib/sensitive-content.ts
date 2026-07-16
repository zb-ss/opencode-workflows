export type SensitiveContentCategory = 'credential' | 'private_key' | 'token'

export interface SensitiveContentRule {
  readonly rule_id: string
  readonly category: SensitiveContentCategory
  readonly pattern: RegExp
}

const MAX_CREDENTIAL_VALUE_UNITS = 4096
const MAX_ESCAPED_UTF8_VALUE_UNIT_BYTES = 5
const MAX_UNCLASSIFIED_TOKEN_UNITS = 4096
export const SENSITIVE_CONTENT_STREAM_OVERLAP_BYTES = (
  MAX_CREDENTIAL_VALUE_UNITS * MAX_ESCAPED_UTF8_VALUE_UNIT_BYTES
) + 1024

const CREDENTIAL_ASSIGNMENT_KEY_SOURCE = String.raw`\b["']?[A-Za-z0-9_$-]{0,127}(?:password|passwd|passphrase|secret(?:[_-]?access[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s{0,32}[:=]\s{0,32}`
const DOUBLE_QUOTED_VALUE_SOURCE = String.raw`"(?:\\[^\r\n]|[^"\\\r\n]){1,${MAX_CREDENTIAL_VALUE_UNITS}}`
const SINGLE_QUOTED_VALUE_SOURCE = String.raw`'(?:\\[^\r\n]|[^'\\\r\n]){1,${MAX_CREDENTIAL_VALUE_UNITS}}`
const UNQUOTED_VALUE_SOURCE = String.raw`(?!["'])[^\s\r\n][^\r\n]{0,${MAX_CREDENTIAL_VALUE_UNITS - 1}}`

export const BUILT_IN_SENSITIVE_CONTENT_RULES: readonly SensitiveContentRule[] = [
  { rule_id: 'private_key.pem_header', category: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule_id: 'token.aws_access_key_id', category: 'token', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    rule_id: 'token.github_fine_grained',
    category: 'token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { rule_id: 'token.github_classic', category: 'token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule_id: 'token.npm', category: 'token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  {
    rule_id: 'token.payment_provider',
    category: 'token',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  { rule_id: 'token.slack', category: 'token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
  {
    rule_id: 'token.jwt',
    category: 'token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    rule_id: 'credential.bearer',
    category: 'credential',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  },
  {
    rule_id: 'credential.url',
    category: 'credential',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
  },
  {
    rule_id: 'credential.assignment_double_quoted',
    category: 'credential',
    pattern: new RegExp(`${CREDENTIAL_ASSIGNMENT_KEY_SOURCE}${DOUBLE_QUOTED_VALUE_SOURCE}`, 'i'),
  },
  {
    rule_id: 'credential.assignment_single_quoted',
    category: 'credential',
    pattern: new RegExp(`${CREDENTIAL_ASSIGNMENT_KEY_SOURCE}${SINGLE_QUOTED_VALUE_SOURCE}`, 'i'),
  },
  {
    rule_id: 'credential.secret_assignment',
    category: 'credential',
    pattern: new RegExp(`${CREDENTIAL_ASSIGNMENT_KEY_SOURCE}${UNQUOTED_VALUE_SOURCE}`, 'i'),
  },
]

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const frequencies = new Map<string, number>()
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length
    return entropy - (probability * Math.log2(probability))
  }, 0)
}

export function hasHighEntropyToken(value: string): boolean {
  return (value.match(/[A-Za-z0-9+/_=-]{40,}/g) ?? []).some((candidate) => (
    candidate.length > MAX_UNCLASSIFIED_TOKEN_UNITS
    || (/[a-z]/.test(candidate)
      && /[A-Z]/.test(candidate)
      && /\d/.test(candidate)
      && shannonEntropy(candidate) >= 4.5)
  ))
}

export function matchesBuiltInSensitiveContent(value: string): boolean {
  return BUILT_IN_SENSITIVE_CONTENT_RULES.some(rule => rule.pattern.test(value)) || hasHighEntropyToken(value)
}

/**
 * Compatibility predicate used by existing bounded-output call sites.
 * Structured publication scans should use publication-scanner.ts instead.
 */
export function containsSensitiveContent(value: string): boolean {
  return matchesBuiltInSensitiveContent(value)
}
