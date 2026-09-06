import { DEFAULT_RECAP_AFTER_SECONDS } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import type {
  EffectiveSessionLaunchSettings,
  EffectiveSessionLaunchSettingsValue,
  SessionMetadataService,
} from "../src/metadata/index.js";
import { getLogger } from "../src/logging/logger.js";
import type { NotificationService } from "../src/notifications/index.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { RealClaudeSDKInterface } from "../src/sdk/types.js";
import { createControllableIterator, waitFor } from "./process.test-support.js";
import {
  RetryableSessionLaunchError,
  type ResumeCompactionError,
  Supervisor,
} from "../src/supervisor/Supervisor.js";
import {
  type SessionSummary,
  encodeProjectId,
} from "../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../src/watcher/EventBus.js";

function createLaunchSettingsMetadata(
  initial?: EffectiveSessionLaunchSettings,
  legacyRequestedModel?: string,
) {
  let current = initial;
  const writes = {
    setProvider: vi.fn<SessionMetadataService["setProvider"]>(
      async () => undefined,
    ),
    setExecutor: vi.fn<SessionMetadataService["setExecutor"]>(
      async () => undefined,
    ),
    updateMetadata: vi.fn<SessionMetadataService["updateMetadata"]>(
      async () => undefined,
    ),
    setSessionSandbox: vi.fn<SessionMetadataService["setSessionSandbox"]>(
      async () => undefined,
    ),
    remapSessionId: vi.fn<SessionMetadataService["remapSessionId"]>(
      async () => undefined,
    ),
    flushPendingWrites: vi.fn<SessionMetadataService["flushPendingWrites"]>(
      async () => undefined,
    ),
    recordSyntheticDone: vi.fn<SessionMetadataService["recordSyntheticDone"]>(
      async () => undefined,
    ),
  };
  const service = {
    getMetadata: () => undefined,
    getEffectiveLaunchSettings: () => current,
    getRequestedModel: () =>
      current ? (current.requestedModel ?? undefined) : legacyRequestedModel,
    recordEffectiveLaunchSettings: async (
      _sessionId: string,
      value: EffectiveSessionLaunchSettingsValue,
    ) => {
      const unchanged =
        current?.permissionMode === value.permissionMode &&
        current.requestedModel === value.requestedModel &&
        current.serviceTier === value.serviceTier &&
        JSON.stringify(current.thinking) === JSON.stringify(value.thinking) &&
        current.effort === value.effort;
      if (!unchanged) {
        current = {
          schemaVersion: 1,
          revision: (current?.revision ?? 0) + 1,
          ...value,
        };
      }
      return current as EffectiveSessionLaunchSettings;
    },
    ...writes,
  } as unknown as SessionMetadataService;
  return { service, current: () => current, writes };
}

function testProvider(
  startSession: AgentProvider["startSession"],
): AgentProvider {
  return {
    name: "claude",
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
    supportsSteering: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    startSession,
  };
}

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

    it("keeps an isolated mock SDK out of provider discovery", async () => {
      const isolatedSdk = new MockClaudeSDK();
      isolatedSdk.addScenario(createMockScenario("isolated-session", "Hello!"));
      const isolatedSupervisor = new Supervisor({
        provider: null,
        sdk: isolatedSdk,
        idleTimeoutMs: 100,
      });

      const process = await isolatedSupervisor.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { providerName: "claude" },
      );

      await vi.waitFor(() => {
        expect(process.sessionId).toBe("isolated-session");
      });
      await expect(
        isolatedSupervisor.requestRecap(process.id),
      ).resolves.toMatchObject({
        supported: false,
        emitted: false,
        reason: "provider not found",
      });
    });

    it("tracks process in getAllProcesses", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisor.startSession("/tmp/test", { text: "hi" });

      expect(supervisor.getAllProcesses()).toHaveLength(1);
    });

    it("revalidates Gateway models at the actual new-session launch", async () => {
      let advertisedModels = [{ id: "gateway-model", name: "Gateway Model" }];
      let sessionNumber = 0;
      const getAvailableModels = vi.fn(async () => advertisedModels);
      const startSession = vi.fn(
        async (_options: Parameters<AgentProvider["startSession"]>[0]) => {
          sessionNumber += 1;
          const sessionId = `gateway-session-${sessionNumber}`;
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: sessionId,
            };
            for await (const message of queue) {
              void message;
              yield { type: "result" as const, session_id: sessionId };
              return;
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {},
          };
        },
      );
      const provider = {
        ...testProvider(startSession),
        name: "claude-gateway" as const,
        displayName: "Claude Gateway",
        getAvailableModels,
      };
      const gatewaySupervisor = new Supervisor({ provider });

      await expect(
        gatewaySupervisor.startSession(
          "/tmp/test",
          { text: "start after validation" },
          undefined,
          { model: "gateway-model", providerName: "claude-gateway" },
        ),
      ).resolves.toMatchObject({ provider: "claude-gateway" });

      advertisedModels = [];
      await expect(
        gatewaySupervisor.startSession(
          "/tmp/test",
          { text: "start after catalog changed" },
          undefined,
          { model: "gateway-model", providerName: "claude-gateway" },
        ),
      ).rejects.toThrow(
        'Claude Gateway no longer advertises model "gateway-model"',
      );
      await expect(
        gatewaySupervisor.createSession("/tmp/test", undefined, {
          model: "gateway-model",
          providerName: "claude-gateway",
        }),
      ).rejects.toThrow(
        'Claude Gateway no longer advertises model "gateway-model"',
      );
      expect(getAvailableModels).toHaveBeenCalledTimes(3);
      expect(startSession).toHaveBeenCalledTimes(1);
    });

    it("rejects retryably when required provider startup fails before init", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const abort = vi.fn();
      const consumedMessages: unknown[] = [];
      const provider = testProvider(async () => {
        const queue = new MessageQueue();
        async function* iterator() {
          for await (const message of queue) {
            consumedMessages.push(message);
            yield await Promise.reject(
              new Error("Codex app-server socket timed out"),
            );
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort,
        };
      });
      const providerSupervisor = new Supervisor({ provider });

      await expect(
        providerSupervisor.startSession(
          "/tmp/test",
          { text: "keep this queued" },
          undefined,
          undefined,
          { requireProviderSessionId: true },
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          name: RetryableSessionLaunchError.name,
          message: expect.stringContaining("Codex app-server socket timed out"),
        }),
      );

      expect(consumedMessages).toHaveLength(1);
      expect(abort).toHaveBeenCalledOnce();
      expect(providerSupervisor.getAllProcesses()).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_error",
          errorMessage: "Codex app-server socket timed out",
        }),
        expect.stringContaining("Codex app-server socket timed out"),
      );
      errorLog.mockRestore();
    });

    it("settles a required launch on provider identity after queuing input", async () => {
      const abort = vi.fn();
      const consumedMessages: unknown[] = [];
      const provider = testProvider(async () => {
        const queue = new MessageQueue();
        async function* iterator() {
          for await (const message of queue) {
            consumedMessages.push(message);
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: "provider-session-id",
            };
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort,
        };
      });
      const providerSupervisor = new Supervisor({ provider });

      const process = await providerSupervisor.startSession(
        "/tmp/test",
        { text: "launch after input" },
        undefined,
        undefined,
        { requireProviderSessionId: true },
      );

      expect(process).toMatchObject({ sessionId: "provider-session-id" });
      expect(consumedMessages).toHaveLength(1);
      expect(providerSupervisor.getAllProcesses()).toEqual([process]);
    });

    it("classifies create-only provider startup rejection as retryable", async () => {
      const provider = testProvider(async () => {
        throw new Error("Provider rejected this launch");
      });
      const providerSupervisor = new Supervisor({ provider });

      await expect(
        providerSupervisor.createSession("/tmp/test", undefined, undefined, {
          retryProviderStartupFailure: true,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          name: RetryableSessionLaunchError.name,
          message: expect.stringContaining("Provider rejected this launch"),
        }),
      );
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

    it("persists provider use before registering a live process", async () => {
      mockSdk.addScenario(createMockScenario("sess-eligible", "Hello!"));
      const onSuccessfulProviderSession = vi.fn(async () => {});
      const providerMetadata = {
        getMetadata: vi.fn(() => undefined),
        recordEffectiveLaunchSettings: vi.fn(async () => undefined),
        remapSessionId: vi.fn(async () => {}),
        setProvider: vi.fn(async () => {}),
      };
      const supervisorWithEligibility = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        sessionMetadataService:
          providerMetadata as unknown as SessionMetadataService,
        onSuccessfulProviderSession,
      });

      const process = await supervisorWithEligibility.startSession(
        "/tmp/test",
        { text: "hi" },
      );

      expect(providerMetadata.setProvider).toHaveBeenCalledWith(
        process.sessionId,
        "claude",
      );
      expect(onSuccessfulProviderSession).toHaveBeenCalledWith(
        process.sessionId,
        "claude",
      );
      expect(supervisorWithEligibility.getAllProcesses()).toEqual([process]);
    });

    it("aborts instead of reporting success when eligibility is not durable", async () => {
      mockSdk.addScenario(createMockScenario("sess-failed-eligibility", ""));
      const supervisorWithEligibility = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        onSuccessfulProviderSession: async () => {
          throw new Error("disk full");
        },
      });

      await expect(
        supervisorWithEligibility.startSession("/tmp/test", { text: "hi" }),
      ).rejects.toThrow(
        "Failed to persist successful claude session boundary: disk full",
      );
      expect(supervisorWithEligibility.getAllProcesses()).toEqual([]);
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

    it("waits for provider attachment before accepting a required resume", async () => {
      let releaseAttachment!: () => void;
      const attachmentGate = new Promise<void>((resolve) => {
        releaseAttachment = resolve;
      });
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          async function* iterator() {
            for await (const message of queue) {
              void message;
              await attachmentGate;
              yield {
                type: "system" as const,
                subtype: "init" as const,
                session_id: options.resumeSessionId,
              };
            }
          }
          return { iterator: iterator(), queue, abort: () => {} };
        },
      );
      const providerSupervisor = new Supervisor({
        provider: testProvider(startSession),
      });
      const settled = vi.fn();

      const resume = providerSupervisor.resumeSession(
        "native-session",
        "/tmp/test",
        { text: "continue" },
        undefined,
        undefined,
        { requireProviderSessionId: true },
      );
      void resume.then(settled);
      await waitFor(() => expect(startSession).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();

      releaseAttachment();
      const process = await resume;

      expect(settled).toHaveBeenCalledWith(process);
      expect(process).toMatchObject({ sessionId: "native-session" });
    });

    it("rejects and unregisters a required resume when attachment fails", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const abort = vi.fn();
      const provider = testProvider(async () => {
        const queue = new MessageQueue();
        async function* iterator() {
          for await (const message of queue) {
            void message;
            yield await Promise.reject(new Error("native session is missing"));
          }
        }
        return { iterator: iterator(), queue, abort };
      });
      const providerSupervisor = new Supervisor({ provider });

      await expect(
        providerSupervisor.resumeSession(
          "missing-session",
          "/tmp/test",
          { text: "continue" },
          undefined,
          undefined,
          { requireProviderSessionId: true },
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          name: RetryableSessionLaunchError.name,
          message: expect.stringContaining("native session is missing"),
        }),
      );

      expect(abort).toHaveBeenCalledOnce();
      expect(providerSupervisor.getAllProcesses()).toEqual([]);
      errorLog.mockRestore();
    });

    it("rejects a required resume that attaches a different native session", async () => {
      const abort = vi.fn();
      const provider = testProvider(async () => {
        const queue = new MessageQueue();
        async function* iterator() {
          for await (const message of queue) {
            void message;
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: "replacement-session",
            };
            return;
          }
        }
        return { iterator: iterator(), queue, abort };
      });
      const providerSupervisor = new Supervisor({ provider });

      await expect(
        providerSupervisor.resumeSession(
          "missing-session",
          "/tmp/test",
          { text: "continue" },
          undefined,
          undefined,
          { requireProviderSessionId: true },
        ),
      ).rejects.toThrow(
        "Provider attached session replacement-session instead of missing-session",
      );

      expect(abort).toHaveBeenCalledOnce();
      expect(providerSupervisor.getAllProcesses()).toEqual([]);
    });

    it("inherits durable settings on a cold direct-message resume", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              void message;
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "new-session",
              };
              return;
            }
          }
          return { iterator: iterator(), queue, abort: () => {} };
        },
      );
      const provider = testProvider(startSession);
      const metadata = createLaunchSettingsMetadata({
        schemaVersion: 1,
        revision: 7,
        permissionMode: "bypassPermissions",
        requestedModel: "opus",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "max",
      });
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
      });

      const process = await supervisorWithMetadata.resumeSession(
        "cold-resume",
        "/tmp/test",
        { text: "continue" },
      );

      expect("id" in process).toBe(true);
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "cold-resume",
          permissionMode: "bypassPermissions",
          model: "opus",
          serviceTier: "priority",
          thinking: { type: "adaptive" },
          effort: "max",
        }),
      );
      expect(metadata.current()?.revision).toBe(7);
    });

    it("does not persist a model change rejected by the provider", async () => {
      const setModel = vi.fn(async () => {
        throw new Error("unsupported model");
      });
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            setModel,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider = testProvider(startSession);
      const initial: EffectiveSessionLaunchSettings = {
        schemaVersion: 1,
        revision: 2,
        permissionMode: "default",
        requestedModel: "sonnet",
        serviceTier: null,
        thinking: null,
        effort: null,
      };
      const metadata = createLaunchSettingsMetadata(initial);
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
      });
      const process = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "rejected-model",
      );

      await expect(
        supervisorWithMetadata.reconfigureProcess(process.id, {
          model: "missing-model",
        }),
      ).rejects.toThrow("unsupported model");
      expect(metadata.current()).toEqual(initial);

      await expect(
        supervisorWithMetadata.abortProcess(process.id),
      ).resolves.toBe(true);
    });

    it("persists an exact default token after a successful live model switch", async () => {
      const setModel = vi.fn(async () => {});
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            setModel,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const metadata = createLaunchSettingsMetadata({
        schemaVersion: 1,
        revision: 2,
        permissionMode: "default",
        requestedModel: "sonnet",
        serviceTier: null,
        thinking: null,
        effort: null,
      });
      const supervisorWithMetadata = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: metadata.service,
      });
      const process = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "default-model",
      );

      const updated = await supervisorWithMetadata.reconfigureProcess(
        process.id,
        { model: undefined, requestedModel: "default" },
      );

      expect(updated).toBe(process);
      expect(setModel).toHaveBeenCalledWith(undefined);
      expect(process.requestedModel).toBe("default");
      expect(process.resolvedModel).toBeUndefined();
      expect(metadata.current()).toEqual({
        schemaVersion: 1,
        revision: 3,
        permissionMode: "default",
        requestedModel: "default",
        serviceTier: null,
        thinking: null,
        effort: null,
      });

      await expect(
        supervisorWithMetadata.abortProcess(process.id),
      ).resolves.toBe(true);
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

    it("restarts an existing process when thinking display changes", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "display-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process1 = await supervisorWithProvider.resumeSession(
        "display-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        { thinking: { type: "adaptive" } },
      );

      const process2 = await supervisorWithProvider.resumeSession(
        "display-session",
        "/tmp/test",
        { text: "second" },
        undefined,
        { thinking: { type: "adaptive", display: "summarized" } },
      );

      expect(process1.id).not.toBe(process2.id);
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(startSession.mock.calls[1]?.[0].thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });

      await supervisorWithProvider.abortProcess(process2.id);
    });

    it("restarts Codex to apply a changed native compact threshold", async () => {
      const controllers: ReturnType<typeof createControllableIterator>[] = [];
      const startSession = vi.fn(
        async (_options: Parameters<AgentProvider["startSession"]>[0]) => {
          const controller = createControllableIterator();
          controllers.push(controller);
          return {
            iterator: controller.iterator,
            queue: new MessageQueue(),
            abort: () => controller.finish(),
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: true,
        supportsNativeCompactThreshold: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const started = await supervisorWithProvider.resumeSession(
        "compact-threshold-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        {
          model: "gpt-5.6",
          compactAtContextPercent: 25,
          compactAtContextWindow: 272_000,
        },
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      controllers[0]?.push({
        type: "system",
        subtype: "init",
        session_id: "compact-threshold-session",
      });
      controllers[0]?.push({
        type: "result",
        session_id: "compact-threshold-session",
      });
      await waitFor(() => expect(started.state.type).toBe("idle"));
      const result = await supervisorWithProvider.queueMessageToSession(
        "compact-threshold-session",
        "/tmp/test",
        { text: "second" },
        undefined,
        {
          model: "gpt-5.6",
          compactAtContextPercent: 50,
          compactAtContextWindow: 272_000,
          forceYaOrchestratedCompaction: false,
        },
      );

      expect(result).toMatchObject({ success: true, restarted: true });
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(startSession.mock.calls[0]?.[0].compactAtContextTokenLimit).toBe(
        68_000,
      );
      expect(startSession.mock.calls[1]?.[0].compactAtContextTokenLimit).toBe(
        136_000,
      );

      if (result.success) {
        await supervisorWithProvider.abortProcess(result.process.id);
      }
    });

    it("restarts Claude to apply a changed launch compact percentage", async () => {
      const controllers: ReturnType<typeof createControllableIterator>[] = [];
      const startSession = vi.fn(
        async (_options: Parameters<AgentProvider["startSession"]>[0]) => {
          const controller = createControllableIterator();
          controllers.push(controller);
          return {
            iterator: controller.iterator,
            queue: new MessageQueue(),
            abort: () => controller.finish(),
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: true,
        supportsLaunchCompactPercentOverride: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      let steerBackgroundPolicy = {
        allowRegex: ".*",
        denyRegex: ".*exclusive.*",
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        getClaudeSteerBackgroundBashSettings: () => steerBackgroundPolicy,
      });

      const started = await supervisorWithProvider.resumeSession(
        "claude-compact-override-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        { claudeAutoCompactPercentOverride: 60 },
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      controllers[0]?.push({
        type: "system",
        subtype: "init",
        session_id: "claude-compact-override-session",
      });
      controllers[0]?.push({
        type: "result",
        session_id: "claude-compact-override-session",
      });
      await waitFor(() => expect(started.state.type).toBe("idle"));
      steerBackgroundPolicy = {
        allowRegex: ".*agentctl watch.*",
        denyRegex: "",
      };

      const result = await supervisorWithProvider.queueMessageToSession(
        "claude-compact-override-session",
        "/tmp/test",
        { text: "second" },
        undefined,
        { claudeAutoCompactPercentOverride: 50 },
      );

      expect(result).toMatchObject({ success: true, restarted: true });
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(startSession.mock.calls[0]?.[0].launchCompactPercentOverride).toBe(
        60,
      );
      expect(startSession.mock.calls[1]?.[0].launchCompactPercentOverride).toBe(
        50,
      );
      expect(startSession.mock.calls[0]?.[0].claudeSteerBackgroundBash).toEqual(
        {
          allowRegex: ".*",
          denyRegex: ".*exclusive.*",
        },
      );
      expect(startSession.mock.calls[1]?.[0].claudeSteerBackgroundBash).toEqual(
        {
          allowRegex: ".*agentctl watch.*",
          denyRegex: "",
        },
      );

      if (result.success) {
        await supervisorWithProvider.abortProcess(result.process.id);
      }
    });

    it("starts forced Codex compaction at the assistant idle boundary", async () => {
      const delivered: string[] = [];
      const runProviderCommand = vi.fn();
      let compactCompleted = false;
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "compact-force-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) return;
              const content = sdkMessage.message.content;
              const text =
                typeof content === "string"
                  ? content
                  : ((content[0] as { text?: string } | undefined)?.text ?? "");
              if (text === "__compact__") {
                yield {
                  type: "system" as const,
                  subtype: "compact_boundary" as const,
                  session_id:
                    options.resumeSessionId ?? "compact-force-session",
                };
                yield {
                  type: "result" as const,
                  session_id:
                    options.resumeSessionId ?? "compact-force-session",
                };
                compactCompleted = true;
                continue;
              }
              delivered.push(text);
              yield {
                type: "assistant" as const,
                message: { content: `reply to ${text}` },
              };
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "compact-force-session",
              };
            }
          }

          runProviderCommand.mockImplementation(async (command: string) => {
            if (command !== "compact") return { handled: false };
            queue.push({ text: "__compact__" });
            return { handled: true };
          });
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [
              { name: "compact", description: "Compact conversation" },
            ],
            runProviderCommand,
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: true,
        supportsNativeCompactThreshold: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const onSessionSummary = vi.fn(
        async () =>
          ({
            contextUsage: { inputTokens: 150_000, percentage: 75 },
          }) as SessionSummary,
      );
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        onSessionSummary,
      });
      const compactSettings = {
        model: "gpt-5.6",
        compactAtContextPercent: 50,
        compactAtContextWindow: 200_000,
        forceYaOrchestratedCompaction: true,
      };

      const started = await supervisorWithProvider.resumeSession(
        "compact-force-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        compactSettings,
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      await vi.waitFor(() => {
        expect(delivered).toEqual(["first"]);
        expect(runProviderCommand).toHaveBeenCalledWith("compact", undefined);
        expect(compactCompleted).toBe(true);
        expect(started.state.type).toBe("idle");
      });

      expect(startSession.mock.calls[0]?.[0]).not.toHaveProperty(
        "compactAtContextTokenLimit",
      );
      expect(runProviderCommand).toHaveBeenCalledTimes(1);
      expect(onSessionSummary).toHaveBeenCalledWith(
        "compact-force-session",
        expect.any(String),
        { contextUsageMode: "manual-compaction" },
      );
      await supervisorWithProvider.abortProcess(started.id);
    });

    it("lets newly arrived input beat speculative idle compaction", async () => {
      const delivered: string[] = [];
      const runProviderCommand = vi.fn(async (command: string) =>
        command === "compact"
          ? { handled: true, error: "compaction should not start" }
          : { handled: false },
      );
      let resolveSummary!: (summary: SessionSummary) => void;
      const summary = new Promise<SessionSummary>((resolve) => {
        resolveSummary = resolve;
      });
      let resolveCommands!: (
        commands: Array<{ name: string; description: string }>,
      ) => void;
      const commands = new Promise<
        Array<{ name: string; description: string }>
      >((resolve) => {
        resolveCommands = resolve;
      });
      const supportedCommands = vi.fn(async () => commands);
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "input-wins-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) return;
              const content = sdkMessage.message.content;
              const text =
                typeof content === "string"
                  ? content
                  : ((content[0] as { text?: string } | undefined)?.text ?? "");
              delivered.push(text);
              yield {
                type: "assistant" as const,
                message: { content: `reply to ${text}` },
              };
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "input-wins-session",
              };
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands,
            runProviderCommand,
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: true,
        supportsNativeCompactThreshold: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const onSessionSummary = vi.fn(async () => summary);
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        onSessionSummary,
      });
      const compactSettings = {
        model: "gpt-5.6",
        compactAtContextPercent: 50,
        compactAtContextWindow: 200_000,
        forceYaOrchestratedCompaction: true,
      };

      const started = await supervisorWithProvider.resumeSession(
        "input-wins-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        compactSettings,
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      await vi.waitFor(() => {
        expect(delivered).toEqual(["first"]);
        expect(onSessionSummary).toHaveBeenCalledTimes(1);
      });

      const queued = supervisorWithProvider.queueMessageToSession(
        "input-wins-session",
        "/tmp/test",
        { text: "/help" },
        undefined,
        compactSettings,
      );
      await vi.waitFor(() => {
        expect(supportedCommands).toHaveBeenCalledTimes(1);
      });

      resolveSummary({
        contextUsage: { inputTokens: 150_000, percentage: 75 },
      } as SessionSummary);
      await Promise.resolve();
      expect(runProviderCommand).not.toHaveBeenCalled();

      resolveCommands([
        { name: "compact", description: "Compact conversation" },
      ]);
      expect(await queued).toMatchObject({ success: true, restarted: false });
      await vi.waitFor(() => {
        expect(delivered).toEqual(["first", "/help"]);
      });
      expect(runProviderCommand.mock.calls).toEqual([["help", ""]]);
      await supervisorWithProvider.abortProcess(started.id);
    });

    it("lets input beat speculative compaction across a dynamic effort update", async () => {
      const delivered: string[] = [];
      const runProviderCommand = vi.fn(async () => ({
        handled: true,
        error: "compaction should not start",
      }));
      let resolveSummary!: (summary: SessionSummary) => void;
      const summary = new Promise<SessionSummary>((resolve) => {
        resolveSummary = resolve;
      });
      // The compact command resolves immediately, so a would-be speculative
      // compaction reaches runProviderCommand within the effort window — that
      // is what a missing ingress note would let it do.
      const supportedCommands = vi.fn(async () => [
        { name: "compact", description: "Compact conversation" },
      ]);
      // A deferred effort update: queueMessageToSession awaits this before it
      // reaches queueProcessMessage, which is exactly the window the accepted
      // turn's intent must already cover.
      let resolveSetEffort!: () => void;
      const setEffort = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSetEffort = resolve;
          }),
      );
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "effort-race-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) return;
              const content = sdkMessage.message.content;
              const text =
                typeof content === "string"
                  ? content
                  : ((content[0] as { text?: string } | undefined)?.text ?? "");
              delivered.push(text);
              yield {
                type: "assistant" as const,
                message: { content: `reply to ${text}` },
              };
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "effort-race-session",
              };
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands,
            runProviderCommand,
            setEffort,
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: true,
        supportsNativeCompactThreshold: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const onSessionSummary = vi.fn(async () => summary);
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100_000,
        onSessionSummary,
      });
      const compactSettings = {
        model: "gpt-5.6",
        compactAtContextPercent: 50,
        compactAtContextWindow: 200_000,
        forceYaOrchestratedCompaction: true,
      };

      const started = await supervisorWithProvider.resumeSession(
        "effort-race-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        { ...compactSettings, effort: "low" },
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      // Speculative idle compaction is now parked on the deferred summary read.
      await vi.waitFor(() => {
        expect(delivered).toEqual(["first"]);
        expect(onSessionSummary).toHaveBeenCalledTimes(1);
      });

      const queued = supervisorWithProvider.queueMessageToSession(
        "effort-race-session",
        "/tmp/test",
        { text: "second" },
        undefined,
        { ...compactSettings, effort: "high" },
      );
      // The queue is now awaiting the dynamic effort change, before it would
      // otherwise record delivery intent.
      await vi.waitFor(() => {
        expect(setEffort).toHaveBeenCalledTimes(1);
      });

      // The parked speculative read now completes above the threshold while the
      // effort update is still applying and the process still reports idle.
      // Because intent was recorded at the ingress boundary (not later, in
      // queueProcessMessage), the compaction check must observe the accepted
      // turn and yield. Without the ingress note it would instead run
      // runProviderCommand here, ahead of the turn.
      resolveSummary({
        contextUsage: { inputTokens: 150_000, percentage: 75 },
      } as SessionSummary);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runProviderCommand).not.toHaveBeenCalled();

      // Let the effort change finish so the accepted turn is queued. The
      // speculative compaction never started for it.
      resolveSetEffort();
      expect(await queued).toMatchObject({ success: true, restarted: false });
      expect(setEffort).toHaveBeenCalledWith("high");
      await supervisorWithProvider.abortProcess(started.id);
    });

    it.each([false, true])(
      "accepts next-turn effort with active control %s",
      async (effortUpdatesActiveTurn) => {
        let aborted = false;
        let completeTurn = () => {};
        const turnCompleted = new Promise<void>((resolve) => {
          completeTurn = resolve;
        });
        const setEffort = vi.fn(async () => {});
        if (effortUpdatesActiveTurn) {
          setEffort.mockRejectedValueOnce(new Error("live update rejected"));
        }
        const startSession = vi.fn(
          async (options: Parameters<AgentProvider["startSession"]>[0]) => {
            const queue = new MessageQueue();

            async function* iterator() {
              yield {
                type: "system" as const,
                subtype: "init" as const,
                session_id: options.resumeSessionId ?? "effort-session",
              };
              await turnCompleted;
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "effort-session",
              };
              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                completeTurn();
              },
              setEffort,
              effortUpdatesActiveTurn,
            };
          },
        );
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession,
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 100,
        });

        const process = await supervisorWithProvider.resumeSession(
          "effort-session",
          "/tmp/test",
          { text: "first" },
          undefined,
          {
            thinking: { type: "adaptive", display: "summarized" },
            effort: "low",
          },
        );
        await vi.waitFor(() => {
          expect(process.state.type).toBe("in-turn");
        });

        try {
          await expect(
            supervisorWithProvider.reconfigureProcess(process.id, {
              thinking: { type: "adaptive", display: "summarized" },
              effort: "medium",
            }),
          ).resolves.toBe(process);
          expect(startSession).toHaveBeenCalledTimes(1);
          expect(aborted).toBe(false);
          expect(process.effort).toBe("medium");
          expect(process.appliedEffort).toBe("low");
          expect(process.getInfo().effort).toBe("medium");
          expect(setEffort).toHaveBeenCalledTimes(
            effortUpdatesActiveTurn ? 1 : 0,
          );

          completeTurn();
          await vi.waitFor(() => {
            expect(process.state.type).toBe("idle");
          });
          expect(setEffort).toHaveBeenCalledWith("medium");
          expect(process.appliedEffort).toBe("medium");
        } finally {
          await supervisorWithProvider.abortProcess(process.id);
        }
      },
    );

    it("serializes idle effort changes so the latest selection wins", async () => {
      let aborted = false;
      let releaseMedium = () => {};
      const mediumGate = new Promise<void>((resolve) => {
        releaseMedium = resolve;
      });
      const setEffort = vi.fn(async (effort?: string) => {
        if (effort === "medium") {
          await mediumGate;
        }
      });
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "effort-race-session",
            };
            yield {
              type: "result" as const,
              session_id: options.resumeSessionId ?? "effort-race-session",
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
              releaseMedium();
            },
            setEffort,
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });
      const process = await supervisorWithProvider.resumeSession(
        "effort-race-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        { thinking: { type: "adaptive" }, effort: "low" },
      );
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));

      const mediumUpdate = supervisorWithProvider.reconfigureProcess(
        process.id,
        { thinking: { type: "adaptive" }, effort: "medium" },
      );
      await vi.waitFor(() => expect(setEffort).toHaveBeenCalledWith("medium"));
      const highUpdate = supervisorWithProvider.reconfigureProcess(process.id, {
        thinking: { type: "adaptive" },
        effort: "high",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseMedium();

      try {
        await Promise.all([mediumUpdate, highUpdate]);
        expect(process.effort).toBe("high");
      } finally {
        await supervisorWithProvider.abortProcess(process.id);
      }
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

    it("runs Claude compact-first resume before the user turn", async () => {
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };

            for await (const sdkMessage of queue) {
              if (aborted) {
                return;
              }
              const content = sdkMessage.message.content;
              const text =
                typeof content === "string"
                  ? content
                  : ((content[0] as { text?: string } | undefined)?.text ?? "");
              delivered.push(text);

              if (text === "/compact") {
                yield {
                  type: "system",
                  subtype: "status",
                  status: "compacting",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                yield {
                  type: "system",
                  subtype: "status",
                  status: null,
                  compact_result: "success",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                yield {
                  type: "system",
                  subtype: "compact_boundary",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                continue;
              }

              yield {
                type: "result",
                session_id: options.resumeSessionId ?? "new-session",
              };
              return;
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [
              { name: "compact", description: "Compact conversation" },
            ],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithProvider.resumeSession(
        "claude-old",
        "/tmp/test",
        { text: "continue" },
        undefined,
        { providerName: "claude", resumeMode: "compact-first" },
      );

      if (!("id" in process)) {
        throw new Error("expected process");
      }
      expect(process.sessionId).toBe("claude-old");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: "claude-old" }),
      );
      expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
      await vi.waitFor(() => {
        expect(delivered).toEqual(["/compact", "continue"]);
      });
    });

    it("reports compact-first resume as unavailable without /compact", async () => {
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) {
                return;
              }
              const content = sdkMessage.message.content;
              delivered.push(typeof content === "string" ? content : "");
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      await expect(
        supervisorWithProvider.resumeSession(
          "claude-old",
          "/tmp/test",
          { text: "continue" },
          undefined,
          { providerName: "claude", resumeMode: "compact-first" },
        ),
      ).rejects.toMatchObject({
        name: "ResumeCompactionError",
        recovery: "full-resume",
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      } satisfies Partial<ResumeCompactionError>);
      expect(delivered).toEqual([]);
      expect(
        supervisorWithProvider.getProcessForSession("claude-old"),
      ).toBeUndefined();
    });
  });

  describe("reactivateSession", () => {
    it("retains managed placement across queueing, shutdown, and resume", async () => {
      let generation = 0;
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          generation += 1;
          const runnerGeneration = `runner-${generation}`;
          const queue = new MessageQueue();
          let alive = true;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "managed-native-session",
            };
            for await (const message of queue) {
              if (!alive) return;
              const text =
                typeof message.message.content === "string"
                  ? message.message.content
                  : "non-text provider message";
              delivered.push(text);
              yield {
                type: "assistant" as const,
                message: { content: `reply to ${text}` },
              };
              yield {
                type: "result" as const,
                session_id: options.resumeSessionId ?? "managed-native-session",
              };
            }
          }
          return {
            iterator: iterator(),
            queue,
            execution: {
              kind: "managed-ssh" as const,
              targetId: "linux-testbed",
              workspaceId: "managed-workspace",
              runnerGeneration,
            },
            abort: () => {
              alive = false;
              queue.push({ text: "__abort__" });
            },
            isProcessAlive: () => alive,
          };
        },
      );
      const providerSupervisor = new Supervisor({
        provider: testProvider(startSession),
        idleTimeoutMs: 60000,
      });

      const first = await providerSupervisor.reactivateSession(
        "/tmp/managed-workspace",
        "managed-native-session",
        undefined,
        { providerName: "claude" },
      );

      expect(first.execution).toEqual({
        kind: "managed-ssh",
        targetId: "linux-testbed",
        workspaceId: "managed-workspace",
        runnerGeneration: "runner-1",
      });
      expect(first.executor).toBeUndefined();
      expect(first.queueMessage({ text: "managed queue turn" })).toEqual(
        expect.objectContaining({ success: true }),
      );
      await waitFor(() => {
        expect(delivered).toContain("managed queue turn");
        expect(first.state.type).toBe("idle");
      });
      await expect(
        providerSupervisor.abortProcessWithVerification(first.id),
      ).resolves.toMatchObject({
        processId: first.id,
        verifiedStopped: true,
        verification: "provider",
      });

      const resumed = await providerSupervisor.reactivateSession(
        "/tmp/managed-workspace",
        "managed-native-session",
        undefined,
        { providerName: "claude" },
      );

      expect(resumed.sessionId).toBe("managed-native-session");
      expect(resumed.execution).toEqual({
        kind: "managed-ssh",
        targetId: "linux-testbed",
        workspaceId: "managed-workspace",
        runnerGeneration: "runner-2",
      });
      await expect(
        providerSupervisor.abortProcessWithVerification(resumed.id),
      ).resolves.toMatchObject({ verifiedStopped: true });
      expect(startSession).toHaveBeenCalledTimes(2);
    });

    it("spawns a live owned process for an existing session with no user turn", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) return;
              void sdkMessage; // idle until a message is pushed
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisor = new Supervisor({ provider, idleTimeoutMs: 60000 });

      const process = await supervisor.reactivateSession(
        "/tmp/test",
        "claude-old",
        undefined,
        { providerName: "claude" },
      );

      // Resumed the existing session with no synthetic user turn.
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: "claude-old" }),
      );
      expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
      // Now owned by this live process.
      expect(supervisor.getProcessForSession("claude-old")).toBe(process);
      expect(process.state.type).toBe("idle");
      expect(process.getLivenessSnapshot().derivedStatus).toBe("verified-idle");

      // Idempotent: a second call returns the existing process, no re-spawn.
      const again = await supervisor.reactivateSession(
        "/tmp/test",
        "claude-old",
        undefined,
        { providerName: "claude" },
      );
      expect(again).toBe(process);
      expect(startSession).toHaveBeenCalledTimes(1);

      const queued = process.queueMessage({ text: "first real turn" });
      expect(queued.success).toBe(true);
      expect(process.state.type).toBe("in-turn");

      await expect(supervisor.abortProcess(process.id)).resolves.toBe(true);
    });

    it.each(["default", "plan", "bypassPermissions"] as const)(
      "restores %s and model settings after the owned process dies",
      async (permissionMode) => {
        const startSession = vi.fn(
          async (options: Parameters<AgentProvider["startSession"]>[0]) => {
            const queue = new MessageQueue();
            let aborted = false;
            async function* iterator() {
              yield {
                type: "system" as const,
                subtype: "init" as const,
                session_id: options.resumeSessionId ?? "new-session",
              };
              for await (const message of queue) {
                if (aborted) return;
                void message;
              }
            }
            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                queue.push({ text: "__abort__" });
              },
            };
          },
        );
        const provider = testProvider(startSession);
        const metadata = createLaunchSettingsMetadata();
        const supervisorWithMetadata = new Supervisor({
          provider,
          idleTimeoutMs: 60_000,
          sessionMetadataService: metadata.service,
        });

        const first = await supervisorWithMetadata.reactivateSession(
          "/tmp/test",
          "durable-session",
          permissionMode,
          {
            providerName: "claude",
            model: "opus",
            requestedModel: "opus",
            serviceTier: "priority",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          },
        );
        expect(metadata.current()?.revision).toBe(1);
        await expect(
          supervisorWithMetadata.abortProcess(first.id),
        ).resolves.toBe(true);

        const restored = await supervisorWithMetadata.reactivateSession(
          "/tmp/test",
          "durable-session",
          undefined,
          { providerName: "claude" },
        );

        expect(startSession.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            resumeSessionId: "durable-session",
            permissionMode,
            model: "opus",
            serviceTier: "priority",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          }),
        );
        expect(restored.permissionMode).toBe(permissionMode);
        expect(restored.requestedModel).toBe("opus");
        expect(restored.thinking).toEqual({
          type: "adaptive",
          display: "summarized",
        });
        expect(restored.effort).toBe("high");
        // Reattaching an identical effective snapshot is not a metadata write.
        expect(metadata.current()?.revision).toBe(1);

        await expect(
          supervisorWithMetadata.abortProcess(restored.id),
        ).resolves.toBe(true);
      },
    );

    it("lets an explicit cold override replace the durable snapshot", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      const provider = testProvider(startSession);
      const metadata = createLaunchSettingsMetadata({
        schemaVersion: 1,
        revision: 4,
        permissionMode: "plan",
        requestedModel: "opus",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "high",
      });
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
      });

      const process = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "override-session",
        "bypassPermissions",
        {
          providerName: "claude",
          requestedModel: "default",
          thinking: { type: "disabled" },
        },
      );

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "bypassPermissions",
          model: undefined,
          serviceTier: "priority",
          thinking: { type: "disabled" },
          effort: undefined,
        }),
      );
      expect(metadata.current()).toEqual({
        schemaVersion: 1,
        revision: 5,
        permissionMode: "bypassPermissions",
        requestedModel: "default",
        serviceTier: "priority",
        thinking: { type: "disabled" },
        effort: null,
      });
      await expect(
        supervisorWithMetadata.abortProcess(process.id),
      ).resolves.toBe(true);
    });

    it("persists recovered settings after a successful cold launch", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      const provider = {
        ...testProvider(startSession),
        name: "codex" as const,
        displayName: "Codex",
      };
      const metadata = createLaunchSettingsMetadata();
      const recoverSessionLaunchSettings = vi.fn(async () => ({
        permissionMode: "bypassPermissions" as const,
        requestedModel: "gpt-5.6-sol",
        thinking: {
          type: "adaptive" as const,
          display: "summarized" as const,
        },
        effort: "xhigh" as const,
      }));
      const supervisorWithMetadata = new Supervisor({
        provider,
        idleTimeoutMs: 60_000,
        sessionMetadataService: metadata.service,
        recoverSessionLaunchSettings,
      });

      const first = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "recovered-session",
        undefined,
        { providerName: "codex" },
      );

      expect(recoverSessionLaunchSettings).toHaveBeenCalledWith(
        "recovered-session",
        encodeProjectId("/tmp/test"),
        "codex",
      );
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "recovered-session",
          permissionMode: "bypassPermissions",
          model: "gpt-5.6-sol",
          thinking: { type: "adaptive", display: "summarized" },
          effort: "xhigh",
        }),
      );
      expect(metadata.current()).toEqual({
        schemaVersion: 1,
        revision: 1,
        permissionMode: "bypassPermissions",
        requestedModel: "gpt-5.6-sol",
        serviceTier: null,
        thinking: { type: "adaptive", display: "summarized" },
        effort: "xhigh",
      });

      await expect(supervisorWithMetadata.abortProcess(first.id)).resolves.toBe(
        true,
      );
      const second = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "recovered-session",
        undefined,
        { providerName: "codex" },
      );
      expect(recoverSessionLaunchSettings).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledTimes(2);
      await expect(
        supervisorWithMetadata.abortProcess(second.id),
      ).resolves.toBe(true);
    });

    it("treats a complete durable snapshot as authoritative", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      const provider = {
        ...testProvider(startSession),
        name: "codex" as const,
        displayName: "Codex",
      };
      const metadata = createLaunchSettingsMetadata({
        schemaVersion: 1,
        revision: 3,
        permissionMode: "plan",
        requestedModel: null,
        serviceTier: null,
        thinking: null,
        effort: null,
      });
      const recoverSessionLaunchSettings = vi.fn(async () => ({
        permissionMode: "bypassPermissions" as const,
        requestedModel: "gpt-5.6-sol",
        thinking: { type: "adaptive" as const },
        effort: "xhigh" as const,
      }));
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
        recoverSessionLaunchSettings,
      });

      const process = await supervisorWithMetadata.reactivateSession(
        "/tmp/test",
        "durable-default-session",
        undefined,
        { providerName: "codex" },
      );

      expect(recoverSessionLaunchSettings).not.toHaveBeenCalled();
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "plan",
          model: undefined,
          thinking: undefined,
          effort: undefined,
        }),
      );
      expect(metadata.current()?.revision).toBe(3);
      await expect(
        supervisorWithMetadata.abortProcess(process.id),
      ).resolves.toBe(true);
    });

    it("lets explicit cold settings override transcript recovery", async () => {
      const startSession = vi.fn(async () => {
        throw new Error("stop after resolution");
      });
      const provider = {
        ...testProvider(startSession),
        name: "codex" as const,
        displayName: "Codex",
      };
      const metadata = createLaunchSettingsMetadata();
      const recoverSessionLaunchSettings = vi.fn(async () => ({
        permissionMode: "bypassPermissions" as const,
        requestedModel: "recovered-model",
        thinking: { type: "adaptive" as const },
        effort: "xhigh" as const,
      }));
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
        recoverSessionLaunchSettings,
      });

      await expect(
        supervisorWithMetadata.reactivateSession(
          "/tmp/test",
          "explicit-recovery-session",
          "default",
          {
            providerName: "codex",
            requestedModel: "explicit-model",
            thinking: { type: "disabled" },
          },
        ),
      ).rejects.toThrow("stop after resolution");

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "default",
          model: "explicit-model",
          thinking: { type: "disabled" },
          effort: undefined,
        }),
      );
      expect(recoverSessionLaunchSettings).not.toHaveBeenCalled();
      expect(metadata.current()).toBeUndefined();
    });

    it("keeps YA model metadata and does not save failed recovered launches", async () => {
      const legacy = createLaunchSettingsMetadata(undefined, "sonnet");
      const startSession = vi.fn(async () => {
        throw new Error("provider rejected launch");
      });
      const provider = testProvider(startSession);
      const recoverSessionLaunchSettings = vi.fn(async () => ({
        permissionMode: "bypassPermissions" as const,
        requestedModel: "gpt-5.6-sol",
        thinking: { type: "adaptive" as const },
        effort: "xhigh" as const,
      }));
      const supervisorWithMetadata = new Supervisor({
        provider,
        sessionMetadataService: legacy.service,
        defaultPermissionMode: "default",
        recoverSessionLaunchSettings,
      });

      await expect(
        supervisorWithMetadata.reactivateSession("/tmp/test", "legacy-session"),
      ).rejects.toThrow("provider rejected launch");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "bypassPermissions",
          model: "sonnet",
          thinking: { type: "adaptive" },
          effort: "xhigh",
        }),
      );
      expect(recoverSessionLaunchSettings).toHaveBeenCalledOnce();
      expect(legacy.current()).toBeUndefined();
    });

    it("falls back conservatively when transcript recovery fails", async () => {
      const legacy = createLaunchSettingsMetadata(undefined, "sonnet");
      const startSession = vi.fn(async () => {
        throw new Error("provider rejected launch");
      });
      const recoverSessionLaunchSettings = vi.fn(async () => {
        throw new Error("transcript unavailable");
      });
      const supervisorWithMetadata = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: legacy.service,
        defaultPermissionMode: "default",
        recoverSessionLaunchSettings,
      });

      await expect(
        supervisorWithMetadata.reactivateSession(
          "/tmp/test",
          "unreadable-legacy-session",
        ),
      ).rejects.toThrow("provider rejected launch");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "default",
          model: "sonnet",
          thinking: undefined,
          effort: undefined,
        }),
      );
      expect(legacy.current()).toBeUndefined();
    });

    it("reaps a message-less reactivation that receives no turn", async () => {
      vi.useFakeTimers();
      let aborted = false;

      try {
        const startSession = vi.fn(
          async (options: Parameters<AgentProvider["startSession"]>[0]) => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system" as const,
                subtype: "init" as const,
                session_id: options.resumeSessionId ?? "new-session",
              };
              for await (const sdkMessage of queue) {
                if (aborted) return;
                void sdkMessage;
              }
            }
            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                queue.push({ text: "__abort__" });
              },
              isProcessAlive: () => !aborted,
            };
          },
        );
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: false,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession,
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 100,
        });

        const process = await supervisorWithProvider.reactivateSession(
          "/tmp/test",
          "claude-reap",
          undefined,
          { providerName: "claude" },
        );

        expect(process.state.type).toBe("idle");
        await vi.advanceTimersByTimeAsync(150);

        expect(
          supervisorWithProvider.getProcessForSession("claude-reap"),
        ).toBeUndefined();
        expect(aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("promotes recovered patient work after message-less reactivation", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-31T10:11:23.000Z"));
      const delivered: string[] = [];
      let aborted = false;

      try {
        const startSession = vi.fn(
          async (options: Parameters<AgentProvider["startSession"]>[0]) => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system" as const,
                subtype: "init" as const,
                session_id: options.resumeSessionId ?? "new-session",
              };
              for await (const sdkMessage of queue) {
                if (aborted) return;
                const content = sdkMessage.message.content;
                delivered.push(typeof content === "string" ? content : "");
                yield {
                  type: "result" as const,
                  session_id: options.resumeSessionId ?? "new-session",
                };
              }
            }
            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                queue.push({ text: "__abort__" });
              },
              isProcessAlive: () => !aborted,
            };
          },
        );
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: false,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession,
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 60_000,
        });

        const process = await supervisorWithProvider.reactivateSession(
          "/tmp/test",
          "claude-patient-recovery",
          undefined,
          { providerName: "claude" },
        );
        expect(process.state.type).toBe("idle");

        const deferred = process.deferMessage(
          {
            text: "recovered patient turn",
            tempId: "temp-recovered-patient",
            metadata: {
              deliveryIntent: "patient",
              patienceSeconds: 2,
            },
          },
          {
            promoteIfReady: true,
            persistedQueueId: "persisted-patient-row",
          },
        );
        expect(deferred).toMatchObject({ success: true, deferred: true });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(delivered).toEqual([]);
        expect(process.getDeferredQueueSummary()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1_500);
        expect(delivered).toEqual(["recovered patient turn"]);
        expect(process.getDeferredQueueSummary()).toEqual([]);

        await expect(
          supervisorWithProvider.abortProcess(process.id),
        ).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("queues a concurrent resume through an in-flight reactivation", async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          await startGate;
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) {
                return;
              }
              const content = sdkMessage.message.content;
              delivered.push(typeof content === "string" ? content : "");
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisor = new Supervisor({ provider, idleTimeoutMs: 60000 });

      const reactivation = supervisor.reactivateSession(
        "/tmp/test",
        "codex-old",
        undefined,
        { providerName: "codex" },
      );
      await vi.waitFor(() => {
        expect(startSession).toHaveBeenCalledTimes(1);
      });

      const resumed = supervisor.resumeSession("codex-old", "/tmp/test", {
        text: "next turn",
      });
      releaseStart();

      const process = await reactivation;
      await expect(resumed).resolves.toBe(process);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(supervisor.getProcessForSession("codex-old")).toBe(process);
      await vi.waitFor(() => {
        expect(delivered).toEqual(["next turn"]);
      });

      await supervisor.abortProcess(process.id);
    });

    it("applies a later override after an in-flight activation settles", async () => {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const setModel = vi.fn(async () => undefined);
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          await startGate;
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            setModel,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      const metadata = createLaunchSettingsMetadata();
      const serialized = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: metadata.service,
        idleTimeoutMs: 60_000,
      });

      const first = serialized.reactivateSession(
        "/tmp/test",
        "serialized-reactivation",
        "default",
        {
          providerName: "claude",
          model: "sonnet",
          requestedModel: "sonnet",
        },
      );
      await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
      const second = serialized.reactivateSession(
        "/tmp/test",
        "serialized-reactivation",
        "plan",
        {
          providerName: "claude",
          model: "opus",
          requestedModel: "opus",
          recapAfterSeconds: 45,
        },
        {
          requestedOverrides: {
            permissionMode: "plan",
            modelSettings: {
              model: "opus",
              requestedModel: "opus",
              providerName: "claude",
              executor: undefined,
              recapMode: "fork",
              recapAfterSeconds: 45,
              promptSuggestionMode: "off",
              sandboxLevel: "none",
            },
          },
        },
      );
      releaseStart();

      const [activated, reconciled] = await Promise.all([first, second]);
      expect(reconciled).toBe(activated);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(setModel).toHaveBeenCalledWith("opus");
      expect(reconciled.permissionMode).toBe("plan");
      expect(reconciled.recapMode).toBe("fork");
      expect(reconciled.recapAfterSeconds).toBe(45);
      expect(reconciled.promptSuggestionMode).toBe("off");
      expect(metadata.current()).toMatchObject({
        revision: 2,
        permissionMode: "plan",
        requestedModel: "opus",
      });
      expect(metadata.writes.setProvider).toHaveBeenLastCalledWith(
        "serialized-reactivation",
        "claude",
      );
      expect(metadata.writes.setExecutor).toHaveBeenCalledWith(
        "serialized-reactivation",
        undefined,
      );
      expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
        "serialized-reactivation",
        {
          recapMode: "fork",
          recapAfterSeconds: 45,
          promptSuggestionMode: "off",
        },
      );
      expect(metadata.writes.setSessionSandbox).toHaveBeenCalledWith(
        "serialized-reactivation",
        expect.objectContaining({
          level: "none",
          projectPath: "/tmp/test",
          provider: "claude",
        }),
      );
      expect(metadata.writes.flushPendingWrites).toHaveBeenCalled();

      const clearOverrides = () =>
        serialized.reactivateSession(
          "/tmp/test",
          "serialized-reactivation",
          undefined,
          { providerName: "claude" },
          {
            requestedOverrides: {
              modelSettings: {
                recapMode: undefined,
                recapAfterSeconds: undefined,
                promptSuggestionMode: undefined,
              },
            },
          },
        );
      metadata.writes.flushPendingWrites.mockRejectedValueOnce(
        new Error("metadata unavailable"),
      );
      await expect(clearOverrides()).rejects.toThrow("metadata unavailable");
      expect(reconciled.recapMode).toBe("off");
      expect(setModel).toHaveBeenCalledTimes(1);

      const cleared = await clearOverrides();
      expect(cleared).toBe(reconciled);
      expect(cleared.recapMode).toBe("off");
      expect(cleared.recapAfterSeconds).toBe(DEFAULT_RECAP_AFTER_SECONDS);
      expect(cleared.promptSuggestionMode).toBe("off");
      expect(metadata.writes.updateMetadata).toHaveBeenLastCalledWith(
        "serialized-reactivation",
        {
          recapMode: "off",
          recapAfterSeconds: DEFAULT_RECAP_AFTER_SECONDS,
          promptSuggestionMode: "off",
        },
      );

      await serialized.abortProcess(reconciled.id);
    });

    it("serializes distinct reactivation overrides in request order", async () => {
      let releaseOpus!: () => void;
      const opusGate = new Promise<void>((resolve) => {
        releaseOpus = resolve;
      });
      let releasePersistence!: () => void;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const setModel = vi.fn(async (model?: string) => {
        if (model === "opus") {
          await opusGate;
        }
      });
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            setModel,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      const metadata = createLaunchSettingsMetadata();
      let pendingRecapAfterSeconds: number | null | undefined;
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          pendingRecapAfterSeconds = updates.recapAfterSeconds;
        },
      );
      metadata.writes.flushPendingWrites.mockImplementation(async () => {
        if (pendingRecapAfterSeconds === 10) {
          await persistenceGate;
        }
      });
      const serialized = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: metadata.service,
        idleTimeoutMs: 60_000,
      });
      const process = await serialized.reactivateSession(
        "/tmp/test",
        "ordered-reactivation",
        undefined,
        {
          providerName: "claude",
          model: "sonnet",
          requestedModel: "sonnet",
        },
      );
      metadata.writes.updateMetadata.mockClear();
      metadata.writes.flushPendingWrites.mockClear();

      const opus = serialized.reactivateSession(
        "/tmp/test",
        "ordered-reactivation",
        undefined,
        {
          providerName: "claude",
          model: "opus",
          requestedModel: "opus",
          recapAfterSeconds: 10,
        },
        {
          requestedOverrides: {
            modelSettings: {
              model: "opus",
              requestedModel: "opus",
              recapAfterSeconds: 10,
            },
          },
        },
      );
      await vi.waitFor(() => expect(setModel).toHaveBeenCalledWith("opus"));
      const haiku = serialized.reactivateSession(
        "/tmp/test",
        "ordered-reactivation",
        undefined,
        {
          providerName: "claude",
          model: "haiku",
          requestedModel: "haiku",
          recapAfterSeconds: 20,
        },
        {
          requestedOverrides: {
            modelSettings: {
              model: "haiku",
              requestedModel: "haiku",
              recapAfterSeconds: 20,
            },
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(setModel).toHaveBeenCalledTimes(1);
      releaseOpus();
      await vi.waitFor(() =>
        expect(metadata.writes.flushPendingWrites).toHaveBeenCalledTimes(1),
      );
      expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
        "ordered-reactivation",
        { recapAfterSeconds: 10 },
      );
      expect(setModel).toHaveBeenCalledTimes(1);
      releasePersistence();

      await Promise.all([opus, haiku]);
      expect(setModel.mock.calls.map(([model]) => model)).toEqual([
        "opus",
        "haiku",
      ]);
      expect(
        metadata.writes.updateMetadata.mock.calls.map(
          ([, updates]) => updates.recapAfterSeconds,
        ),
      ).toEqual([10, 20]);
      expect(process.requestedModel).toBe("haiku");
      expect(process.recapAfterSeconds).toBe(20);

      await serialized.abortProcess(process.id);
    });

    it("applies supported active overrides and rejects restart requirements", async () => {
      const setModel = vi.fn(async () => undefined);
      let aborted = false;
      let activeQueue: MessageQueue | undefined;
      const abort = vi.fn(() => {
        aborted = true;
        activeQueue?.push({ text: "__abort__" });
      });
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          activeQueue = queue;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return { iterator: iterator(), queue, setModel, abort };
        },
      );
      const serialized = new Supervisor({
        provider: testProvider(startSession),
        idleTimeoutMs: 60_000,
      });
      const process = await serialized.reactivateSession(
        "/tmp/test",
        "active-reactivation",
        undefined,
        {
          providerName: "claude",
          model: "sonnet",
          requestedModel: "sonnet",
        },
      );
      expect(process.queueMessage({ text: "active turn" }).success).toBe(true);
      expect(process.state.type).toBe("in-turn");

      await expect(
        serialized.reactivateSession(
          "/tmp/test",
          "active-reactivation",
          undefined,
          { providerName: "claude", model: "opus", requestedModel: "opus" },
          {
            requestedOverrides: {
              modelSettings: { model: "opus", requestedModel: "opus" },
            },
          },
        ),
      ).resolves.toBe(process);
      expect(setModel).toHaveBeenCalledWith("opus");

      await expect(
        serialized.reactivateSession(
          "/tmp/test",
          "active-reactivation",
          undefined,
          { providerName: "claude", serviceTier: "priority" },
          {
            requestedOverrides: {
              modelSettings: { serviceTier: "priority" },
            },
          },
        ),
      ).rejects.toMatchObject({
        status: 409,
        changes: ["service tier"],
      });
      expect(abort).not.toHaveBeenCalled();
      expect(serialized.getProcessForSession("active-reactivation")).toBe(
        process,
      );

      await serialized.abortProcess(process.id);
    });

    it("reports persistence failure and later reconciles the applied state", async () => {
      const setModel = vi.fn(async () => undefined);
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const message of queue) {
              if (aborted) return;
              void message;
            }
          }
          return {
            iterator: iterator(),
            queue,
            setModel,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
          };
        },
      );
      let durable: EffectiveSessionLaunchSettings | undefined;
      let persistenceAvailable = true;
      const recordEffectiveLaunchSettings = vi.fn(
        async (
          _sessionId: string,
          value: EffectiveSessionLaunchSettingsValue,
        ) => {
          if (!persistenceAvailable) {
            throw new Error("metadata unavailable");
          }
          durable = {
            schemaVersion: 1,
            revision: (durable?.revision ?? 0) + 1,
            ...value,
          };
          return durable;
        },
      );
      const metadata = {
        getMetadata: () => undefined,
        getEffectiveLaunchSettings: () => durable,
        getRequestedModel: () => durable?.requestedModel ?? undefined,
        recordEffectiveLaunchSettings,
      } as unknown as SessionMetadataService;
      const serialized = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: metadata,
        idleTimeoutMs: 60_000,
      });
      const process = await serialized.reactivateSession(
        "/tmp/test",
        "durability-reactivation",
        undefined,
        {
          providerName: "claude",
          model: "sonnet",
          requestedModel: "sonnet",
        },
        { requestedOverrides: {} },
      );
      persistenceAvailable = false;

      await expect(
        serialized.reconfigureProcess(process.id, {
          model: "opus",
          requestedModel: "opus",
        }),
      ).rejects.toThrow("metadata unavailable");
      expect(process.requestedModel).toBe("opus");
      expect(durable?.requestedModel).toBe("sonnet");
      expect(setModel).toHaveBeenCalledTimes(1);

      persistenceAvailable = true;
      await expect(
        serialized.reconfigureProcess(process.id, {
          model: "opus",
          requestedModel: "opus",
        }),
      ).resolves.toBe(process);
      expect(durable?.requestedModel).toBe("opus");
      expect(setModel).toHaveBeenCalledTimes(1);
      expect(recordEffectiveLaunchSettings.mock.calls.length).toBeGreaterThan(
        2,
      );

      persistenceAvailable = false;
      await expect(
        serialized.reconfigureProcess(process.id, {
          model: "haiku",
          requestedModel: "haiku",
        }),
      ).rejects.toThrow("metadata unavailable");
      const callsAfterFailedSave =
        recordEffectiveLaunchSettings.mock.calls.length;

      await serialized.abortProcess(process.id);

      process.setPermissionMode("plan");
      await Promise.resolve();
      expect(recordEffectiveLaunchSettings).toHaveBeenCalledTimes(
        callsAfterFailedSave,
      );
    });

    it("refuses to preempt a live worker when preempt:false", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };
            yield {
              type: "result",
              session_id: options.resumeSessionId ?? "new-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      // Capacity 1, and idle workers preemptable immediately (threshold 0) so
      // the only thing stopping eviction is the preempt:false flag itself.
      const supervisor = new Supervisor({
        provider,
        idleTimeoutMs: 60000,
        maxWorkers: 1,
        idlePreemptThresholdMs: 0,
      });

      const first = await supervisor.reactivateSession(
        "/tmp/test",
        "session-a",
        undefined,
        { providerName: "claude" },
      );
      await vi.waitFor(() => expect(first.state.type).toBe("idle"));

      // A background recap revives with preempt:false: at capacity it must
      // refuse rather than evict the idle session-a.
      await expect(
        supervisor.reactivateSession(
          "/tmp/test",
          "session-b",
          undefined,
          { providerName: "claude" },
          { preempt: false },
        ),
      ).rejects.toThrow(/worker capacity/);
      expect(supervisor.getProcessForSession("session-a")).toBe(first);
      expect(first.isTerminated).toBe(false);

      await supervisor.abortProcess(first.id);
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

    it("passes the global Claude compaction override through the SDK wrapper", async () => {
      let aborted = false;
      const startSession = vi.fn<RealClaudeSDKInterface["startSession"]>(
        async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "real-sdk-compact-override",
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
      const supervisorWithRealSdk = new Supervisor({
        realSdk: { startSession },
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { claudeAutoCompactPercentOverride: 60 },
      );

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ launchCompactPercentOverride: 60 }),
      );
      expect(process.launchCompactPercentOverride).toBe(60);
      await supervisorWithRealSdk.abortProcess(process.id);
    });

    it("keeps one canonical row when the same session is restarted", async () => {
      mockSdk.addScenario(createMockScenario("sess-restarted", "First run"));
      const first = await supervisor.resumeSession(
        "sess-restarted",
        "/tmp/test",
        { text: "first" },
      );
      await supervisor.abortProcess(first.id);
      expect(supervisor.getRecentlyTerminatedProcesses()).toHaveLength(1);

      mockSdk.addScenario(createMockScenario("sess-restarted", "Second run"));
      const second = await supervisor.resumeSession(
        "sess-restarted",
        "/tmp/test",
        { text: "second" },
      );
      expect(supervisor.getRecentlyTerminatedProcesses()).toEqual([]);

      await supervisor.abortProcess(second.id);
      expect(supervisor.getRecentlyTerminatedProcesses()).toMatchObject([
        { id: second.id, sessionId: "sess-restarted" },
      ]);
    });
  });

  describe("interruptProcess", () => {
    it("hard-aborts and unregisters when interrupt reports incomplete", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      let aborted = false;
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "interrupt-fallback-session",
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
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-fallback-session",
        "/tmp/test",
        { text: "hi" },
      );

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(true);
      expect(
        supervisorWithRealSdk.getProcessForSession(
          "interrupt-fallback-session",
        ),
      ).toBeUndefined();
      expect(
        supervisorWithRealSdk.isRecapPausedUntilUserTurn(
          "interrupt-fallback-session",
        ),
      ).toBe(true);
      expect(
        warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
      ).toEqual(["session_interrupt_incomplete", "process_terminated"]);
      warn.mockRestore();
    });

    it("times out a stalled interrupt before hard-aborting", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      let aborted = false;
      const interrupt = vi.fn(() => new Promise<boolean>(() => {}));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "interrupt-timeout-session",
            };
            await queue[Symbol.asyncIterator]().next();
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        interruptTimeoutMs: 10,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-timeout-session",
        "/tmp/test",
        { text: "hi" },
      );

      const startedAt = Date.now();
      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(true);
      expect(
        supervisorWithRealSdk.getProcessForSession("interrupt-timeout-session"),
      ).toBeUndefined();
      expect(
        warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
      ).toEqual([
        "session_interrupt_timeout",
        "session_interrupt_incomplete",
        "process_terminated",
      ]);
      warn.mockRestore();
    });

    it("recovers deferred messages onto a replacement after hard abort", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      let startCount = 0;
      const aborts: Array<() => void> = [];
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async (options) => {
          startCount++;
          const run = { aborted: false };
          const queue = new MessageQueue();

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? `interrupt-recovery-${startCount}`,
            };
            await queue[Symbol.asyncIterator]().next();
            while (!run.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          const abort = () => {
            run.aborted = true;
          };
          aborts.push(abort);

          return {
            iterator: iterator(),
            queue,
            abort,
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-fallback-session",
        "/tmp/test",
        { text: "hi" },
      );
      process.deferMessage(
        { text: "ping", tempId: "temp-ping" },
        { promoteIfReady: true },
      );

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      await vi.waitFor(() => {
        const replacement = supervisorWithRealSdk.getProcessForSession(
          "interrupt-fallback-session",
        );
        const recovered = replacement
          ?.getMessageHistory()
          .find((message) => message.tempId === "temp-ping");
        expect(recovered?.message?.content).toBe("ping");
      });

      const replacement = supervisorWithRealSdk.getProcessForSession(
        "interrupt-fallback-session",
      );
      expect(replacement).toBeDefined();
      expect(replacement?.id).not.toBe(process.id);
      expect(aborts).toHaveLength(2);

      await replacement?.abort();
      expect(
        warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
      ).toEqual(["session_interrupt_incomplete", "process_terminated"]);
      warn.mockRestore();
    });

    it("recovers queued provider messages onto a replacement after hard abort", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      let startCount = 0;
      const aborts: Array<() => void> = [];
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async (options) => {
          startCount++;
          const run = { aborted: false };
          const queue = new MessageQueue();

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ??
                `interrupt-queue-recovery-${startCount}`,
            };
            await queue[Symbol.asyncIterator]().next();
            while (!run.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          const abort = () => {
            run.aborted = true;
          };
          aborts.push(abort);

          return {
            iterator: iterator(),
            queue,
            abort,
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-queued-provider-session",
        "/tmp/test",
        { text: "hi" },
      );
      process.queueMessage({ text: "ping", tempId: "temp-ping" });

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      await vi.waitFor(() => {
        const replacement = supervisorWithRealSdk.getProcessForSession(
          "interrupt-queued-provider-session",
        );
        const recovered = replacement
          ?.getMessageHistory()
          .find((message) => message.tempId === "temp-ping");
        expect(recovered?.message?.content).toBe("ping");
        expect(recovered?.uuid).toBeDefined();
      });

      const replacement = supervisorWithRealSdk.getProcessForSession(
        "interrupt-queued-provider-session",
      );
      expect(replacement).toBeDefined();
      expect(replacement?.id).not.toBe(process.id);

      await replacement?.abort();
      expect(
        warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
      ).toEqual(["session_interrupt_incomplete", "process_terminated"]);
      warn.mockRestore();
    });

    it("waits for provider teardown before starting hard-abort recovery", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      let startCount = 0;
      let releaseFirstAbort: (() => void) | undefined;
      const firstAbortGate = new Promise<void>((resolve) => {
        releaseFirstAbort = resolve;
      });
      const lifecycle: string[] = [];
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async (options) => {
          startCount++;
          const runNumber = startCount;
          lifecycle.push(`start-${runNumber}`);
          const run = { aborted: false };
          const queue = new MessageQueue();

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ??
                `interrupt-ordered-recovery-${runNumber}`,
            };
            await queue[Symbol.asyncIterator]().next();
            while (!run.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: async () => {
              lifecycle.push(`abort-start-${runNumber}`);
              if (runNumber === 1) await firstAbortGate;
              run.aborted = true;
              lifecycle.push(`abort-finish-${runNumber}`);
            },
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-ordered-recovery-session",
        "/tmp/test",
        { text: "hi" },
      );
      process.queueMessage({ text: "ping", tempId: "temp-ping" });

      const interrupted = supervisorWithRealSdk.interruptProcess(process.id);
      await vi.waitFor(() => {
        expect(lifecycle).toContain("abort-start-1");
      });
      expect(startCount).toBe(1);
      expect(process.hasUnverifiedProviderOwnership).toBe(true);
      await expect(
        supervisorWithRealSdk.resumeSession(
          "interrupt-ordered-recovery-session",
          "/tmp/test",
          { text: "must not race provider teardown" },
        ),
      ).rejects.toThrow(/prior provider teardown is in progress or unverified/);

      releaseFirstAbort?.();
      await expect(interrupted).resolves.toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      await vi.waitFor(() => {
        expect(startCount).toBe(2);
      });
      expect(lifecycle.indexOf("abort-finish-1")).toBeLessThan(
        lifecycle.indexOf("start-2"),
      );

      await supervisorWithRealSdk
        .getProcessForSession("interrupt-ordered-recovery-session")
        ?.abort();
      expect(
        warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
      ).toEqual(["session_interrupt_incomplete", "process_terminated"]);
      warn.mockRestore();
    });
  });

  describe("recaps", () => {
    it("persists a recap pause and clears only it on a fresh user turn", async () => {
      const metadata = createLaunchSettingsMetadata();
      let aborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "recap-pause-session",
          };
          for await (const message of queue) {
            if (aborted) return;
            void message;
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            aborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const recapSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        sessionMetadataService: metadata.service,
      });
      const process = await recapSupervisor.reactivateSession(
        "/tmp/test",
        "recap-pause-session",
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      metadata.writes.updateMetadata.mockClear();

      await recapSupervisor.pauseRecapsUntilUserTurn(process.id);

      expect(
        recapSupervisor.isRecapPausedUntilUserTurn("recap-pause-session"),
      ).toBe(true);
      expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
        "recap-pause-session",
        { recapPausedUntilUserTurn: true },
      );

      process.queueMessage({
        text: "continue intentionally",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });

      await vi.waitFor(() => {
        expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
          "recap-pause-session",
          { recapPausedUntilUserTurn: false },
        );
      });
      expect(
        recapSupervisor.isRecapPausedUntilUserTurn("recap-pause-session"),
      ).toBe(false);
      expect(metadata.writes.updateMetadata.mock.calls).toEqual([
        ["recap-pause-session", { recapPausedUntilUserTurn: true }],
        ["recap-pause-session", { recapPausedUntilUserTurn: false }],
      ]);

      await process.abort();
    });

    it("clears a durable automation pause only on a fresh user turn", async () => {
      const metadata = createLaunchSettingsMetadata();
      let automationPaused = true;
      metadata.service.getMetadata = (() =>
        automationPaused
          ? { automationPausedUntilUserTurn: true }
          : undefined) as SessionMetadataService["getMetadata"];
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          if (updates.automationPausedUntilUserTurn !== undefined) {
            automationPaused = updates.automationPausedUntilUserTurn;
          }
        },
      );
      let aborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "done-pause-session",
          };
          for await (const message of queue) {
            if (aborted) return;
            void message;
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            aborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const doneSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        sessionMetadataService: metadata.service,
      });
      const process = await doneSupervisor.reactivateSession(
        "/tmp/test",
        "done-pause-session",
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      metadata.writes.updateMetadata.mockClear();
      await doneSupervisor.pauseSessionAutomation("done-pause-session");

      process.queueMessage({
        text: "automatic project work",
        automaticSource: "project-queue",
      });
      process.queueMessage({ text: "automatic wake", automaticSource: "wake" });
      expect(automationPaused).toBe(true);
      expect(metadata.writes.updateMetadata).not.toHaveBeenCalled();

      process.queueMessage({
        text: "continue intentionally",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });

      await vi.waitFor(() => {
        expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
          "done-pause-session",
          { automationPausedUntilUserTurn: false },
        );
      });
      expect(automationPaused).toBe(false);
      expect(
        doneSupervisor.isAutomationPausedUntilUserTurn("done-pause-session"),
      ).toBe(false);

      await process.abort();
    });

    it("commits /done immediately when no provider turn is active", async () => {
      const metadata = createLaunchSettingsMetadata();
      const markSeen = vi.fn(async () => undefined);
      const doneSupervisor = new Supervisor({
        provider: testProvider(async () => {
          throw new Error("provider should not start");
        }),
        sessionMetadataService: metadata.service,
        notificationService: { markSeen } as unknown as NotificationService,
      });

      const result = await doneSupervisor.requestSessionDone("idle-session");

      expect(result).toMatchObject({ queued: false, paused: true });
      expect(metadata.writes.recordSyntheticDone).toHaveBeenCalledWith(
        "idle-session",
        result.message,
      );
      expect(markSeen).toHaveBeenCalledWith(
        "idle-session",
        result.message.timestamp,
        result.message.uuid,
      );
    });

    it("finalizes a retained /terminate boundary before verified abort", async () => {
      const metadata = createLaunchSettingsMetadata();
      let sessionMetadata: Record<string, unknown> | undefined;
      metadata.service.getMetadata = (() =>
        sessionMetadata) as SessionMetadataService["getMetadata"];
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          sessionMetadata = { ...sessionMetadata, ...updates };
        },
      );
      metadata.writes.recordSyntheticDone.mockImplementation(
        async (_sessionId, _message, options) => {
          sessionMetadata = {
            ...sessionMetadata,
            automationPausedUntilUserTurn: true,
            pendingSyntheticDone: undefined,
            ...(options?.archived ? { isArchived: true } : {}),
          };
        },
      );
      let providerAborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "terminate-session",
          };
          for await (const message of queue) {
            if (providerAborted) return;
            void message;
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            providerAborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const doneSupervisor = new Supervisor({
        provider,
        sessionMetadataService: metadata.service,
      });
      const process = await doneSupervisor.reactivateSession(
        "/tmp/test",
        "terminate-session",
        undefined,
        { providerName: "claude" },
      );
      vi.spyOn(process, "isRetainingProviderWork").mockReturnValue(true);

      const result = await doneSupervisor.requestSessionBoundaryAndAbort(
        "terminate-session",
        "/terminate",
      );

      expect(result).toMatchObject({
        queued: false,
        message: { content: "/terminate" },
        resumeExemption: { autoResumeDisabled: true },
        termination: { sessionId: "terminate-session" },
      });
      expect(metadata.writes.recordSyntheticDone).toHaveBeenCalledWith(
        "terminate-session",
        expect.objectContaining({ content: "/terminate" }),
        { archived: true },
      );
      expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
        "terminate-session",
        expect.objectContaining({
          heartbeatTurnsEnabled: false,
          autoResumeDisabled: true,
        }),
      );
      expect(providerAborted).toBe(true);
      expect(doneSupervisor.getProcessForSession("terminate-session")).toBe(
        undefined,
      );
    });

    it("still aborts when a durable stop boundary cannot be finalized", async () => {
      const metadata = createLaunchSettingsMetadata();
      metadata.service.getMetadata = (() => ({
        automationPausedUntilUserTurn: true,
        pendingSyntheticDone: {
          message: {
            type: "user",
            content: "/done",
            message: { role: "user", content: "/done" },
            timestamp: "2026-08-22T10:00:00.000Z",
            uuid: "durable-stop-boundary",
            id: "durable-stop-boundary",
            isSynthetic: true,
            yaSyntheticSource: "done",
          },
          userTurnVersion: 1,
        },
      })) as SessionMetadataService["getMetadata"];
      const doneSupervisor = new Supervisor({
        provider: testProvider(async () => {
          throw new Error("provider should not start");
        }),
        sessionMetadataService: metadata.service,
      });
      const finalizeError = new Error("synthetic row write failed");
      (
        doneSupervisor as unknown as {
          sessionDone: {
            requestSessionBoundaryForStop: () => Promise<never>;
          };
        }
      ).sessionDone.requestSessionBoundaryForStop = vi.fn(async () => {
        throw finalizeError;
      });
      const abortSessionWithVerification = vi
        .spyOn(doneSupervisor, "abortSessionWithVerification")
        .mockResolvedValue(null);

      await expect(
        doneSupervisor.requestSessionBoundaryAndAbort(
          "failed-finalize-session",
        ),
      ).rejects.toBe(finalizeError);
      expect(abortSessionWithVerification).toHaveBeenCalledWith(
        "failed-finalize-session",
      );
    });

    it("reports a terminate resume-exemption failure after process cleanup", async () => {
      const metadata = createLaunchSettingsMetadata();
      metadata.writes.updateMetadata.mockRejectedValue(
        new Error("metadata is read-only"),
      );
      const doneSupervisor = new Supervisor({
        provider: testProvider(async () => {
          throw new Error("provider should not start");
        }),
        sessionMetadataService: metadata.service,
      });
      const abortSessionWithVerification = vi
        .spyOn(doneSupervisor, "abortSessionWithVerification")
        .mockResolvedValue(null);

      const result = await doneSupervisor.requestSessionBoundaryAndAbort(
        "terminate-exemption-failure",
        "/terminate",
      );

      expect(result.resumeExemption).toEqual({
        heartbeatDisabled: false,
        autoResumeDisabled: false,
        error: "metadata is read-only",
      });
      expect(abortSessionWithVerification).toHaveBeenCalledWith(
        "terminate-exemption-failure",
      );
      expect(metadata.writes.recordSyntheticDone).toHaveBeenCalledWith(
        "terminate-exemption-failure",
        expect.objectContaining({ content: "/terminate" }),
        { archived: true },
      );
    });

    it("queues /done locally during a turn and commits it at the boundary", async () => {
      const metadata = createLaunchSettingsMetadata();
      let automationPaused = false;
      metadata.service.getMetadata = (() =>
        automationPaused
          ? { automationPausedUntilUserTurn: true }
          : undefined) as SessionMetadataService["getMetadata"];
      metadata.writes.recordSyntheticDone.mockImplementation(async () => {
        automationPaused = true;
      });
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          if (updates.automationPausedUntilUserTurn !== undefined) {
            automationPaused = updates.automationPausedUntilUserTurn;
          }
        },
      );
      const markSeen = vi.fn(async () => undefined);
      let finishTurn: (() => void) | undefined;
      const turnBoundary = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      const providerMessages: string[] = [];
      let aborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "queued-done-session",
          };
          for await (const message of queue) {
            if (aborted) return;
            providerMessages.push(
              typeof message.message.content === "string"
                ? message.message.content
                : "non-text provider message",
            );
            yield {
              type: "assistant" as const,
              message: { content: "working" },
            };
            await turnBoundary;
            yield {
              type: "result" as const,
              session_id: "queued-done-session",
            };
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            aborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const doneSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 10_000,
        sessionMetadataService: metadata.service,
        notificationService: { markSeen } as unknown as NotificationService,
      });
      const process = await doneSupervisor.reactivateSession(
        "/tmp/test",
        "queued-done-session",
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );

      process.queueMessage({
        text: "work already in progress",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });
      await vi.waitFor(() => {
        expect(providerMessages).toEqual(["work already in progress"]);
      });

      const result = await doneSupervisor.requestSessionDone(
        "queued-done-session",
      );
      expect(result).toMatchObject({ queued: true, paused: true });
      expect(process.getDeferredQueueSummary()).toEqual([
        expect.objectContaining({
          content: "/done",
          kind: "ya-command",
          yaCommand: "done",
        }),
      ]);
      expect(metadata.writes.updateMetadata).toHaveBeenCalledWith(
        "queued-done-session",
        expect.objectContaining({
          automationPausedUntilUserTurn: true,
          pendingSyntheticDone: expect.objectContaining({
            message: expect.objectContaining({
              content: "/done",
              uuid: result.message.uuid,
            }),
            userTurnVersion: 1,
          }),
        }),
      );
      expect(
        doneSupervisor.isAutomationPausedUntilUserTurn("queued-done-session"),
      ).toBe(true);
      expect(metadata.writes.recordSyntheticDone).not.toHaveBeenCalled();
      expect(providerMessages).toEqual(["work already in progress"]);

      process.deferMessage({
        text: "real user follow-up after done",
        tempId: "follow-up-after-done",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });

      finishTurn?.();
      await vi.waitFor(() => {
        expect(metadata.writes.recordSyntheticDone).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(process.getDeferredQueueSummary()).toEqual([]);
      });
      const [recordedSessionId, recordedMessage] =
        metadata.writes.recordSyntheticDone.mock.calls[0] ?? [];
      expect(recordedSessionId).toBe("queued-done-session");
      expect(recordedMessage).toMatchObject({
        content: "/done",
        uuid: result.message.uuid,
        yaSyntheticSource: "done",
      });
      await vi.waitFor(() => {
        expect(providerMessages).toEqual([
          "work already in progress",
          "real user follow-up after done",
        ]);
      });
      expect(providerMessages).not.toContain("/done");
      expect(
        doneSupervisor.isAutomationPausedUntilUserTurn("queued-done-session"),
      ).toBe(false);
      expect(markSeen).toHaveBeenCalledWith(
        "queued-done-session",
        recordedMessage?.timestamp,
        result.message.uuid,
      );

      await process.abort();
    });

    it("keeps a queued /done pause after the live process dies", async () => {
      const metadata = createLaunchSettingsMetadata();
      let automationPaused = false;
      metadata.service.getMetadata = (() =>
        automationPaused
          ? { automationPausedUntilUserTurn: true }
          : undefined) as SessionMetadataService["getMetadata"];
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          if (updates.automationPausedUntilUserTurn !== undefined) {
            automationPaused = updates.automationPausedUntilUserTurn;
          }
        },
      );
      const providerMessages: string[] = [];
      let finishTurn: (() => void) | undefined;
      const turnBoundary = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      let aborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "done-restart-session",
          };
          for await (const message of queue) {
            if (aborted) return;
            providerMessages.push(
              typeof message.message.content === "string"
                ? message.message.content
                : "non-text provider message",
            );
            yield {
              type: "assistant" as const,
              message: { content: "working" },
            };
            await turnBoundary;
            if (aborted) return;
            yield {
              type: "result" as const,
              session_id: "done-restart-session",
            };
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            aborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const doneSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 10_000,
        sessionMetadataService: metadata.service,
      });
      const process = await doneSupervisor.reactivateSession(
        "/tmp/test",
        "done-restart-session",
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      process.queueMessage({
        text: "work already in progress",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });
      await vi.waitFor(() => {
        expect(providerMessages).toEqual(["work already in progress"]);
      });

      const result = await doneSupervisor.requestSessionDone(
        "done-restart-session",
      );
      expect(result.queued).toBe(true);
      expect(automationPaused).toBe(true);

      const coldSupervisor = new Supervisor({
        provider: testProvider(async () => {
          throw new Error("cold supervisor should not start a provider");
        }),
        sessionMetadataService: metadata.service,
      });
      expect(
        coldSupervisor.isAutomationPausedUntilUserTurn("done-restart-session"),
      ).toBe(true);
      expect(metadata.writes.recordSyntheticDone).not.toHaveBeenCalled();

      aborted = true;
      finishTurn?.();
      await process.abort();
    });

    it("leaves automation paused after an idle /done commit with no later user turn", async () => {
      const metadata = createLaunchSettingsMetadata();
      let automationPaused = false;
      metadata.service.getMetadata = (() =>
        automationPaused
          ? { automationPausedUntilUserTurn: true }
          : undefined) as SessionMetadataService["getMetadata"];
      metadata.writes.recordSyntheticDone.mockImplementation(async () => {
        automationPaused = true;
      });
      metadata.writes.updateMetadata.mockImplementation(
        async (_sessionId, updates) => {
          if (updates.automationPausedUntilUserTurn !== undefined) {
            automationPaused = updates.automationPausedUntilUserTurn;
          }
        },
      );
      const providerMessages: string[] = [];
      let finishTurn: (() => void) | undefined;
      const turnBoundary = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      let aborted = false;
      const provider = testProvider(async (options) => {
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: options.resumeSessionId ?? "done-hold-session",
          };
          for await (const message of queue) {
            if (aborted) return;
            providerMessages.push(
              typeof message.message.content === "string"
                ? message.message.content
                : "non-text provider message",
            );
            yield {
              type: "assistant" as const,
              message: { content: "working" },
            };
            await turnBoundary;
            yield {
              type: "result" as const,
              session_id: "done-hold-session",
            };
          }
        }
        return {
          iterator: iterator(),
          queue,
          abort: () => {
            aborted = true;
            queue.push({ text: "__abort__" });
          },
        };
      });
      const doneSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 10_000,
        sessionMetadataService: metadata.service,
      });
      const process = await doneSupervisor.reactivateSession(
        "/tmp/test",
        "done-hold-session",
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      process.queueMessage({
        text: "work already in progress",
        metadata: { serverReceivedAt: new Date().toISOString() },
      });
      await vi.waitFor(() => {
        expect(providerMessages).toEqual(["work already in progress"]);
      });

      await doneSupervisor.requestSessionDone("done-hold-session");
      finishTurn?.();
      await vi.waitFor(() => {
        expect(metadata.writes.recordSyntheticDone).toHaveBeenCalledOnce();
      });
      expect(
        doneSupervisor.isAutomationPausedUntilUserTurn("done-hold-session"),
      ).toBe(true);

      await process.abort();
    });

    it("falls back to tailed recap generation when forked recap cannot fork", async () => {
      const generateSummary = vi.fn(async (request) => ({
        text:
          request.strategy === "side-session"
            ? request.recentAssistantText.join(" | ")
            : "",
      }));
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "recap-fallback-session",
            };
            yield {
              type: "assistant" as const,
              message: { content: "assistant after start" },
            };
            yield {
              type: "result" as const,
              session_id: options.resumeSessionId ?? "recap-fallback-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        supportsRecaps: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
        generateSummary,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithProvider.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      if (!("id" in process)) {
        throw new Error("expected immediate process");
      }
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));

      const result = await (
        supervisorWithProvider as unknown as {
          requestForkedRecap: (
            process: typeof process,
            provider: AgentProvider,
            sinceMs: number | null,
          ) => Promise<{
            supported: boolean;
            emitted: boolean;
            text?: string;
          }>;
        }
      ).requestForkedRecap(process, provider, Date.now() - 1_000);

      expect(result).toMatchObject({
        supported: true,
        emitted: true,
        text: "assistant after start",
      });
      expect(generateSummary).toHaveBeenCalledWith({
        purpose: "recap",
        strategy: "side-session",
        recentAssistantText: ["assistant after start"],
        model: "cheapest",
      });
      await process.abort();
    });

    it("bypasses the recent-text gate for a revived process (forks from transcript)", async () => {
      const generateSummary = vi.fn(async (request) => ({
        text: request.strategy === "fork" ? "forked summary" : "",
      }));
      const forkSession = vi.fn(async () => ({
        sessionId: "revived-recap-fork",
      }));
      // Message-less resume: yields init then idles, so nothing streams and the
      // in-memory recap buffer stays empty (as for a process revived for recap).
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "revived-session",
            };
            yield {
              type: "result" as const,
              session_id: options.resumeSessionId ?? "revived-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        supportsRecaps: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
        generateSummary,
        forkSession,
      };
      const supervisor = new Supervisor({ provider, idleTimeoutMs: 60000 });

      const process = await supervisor.reactivateSession(
        "/tmp/test",
        "revived-session",
        undefined,
        {
          model: "gpt-5.6-sol",
          requestedModel: "gpt-5.6-sol",
          providerName: "claude",
          recapMode: "fork",
        },
      );
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));
      // The in-memory recap buffer is empty for a freshly revived process.
      expect(process.getRecentAssistantText(null)).toEqual([]);

      const callForked = (revived?: boolean) =>
        (
          supervisor as unknown as {
            requestForkedRecap: (
              p: typeof process,
              prov: AgentProvider,
              since: number | null,
              opts?: { revived?: boolean },
            ) => Promise<{
              supported: boolean;
              emitted: boolean;
              reason?: string;
              text?: string;
            }>;
          }
        ).requestForkedRecap(
          process,
          provider,
          null,
          revived === undefined ? undefined : { revived },
        );

      // Without the flag, the empty buffer suppresses the recap.
      await expect(callForked()).resolves.toMatchObject({ emitted: false });
      expect(forkSession).not.toHaveBeenCalled();

      // With revived:true, the fork runs and emits the transcript summary.
      await expect(callForked(true)).resolves.toMatchObject({
        emitted: true,
        text: "forked summary",
      });
      expect(forkSession).toHaveBeenCalled();
      expect(generateSummary).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-5.6-sol" }),
      );

      await process.abort();
    });

    it("suppresses a recap with no assistant text since the last emitted recap", async () => {
      const generateSummary = vi.fn(async (request) => ({
        text: request.strategy === "fork" ? "forked summary" : "",
      }));
      const forkSession = vi.fn(async () => ({
        sessionId: "since-last-recap-fork",
      }));
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "since-last-recap",
            };
            yield {
              type: "assistant" as const,
              message: { content: "assistant after start" },
            };
            yield {
              type: "result" as const,
              session_id: options.resumeSessionId ?? "since-last-recap",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        supportsRecaps: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
        generateSummary,
        forkSession,
      };
      // Only the recap floor and the fork-archival path touch the metadata
      // service here; back the stub with a swappable recap row list.
      let persistedRecaps: unknown[] = [];
      const setSessionSandbox = vi.fn(async () => undefined);
      const metadataStub = {
        getMetadata: () => undefined,
        recordEffectiveLaunchSettings: async () => ({
          schemaVersion: 1,
          revision: 1,
          permissionMode: "default",
          requestedModel: null,
          serviceTier: null,
          thinking: null,
          effort: null,
        }),
        getRecapMessages: () => [...persistedRecaps],
        remapSessionId: async () => {},
        updateMetadata: async () => {},
        setProvider: async () => {},
        setExecutor: async () => {},
        setRequestedModel: async () => {},
        setSessionSandbox,
        addRecapMessage: async () => {},
      } as unknown as ConstructorParameters<
        typeof Supervisor
      >[0]["sessionMetadataService"];
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));
      const supervisorWithMetadata = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        sessionMetadataService: metadataStub,
        eventBus,
      });

      const process = await supervisorWithMetadata.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { providerName: "claude", recapMode: "fork" },
      );
      if (!("id" in process)) {
        throw new Error("expected immediate process");
      }
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));

      const callForked = () =>
        (
          supervisorWithMetadata as unknown as {
            requestForkedRecap: (
              p: typeof process,
              prov: AgentProvider,
              since: number | null,
            ) => Promise<{
              supported: boolean;
              emitted: boolean;
              reason?: string;
            }>;
          }
        ).requestForkedRecap(process, provider, null);

      // A persisted recap newer than all buffered assistant text raises the
      // floor past the buffer: nothing new to say, so no second recap.
      persistedRecaps = [
        {
          type: "system",
          subtype: "away_summary",
          content: "Already recapped.",
          timestamp: new Date(Date.now() + 60_000).toISOString(),
          uuid: "recap-after",
          id: "recap-after",
          yaRecapSource: "ya-synthetic",
        },
      ];
      await expect(callForked()).resolves.toMatchObject({
        supported: true,
        emitted: false,
        reason: "no recent assistant activity to summarize",
      });
      expect(forkSession).not.toHaveBeenCalled();

      // A recap older than the buffered assistant text does not block a new one.
      persistedRecaps = [
        {
          type: "system",
          subtype: "away_summary",
          content: "Stale recap.",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          uuid: "recap-before",
          id: "recap-before",
          yaRecapSource: "ya-synthetic",
        },
      ];
      await expect(callForked()).resolves.toMatchObject({
        supported: true,
        emitted: true,
        text: "forked summary",
      });
      expect(forkSession).toHaveBeenCalled();

      Object.assign(process, {
        sandboxEnforcement: {
          requested: "project-write",
          effective: "project-write",
          state: "enforced",
          networkFirewall: false,
        },
        sandboxStateKey: "project-sandbox",
        sandboxProjectPath: "/tmp/test",
      });
      const sandboxPersistence = supervisorWithMetadata as unknown as {
        persistProcessSandboxOrAbort: (p: typeof process) => Promise<void>;
        archiveHelperFork: (
          childSessionId: string,
          sourceSessionId: string,
          title: string,
          providerName: "claude",
          p: typeof process,
        ) => Promise<void>;
      };
      await sandboxPersistence.persistProcessSandboxOrAbort(process);
      await sandboxPersistence.archiveHelperFork(
        "sandbox-helper-fork",
        process.sessionId,
        "Sandbox helper",
        "claude",
        process,
      );
      expect(setSessionSandbox).toHaveBeenCalledWith(
        process.sessionId,
        expect.objectContaining({
          level: "project-write",
          networkFirewall: false,
        }),
      );
      expect(setSessionSandbox).toHaveBeenCalledWith(
        "sandbox-helper-fork",
        expect.objectContaining({
          level: "project-write",
          networkFirewall: false,
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-metadata-changed",
          sessionId: "since-last-recap-fork",
          title: "Recap generator",
          archived: true,
          forkedFromSessionId: "since-last-recap",
        }),
      );

      await process.abort();
    });
  });

  describe("prompt suggestion options", () => {
    it("keeps native selection as an observation mode", async () => {
      const startedOptions: Array<
        Parameters<AgentProvider["startSession"]>[0]
      > = [];
      const makeProvider = (
        supportsNativePromptSuggestions: boolean,
      ): AgentProvider => ({
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        supportsNativePromptSuggestions,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession: async (options) => {
          startedOptions.push(options);
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? randomSessionId(),
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      });
      const randomSessionId = () =>
        `prompt-suggestion-${startedOptions.length}`;

      const nativeSupervisor = new Supervisor({
        provider: makeProvider(true),
        idleTimeoutMs: 100,
      });
      const nativeProcess = await nativeSupervisor.startSession("/tmp/test", {
        text: "hi",
      });
      if (!("id" in nativeProcess)) {
        throw new Error("expected process");
      }

      const explicitOffProcess = await nativeSupervisor.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { promptSuggestionMode: "off" },
      );
      if (!("id" in explicitOffProcess)) {
        throw new Error("expected process");
      }

      const unsupportedSupervisor = new Supervisor({
        provider: makeProvider(false),
        idleTimeoutMs: 100,
      });
      const unsupportedProcess = await unsupportedSupervisor.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { promptSuggestionMode: "native" },
      );
      if (!("id" in unsupportedProcess)) {
        throw new Error("expected process");
      }

      expect(startedOptions.map((options) => options.sessionOptions)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(nativeProcess.promptSuggestionMode).toBe("native");
      expect(explicitOffProcess.promptSuggestionMode).toBe("off");
      expect(unsupportedProcess.promptSuggestionMode).toBe("off");

      await nativeProcess.abort();
      await explicitOffProcess.abort();
      await unsupportedProcess.abort();
    });
  });

  describe("queue propagation", () => {
    it.each([false, true])(
      "dispatches an initial native goal without a model turn (resume: %s)",
      async (resume) => {
        let finish!: () => void;
        const closed = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const queue = new MessageQueue();
        const command = vi.fn(async () => ({
          handled: true,
          output: { summary: "/goal", details: ["Keep working", "Goal set"] },
        }));
        const provider = testProvider(async () => ({
          iterator: (async function* () {
            yield {
              type: "system",
              subtype: "init",
              session_id: "goal-session",
            };
            await closed;
          })(),
          queue,
          abort: finish,
          runProviderCommand: command,
        }));
        const metadata = createLaunchSettingsMetadata();
        const addLocalCommandMessage = vi.fn(async () => {});
        metadata.service.addLocalCommandMessage = addLocalCommandMessage;
        const owner = new Supervisor({
          provider,
          sessionMetadataService: metadata.service,
          idleTimeoutMs: 100,
        });
        try {
          const input = { text: "/goal Keep working", tempId: "goal-temp" };
          const result = resume
            ? await owner.resumeSession("goal-session", "/tmp/test", input)
            : await owner.startSession("/tmp/test", input);
          if (!("id" in result)) throw new Error("expected process");
          expect(command).toHaveBeenCalledWith("goal", "Keep working");
          expect(result.state.type).toBe("idle");
          expect(addLocalCommandMessage).toHaveBeenCalledWith(
            "goal-session",
            expect.objectContaining({
              subtype: "local_command",
              details: ["Keep working", "Goal set"],
              tempId: "goal-temp",
            }),
          );
          expect(
            result
              .getMessageHistory()
              .some((message) => message.type === "user"),
          ).toBe(false);
          await result.abort();
        } finally {
          finish();
        }
      },
    );

    it("expands emulated slash commands for the first provider message", async () => {
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "slash-emulation-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            supportedCommands: async () => [
              {
                name: "goal",
                description: "Keep working until done",
                emulation: { providerText: "/loop wish {{argument}}" },
              },
            ],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
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
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithProvider.startSession("/tmp/test", {
        text: "/goal Make tests pass",
      });
      if (!("id" in process)) {
        throw new Error("expected process");
      }

      expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
      const queuedProviderTurn = await queues[0]
        ?.[Symbol.asyncIterator]()
        .next();
      expect(queuedProviderTurn?.value?.message.content).toBe(
        "/loop wish Make tests pass",
      );
      expect(
        process
          .getMessageHistory()
          .some(
            (message) =>
              message.type === "user" &&
              message.message?.content === "/loop wish Make tests pass",
          ),
      ).toBe(true);

      await process.abort();
    });

    it("preserves model settings when a queued session starts later", async () => {
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? `queued-session-${queues.length}`,
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
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
          serviceTier: "priority",
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
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "high",
      });
      expect(startSession.mock.calls[1]?.[0].initialMessage).toBeUndefined();
      const secondMessage = await queues[1]?.[Symbol.asyncIterator]().next();
      expect(secondMessage?.value?.message.content).toBe("second");
    });

    it("revalidates a queued Gateway model before starting its process", async () => {
      let advertisedModels = [{ id: "gateway-model", name: "Gateway Model" }];
      let aborted = false;
      const getAvailableModels = vi.fn(async () => advertisedModels);
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "gateway-occupier",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        ...testProvider(startSession),
        name: "claude-gateway",
        displayName: "Claude Gateway",
        getAvailableModels,
      };
      const gatewaySupervisor = new Supervisor({
        provider,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      const occupying = await gatewaySupervisor.startSession(
        "/tmp/test",
        { text: "occupy the worker" },
        undefined,
        { model: "gateway-model", providerName: "claude-gateway" },
      );
      if (!("id" in occupying)) {
        throw new Error("expected occupying process");
      }
      const direct = await gatewaySupervisor.startSession(
        "/tmp/test",
        { text: "direct launch cannot observe a deferred failure" },
        undefined,
        { model: "gateway-model", providerName: "claude-gateway" },
      );
      expect(direct).toEqual({ error: "queue_full", maxQueueSize: 1 });
      expect(gatewaySupervisor.getQueueInfo()).toEqual([]);

      const onFailed = vi.fn();
      const queued = await gatewaySupervisor.startSession(
        "/tmp/test",
        { text: "start after the worker is free" },
        undefined,
        { model: "gateway-model", providerName: "claude-gateway" },
        { onFailed },
      );
      expect("queued" in queued && queued.queued).toBe(true);
      expect(getAvailableModels).toHaveBeenCalledTimes(1);

      advertisedModels = [];
      await gatewaySupervisor.abortProcess(occupying.id);

      await vi.waitFor(() => {
        expect(getAvailableModels).toHaveBeenCalledTimes(2);
        expect(onFailed).toHaveBeenCalledWith(
          'Claude Gateway no longer advertises model "gateway-model"',
        );
      });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(gatewaySupervisor.getAllProcesses()).toEqual([]);
    });

    it("inherits durable settings when a cold resume waits in the worker queue", async () => {
      let callNumber = 0;
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          callNumber += 1;
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id:
                options.resumeSessionId ?? `queue-occupier-${callNumber}`,
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
      const metadata = createLaunchSettingsMetadata({
        schemaVersion: 1,
        revision: 9,
        permissionMode: "bypassPermissions",
        requestedModel: "opus",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "max",
      });
      const supervisorWithQueue = new Supervisor({
        provider: testProvider(startSession),
        sessionMetadataService: metadata.service,
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      const first = await supervisorWithQueue.startSession(
        "/tmp/test",
        { text: "occupy worker" },
        "bypassPermissions",
        {
          model: "opus",
          requestedModel: "opus",
          serviceTier: "priority",
          thinking: { type: "adaptive" },
          effort: "max",
        },
      );
      if (!("id" in first)) {
        throw new Error("expected occupying process");
      }

      const queued = await supervisorWithQueue.resumeSession(
        "queued-cold-resume",
        "/tmp/test",
        { text: "continue" },
      );
      expect("queued" in queued && queued.queued).toBe(true);

      await supervisorWithQueue.abortProcess(first.id);
      await vi.waitFor(() => {
        expect(startSession).toHaveBeenCalledTimes(2);
      });

      expect(startSession.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          resumeSessionId: "queued-cold-resume",
          permissionMode: "bypassPermissions",
          model: "opus",
          serviceTier: "priority",
          thinking: { type: "adaptive" },
          effort: "max",
        }),
      );
      expect(metadata.current()?.revision).toBe(9);

      const resumed =
        supervisorWithQueue.getProcessForSession("queued-cold-resume");
      await resumed?.abort();
    });

    it("steers active turns without restarting for composer thinking drift", async () => {
      let aborted = false;
      const steeredMessages: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "steering-session",
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
            steer: async (message) => {
              steeredMessages.push(message.text);
              return true;
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
        supportsSteering: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const started = await supervisorWithProvider.resumeSession(
        "steering-session",
        "/tmp/test",
        { text: "start" },
        undefined,
        {
          model: "gpt-5.5",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      await vi.waitFor(() => {
        expect(started.state.type).toBe("in-turn");
      });

      const result = await supervisorWithProvider.queueMessageToSession(
        "steering-session",
        "/tmp/test",
        {
          text: "steer me",
          metadata: { deliveryIntent: "steer" as const },
        },
        undefined,
        {
          model: "gpt-5.5",
          thinking: { type: "adaptive" },
          effort: "max",
        },
      );

      expect(result).toMatchObject({ success: true, restarted: false });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(
        supervisorWithProvider.getProcessForSession("steering-session"),
      ).toBe(started);
      await vi.waitFor(() => {
        expect(steeredMessages).toEqual(["steer me"]);
      });

      await supervisorWithProvider.abortProcess(started.id);
    });
  });

  describe("heartbeat turns", () => {
    it("requires verified idle liveness before queueing a synthetic turn", async () => {
      vi.useFakeTimers();
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-session-1",
              };
              await queue[Symbol.asyncIterator]().next();
              yield { type: "result", session_id: "heartbeat-session-1" };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const originalSnapshot = started.getLivenessSnapshot.bind(started);
        const livenessSpy = vi
          .spyOn(started, "getLivenessSnapshot")
          .mockImplementation((now?: Date) => ({
            ...originalSnapshot(now),
            derivedStatus: "long-silent-unverified",
            activeWorkKind: "agent-turn",
            lastVerifiedIdleAt: null,
          }));

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        livenessSpy.mockImplementation((now?: Date) => originalSnapshot(now));

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not queue heartbeat turns while provider retention is active", async () => {
      vi.useFakeTimers();
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-provider-retained-session",
              };
              await queue[Symbol.asyncIterator]().next();
              yield {
                type: "result",
                session_id: "heartbeat-provider-retained-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              getProviderRetention: () => ({
                retained: true,
                reasons: ["stop-hook-background-tasks:1"],
                backgroundTaskCount: 1,
                sessionCronCount: 0,
                liveTaskCount: 0,
              }),
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 120_000,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");
        expect(started.getLivenessSnapshot().derivedStatus).toBe(
          "verified-waiting-provider",
        );
        expect(supervisorWithHeartbeat.getWorkerActivity()).toMatchObject({
          activeWorkers: 1,
          interruptibleSessionCount: 1,
          hasActiveWork: true,
        });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);
        expect(supervisorWithHeartbeat.getWorkerActivity().hasActiveWork).toBe(
          true,
        );

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("promotes patient deferred messages after verified quiet", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "patient-deferred-heartbeat-session",
              };
              await queue[Symbol.asyncIterator]().next();
              yield {
                type: "result",
                session_id: "patient-deferred-heartbeat-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: false,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const deferred = started.deferMessage(
          {
            text: "patient follow-up",
            tempId: "temp-patient",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: true },
        );
        expect(deferred).toMatchObject({ success: true, deferred: true });
        expect(started.getDeferredQueueSummary()).toMatchObject([
          {
            tempId: "temp-patient",
            content: "patient follow-up",
            metadata: { deliveryIntent: "patient" },
          },
        ]);

        // Still inside the (default 2s) quiet window: not yet promoted.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);
        expect(started.getDeferredQueueSummary()).toHaveLength(1);

        // Past the quiet window: promoted.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);
        expect(started.getDeferredQueueSummary()).toEqual([]);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats a patient message as plain deferred on non-Claude providers", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;

      try {
        const startSession = vi.fn(async () => {
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "codex-patient-session",
            };
            await queue[Symbol.asyncIterator]().next();
            yield { type: "result", session_id: "codex-patient-session" };

            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            isProcessAlive: () => !aborted,
          };
        });
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

        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 100,
        });

        const started = await supervisorWithProvider.startSession("/tmp/test", {
          text: "start",
        });
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        // On Claude this exact call defers and waits the verified-idle quiet
        // window (see "promotes patient deferred messages after verified
        // quiet"). On a non-Claude provider there is no background-work
        // retention to wait for, so the patient tag is downgraded to a plain
        // deferred turn that promotes immediately — no timers advanced.
        const result = started.deferMessage(
          {
            text: "patient follow-up",
            tempId: "temp-patient-codex",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: true },
        );
        expect(result).toMatchObject({
          success: true,
          deferred: false,
          promoted: true,
        });
        expect(started.hasPatientDeferredMessages()).toBe(false);
        expect(started.getDeferredQueueSummary()).toEqual([]);
        expect(started.queueDepth).toBe(1);
        expect(started.state.type).toBe("in-turn");

        const abortPromise = supervisorWithProvider.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("visits an opted-in idle session at its deadline, not on an interval", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      let resolveAbort!: () => void;
      const abortSignal = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-deadline-session",
              };
              await queue[Symbol.asyncIterator]().next();
              yield {
                type: "result",
                session_id: "heartbeat-deadline-session",
              };

              await abortSignal;
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                resolveAbort();
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 10,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        // Five minutes of an idle, opted-in session. The fixed tick this
        // replaced would have swept ten times over the same span.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(started.queueDepth).toBe(0);
        expect(
          supervisorWithHeartbeat.getHeartbeatScheduleMetrics().sweeps,
        ).toBeLessThanOrEqual(2);

        // The deadline itself still fires.
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
        expect(started.queueDepth).toBe(1);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("arms no timer at all while nothing is opted in", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));

      try {
        const supervisorWithoutHeartbeat = new Supervisor({
          realSdk: { startSession: async () => ({}) as never },
          getHeartbeatTurnSettings: () => ({
            enabled: false,
            afterMinutes: 5,
            text: "heartbeat check",
          }),
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);

        const metrics =
          supervisorWithoutHeartbeat.getHeartbeatScheduleMetrics();
        expect(metrics.sweeps).toBe(1);
        expect(metrics.armedAtMs).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rechecks a settled unowned candidate once per idle threshold", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      const getCandidates = vi.fn(() => []);

      try {
        new Supervisor({
          realSdk: { startSession: async () => ({}) as never },
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 5,
            text: "heartbeat check",
          }),
          getHeartbeatTurnCandidates: getCandidates,
          // Eligible, unowned, and currently settled: an external append can
          // still make it due, but never sooner than one idle threshold.
          getHeartbeatWaitingSessionIds: () => ["settled-session"],
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);

        // Twenty fixed ticks would have reached storage twenty times.
        expect(getCandidates.mock.calls.length).toBeLessThanOrEqual(3);
        expect(getCandidates.mock.calls.length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the heartbeat timeout on real liveness signals", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      let resolveAbort!: () => void;
      const abortSignal = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-session-2",
              };
              await queue[Symbol.asyncIterator]().next();
              yield { type: "result", session_id: "heartbeat-session-2" };

              await abortSignal;
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
                resolveAbort();
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const originalSnapshot = started.getLivenessSnapshot.bind(started);
        const rawActivityAtMs = Date.parse("2026-05-06T00:00:45.000Z");
        const rawActivityAt = new Date(rawActivityAtMs).toISOString();
        vi.spyOn(started, "getLivenessSnapshot").mockImplementation(
          (now?: Date) => {
            const snapshot = originalSnapshot(now);
            const checkedAtMs = now?.getTime() ?? Date.now();
            return checkedAtMs >= rawActivityAtMs
              ? {
                  ...snapshot,
                  lastRawProviderEventAt: rawActivityAt,
                  lastRawProviderEventSource: "test:raw-provider",
                }
              : snapshot;
          },
        );

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("steers heartbeat turns into quiet doubtful active sessions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const steeredMessages: string[] = [];

      try {
        const provider: AgentProvider = {
          name: "codex",
          displayName: "Codex",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: false,
          supportsSteering: true,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-active-session",
              };
              await queue[Symbol.asyncIterator]().next();

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              steer: async (message) => {
                steeredMessages.push(message.text);
                return true;
              },
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          provider,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("in-turn");

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
          expect(steeredMessages).toEqual(["heartbeat check"]);
        });
        expect(started.state.type).toBe("in-turn");

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes unowned stale pending-tool sessions with heartbeat text", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? "heartbeat-unowned-session",
            };
            yield {
              type: "result",
              session_id:
                options.resumeSessionId ?? "heartbeat-unowned-session",
            };

            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            isProcessAlive: () => !aborted,
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        supportsSteering: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };

      try {
        const supervisorWithHeartbeat = new Supervisor({
          provider,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
          getHeartbeatTurnCandidates: () => [
            {
              sessionId: "heartbeat-unowned-session",
              projectId: encodeProjectId("/tmp/test"),
              projectPath: "/tmp/test",
              provider: "codex",
              model: "gpt-5.5",
              updatedAt: "2026-05-06T00:00:00.000Z",
              hasPendingToolCall: true,
            },
          ],
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
          expect(startSession).toHaveBeenCalledTimes(1);
        });
        expect(startSession.mock.calls[0]?.[0]).toMatchObject({
          resumeSessionId: "heartbeat-unowned-session",
          model: "gpt-5.5",
        });
        expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
        const heartbeatMessage = await queues[0]
          ?.[Symbol.asyncIterator]()
          .next();
        expect(heartbeatMessage?.value?.message.content).toBe(
          "heartbeat check",
        );

        const started = supervisorWithHeartbeat.getProcessForSession(
          "heartbeat-unowned-session",
        );
        expect(started).toBeDefined();
        if (started) {
          const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
          await vi.advanceTimersByTimeAsync(5000);
          await expect(abortPromise).resolves.toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("active liveness probes", () => {
    it("probes provider status for long-silent active sessions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const probeLiveness = vi.fn(async () => ({
        status: "active" as const,
        source: "test:probe",
        checkedAt: new Date(),
      }));

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "liveness-probe-session",
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
              isProcessAlive: () => !aborted,
              probeLiveness,
            };
          },
        };

        const supervisorWithProbe = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
        });

        const started = await supervisorWithProbe.startSession("/tmp/test", {
          text: "start",
        });
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        expect(probeLiveness).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30 * 1000);
        await vi.waitFor(() => {
          expect(probeLiveness).toHaveBeenCalledTimes(1);
        });
        expect(started.lastLivenessProbe).toMatchObject({
          status: "active",
          source: "test:probe",
        });
        expect(started.getLivenessSnapshot().derivedStatus).toBe(
          "verified-waiting-provider",
        );

        const abortPromise = supervisorWithProbe.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
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
      expect(events.some((event) => event.type === "session-id-remapped")).toBe(
        false,
      );
    });

    it("emits a public remap when init follows the provisional ID timeout", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => events.push(event));
        const remapSessionId = vi.fn(async () => {});
        const sessionMetadataService = {
          getMetadata: () => undefined,
          recordEffectiveLaunchSettings: async () => ({
            schemaVersion: 1,
            revision: 1,
            permissionMode: "default",
            requestedModel: null,
            serviceTier: null,
            thinking: null,
            effort: null,
          }),
          remapSessionId,
        } as unknown as ConstructorParameters<
          typeof Supervisor
        >[0]["sessionMetadataService"];

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => ({
            iterator: controller.iterator,
            queue: new MessageQueue(),
            abort: () => controller.finish(),
          }),
        };
        const supervisorWithBus = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          eventBus,
          sessionMetadataService,
        });

        const starting = supervisorWithBus.startSession("/tmp/test", {
          text: "Start after a slow init",
        });
        await vi.advanceTimersByTimeAsync(5000);
        const process = await starting;
        const provisionalSessionId = process.sessionId;

        expect(provisionalSessionId).not.toBe("canonical-session");
        expect(
          events.find(
            (event) =>
              event.type === "session-created" &&
              event.session.id === provisionalSessionId,
          ),
        ).toBeDefined();

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "canonical-session",
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(
          events.find((event) => event.type === "session-id-remapped"),
        ).toMatchObject({
          type: "session-id-remapped",
          oldSessionId: provisionalSessionId,
          newSessionId: "canonical-session",
          projectId: encodeProjectId("/tmp/test"),
          processId: process.id,
          provider: "claude",
        });
        expect(
          supervisorWithBus.getProcessForSession(provisionalSessionId),
        ).toBe(process);
        expect(
          supervisorWithBus.getProcessForSession("canonical-session"),
        ).toBe(process);
        expect(remapSessionId).toHaveBeenCalledWith(
          provisionalSessionId,
          "canonical-session",
        );

        controller.finish();
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
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
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
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

      await expect(
        supervisorWithBus.startSession("/tmp/test", {
          text: "Trigger failure",
        }),
      ).rejects.toThrow(/Process terminated|Failed to queue initial message/);

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
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_error",
          sessionId: "terminated-session-1",
          errorMessage: "process exited",
        }),
        "Process error: terminated-session-1 - process exited",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          sessionId: "terminated-session-1",
          reason: "underlying process terminated",
        }),
        "Process terminated: terminated-session-1 - underlying process terminated",
      );
      errorLog.mockRestore();
      warn.mockRestore();
    });

    it("keeps an idle owner registered until provider abort is verified", async () => {
      vi.useFakeTimers();
      try {
        let providerAlive = true;
        let releaseAbort: (() => void) | undefined;
        const abortGate = new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: "idle-alive-session-1",
          };
          for await (const sdkMessage of queue) {
            void sdkMessage;
            if (!providerAlive) return;
            yield {
              type: "result" as const,
              session_id: "idle-alive-session-1",
            };
          }
        }
        const startSession = vi.fn(async () => ({
          iterator: iterator(),
          queue,
          abort: async () => {
            await abortGate;
            providerAlive = false;
            queue.push({ text: "__abort__" });
          },
          isProcessAlive: () => providerAlive,
        }));
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => {
          events.push(event);
        });
        const supervisorWithAliveProcess = new Supervisor({
          realSdk: { startSession },
          idleTimeoutMs: 100,
          eventBus,
        });

        const process = await supervisorWithAliveProcess.startSession(
          "/tmp/test",
          { text: "Keep this session alive" },
        );
        await vi.waitFor(() => {
          expect(process.state.type).toBe("idle");
        });

        await vi.advanceTimersByTimeAsync(100);

        expect(process.hasUnverifiedProviderOwnership).toBe(true);
        expect(
          supervisorWithAliveProcess.getProcessForSession(
            "idle-alive-session-1",
          ),
        ).toBe(process);
        expect(
          events.some(
            (event) =>
              event.type === "session-status-changed" &&
              event.sessionId === "idle-alive-session-1" &&
              event.ownership.owner === "none",
          ),
        ).toBe(false);
        await expect(
          supervisorWithAliveProcess.reactivateSession(
            "/tmp/test",
            "idle-alive-session-1",
          ),
        ).rejects.toThrow(
          /prior provider teardown is in progress or unverified/,
        );
        expect(startSession).toHaveBeenCalledOnce();

        releaseAbort?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(
          supervisorWithAliveProcess.getProcessForSession(
            "idle-alive-session-1",
          ),
        ).toBeUndefined();
        const abortedIndex = events.findIndex(
          (event) =>
            event.type === "session-aborted" &&
            event.sessionId === "idle-alive-session-1",
        );
        const releasedIndex = events.findIndex(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === "idle-alive-session-1" &&
            event.ownership.owner === "none",
        );
        expect(abortedIndex).toBeGreaterThanOrEqual(0);
        expect(releasedIndex).toBeGreaterThan(abortedIndex);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains a failed idle teardown until an explicit abort retry", async () => {
      vi.useFakeTimers();
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      try {
        let providerAlive = true;
        const queue = new MessageQueue();
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: "idle-failed-abort-session",
          };
          for await (const sdkMessage of queue) {
            void sdkMessage;
            if (!providerAlive) return;
            yield {
              type: "result" as const,
              session_id: "idle-failed-abort-session",
            };
          }
        }
        const abort = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(new Error("provider refused shutdown"))
          .mockImplementationOnce(async () => {
            providerAlive = false;
            queue.push({ text: "__abort__" });
          });
        const startSession = vi.fn(async () => ({
          iterator: iterator(),
          queue,
          abort,
          isProcessAlive: () => providerAlive,
        }));
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => {
          events.push(event);
        });
        const supervisorWithFailedAbort = new Supervisor({
          realSdk: { startSession },
          idleTimeoutMs: 100,
          eventBus,
        });

        const process = await supervisorWithFailedAbort.startSession(
          "/tmp/test",
          { text: "Retain this failed owner" },
        );
        await vi.waitFor(() => {
          expect(process.state.type).toBe("idle");
        });
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(0);

        expect(abort).toHaveBeenCalledOnce();
        expect(process.hasUnverifiedProviderOwnership).toBe(true);
        expect(process.state).toMatchObject({
          type: "terminated",
          reason: "idle reap provider teardown failed",
        });
        expect(
          supervisorWithFailedAbort.getProcessForSession(
            "idle-failed-abort-session",
          ),
        ).toBe(process);
        expect(
          events.some(
            (event) =>
              event.type === "session-status-changed" &&
              event.sessionId === "idle-failed-abort-session" &&
              event.ownership.owner === "none",
          ),
        ).toBe(false);
        await expect(
          supervisorWithFailedAbort.reactivateSession(
            "/tmp/test",
            "idle-failed-abort-session",
          ),
        ).rejects.toThrow(
          /prior provider teardown is in progress or unverified/,
        );
        expect(startSession).toHaveBeenCalledOnce();

        await expect(
          supervisorWithFailedAbort.abortProcessWithVerification(process.id),
        ).resolves.toMatchObject({
          processId: process.id,
          verifiedStopped: true,
          verification: "provider",
        });

        expect(abort).toHaveBeenCalledTimes(2);
        expect(
          supervisorWithFailedAbort.getProcessForSession(
            "idle-failed-abort-session",
          ),
        ).toBeUndefined();
        expect(
          events.filter(
            (event) =>
              event.type === "session-status-changed" &&
              event.sessionId === "idle-failed-abort-session" &&
              event.ownership.owner === "none",
          ),
        ).toHaveLength(1);
        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "lifecycle_teardown_failed",
            sessionId: "idle-failed-abort-session",
            reason: "idle reap provider teardown failed",
            errorMessage: "provider refused shutdown",
          }),
          "Provider teardown remains unverified: idle-failed-abort-session",
        );
      } finally {
        errorLog.mockRestore();
        vi.useRealTimers();
      }
    });

    it("does not run prompt-cache keepalive without a viewer lease", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        let resolveAbort!: () => void;
        const abortSignal = new Promise<void>((resolve) => {
          resolveAbort = resolve;
        });
        const refreshPromptCache = vi.fn(async () => ({
          mode: "no-context-pollution-nudge" as const,
          refreshed: true,
        }));
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: true,
          promptCacheKeepalive: {
            supportsNoContextPollutionNudge: true,
            defaultMode: "auto",
            defaultInactivityMinutes: 1,
          },
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "keepalive-no-viewer-session",
              };
              yield {
                type: "result",
                session_id: "keepalive-no-viewer-session",
              };
              await abortSignal;
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
                resolveAbort();
              },
              isProcessAlive: () => !aborted,
              refreshPromptCache,
            };
          },
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 10 * 60 * 1000,
          getPromptCacheKeepaliveSettings: () => ({
            enabled: true,
            inactivityMinutes: 1,
          }),
        });

        const created = await supervisorWithProvider.createSession("/tmp/test");
        if ("queued" in created || "error" in created) {
          throw new Error("Expected process");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(created.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(refreshPromptCache).not.toHaveBeenCalled();

        const abortPromise = supervisorWithProvider.abortProcess(created.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs prompt-cache keepalive only while a viewer lease is active", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        let resolveAbort!: () => void;
        const abortSignal = new Promise<void>((resolve) => {
          resolveAbort = resolve;
        });
        const refreshPromptCache = vi.fn(async () => ({
          mode: "no-context-pollution-nudge" as const,
          refreshed: true,
        }));
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: true,
          promptCacheKeepalive: {
            supportsNoContextPollutionNudge: true,
            defaultMode: "auto",
            defaultInactivityMinutes: 1,
          },
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "keepalive-viewer-session",
              };
              yield {
                type: "result",
                session_id: "keepalive-viewer-session",
              };
              await abortSignal;
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
                resolveAbort();
              },
              isProcessAlive: () => !aborted,
              refreshPromptCache,
            };
          },
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 10 * 60 * 1000,
          getPromptCacheKeepaliveSettings: () => ({
            enabled: true,
            inactivityMinutes: 1,
          }),
        });

        const created = await supervisorWithProvider.createSession("/tmp/test");
        if ("queued" in created || "error" in created) {
          throw new Error("Expected process");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(created.state.type).toBe("idle");
        const lastProviderMessageAt =
          created.getLivenessSnapshot().lastProviderMessageAt;

        const cleanup =
          supervisorWithProvider.registerPromptCacheKeepaliveViewer(created);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(refreshPromptCache).toHaveBeenCalledTimes(1);
        expect(created.getLivenessSnapshot().lastProviderMessageAt).toBe(
          lastProviderMessageAt,
        );

        cleanup();
        await vi.advanceTimersByTimeAsync(2 * 60_000);

        expect(refreshPromptCache).toHaveBeenCalledTimes(1);

        const abortPromise = supervisorWithProvider.abortProcess(created.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not count idle owned sessions as interruptible restart work", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "idle-owned-safe-restart-session",
              };
              yield {
                type: "result",
                session_id: "idle-owned-safe-restart-session",
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
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithIdleProcess = new Supervisor({
          realSdk,
          idleTimeoutMs: 10 * 60 * 1000,
        });

        const process = await supervisorWithIdleProcess.startSession(
          "/tmp/test",
          {
            text: "finish and stay idle",
          },
        );
        if (!("id" in process)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);

        expect(process.state.type).toBe("idle");
        expect(supervisorWithIdleProcess.getWorkerActivity()).toMatchObject({
          activeWorkers: 1,
          interruptibleSessionCount: 0,
          hasActiveWork: false,
        });

        const abortPromise = supervisorWithIdleProcess.abortProcess(process.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not count active reload-safe sessions as interruptible", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const queue = new MessageQueue();

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "active-reload-safe-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              detachForServerReload: async () => {},
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithReloadSafeProcess = new Supervisor({ realSdk });
        const process = await supervisorWithReloadSafeProcess.startSession(
          "/tmp/test",
          { text: "keep running across reload" },
        );
        if (!("id" in process)) {
          throw new Error("expected process");
        }

        queue.drain();
        expect(process.state.type).toBe("in-turn");
        expect(
          supervisorWithReloadSafeProcess.getWorkerActivity(),
        ).toMatchObject({
          activeWorkers: 1,
          interruptibleSessionCount: 0,
          hasActiveWork: false,
        });

        queue.push({ text: "queued input must block detach" });
        expect(
          supervisorWithReloadSafeProcess.getWorkerActivity(),
        ).toMatchObject({
          activeWorkers: 1,
          interruptibleSessionCount: 1,
          queuedSessionMessageCount: 1,
          hasActiveWork: true,
        });
        queue.drain();

        const abortPromise = supervisorWithReloadSafeProcess.abortProcess(
          process.id,
        );
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not terminate long-silent active sessions without liveness", async () => {
      vi.useFakeTimers();
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      try {
        let aborted = false;
        let resolveAbort!: () => void;
        const abortSignal = new Promise<void>((resolve) => {
          resolveAbort = resolve;
        });

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "silent-unknown-liveness-session",
              };

              await abortSignal;
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
                resolveAbort();
              },
            };
          },
        };

        const supervisorWithUnknownLiveness = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
        });

        const process = await supervisorWithUnknownLiveness.startSession(
          "/tmp/test",
          {
            text: "Run quietly",
          },
        );

        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

        expect(process.state.type).toBe("in-turn");
        expect(
          supervisorWithUnknownLiveness.getProcessForSession(
            "silent-unknown-liveness-session",
          ),
        ).toBe(process);
        expect(aborted).toBe(false);

        const abortPromise = supervisorWithUnknownLiveness.abortProcess(
          process.id,
        );
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(
          warn.mock.calls.map(
            ([fields]) => (fields as { event?: string }).event,
          ),
        ).toEqual([
          "stale_process_liveness_unknown",
          "stale_process_liveness_unknown",
        ]);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("terminal provider status retention", () => {
    it("keeps terminal status after the provider process is reaped", async () => {
      const controller = createControllableIterator();
      let providerAlive = true;
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession: async () => ({
          iterator: controller.iterator,
          queue: new MessageQueue(),
          abort: () => {
            providerAlive = false;
            controller.finish();
          },
          isProcessAlive: () => providerAlive,
        }),
      };
      const runtimeSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 20,
      });

      const process = await runtimeSupervisor.reactivateSession(
        "/tmp/test",
        "terminal-session",
        undefined,
        { providerName: "codex" },
      );

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "terminal-session",
        error: "Selected model is at capacity.",
        codexErrorInfo: "serverOverloaded",
        codexWillRetry: false,
        codexTurnId: "turn-1",
      });
      controller.push({ type: "result", session_id: "terminal-session" });

      await waitFor(() => {
        expect(
          runtimeSupervisor.getProviderRuntimeStatusForSession(
            "terminal-session",
          )?.kind,
        ).toBe("terminal");
      });
      await waitFor(() => {
        expect(
          runtimeSupervisor.getProcessForSession("terminal-session"),
        ).toBeUndefined();
      });

      expect(
        runtimeSupervisor.getProviderRuntimeStatusForSession(
          "terminal-session",
        ),
      ).toMatchObject({
        kind: "terminal",
        reason: "overloaded",
        turnId: "turn-1",
      });
      expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
    });

    it("clears retained terminal status when the next user turn begins", async () => {
      const controller = createControllableIterator();
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession: async () => ({
          iterator: controller.iterator,
          queue: new MessageQueue(),
          abort: () => controller.finish(),
          isProcessAlive: () => true,
        }),
      };
      const runtimeSupervisor = new Supervisor({ provider });

      await runtimeSupervisor.reactivateSession(
        "/tmp/test",
        "terminal-session",
        undefined,
        { providerName: "codex" },
      );

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "terminal-session",
        error: "Selected model is at capacity.",
        codexErrorInfo: "serverOverloaded",
        codexWillRetry: false,
        codexTurnId: "turn-1",
      });
      await waitFor(() => {
        expect(
          runtimeSupervisor.getProviderRuntimeStatusForSession(
            "terminal-session",
          )?.kind,
        ).toBe("terminal");
      });

      controller.push({
        type: "user",
        uuid: "user-turn-2",
        session_id: "terminal-session",
        message: { role: "user", content: "Try again" },
      });
      await waitFor(() => {
        expect(
          runtimeSupervisor.getProviderRuntimeStatusForSession(
            "terminal-session",
          ),
        ).toBe(null);
      });

      controller.finish();
    });
  });
});
