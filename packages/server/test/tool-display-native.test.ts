import { describe, expect, it } from "vitest";
import {
  nativeDisplayCases,
  preparedNativeRecord,
  runNativeDisplayCase,
} from "./utils/native-tool-display-corpus.ts";
import { normalizeRenderItemsForComparison } from "./utils/render-parity-harness.ts";
import {
  runNativeDisplayLifecycle,
  runNativeDisplayOwnership,
} from "./utils/native-tool-display-lifecycle.js";

it.each([1, 2, 3, 4])(
  "preserves ordered lifecycle facts at native prefix %s",
  async (prefix) => {
    const pair = await runNativeDisplayLifecycle(prefix);
    const expected =
      prefix < 3
        ? ["display-lifecycle/rejected"]
        : ["display-lifecycle/rejected", "display-lifecycle/corrected"];
    for (const side of [pair.live, pair.durable]) {
      const unfinished = side === pair.live ? "pending" : "incomplete";
      const calls = side.renderItems.filter(
        (item) => item.type === "tool_call",
      );
      expect(calls.map((call) => call.id)).toEqual(expected);
      expect(calls.map((call) => call.status)).toEqual(
        prefix === 1
          ? [unfinished]
          : prefix === 2
            ? ["error"]
            : prefix === 3
              ? ["error", unfinished]
              : ["error", "complete"],
      );
      expect(calls.map((call) => preparedNativeRecord(call).kind)).toEqual(
        prefix < 3 ? ["raw"] : ["raw", "rich"],
      );
    }
    // A frozen unclosed JSONL call is incomplete; only the live caller supplies
    // active-work knowledge. Terminal prefixes converge without that exception.
    if (prefix % 2 === 0)
      expect(normalizeRenderItemsForComparison(pair.live.renderItems)).toEqual(
        normalizeRenderItemsForComparison(pair.durable.renderItems),
      );
  },
);

it("keeps child call ordering separate and recovers the parent launch link from the sidecar", async () => {
  const pair = await runNativeDisplayOwnership();
  expect(pair.mappings).toContainEqual(
    expect.objectContaining({
      toolUseId: pair.parentId,
      agentId: "review-child",
    }),
  );
  expect(
    pair.liveMessages.every(
      (message) => message.parent_tool_use_id === pair.parentId,
    ),
  ).toBe(true);
  expect(
    pair.parent.renderItems
      .filter((item) => item.type === "tool_call")
      .map((item) => item.id),
  ).toEqual([pair.parentId]);
  for (const side of [pair.live, pair.durable]) {
    const calls = side.renderItems.filter((item) => item.type === "tool_call");
    expect(calls.map((call) => [call.id, call.status])).toEqual([
      ["display-lifecycle/rejected", "error"],
      ["display-lifecycle/corrected", "complete"],
    ]);
    expect(
      calls.map(preparedNativeRecord).map((record) => record.kind),
    ).toEqual(["raw", "rich"]);
  }
  expect(normalizeRenderItemsForComparison(pair.live.renderItems)).toEqual(
    normalizeRenderItemsForComparison(pair.durable.renderItems),
  );
});
for (const fixture of nativeDisplayCases)
  describe(fixture.id, () => {
    it(
      fixture.provider === "gemini"
        ? "preserves historical tool normalization, compilation and display preparation"
        : "converges through native adapters, durable normalization, compilation and display preparation",
      async () => {
        const { live, durable } = await runNativeDisplayCase(fixture);
        const expectedKind =
          fixture.expectedKind ??
          (fixture.isError
            ? "raw"
            : (fixture.id.endsWith("plain-text") &&
                  fixture.tool !== "Write" &&
                  fixture.tool !== "Bash") ||
                fixture.id === "codex/Edit/patch" ||
                fixture.id === "pi/Grep/native"
              ? "partial"
              : "rich");
        if (!live) {
          expect(fixture.provider).toBe("gemini");
          const calls = durable.renderItems.filter(
            (item) => item.type === "tool_call",
          );
          expect(calls).toHaveLength(1);
          const call = calls[0];
          if (!call) throw new Error("Missing historical tool call");
          expect(call.toolName).toBe(fixture.tool);
          expect(call.status).toBe(fixture.isError ? "error" : "complete");
          expect(call.toolResult?.isError).toBe(!!fixture.isError);
          expect(preparedNativeRecord(call).kind).toBe(expectedKind);
          return;
        }
        const liveCalls = live.renderItems.filter(
          (item) => item.type === "tool_call",
        );
        const durableCalls = durable.renderItems.filter(
          (item) => item.type === "tool_call",
        );
        expect(liveCalls).toHaveLength(1);
        expect(durableCalls).toHaveLength(1);
        const liveCall = liveCalls[0];
        const durableCall = durableCalls[0];
        if (!liveCall || !durableCall)
          throw new Error("Missing paired tool call");
        expect(liveCall.toolName).toBe(fixture.tool);
        expect(durableCall.toolName).toBe(fixture.tool);
        expect(liveCall.id).toBe(durableCall.id);
        expect(liveCall.status).toBe(fixture.isError ? "error" : "complete");
        expect(liveCall.toolResult?.isError).toBe(!!fixture.isError);
        expect(liveCall.isSubagent).toBe(durableCall.isSubagent);
        expect(preparedNativeRecord(liveCall)).toEqual(
          preparedNativeRecord(durableCall),
        );
        expect(preparedNativeRecord(liveCall).kind).toBe(expectedKind);
        // Deliberate non-display metadata exceptions; never erase result facts
        // or a display classification to obtain parity.
        const comparableLive = liveCalls.map((call) => ({
          ...call,
          toolResult: call.toolResult ? { ...call.toolResult } : undefined,
        }));
        const comparableDurable = durableCalls.map((call) => ({
          ...call,
          toolInput: { ...Object(call.toolInput) },
        }));
        if (fixture.provider === "grok") {
          expect(comparableDurable[0]?.toolInput.status).toBe("completed");
          delete comparableDurable[0]?.toolInput.status;
        }
        if (fixture.id === "codex/Write/command-item") {
          expect(liveCall.toolResult?.content).toBe("(no output)");
          expect(durableCall.toolResult?.content).toBe("");
          const result = comparableLive[0]?.toolResult;
          if (result) result.content = "";
        }
        expect(normalizeRenderItemsForComparison(comparableLive)).toEqual(
          normalizeRenderItemsForComparison(comparableDurable),
        );
      },
    );
  });

import { displayFixtures } from "../../client/src/components/renderers/tools/__fixtures__/displayFixtures.js";
it("accounts for every display variant with a native pair or a synthetic-only reason", () => {
  const synthetic: Record<string, string> = {
    "Edit/augmented":
      "YA structured-patch-only augmentation; native replacement and raw patch pairs exercise its producer.",
    "Edit/changes":
      "Compatibility metadata-only file-change shape; complete Codex patch pairs own native diffs.",
    "Edit/target":
      "Incomplete target-only call; no complete provider replacement is claimed.",
    "TaskCreate/snapshot":
      "YA projection over task events, checked by native event pairs and registry snapshot fixtures.",
    "TaskUpdate/snapshot":
      "YA projection over task events, checked by native event pairs and registry snapshot fixtures.",
  };
  for (const [tool, variants] of Object.entries(displayFixtures))
    for (const variant of Object.keys(variants)) {
      expect(
        nativeDisplayCases.some(
          (f) => f.tool === tool && f.id.endsWith(`/${variant}`),
        ) || (synthetic[`${tool}/${variant}`]?.length ?? 0) > 20,
        `${tool}/${variant}`,
      ).toBe(true);
    }
});
