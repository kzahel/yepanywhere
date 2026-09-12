import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  NEVER_IDLE_REAP_HOURS,
} from "@yep-anywhere/shared";
import type { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import type { PublicShareService } from "../../src/services/PublicShareService.js";
import type { HostAwakeService } from "../../src/services/host-awake/HostAwakeService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";
import {
  DEFAULT_SERVER_SETTINGS,
  CommittedSettingsSaveError,
  MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH,
} from "../../src/services/ServerSettingsService.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("Settings Routes", () => {
  let settings: ServerSettings;
  let mockServerSettingsService: ServerSettingsService;

  beforeEach(() => {
    settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectDirectoryStorage: "app-data",
      toolResultMediaPreservation: "on-demand",
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      clientLogCollectionRequested: false,
      approvalAuditLogEnabled: false,
      speechAudioRetention: DEFAULT_SERVER_SETTINGS.speechAudioRetention,
      publicSharesEnabled: false,
      workstreamsEnabled: false,
      hostProcessObservabilityEnabled: true,
      hostAwakeMode: "off",
      hostAwakeBatteryFloorPercent: 10,
      codexReasoningSummary: "auto",
      codexReloadSafeSessions: false,
      claudeGatewayDisableAgent: true,
      claudeGatewayDisablePlanMode: true,
      subagentMaxDepth: 1,
    };

    mockServerSettingsService = {
      getSettings: vi.fn(() => settings),
      getSetting: vi.fn(
        <K extends keyof ServerSettings>(key: K): ServerSettings[K] =>
          settings[key],
      ),
      updateSettings: vi.fn(async (updates: Partial<ServerSettings>) => {
        settings = { ...settings, ...updates };
        return settings;
      }),
    } as unknown as ServerSettingsService;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies committed file access and completes a storage transition before reporting durability failure", async () => {
    const onFileAccessChanged = vi.fn();
    const completed = vi.fn();
    const failure = new Error("disk I/O failure");
    vi.mocked(mockServerSettingsService.updateSettings).mockImplementation(
      async (updates) => {
        settings = { ...settings, ...updates };
        throw new CommittedSettingsSaveError(settings, failure);
      },
    );
    const routes = createSettingsRoutes({
      serverSettingsService: mockServerSettingsService,
      onFileAccessChanged,
      projectStoragePolicy: {
        transitionMode: async (
          _mode: unknown,
          commit: () => Promise<ServerSettings>,
        ) => {
          const result = await commit();
          completed();
          return result;
        },
      } as unknown as ProjectStoragePolicy,
    });
    routes.onError((error, c) => c.json({ error: error.message }, 500));
    const fileAccess = {
      projects: true,
      uploads: true,
      temp: true,
      home: false,
      custom: ["C:\\tmp"],
    };
    const response = await routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileAccess, projectDirectoryStorage: "project" }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Settings were saved, but crash durability could not be confirmed",
    });
    expect(onFileAccessChanged).toHaveBeenCalledWith(fileAccess);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  describe("PUT /remote-executors", () => {
    it("rejects invalid host aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["  devbox  ", "gpu-server", "", "  "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.executors).toEqual(["devbox", "gpu-server"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        remoteExecutors: ["devbox", "gpu-server"],
      });
    });
  });

  describe("PUT /", () => {
    it("saves or disables the readiness executable and notifies after saving", async () => {
      const changed = vi.fn(() =>
        expect(settings.projectQueueReadinessCheck).toEqual(command),
      );
      let command: ServerSettings["projectQueueReadinessCheck"] = {
        executable: "/usr/bin/agentctl",
        args: ["others", "--text"],
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onProjectQueueReadinessChanged: changed,
      });
      for (const next of [command, null]) {
        command = next;
        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectQueueReadinessCheck: command }),
        });
        expect(response.status).toBe(200);
        expect(
          (await response.json()).settings.projectQueueReadinessCheck,
        ).toEqual(command);
      }
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it.each([
      "agentctl others",
      {},
      { executable: "", args: [] },
      { executable: "agentctl", args: "others" },
      { executable: "agentctl", args: [42] },
      { executable: "agentctl", args: ["bad\0arg"] },
      { executable: "agentctl", args: Array(129).fill("x") },
    ])("rejects malformed readiness config: %j", async (command) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectQueueReadinessCheck: command }),
      });
      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("bounds readiness arguments by UTF-8 bytes", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectQueueReadinessCheck: {
            executable: "agentctl",
            args: ["é".repeat(8193)],
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists the default-off session wake gate", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wakeTurnsEnabled: true }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        wakeTurnsEnabled: true,
      });
    });

    it.each([null, 0, 1, 4])(
      "persists valid subagent nesting depth %p",
      async (subagentMaxDepth) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subagentMaxDepth }),
        });

        expect(response.status).toBe(200);
        expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
          subagentMaxDepth,
        });
      },
    );

    it.each([-1, 5, 1.5, "1"])(
      "rejects invalid subagent nesting depth %p",
      async (subagentMaxDepth) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subagentMaxDepth }),
        });

        expect(response.status).toBe(400);
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("returns the effective idle-reap grace before it is persisted", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        getIdleReapHours: () => 7.5,
      });

      const response = await routes.request("/");

      expect(response.status).toBe(200);
      expect((await response.json()).settings.idleReapHours).toBe(7.5);
    });

    it("persists fractional idle-reap hours and applies them live", async () => {
      const onIdleReapHoursChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        getIdleReapHours: () => settings.idleReapHours ?? 24,
        onIdleReapHoursChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idleReapHours: 2.5 }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        idleReapHours: 2.5,
      });
      expect(onIdleReapHoursChanged).toHaveBeenCalledWith(2.5);
      expect((await response.json()).settings.idleReapHours).toBe(2.5);
    });

    it("normalizes negative idle-reap input to the Never notch", async () => {
      const onIdleReapHoursChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onIdleReapHoursChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idleReapHours: -12 }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        idleReapHours: NEVER_IDLE_REAP_HOURS,
      });
      expect(onIdleReapHoursChanged).toHaveBeenCalledWith(
        NEVER_IDLE_REAP_HOURS,
      );
    });

    it.each([73, "24", null])(
      "rejects invalid idle-reap input %p",
      async (idleReapHours) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });
        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idleReapHours }),
        });

        expect(response.status).toBe(400);
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("updates the two independent storage policies", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDirectoryStorage: "project",
          toolResultMediaPreservation: "preserve",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          projectDirectoryStorage: "project",
          toolResultMediaPreservation: "preserve",
        }),
      );
    });

    it("prepares project storage before persisting its new mode", async () => {
      const events: string[] = [];
      mockServerSettingsService.updateSettings = vi.fn(
        async (updates: Partial<ServerSettings>) => {
          events.push(`persist:${updates.projectDirectoryStorage}`);
          settings = { ...settings, ...updates };
          return settings;
        },
      );
      const projectStoragePolicy = {
        transitionMode: vi.fn(
          async <T>(targetMode: string, commit: () => Promise<T>) => {
            events.push(`prepare:${targetMode}`);
            const result = await commit();
            events.push(`committed:${targetMode}`);
            return result;
          },
        ),
      } as unknown as ProjectStoragePolicy;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        projectStoragePolicy,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDirectoryStorage: "project" }),
      });

      expect(response.status).toBe(200);
      expect(events).toEqual([
        "prepare:project",
        "persist:project",
        "committed:project",
      ]);
    });

    it("serializes an explicit switch back despite a stale pre-queue mode", async () => {
      const firstTransitionStarted = deferred();
      const releaseFirstTransition = deferred();
      let transitionTail = Promise.resolve();
      const projectStoragePolicy = {
        transitionMode: vi.fn(
          <T>(targetMode: string, commit: () => Promise<T>): Promise<T> => {
            const operation = transitionTail.then(async () => {
              if (targetMode === "project") {
                firstTransitionStarted.resolve();
                await releaseFirstTransition.promise;
              }
              return commit();
            });
            transitionTail = operation.then(
              () => undefined,
              () => undefined,
            );
            return operation;
          },
        ),
      } as unknown as ProjectStoragePolicy;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        projectStoragePolicy,
      });

      const switchToProject = routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDirectoryStorage: "project" }),
      });
      await firstTransitionStarted.promise;
      const switchBack = routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDirectoryStorage: "app-data" }),
      });
      releaseFirstTransition.resolve();

      const responses = await Promise.all([switchToProject, switchBack]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(projectStoragePolicy.transitionMode).toHaveBeenCalledTimes(2);
      expect(projectStoragePolicy.transitionMode).toHaveBeenNthCalledWith(
        1,
        "project",
        expect.any(Function),
      );
      expect(projectStoragePolicy.transitionMode).toHaveBeenNthCalledWith(
        2,
        "app-data",
        expect.any(Function),
      );
      expect(settings.projectDirectoryStorage).toBe("app-data");
    });

    it.each([
      { projectDirectoryStorage: "both" },
      { toolResultMediaPreservation: "cache" },
    ])("rejects invalid storage settings %j", async (body) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });
    it.each(["auto", "concise", "detailed", "none"] as const)(
      "persists the %s Codex reasoning-summary mode",
      async (codexReasoningSummary) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexReasoningSummary }),
        });

        expect(response.status).toBe(200);
        expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
          codexReasoningSummary,
        });
      },
    );

    it.each(["short", "off", "", null, true])(
      "rejects invalid Codex reasoning-summary mode %j",
      async (codexReasoningSummary) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexReasoningSummary }),
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain(
          "codexReasoningSummary",
        );
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it.each(["provider-default", "disabled", "enabled"] as const)(
      "persists the %s Codex plan-tool mode",
      async (codexPlanToolMode) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexPlanToolMode }),
        });

        expect(response.status).toBe(200);
        expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
          codexPlanToolMode,
        });
      },
    );

    it("clears the Codex plan-tool mode to its startup fallback", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexPlanToolMode: null }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        codexPlanToolMode: undefined,
      });
    });

    it.each(["sometimes", "", true, 1])(
      "rejects invalid Codex plan-tool mode %j",
      async (codexPlanToolMode) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexPlanToolMode }),
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("codexPlanToolMode");
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("persists the reload-safe Codex opt-in", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexReloadSafeSessions: true }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        codexReloadSafeSessions: true,
      });
    });

    it("rejects a non-boolean reload-safe Codex setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexReloadSafeSessions: "yes" }),
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "codexReloadSafeSessions",
      );
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it.each(["off", "before", "after"] as const)(
      "persists the %s turn-timestamp placement",
      async (turnTimestamps) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnTimestamps }),
        });

        expect(response.status).toBe(200);
        expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
          turnTimestamps,
        });
      },
    );

    it.each(["sometimes", "", null, true, { placement: "before" }])(
      "rejects invalid turn-timestamp placement %j",
      async (turnTimestamps) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnTimestamps }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "turnTimestamps must be one of: off, before, after",
        });
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("persists a host process observability opt-out", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostProcessObservabilityEnabled: false }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        hostProcessObservabilityEnabled: false,
      });
    });

    it("rejects a non-boolean host process observability setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostProcessObservabilityEnabled: "yes" }),
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "hostProcessObservabilityEnabled",
      );
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it.each([
      [{ hostAwakeMode: "always" }, "hostAwakeMode"],
      [{ hostAwakeBatteryFloorPercent: 10.5 }, "hostAwakeBatteryFloorPercent"],
      [{ hostAwakeBatteryFloorPercent: 0 }, "hostAwakeBatteryFloorPercent"],
    ])("rejects invalid host-awake settings %j", async (body, errorField) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService: {} as HostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(errorField);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("does not persist an unsupported host-awake enable request", async () => {
      const status = {
        requestedMode: "off" as const,
        state: "unsupported" as const,
        platform: "linux",
        support: {
          idleSleepPrevention: false,
          batteryFloor: false,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: "unknown" as const,
        batteryFloorPercent: 10,
        reason: "Host-awake control is unavailable on this server",
      };
      const hostAwakeService = {
        checkSupport: vi.fn(async () => ({ ok: false, status })),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAwakeMode: "idle" }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).status).toEqual(status);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists and applies a supported host-awake request live", async () => {
      const activeStatus = {
        requestedMode: "idle" as const,
        state: "active" as const,
        platform: "darwin",
        support: {
          idleSleepPrevention: true,
          batteryFloor: true,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: true,
        powerSource: "external" as const,
        batteryPercent: 80,
        powerObservedAt: 123,
        batteryFloorPercent: 15,
      };
      const hostAwakeService = {
        checkSupport: vi.fn(async () => ({
          ok: true,
          status: { ...activeStatus, requestedMode: "off", state: "disabled" },
        })),
        apply: vi.fn(async () => activeStatus),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostAwakeMode: "idle",
          hostAwakeBatteryFloorPercent: 15,
        }),
      });

      expect(response.status).toBe(200);
      expect(hostAwakeService.apply).toHaveBeenCalledWith("idle", 15);
      expect((await response.json()).hostAwakeStatus).toEqual(activeStatus);
    });

    it("accepts and normalizes a host identity marker", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: { icon: " ❤️ " } }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        hostIdentity: { icon: "❤️" },
      });
    });

    it("clears a host identity marker", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: null }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        hostIdentity: undefined,
      });
    });

    it("rejects invalid host identity markers", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: { icon: "💻❤️" } }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts clearing globalInstructions with null", async () => {
      settings = {
        ...settings,
        globalInstructions: "Existing instructions",
      };

      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalInstructions: null,
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.globalInstructions).toBeUndefined();
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        globalInstructions: undefined,
      });
    });

    it("accepts agent context hint settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentContextHints: { latexMathRendering: true },
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.agentContextHints).toEqual({
        latexMathRendering: true,
      });
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        agentContextHints: { latexMathRendering: true },
      });
    });

    it("rejects invalid agent context hint settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentContextHints: { latexMathRendering: "yes" },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid agentContextHints setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid aliases in remoteExecutors setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteExecutors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["  chromeroot  ", "lab-book", "", " "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.chromeOsHosts).toEqual(["chromeroot", "lab-book"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        chromeOsHosts: ["chromeroot", "lab-book"],
      });
    });

    it("rejects invalid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["chromeroot", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid ChromeOS host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts lifecycle webhook settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lifecycleWebhooksEnabled: true,
          lifecycleWebhookUrl: "https://example.com/hook",
          lifecycleWebhookToken: "secret",
          lifecycleWebhookDryRun: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookToken: "secret",
        lifecycleWebhookDryRun: false,
      });
    });

    it("accepts server-requested client log collection", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientLogCollectionRequested: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientLogCollectionRequested: true,
      });
    });

    it("accepts approval audit log settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalAuditLogEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        approvalAuditLogEnabled: true,
      });
    });

    it("accepts the experimental workstreams gate", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workstreamsEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        workstreamsEnabled: true,
      });
    });

    it("accepts the experimental live worktree monitoring gate", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveWorktreeMonitoringEnabled: true }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        liveWorktreeMonitoringEnabled: true,
      });
    });

    it("rejects a non-boolean live worktree monitoring gate", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveWorktreeMonitoringEnabled: "yes" }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts the source-review opt-in and bounded response turns", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceReviewSubmissionsEnabled: true,
          sourceReviewResponseTurns: 16,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        sourceReviewSubmissionsEnabled: true,
        sourceReviewResponseTurns: 16,
      });
    });

    it.each([
      { sourceReviewSubmissionsEnabled: "yes" },
      { sourceReviewResponseTurns: 0 },
      { sourceReviewResponseTurns: 33 },
      { sourceReviewResponseTurns: 1.5 },
    ])("rejects invalid source-review settings %j", async (body) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts Project Queue quiet-window settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectQueueQuietSeconds: 45,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        projectQueueQuietSeconds: 45,
      });
    });

    it("rejects out-of-range Project Queue quiet-window settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectQueueQuietSeconds: MAX_PROJECT_QUEUE_QUIET_SECONDS + 1,
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts Grok Build XAI_API_KEY opt-in setting", async () => {
      const onGrokBuildUseXaiApiKeyChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onGrokBuildUseXaiApiKeyChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grokBuildUseXaiApiKey: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        grokBuildUseXaiApiKey: true,
      });
      expect(onGrokBuildUseXaiApiKeyChanged).toHaveBeenCalledWith(true);
    });

    it("normalizes and applies a Claude gateway URL live", async () => {
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeGatewayUrl: "  http://localhost:4141/  ",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayUrl: "http://localhost:4141",
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: "http://localhost:4141",
        startCommand: undefined,
        disableAgent: true,
        disablePlanMode: true,
      });
    });

    it("persists and applies a Claude gateway start command live", async () => {
      settings = {
        ...settings,
        claudeGatewayUrl: "http://localhost:4141",
      };
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeGatewayStartCommand: "  HOST=localhost gateway start  ",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayStartCommand: "HOST=localhost gateway start",
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: "http://localhost:4141",
        startCommand: "HOST=localhost gateway start",
        disableAgent: true,
        disablePlanMode: true,
      });
    });

    it("persists and applies the Claude Gateway Agent denial live", async () => {
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayDisableAgent: false }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayDisableAgent: false,
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: undefined,
        startCommand: undefined,
        disableAgent: false,
        disablePlanMode: true,
      });
    });

    it.each([null, "false", 0])(
      "rejects invalid Claude Gateway Agent denial %p",
      async (claudeGatewayDisableAgent) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claudeGatewayDisableAgent }),
        });

        expect(response.status).toBe(400);
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("persists and applies the Claude Gateway plan-mode exclusion live", async () => {
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayDisablePlanMode: false }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayDisablePlanMode: false,
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: undefined,
        startCommand: undefined,
        disableAgent: true,
        disablePlanMode: false,
      });
    });

    it.each([null, "false", 0])(
      "rejects invalid Claude Gateway plan-mode exclusion %p",
      async (claudeGatewayDisablePlanMode) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claudeGatewayDisablePlanMode }),
        });

        expect(response.status).toBe(400);
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["non-string", 42],
      [
        "too long",
        `gateway start ${"x".repeat(MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH)}`,
      ],
      ["NUL byte", "gateway\u0000start"],
    ])("rejects a %s Claude gateway start command", async (_case, command) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayStartCommand: command }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it.each([
      "ftp://localhost:4141",
      "http://user:secret@localhost:4141",
      "http://localhost:4141?token=secret",
      "http://localhost:4141#gateway",
      "localhost:4141",
    ])("rejects unsafe Claude gateway URL %s", async (claudeGatewayUrl) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayUrl }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("clears and applies the Claude gateway URL", async () => {
      settings = {
        ...settings,
        claudeGatewayUrl: "http://localhost:4141",
      };
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayUrl: null }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayUrl: undefined,
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: undefined,
        startCommand: undefined,
        disableAgent: true,
        disablePlanMode: true,
      });
    });

    it("accepts speech audio retention settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speechAudioRetention: {
            enabled: true,
            maxAgeDays: 56,
            maxBytes: 400 * 1024 * 1024,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        speechAudioRetention: {
          enabled: true,
          maxAgeDays: 56,
          maxBytes: 400 * 1024 * 1024,
        },
      });
    });

    it("rejects invalid speech audio retention settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speechAudioRetention: {
            enabled: true,
            maxAgeDays: 0,
            maxBytes: 400 * 1024 * 1024,
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("merges server-learned client defaults", async () => {
      settings = {
        ...settings,
        clientDefaults: {
          speech: {
            voiceInputEnabled: false,
          },
          busyComposerDefaultAction: "steer",
          collapsedComposerButton: "primary",
          sessionToolbarPresence: {
            microphone: "hidden",
            slashMenu: "hidden",
          },
        },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            speech: {
              speechMethod: "ya-grok",
              speechSmartTurnSettings: {
                enabled: true,
                threshold: 0.91,
                timeoutMs: 10000,
              },
            },
            sessionToolbarPresence: {
              microphone: "pin",
              waveform: "hidden",
            },
            busyComposerDefaultAction: "queue",
            collapsedComposerButton: "alternate",
            projectQueueCtrlEnterEnabled: false,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          speech: {
            voiceInputEnabled: false,
            speechMethod: "ya-grok",
            speechSmartTurnSettings: {
              enabled: true,
              threshold: 0.91,
              timeoutMs: 10000,
            },
          },
          busyComposerDefaultAction: "queue",
          collapsedComposerButton: "alternate",
          projectQueueCtrlEnterEnabled: false,
          sessionToolbarPresence: {
            microphone: "pin",
            waveform: "hidden",
            slashMenu: "hidden",
          },
        },
      });
    });

    it("rejects invalid server-learned client defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            collapsedComposerButton: "floating-action-button",
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists the default-off local command setting as a boolean", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { bangCommandsEnabled: true },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: { bangCommandsEnabled: true },
      });

      const invalid = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { bangCommandsEnabled: "yes" },
        }),
      });
      expect(invalid.status).toBe(400);
    });

    it("merges server-learned session toolbar presence", async () => {
      settings = {
        ...settings,
        clientDefaults: {
          sessionToolbarPresence: {
            modeSelector: "first",
            shortcutsHelp: "last",
          },
        },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            sessionToolbarPresence: {
              modeSelector: "hidden",
              attachments: "pin",
              projectQueueNewSessionShortcut: "hidden",
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          sessionToolbarPresence: {
            modeSelector: "hidden",
            attachments: "pin",
            shortcutsHelp: "last",
            projectQueueNewSessionShortcut: "hidden",
          },
        },
      });
    });

    it("rejects an invalid session toolbar presence value", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            sessionToolbarPresence: { modeSelector: "bogus" },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists per-model compact thresholds and drops out-of-range entries", async () => {
      settings = { ...settings, clientDefaults: undefined };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            // 150 means "off" for sonnet (>= 100) and is dropped.
            compactAtContextPercent: { opus: 20, sonnet: 150 },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      });
    });

    it("preserves compact thresholds when another client default changes", async () => {
      settings = {
        ...settings,
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { steerNowDefault: true },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          compactAtContextPercent: { opus: 20 },
          steerNowDefault: true,
        },
      });
    });

    it("clears compact thresholds when the map empties", async () => {
      settings = {
        ...settings,
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { compactAtContextPercent: {} },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: undefined,
      });
    });

    it("rejects non-numeric compact threshold values", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { compactAtContextPercent: { opus: "20" } },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists the global YA-orchestrated compaction override", async () => {
      settings = {
        ...settings,
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { forceYaOrchestratedCompaction: true },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          compactAtContextPercent: { opus: 20 },
          forceYaOrchestratedCompaction: true,
        },
      });
    });

    it("rejects a non-boolean YA compaction override", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { forceYaOrchestratedCompaction: "yes" },
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts provider-scoped prompt-cache keepalive settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptCacheKeepalive: {
            providers: {
              claude: {
                mode: "auto",
                inactivityMinutes: 40,
              },
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        promptCacheKeepalive: {
          providers: {
            claude: {
              mode: "auto",
              inactivityMinutes: 40,
            },
          },
        },
      });
    });

    it("accepts provider-scoped cache-billing freshness windows", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cacheMissBilling: {
            enabled: true,
            showToasts: true,
            providerFreshWindowMinutes: {
              claude: 60,
              codex: 10,
            },
            minimumWastedTokens: 25_000,
            recentActivityMinutes: 5,
            ignoreAfterMinutes: 45,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        cacheMissBilling: {
          enabled: true,
          showToasts: true,
          freshWindowMinutes: 60,
          providerFreshWindowMinutes: {
            claude: 60,
            codex: 10,
          },
          minimumWastedTokens: 25_000,
          recentActivityMinutes: 5,
          ignoreAfterMinutes: 45,
        },
      });
    });

    it("rejects invalid cache-billing freshness windows", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cacheMissBilling: {
            providerFreshWindowMinutes: {
              unknown: 10,
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("cacheMissBilling must use booleans");
      expect(json.error).toContain("minimumWastedTokens 1-5000000");
      expect(json.error).toContain(
        "freshWindowMinutes and providerFreshWindowMinutes 1-1440",
      );
      expect(json.error).toContain(
        "recentActivityMinutes and ignoreAfterMinutes 0-1440",
      );
      expect(json.error).not.toContain("minimumInputTokens");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts provider-scoped new-session defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            provider: "codex",
            model: "legacy-codex",
            serviceTier: "legacy-priority",
            sandboxLevel: "project-write",
            sandboxNetworkFirewall: false,
            providers: {
              claude: {
                model: "opus",
                thinkingMode: "on",
                effortLevel: "high",
                helperSideModel: "haiku",
              },
              codex: {
                model: "gpt-5.5",
                serviceTier: "priority",
                thinkingMode: "auto",
                effortLevel: "xhigh",
                helperSideModel: "helper-target:local-vllm",
              },
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        newSessionDefaults: {
          provider: "codex",
          model: "legacy-codex",
          serviceTier: "legacy-priority",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
          providers: {
            claude: {
              model: "opus",
              thinkingMode: "on",
              effortLevel: "high",
              helperSideModel: "haiku",
            },
            codex: {
              model: "gpt-5.5",
              serviceTier: "priority",
              thinkingMode: "auto",
              effortLevel: "xhigh",
              helperSideModel: "helper-target:local-vllm",
            },
          },
        },
      });
    });

    it("rejects an invalid new-session sandbox default", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            sandboxLevel: "home-write",
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid newSessionDefaults setting",
      });
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects a network firewall default without project sandboxing", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            sandboxLevel: "none",
            sandboxNetworkFirewall: true,
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid newSessionDefaults setting",
      });
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts exact opt-in Claude model selections", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const selections = [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          origin: "registry",
        },
        {
          id: "claude-future-6[1m]",
          label: "claude-future-6[1m]",
          origin: "custom",
        },
      ];

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAdditionalModels: selections }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeAdditionalModels: selections,
      });
    });

    it("rejects duplicate opt-in Claude model ids", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeAdditionalModels: [
            { id: "same", label: "Same", origin: "custom" },
            { id: "same", label: "Same again", origin: "custom" },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid claudeAdditionalModels setting",
      });
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and clears the global Claude auto-compaction override", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const enabled = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAutoCompactPercentOverride: 60 }),
      });
      expect(enabled.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenLastCalledWith(
        {
          claudeAutoCompactPercentOverride: 60,
        },
      );

      const cleared = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAutoCompactPercentOverride: 0 }),
      });
      expect(cleared.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenLastCalledWith(
        {
          claudeAutoCompactPercentOverride: undefined,
        },
      );
    });

    it.each([101, -1, 50.5, "50"])(
      "rejects invalid Claude auto-compaction override %p",
      async (claudeAutoCompactPercentOverride) => {
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
        });

        const response = await routes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claudeAutoCompactPercentOverride }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error:
            "claudeAutoCompactPercentOverride must be an integer from 1 to 100, or 0/null to clear",
        });
        expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
      },
    );

    it("accepts the Claude steer foreground-Bash policy", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const policy = {
        allowRegex: ".*agentctl watch.*",
        denyRegex: ".*--exclusive.*",
      };

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSteerBackgroundBash: policy }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenLastCalledWith(
        { claudeSteerBackgroundBash: policy },
      );
    });

    it.each([
      { allowRegex: "[", denyRegex: "" },
      { allowRegex: "(?=unsafe)", denyRegex: "" },
      { allowRegex: "(unsafe)\\1", denyRegex: "" },
      { allowRegex: ".*" },
      { allowRegex: ".*", denyRegex: "", extra: true },
    ])("rejects invalid Claude steer Bash policy %j", async (policy) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSteerBackgroundBash: policy }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "claudeSteerBackgroundBash must contain valid allowRegex and denyRegex strings",
      });
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid provider-scoped helper model defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            providers: {
              claude: { helperSideModel: { id: "haiku" } },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid newSessionDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid provider-scoped new-session defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            providers: {
              claude: { effortLevel: "extreme" },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid newSessionDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid prompt-cache keepalive settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptCacheKeepalive: {
            providers: {
              claude: {
                mode: "hidden-message",
                inactivityMinutes: 0,
              },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("promptCacheKeepalive must configure");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts public share feature gating", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: true,
      });
    });

    it("accepts and normalizes bare YA client hosts", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: "ya.graehl.org",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: "https://ya.graehl.org",
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("accepts legacy public share viewer base URLs", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicShareViewerBaseUrl: "https://example.com/remote/share/",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: "https://example.com/remote",
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("clears YA client base URL for default hosted client", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: null,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: undefined,
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("rejects YA client URLs with query strings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: "https://example.com?x=1",
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("revokes stored public shares when disabling the feature", async () => {
      const disableAndRevoke = vi.fn(async () => 2);
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        publicShareService: {
          disableAndRevoke,
        } as unknown as PublicShareService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: false,
      });
      expect(disableAndRevoke).toHaveBeenCalled();
    });

    it("disables public shares before a later compound effect fails", async () => {
      settings = { ...settings, publicSharesEnabled: true };
      const events: string[] = [];
      let disableMarkerPresent = false;
      let grantPresent = true;
      mockServerSettingsService.updateSettings = vi.fn(
        async (updates: Partial<ServerSettings>) => {
          settings = { ...settings, ...updates };
          events.push(`persist:${updates.publicSharesEnabled}`);
          return settings;
        },
      );
      const disableAndRevoke = vi.fn(async () => {
        events.push("shares:disable");
        disableMarkerPresent = true;
        grantPresent = false;
        return 1;
      });
      const enable = vi.fn(async () => {
        events.push("shares:enable");
        if (!disableMarkerPresent) {
          grantPresent = true;
        }
        disableMarkerPresent = false;
      });
      const onRemoteSessionPersistenceChanged = vi.fn(async () => {
        events.push("remote-persistence:fail");
        throw new Error("remote persistence failed");
      });
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onRemoteSessionPersistenceChanged,
        publicShareService: {
          disableAndRevoke,
          enable,
        } as unknown as PublicShareService,
      });
      routes.onError((error, c) => c.json({ error: error.message }, 500));

      const disabling = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: false,
          persistRemoteSessionsToDisk: true,
        }),
      });

      expect(disabling.status).toBe(500);
      expect(await disabling.json()).toEqual({
        error: "remote persistence failed",
      });
      expect(settings.publicSharesEnabled).toBe(false);
      expect(events).toEqual([
        "persist:false",
        "shares:disable",
        "remote-persistence:fail",
      ]);

      const enabling = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicSharesEnabled: true }),
      });

      expect(enabling.status).toBe(200);
      expect(events).toEqual([
        "persist:false",
        "shares:disable",
        "remote-persistence:fail",
        "persist:true",
        "shares:enable",
      ]);
      expect(grantPresent).toBe(false);
    });

    it.each([
      [false, true],
      [true, false],
    ] as const)(
      "serializes public-share persistence and effects for %s then %s",
      async (firstEnabled, secondEnabled) => {
        const gates = [deferred(), deferred()];
        const events: string[] = [];
        let _update = 0;
        mockServerSettingsService.updateSettings = vi.fn(
          async (updates: Partial<ServerSettings>) => {
            const enabled = updates.publicSharesEnabled;
            events.push(`persist:start:${enabled}`);
            await gates[_update++]!.promise;
            settings = { ...settings, ...updates };
            events.push(`persist:done:${enabled}`);
            return settings;
          },
        );
        const disableAndRevoke = vi.fn(async () => {
          events.push("effect:false");
          return 0;
        });
        const enable = vi.fn(async () => {
          events.push("effect:true");
        });
        const routes = createSettingsRoutes({
          serverSettingsService: mockServerSettingsService,
          publicShareService: {
            disableAndRevoke,
            enable,
          } as unknown as PublicShareService,
        });
        const request = (enabled: boolean) =>
          routes.request("/", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicSharesEnabled: enabled }),
          });

        const first = request(firstEnabled);
        const second = request(secondEnabled);
        await vi.waitFor(() => {
          expect(events).toEqual([`persist:start:${firstEnabled}`]);
        });

        gates[0]!.resolve();
        await expect(first).resolves.toMatchObject({ status: 200 });
        await vi.waitFor(() => {
          expect(events).toEqual([
            `persist:start:${firstEnabled}`,
            `persist:done:${firstEnabled}`,
            `effect:${firstEnabled}`,
            `persist:start:${secondEnabled}`,
          ]);
        });

        gates[1]!.resolve();
        await expect(second).resolves.toMatchObject({ status: 200 });
        expect(events).toEqual([
          `persist:start:${firstEnabled}`,
          `persist:done:${firstEnabled}`,
          `effect:${firstEnabled}`,
          `persist:start:${secondEnabled}`,
          `persist:done:${secondEnabled}`,
          `effect:${secondEnabled}`,
        ]);
      },
    );

    it("keeps remote-executor persistence behind an in-flight share disable", async () => {
      const disableGate = deferred();
      const events: string[] = [];
      mockServerSettingsService.updateSettings = vi.fn(
        async (updates: Partial<ServerSettings>) => {
          events.push(
            "publicSharesEnabled" in updates
              ? `persist:shares:${updates.publicSharesEnabled}`
              : `persist:executors:${updates.remoteExecutors?.join(",")}`,
          );
          settings = { ...settings, ...updates };
          return settings;
        },
      );
      const disableAndRevoke = vi.fn(async () => {
        events.push("disable:start");
        await disableGate.promise;
        events.push("disable:done");
        return 0;
      });
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        publicShareService: {
          disableAndRevoke,
        } as unknown as PublicShareService,
      });

      const disabling = routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicSharesEnabled: false }),
      });
      await vi.waitFor(() => {
        expect(events).toEqual(["persist:shares:false", "disable:start"]);
      });
      const updatingExecutors = routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executors: ["worker-one"] }),
      });
      await Promise.resolve();
      expect(events).toEqual(["persist:shares:false", "disable:start"]);

      disableGate.resolve();
      await expect(disabling).resolves.toMatchObject({ status: 200 });
      await expect(updatingExecutors).resolves.toMatchObject({ status: 200 });
      expect(events).toEqual([
        "persist:shares:false",
        "disable:start",
        "disable:done",
        "persist:executors:worker-one",
      ]);
    });

    it("accepts and normalizes helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "local-vllm",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
              model: "",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.helperTargets).toEqual([
        {
          id: "local-vllm",
          name: "Local vLLM",
          kind: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      ]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        helperTargets: [
          {
            id: "local-vllm",
            name: "Local vLLM",
            kind: "openai-compatible",
            baseUrl: "http://localhost:8001/v1",
          },
        ],
      });
    });

    it("rejects invalid helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "bad/id",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid helperTargets setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("GET /host-awake/status", () => {
    it("returns the process-global host status", async () => {
      const status = {
        requestedMode: "off" as const,
        state: "disabled" as const,
        platform: "win32",
        support: {
          idleSleepPrevention: true,
          batteryFloor: true,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: false,
        powerSource: "external" as const,
        powerObservedAt: 123,
        batteryFloorPercent: 10,
      };
      const hostAwakeService = {
        getStatus: vi.fn(async () => status),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/host-awake/status?refresh=1");

      expect(response.status).toBe(200);
      expect(hostAwakeService.getStatus).toHaveBeenCalledWith({
        forceRefresh: true,
      });
      expect(await response.json()).toEqual({ status });
    });
  });

  describe("POST /helper-targets/models", () => {
    it("discovers OpenAI-compatible model ids through the server", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "Qwen/Qwen3.6-27B",
                  max_model_len: 161072,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "localhost:8001" }),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8001/v1/models",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      const json = await response.json();
      expect(json).toEqual({
        baseUrl: "http://localhost:8001/v1",
        models: [
          {
            id: "Qwen/Qwen3.6-27B",
            name: "Qwen/Qwen3.6-27B",
            contextWindow: 161072,
          },
        ],
      });
    });

    it("rejects invalid helper target discovery URLs", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "file:///etc/passwd" }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("baseUrl must be an http(s) URL");
    });
  });

  describe("POST /remote-executors/:host/test", () => {
    it("rejects invalid host path parameters", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const invalidHost = encodeURIComponent("-oProxyCommand=touch_/tmp/pwned");

      const response = await routes.request(
        `/remote-executors/${invalidHost}/test`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("host must be a valid SSH host alias");
    });
  });
});
