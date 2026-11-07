import { describe, expect, it } from "vitest";
import { resolveCompactWindow } from "../../src/sessions/session-compact-thresholds.js";

// Stand-in for ModelInfoService.getContextWindow (the real one resolves
// observed → ingested → heuristic). resolveCompactWindow special-cases no
// model — it just picks the first candidate it can resolve a window for. The
// 1M/200K values here are arbitrary stand-ins to exercise that candidate loop.
const windowFor = (m: string | undefined): number =>
  m === "opus" || m === "claude-opus-4-8"
    ? 1_000_000
    : m === "sonnet" || m === "claude-sonnet-4-6"
      ? 200_000
      : 0;

describe("resolveCompactWindow (task 029)", () => {
  it("returns the window of the first resolvable candidate", () => {
    expect(
      resolveCompactWindow(
        "claude",
        [undefined, "claude-opus-4-8", "sonnet"],
        windowFor,
      ),
    ).toBe(1_000_000);
  });

  it("skips the 'default' sentinel and unknown models", () => {
    expect(
      resolveCompactWindow(
        "claude",
        ["default", "unknown", "sonnet"],
        windowFor,
      ),
    ).toBe(200_000);
  });

  it("returns undefined when no candidate resolves a window", () => {
    expect(
      resolveCompactWindow(
        "claude",
        [undefined, "default", "unknown"],
        windowFor,
      ),
    ).toBeUndefined();
  });
});
