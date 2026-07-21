import { createHash } from 'node:crypto'

export const HASH_IDENTIFIER_HEX_LENGTH = 24

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_IDENTIFIER_HEX_LENGTH)
}
