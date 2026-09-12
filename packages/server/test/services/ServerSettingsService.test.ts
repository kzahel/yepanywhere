import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROJECT_QUEUE_QUIET_SECONDS } from "@yep-anywhere/shared";
import {
  ServerSettingsService,
  CommittedSettingsSaveError,
  defaultLiveWorktreeMonitoringEnabled,
} from "../../src/services/ServerSettingsService.js";
import * as directorySync from "../../src/utils/syncDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

describe("ServerSettingsService", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-settings-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("uses continue as the default heartbeat turn text", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("continue");
  });

  it("does not fall back to defaults after a committed migration fails to sync", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: { serviceWorkerEnabled: false },
      }),
    );
    const service = new ServerSettingsService({
      dataDir: testDir,
      logger: { error: vi.fn() },
    });
    vi.spyOn(directorySync, "syncDirectory").mockRejectedValueOnce(
      new Error("disk I/O failure"),
    );
    await expect(service.initialize()).rejects.toBeInstanceOf(
      CommittedSettingsSaveError,
    );
    expect(() => service.getSettings()).toThrow("not initialized");
    await service.initialize();
    expect(service.getSetting("serviceWorkerEnabled")).toBe(false);
  });

  it("keeps committed settings and queued updates after a directory I/O failure", async () => {
    const error = vi.fn();
    const service = new ServerSettingsService({
      dataDir: testDir,
      logger: { error },
    });
    await service.initialize();
    const changed = vi.fn();
    service.onSettingsChanged(changed);
    const failure = Object.assign(new Error("disk I/O failure"), {
      code: "EIO",
    });
    vi.spyOn(directorySync, "syncDirectory").mockRejectedValueOnce(failure);
    const first = service.updateSettings({
      fileAccess: {
        projects: true,
        uploads: true,
        temp: true,
        home: false,
        custom: ["C:\\tmp", "D:\\code"],
      },
    });
    const second = service.updateSettings({ serviceWorkerEnabled: false });
    await expect(first).rejects.toBeInstanceOf(CommittedSettingsSaveError);
    await second;
    expect(changed).toHaveBeenCalledTimes(2);
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(service.getSetting("fileAccess")).toEqual(
      reloaded.getSetting("fileAccess"),
    );
    expect(service.getSetting("serviceWorkerEnabled")).toBe(false);
    expect(reloaded.getSetting("serviceWorkerEnabled")).toBe(false);
    expect(reloaded.getSetting("fileAccess")?.custom).toEqual([
      "C:\\tmp",
      "D:\\code",
    ]);
    expect(error).toHaveBeenCalledWith(
      "[ServerSettingsService] Failed to save settings:",
      failure,
    );
  });

  it("does not swallow a file fsync permission error or replace saved settings", async () => {
    const service = new ServerSettingsService({
      dataDir: testDir,
      logger: { error: vi.fn() },
    });
    await service.initialize();
    await service.updateSettings({ serviceWorkerEnabled: true });
    const originalOpen = fs.open;
    const failure = Object.assign(new Error("file fsync denied"), {
      code: "EPERM",
    });
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(
      service.updateSettings({ serviceWorkerEnabled: false }),
    ).rejects.toBe(failure);
    expect(service.getSetting("serviceWorkerEnabled")).toBe(true);
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("serviceWorkerEnabled")).toBe(true);
    expect(await fs.readdir(testDir)).toEqual(["server-settings.json"]);
  });

  it("preserves server-wide readiness configuration and explicit disabling across reloads", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    expect(service.getSetting("projectQueueReadinessCheck")).toBeUndefined();
    const command = { executable: "agentctl", args: ["others", "--text"] };
    await service.updateSettings({ projectQueueReadinessCheck: command });
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("projectQueueReadinessCheck")).toEqual(command);
    await reloaded.updateSettings({ projectQueueReadinessCheck: null });
    const disabled = new ServerSettingsService({ dataDir: testDir });
    await disabled.initialize();
    expect(disabled.getSetting("projectQueueReadinessCheck")).toBeNull();
  });

  it("denies the Claude Gateway Agent tool by default", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayDisableAgent")).toBe(true);
  });

  it("removes Claude Gateway plan-mode tools by default", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayDisablePlanMode")).toBe(true);
  });

  it("defaults subagent nesting to one level and preserves explicit unset", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("subagentMaxDepth")).toBe(1);
    await service.updateSettings({ subagentMaxDepth: null });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("subagentMaxDepth")).toBeNull();
  });

  it("normalizes invalid persisted subagent nesting to one level", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { subagentMaxDepth: 5 },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("subagentMaxDepth")).toBe(1);
  });

  it("keeps experimental workstreams disabled by default", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("workstreamsEnabled")).toBe(false);
  });

  it("defaults live worktree monitoring on only on Linux", () => {
    expect(defaultLiveWorktreeMonitoringEnabled("darwin")).toBe(false);
    expect(defaultLiveWorktreeMonitoringEnabled("linux")).toBe(true);
    expect(defaultLiveWorktreeMonitoringEnabled("win32")).toBe(false);
  });

  it("applies the platform monitoring default and persists an explicit choice", async () => {
    const platformDefault = defaultLiveWorktreeMonitoringEnabled();
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("liveWorktreeMonitoringEnabled")).toBe(
      platformDefault,
    );
    await service.updateSettings({
      liveWorktreeMonitoringEnabled: !platformDefault,
    });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("liveWorktreeMonitoringEnabled")).toBe(
      !platformDefault,
    );
  });

  it("normalizes invalid live worktree monitoring state to the platform default", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { liveWorktreeMonitoringEnabled: "yes" },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("liveWorktreeMonitoringEnabled")).toBe(
      defaultLiveWorktreeMonitoringEnabled(),
    );
  });

  it("defaults project writes to app data and tool media to on demand", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("projectDirectoryStorage")).toBe("app-data");
    expect(service.getSetting("toolResultMediaPreservation")).toBe("on-demand");

    await service.updateSettings({
      projectDirectoryStorage: "project",
      toolResultMediaPreservation: "preserve",
    });
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("projectDirectoryStorage")).toBe("project");
    expect(reloaded.getSetting("toolResultMediaPreservation")).toBe("preserve");
  });

  it("does not publish a storage mode whose durable write failed", async () => {
    const error = vi.fn();
    const service = new ServerSettingsService({
      dataDir: testDir,
      logger: { error },
    });
    await service.initialize();
    await service.updateSettings({ projectDirectoryStorage: "project" });

    const displaced = `${testDir}-before-failure`;
    await fs.rename(testDir, displaced);
    await fs.writeFile(testDir, "not a directory", "utf-8");
    try {
      await expect(
        service.updateSettings({ projectDirectoryStorage: "app-data" }),
      ).rejects.toBeTruthy();
      expect(service.getSetting("projectDirectoryStorage")).toBe("project");
      expect(error).toHaveBeenCalledWith(
        "[ServerSettingsService] Failed to save settings:",
        expect.any(Error),
      );
    } finally {
      await fs.rm(testDir);
      await fs.rename(displaced, testDir);
    }

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("projectDirectoryStorage")).toBe("project");
  });

  it("normalizes unknown storage policy values to safe defaults", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          projectDirectoryStorage: "both",
          toolResultMediaPreservation: "cache",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("projectDirectoryStorage")).toBe("app-data");
    expect(service.getSetting("toolResultMediaPreservation")).toBe("on-demand");
  });

  it("keeps reload-safe Codex sessions off by default and persists opt-in", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("codexReloadSafeSessions")).toBe(false);
    await service.updateSettings({ codexReloadSafeSessions: true });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("codexReloadSafeSessions")).toBe(true);
  });

  it("defaults Codex reasoning summaries to auto and persists a selection", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("codexReasoningSummary")).toBe("auto");
    await service.updateSettings({ codexReasoningSummary: "concise" });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("codexReasoningSummary")).toBe("concise");
  });

  it("normalizes an invalid persisted Codex reasoning summary to auto", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { codexReasoningSummary: "short" },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("codexReasoningSummary")).toBe("auto");
  });

  it("inherits the Codex plan-tool fallback until an override is saved", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("codexPlanToolMode")).toBeUndefined();
    await service.updateSettings({ codexPlanToolMode: "enabled" });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("codexPlanToolMode")).toBe("enabled");
  });

  it("drops an invalid persisted Codex plan-tool override", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { codexPlanToolMode: "sometimes" },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("codexPlanToolMode")).toBeUndefined();
  });

  it("inherits the Codex cyber access fallback until an override is saved", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("codexCyberAccessProgram")).toBeUndefined();
    await service.updateSettings({ codexCyberAccessProgram: "daybreak-blue" });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("codexCyberAccessProgram")).toBe(
      "daybreak-blue",
    );
  });

  it("drops an invalid persisted Codex cyber access override", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { codexCyberAccessProgram: "daybreak-purple" },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("codexCyberAccessProgram")).toBeUndefined();
  });

  it("defaults Claude steer backgrounding to every Bash command", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("claudeSteerBackgroundBash")).toEqual({
      allowRegex: ".*",
      denyRegex: "",
    });
  });

  it("fails closed for an invalid persisted Claude steer policy", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeSteerBackgroundBash: {
            allowRegex: "[",
            denyRegex: "",
          },
        },
      }),
    );

    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("claudeSteerBackgroundBash")).toEqual({
      allowRegex: "",
      denyRegex: "",
    });
  });

  it("leaves idle-reap hours absent until explicitly saved", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("idleReapHours")).toBeUndefined();

    await service.updateSettings({ idleReapHours: 2.5 });
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("idleReapHours")).toBe(2.5);
  });

  it("normalizes persisted negative idle-reap hours to Never", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { idleReapHours: -12 },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("idleReapHours")).toBe(-1);
  });

  it("drops persisted idle-reap hours above the supported range", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { idleReapHours: 73 },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("idleReapHours")).toBeUndefined();
  });

  it("normalizes malformed reload-safe Codex values to off", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: { codexReloadSafeSessions: "yes" },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("codexReloadSafeSessions")).toBe(false);
  });

  it("keeps source-review submissions off with an eight-turn response window", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("sourceReviewSubmissionsEnabled")).toBe(true);
    expect(service.getSetting("sourceReviewResponseTurns")).toBe(8);

    await service.updateSettings({
      sourceReviewSubmissionsEnabled: true,
      sourceReviewResponseTurns: 12,
    });
    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("sourceReviewSubmissionsEnabled")).toBe(true);
    expect(reloaded.getSetting("sourceReviewResponseTurns")).toBe(12);
  });

  it("normalizes malformed source-review settings to safe defaults", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          sourceReviewSubmissionsEnabled: "yes",
          sourceReviewResponseTurns: 33,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("sourceReviewSubmissionsEnabled")).toBe(true);
    expect(service.getSetting("sourceReviewResponseTurns")).toBe(8);
  });

  it("enables host process observability by default and persists opt-out", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("hostProcessObservabilityEnabled")).toBe(true);
    await service.updateSettings({ hostProcessObservabilityEnabled: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("hostProcessObservabilityEnabled")).toBe(false);
  });

  it("notifies process-local owners when live settings change", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    const changes: Array<{ current: boolean; previous: boolean }> = [];
    const unsubscribe = service.onSettingsChanged((settings, previous) => {
      changes.push({
        current: settings.hostProcessObservabilityEnabled,
        previous: previous.hostProcessObservabilityEnabled,
      });
    });

    await service.updateSettings({ hostProcessObservabilityEnabled: false });
    unsubscribe();
    await service.updateSettings({ hostProcessObservabilityEnabled: true });

    expect(changes).toEqual([{ current: false, previous: true }]);
  });

  it("normalizes malformed host process observability values to enabled", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          hostProcessObservabilityEnabled: "no",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostProcessObservabilityEnabled")).toBe(true);
  });

  it("keeps host-awake default-off with a ten-percent reserve", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostAwakeMode")).toBe("off");
    expect(service.getSetting("hostAwakeBatteryFloorPercent")).toBe(10);
  });

  it("normalizes invalid persisted host-awake values to safe defaults", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          hostAwakeMode: "always",
          hostAwakeBatteryFloorPercent: 0,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostAwakeMode")).toBe("off");
    expect(service.getSetting("hostAwakeBatteryFloorPercent")).toBe(10);
  });

  it("persists host identity across service instances", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ hostIdentity: { icon: "💻" } });
    await service.updateSettings({ serviceWorkerEnabled: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("hostIdentity")).toEqual({ icon: "💻" });
  });

  it("persists registry provenance without consulting the current catalog", async () => {
    const selection = {
      id: "claude-opus-4-5",
      label: "Opus 4.5",
      origin: "registry" as const,
    };
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ claudeAdditionalModels: [selection] });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeAdditionalModels")).toEqual([selection]);
  });

  it("persists the optional Claude Gateway start command", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({
      claudeGatewayStartCommand: "HOST=localhost gateway start",
    });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeGatewayStartCommand")).toBe(
      "HOST=localhost gateway start",
    );
  });

  it("persists an opt-out from the Claude Gateway Agent denial", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ claudeGatewayDisableAgent: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeGatewayDisableAgent")).toBe(false);
  });

  it("defaults malformed persisted Claude Gateway Agent denial values", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeGatewayDisableAgent: "false",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayDisableAgent")).toBe(true);
  });

  it("persists an opt-out from the Claude Gateway plan-mode exclusion", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ claudeGatewayDisablePlanMode: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeGatewayDisablePlanMode")).toBe(false);
  });

  it("defaults malformed persisted Gateway plan-mode exclusion values", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeGatewayDisablePlanMode: "false",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayDisablePlanMode")).toBe(true);
  });

  it("drops malformed persisted Claude Gateway start commands", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeGatewayStartCommand: 42,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayStartCommand")).toBeUndefined();
  });

  it("drops malformed persisted additional model settings", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeAdditionalModels: [
            {
              id: "model with spaces",
              label: "Invalid",
              origin: "custom",
            },
          ],
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeAdditionalModels")).toBeUndefined();
  });

  it.each(["heartbeat", "yepanywhere heartbeat"])(
    "migrates legacy built-in heartbeat turn text default %j",
    async (heartbeatTurnText) => {
      await fs.writeFile(
        path.join(testDir, "server-settings.json"),
        JSON.stringify({
          version: 1,
          settings: {
            heartbeatTurnText,
          },
        }),
        "utf-8",
      );
      const service = new ServerSettingsService({ dataDir: testDir });

      await service.initialize();

      expect(service.getSetting("heartbeatTurnText")).toBe("continue");
      const persisted = JSON.parse(
        await fs.readFile(path.join(testDir, "server-settings.json"), "utf-8"),
      ) as { settings: { heartbeatTurnText?: string }; version: number };
      expect(persisted.version).toBe(2);
      expect(persisted.settings.heartbeatTurnText).toBe("continue");
    },
  );

  it("preserves custom heartbeat turn text", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          heartbeatTurnText: "checking in",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("checking in");
  });

  it("folds legacy toolbar visibility/priority client defaults into presence", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          clientDefaults: {
            sessionToolbarVisibility: {
              slashMenu: false,
              renderMode: true,
            },
            sessionToolbarPriority: {
              slashMenu: "pin",
              renderMode: "last",
              contextUsage: "mid",
            },
          },
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    const clientDefaults = service.getSetting("clientDefaults") as Record<
      string,
      unknown
    >;
    // Explicit hide wins over the stored tier; other tiers carry over.
    expect(clientDefaults.sessionToolbarPresence).toEqual({
      slashMenu: "hidden",
      renderMode: "last",
      contextUsage: "mid",
    });
    expect(clientDefaults).not.toHaveProperty("sessionToolbarVisibility");
    expect(clientDefaults).not.toHaveProperty("sessionToolbarPriority");
  });

  it("prefers stored presence client defaults over legacy maps", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          clientDefaults: {
            sessionToolbarPresence: { slashMenu: "pin" },
            sessionToolbarVisibility: { slashMenu: false },
          },
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    const clientDefaults = service.getSetting("clientDefaults") as Record<
      string,
      unknown
    >;
    expect(clientDefaults.sessionToolbarPresence).toEqual({
      slashMenu: "pin",
    });
  });

  it("clamps oversized Project Queue quiet-window settings on load", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          projectQueueQuietSeconds: 999,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("projectQueueQuietSeconds")).toBe(
      MAX_PROJECT_QUEUE_QUIET_SECONDS,
    );
  });
});
