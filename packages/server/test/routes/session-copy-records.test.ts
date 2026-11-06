import type {
  TranscriptDisplayObject,
  UrlProjectId,
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
import { ForkSettingsPersistenceError } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";

// Characterization for the session-launch service plan (doc 177, steps 4
// and 5): fork, restart, the stale-session handoff and the retitle and
// fork-summary helpers announce a new session with session-metadata-changed
// (clone does not announce and is not covered here) and record what only the
// route knows: a handoff's title, a fork's lineage root and the fork-summary
// target's archiving. Creation admission records a copy's title, source,
// archiving and creator, so those are announced, not written again. The
// forks claim a fork number that a failed fork gives back. These pin, per
// new session, the writes and announcements in order, and the fork-number
// claims and releases.

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

const source = {
  customTitle: "Refactor session",
  effectiveLaunchSettings: {
    schemaVersion: 1,
    revision: 1,
    permissionMode: "default",
    requestedModel: "settings-model",
  },
};

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
    {
      type: "assistant",
      uuid: "msg-after-initial-turn",
      timestamp: "2026-04-24T20:00:01.000Z",
      message: { role: "assistant", content: "Found the failing test." },
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

type Entry = unknown[];

/**
 * Routes over a mocked Supervisor (`supervisor` overrides its defaults) with
 * every metadata write, announcement, fork-number claim and release logged
 * in one ordered list.
 */
function copyRoutes(
  supervisor: Record<string, unknown>,
  principal?: Principal,
) {
  const log: Entry[] = [];
  let displayObjects: TranscriptDisplayObject[] = [];
  const readers: Record<string, unknown> = {
    getProvider: () => "claude",
    getRequestedModel: () => "saved-model",
    getExecutor: () => undefined,
    getMetadata: () => source,
    identities: undefined,
    nextForkOrdinal: async (sessionId: string) => {
      log.push(["claim", sessionId]);
      return { ordinal: 2, lineageRootId: "sess-root" };
    },
    releaseForkOrdinal: async (claim: unknown) => {
      log.push(["release", claim]);
    },
    forkLineageRoot: () => "sess-root",
    getTranscriptDisplayObjects: () => displayObjects,
    addTranscriptDisplayObject: async (
      _sessionId: string,
      object: TranscriptDisplayObject,
    ) => {
      displayObjects = [...displayObjects, object];
    },
    updateTranscriptDisplayObject: async (
      _sessionId: string,
      objectId: string,
      updater: (object: TranscriptDisplayObject) => TranscriptDisplayObject,
    ) => {
      let updated: TranscriptDisplayObject | undefined;
      displayObjects = displayObjects.map((object) => {
        if (object.id !== objectId) return object;
        updated = updater(object);
        return updated;
      });
      return updated;
    },
  };
  const sessionMetadataService = new Proxy(readers, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      if (prop.startsWith("get")) return undefined;
      return async (...args: unknown[]) => {
        log.push([prop, ...args]);
        return undefined;
      };
    },
  });
  const sessionsRoutes = createSessionsRoutes({
    supervisor: {
      getProcessForSession: vi.fn(() => sourceProcess),
      interruptProcess: vi.fn(async () => ({ success: true, supported: true })),
      abortProcess: vi.fn(async () => true),
      supportsForkSession: vi.fn(() => true),
      cancelQueuedRequest: vi.fn(() => true),
      ...supervisor,
    } as unknown as SessionsDeps["supervisor"],
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as SessionsDeps["scanner"],
    readerFactory: vi.fn(
      () =>
        ({
          getSessionSummary: vi.fn(async () => null),
          getSession: vi.fn(async () => null),
        }) as unknown as ISessionReader,
    ),
    sessionMetadataService: sessionMetadataService as unknown as NonNullable<
      SessionsDeps["sessionMetadataService"]
    >,
    eventBus: {
      emit: vi.fn((event: Record<string, unknown>) => {
        const { timestamp, ...rest } = event;
        expect(typeof timestamp).toBe("string");
        log.push(["announce", rest]);
      }),
    } as unknown as SessionsDeps["eventBus"],
    userUsageService: {
      recordSession: vi.fn(async (username?: string) => {
        log.push(["usage", username]);
      }),
      recordTurn: vi.fn(async () => undefined),
    } as unknown as SessionsDeps["userUsageService"],
  });
  const routes = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  if (principal) {
    routes.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, principal);
      await next();
    });
  }
  routes.route("/", sessionsRoutes);
  return {
    post: (path: string, body: unknown) =>
      routes.request(`/projects/${project.id}/sessions/sess-1/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    /**
     * Title and lineage writes and announcements for one new session, without
     * the launch-preference writes step 1's tests pin.
     */
    recordsFor: (sessionId: string) =>
      log.filter(
        ([kind, first, fields]) =>
          (kind === "updateMetadata" &&
            first === sessionId &&
            !("promptSuggestionMode" in (fields as object)) &&
            !("recapAfterSeconds" in (fields as object))) ||
          (kind === "announce" &&
            (first as { sessionId?: string }).sessionId === sessionId),
      ),
    claims: () =>
      log.filter(([kind]) => kind === "claim" || kind === "release"),
    /** Creator and usage records with the title and lineage records. */
    creationRecords: () =>
      log.filter(
        ([kind, , fields]) =>
          kind === "recordSessionCreator" ||
          kind === "usage" ||
          kind === "announce" ||
          (kind === "updateMetadata" &&
            !("promptSuggestionMode" in (fields as object)) &&
            !("recapAfterSeconds" in (fields as object))),
      ),
    forkSummary: () =>
      displayObjects.find((object) => object.kind === "fork-summary"),
  };
}

const metadataWrite = (sessionId: string, fields: Record<string, unknown>) => [
  "updateMetadata",
  sessionId,
  fields,
];
const announce = (sessionId: string, fields: Record<string, unknown>) => [
  "announce",
  { type: "session-metadata-changed", sessionId, ...fields },
];

describe("new-session title and lineage records", () => {
  it("fork records its lineage root and announces its title and source", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => ({ sessionId: "sess-fork" })),
    });

    const response = await fixture.post("fork", {
      upToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(200);
    expect(fixture.recordsFor("sess-fork")).toEqual([
      metadataWrite("sess-fork", { forkLineageRootId: "sess-root" }),
      announce("sess-fork", {
        title: "Fork 2: Refactor session",
        forkedFromSessionId: "sess-1",
      }),
    ]);
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
  });

  it("a limited user's fork counts as one of their sessions and leaves its creator to admission", async () => {
    const fixture = copyRoutes(
      { forkSession: vi.fn(async () => ({ sessionId: "sess-fork" })) },
      {
        kind: "limited",
        username: "alice",
        grants: {
          newSessionProjects: [project.id],
          joinProjects: [],
          viewProjects: [],
          joinStaleOffsetMinutes: 0,
        },
        switched: false,
        locked: false,
        via: "direct",
      } as unknown as Principal,
    );

    const response = await fixture.post("fork", {
      upToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(200);
    expect(fixture.creationRecords()).toEqual([
      ["usage", "alice"],
      metadataWrite("sess-fork", { forkLineageRootId: "sess-root" }),
      announce("sess-fork", {
        title: "Fork 2: Refactor session",
        forkedFromSessionId: "sess-1",
      }),
    ]);
  });

  it("restart fork records its lineage root and announces its title", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => ({ sessionId: "sess-fork" })),
      resumeSession: vi.fn(async () => startedProcess("sess-fork")),
    });

    const response = await fixture.post("restart", {
      restartMode: "fork",
      forkUpToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(200);
    expect(fixture.recordsFor("sess-fork")).toEqual([
      metadataWrite("sess-fork", { forkLineageRootId: "sess-root" }),
      announce("sess-fork", { title: "Fork 2: Refactor session" }),
    ]);
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
  });

  it("restart handoff records and announces its title", async () => {
    const fixture = copyRoutes({
      startSession: vi.fn(async () => startedProcess("sess-new")),
    });

    const response = await fixture.post("restart", {
      handoffText: "Continue the fix.",
    });

    expect(response.status).toBe(200);
    expect(fixture.recordsFor("sess-new")).toEqual([
      metadataWrite("sess-new", { title: "Handoff: Refactor session" }),
      announce("sess-new", { title: "Handoff: Refactor session" }),
    ]);
    expect(fixture.claims()).toEqual([]);
  });

  it("stale-session handoff records and announces its title", async () => {
    const fixture = copyRoutes({
      startSession: vi.fn(async () => startedProcess("sess-new")),
    });

    const response = await fixture.post("stale-handoff", {
      message: "what is a volcano?",
    });

    expect(response.status).toBe(200);
    expect(fixture.recordsFor("sess-new")).toEqual([
      metadataWrite("sess-new", { title: "Handoff: Refactor session" }),
      announce("sess-new", { title: "Handoff: Refactor session" }),
    ]);
  });

  it("retitle announces its archived generator", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => ({ sessionId: "sess-generator" })),
      generateSummary: vi.fn(async () => ({ text: "Tight rename flow" })),
    });

    const response = await fixture.post("retitle", {
      currentTitle: "old title",
    });

    expect(response.status).toBe(200);
    const generator = {
      title: "Retitle generator",
      archived: true,
      forkedFromSessionId: "sess-1",
    };
    expect(fixture.recordsFor("sess-generator")).toEqual([
      announce("sess-generator", generator),
    ]);
    expect(fixture.claims()).toEqual([]);
  });

  it("fork-summary announces its archived generator and reveals its target once started", async () => {
    const fixture = copyRoutes({
      forkSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess-generator" })
        .mockResolvedValueOnce({ sessionId: "sess-target" }),
      generateSummary: vi.fn(async () => ({
        text: "Title: Refactor continuation\n\nContinue from the fix.",
      })),
      resumeSession: vi.fn(async () => startedProcess("sess-target")),
    });

    const response = await fixture.post("fork-summary", {
      sourceMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(202);
    const target = {
      title: "Refactor continuation",
      forkedFromSessionId: "sess-1",
    };
    await vi.waitFor(() =>
      expect(fixture.recordsFor("sess-target")).toEqual([
        metadataWrite("sess-target", {
          archived: true,
          forkLineageRootId: "sess-root",
        }),
        announce("sess-target", { ...target, archived: true }),
        metadataWrite("sess-target", { archived: false }),
        announce("sess-target", { ...target, archived: false }),
      ]),
    );
    const generator = {
      title: "Fork summary generator",
      archived: true,
      forkedFromSessionId: "sess-1",
    };
    expect(fixture.recordsFor("sess-generator")).toEqual([
      announce("sess-generator", generator),
    ]);
    // The generated summary named a title, so no fork number is claimed.
    expect(fixture.claims()).toEqual([]);
  });
});

describe("fork-number claims", () => {
  const claim = { ordinal: 2, lineageRootId: "sess-root" };
  const settingsLost = () =>
    new ForkSettingsPersistenceError("sess-kept", new Error("disk full"));

  it("a failed fork gives its number back", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => {
        throw new Error("provider fork failed");
      }),
    });

    const response = await fixture.post("fork", {
      upToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(500);
    expect(fixture.claims()).toEqual([
      ["claim", "sess-1"],
      ["release", claim],
    ]);
  });

  it("a fork kept without its settings keeps its number", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => {
        throw settingsLost();
      }),
    });

    const response = await fixture.post("fork", {
      upToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(500);
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
  });

  it("a failed restart fork gives its number back", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => {
        throw new Error("provider fork failed");
      }),
    });

    const response = await fixture.post("restart", {
      restartMode: "fork",
      forkUpToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(500);
    expect(fixture.claims()).toEqual([
      ["claim", "sess-1"],
      ["release", claim],
    ]);
  });

  it("a restart fork kept without its settings keeps its number", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => {
        throw settingsLost();
      }),
    });

    const response = await fixture.post("restart", {
      restartMode: "fork",
      forkUpToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(500);
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
  });

  it("a restart fork whose launch is refused keeps its number", async () => {
    const fixture = copyRoutes({
      forkSession: vi.fn(async () => ({ sessionId: "sess-fork" })),
      resumeSession: vi.fn(async () => ({
        error: "queue_full",
        maxQueueSize: 4,
      })),
    });

    const response = await fixture.post("restart", {
      restartMode: "fork",
      forkUpToMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(503);
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
    expect(fixture.recordsFor("sess-fork")).toEqual([]);
  });

  it("fork-summary claims a number only for a fallback title, and gives it back when its target fails", async () => {
    const fixture = copyRoutes({
      forkSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess-generator" })
        .mockRejectedValueOnce(new Error("provider fork failed")),
      generateSummary: vi.fn(async () => ({ text: "   " })),
    });

    const response = await fixture.post("fork-summary", {
      sourceMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(fixture.claims()).toEqual([
        ["claim", "sess-1"],
        ["release", claim],
      ]),
    );
  });

  it("fork-summary keeps the number of a target kept without its settings", async () => {
    const fixture = copyRoutes({
      forkSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess-generator" })
        .mockRejectedValueOnce(settingsLost()),
      generateSummary: vi.fn(async () => ({ text: "   " })),
    });

    const response = await fixture.post("fork-summary", {
      sourceMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(202);
    // The job's catch marks the summary failed after its cleanup.
    await vi.waitFor(() =>
      expect(fixture.forkSummary()).toMatchObject({ status: "error" }),
    );
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
    const generator = {
      title: "Fork summary generator",
      archived: true,
      forkedFromSessionId: "sess-1",
    };
    // Announced when made, and again by the failed job's cleanup.
    expect(fixture.recordsFor("sess-generator")).toEqual([
      announce("sess-generator", generator),
      announce("sess-generator", generator),
    ]);
  });

  it("fork-summary keeps the number of a target whose launch is refused, and re-archives the target", async () => {
    const fixture = copyRoutes({
      forkSession: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess-generator" })
        .mockResolvedValueOnce({ sessionId: "sess-target" }),
      generateSummary: vi.fn(async () => ({ text: "   " })),
      resumeSession: vi.fn(async () => ({
        error: "queue_full",
        maxQueueSize: 4,
      })),
    });

    const response = await fixture.post("fork-summary", {
      sourceMessageId: "msg-user-initial",
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(fixture.forkSummary()).toMatchObject({ status: "error" }),
    );
    expect(fixture.claims()).toEqual([["claim", "sess-1"]]);
    const target = {
      title: "Fork 2: Refactor session",
      archived: true,
      forkedFromSessionId: "sess-1",
    };
    expect(fixture.recordsFor("sess-target")).toEqual([
      metadataWrite("sess-target", {
        archived: true,
        forkLineageRootId: "sess-root",
      }),
      announce("sess-target", target),
      // The cleanup re-archives without the lineage root.
      metadataWrite("sess-target", { archived: true }),
      announce("sess-target", target),
    ]);
  });
});
