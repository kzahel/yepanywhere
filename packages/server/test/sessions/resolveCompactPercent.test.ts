import { describe, expect, it } from "vitest";
import { resolveCompactPercent } from "../../src/sessions/session-compact-thresholds.js";

describe("resolveCompactPercent (task 029: direct YA-model-id lookup)", () => {
  const map = { opus: 5, sonnet: 30, default: 40 };

  it("looks up the resolved YA model id directly", () => {
    expect(resolveCompactPercent(map, "opus")).toBe(5);
    expect(resolveCompactPercent(map, "sonnet")).toBe(30);
  });

  it("does NOT family-fallback a reported id — that mapping is the provider helper's job", () => {
    // The reported→YA-id canonicalization now happens upstream via
    // provider.yaModelIdForReported (see ClaudeProvider.yaModelIdForReported);
    // resolveCompactPercent keys by the already-resolved YA id only.
    expect(resolveCompactPercent(map, "claude-opus-4-8")).toBeUndefined();
    expect(resolveCompactPercent(map, "claude-sonnet-4-6")).toBeUndefined();
  });

  it("never keys by the 'default' runtime holdout", () => {
    expect(resolveCompactPercent(map, "default")).toBeUndefined();
  });

  it("returns undefined for an unknown id, an absent map, or no id", () => {
    expect(resolveCompactPercent(map, "haiku")).toBeUndefined();
    expect(resolveCompactPercent(undefined, "opus")).toBeUndefined();
    expect(resolveCompactPercent(map, undefined)).toBeUndefined();
  });
});
