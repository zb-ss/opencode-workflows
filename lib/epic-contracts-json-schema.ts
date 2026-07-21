import { z } from 'zod'

import {
  EPIC_STATE_SCHEMA_ID,
  EpicStateStructuralSchema,
} from './epic-contract-schemas.ts'

export function epicStateJsonSchema(): Record<string, unknown> {
  const structural = z.toJSONSchema(EpicStateStructuralSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: EPIC_STATE_SCHEMA_ID,
    title: 'Epic State',
    description: 'Structural schema for epic state version 2.',
    $comment: 'Authoritative runtime validation additionally enforces DAG, transition, identity, timestamp, digest, scoped usage, budget hierarchy, ownership, and revision-order invariants that JSON Schema cannot express.',
    ...structural,
  }
}
