# Guarded Publication

Phase 3 adds an opt-in, post-completion publication broker for automatic workflows. It creates a local immutable preview, scans all Git history reachable from the publication head, pins the source, publisher, and destination, and requires a separate one-shot approval before invoking an operator-configured publisher. Publication is disabled by default.

## Flow

1. Complete an automatic `development` or `e2e` workflow in its owning root session.
2. Run `/publication-preview <target>`.
3. Review the exact source object IDs, publisher identity digests, remote URL, destination ref, protection class, gates, scan counts, findings, expiry, artifact ID, and artifact digest.
4. Run `/publication-execute <artifact-id> <artifact-sha256>` only for a ready artifact.
5. Approve the external side effect. A target marked `approval_required` produces a separate protected-target approval first.
6. Inspect the durable result with `/publication-status [artifact-id]`.

Preview performs no network or publication side effect. Execution accepts no target, ref, URL, command, or payload override; all authority is frozen in the artifact and operator configuration.

## Configuration

Configure `publication` in `workflows.json`. The installer and migration leave it disabled and never invent targets, refs, URLs, executable paths, internal markers, credentials, or operational limits.

An enabled policy requires explicit values for:

- `artifact_ttl_ms`
- `git_timeout_ms`
- `max_artifacts_per_workflow`
- `max_commits`
- `max_objects`
- `max_blob_bytes`
- `max_total_scan_bytes`
- `max_findings`
- `record_settle_attempts`
- `record_settle_delay_ms`
- `record_settle_timeout_ms`
- At least one repository-specific internal marker
- At least one complete target

Each target defines:

- A display name and safe identifier.
- A root-owned absolute Git executable that is not group/world-writable.
- Full `refs/heads/...` base and head source refs plus a full `refs/...` destination ref.
- A local remote name and exact expected HTTPS or SSH URL without userinfo, query, or fragment.
- `deny`, `approval_required`, or `unprotected` classification.
- A fixed publisher argv exactly equal to `[absolute executable, "{request_file}"]`.
- A worktree-contained working directory, environment-name allowlist, timeout, output limit, and success code `[0]`.

The publisher is an operator-controlled security boundary. `argv[0]` must resolve to a root-owned native ELF or Mach-O executable outside the worktree that is not group/world-writable. Scripts and shebang interpreters are rejected because pinning a script descriptor does not pin the interpreter selected by the kernel. The executable is opened, identity-checked, inherited, and invoked through its pinned descriptor rather than its pathname. Environment values are inherited only for configured names and are never written into artifacts, returned requests, or audit events. Loader and interpreter control variables are prohibited. The inherited `PATH` contains only canonical directories whose complete path is root-owned and not group/world-writable. Restart OpenCode after changing publication configuration or installed commands/plugins.

## Preview Gates

The preview artifact records explicit gates:

- `workflow_completed`
- `target_allowed`
- `publisher_descriptor`
- `repository_snapshot`
- `content_scrub`

Publication requires the owning root session, the exact project worktree root, a completed automatic workflow, a clean index/worktree including staged, tracked, and non-ignored untracked files, a nonempty ancestor range, and a configured target that is not denied.

The Git snapshot fails closed for unsupported or unsafe repository features, including:

- Shallow, promisor, partial, alternate-object, replace-ref, or grafted repositories.
- Submodules and Git LFS pointers.
- Unsafe local Git configuration such as credential helpers, URL rewrites, push URLs, includes, executable filters, hooks, aliases, and repository SSH commands.
- Missing, oversized, opaque binary, invalid UTF-8, or malformed objects and metadata.
- A remote URL, checked-out head, worktree, configuration, object identity, or ref that changes during scanning.

The broker uses fixed local Git argv with no shell, no network commands, global/system configuration disabled, credential prompts disabled, and bounded cancellable process groups. The trusted Git executable identity is bound into the snapshot; every command reopens and verifies that identity, then invokes the opened file through an inherited descriptor. Path replacement between commands fails closed. Graft files are rejected in both the worktree Git directory and common Git directory, their containing-directory identities are rechecked after scanning, and raw commit parent closure is verified independently of revision walking. Every Git command is limited by `git_timeout_ms`; after termination is requested, that same configured interval is the maximum wait for process completion before the snapshot fails closed with explicit termination uncertainty.

## Scrub Scope

The scanner examines:

- Every commit object reachable from `head`, including base ancestry, messages, and authorship metadata.
- Every reachable tree and blob, including content added and later deleted.
- Every changed path in every reachable commit.
- Built-in credential, token, private-key, connection-string, secret-assignment, and high-entropy signatures.
- Operator-configured literal internal markers.
- Prohibited credential, private-key, secret-backup, environment, and private assistant-context paths.

Findings contain rule/category identifiers, safe location identities, and fingerprints. They never contain matched text or configured internal-marker literals. A finding blocks the artifact. The scanner intentionally blocks unsupported opaque binary data rather than claiming it was inspected.

Scanning is defense in depth, not proof that content is safe or legally publishable. Operator markers must cover private names and infrastructure identifiers relevant to the repository. Review the full artifact and repository history before approval.

## Execution Safety

Before dispatch, the broker:

1. Verifies the artifact bytes and supplied SHA-256.
2. Verifies workflow/session/worktree ownership, expiry, target, and configuration digest.
3. Revalidates the publisher identity and rebuilds the complete Git snapshot.
4. Requires publication permissions to resolve to `ask`; a silent `allow` is rejected.
5. Requests protected-target approval when configured.
6. Requests a separate external-side-effect approval with `always: []`.
7. Rebuilds the snapshot and revalidates the publisher identity again after approval.
8. Atomically consumes the artifact for one execution.
9. Durably records `dispatching` before process creation.
10. Streams an immutable in-memory request through fd3 to the fixed publisher and requires an exact request-bound acknowledgment on fd5.

The request includes an artifact-derived idempotency key, exact artifact/source/target identities, and the canonical worktree needed by the trusted adapter. It contains no inherited credential values and has no mutable pathname. The adapter receives the fd3 request path as its only argument. After consuming those exact bytes, completing the external operation, and reconciling the expected target state, it must write exactly `opencode-workflows-publication-ack-v1 <request-sha256>\n` to fd5 and close the descriptor. Missing, malformed, mismatched, or oversized acknowledgment data is ambiguous. All observed publisher output bytes are hashed and scanned but never returned or persisted as raw text. `output_truncated` reports either a configured output-limit overflow or incomplete capture after uncertain termination. Exceeding the configured combined output limit terminates the publisher and produces an ambiguous result.

Success requires both exit code `0` and the exact fd5 acknowledgment. Nonzero exits, signals, missing or invalid acknowledgment, cancellation, timeout, spawn uncertainty, termination uncertainty, or a crash after `dispatching` are `ambiguous`. After publisher termination is requested, its configured `timeout_ms` is also the maximum completion grace period; an overrun is persisted as termination uncertainty with truncated capture. The broker never automatically retries an ambiguous execution. Reconcile the exact external destination manually; compensation is a new side effect and requires separate approval.

## Persistence

Artifacts, durable capacity slots, one-shot claims, and hash-chained execution events are stored below the owning session runtime directory with private modes. Records are strict, digest-checked, symlink-resistant, hard-link-resistant, immutable, and file/directory-synchronized before they authorize dispatch. Every successful claim already references a durable `dispatching` event. All directly created immutable records carry an explicit completion marker; readers retry only marker-incomplete records, using asynchronous delays bounded by both the configured attempt count and `record_settle_timeout_ms`. Complete malformed records and filesystem safety failures fail immediately. When publication is disabled, status access never creates or repairs the publication layout; an absent layout is reported as an empty status, while an unsafe existing layout fails closed without changing permissions.

The checked-in artifact and event JSON Schemas validate their portable structural constraints. Runtime Zod contracts additionally verify semantic relationships that JSON Schema cannot calculate, including content digests, time ordering, counts, and event-chain hashes.

The local hash chain detects direct record modification when read, but it is not an externally signed append-only ledger and cannot protect against a fully privileged same-user attacker rewriting the entire private runtime. Back up or export audit evidence to an independently protected system when that assurance is required.

## Boundary

This broker is not an OS sandbox, deployment engine, package publisher, provider-specific API client, or universal data-loss-prevention system. It does not fetch remote state, discover provider protection rules, commit changes, generate release notes, push refs itself, retry, reconcile, or roll back an external effect. The configured publisher must implement target-specific authentication, remote compare-and-swap/idempotency, protection checks that can only strengthen local policy, and post-effect reconciliation.

Publication tools are unavailable inside automatic child sessions, including bounded children. The root-side broker is attended and POSIX-only because reliable descendant process-group termination and descriptor semantics are required.
