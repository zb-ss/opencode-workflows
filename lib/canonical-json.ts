import { createHash } from 'node:crypto'

export function stableCanonicalJson(value: unknown): string {
  const active = new Set<object>()

  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('canonical JSON requires finite numbers')
      return candidate
    }
    if (typeof candidate !== 'object') throw new Error('canonical JSON contains an unsupported value')
    if (active.has(candidate)) throw new Error('canonical JSON must not contain cycles')

    active.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        if (Object.keys(candidate).some(key => !/^(?:0|[1-9][0-9]*)$/.test(key))) {
          throw new Error('canonical JSON arrays must not have named properties')
        }
        return Array.from({ length: candidate.length }, (_, index) => {
          if (!(index in candidate)) throw new Error('canonical JSON arrays must not be sparse')
          return canonicalize(candidate[index])
        })
      }

      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('canonical JSON objects must be plain objects')
      }
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => compareOrdinal(left, right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      )
    } finally {
      active.delete(candidate)
    }
  }

  return JSON.stringify(canonicalize(value))
}

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(stableCanonicalJson(value))
}
