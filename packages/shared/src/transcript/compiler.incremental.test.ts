import { describe, expect, it, vi } from "vitest";
import {
  compileTranscriptProjection,
  createTranscriptProjectionCompiler,
} from "./compiler.js";
import type { Message, ContentBlock } from "./message.js";
import type { RenderItem, ToolCallItem } from "./items.js";
import * as shellOutput from "./shellToolOutput.js";
import type { TranscriptProjectionAugments } from "./types.js";

const call = (id: string, name = "Bash", input: unknown = {}): Message => ({
  uuid: `call-${id}`,
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  },
});
const result = (
  id: string,
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  uuid: `result-${id}`,
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  },
  ...extra,
});
const tool = (items: RenderItem[], id: string): ToolCallItem => {
  const item = items.find(
    (item) => item.type === "tool_call" && item.id === id,
  );
  if (item?.type !== "tool_call") throw Error(`Missing tool ${id}`);
  return item;
};

// Freezing results includes their source objects: a later snapshot must not mutate
// either old projections or immutable nested message data shared by snapshots.
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

describe("immutable transcript fact reuse", () => {
  it("matches fresh full rebuilds through pairing, live results, folding, rewinds, augments and replacement", () => {
    const compile = createTranscriptProjectionCompiler();
    const unmatched = vi.fn();
    const fullUnmatched = vi.fn();
    const launch = call("launch", "exec_command", { cmd: "run" });
    const launchResult = result("launch", "Script running with cell ID 7");
    const poll = call("poll", "wait", { cell_id: "7" });
    const partial = result("poll", "running", { _isStreaming: true });
    const final = result("poll", "SESSION_ID=42\nProcess exited with code 0");
    const text: Message = { uuid: "text", type: "assistant", content: "done" };
    const config: Message = {
      uuid: "config",
      type: "system",
      subtype: "config_ack",
      configModel: "model",
      configMismatch: true,
    };
    let previous: RenderItem[] | undefined;
    const check = (
      messages: Message[],
      augments?: TranscriptProjectionAugments,
    ) => {
      const old = previous && JSON.stringify(previous);
      unmatched.mockClear();
      fullUnmatched.mockClear();
      const next = compile([...messages], augments, {
        onUnmatchedToolResult: unmatched,
      });
      const full = compileTranscriptProjection([...messages], augments, {
        onUnmatchedToolResult: fullUnmatched,
      });
      expect(next).toEqual(full);
      expect(unmatched.mock.calls).toEqual(fullUnmatched.mock.calls);
      if (previous) expect(JSON.stringify(previous)).toBe(old);
      freeze(next);
      previous = next;
      return next;
    };
    check([launchResult]); // The result precedes its call after catch-up.
    check([launchResult, launch]);
    check([launchResult, launch, poll]);
    check([launchResult, launch, poll, partial]);
    check([launchResult, launch, poll, partial, final, text]);
    check([
      launch,
      launchResult,
      poll,
      final,
      text,
      config,
      { ...config, uuid: "same-config" },
    ]);
    const orphan: Message = {
      uuid: "new-turn",
      type: "user",
      content: "next",
      orphanedToolUseIds: ["pending"],
    };
    const pending = call("pending");
    check([pending, orphan], { activeToolApproval: false });
    check([orphan, pending], { activeToolApproval: true });
    check([orphan, pending], { activeToolApproval: false });
    check([text], {
      markdown: { text: { html: "<p>done</p>" } },
    });
    check([
      {
        uuid: "compact",
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
      },
      text,
    ]);
    check([launch, launchResult, poll, final]); // Rewind/window replacement.
    check([config, launch, launchResult, poll, final]); // Older-page prepend.
    check([launch, launchResult, { ...launch, uuid: "replayed-call" }]);
    check([launch, { ...launchResult, toolUseResult: { changed: true } }]);
    const running = result("pending", "Process running with session ID 42");
    check([orphan, pending, running], { activeToolApproval: true });
    check([orphan, pending, running], { activeToolApproval: false });
    const failed = result("failed", "Exit code: 2\nbad");
    (failed.message!.content as ContentBlock[])[0]!.is_error = true;
    check([call("failed", "Bash"), failed]);
    check([call("failed", "Read"), failed]);
    check([call("failed", "Bash"), failed]);
    check([call("launch", "Read"), launchResult]); // Same IDs, changed call type.
  });

  it("reuses old decoded results without rereading output, but invalidates replaced message envelopes and blocks", () => {
    const compile = createTranscriptProjectionCompiler();
    const launch = call("large");
    const content = vi.fn(() => "a long output line\n".repeat(1000));
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: "large",
      get content() {
        return content();
      },
    };
    const output: Message = {
      uuid: "large-result",
      type: "user",
      message: { role: "user", content: [block] },
    };
    const parse = vi.spyOn(shellOutput, "extractDetachedCellId");
    let initial: ToolCallItem;
    try {
      initial = tool(compile([launch, output]), "large");
      expect(parse).toHaveBeenCalled();
      parse.mockClear();
      expect(content).toHaveBeenCalled();
      content.mockClear();
      for (let i = 0; i < 5; i++) {
        const next = compile(
          [
            launch,
            output,
            { uuid: `text-${i}`, type: "assistant", content: `${i}` },
          ],
          { activeToolApproval: !!(i % 2) },
        );
        expect(tool(next, "large").toolResult).toBe(initial.toolResult);
      }
      expect(content).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    const changedEnvelope = { ...output, toolUseResult: { exitCode: 2 } };
    const changed = tool(compile([launch, changedEnvelope]), "large");
    expect(changed.toolResult).not.toBe(initial.toolResult);
    expect(changed.toolResult?.structured).toEqual({ exitCode: 2 });
    expect(content).toHaveBeenCalled();
    content.mockClear();
    const changedBlock = result("large", "new output");
    expect(
      tool(compile([launch, changedBlock]), "large").toolResult?.content,
    ).toBe("new output");
    expect(content).not.toHaveBeenCalled();
    expect(tool(compile([launch, output]), "large").toolResult).toBe(
      initial.toolResult,
    );
  });
});
