import { describe, expect, it, vi } from "vitest";
import {
  MessageQueue,
  Process,
  createControllableIterator,
  createMockIterator,
} from "./process.test-support.js";
import type { SDKMessage, UrlProjectId } from "./process.test-support.js";
import { STREAMING_SNAPSHOT_INTERVAL_MS } from "../src/sdk/providers/streaming-snapshot-coalescing.js";

describe("Process", () => {
  describe("messageHistory", () => {
    it("adds queued user messages to replay history", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history for replay to late-joining clients.
      // Client-side deduplication (mergeStreamMessage, mergeJSONLMessages) handles
      // any duplicates when JSONL is eventually fetched.
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should always emit user messages via stream regardless of SDK type", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue, // Real SDK
      });

      const emittedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          emittedMessages.push(event.message);
        }
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // Message should still be emitted for live stream subscribers
      const userEmits = emittedMessages.filter((m) => m.type === "user");
      expect(userEmits).toHaveLength(1);
    });

    it("does not re-emit a provider user echo that already has the queue uuid", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "grok",
        idleTimeoutMs: 100,
        queue,
      });

      const emittedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          emittedMessages.push(event.message);
        }
      });

      const queuedResult = process.queueMessage({
        text: "hello grok",
        tempId: "temp-send",
      });
      expect(queuedResult.success).toBe(true);
      const optimistic = emittedMessages.find((m) => m.type === "user");
      expect(optimistic?.uuid).toBeTypeOf("string");
      expect(optimistic?.tempId).toBe("temp-send");

      controller.push({
        type: "user",
        uuid: optimistic?.uuid,
        message: { role: "user", content: "hello grok" },
      });
      controller.push({ type: "result", session_id: "sess-1" });

      await vi.waitFor(() => {
        expect(
          emittedMessages.filter((m) => m.type === "result"),
        ).not.toHaveLength(0);
      });

      expect(emittedMessages.filter((m) => m.type === "user")).toHaveLength(1);
      controller.finish();
      await process.abort();
    });

    it("publishes repeated tool-result states and replays only their newest cursor across bucket rotation", async () => {
      vi.useFakeTimers();
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 60_000,
        queue: new MessageQueue(),
      });
      const emitted: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") emitted.push(event.message);
      });
      const tool = (
        uuid: string,
        content: string,
        streaming = true,
      ): SDKMessage => ({
        type: "user",
        timestamp: new Date().toISOString(),
        uuid,
        _isStreaming: streaming,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: uuid.replace("-result", ""),
              content,
            },
          ],
        },
      });
      try {
        controller.push(tool("first-result", "started"));
        await vi.waitFor(() => expect(emitted).toHaveLength(1));
        const before = process.getReplayCursor();
        controller.push(tool("second-result", "other command"));
        controller.push(tool("first-result", "updated"));
        await vi.waitFor(() => expect(emitted).toHaveLength(3));
        expect(
          process.getMessageHistory().filter((m) => m.uuid === "first-result"),
        ).toHaveLength(1);
        expect(process.getReplayCursor()).toBeGreaterThan(before);

        // The next update must replace a state retained in the previous bucket.
        await vi.advanceTimersByTimeAsync(15_000);
        const cursorAtRotation = process.getReplayCursor();
        expect(
          process.getMessageHistory().filter((m) => m.uuid === "second-result"),
        ).toHaveLength(1);
        // Let each update cross the existing queued-snapshot coalescer before
        // publishing the next one; a burst may deliberately coalesce upstream.
        for (let index = 1; index <= 256; index++) {
          const snapshot = tool("first-result", "x".repeat(index * 256));
          controller.push(snapshot);
          await vi.advanceTimersByTimeAsync(STREAMING_SNAPSHOT_INTERVAL_MS);
          expect(emitted.at(-1)).toBe(snapshot);
        }
        const final = tool("first-result", "complete", false);
        final.toolUseResult = {
          stdout: "complete",
          stderr: "",
          interrupted: false,
          exitCode: 0,
        };
        controller.push(final);
        controller.push({ type: "result", session_id: "sess-1" });
        await vi.waitFor(() => expect(emitted.at(-1)?.type).toBe("result"));
        expect(emitted.filter((m) => m.uuid === "first-result")).toHaveLength(
          259,
        );
        expect(emitted.filter((m) => m.uuid === "first-result").at(-1)).toBe(
          final,
        );
        const history = process.getMessageHistory();
        expect(history.filter((m) => m.uuid === "first-result")).toEqual([
          final,
        ]);
        // The independent state expires normally while the updated tool survives.
        expect(history.filter((m) => m.uuid === "second-result")).toHaveLength(
          0,
        );
        expect(process.getReplaySeq(final)).toBeGreaterThan(cursorAtRotation);
      } finally {
        controller.finish();
        await process.abort();
        vi.useRealTimers();
      }
    });

    it("should include attachment info in user message content", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      // Queue a user message with attachments
      process.queueMessage({
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
        ],
      });

      // User message should include attachment info in content
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      const content = userMessages[0]?.message?.content as string;
      expect(content).toContain("Here is a screenshot");
      expect(content).toContain("User uploaded files:");
      expect(content).toContain("screenshot.png");
      expect(content).toContain("1\u202fkb");
      expect(content).toContain("image/png");
      expect(content).toContain("/uploads/screenshot.png");
    });

    it("should produce identical content format as MessageQueue for deduplication", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      const testMessage = {
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
          {
            id: "file-2",
            originalName: "document.pdf",
            name: "document.pdf",
            size: 2048576, // ~2 MB
            mimeType: "application/pdf",
            path: "/uploads/document.pdf",
          },
        ],
      };

      // Queue the message through Process
      process.queueMessage(testMessage);

      // Get what Process put in history
      const historyContent = process.getMessageHistory()[0]?.message
        ?.content as string;

      // Get what MessageQueue would send to SDK via its generator
      const gen = queue.generator();
      const sdkMessage = await gen.next();
      const sdkContent = sdkMessage.value?.message?.content as string;

      // Both should produce identical content for deduplication to work
      expect(historyContent).toBe(sdkContent);
    });
  });
});
