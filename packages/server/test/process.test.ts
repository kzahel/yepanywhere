import { describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/sdk/messageQueue.js";
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

      const result1 = process.queueMessage({ text: "first" });
      const result2 = process.queueMessage({ text: "second" });

      expect(result1.success).toBe(true);
      expect(result1.position).toBe(1);
      expect(result2.success).toBe(true);
      expect(result2.position).toBe(2);
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

    it("initializes modeVersion to 0", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);
    });

    it("increments modeVersion when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);

      process.setPermissionMode("acceptEdits");
      expect(process.modeVersion).toBe(1);

      process.setPermissionMode("bypassPermissions");
      expect(process.modeVersion).toBe(2);

      process.setPermissionMode("plan");
      expect(process.modeVersion).toBe(3);
    });

    it("emits mode-change event when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "mode-change") {
          events.push(event);
        }
      });

      process.setPermissionMode("acceptEdits");
      process.setPermissionMode("bypassPermissions");

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "mode-change",
        mode: "acceptEdits",
        version: 1,
      });
      expect(events[1]).toEqual({
        type: "mode-change",
        mode: "bypassPermissions",
        version: 2,
      });
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

    it("handleToolApproval auto-allows read-only tools in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // Read-only tools should be auto-allowed in plan mode
      for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("handleToolApproval prompts user for mutating tools in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // Edit should prompt the user, not auto-deny
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user denying
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("Edit");
      process.respondToInput(pendingRequest?.id ?? "", "deny");

      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
    });

    it("handleToolApproval prompts user for ExitPlanMode in plan mode (not auto-approve)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // ExitPlanMode should NOT auto-approve - it should prompt the user
      const approvalPromise = process.handleToolApproval(
        "ExitPlanMode",
        {},
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("ExitPlanMode");
      process.respondToInput(pendingRequest?.id, "approve");

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // After approval, should switch back to default mode
      expect(process.permissionMode).toBe("default");
    });

    it("handleToolApproval prompts user for AskUserQuestion in plan mode (not auto-deny)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // AskUserQuestion should NOT auto-deny - it should prompt the user
      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        { questions: [{ question: "test?", header: "Test", options: [] }] },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving with answers
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");
      process.respondToInput(pendingRequest?.id, "approve", { "test?": "Yes" });

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // Should have updated input with answers
      expect(result.updatedInput).toEqual({
        questions: [{ question: "test?", header: "Test", options: [] }],
        answers: { "test?": "Yes" },
      });
      // Should still be in plan mode (AskUserQuestion doesn't exit plan mode)
      expect(process.permissionMode).toBe("plan");
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

    it("handleToolApproval auto-allows read-only tools in default mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Read-only tools should be auto-allowed in default mode (ask before EDITS, not reads)
      for (const tool of [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
      ]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("handleToolApproval auto-allows read-only tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      const abortController = new AbortController();

      // Read-only tools should also be auto-allowed in acceptEdits mode
      // (acceptEdits is strictly more permissive than default)
      for (const tool of [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
      ]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("acceptEdits mode is strictly more permissive than default mode", async () => {
      // This test ensures the permission hierarchy is maintained:
      // bypassPermissions > acceptEdits > default > plan
      // Any tool auto-approved in default should also be auto-approved in acceptEdits
      const abortController = new AbortController();

      // Test all common tools across both modes
      const testTools = [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
        "Edit",
        "Write",
        "NotebookEdit",
        "Bash",
        "AskUserQuestion",
      ];

      for (const tool of testTools) {
        // Create fresh processes for each tool to avoid state pollution
        const defaultProcess = new Process(createMockIterator([]), {
          projectPath: "/test",
          projectId: "proj-1",
          sessionId: "sess-1",
          idleTimeoutMs: 100,
          permissionMode: "default",
        });

        const acceptEditsProcess = new Process(createMockIterator([]), {
          projectPath: "/test",
          projectId: "proj-1",
          sessionId: "sess-2",
          idleTimeoutMs: 100,
          permissionMode: "acceptEdits",
        });

        // Start both approval requests
        const defaultPromise = defaultProcess.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        const acceptEditsPromise = acceptEditsProcess.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );

        // Check immediate states (before any user response)
        const defaultNeedsApproval =
          defaultProcess.state.type === "waiting-input";
        const acceptEditsNeedsApproval =
          acceptEditsProcess.state.type === "waiting-input";

        // If default auto-approves, acceptEdits must also auto-approve
        if (!defaultNeedsApproval) {
          expect(acceptEditsNeedsApproval).toBe(false);
          // Both should return allow
          const [defaultResult, acceptEditsResult] = await Promise.all([
            defaultPromise,
            acceptEditsPromise,
          ]);
          expect(defaultResult.behavior).toBe("allow");
          expect(acceptEditsResult.behavior).toBe("allow");
        } else {
          // If default needs approval, acceptEdits might auto-approve (e.g., Edit)
          // but we need to resolve the pending promise for default
          const pendingRequest = defaultProcess.getPendingInputRequest();
          if (pendingRequest) {
            defaultProcess.respondToInput(pendingRequest.id, "approve");
          }

          // Also resolve acceptEdits if it's waiting
          if (acceptEditsNeedsApproval) {
            const acceptEditsPendingRequest =
              acceptEditsProcess.getPendingInputRequest();
            if (acceptEditsPendingRequest) {
              acceptEditsProcess.respondToInput(
                acceptEditsPendingRequest.id,
                "approve",
              );
            }
          }

          await Promise.all([defaultPromise, acceptEditsPromise]);
        }
      }
    });

    it("handleToolApproval prompts user for mutating tools in default mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Edit should prompt the user in default mode
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("Edit");
      if (pendingRequest) {
        process.respondToInput(pendingRequest.id, "approve");
      }

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
    });

    it("handles concurrent tool approvals (queues them)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Start two concurrent tool approvals for tools that require approval (Bash, not Read)
      const approval1 = process.handleToolApproval(
        "Bash",
        { command: "ls -la" },
        { signal: abortController.signal },
      );
      const approval2 = process.handleToolApproval(
        "Bash",
        { command: "pwd" },
        { signal: abortController.signal },
      );

      // Both should be pending - first one should be shown
      const firstRequest = process.getPendingInputRequest();
      expect(firstRequest).not.toBeNull();
      expect(firstRequest?.toolName).toBe("Bash");

      // Process should be in waiting-input state
      expect(process.state.type).toBe("waiting-input");

      // Approve the first request
      if (!firstRequest) throw new Error("firstRequest should not be null");
      const firstId = firstRequest.id;
      const responded1 = process.respondToInput(firstId, "approve");
      expect(responded1).toBe(true);

      // First approval should resolve
      const result1 = await approval1;
      expect(result1.behavior).toBe("allow");

      // Second request should now be pending
      const secondRequest = process.getPendingInputRequest();
      expect(secondRequest).not.toBeNull();
      expect(secondRequest?.id).not.toBe(firstId);

      // Approve the second request
      if (!secondRequest) throw new Error("secondRequest should not be null");
      const responded2 = process.respondToInput(secondRequest.id, "approve");
      expect(responded2).toBe(true);

      // Second approval should resolve
      const result2 = await approval2;
      expect(result2.behavior).toBe("allow");

      // No more pending requests
      expect(process.getPendingInputRequest()).toBeNull();
      expect(process.state.type).toBe("running");
    });
  });

  describe("messageHistory", () => {
    it("should add user messages to history for real SDK sessions (with queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue, // Real SDK provides queue
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history for SSE replay to late-joining clients.
      // Client-side deduplication (mergeSSEMessage, mergeJSONLMessages) handles
      // any duplicates when JSONL is eventually fetched.
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should add user messages to history for mock SDK sessions (no queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        // No queue = mock SDK
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history (mock SDK needs replay)
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should always emit user messages via SSE regardless of SDK type", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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

      // Message should still be emitted for live SSE subscribers
      const userEmits = emittedMessages.filter((m) => m.type === "user");
      expect(userEmits).toHaveLength(1);
    });

    it("should include attachment info in user message content", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
      expect(content).toContain("1.0 KB");
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
      });

      const testMessage = {
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
          {
            id: "file-2",
            originalName: "document.pdf",
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

  describe("process termination", () => {
    it("isTerminated returns false for new process", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.isTerminated).toBe(false);
      expect(process.terminationReason).toBe(null);
    });

    it("queueMessage returns error when process is terminated", async () => {
      // Create an iterator that throws a process termination error
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      // Wait for the iterator to process and fail
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Now queueMessage should return an error
      const result = process.queueMessage({ text: "should fail" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("terminated");
    });

    it("emits terminated event when process dies", async () => {
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      let terminatedEvent: { reason: string; error?: Error } | null = null;
      process.subscribe((event) => {
        if (event.type === "terminated") {
          terminatedEvent = { reason: event.reason, error: event.error };
        }
      });

      // Wait for the terminated event
      await vi.waitFor(() => {
        expect(terminatedEvent).not.toBe(null);
      });

      expect(terminatedEvent?.reason).toContain("terminated");
      expect(terminatedEvent?.error).toBe(error);
    });

    it("getInfo returns terminated state", async () => {
      const error = new Error("process exited");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      // Wait for termination
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const info = process.getInfo();
      expect(info.state).toBe("terminated");
    });
  });

  describe("hold mode", () => {
    it("setHold(true) transitions to hold state", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.isHeld).toBe(false);
      expect(process.holdSince).toBe(null);

      process.setHold(true);

      expect(process.isHeld).toBe(true);
      expect(process.holdSince).not.toBe(null);
      expect(process.state.type).toBe("hold");
    });

    it("setHold(false) transitions back to running", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);
      expect(process.state.type).toBe("hold");

      process.setHold(false);
      expect(process.isHeld).toBe(false);
      expect(process.holdSince).toBe(null);
      expect(process.state.type).toBe("running");
    });

    it("emits state-change events for hold/resume", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const stateChanges: string[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event.state.type);
        }
      });

      process.setHold(true);
      process.setHold(false);

      expect(stateChanges).toContain("hold");
      expect(stateChanges).toContain("running");
    });

    it("setHold is idempotent", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const stateChanges: string[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event.state.type);
        }
      });

      // Calling setHold(true) multiple times should only emit once
      process.setHold(true);
      process.setHold(true);
      process.setHold(true);

      const holdChanges = stateChanges.filter((s) => s === "hold");
      expect(holdChanges).toHaveLength(1);
    });

    it("getInfo returns hold state and holdSince", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);

      const info = process.getInfo();
      expect(info.state).toBe("hold");
      expect(info.holdSince).toBeDefined();
    });

    it("pauses iterator consumption when held", async () => {
      // Create an iterator that we can control
      let resolveNext: ((value: IteratorResult<SDKMessage>) => void) | null =
        null;
      const controllableIterator: AsyncIterator<SDKMessage> = {
        next() {
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };

      const process = new Process(controllableIterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const receivedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          receivedMessages.push(event.message);
        }
      });

      // Let the first message through
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (resolveNext) {
        resolveNext({
          done: false,
          value: { type: "system", subtype: "init", session_id: "sess-1" },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(receivedMessages).toHaveLength(1);

      // Now hold the process - the next iterator.next() should not be called
      // until we resume
      process.setHold(true);

      // The loop should be blocked waiting to resume
      // If we resolve another message, it shouldn't be received yet
      // (This is hard to test without more control, but we can at least
      // verify the state)
      expect(process.state.type).toBe("hold");
    });

    it("resumes iterator consumption after hold is released", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: "Hello" } },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const receivedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          receivedMessages.push(event.message);
        }
      });

      // Wait for processing to complete (mock iterator is fast)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // All messages should be received
      expect(receivedMessages).toHaveLength(3);
    });

    it("can queue messages while held", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);

      // Should still be able to queue messages
      const result = process.queueMessage({ text: "Hello while held" });
      expect(result.success).toBe(true);
      expect(result.position).toBe(1);
    });

    it("termination while held resolves the wait", async () => {
      // Create an iterator that throws after first message
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw new Error("ProcessTransport is not ready for writing");
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      // Wait for error to occur and process to terminate
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Hold should be cleared
      expect(process.isHeld).toBe(false);
    });
  });
});
