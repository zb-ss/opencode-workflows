const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s"'\r\n]{8,}/i,
]

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>()
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length
    return entropy - (probability * Math.log2(probability))
  }, 0)
}

function hasHighEntropyToken(value: string): boolean {
  return (value.match(/[A-Za-z0-9+/_=-]{40,}/g) ?? []).some((candidate) => (
    /[a-z]/.test(candidate)
    && /[A-Z]/.test(candidate)
    && /\d/.test(candidate)
    && shannonEntropy(candidate) >= 4.5
  ))
}

export function containsSensitiveContent(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value)) || hasHighEntropyToken(value)
}
