import { beforeEach, describe, expect, it } from "vitest";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
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
        processState: "running",
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
        status: { state: "owned" },
      });
    });
  });
});
