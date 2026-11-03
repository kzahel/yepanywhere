import { controlledProvider } from "../support/scripted-provider.js";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushNotifier } from "../../src/push/PushNotifier.js";
import type { PushService } from "../../src/push/PushService.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { EventBus as LiveEventBus } from "../../src/watcher/EventBus.js";
import { createControllableIterator } from "../process.test-support.js";
import type { InputRequest, ProcessState } from "../../src/supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  SessionAbortedEvent,
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Wait for async processing
      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const sendCall = vi.mocked(mockPushService.sendToAll).mock.calls[0];
      expect(sendCall).toHaveLength(1);
      const payload = sendCall[0];
      expect(payload.type).toBe("pending-input");
      expect(payload.sessionId).toBe("session-1");
      expect(payload.projectId).toBe(testProjectId);
      expect(payload.projectName).toBe("test-project");
      expect(payload.inputType).toBe("tool-approval");
      expect(payload.summary).toBe("Edit: index.ts");
      expect(payload.requestId).toBe("req-1");
    });

    it("should not send push when activity is in-turn", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
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
        activity: "waiting-input",
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
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });
  });

  describe("session halted notifications", () => {
    it("should send session-halted push when a live process becomes idle", async () => {
      const startedAt = new Date("2026-01-01T00:00:00.000Z");
      const timestamp = "2026-01-01T00:00:05.000Z";
      const mockProcess = {
        userTurnVersion: 0,
        state: {
          type: "idle",
          since: new Date(timestamp),
        } as ProcessState,
        startedAt,
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
        activity: "idle",
        timestamp,
      };

      eventHandler?.({ ...event, activity: "in-turn" });
      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload).toMatchObject({
        type: "session-halted",
        sessionId: "session-1",
        projectId: testProjectId,
        projectName: "test-project",
        reason: "completed",
        duration: 5000,
        timestamp,
      });
    });

    it("should ignore synthetic idle events from process cleanup", async () => {
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
        activity: "idle",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.({ ...event, activity: "in-turn" });
      eventHandler?.(event);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send session-halted when the setting is disabled", async () => {
      vi.mocked(mockPushService.isNotificationTypeEnabled).mockImplementation(
        (type) => type !== "sessionHalted",
      );

      const mockProcess = {
        userTurnVersion: 0,
        state: {
          type: "idle",
          since: new Date(),
        } as ProcessState,
        startedAt: new Date(),
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
        activity: "idle",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.({ ...event, activity: "in-turn" });
      eventHandler?.(event);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should send session-halted push when a process terminates", async () => {
      const startedAt = new Date("2026-01-01T00:00:00.000Z");
      const timestamp = "2026-01-01T00:00:08.000Z";
      const mockProcess = {
        userTurnVersion: 0,
        state: {
          type: "terminated",
          reason: "stale",
        } as ProcessState,
        startedAt,
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

      const event: ProcessTerminatedEvent = {
        type: "process-terminated",
        sessionId: "session-1",
        projectId: testProjectId,
        processId: "process-1",
        provider: "claude",
        reason: "stale: no SDK messages for 60s",
        timestamp,
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload).toMatchObject({
        type: "session-halted",
        sessionId: "session-1",
        reason: "error",
        duration: 8000,
        timestamp,
      });
    });

    it("should suppress session-halted after a user abort", async () => {
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue({
        userTurnVersion: 0,
        state: { type: "idle" },
      } as ReturnType<Supervisor["getProcessForSession"]>);
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const abortedEvent: SessionAbortedEvent = {
        type: "session-aborted",
        sessionId: "session-1",
        projectId: testProjectId,
        timestamp: new Date().toISOString(),
      };
      const terminatedEvent: ProcessTerminatedEvent = {
        type: "process-terminated",
        sessionId: "session-1",
        projectId: testProjectId,
        processId: "process-1",
        provider: "claude",
        reason: "interrupt fallback abort",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(abortedEvent);
      eventHandler?.(terminatedEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });
  });

  describe("completion boundaries and intentional stops", () => {
    function setup() {
      const process = {
        userTurnVersion: 0,
        state: { type: "idle", since: new Date() } as ProcessState,
        startedAt: new Date(),
      };
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        process as ReturnType<Supervisor["getProcessForSession"]>,
      );
      const notifier = new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });
      const activity = (value: ProcessStateEvent["activity"]) => {
        eventHandler?.({
          type: "process-state-changed",
          sessionId: "session-1",
          projectId: testProjectId,
          activity: value,
          timestamp: new Date().toISOString(),
        });
      };
      const terminated = () =>
        eventHandler?.({
          type: "process-terminated",
          sessionId: "session-1",
          projectId: testProjectId,
          processId: "process-1",
          provider: "codex",
          reason: "underlying process terminated",
          timestamp: new Date().toISOString(),
        });
      return { process, notifier, activity, terminated };
    }

    it("does not treat initial or restored idle state as completed work", () => {
      const { activity } = setup();
      activity("idle");
      activity("idle");
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("consumes a completion edge before delivery finishes and rearms for later work", () => {
      const { activity } = setup();
      vi.mocked(mockPushService.sendToAll).mockReturnValue(
        new Promise(() => {}),
      );
      activity("in-turn");
      activity("idle"); // result
      activity("idle"); // iterator done
      expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      activity("in-turn");
      activity("idle");
      expect(mockPushService.sendToAll).toHaveBeenCalledTimes(2);
    });

    it.each(["session-stop-requested", "session-aborted"] as const)(
      "keeps %s quiet through repeated cleanup until fresh user work",
      (type) => {
        const { process, activity, terminated } = setup();
        activity("in-turn");
        eventHandler?.({
          type,
          sessionId: "session-1",
          projectId: testProjectId,
          timestamp: new Date().toISOString(),
        });
        activity("idle");
        activity("idle");
        activity("in-turn"); // a late provider cleanup event is not fresh input
        activity("idle");
        terminated();
        terminated();
        expect(mockPushService.sendToAll).not.toHaveBeenCalled();
        process.userTurnVersion++;
        activity("in-turn");
        activity("idle");
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      },
    );

    it("does not carry stop suppression into a replacement process", () => {
      const { process, activity } = setup();
      eventHandler?.({
        type: "session-stop-requested",
        sessionId: "session-1",
        projectId: testProjectId,
        timestamp: new Date().toISOString(),
      });
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue({
        ...process,
      } as ReturnType<Supervisor["getProcessForSession"]>);
      activity("in-turn");
      activity("idle");
      expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
    });

    it("preserves unexpected termination alerts and ignores duplicate termination events", () => {
      const { terminated } = setup();
      terminated();
      terminated();
      expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      expect(mockPushService.sendToAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session-halted", reason: "error" }),
      );
    });

    it("stops notification generation before bulk abort or detach cleanup", () => {
      const { notifier, activity, terminated } = setup();
      activity("in-turn");
      notifier.dispose();
      for (let i = 0; i < 23; i++) {
        activity("idle");
        activity("idle");
        terminated();
      }
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("does not send a completion after shutdown interrupts an awaited dismiss", async () => {
      const { process, notifier, activity } = setup();
      process.state = {
        type: "waiting-input",
        request: {
          id: "request-1",
          type: "tool-approval",
          toolName: "Bash",
        } as InputRequest,
      };
      activity("waiting-input");
      await vi.waitFor(() =>
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1),
      );
      let resolveDismiss!: (value: []) => void;
      vi.mocked(mockPushService.sendToAll).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDismiss = resolve;
          }),
      );
      process.state = { type: "idle", since: new Date() };
      activity("idle");
      activity("idle");
      notifier.dispose();
      resolveDismiss([]);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockPushService.sendToAll).toHaveBeenCalledTimes(2);
      expect(mockPushService.sendToAll).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "session-halted" }),
      );
    });
  });

  describe("real supervisor and process lifecycle", () => {
    it.each(["stop", "kill", "shutdown"])(
      "keeps %s cleanup quiet without changing provider teardown",
      async (action) => {
        const eventBus = new LiveEventBus();
        const stream = createControllableIterator();
        const queue = new MessageQueue();
        const abort = vi.fn(() => {
          stream.push({ type: "result", session_id: "lifecycle-session" });
          stream.finish();
        });
        const interrupt = vi.fn(async () => {
          stream.push({ type: "result", session_id: "lifecycle-session" });
          return true;
        });
        const supervisor = new Supervisor({
          eventBus,
          providerDiscoveryEnabled: false,
          provider: controlledProvider({
            startSession: async () => ({
              iterator: stream.iterator,
              queue,
              abort,
              interrupt,
            }),
          }),
        });
        const notifier = new PushNotifier({
          eventBus,
          supervisor,
          pushService: mockPushService,
        });
        const process = await supervisor.resumeSession(
          "lifecycle-session",
          "/tmp/test",
          { text: "hi" },
        );
        // Model the provider having consumed its initial input.
        queue.drain();
        try {
          if (action === "shutdown") {
            stream.push({ type: "result", session_id: process.sessionId });
            await vi.waitFor(() => expect(process.state.type).toBe("idle"));
            vi.mocked(mockPushService.sendToAll).mockClear();
            notifier.dispose();
            await process.abort(); // Mac shutdown bypasses Supervisor.abortProcess
          } else if (action === "kill") {
            await supervisor.abortProcessWithVerification(process.id);
          } else {
            expect(await supervisor.interruptProcess(process.id)).toMatchObject(
              { success: true },
            );
            await vi.waitFor(() => expect(process.state.type).toBe("idle"));
            expect(interrupt).toHaveBeenCalledTimes(1);
            expect(abort).not.toHaveBeenCalled();
            expect(mockPushService.sendToAll).not.toHaveBeenCalled();
            process.queueMessage({
              text: "next turn",
              metadata: { serverReceivedAt: new Date().toISOString() },
            });
            queue.drain();
            stream.push({ type: "result", session_id: process.sessionId });
            await vi.waitFor(() =>
              expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1),
            );
            expect(mockPushService.sendToAll).toHaveBeenCalledWith(
              expect.objectContaining({ reason: "completed" }),
            );
            return;
          }
          expect(mockPushService.sendToAll).not.toHaveBeenCalled();
          expect(abort).toHaveBeenCalledTimes(1);
          expect(
            supervisor.getProcessForSession(process.sessionId),
          ).toBeUndefined();
        } finally {
          notifier.dispose();
          if (supervisor.getProcessForSession(process.sessionId)) {
            await supervisor.abortProcessWithVerification(process.id);
          }
        }
      },
    );
  });

  describe("summary building", () => {
    it("should build summary with file path for file operations", async () => {
      const mockProcess = {
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        activity: "in-turn",
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
        activity: "in-turn",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
        activity: "in-turn",
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
        userTurnVersion: 0,
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
        activity: "waiting-input",
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
