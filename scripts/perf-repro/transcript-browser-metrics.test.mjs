import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distribution,
  summarizeTranscriptProbe,
} from "./transcript-browser-metrics.mjs";

test("a sparse stall fails typing and remains visible when frame p95 hides it", () => {
  const raw = {
    frames: [...Array(300).fill(1000 / 60), 150],
    keys: [{ expected: "a", value: "a", valueAtFrame: "a", latencyMs: 151 }],
    inputValue: "a",
    markers: [{ domLatencyMs: 152, latenessMs: 150 }],
    pending: 0,
    snapshot: { unexpected: [], loadedMessages: 84 },
    mountedRows: 20,
    longTasks: [{ at: 100, ms: 150 }],
  };
  const summary = summarizeTranscriptProbe(
    raw,
    Array(60).fill(1000 / 60),
    1,
    "a",
  );
  assert.equal(summary.valid, true);
  assert.equal(summary.responsiveInput, false);
  assert.equal(summary.frames.p95, 1000 / 60);
  assert.equal(summary.missedFrameOpportunities, 8);
  assert.equal(summary.gapsOverTwoFrames, 1);
  assert.equal(summary.longestTaskMs, 150);
  assert.equal(
    summarizeTranscriptProbe(
      { ...raw, keys: [{ expected: "a", value: "b", latencyMs: 10 }] },
      [16, 16],
      1,
      "a",
    ).valid,
    false,
  );
  assert.equal(
    summarizeTranscriptProbe({ ...raw, markers: [] }, [16, 16], 1, "a")
      .complete,
    false,
  );
  assert.equal(
    summarizeTranscriptProbe(
      { ...raw, snapshot: { unexpected: ["GET /new"] } },
      [16, 16],
      1,
      "a",
    ).valid,
    false,
  );
  assert.throws(
    () =>
      summarizeTranscriptProbe(
        { ...raw, keys: [{ latencyMs: null }] },
        [16, 16],
        1,
        "a",
      ),
    /invalid/,
  );
  assert.throws(() => distribution([]), /Missing/);
  assert.throws(() => distribution([Number.NaN]), /invalid/);
});
