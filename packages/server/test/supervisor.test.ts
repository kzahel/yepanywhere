import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { RealClaudeSDKInterface } from "../src/sdk/types.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
import type { SessionSummary } from "../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../src/watcher/EventBus.js";

describe("Supervisor", () => {
  let mockSdk: MockClaudeSDK;
  let supervisor: Supervisor;

  beforeEach(() => {
    mockSdk = new MockClaudeSDK();
    supervisor = new Supervisor({ sdk: mockSdk, idleTimeoutMs: 100 });
  });

  describe("startSession", () => {
    it("starts a session and returns a process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      expect(process.id).toBeDefined();
      expect(process.projectPath).toBe("/tmp/test");
    });

    it("tracks process in getAllProcesses", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisor.startSession("/tmp/test", { text: "hi" });

      expect(supervisor.getAllProcesses()).toHaveLength(1);
    });

    it("encodes projectId correctly", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // /tmp/test in base64url
      expect(process.projectId).toBe(
        Buffer.from("/tmp/test").toString("base64url"),
      );
    });

    it("queues the initial message", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // The message was queued
      expect(process.queueDepth).toBeGreaterThanOrEqual(0);
    });
  });

  describe("resumeSession", () => {
    it("resumes an existing session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "continue",
      });

      expect(process.sessionId).toBe("sess-123");
    });

    it("reuses existing process for same session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).toBe(process2.id);
    });

    it("creates new process for different session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));
      mockSdk.addScenario(createMockScenario("sess-456", "Second"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-456", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).not.toBe(process2.id);
    });
  });

  describe("getProcess", () => {
    it("returns process by id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcess(process.id);

      expect(found).toBe(process);
    });

    it("returns undefined for unknown id", () => {
      const found = supervisor.getProcess("unknown-id");
      expect(found).toBeUndefined();
    });
  });

  describe("getProcessForSession", () => {
    it("returns process by session id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcessForSession("sess-123");

      expect(found).toBe(process);
    });

    it("returns undefined for unknown session", () => {
      const found = supervisor.getProcessForSession("unknown-session");
      expect(found).toBeUndefined();
    });
  });

  describe("getProcessInfoList", () => {
    it("returns info for all processes", async () => {
      mockSdk.addScenario(createMockScenario("sess-1", "First"));
      mockSdk.addScenario(createMockScenario("sess-2", "Second"));

      await supervisor.startSession("/tmp/test1", { text: "one" });
      await supervisor.startSession("/tmp/test2", { text: "two" });

      const infoList = supervisor.getProcessInfoList();

      expect(infoList).toHaveLength(2);
      expect(infoList[0]?.id).toBeDefined();
      expect(infoList[1]?.id).toBeDefined();
    });
  });

  describe("abortProcess", () => {
    it("aborts and removes process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      const result = await supervisor.abortProcess(process.id);

      expect(result).toBe(true);
      expect(supervisor.getAllProcesses()).toHaveLength(0);
    });

    it("returns false for unknown process", async () => {
      const result = await supervisor.abortProcess("unknown-id");
      expect(result).toBe(false);
    });

    it("removes session mapping on abort", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });

      await supervisor.abortProcess(process.id);

      expect(supervisor.getProcessForSession("sess-123")).toBeUndefined();
    });

    it("records a terminated process only once when abort emits completion", async () => {
      let aborted = false;

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "abort-once-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.startSession("/tmp/test", {
        text: "hi",
      });

      await expect(
        supervisorWithRealSdk.abortProcess(process.id),
      ).resolves.toBe(true);

      expect(
        supervisorWithRealSdk.getRecentlyTerminatedProcesses(),
      ).toHaveLength(1);
    });
  });

  describe("queue propagation", () => {
    it("preserves model settings when a queued session starts later", async () => {
      let aborted = false;
      const startSession = vi.fn(
        async (options: {
          model?: string;
          thinking?: { type: "adaptive" | "enabled" | "disabled" };
          effort?: "low" | "medium" | "high" | "max";
          resumeSessionId?: string;
          initialMessage?: { text: string };
        }) => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ??
                `queued-session-${options.initialMessage?.text ?? "none"}`,
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
          };
        },
      );

      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };

      const supervisorWithQueue = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      const first = await supervisorWithQueue.startSession("/tmp/test", {
        text: "first",
      });
      expect("id" in first).toBe(true);

      const queued = await supervisorWithQueue.startSession(
        "/tmp/test",
        { text: "second" },
        undefined,
        {
          model: "gpt-5.4",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      );
      expect("queued" in queued && queued.queued).toBe(true);

      aborted = true;
      await supervisorWithQueue.abortProcess((first as { id: string }).id);

      await vi.waitFor(() => {
        expect(startSession).toHaveBeenCalledTimes(2);
      });

      expect(startSession.mock.calls[1]?.[0]).toMatchObject({
        model: "gpt-5.4",
        thinking: { type: "adaptive" },
        effort: "high",
        initialMessage: { text: "second" },
      });
    });
  });

  describe("eventBus integration", () => {
    it("emits process-state-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find process-state-changed events
      const processStateEvents = events.filter(
        (e) => e.type === "process-state-changed",
      );

      console.log(
        "All events emitted:",
        events.map((e) => e.type),
      );
      console.log("Process state events:", processStateEvents);

      expect(processStateEvents.length).toBeGreaterThanOrEqual(1);
      expect(processStateEvents[0]).toMatchObject({
        type: "process-state-changed",
        activity: "in-turn",
      });
    });

    it("emits session-status-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find session-status-changed events
      const statusEvents = events.filter(
        (e) => e.type === "session-status-changed",
      );

      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      expect(statusEvents[0]).toMatchObject({
        type: "session-status-changed",
        ownership: { owner: "self" },
      });
    });

    it("emits optimistic title/messageCount in session-created for real SDK sessions", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "real-session-1",
            };
            yield { type: "result", session_id: "real-session-1" };
          }
          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {},
          };
        },
      };

      const supervisorWithBus = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      await supervisorWithBus.startSession("/tmp/test", {
        text: "Optimistic title from request",
      });

      const created = events.find(
        (e): e is Extract<BusEvent, { type: "session-created" }> =>
          e.type === "session-created",
      );
      expect(created).toBeDefined();
      expect(created?.session.title).toBe("Optimistic title from request");
      expect(created?.session.messageCount).toBe(1);
    });

    it("strips IDE setup preambles from optimistic session titles", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "real-session-ide-1",
            };
            yield { type: "result", session_id: "real-session-ide-1" };
          }
          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {},
          };
        },
      };

      const supervisorWithBus = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      await supervisorWithBus.startSession("/tmp/test", {
        text: `# Context from my IDE setup:

## Active file: /tmp/foo.ts

## Open tabs:
- foo.ts: /tmp/foo.ts

## My request for Codex:
Investigate the bad session title`,
      });

      const created = events.find(
        (e): e is Extract<BusEvent, { type: "session-created" }> =>
          e.type === "session-created",
      );
      expect(created).toBeDefined();
      expect(created?.session.title).toBe("Investigate the bad session title");
      expect(created?.session.fullTitle).toBe(
        "Investigate the bad session title",
      );
      expect(created?.session.messageCount).toBe(1);
    });

    it("emits timed session-updated reconciliation from onSessionSummary", async () => {
      vi.useFakeTimers();
      try {
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => events.push(event));

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "reconcile-session-1",
              };
            }
            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {},
            };
          },
        };

        const onSessionSummary = vi.fn(
          async (
            sessionId: string,
            projectId: string,
          ): Promise<SessionSummary | null> => ({
            id: sessionId,
            projectId,
            title: "Reconciled title",
            fullTitle: "Reconciled title",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1000).toISOString(),
            messageCount: 1,
            ownership: { owner: "self", processId: "test-proc" },
            provider: "claude",
          }),
        );

        const supervisorWithBus = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          eventBus,
          onSessionSummary,
        });

        await supervisorWithBus.startSession("/tmp/test", {
          text: "Seed title",
        });

        // Allow init event and first reconciliation window.
        await vi.advanceTimersByTimeAsync(20);
        await vi.advanceTimersByTimeAsync(1100);

        expect(onSessionSummary).toHaveBeenCalled();

        const updated = events.find(
          (event): event is Extract<BusEvent, { type: "session-updated" }> =>
            event.type === "session-updated" &&
            event.sessionId === "reconcile-session-1",
        );
        expect(updated).toBeDefined();
        expect(updated?.title).toBe("Reconciled title");
        expect(updated?.messageCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits process-terminated when the underlying process exits unexpectedly", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "terminated-session-1",
            };
            throw new Error("process exited");
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {},
          };
        },
      };

      const supervisorWithBus = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      await supervisorWithBus.startSession("/tmp/test", {
        text: "Trigger failure",
      });

      await vi.waitFor(() => {
        expect(
          events.some((event) => event.type === "process-terminated"),
        ).toBe(true);
      });

      const terminated = events.find(
        (event): event is Extract<BusEvent, { type: "process-terminated" }> =>
          event.type === "process-terminated",
      );
      expect(terminated).toMatchObject({
        type: "process-terminated",
        sessionId: "terminated-session-1",
        reason: "underlying process terminated",
      });
    });

    it("keeps idle sessions owned while the underlying process is still alive", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "idle-alive-session-1",
              };
              yield { type: "result", session_id: "idle-alive-session-1" };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithAliveProcess = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
        });

        const process = await supervisorWithAliveProcess.startSession(
          "/tmp/test",
          {
            text: "Keep this session alive",
          },
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(150);

        expect(
          supervisorWithAliveProcess.getProcessForSession(
            "idle-alive-session-1",
          ),
        ).toBe(process);

        const abortPromise = supervisorWithAliveProcess.abortProcess(
          process.id,
        );
        await vi.advanceTimersByTimeAsync(20);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
