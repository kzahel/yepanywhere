import { describe, expect, it } from "vitest";
import type { SDKMessage } from "../src/sdk/types.js";
import { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent } from "../src/supervisor/types.js";

function createMockIterator(messages: SDKMessage[]): AsyncIterator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index >= messages.length) {
        return { done: true as const, value: undefined };
      }
      return { done: false as const, value: messages[index++] };
    },
  };
}

describe("Process", () => {
  describe("event subscription", () => {
    it("emits message events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: "Hi" } },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const received: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          received.push(event.message);
        }
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(3);
      expect(received[0]?.type).toBe("system");
      expect(received[1]?.type).toBe("assistant");
      expect(received[2]?.type).toBe("result");
    });

    it("transitions to idle after result", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("idle");
    });

    it("emits state-change events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const stateChanges: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have at least one state change to idle
      expect(stateChanges.length).toBeGreaterThan(0);
      const lastChange = stateChanges[stateChanges.length - 1];
      expect(lastChange?.type).toBe("state-change");
      if (lastChange?.type === "state-change") {
        expect(lastChange.state.type).toBe("idle");
      }
    });
  });

  describe("message queue", () => {
    it("queues messages and returns position", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const pos1 = process.queueMessage({ text: "first" });
      const pos2 = process.queueMessage({ text: "second" });

      expect(pos1).toBe(1);
      expect(pos2).toBe(2);
    });

    it("reports queue depth", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.queueMessage({ text: "first" });
      process.queueMessage({ text: "second" });

      expect(process.queueDepth).toBe(2);
    });
  });

  describe("getInfo", () => {
    it("returns process info", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test/path",
        projectId: "proj-123",
        sessionId: "sess-456",
        idleTimeoutMs: 100,
      });

      const info = process.getInfo();

      expect(info.id).toBe(process.id);
      expect(info.sessionId).toBe("sess-456");
      expect(info.projectId).toBe("proj-123");
      expect(info.projectPath).toBe("/test/path");
      expect(info.startedAt).toBeDefined();
    });
  });

  describe("abort", () => {
    it("emits complete event on abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      let completed = false;
      process.subscribe((event) => {
        if (event.type === "complete") {
          completed = true;
        }
      });

      await process.abort();

      expect(completed).toBe(true);
    });

    it("clears listeners after abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      let callCount = 0;
      process.subscribe(() => {
        callCount++;
      });

      await process.abort();

      // Listener should have been called once for complete event
      expect(callCount).toBe(1);
    });
  });

  describe("input request handling", () => {
    it("transitions to waiting-input on input_request message", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "system",
          subtype: "input_request",
          input_request: {
            id: "req-123",
            type: "tool-approval",
            prompt: "Allow file write?",
          },
        },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("waiting-input");
      if (process.state.type === "waiting-input") {
        expect(process.state.request.id).toBe("req-123");
        expect(process.state.request.type).toBe("tool-approval");
        expect(process.state.request.prompt).toBe("Allow file write?");
      }
    });
  });

  describe("permission mode", () => {
    it("defaults to 'default' mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.permissionMode).toBe("default");
    });

    it("accepts initial permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      expect(process.permissionMode).toBe("acceptEdits");
    });

    it("allows changing permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setPermissionMode("bypassPermissions");
      expect(process.permissionMode).toBe("bypassPermissions");

      process.setPermissionMode("plan");
      expect(process.permissionMode).toBe("plan");
    });

    it("handleToolApproval auto-approves in bypassPermissions mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "bypassPermissions",
      });

      const abortController = new AbortController();
      const result = await process.handleToolApproval(
        "Bash",
        { command: "rm -rf /" },
        { signal: abortController.signal },
      );

      expect(result.behavior).toBe("allow");
    });

    it("handleToolApproval denies all in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();
      const result = await process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("Plan mode");
    });

    it("handleToolApproval auto-approves Edit tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      const abortController = new AbortController();

      // Edit should be auto-approved
      const editResult = await process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );
      expect(editResult.behavior).toBe("allow");

      // Write should be auto-approved
      const writeResult = await process.handleToolApproval(
        "Write",
        { file: "test.ts" },
        { signal: abortController.signal },
      );
      expect(writeResult.behavior).toBe("allow");
    });
  });
});
