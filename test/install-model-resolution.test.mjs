/**
 * Tests for resolveModelForAgent() logic from install.mjs.
 *
 * The function is not exported from install.mjs (it is a CLI entry-point script
 * that calls main() immediately), so the logic is reimplemented here verbatim
 * from the source. The tests validate the BEHAVIORAL CONTRACT rather than
 * calling the original module directly.
 *
 * Source of truth: install.mjs lines 217-236 and the MODEL_SAFE_RE pattern.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Reimplementation of resolveModelForAgent() — must stay in sync with
// install.mjs. If the source changes, update this copy and re-run tests.
// ---------------------------------------------------------------------------

const MODEL_SAFE_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:@-]+$/;

/**
 * @param {string|null} agentName
 * @param {string|null} tier
 * @param {object} config
 * @returns {string|null}
 */
function resolveModelForAgent(agentName, tier, config) {
  // 1. Check per-agent override (skip keys starting with '_')
  const agentModels = config.agent_models || {};
  if (agentName && agentModels[agentName]) {
    const model = agentModels[agentName];
    if (typeof model === "string" && MODEL_SAFE_RE.test(model)) {
      return model;
    } else if (typeof model === "string") {
      // In the real implementation this emits a console.warn — tested via
      // fallback behaviour rather than capturing the warning.
    }
  }
  // 2. Fall back to tier
  const tiers = config.model_tiers || {};
  if (tier && tiers[tier] && tiers[tier].length > 0) {
    return tiers[tier][0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reimplementation of loadWorkflowConfig() filtering logic — the part that
// strips '_'-prefixed keys from agent_models before storing them.
// ---------------------------------------------------------------------------

/**
 * Mirrors the agent_models filtering step inside loadWorkflowConfig().
 * @param {object} raw  — raw parsed JSON object
 * @returns {object}    — filtered config suitable for resolveModelForAgent()
 */
function buildFilteredConfig(raw) {
  const model_tiers = {};
  for (const [tier, models] of Object.entries(raw.model_tiers || {})) {
    if (Array.isArray(models) && models.length > 0) {
      model_tiers[tier] = models;
    }
  }

  const agentModels = raw.agent_models || {};
  const agent_models = {};
  for (const [key, val] of Object.entries(agentModels)) {
    if (!key.startsWith("_")) {
      agent_models[key] = val;
    }
  }

  return { model_tiers, agent_models };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModelForAgent()", () => {
  // ------------------------------------------------------------------
  // Test 1 — per-agent override takes precedence over tier
  // ------------------------------------------------------------------
  it("returns per-agent override when one is configured", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "override/model" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "override/model");
  });

  // ------------------------------------------------------------------
  // Test 2 — falls back to tier when no matching agent override exists
  // ------------------------------------------------------------------
  it("falls back to first tier model when no agent override is present", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: {},
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  // ------------------------------------------------------------------
  // Test 3 — absent agent_models key behaves the same as an empty map
  // ------------------------------------------------------------------
  it("falls back to tier when agent_models key is absent from config", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      // No agent_models key
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  // ------------------------------------------------------------------
  // Test 4 — invalid model format (no slash) is rejected; falls back
  // ------------------------------------------------------------------
  it("rejects agent override without a slash and falls back to tier", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "invalidmodel" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  // ------------------------------------------------------------------
  // Test 5 — _example_ prefixed keys are filtered out by loadWorkflowConfig;
  // after filtering, resolveModelForAgent sees no override for that agent
  // ------------------------------------------------------------------
  it("ignores _example_ prefixed keys after config-loading filter is applied", () => {
    const raw = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "_example_wf-executor": "override/model" },
    };
    const config = buildFilteredConfig(raw);
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  it("any key starting with underscore is stripped during config load", () => {
    const raw = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: {
        "_comment_any_key": "should/be-ignored",
        "_": "also/ignored",
      },
    };
    const config = buildFilteredConfig(raw);
    // None of those stripped keys should appear in agent_models
    assert.deepEqual(config.agent_models, {});
  });

  // ------------------------------------------------------------------
  // Test 6 — model string containing a newline (injection attempt)
  // is rejected by MODEL_SAFE_RE and falls back to tier
  // ------------------------------------------------------------------
  it("rejects unsafe model string with embedded newline and falls back to tier", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "bad/model\ninjection: attack" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  it("rejects model string containing a space (YAML-breaking character)", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "bad model/string" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  it("rejects model string that is just a slash with no provider", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "/no-provider" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  // ------------------------------------------------------------------
  // Test 7 — model_tiers is an array; function returns first element
  // ------------------------------------------------------------------
  it("returns the first element from a multi-model tier array", () => {
    const config = {
      model_tiers: { high: ["first/model", "second/model", "third/model"] },
    };
    const result = resolveModelForAgent("wf-executor", "high", config);
    assert.equal(result, "first/model");
  });

  // ------------------------------------------------------------------
  // Test 8 — completely empty config returns null
  // ------------------------------------------------------------------
  it("returns null when config is completely empty", () => {
    const result = resolveModelForAgent("wf-executor", "mid", {});
    assert.equal(result, null);
  });

  // ------------------------------------------------------------------
  // Additional edge cases
  // ------------------------------------------------------------------

  it("returns null when agentName is null and no tier config exists", () => {
    const result = resolveModelForAgent(null, "mid", {});
    assert.equal(result, null);
  });

  it("returns null when tier is null and no agent override matches", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: {},
    };
    const result = resolveModelForAgent("wf-executor", null, config);
    assert.equal(result, null);
  });

  it("handles a valid model string with colons (versioned model IDs like anthropic/claude-3-5-sonnet:latest)", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "anthropic/claude-3-5-sonnet:latest" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "anthropic/claude-3-5-sonnet:latest");
  });

  it("handles a valid model string with @ sign (versioned model IDs)", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "openai/gpt-4o@2024-11" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "openai/gpt-4o@2024-11");
  });

  it("agent override for a different agent does not affect current agent", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "other-agent": "other/model" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });

  it("returns null when tier array exists but is empty after buildFilteredConfig strips it", () => {
    // buildFilteredConfig skips tiers with empty arrays
    const raw = {
      model_tiers: { mid: [] },
    };
    const config = buildFilteredConfig(raw);
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, null);
  });

  it("uses low tier model when tier is 'low'", () => {
    const config = {
      model_tiers: {
        low: ["cheap/model"],
        mid: ["mid/model"],
        high: ["expensive/model"],
      },
    };
    assert.equal(resolveModelForAgent("any-agent", "low", config), "cheap/model");
    assert.equal(resolveModelForAgent("any-agent", "mid", config), "mid/model");
    assert.equal(resolveModelForAgent("any-agent", "high", config), "expensive/model");
  });

  it("non-existent tier returns null", () => {
    const config = {
      model_tiers: { mid: ["mid/model"] },
    };
    const result = resolveModelForAgent("wf-executor", "ultra", config);
    assert.equal(result, null);
  });

  it("MODEL_SAFE_RE accepts dots in provider name", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "openai.azure/gpt-4o" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "openai.azure/gpt-4o");
  });

  it("rejects model string with semicolon (potential injection)", () => {
    const config = {
      model_tiers: { mid: ["tier-model"] },
      agent_models: { "wf-executor": "bad/model;rm -rf" },
    };
    const result = resolveModelForAgent("wf-executor", "mid", config);
    assert.equal(result, "tier-model");
  });
});

describe("buildFilteredConfig() — mirrors loadWorkflowConfig() filtering", () => {
  it("preserves non-underscore agent_models keys", () => {
    const raw = {
      model_tiers: { mid: ["mid/model"] },
      agent_models: { "wf-executor": "provider/model" },
    };
    const config = buildFilteredConfig(raw);
    assert.equal(config.agent_models["wf-executor"], "provider/model");
  });

  it("strips any key beginning with underscore", () => {
    const raw = {
      model_tiers: { mid: ["mid/model"] },
      agent_models: {
        "_comment_hint": "ignore/me",
        "_example_agent": "example/model",
        "real-agent": "real/model",
      },
    };
    const config = buildFilteredConfig(raw);
    assert.ok(!("_comment_hint" in config.agent_models));
    assert.ok(!("_example_agent" in config.agent_models));
    assert.equal(config.agent_models["real-agent"], "real/model");
  });

  it("returns empty model_tiers when raw has none", () => {
    const config = buildFilteredConfig({});
    assert.deepEqual(config.model_tiers, {});
  });

  it("skips tier entries whose value is an empty array", () => {
    const raw = { model_tiers: { mid: [], high: ["high/model"] } };
    const config = buildFilteredConfig(raw);
    assert.ok(!("mid" in config.model_tiers));
    assert.deepEqual(config.model_tiers.high, ["high/model"]);
  });
});
