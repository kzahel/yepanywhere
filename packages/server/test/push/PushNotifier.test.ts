import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushNotifier } from "../../src/push/PushNotifier.js";
import type { PushService } from "../../src/push/PushService.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { InputRequest, ProcessState } from "../../src/supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
} from "../../src/watcher/EventBus.js";

describe("PushNotifier", () => {
  let mockEventBus: EventBus;
  let mockPushService: PushService;
  let mockSupervisor: Supervisor;
  let eventHandler: ((event: BusEvent) => void) | null = null;
  let unsubscribeCalled = false;

  const testProjectId = Buffer.from("/home/user/test-project").toString(
    "base64url",
  ) as UrlProjectId;

  beforeEach(() => {
    eventHandler = null;
    unsubscribeCalled = false;

    // Mock EventBus
    mockEventBus = {
      subscribe: vi.fn((handler) => {
        eventHandler = handler;
        return () => {
          unsubscribeCalled = true;
        };
      }),
      emit: vi.fn(),
    } as unknown as EventBus;

    // Mock PushService
    mockPushService = {
      getSubscriptionCount: vi.fn(() => 1),
      sendToAll: vi.fn(() =>
        Promise.resolve([{ browserProfileId: "profile-1", success: true }]),
      ),
      isNotificationTypeEnabled: vi.fn(() => true),
    } as unknown as PushService;

    // Mock Supervisor
    mockSupervisor = {
      getProcessForSession: vi.fn(),
    } as unknown as Supervisor;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("should subscribe to EventBus on construction", () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      expect(mockEventBus.subscribe).toHaveBeenCalled();
      expect(eventHandler).not.toBeNull();
    });

    it("should unsubscribe on dispose", () => {
      const notifier = new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      notifier.dispose();

      expect(unsubscribeCalled).toBe(true);
    });
  });

  describe("handling process state changes", () => {
    it("should send push notification when entering waiting-input state", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            toolInput: { file_path: "/home/user/test-project/src/index.ts" },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // Emit a waiting-input event
      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Wait for async processing
      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("pending-input");
      expect(payload.sessionId).toBe("session-1");
      expect(payload.projectId).toBe(testProjectId);
      expect(payload.projectName).toBe("test-project");
      expect(payload.inputType).toBe("tool-approval");
      expect(payload.summary).toBe("Edit: index.ts");
      expect(payload.requestId).toBe("req-1");
    });

    it("should not send push when state is running", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "running",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send push when no subscriptions exist", async () => {
      vi.mocked(mockPushService.getSubscriptionCount).mockReturnValue(0);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send push when process not found", async () => {
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });
  });

  describe("summary building", () => {
    it("should build summary with file path for file operations", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Write?",
            toolName: "Write",
            toolInput: {
              file_path: "/home/user/project/src/components/Button.tsx",
            },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Write: Button.tsx");
    });

    it("should build summary with just tool name when no file path", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Bash?",
            toolName: "Bash",
            toolInput: { command: "npm install" },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Run: Bash");
    });

    it("should truncate long question prompts", async () => {
      const longPrompt =
        "This is a very long question that exceeds the maximum length we want to show in a push notification summary";

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "question",
            prompt: longPrompt,
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary.length).toBeLessThanOrEqual(60);
      expect(payload.summary.endsWith("...")).toBe(true);
      expect(payload.inputType).toBe("user-question");
    });

    it("should not truncate short prompts", async () => {
      const shortPrompt = "What database should we use?";

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "question",
            prompt: shortPrompt,
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe(shortPrompt);
    });
  });

  describe("dismissal sync", () => {
    it("should send dismiss when process leaves waiting-input state", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // First, enter waiting-input state (sends pending-input)
      const waitingEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(waitingEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      // Verify first call was pending-input
      const firstPayload = vi.mocked(mockPushService.sendToAll).mock
        .calls[0][0];
      expect(firstPayload.type).toBe("pending-input");

      // Now exit waiting-input state (should send dismiss)
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "running",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(2);
      });

      // Verify second call was dismiss
      const secondPayload = vi.mocked(mockPushService.sendToAll).mock
        .calls[1][0];
      expect(secondPayload.type).toBe("dismiss");
      expect(secondPayload.sessionId).toBe("session-1");
    });

    it("should not send dismiss if no notification was sent for that session", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // Directly send running event without going through waiting-input first
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "running",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not have sent anything
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send dismiss when push sending failed", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      // Mock sendToAll to return no successful results
      vi.mocked(mockPushService.sendToAll).mockResolvedValue([
        {
          browserProfileId: "profile-1",
          success: false,
          error: "Network error",
        },
      ]);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // Enter waiting-input state
      const waitingEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(waitingEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      // Clear mock to track dismiss calls
      vi.mocked(mockPushService.sendToAll).mockClear();

      // Exit waiting-input state
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "running",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not have sent dismiss since no notification was successfully sent
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("error handling", () => {
    it("should handle push service errors gracefully", async () => {
      vi.mocked(mockPushService.sendToAll).mockRejectedValue(
        new Error("Network error"),
      );

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        processState: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[PushNotifier]"),
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });
});
