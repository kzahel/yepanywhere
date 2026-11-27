import { describe, expect, it, vi } from "vitest";
import { limitedActivityEvent } from "../../src/auth/activityEventAccess.js";
import { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import type { BusEvent } from "../../src/watcher/index.js";

/** topics/limited-users.md § Delivery v1 — Authorization. */

const timestamp = "2026-09-26T00:00:00.000Z";

const access = {
  isProjectAccessible: (projectId: string) => projectId === "granted",
  knownSessionProject: (sessionId: string) =>
    ({ "granted-session": "granted", "other-session": "other" })[
      sessionId as "granted-session" | "other-session"
    ],
};

const deliver = (event: BusEvent) => limitedActivityEvent(event, access);

describe("limited-user activity events", () => {
  it("hides a formerly granted session event while its replacement catalog loads", async () => {
    let version = "epoch:1";
    let release!: (
      rows: Array<{ sessionId: string; projectId: string }>,
    ) => void;
    const pending = new Promise<
      Array<{ sessionId: string; projectId: string }>
    >((resolve) => {
      release = resolve;
    });
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => version,
      readCatalogRows: async () =>
        version === "epoch:1"
          ? [{ sessionId: "moved", projectId: "granted" }]
          : pending,
    });
    await resolver.resolve("moved");
    const event: BusEvent = {
      type: "session-seen",
      sessionId: "moved",
      timestamp,
    };
    const filtered = () =>
      limitedActivityEvent(event, {
        isProjectAccessible: access.isProjectAccessible,
        knownSessionProject: (id) => resolver.resolveKnown(id)?.projectId,
      });
    expect(filtered()).toEqual(event);
    version = "epoch:2";
    expect(filtered()).toBeNull();
    release([{ sessionId: "moved", projectId: "other" }]);
    await resolver.resolve("moved");
    expect(filtered()).toBeNull();
  });
  it("delivers a new session only in an accessible project", () => {
    const created = (projectId: string) =>
      ({
        type: "session-created",
        session: { id: "s", projectId, title: "title" },
        timestamp,
      }) as unknown as BusEvent;
    expect(deliver(created("granted"))).not.toBeNull();
    expect(deliver(created("other"))).toBeNull();
  });

  it("resolves the project of an event that names only its session", () => {
    const seen = (sessionId: string): BusEvent => ({
      type: "session-seen",
      sessionId,
      timestamp,
    });
    expect(deliver(seen("granted-session"))).not.toBeNull();
    expect(deliver(seen("other-session"))).toBeNull();
    // A session that resolves to no project is hidden.
    expect(deliver(seen("unknown-session"))).toBeNull();

    const retitled: BusEvent = {
      type: "session-metadata-changed",
      sessionId: "other-session",
      title: "Other project's title",
      timestamp,
    };
    expect(deliver(retitled)).toBeNull();
  });

  it("hides worker queue movement with no session to attribute", () => {
    expect(
      deliver({
        type: "queue-request-removed",
        queueId: "q",
        reason: "started",
        timestamp,
      }),
    ).toBeNull();
  });

  it("narrows a multi-project event to the accessible projects", () => {
    expect(
      deliver({
        type: "project-captions-changed",
        projectIds: ["other", "granted"],
        timestamp,
      }),
    ).toMatchObject({ projectIds: ["granted"] });
    expect(
      deliver({
        type: "projects-changed",
        projectIds: ["other"],
        timestamp,
      }),
    ).toBeNull();
  });

  it("hides host inventory that names no project", () => {
    expect(
      deliver({
        type: "file-change",
        provider: "claude",
        path: "/home/owner/.claude/projects/p/s.jsonl",
        relativePath: "projects/p/s.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp,
      }),
    ).toBeNull();
    expect(
      deliver({
        type: "browser-tab-connected",
        browserProfileId: "b",
        connectionId: 1,
        transport: "ws",
        tabCount: 1,
        totalTabCount: 1,
        timestamp,
      }),
    ).toBeNull();
  });

  it("keeps catalog refresh signals but drops their operator diagnostic", () => {
    expect(
      deliver({
        type: "projects-changed",
        projectIds: ["other"],
        collectionRefresh: true,
        timestamp,
      }),
    ).toEqual({
      type: "projects-changed",
      projectIds: [],
      collectionRefresh: true,
      timestamp,
    });
    expect(deliver({ type: "recents-changed", timestamp })).toEqual({
      type: "recents-changed",
      timestamp,
    });
    expect(
      deliver({
        type: "session-catalog-updated",
        catalog: {
          catalogEpoch: "e",
          catalogGeneration: 3,
          complete: true,
          refreshing: false,
          refreshError: "EACCES: /home/owner/private",
        },
        timestamp,
      }),
    ).toEqual({
      type: "session-catalog-updated",
      catalog: {
        catalogEpoch: "e",
        catalogGeneration: 3,
        complete: true,
        refreshing: false,
      },
      timestamp,
    });
  });
});

describe("SessionAccessResolver.resolveKnown", () => {
  it("answers from memory, starting one background catalog read for what it lacks", async () => {
    let catalogReads = 0;
    const resolver = new SessionAccessResolver({
      getLiveSession: (sessionId) =>
        sessionId === "live" ? { projectId: "live-project" } : undefined,
      readCatalogRows: async () => {
        catalogReads += 1;
        return [{ sessionId: "idle", projectId: "idle-project" }];
      },
      getSessionMetadata: (sessionId) =>
        sessionId === "pinned"
          ? { workingProjectId: "pinned-project", createdByUser: "bob" }
          : undefined,
    });
    expect(resolver.resolveKnown("live")?.projectId).toBe("live-project");
    expect(resolver.resolveKnown("pinned")?.projectId).toBe("pinned-project");
    expect(resolver.resolveKnown("idle")).toBeNull();
    expect(resolver.resolveKnown("idle")).toBeNull();
    await vi.waitFor(() => {
      expect(resolver.resolveKnown("idle")?.projectId).toBe("idle-project");
    });
    // Each id loads once, including concurrent events for the same idle session.
    expect(catalogReads).toBe(3);
  });

  it("uses catalog rows an earlier resolve already read", async () => {
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      readCatalogRows: async () => [
        { sessionId: "idle", projectId: "idle-project" },
      ],
      getSessionMetadata: () => undefined,
    });
    expect((await resolver.resolve("idle"))?.projectId).toBe("idle-project");
    expect(resolver.resolveKnown("idle")?.projectId).toBe("idle-project");
  });
});
