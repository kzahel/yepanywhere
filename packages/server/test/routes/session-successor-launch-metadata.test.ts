import type {
  TranscriptDisplayObject,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

// Characterization for the session-launch service plan (doc 177): the
// launch metadata each successor launch (fork, retitle generator,
// fork-summary generator and target, restart fork, restart handoff) writes
// after its session exists, in order.
// Creation admission records a copy's provider, model, preferences, title,
// source and sandbox, and the Supervisor the sandbox a process runs in, so
// the routes write only what neither knows: the preferences a started
// process resolved, the lineage root and the fork-summary target's
// archiving. A copy is told the project it is listed under instead.
// session-launch-records.test.ts and its Linux sandboxed sibling pin the
// stored result of all of them together.

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

/** A sandboxed source whose every inherited field is distinguishable. */
const sandboxedSource = {
  customTitle: "Refactor session",
  promptSuggestionMode: "native",
  recapAfterSeconds: 300,
  sandboxLevel: "project-write",
  sandboxNetworkFirewall: false,
  sandboxStateKey: "source-sandbox",
  sandboxProjectPath: "/tmp/project-sandbox",
  workingProjectId: "proj-working",
  effectiveLaunchSettings: {
    schemaVersion: 1,
    revision: 2,
    permissionMode: "bypassPermissions",
    requestedModel: "settings-model",
    thinking: { type: "adaptive" },
    effort: "high",
  },
};

/** The same source with the network firewall left at its default (on). */
const firewallOnSource = {
  ...sandboxedSource,
  sandboxNetworkFirewall: undefined,
};

type Write = [method: string, ...args: unknown[]];

/**
 * A metadata service that answers the reads the successor routes make and
 * records every write, in call order.
 */
function recordingMetadata(source: Record<string, unknown> | undefined) {
  const writes: Write[] = [];
  let displayObjects: TranscriptDisplayObject[] = [];
  const readers: Record<string, unknown> = {
    getProvider: () => "claude",
    getRequestedModel: () => "saved-model",
    getExecutor: () => undefined,
    getMetadata: () => source,
    // A property, not a method: no identity store in these fixtures.
    identities: undefined,
    nextForkOrdinal: async () => ({ ordinal: 1, lineageRootId: "sess-1" }),
    forkLineageRoot: (id: string) => id,
    getTranscriptDisplayObjects: () => displayObjects,
    addTranscriptDisplayObject: async (
      sessionId: string,
      object: TranscriptDisplayObject,
    ) => {
      writes.push(["addTranscriptDisplayObject", sessionId, object.kind]);
      displayObjects = [...displayObjects, object];
    },
    updateTranscriptDisplayObject: async (
      sessionId: string,
      objectId: string,
      updater: (object: TranscriptDisplayObject) => TranscriptDisplayObject,
    ) => {
      writes.push(["updateTranscriptDisplayObject", sessionId]);
      let updated: TranscriptDisplayObject | undefined;
      displayObjects = displayObjects.map((object) => {
        if (object.id !== objectId) return object;
        updated = updater(object);
        return updated;
      });
      return updated;
    },
  };
  // Every method that is not a reader is recorded as a write, so a write
  // made through optional chaining cannot be skipped silently.
  const service = new Proxy(readers, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      if (prop.startsWith("get")) return undefined;
      return async (...args: unknown[]) => {
        writes.push([prop, ...args]);
        return undefined;
      };
    },
  });
  return {
    service: service as unknown as NonNullable<
      SessionsDeps["sessionMetadataService"]
    >,
    writesFor: (sessionId: string) =>
      writes.filter(([, id]) => id === sessionId),
  };
}

const nullReader = () =>
  ({
    getSessionSummary: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
  }) as unknown as ISessionReader;

const sourceProcess = (overrides: Record<string, unknown> = {}) => ({
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
    {
      type: "assistant",
      uuid: "msg-after-initial-turn",
      timestamp: "2026-04-24T20:00:01.000Z",
      message: { role: "assistant", content: "Found the failing test." },
    },
  ]),
  ...overrides,
});

const post = (path: string, body: unknown) => ({
  path: `/projects/${project.id}/sessions/sess-1/${path}`,
  init: {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  },
});

describe("successor launch metadata writes", () => {
  it("fork names the source's working project and records its lineage root", async () => {
    const metadata = recordingMetadata(sandboxedSource);
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-fork",
      sandboxStateKey: "child-sandbox",
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("fork", { upToMessageId: "msg-uuid-3" });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/tmp/project-sandbox",
        workingProjectId: "proj-working",
      }),
    );
    expect(metadata.writesFor("sess-fork")).toEqual([
      ["updateMetadata", "sess-fork", { forkLineageRootId: "sess-1" }],
    ]);
  });

  it("fork of a source with no saved metadata names the request's project", async () => {
    const metadata = recordingMetadata(undefined);
    const forkSession = vi.fn(async () => ({ sessionId: "sess-fork" }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => undefined),
        supportsForkSession: vi.fn(() => true),
        forkSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("fork", { upToMessageId: "msg-uuid-3" });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: project.path,
        workingProjectId: project.id,
      }),
    );
    expect(metadata.writesFor("sess-fork")).toEqual([
      ["updateMetadata", "sess-fork", { forkLineageRootId: "sess-1" }],
    ]);
  });

  it("retitle names the source's working project and writes nothing after", async () => {
    const metadata = recordingMetadata(firewallOnSource);
    const forkSession = vi.fn(async () => ({
      sessionId: "sess-retitle-generator",
      sandboxStateKey: "child-sandbox",
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => sourceProcess()),
        supportsForkSession: vi.fn(() => true),
        forkSession,
        generateSummary: vi.fn(async () => ({ text: "Tight rename flow" })),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("retitle", { currentTitle: "old title" });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(200);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingProjectId: "proj-working" }),
    );
    expect(metadata.writesFor("sess-retitle-generator")).toEqual([]);
  });

  it("fork-summary names the working project and records its target's started settings", async () => {
    const metadata = recordingMetadata(firewallOnSource);
    const forkSession = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "sess-generator",
        sandboxStateKey: "generator-sandbox",
      })
      .mockResolvedValueOnce({
        sessionId: "sess-target",
        sandboxStateKey: "target-sandbox",
      });
    const resumeSession = vi.fn(async () => ({
      id: "proc-target",
      sessionId: "sess-target",
      projectId: "proj-resumed",
      projectPath: "/tmp/project-resumed",
      provider: "claude",
      model: "sonnet",
      resolvedModel: "sonnet",
      permissionMode: "default",
      modeVersion: 0,
      promptSuggestionMode: "off",
      recapAfterSeconds: 600,
      sandboxStateKey: "resumed-sandbox",
      subscribe: vi.fn(() => vi.fn()),
    }));
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => sourceProcess()),
        supportsForkSession: vi.fn(() => true),
        generateSummary: vi.fn(async () => ({
          text: "Title: Refactor continuation\n\nContinue from the fix.",
        })),
        forkSession,
        resumeSession,
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("fork-summary", {
      sourceMessageId: "msg-user-initial",
    });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(
        metadata
          .writesFor("sess-target")
          .some(
            ([method, , update]) =>
              method === "updateMetadata" &&
              (update as { archived?: boolean }).archived === false,
          ),
      ).toBe(true);
    });
    expect(forkSession.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ workingProjectId: "proj-working" }),
      expect.objectContaining({ workingProjectId: "proj-working" }),
    ]);
    expect(metadata.writesFor("sess-generator")).toEqual([]);
    expect(metadata.writesFor("sess-target")).toEqual([
      [
        "updateMetadata",
        "sess-target",
        { archived: true, forkLineageRootId: "sess-1" },
      ],
      // After the resumed target process starts: its own resolved settings.
      ["updateMetadata", "sess-target", { promptSuggestionMode: "off" }],
      ["updateMetadata", "sess-target", { recapAfterSeconds: 600 }],
      ["updateMetadata", "sess-target", { archived: false }],
    ]);
  });

  it("restart fork records its started preferences and lineage root", async () => {
    const metadata = recordingMetadata(sandboxedSource);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => sourceProcess()),
        supportsForkSession: vi.fn(() => true),
        forkSession: vi.fn(async () => ({
          sessionId: "sess-fork",
          sandboxStateKey: "child-sandbox",
        })),
        resumeSession: vi.fn(async () => ({
          id: "proc-new",
          sessionId: "sess-fork",
          projectId: "proj-resumed",
          provider: "claude",
          model: "sonnet",
          resolvedModel: "sonnet",
          permissionMode: "default",
          modeVersion: 0,
          promptSuggestionMode: "off",
          recapAfterSeconds: 600,
          sandboxStateKey: "resumed-sandbox",
          subscribe: vi.fn(() => vi.fn()),
        })),
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("restart", {
      restartMode: "fork",
      forkUpToMessageId: "msg-uuid-7",
    });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(200);
    expect(metadata.writesFor("sess-fork")).toEqual([
      ["updateMetadata", "sess-fork", { promptSuggestionMode: "off" }],
      ["updateMetadata", "sess-fork", { recapAfterSeconds: 600 }],
      ["updateMetadata", "sess-fork", { forkLineageRootId: "sess-1" }],
    ]);
  });

  it("restart handoff records its started recap delay and title", async () => {
    const metadata = recordingMetadata(firewallOnSource);
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => sourceProcess()),
        startSession: vi.fn(async () => ({
          id: "proc-new",
          sessionId: "sess-new",
          projectId: "proj-started",
          projectPath: "/tmp/project-started",
          sandboxProjectPath: "/tmp/project-started-sandbox",
          provider: "claude",
          model: "sonnet",
          resolvedModel: "sonnet",
          permissionMode: "default",
          modeVersion: 0,
          promptSuggestionMode: "off",
          recapAfterSeconds: 600,
          sandboxStateKey: "started-sandbox",
          subscribe: vi.fn(() => vi.fn()),
        })),
        interruptProcess: vi.fn(async () => ({
          success: true,
          supported: true,
        })),
        abortProcess: vi.fn(async () => true),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(nullReader),
      sessionMetadataService: metadata.service,
      eventBus: { emit: vi.fn() } as unknown as SessionsDeps["eventBus"],
    });

    const request = post("restart", { handoffText: "Continue the fix." });
    const response = await routes.request(request.path, request.init);

    expect(response.status).toBe(200);
    expect(metadata.writesFor("sess-new")).toEqual([
      ["updateMetadata", "sess-new", { recapAfterSeconds: 600 }],
      ["updateMetadata", "sess-new", { title: "Handoff: Refactor session" }],
    ]);
  });
});
