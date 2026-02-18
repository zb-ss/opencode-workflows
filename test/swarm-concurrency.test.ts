/**
 * Tests for ConcurrencyManager and StalenessDetector from plugin/swarm-manager.ts.
 *
 * Those classes are not exported from the plugin (only the Plugin export is public).
 * The classes are reimplemented here verbatim from the source so the tests verify
 * the behavioral contract. If the source changes, update these copies and re-run.
 *
 * Run with:
 *   node --experimental-strip-types --test test/swarm-concurrency.test.ts
 *
 * Source of truth: plugin/swarm-manager.ts lines 75-143.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Type definitions (copied from lib/types.ts)
// ---------------------------------------------------------------------------

interface SwarmUserConfig {
  default_concurrency?: number;
  stale_timeout_ms?: number;
  poll_interval_ms?: number;
  provider_concurrency?: Record<string, number>;
  progress_timeout_ms?: number;
}

interface TrackedSession {
  sessionId: string;
  taskId: string;
  agent: string;
  provider: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  lastMessageCount: number;
  lastProgressAt: number;
}

// ---------------------------------------------------------------------------
// Reimplementation of ConcurrencyManager — must stay in sync with
// plugin/swarm-manager.ts lines 75-108.
// ---------------------------------------------------------------------------

class ConcurrencyManager {
  private slots: Map<string, number> = new Map();
  private limits: Map<string, number>;
  private defaultLimit: number;

  constructor(config: SwarmUserConfig) {
    this.defaultLimit = config.default_concurrency ?? 4;
    this.limits = new Map(Object.entries(config.provider_concurrency ?? {}));
  }

  canAcquire(provider: string): boolean {
    const limit = this.limits.get(provider) ?? this.defaultLimit;
    const current = this.slots.get(provider) ?? 0;
    return current < limit;
  }

  acquire(provider: string): void {
    const current = this.slots.get(provider) ?? 0;
    this.slots.set(provider, current + 1);
  }

  release(provider: string): void {
    const current = this.slots.get(provider) ?? 0;
    this.slots.set(provider, Math.max(0, current - 1));
  }

  getActive(provider: string): number {
    return this.slots.get(provider) ?? 0;
  }

  getLimit(provider: string): number {
    return this.limits.get(provider) ?? this.defaultLimit;
  }
}

// ---------------------------------------------------------------------------
// Reimplementation of StalenessDetector — must stay in sync with
// plugin/swarm-manager.ts lines 120-143.
// ---------------------------------------------------------------------------

class StalenessDetector {
  private staleTimeoutMs: number;
  private progressTimeoutMs: number;

  constructor(config: SwarmUserConfig) {
    this.staleTimeoutMs = Math.max(60000, config.stale_timeout_ms ?? 180000);
    this.progressTimeoutMs = Math.max(60000, config.progress_timeout_ms ?? 600000);
  }

  check(session: TrackedSession, now: number): "active" | "stale" | "stuck" {
    const runtime = now - session.startedAt;
    if (runtime < 30000) return "active"; // min 30s before checking

    const timeSinceProgress = now - session.lastProgressAt;

    if (session.lastMessageCount === 0 && timeSinceProgress > this.staleTimeoutMs) {
      return "stale"; // never made any progress
    }
    if (session.lastMessageCount > 0 && timeSinceProgress > this.progressTimeoutMs) {
      return "stuck"; // made progress but stalled
    }
    return "active";
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a TrackedSession with sensible defaults, allowing partial overrides.
 */
function makeSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  const now = Date.now();
  return {
    sessionId: "sess-test",
    taskId: "task-test",
    agent: "wf-executor",
    provider: "anthropic",
    status: "running",
    startedAt: now,
    lastMessageCount: 0,
    lastProgressAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ConcurrencyManager tests
// ---------------------------------------------------------------------------

describe("ConcurrencyManager", () => {
  // ----------------------------------------------------------------
  // Test 1 — can acquire up to provider limit
  // ----------------------------------------------------------------
  it("allows acquiring slots up to the configured provider limit", () => {
    const mgr = new ConcurrencyManager({
      provider_concurrency: { anthropic: 2 },
    });

    // First acquire
    assert.ok(mgr.canAcquire("anthropic"), "should be able to acquire slot 1");
    mgr.acquire("anthropic");
    assert.equal(mgr.getActive("anthropic"), 1);

    // Second acquire
    assert.ok(mgr.canAcquire("anthropic"), "should be able to acquire slot 2");
    mgr.acquire("anthropic");
    assert.equal(mgr.getActive("anthropic"), 2);
  });

  // ----------------------------------------------------------------
  // Test 2 — cannot acquire when at provider limit
  // ----------------------------------------------------------------
  it("blocks acquisition when provider is at its concurrency limit", () => {
    const mgr = new ConcurrencyManager({
      provider_concurrency: { anthropic: 2 },
    });

    mgr.acquire("anthropic");
    mgr.acquire("anthropic");

    assert.ok(
      !mgr.canAcquire("anthropic"),
      "should not allow a third slot beyond limit of 2"
    );
    assert.equal(mgr.getActive("anthropic"), 2);
  });

  // ----------------------------------------------------------------
  // Test 3 — release frees a slot for another acquire
  // ----------------------------------------------------------------
  it("makes a slot available again after release", () => {
    const mgr = new ConcurrencyManager({
      provider_concurrency: { anthropic: 1 },
    });

    mgr.acquire("anthropic");
    assert.ok(!mgr.canAcquire("anthropic"), "at limit before release");

    mgr.release("anthropic");
    assert.ok(mgr.canAcquire("anthropic"), "slot available after release");
    assert.equal(mgr.getActive("anthropic"), 0);
  });

  it("release never drives active count below zero", () => {
    const mgr = new ConcurrencyManager({});
    // Release on a provider with no slots acquired
    mgr.release("anthropic");
    assert.equal(mgr.getActive("anthropic"), 0);

    // Release again — still zero
    mgr.release("anthropic");
    assert.equal(mgr.getActive("anthropic"), 0);
  });

  // ----------------------------------------------------------------
  // Test 4 — unknown provider uses default_concurrency
  // ----------------------------------------------------------------
  it("uses default_concurrency for providers not in provider_concurrency map", () => {
    const mgr = new ConcurrencyManager({
      default_concurrency: 3,
      provider_concurrency: { anthropic: 1 },
    });

    assert.equal(mgr.getLimit("unknown-provider"), 3);
    assert.equal(mgr.getLimit("openai"), 3);

    // Should be able to acquire 3 slots for an unknown provider
    mgr.acquire("openai");
    mgr.acquire("openai");
    mgr.acquire("openai");
    assert.ok(!mgr.canAcquire("openai"), "fourth slot should be blocked");
    assert.equal(mgr.getActive("openai"), 3);
  });

  // ----------------------------------------------------------------
  // Test 5 — default limit of 4 when no config is provided
  // ----------------------------------------------------------------
  it("defaults to a concurrency limit of 4 when no config is supplied", () => {
    const mgr = new ConcurrencyManager({});

    assert.equal(mgr.getLimit("any-provider"), 4);

    // Can acquire 4 slots
    for (let i = 0; i < 4; i++) {
      assert.ok(mgr.canAcquire("any-provider"), `slot ${i + 1} should be acquirable`);
      mgr.acquire("any-provider");
    }

    // Fifth slot must be blocked
    assert.ok(!mgr.canAcquire("any-provider"), "fifth slot should be blocked at default limit of 4");
  });

  // ----------------------------------------------------------------
  // Additional edge cases
  // ----------------------------------------------------------------

  it("tracks slots independently per provider", () => {
    const mgr = new ConcurrencyManager({
      provider_concurrency: { anthropic: 1, openai: 2 },
    });

    mgr.acquire("anthropic");
    // anthropic is at limit; openai still has capacity
    assert.ok(!mgr.canAcquire("anthropic"), "anthropic should be at limit");
    assert.ok(mgr.canAcquire("openai"), "openai should still have capacity");

    mgr.acquire("openai");
    mgr.acquire("openai");
    assert.ok(!mgr.canAcquire("openai"), "openai should now be at limit");

    // Releasing anthropic should only affect anthropic
    mgr.release("anthropic");
    assert.ok(mgr.canAcquire("anthropic"), "anthropic available after release");
    assert.ok(!mgr.canAcquire("openai"), "openai still blocked");
  });

  it("getActive returns 0 for a provider that was never touched", () => {
    const mgr = new ConcurrencyManager({ default_concurrency: 2 });
    assert.equal(mgr.getActive("virgin-provider"), 0);
  });

  it("getLimit returns provider-specific limit when one is configured", () => {
    const mgr = new ConcurrencyManager({
      default_concurrency: 4,
      provider_concurrency: { anthropic: 10 },
    });
    assert.equal(mgr.getLimit("anthropic"), 10);
    assert.equal(mgr.getLimit("openai"), 4);
  });
});

// ---------------------------------------------------------------------------
// StalenessDetector tests
// ---------------------------------------------------------------------------

describe("StalenessDetector", () => {
  const BASE_NOW = 1_700_000_000_000; // fixed reference timestamp (ms)

  // ----------------------------------------------------------------
  // Test 6 — session within 30s grace period is always 'active'
  // ----------------------------------------------------------------
  it("returns 'active' for sessions within the 30s grace period", () => {
    const detector = new StalenessDetector({
      stale_timeout_ms: 60000,
      progress_timeout_ms: 60000,
    });

    // Session that started 29 seconds ago with no messages
    const session = makeSession({
      startedAt: BASE_NOW - 29_000,
      lastProgressAt: BASE_NOW - 29_000,
      lastMessageCount: 0,
    });

    const result = detector.check(session, BASE_NOW);
    assert.equal(result, "active");
  });

  it("still returns 'active' at exactly the 30s boundary (< 30000 means active)", () => {
    const detector = new StalenessDetector({});
    const session = makeSession({
      startedAt: BASE_NOW - 29_999,
      lastProgressAt: BASE_NOW - 29_999,
      lastMessageCount: 0,
    });
    // runtime = 29999 which is < 30000, so must be 'active'
    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  // ----------------------------------------------------------------
  // Test 7 — session with no progress after stale_timeout_ms is 'stale'
  // ----------------------------------------------------------------
  it("returns 'stale' when lastMessageCount is 0 and stale_timeout_ms has elapsed", () => {
    const detector = new StalenessDetector({ stale_timeout_ms: 180_000 });

    // Session started 5 minutes ago, no messages ever
    const session = makeSession({
      startedAt: BASE_NOW - 300_000,
      lastProgressAt: BASE_NOW - 181_000, // just over 180s of no progress
      lastMessageCount: 0,
    });

    assert.equal(detector.check(session, BASE_NOW), "stale");
  });

  it("does not mark session as 'stale' when stale_timeout_ms has not elapsed", () => {
    const detector = new StalenessDetector({ stale_timeout_ms: 180_000 });

    // No messages, but only 2 minutes since last progress
    const session = makeSession({
      startedAt: BASE_NOW - 300_000,
      lastProgressAt: BASE_NOW - 60_000, // only 60s of no progress
      lastMessageCount: 0,
    });

    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  // ----------------------------------------------------------------
  // Test 8 — session with prior progress that stalled after progress_timeout_ms
  // ----------------------------------------------------------------
  it("returns 'stuck' when session had messages but stalled beyond progress_timeout_ms", () => {
    const detector = new StalenessDetector({ progress_timeout_ms: 600_000 });

    // Session made progress (has messages), but nothing new for over 10 minutes
    const session = makeSession({
      startedAt: BASE_NOW - 900_000,  // started 15 min ago
      lastProgressAt: BASE_NOW - 601_000, // last progress over 10 min ago
      lastMessageCount: 5,
    });

    assert.equal(detector.check(session, BASE_NOW), "stuck");
  });

  it("does not mark session as 'stuck' when progress_timeout_ms has not elapsed", () => {
    const detector = new StalenessDetector({ progress_timeout_ms: 600_000 });

    const session = makeSession({
      startedAt: BASE_NOW - 900_000,
      lastProgressAt: BASE_NOW - 300_000, // 5 min ago — still within timeout
      lastMessageCount: 5,
    });

    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  // ----------------------------------------------------------------
  // Test 9 — session making regular progress is 'active'
  // ----------------------------------------------------------------
  it("returns 'active' when session has recent progress and message count > 0", () => {
    const detector = new StalenessDetector({
      stale_timeout_ms: 180_000,
      progress_timeout_ms: 600_000,
    });

    const session = makeSession({
      startedAt: BASE_NOW - 120_000, // 2 min old (past grace period)
      lastProgressAt: BASE_NOW - 5_000, // progress 5s ago
      lastMessageCount: 12,
    });

    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  it("returns 'active' for a session with 0 messages but recent lastProgressAt", () => {
    const detector = new StalenessDetector({ stale_timeout_ms: 180_000 });

    const session = makeSession({
      startedAt: BASE_NOW - 60_000,
      lastProgressAt: BASE_NOW - 1_000, // 1s ago
      lastMessageCount: 0,
    });

    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  // ----------------------------------------------------------------
  // Test 10 — minimum stale_timeout_ms clamped to 60000
  // ----------------------------------------------------------------
  it("clamps stale_timeout_ms to a minimum of 60000ms even when configured lower", () => {
    // Configure an absurdly low 1ms timeout
    const detector = new StalenessDetector({ stale_timeout_ms: 1 });

    // Session running for 2 minutes with no messages; since the true effective
    // timeout is 60000ms this must be 'stale' (timeSinceProgress > 60000ms)
    const session = makeSession({
      startedAt: BASE_NOW - 120_000,
      lastProgressAt: BASE_NOW - 61_000, // 61s — over clamped 60s minimum
      lastMessageCount: 0,
    });

    assert.equal(detector.check(session, BASE_NOW), "stale");
  });

  it("clamps stale_timeout_ms so that 59s elapsed is still 'active' even with a 1ms config", () => {
    const detector = new StalenessDetector({ stale_timeout_ms: 1 });

    const session = makeSession({
      startedAt: BASE_NOW - 120_000,
      lastProgressAt: BASE_NOW - 59_000, // 59s — under the 60s clamped minimum
      lastMessageCount: 0,
    });

    assert.equal(detector.check(session, BASE_NOW), "active");
  });

  it("clamps progress_timeout_ms to a minimum of 60000ms", () => {
    // Configure a very low progress timeout
    const detector = new StalenessDetector({ progress_timeout_ms: 1 });

    // 61s since last progress, session had messages — must be 'stuck'
    const session = makeSession({
      startedAt: BASE_NOW - 300_000,
      lastProgressAt: BASE_NOW - 61_000,
      lastMessageCount: 3,
    });

    assert.equal(detector.check(session, BASE_NOW), "stuck");
  });

  it("defaults stale_timeout_ms to 180000 when not configured", () => {
    const detector = new StalenessDetector({});

    // 179s elapsed — should still be 'active'
    const sessionActive = makeSession({
      startedAt: BASE_NOW - 300_000,
      lastProgressAt: BASE_NOW - 179_000,
      lastMessageCount: 0,
    });
    assert.equal(detector.check(sessionActive, BASE_NOW), "active");

    // 181s elapsed — should now be 'stale'
    const sessionStale = makeSession({
      startedAt: BASE_NOW - 300_000,
      lastProgressAt: BASE_NOW - 181_000,
      lastMessageCount: 0,
    });
    assert.equal(detector.check(sessionStale, BASE_NOW), "stale");
  });

  it("defaults progress_timeout_ms to 600000 when not configured", () => {
    const detector = new StalenessDetector({});

    // 599s elapsed with messages — still 'active'
    const sessionActive = makeSession({
      startedAt: BASE_NOW - 900_000,
      lastProgressAt: BASE_NOW - 599_000,
      lastMessageCount: 1,
    });
    assert.equal(detector.check(sessionActive, BASE_NOW), "active");

    // 601s elapsed with messages — 'stuck'
    const sessionStuck = makeSession({
      startedAt: BASE_NOW - 900_000,
      lastProgressAt: BASE_NOW - 601_000,
      lastMessageCount: 1,
    });
    assert.equal(detector.check(sessionStuck, BASE_NOW), "stuck");
  });

  it("stale check takes priority over stuck check when lastMessageCount is 0", () => {
    // When there are no messages the 'stale' branch runs first.
    // Even if progress_timeout_ms would also fire, the result must be 'stale'.
    const detector = new StalenessDetector({
      stale_timeout_ms: 180_000,
      progress_timeout_ms: 60_000, // lower than stale
    });

    const session = makeSession({
      startedAt: BASE_NOW - 600_000,
      lastProgressAt: BASE_NOW - 200_000,
      lastMessageCount: 0, // no messages — stale branch applies
    });

    assert.equal(detector.check(session, BASE_NOW), "stale");
  });
});
