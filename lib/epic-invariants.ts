import { stableCanonicalJson } from './epic-canonical-json.ts'
import { EpicValidationError } from './epic-contract-schemas.ts'

export function assertEpicEqual(label: string, previous: unknown, next: unknown): void {
  if (stableCanonicalJson(previous) !== stableCanonicalJson(next)) {
    throw new EpicValidationError(`${label} is immutable across epic revisions`)
  }
}

export function assertEpicExactPrefix(label: string, previous: unknown[], next: unknown[]): void {
  if (next.length < previous.length) throw new EpicValidationError(`${label} history cannot be shortened`)
  previous.forEach((entry, index) => assertEpicEqual(`${label}[${index}]`, entry, next[index]))
}
