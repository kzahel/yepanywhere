import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConversationFile,
  MAX_CONVERSATION_RECORD_BYTES,
} from "../src/experimental/conversation-reader.js";
import {
  MAX_PROJECTION_INPUT_BYTES,
  prepareConversation,
  selectConversation,
  serializeConversationSnapshot,
} from "../src/experimental/conversation-projection.js";
import { loadCapture, replayNative } from "./utils/captured-provider-replay.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function file(text: string) {
  const dir = await mkdtemp(join(tmpdir(), "ya-conversation-reader-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  await writeFile(path, text);
  return path;
}
const options = {
  provider: "claude" as const,
  sessionId: "session",
  signal: new AbortController().signal,
};

describe("bounded native Conversation acquisition", () => {
  it.each(["claude", "codex"] as const)(
    "%s matches the existing captured native pipeline",
    async (provider) => {
      const capture = await loadCapture(`${provider}-basic-2026-09-12`);
      const path = await file(
        `${capture.native.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
      const read = await readConversationFile({
        ...options,
        path,
        provider,
        sessionId: capture.manifest.sessionId,
      });
      const existing = await replayNative(capture);
      const snapshot = (messages: typeof read.messages) =>
        serializeConversationSnapshot(
          selectConversation(
            prepareConversation({ ...read, messages }),
            {
              sessionId: read.sessionId,
              maxMessages: 20,
              anchorMessageId: null,
            },
            { subscriptionId: "test", sequence: 0 },
          ),
        );
      expect(snapshot(read.messages)).toEqual(snapshot(existing.messages));
    },
  );
  it("refuses oversized acquisition before parsing", async () => {
    const path = await file("");
    await truncate(path, MAX_PROJECTION_INPUT_BYTES + 1);
    await expect(readConversationFile({ ...options, path })).rejects.toThrow(
      "byte budget",
    );
  });
  it("rejects an oversized unfinished row and complete malformed rows", async () => {
    await expect(
      readConversationFile({
        ...options,
        path: await file("x".repeat(MAX_CONVERSATION_RECORD_BYTES + 1)),
      }),
    ).rejects.toThrow("record budget");
    await expect(
      readConversationFile({ ...options, path: await file("not-json\n") }),
    ).rejects.toThrow();
  });
  it("reports an unfinished final row without inventing a message", async () => {
    const read = await readConversationFile({
      ...options,
      path: await file(
        '{"type":"user","uuid":"u","message":{"role":"user","content":"Hello"}}\n{"type":',
      ),
    });
    expect(read.sourceCoverage.complete).toBe(false);
    expect(read.messages).toHaveLength(1);
  });
  it("rejects inherited Codex history and mismatched source identity", async () => {
    const capture = await loadCapture("codex-basic-2026-09-12");
    const meta = structuredClone(capture.native[0]) as {
      payload: Record<string, unknown>;
    };
    meta.payload.history_base = {
      thread_id: "parent",
      end_byte_offset: 12,
      end_ordinal_exclusive: 2,
    };
    const path = await file(`${JSON.stringify(meta)}\n`);
    await expect(
      readConversationFile({
        ...options,
        path,
        provider: "codex",
        sessionId: capture.manifest.sessionId,
      }),
    ).rejects.toThrow("lineage");
    delete meta.payload.history_base;
    await writeFile(path, `${JSON.stringify(meta)}\n`);
    await expect(
      readConversationFile({ ...options, path, provider: "codex" }),
    ).rejects.toThrow("lineage");
  });
  it("honors cancellation before opening a source", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readConversationFile({
        ...options,
        path: "missing",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
