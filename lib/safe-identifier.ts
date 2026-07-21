import { z } from 'zod'

export const SAFE_IDENTIFIER_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]*$'
export const SAFE_IDENTIFIER_PATTERN = new RegExp(SAFE_IDENTIFIER_SOURCE)
export const MAX_SAFE_IDENTIFIER_LENGTH = 64

const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export const SafeIdentifierSchema = z.string()
  .min(1)
  .max(MAX_SAFE_IDENTIFIER_LENGTH)
  .regex(SAFE_IDENTIFIER_PATTERN)
  .refine(value => !RESERVED_PROPERTY_NAMES.has(value), {
    message: 'reserved object property names are not valid identifiers',
  })

export function isSafeIdentifier(value: unknown): value is string {
  return SafeIdentifierSchema.safeParse(value).success
}
