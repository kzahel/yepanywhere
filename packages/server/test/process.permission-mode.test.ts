import { describe, expect, it } from "vitest";
import {
  MessageQueue,
  Process,
  createMockIterator,
} from "./process.test-support.js";
import type { ProcessEvent, UrlProjectId } from "./process.test-support.js";

describe("Process", () => {
  describe("permission mode", () => {
    it("defaults to 'default' mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.permissionMode).toBe("default");
    });

    it("accepts initial permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      expect(process.permissionMode).toBe("acceptEdits");
    });

    it("allows changing permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.setPermissionMode("bypassPermissions");
      expect(process.permissionMode).toBe("bypassPermissions");

      process.setPermissionMode("plan");
      expect(process.permissionMode).toBe("plan");
    });

    it("tracks the selected and applied Codex modes separately", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "mode-applied") {
          events.push(event);
        }
      });

      expect(process.appliedPermissionMode).toBeUndefined();
      process.setAppliedPermissionMode("default");

      process.setPermissionMode("bypassPermissions");
      expect(process.permissionMode).toBe("bypassPermissions");
      expect(process.appliedPermissionMode).toBe("default");

      process.setAppliedPermissionMode("bypassPermissions");
      process.setAppliedPermissionMode("bypassPermissions");

      expect(process.appliedPermissionMode).toBe("bypassPermissions");
      expect(events).toEqual([
        { type: "mode-applied", mode: "default" },
        { type: "mode-applied", mode: "bypassPermissions" },
      ]);
    });

    it("initializes modeVersion to 0", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);
    });

    it("increments modeVersion when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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

    it("auto-approves plan completion and remains in Bypass mode", async () => {
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude-gateway",
        idleTimeoutMs: 100,
        permissionMode: "bypassPermissions",
      });

      const approval = process.handleToolApproval(
        "ExitPlanMode",
        {},
        { signal: new AbortController().signal },
      );

      expect(process.getPendingInputRequest()).toBeNull();
      await expect(approval).resolves.toEqual({ behavior: "allow" });
      expect(process.permissionMode).toBe("bypassPermissions");
    });

    it("still surfaces user questions in Bypass mode", async () => {
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude-gateway",
        idleTimeoutMs: 100,
        permissionMode: "bypassPermissions",
      });
      const input = {
        questions: [{ question: "Choose?", header: "Choice", options: [] }],
      };
      const approval = process.handleToolApproval("AskUserQuestion", input, {
        signal: new AbortController().signal,
      });

      expect(process.getPendingInputRequest()?.type).toBe("question");
      const requestId = process.getPendingInputRequest()?.id;
      process.respondToInput(requestId ?? "", "approve", { "Choose?": "One" });
      await expect(approval).resolves.toMatchObject({ behavior: "allow" });
      expect(process.permissionMode).toBe("bypassPermissions");
    });

    it("applies a pending Bypass selection to the active approval bridge", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });
      const abortController = new AbortController();
      process.setAppliedPermissionMode("default");

      const approvalPromise = process.handleToolApproval(
        "Bash",
        { command: "touch frozen-mode" },
        {
          signal: abortController.signal,
          permissionMode: "default",
        },
      );
      expect(process.state.type).toBe("waiting-input");

      process.setPermissionMode("bypassPermissions");
      expect(process.appliedPermissionMode).toBe("default");
      expect(process.state.type).toBe("in-turn");
      expect(process.getPendingInputRequest()).toBeNull();
      await expect(approvalPromise).resolves.toEqual({ behavior: "allow" });
    });

    it("uses selected Ask when the provider turn was frozen in Bypass", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const approval = process.handleToolApproval(
        "Bash",
        { command: "touch bypass-mode" },
        {
          signal: new AbortController().signal,
          permissionMode: "bypassPermissions",
        },
      );

      expect(process.getPendingInputRequest()?.toolName).toBe("Bash");
      process.respondToInput(
        process.getPendingInputRequest()?.id ?? "",
        "deny",
      );
      await expect(approval).resolves.toMatchObject({ behavior: "deny" });
    });

    it("auto-approves only edits when Accept edits becomes pending", async () => {
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });
      const signal = new AbortController().signal;
      const editApproval = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal, permissionMode: "default" },
      );
      const commandApproval = process.handleToolApproval(
        "Bash",
        { command: "pnpm test" },
        { signal, permissionMode: "default" },
      );

      process.setPermissionMode("acceptEdits");

      await expect(editApproval).resolves.toEqual({ behavior: "allow" });
      expect(process.getPendingInputRequest()?.toolName).toBe("Bash");
      process.respondToInput(
        process.getPendingInputRequest()?.id ?? "",
        "deny",
      );
      await expect(commandApproval).resolves.toMatchObject({
        behavior: "deny",
      });
    });

    it("auto-approves every queued permission when Bypass becomes pending", async () => {
      const process = new Process(createMockIterator([]), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });
      const signal = new AbortController().signal;
      const commandApproval = process.handleToolApproval(
        "Bash",
        { command: "pnpm test" },
        { signal, permissionMode: "default" },
      );
      const editApproval = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal, permissionMode: "default" },
      );
      const question = process.handleToolApproval(
        "AskUserQuestion",
        {
          questions: [
            { question: "Continue?", header: "Continue", options: [] },
          ],
        },
        { signal, permissionMode: "default" },
      );

      process.setPermissionMode("bypassPermissions");

      await expect(commandApproval).resolves.toEqual({ behavior: "allow" });
      await expect(editApproval).resolves.toEqual({ behavior: "allow" });
      expect(process.getPendingInputRequest()?.type).toBe("question");
      process.respondToInput(
        process.getPendingInputRequest()?.id ?? "",
        "approve",
        { "Continue?": "Yes" },
      );
      await expect(question).resolves.toMatchObject({ behavior: "allow" });
    });

    it("handleToolApproval auto-allows read-only tools in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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

    it("queues deny feedback as follow-up message for Codex approvals", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        provider: "codex",
        queue: new MessageQueue(),
      });

      const abortController = new AbortController();
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();

      const accepted = process.respondToInput(
        pendingRequest?.id ?? "",
        "deny",
        undefined,
        "edit src/foo.ts instead",
      );

      expect(accepted).toBe(true);
      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("edit src/foo.ts instead");
      expect(result.interrupt).toBe(false);
      expect(process.queueDepth).toBe(1);
    });

    it("does not queue deny feedback follow-up for non-Codex providers", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
      });

      const abortController = new AbortController();
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();

      const accepted = process.respondToInput(
        pendingRequest?.id ?? "",
        "deny",
        undefined,
        "edit src/foo.ts instead",
      );

      expect(accepted).toBe(true);
      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("edit src/foo.ts instead");
      expect(result.interrupt).toBe(false);
      expect(process.queueDepth).toBe(0);
    });

    it("handleToolApproval prompts user for ExitPlanMode in plan mode (not auto-approve)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
      process.respondToInput(pendingRequest?.id ?? "", "approve");

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // After approval, should switch back to default mode
      expect(process.permissionMode).toBe("default");
    });

    it("surfaces AskUserQuestion as a user question in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();
      const input = {
        questions: [{ question: "test?", header: "Test", options: [] }],
      };

      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        input,
        { signal: abortController.signal },
      );

      expect(process.state.type).toBe("waiting-input");

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");
      expect(pendingRequest?.type).toBe("question");
      expect(pendingRequest?.prompt).toBe("test?");
      process.respondToInput(pendingRequest?.id ?? "", "approve", {
        "test?": "Yes",
      });

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toEqual({
        ...input,
        answers: { "test?": "Yes" },
      });
      expect(process.permissionMode).toBe("plan");
    });

    it("does not let permission rules answer AskUserQuestion", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissions: { deny: ["AskUserQuestion(*)"] },
      });

      const abortController = new AbortController();
      const input = {
        questions: [
          {
            question: "Which checks?",
            header: "Checks",
            options: [
              { label: "Unit", description: "Run unit tests" },
              { label: "Types", description: "Run typecheck" },
            ],
            multiSelect: true,
          },
        ],
      };
      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        input,
        {
          signal: abortController.signal,
        },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest?.type).toBe("question");
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");

      process.respondToInput(pendingRequest?.id ?? "", "approve", {
        "Which checks?": ["Unit", "Types"],
      });

      const result = await approvalPromise;
      expect(result).toEqual({
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: { "Which checks?": ["Unit", "Types"] },
        },
      });
    });

    it("handleToolApproval auto-approves Edit tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          permissionMode: "default",
        });

        const acceptEditsProcess = new Process(createMockIterator([]), {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-2",
          provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
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
      expect(process.state.type).toBe("in-turn");
    });

    it("clears pending approvals on interrupt", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "default",
        interruptFn: async () => true,
      });

      const abortController = new AbortController();
      const approvalPromise = process.handleToolApproval(
        "Bash",
        { command: "ls -la" },
        { signal: abortController.signal },
      );

      expect(process.state.type).toBe("waiting-input");
      expect(process.getPendingInputRequest()?.toolName).toBe("Bash");

      const interrupted = await process.interrupt();

      expect(interrupted).toBe(true);
      expect(process.state.type).toBe("in-turn");
      expect(process.getPendingInputRequest()).toBeNull();

      const result = await approvalPromise;
      expect(result).toMatchObject({
        behavior: "deny",
        message: "Operation interrupted",
        interrupt: true,
      });
    });
  });
});
