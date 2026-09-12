import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  captureRoot,
  discoverCaptures,
  loadCapture,
  replayLive,
  replayNative,
  type Capture,
} from "./utils/captured-provider-replay.js";
import { preparedNativeRecord } from "./utils/native-tool-display-corpus.js";

const names = await discoverCaptures();
const captures = await Promise.all(names.map((name) => loadCapture(name)));

function assertFacts(
  capture: Capture,
  items: RenderItem[],
  path: "native" | "live",
) {
  const { expected } = capture.manifest;
  const tools = items.filter((item) => item.type === "tool_call");
  expect(tools.map((item) => item.toolName)).toEqual(
    expected.tools.map((tool) => tool.name),
  );
  expect(new Set(tools.map((item) => item.id)).size).toBe(tools.length);
  expect(tools.every((item) => !item.isSubagent)).toBe(true);
  tools.forEach((item, index) => {
    const fact = expected.tools[index];
    if (!fact) throw new Error("Undeclared tool call");
    expect(item.status).toBe(fact.status);
    expect(item.toolResult?.content).toContain(fact.resultIncludes[path]);
    expect(preparedNativeRecord(item).kind).toBe(fact.display[path]);
  });
  const text = items
    .filter((item) => item.type === "text")
    .map((item) => item.text);
  expect(text).toEqual(["Starting fixture work.", ...expected.finalTexts]);
  const firstFinal = items.findIndex(
    (item) => item.type === "text" && item.text === expected.finalTexts[0],
  );
  expect(
    items.slice(0, firstFinal).filter((item) => item.type === "tool_call"),
  ).toHaveLength(4);
  expect(
    items.slice(firstFinal).filter((item) => item.type === "tool_call"),
  ).toHaveLength(1);
  if (path === "native") {
    expect(items.filter((item) => item.type === "user_prompt")).toHaveLength(
      expected.userMessages,
    );
  }
}

describe("captured provider transcripts (no provider processes or credentials)", () => {
  it("discovers both required baseline captures", () => {
    expect(names).toContain("claude-basic-2026-09-12");
    expect(names).toContain("codex-basic-2026-09-12");
  });

  for (const capture of captures) {
    const { provider } = capture.manifest;
    it(`${provider}: preserves independent conversation facts through both production paths`, async () => {
      assertFacts(capture, (await replayNative(capture)).renderItems, "native");
      assertFacts(capture, (await replayLive(capture)).renderItems, "live");
    });
  }

  it.each([
    "missing",
    "wrong turn",
    "wrong command",
    "concurrent call",
    "multiple executions",
  ])(
    "does not infer native failure from printed JSON when execution evidence is %s",
    async (variant) => {
      const capture = await loadCapture("codex-basic-2026-09-12");
      const eventIndex = capture.native.findIndex((row) =>
        JSON.stringify(row).includes(
          '"id":"exec-c85f77b8-c34c-4963-8f06-50e4f699a01e"',
        ),
      );
      const event = capture.native[eventIndex];
      if (!event) throw new Error("Missing captured execution");
      const payload = event.payload as Record<string, unknown>;
      const item = payload.item as Record<string, unknown>;
      if (variant === "missing") capture.native.splice(eventIndex, 1);
      if (variant === "wrong turn") payload.turn_id = "unrelated-turn";
      if (variant === "wrong command")
        item.parsed_cmd = [{ type: "unknown", cmd: "unrelated command" }];
      if (variant === "concurrent call") {
        const call = capture.native.find(
          (row) =>
            row.type === "response_item" &&
            JSON.stringify(row).includes(
              '"call_id":"call_MYWVe6FE2rRhyysPyS53QPZh"',
            ),
        );
        if (!call) throw new Error("Missing captured call");
        capture.native.splice(
          eventIndex,
          0,
          JSON.parse(
            JSON.stringify(call).replaceAll(
              "call_MYWVe6FE2rRhyysPyS53QPZh",
              "concurrent-control",
            ),
          ),
        );
      }
      if (variant === "multiple executions") {
        capture.native.splice(
          eventIndex + 1,
          0,
          JSON.parse(
            JSON.stringify(event).replaceAll(
              "exec-c85f77b8-c34c-4963-8f06-50e4f699a01e",
              "second-execution-control",
            ),
          ),
        );
      }
      const result = await replayNative(capture);
      const call = result.renderItems.find(
        (row) =>
          row.type === "tool_call" &&
          row.id === "call_MYWVe6FE2rRhyysPyS53QPZh",
      );
      expect(call).toMatchObject({ status: "complete" });
    },
  );

  it("prefers native success metadata over a printed exit_code field", async () => {
    const capture = await loadCapture("codex-basic-2026-09-12");
    for (const row of capture.native) {
      const payload = row.payload as Record<string, unknown> | undefined;
      const item = payload?.item as Record<string, unknown> | undefined;
      if (item?.id !== "exec-c85f77b8-c34c-4963-8f06-50e4f699a01e") continue;
      item.exit_code = 0;
      item.status = "completed";
    }
    const result = await replayNative(capture);
    const call = result.renderItems.find(
      (row) =>
        row.type === "tool_call" && row.id === "call_MYWVe6FE2rRhyysPyS53QPZh",
    );
    expect(call).toMatchObject({
      status: "complete",
      toolResult: { structured: { exitCode: 0 } },
    });
  });

  it("keeps an observed live tool prefix unfinished until its recorded result arrives", async () => {
    const capture = await loadCapture("claude-basic-2026-09-12");
    const resultIndex = capture.live.findIndex((row) => row.type === "user");
    expect(resultIndex).toBeGreaterThan(0);
    const prefix = await replayLive(capture, resultIndex);
    const calls = prefix.renderItems.filter(
      (item) => item.type === "tool_call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("pending");
    expect(calls[0]?.toolResult).toBeUndefined();
  });

  it("rejects a missing declared recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "ya-capture-negative-"));
    try {
      const name = "claude-basic-2026-09-12";
      await cp(join(captureRoot, name), join(root, name), { recursive: true });
      await rm(join(root, name, "live.jsonl"));
      await expect(loadCapture(name, root)).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a broken captured tool/result reference, beyond mere JSON decoding", async () => {
    const capture = await loadCapture("claude-basic-2026-09-12");
    // Mutate only a tool result reference, preserving the valid native shape.
    capture.native = capture.native.map((row) =>
      JSON.parse(
        JSON.stringify(row).replace(
          '"tool_use_id":"toolu_01ARtSALtkdtCXMaMcamcYuU"',
          '"tool_use_id":"missing-call-negative-control"',
        ),
      ),
    );
    // The deliberately orphaned result must emit this diagnostic. Assert it
    // rather than leaking an expected warning into every normal test run.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await replayNative(capture);
      expect(warning.mock.calls).toEqual([
        ["Tool result for unknown tool_use: missing-call-negative-control"],
      ]);
      expect(() =>
        assertFacts(capture, result.renderItems, "native"),
      ).toThrow();
    } finally {
      warning.mockRestore();
    }
  });

  it("detects loss of supported rich presentation", async () => {
    const capture = await loadCapture("claude-basic-2026-09-12");
    const result = await replayNative(capture);
    const read = result.renderItems.find((item) => item.type === "tool_call");
    if (read?.type !== "tool_call") throw new Error("Missing Read control");
    read.toolInput = { unsupported: true };
    expect(preparedNativeRecord(read).kind).toBe("raw");
    expect(() => assertFacts(capture, result.renderItems, "native")).toThrow();
  });
});
