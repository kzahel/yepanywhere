import type { Stats } from "node:fs";
import type { ClaudeSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  condenseClaudeSummary,
  projectedClaudeSummary,
} from "../../src/sessions/claude-index-summary.js";
import {
  addEntryToState,
  buildSummaryFromState,
  createParseState,
} from "../../src/sessions/claude-summary.js";

const FILE_TIME = new Date("2026-09-01T00:00:00.000Z");
const options = {
  filePath: "/tmp/session.jsonl",
  stats: {
    birthtime: FILE_TIME,
    birthtimeMs: FILE_TIME.getTime(),
    mtime: FILE_TIME,
    size: 1,
  } as Stats,
  sessionId: "session",
  projectId: "project" as UrlProjectId,
};

const FABLE = "claude-fable-5";
const OPUS = "claude-opus-4-8";

/** Chains the rows into one branch, a minute apart. */
function parse(rows: readonly Record<string, unknown>[]) {
  const state = createParseState();
  rows.forEach((row, index) => {
    addEntryToState(
      state,
      {
        ...row,
        uuid: `row-${index}`,
        parentUuid: index ? `row-${index - 1}` : null,
        timestamp: new Date(FILE_TIME.getTime() + index * 60_000).toISOString(),
      } as unknown as ClaudeSessionEntry,
      index,
    );
  });
  return state;
}

/** The summary as a full parse reports it and as the durable index does. */
function restrictions(rows: readonly Record<string, unknown>[]) {
  const state = parse(rows);
  const branch = [...state.nodeMap.values()];
  return [
    buildSummaryFromState(state, options)?.capabilityRestriction,
    buildSummaryFromState(
      projectedClaudeSummary(state, condenseClaudeSummary(branch), 0),
      options,
    )?.capabilityRestriction,
  ];
}

const user = { type: "user", message: { content: "look at the relay" } };
const answer = (model: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text: "on it" }], model },
});
const fallback = (extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "model_refusal_fallback",
  content: "Retrying with the fallback model.",
  trigger: "refusal",
  direction: "retry",
  originalModel: FABLE,
  fallbackModel: OPUS,
  requestId: null,
  ...extra,
});

describe("claude summary capability restriction", () => {
  it("reports nothing for a transcript without a refusal fallback", () => {
    expect(restrictions([user, answer(FABLE)])).toEqual([undefined, undefined]);
  });

  it("is active while the fallback model keeps answering", () => {
    const rows = [
      user,
      answer(FABLE),
      fallback({ apiRefusalCategory: "cyber" }),
      answer(`${OPUS}-20260801`),
      user,
      answer(`${OPUS}-20260801`),
    ];
    for (const restriction of restrictions(rows)) {
      expect(restriction).toEqual({
        events: [
          {
            messageId: "row-2",
            at: "2026-09-01T00:02:00.000Z",
            fromModel: FABLE,
            toModel: OPUS,
            category: "cyber",
            scope: "session",
          },
        ],
        activeModel: OPUS,
        omitted: false,
      });
    }
  });

  it("stops being active once another model answers", () => {
    const rows = [user, fallback(), answer(OPUS), user, answer(FABLE)];
    for (const restriction of restrictions(rows)) {
      expect(restriction?.events).toHaveLength(1);
      expect(restriction?.activeModel).toBeUndefined();
    }
  });

  it("leaves the session model alone for a single-reply fallback", () => {
    const rows = [user, fallback({ scope: "local" }), answer(FABLE)];
    for (const restriction of restrictions(rows)) {
      expect(restriction?.events[0]?.scope).toBe("response");
      expect(restriction?.activeModel).toBeUndefined();
    }
  });

  it("keeps the newest events and says earlier ones exist", () => {
    const rows = [user, ...Array.from({ length: 10 }, () => fallback())];
    for (const restriction of restrictions(rows)) {
      expect(restriction?.events.map((event) => event.messageId)).toEqual(
        ["3", "4", "5", "6", "7", "8", "9", "10"].map((n) => `row-${n}`),
      );
      expect(restriction?.omitted).toBe(true);
      expect(restriction?.activeModel).toBe(OPUS);
    }
  });
});
