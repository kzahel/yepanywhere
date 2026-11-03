import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../src/metadata/index.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { PrepareSessionSandboxOptions } from "../src/session-sandbox.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";

// Every launch reaches prepareSessionSandbox with the level it will run
// under. A sandboxed request stops there, so no real Bubblewrap is needed;
// an unsandboxed one proceeds to the provider, which refuses it.
const sandboxRequests = vi.hoisted(() => [] as PrepareSessionSandboxOptions[]);
vi.mock("../src/session-sandbox.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/session-sandbox.js")>();
  return {
    ...actual,
    prepareSessionSandbox: async (options: PrepareSessionSandboxOptions) => {
      sandboxRequests.push(options);
      if (options.level === "project-write") {
        throw new Error("sandboxed-launch");
      }
      return undefined;
    },
  };
});

const SANDBOXED = "settled-sandboxed-session";
const PLAIN = "settled-plain-session";

function metadataService(): SessionMetadataService {
  const metadata: Record<string, object> = {
    [SANDBOXED]: {
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      sandboxStateKey: "project-settled",
      sandboxProjectPath: "/srv/sandboxed-project",
      createdByUser: "alice",
    },
    [PLAIN]: {},
  };
  return {
    getMetadata: (sessionId: string) => metadata[sessionId],
    getGoalCommand: () => undefined,
    getEffectiveLaunchSettings: () => undefined,
    getRequestedModel: () => undefined,
  } as unknown as SessionMetadataService;
}

function refusingProvider(): AgentProvider {
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
    startSession: async () => {
      throw new Error("unsandboxed-launch");
    },
  };
}

describe("Supervisor settled session sandbox", () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    sandboxRequests.length = 0;
    supervisor = new Supervisor({
      provider: refusingProvider(),
      sessionMetadataService: metadataService(),
      idleTimeoutMs: 60_000,
      getLimitedUserInstructions: (username) => ({
        startFromDefault: false,
        text: `Instructions for ${username}`,
      }),
    });
  });

  it.each([
    ["a wake with no launch settings", undefined],
    [
      "a heartbeat naming only provider and model",
      { providerName: "claude" as const, model: "opus" },
    ],
  ])("relaunches a sandboxed session sandboxed on %s", async (_, settings) => {
    await expect(
      supervisor.resumeSession(
        SANDBOXED,
        "/srv/working-copy",
        { text: "wake up", automaticSource: "wake" },
        undefined,
        settings,
      ),
    ).rejects.toThrow("sandboxed-launch");
    expect(sandboxRequests).toEqual([
      expect.objectContaining({
        level: "project-write",
        networkFirewall: true,
        stateKey: "project-settled",
        projectPath: "/srv/sandboxed-project",
        instructions: {
          startFromDefault: false,
          text: "Instructions for alice",
        },
      }),
    ]);
  });

  it("refuses a resume that would drop a settled sandbox", async () => {
    await expect(
      supervisor.resumeSession(
        SANDBOXED,
        "/srv/sandboxed-project",
        { text: "hi" },
        undefined,
        { sandboxLevel: "none" },
      ),
    ).rejects.toThrow(/keeps its settled sandbox/);
    await expect(
      supervisor.resumeSession(
        SANDBOXED,
        "/srv/sandboxed-project",
        { text: "hi" },
        undefined,
        { sandboxLevel: "project-write", sandboxNetworkFirewall: false },
      ),
    ).rejects.toThrow(/keeps its settled sandbox/);
    expect(sandboxRequests).toEqual([]);
  });

  it("refuses a reactivation override that would drop a settled sandbox", async () => {
    await expect(
      supervisor.reactivateSession(
        "/srv/sandboxed-project",
        SANDBOXED,
        undefined,
        { providerName: "claude" },
        {
          requestedOverrides: { modelSettings: { sandboxLevel: "none" } },
        },
      ),
    ).rejects.toThrow(/keeps its settled sandbox/);
    expect(sandboxRequests).toEqual([]);
  });

  it("reactivates a sandboxed session sandboxed without restated settings", async () => {
    await expect(
      supervisor.reactivateSession("/srv/working-copy", SANDBOXED, undefined, {
        providerName: "claude",
      }),
    ).rejects.toThrow("sandboxed-launch");
    expect(sandboxRequests).toEqual([
      expect.objectContaining({
        level: "project-write",
        stateKey: "project-settled",
        projectPath: "/srv/sandboxed-project",
      }),
    ]);
  });

  it("leaves an unsandboxed session's launch unchanged", async () => {
    await expect(
      supervisor.resumeSession(PLAIN, "/srv/plain", { text: "hi" }),
    ).rejects.toThrow("unsandboxed-launch");
    expect(sandboxRequests).toEqual([
      expect.objectContaining({ level: undefined, projectPath: "/srv/plain" }),
    ]);
  });

  it("resolves new-session instructions before ownership metadata exists", async () => {
    await expect(
      supervisor.startSession(
        "/srv/new-project",
        { text: "new initial request" },
        undefined,
        {
          providerName: "claude",
          sandboxLevel: "project-write",
          instructionUsername: "bobby",
        },
      ),
    ).rejects.toThrow("sandboxed-launch");
    expect(sandboxRequests[0]?.instructions).toEqual({
      startFromDefault: false,
      text: "Instructions for bobby",
    });
  });
});
