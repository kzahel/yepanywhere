import {
  type UrlProjectId,
  buildEffectiveAgentContext,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

// Characterization for the session-launch service plan (doc 177, step 2):
// restart handoff, restart fork and the stale-session handoff each build the
// Supervisor launch settings of a successor session. These pin the exact
// settings object and permission mode each passes, including the
// compact-window fallback models, so the shared assembly cannot drop or remap
// a field. `toEqual` ignores keys whose value is undefined, so those are
// pinned only as absent values.

const project: Project = {
  id: "proj-1" as UrlProjectId,
  path: "/tmp/project",
  name: "project",
  sessionCount: 1,
  sessionDir: "/tmp/project/.claude-sessions",
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
  provider: "claude",
};

const GLOBAL_INSTRUCTIONS = "Prefer small commits.";
const expectedGlobalInstructions = buildEffectiveAgentContext({
  globalInstructions: GLOBAL_INSTRUCTIONS,
  hints: undefined,
});

/** A source whose every inherited launch field is distinguishable. */
const unsandboxedSource = {
  customTitle: "Refactor session",
  promptSuggestionMode: "native",
  recapMode: "native",
  recapAfterSeconds: 300,
  effectiveLaunchSettings: {
    schemaVersion: 1,
    revision: 2,
    permissionMode: "bypassPermissions",
    requestedModel: "settings-model",
    serviceTier: "flex",
    thinking: { type: "adaptive" },
    effort: "high",
  },
};

/** The same source in a project-write sandbox with the firewall on. */
const sandboxedSource = {
  ...unsandboxedSource,
  sandboxLevel: "project-write",
  sandboxStateKey: "source-sandbox",
  sandboxProjectPath: "/tmp/project-sandbox",
};

/**
 * Context windows by model. The YA model ids have a stored compact percent
 * but no known window, so each path's fallback model list decides the
 * window.
 */
const contextWindows: Record<string, number> = {
  "live-model": 400_000,
  "transcript-model": 300_000,
};

/** A reader whose transcript ran a model other than the live process's. */
function transcriptReader(): ISessionReader {
  const summary = {
    id: "sess-1",
    projectId: project.id,
    title: "Refactor session",
    fullTitle: "Refactor session",
    createdAt: "2026-04-24T20:00:00.000Z",
    updatedAt: "2026-04-24T20:00:01.000Z",
    messageCount: 0,
    ownership: { owner: "none" },
    provider: "claude",
    model: "transcript-model",
  };
  return {
    getSessionSummary: vi.fn(async () => summary),
    getSession: vi.fn(async () => ({
      summary,
      data: { provider: "claude", session: { messages: [] } },
    })),
  } as unknown as ISessionReader;
}

function launchDeps(
  source: Record<string, unknown>,
  supervisor: Record<string, unknown>,
  options: { reader?: () => ISessionReader; process?: unknown } = {},
): SessionsDeps {
  const process = "process" in options ? options.process : sourceProcess;
  return {
    supervisor: {
      getProcessForSession: vi.fn(() => process),
      interruptProcess: vi.fn(async () => ({ success: true, supported: true })),
      abortProcess: vi.fn(async () => true),
      ...supervisor,
    } as unknown as SessionsDeps["supervisor"],
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as SessionsDeps["scanner"],
    readerFactory: vi.fn(
      options.reader ??
        (() =>
          ({
            getSessionSummary: vi.fn(async () => null),
            getSession: vi.fn(async () => null),
          }) as unknown as ISessionReader),
    ),
    sessionMetadataService: {
      getProvider: vi.fn(() => "claude"),
      getRequestedModel: vi.fn(() => "legacy-model"),
      getExecutor: vi.fn(() => undefined),
      getMetadata: vi.fn(() => source),
      nextForkOrdinal: vi.fn(async () => ({
        ordinal: 1,
        lineageRootId: "sess-1",
      })),
      setProvider: vi.fn(async () => undefined),
      setRequestedModel: vi.fn(async () => undefined),
      setSessionSandbox: vi.fn(async () => undefined),
      updateMetadata: vi.fn(async () => undefined),
    } as unknown as NonNullable<SessionsDeps["sessionMetadataService"]>,
    serverSettingsService: {
      getSetting: vi.fn((key: string) => {
        if (key === "globalInstructions") return GLOBAL_INSTRUCTIONS;
        if (key === "claudeAutoCompactPercentOverride") return 85;
        if (key === "clientDefaults") {
          return {
            forceYaOrchestratedCompaction: true,
            compactAtContextPercent: {
              "settings-model": 60,
              "request-model": 70,
              "lock-model": 80,
            },
          };
        }
        return undefined;
      }),
    } as unknown as SessionsDeps["serverSettingsService"],
    modelInfoService: {
      getContextWindow: vi.fn((model: string) => contextWindows[model] ?? 0),
    } as unknown as SessionsDeps["modelInfoService"],
    eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
  };
}

const sourceProcess = {
  id: "proc-source",
  provider: "claude",
  model: "live-model",
  resolvedModel: "live-model",
  permissionMode: "default",
  modeVersion: 0,
  state: { type: "idle", since: new Date() },
  getMessageHistory: vi.fn(() => [
    {
      type: "user",
      uuid: "msg-user-initial",
      timestamp: "2026-04-24T20:00:00.000Z",
      message: { role: "user", content: "Fix the failing test." },
    },
  ]),
};

const startedProcess = (sessionId: string) => ({
  id: "proc-new",
  sessionId,
  projectId: project.id,
  projectPath: project.path,
  provider: "claude",
  model: "sonnet",
  resolvedModel: "sonnet",
  permissionMode: "default",
  modeVersion: 0,
  subscribe: vi.fn(() => vi.fn()),
});

const post = (path: string, body: unknown) =>
  [
    `/projects/${project.id}/sessions/sess-1/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ] as const;

/** Compact fields when the window falls back to the live process's model. */
const claudeCompact = (percent: number, window: number | undefined) => ({
  compactAtContextPercent: percent,
  compactAtContextWindow: window,
  forceYaOrchestratedCompaction: true,
  claudeAutoCompactPercentOverride: 85,
});

describe("successor launch settings", () => {
  it("restart handoff applies every request override over the source", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(unsandboxedSource, { startSession }),
    );

    const response = await routes.request(
      ...post("restart", {
        handoffText: "Continue the fix.",
        model: "request-model",
        thinking: "max",
        serviceTier: "priority",
        mode: "plan",
        permissions: { allow: ["Read"] },
        recapMode: "fork",
        recapAfterSeconds: 120,
        promptSuggestionMode: "off",
        helperSideModel: "haiku",
      }),
    );

    expect(response.status).toBe(200);
    expect(startSession).toHaveBeenCalledTimes(1);
    const [projectPath, message, permissionMode, settings] = startSession.mock
      .calls[0] as unknown[];
    expect(projectPath).toBe(project.path);
    expect(message).toEqual({ text: "Continue the fix.", mode: "plan" });
    expect(permissionMode).toBe("plan");
    expect(settings).toEqual({
      model: "request-model",
      requestedModel: "request-model",
      serviceTier: "priority",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "max",
      providerName: "claude",
      clientName: "yep-anywhere",
      executor: undefined,
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      globalInstructions: expectedGlobalInstructions,
      permissions: { allow: ["Read"] },
      recapMode: "fork",
      recapAfterSeconds: 120,
      promptSuggestionMode: "off",
      helperSideModel: "haiku",
      ...claudeCompact(70, 400_000),
    });
  });

  it("restart handoff inherits the source's settings and sandbox", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(
        sandboxedSource,
        { startSession },
        { reader: transcriptReader },
      ),
    );

    const response = await routes.request(
      ...post("restart", { handoffText: "Continue the fix." }),
    );

    expect(response.status).toBe(200);
    const [projectPath, message, permissionMode, settings] = startSession.mock
      .calls[0] as unknown[];
    expect(projectPath).toBe("/tmp/project-sandbox");
    expect(message).toEqual({
      text: "Continue the fix.",
      mode: "bypassPermissions",
    });
    expect(permissionMode).toBe("bypassPermissions");
    expect(settings).toEqual({
      model: "settings-model",
      requestedModel: "settings-model",
      serviceTier: "flex",
      thinking: { type: "adaptive" },
      effort: "high",
      providerName: "claude",
      clientName: "yep-anywhere",
      executor: undefined,
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      globalInstructions: expectedGlobalInstructions,
      permissions: undefined,
      recapMode: undefined,
      recapAfterSeconds: 300,
      promptSuggestionMode: "native",
      helperSideModel: undefined,
      ...claudeCompact(60, 400_000),
    });
  });

  it("cross-provider restart handoff drops the source's provider-local settings", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(unsandboxedSource, { startSession }),
    );

    const response = await routes.request(
      ...post("restart", {
        handoffText: "Continue the fix.",
        provider: "codex",
        model: "request-model",
      }),
    );

    expect(response.status).toBe(200);
    const [, , permissionMode, settings] = startSession.mock
      .calls[0] as unknown[];
    expect(permissionMode).toBe("bypassPermissions");
    expect(settings).toEqual({
      model: "request-model",
      requestedModel: "request-model",
      serviceTier: undefined,
      thinking: undefined,
      effort: undefined,
      providerName: "codex",
      clientName: "yep-anywhere",
      executor: undefined,
      sandboxLevel: "none",
      sandboxNetworkFirewall: false,
      globalInstructions: expectedGlobalInstructions,
      permissions: undefined,
      recapMode: undefined,
      recapAfterSeconds: 300,
      promptSuggestionMode: "native",
      helperSideModel: undefined,
      // Only the requested model is a window candidate across providers.
      compactAtContextPercent: 70,
      compactAtContextWindow: undefined,
      forceYaOrchestratedCompaction: true,
      claudeAutoCompactPercentOverride: undefined,
    });
  });

  it("restart fork resumes the fork with the source's settings and the fork's sandbox state", async () => {
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-fork",
      sandboxStateKey: "fork-sandbox",
    }));
    const resumeSession = vi.fn(async () => startedProcess("sess-fork"));
    const routes = createSessionsRoutes(
      launchDeps(sandboxedSource, {
        supportsForkSession: vi.fn(() => true),
        forkSession,
        resumeSession,
      }),
    );

    const response = await routes.request(
      ...post("restart", {
        restartMode: "fork",
        forkUpToMessageId: "msg-user-initial",
        recapAfterSeconds: 90,
      }),
    );

    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "claude",
        launchOverrides: {
          requestedModel: "settings-model",
          thinking: undefined,
          permissionMode: "bypassPermissions",
          serviceTier: undefined,
        },
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: true,
        sandboxStateKey: "source-sandbox",
      }),
    );
    const [sessionId, projectPath, message, permissionMode, settings] =
      resumeSession.mock.calls[0] as unknown[];
    expect(sessionId).toBe("sess-fork");
    expect(projectPath).toBe("/tmp/project-sandbox");
    expect(message).toEqual({
      text: "Continue from this fork point.",
      mode: "bypassPermissions",
    });
    expect(permissionMode).toBe("bypassPermissions");
    expect(settings).toEqual({
      model: "settings-model",
      requestedModel: "settings-model",
      serviceTier: "flex",
      thinking: { type: "adaptive" },
      effort: "high",
      providerName: "claude",
      executor: undefined,
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      sandboxStateKey: "fork-sandbox",
      globalInstructions: expectedGlobalInstructions,
      permissions: undefined,
      recapMode: undefined,
      recapAfterSeconds: 90,
      promptSuggestionMode: "native",
      helperSideModel: undefined,
      ...claudeCompact(60, 400_000),
    });
  });

  it("stale-session handoff inherits the source's settings and sandbox", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(sandboxedSource, { startSession }),
    );

    const response = await routes.request(
      ...post("stale-handoff", { message: "what is a volcano?" }),
    );

    expect(response.status).toBe(200);
    const [projectPath, message, permissionMode, settings] = startSession.mock
      .calls[0] as unknown[];
    expect(projectPath).toBe("/tmp/project-sandbox");
    expect(message).toMatchObject({ mode: undefined });
    expect(permissionMode).toBe("bypassPermissions");
    expect(settings).toEqual({
      model: "settings-model",
      requestedModel: "settings-model",
      serviceTier: "flex",
      thinking: { type: "adaptive" },
      effort: "high",
      providerName: "claude",
      executor: undefined,
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      instructionUsername: undefined,
      globalInstructions: expectedGlobalInstructions,
      recapAfterSeconds: 300,
      promptSuggestionMode: "native",
      ...claudeCompact(60, 400_000),
    });
  });

  it("stale-session handoff falls back to the live process's model before the transcript's", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(
        unsandboxedSource,
        { startSession },
        { reader: transcriptReader },
      ),
    );

    const response = await routes.request(
      ...post("stale-handoff", { message: "what is a volcano?" }),
    );

    expect(response.status).toBe(200);
    const settings = startSession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(settings).toMatchObject(claudeCompact(60, 400_000));
  });

  it("restart handoff falls back to the transcript's model without a live one", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const routes = createSessionsRoutes(
      launchDeps(
        unsandboxedSource,
        { startSession },
        { reader: transcriptReader, process: undefined },
      ),
    );

    const response = await routes.request(
      ...post("restart", { handoffText: "Continue the fix." }),
    );

    expect(response.status).toBe(200);
    const settings = startSession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(settings).toMatchObject(claudeCompact(60, 300_000));
  });

  it("limited stale-session handoff applies the user's lock", async () => {
    const startSession = vi.fn(async () => startedProcess("sess-new"));
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, {
        kind: "limited",
        username: "alice",
        grants: {
          newSessionProjects: [project.id],
          joinProjects: [],
          viewProjects: [],
          joinStaleOffsetMinutes: 0,
          lock: { provider: "codex", model: "lock-model" },
        },
        switched: false,
        locked: true,
        via: "direct",
      });
      await next();
    });
    app.route(
      "/",
      createSessionsRoutes(launchDeps(unsandboxedSource, { startSession })),
    );

    const response = await app.request(
      ...post("stale-handoff", { message: "what is a volcano?" }),
    );

    expect(response.status).toBe(200);
    const [projectPath, , permissionMode, settings] = startSession.mock
      .calls[0] as unknown[];
    expect(projectPath).toBe(project.path);
    expect(permissionMode).toBe("bypassPermissions");
    expect(settings).toEqual({
      model: "lock-model",
      requestedModel: "lock-model",
      serviceTier: undefined,
      thinking: undefined,
      effort: undefined,
      providerName: "codex",
      executor: undefined,
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
      instructionUsername: "alice",
      globalInstructions: expectedGlobalInstructions,
      recapAfterSeconds: 300,
      promptSuggestionMode: "native",
      compactAtContextPercent: 80,
      // The source's Claude models are not window candidates for Codex.
      compactAtContextWindow: undefined,
      forceYaOrchestratedCompaction: true,
      claudeAutoCompactPercentOverride: undefined,
    });
  });
});
