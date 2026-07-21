import { sha256Hex, stableCanonicalJson } from './epic-canonical-json.ts'
import type { EpicIdentity, EpicIntegrationEvent, EpicItem, EpicState } from './epic-contract-schemas.ts'
import type { EpicIssueReporter } from './epic-validation.ts'

export function computeEpicIdentityDigest(identity: EpicIdentity): string { return sha256Hex(stableCanonicalJson(identity)) }
export function computeDependencySnapshotDigest(state: EpicState, item: EpicItem): string {
  return sha256Hex(stableCanonicalJson(item.dependencies.map(item_id => ({ item_id, integration_commit: state.items[item_id]?.integration_commit ?? null }))))
}
export function computeIntegrationEventDigest(event: EpicIntegrationEvent): string {
  const { event_digest: _digest, ...without_digest } = event
  return sha256Hex(stableCanonicalJson(without_digest))
}
export function projectIdentitySha256(project_root: string): string { return sha256Hex(project_root) }

export function validateIntegrationLog(state: EpicState, issue: EpicIssueReporter): void {
  const event_ids = new Set<string>()
  state.integration_log.forEach((event, index) => {
    if (event_ids.has(event.event_id)) issue(['integration_log', index, 'event_id'], `duplicate integration event ID: ${event.event_id}`)
    event_ids.add(event.event_id)
    const item = state.items[event.item_id]
    if (!item) issue(['integration_log', index, 'item_id'], `integration event references unknown item ${event.item_id}`)
    const expected_previous = index === 0 ? null : state.integration_log[index - 1]!.event_digest
    if (event.previous_event_digest !== expected_previous) issue(['integration_log', index, 'previous_event_digest'], `event ${event.event_id} previous_event_digest does not link to preceding event`)
    if (computeIntegrationEventDigest(event) !== event.event_digest) issue(['integration_log', index, 'event_digest'], `event ${event.event_id} digest does not match content`)
    if (Date.parse(event.recorded_at) < Date.parse(state.created_at)) issue(['integration_log', index, 'recorded_at'], 'integration event cannot predate the epic')
    if (Date.parse(event.recorded_at) > Date.parse(state.updated_at)) issue(['integration_log', index, 'recorded_at'], 'integration event cannot exceed state updated_at')
    if (index > 0 && Date.parse(event.recorded_at) < Date.parse(state.integration_log[index - 1]!.recorded_at)) issue(['integration_log', index, 'recorded_at'], 'integration event timestamps must be monotonic')
    if (!item) return
    if (event.dependency_snapshot_sha256 !== computeDependencySnapshotDigest(state, item)) issue(['integration_log', index, 'dependency_snapshot_sha256'], 'integration event dependency snapshot does not match frozen dependencies')
    const boundAttempts = item.attempts.filter(attempt => attempt.attempt_id === event.attempt_id
      && attempt.status === 'passed' && attempt.checkpoint_commit === event.source_commit
      && attempt.review_evidence_digest === event.review_evidence_digest)
    if (boundAttempts.length !== 1) issue(['integration_log', index], 'integration event must bind exactly one historical passed attempt')
    if (event.result === 'success' && event.target_commit !== item.integration_commit) issue(['integration_log', index, 'target_commit'], 'successful integration event target commit does not match item integration commit')
  })
}
