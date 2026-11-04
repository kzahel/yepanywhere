import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderChildRelationshipService,
  type ProviderChildObservation,
  type ProviderChildSource,
} from "../../src/sessions/ProviderChildRelationshipService.js";
import { SessionIdentityStore } from "../../src/sessions/SessionIdentityStore.js";
import { SessionRelationshipStore } from "../../src/sessions/SessionRelationshipStore.js";
import { resolveProviderChildSessions } from "../../src/sessions/provider-child-sessions.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const roots: string[] = [];
const databases: DiscoverySqliteService[] = [];
const services: ProviderChildRelationshipService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const native = (id: string) =>
  nativeSessionRef("codex", "/owned/native/sessions", parseNativeSessionId(id));
const owner = { sessionId: "canonical-ya-parent" };
function snapshot(
  id: string | null,
  version = "v1",
  state: "complete" | "partial" = "complete",
): ProviderChildObservation {
  return {
    version,
    state,
    children: id
      ? [
          {
            native: native(id),
            summary: {
              id,
              parentSessionId: "parent",
              toolUseId: "spawn",
              title: "Owned child",
              updatedAt: "2026-11-04T00:00:00.000Z",
            },
          },
        ]
      : [],
  };
}
function fixture(dataDir?: string) {
  const root =
    dataDir ?? mkdtempSync(join(tmpdir(), "ya-child-relationships-"));
  if (!dataDir) roots.push(root);
  const db = new DiscoverySqliteService({
    dataDir: root,
    probeNetworkFilesystem: () => undefined,
  });
  databases.push(db);
  const committed = deferred<void>(),
    failed = deferred<unknown>();
  const ownerChanges: string[] = [];
  const service = new ProviderChildRelationshipService(
    db.getDatabase(),
    "local",
    (owner) => {
      ownerChanges.push(owner.sessionId);
      committed.resolve();
    },
    (error) => failed.resolve(error),
  );
  services.push(service);
  return { root, db, service, committed, failed, ownerChanges };
}
const source = (value: ProviderChildObservation): ProviderChildSource => ({
  observe: async () => value,
  isCurrent: async () => true,
});
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("profile-owned provider child facts", () => {
  it("bounds native event pressure, preserves creation across appends and lets acquisition progress", async () => {
    const f = fixture();
    const held = [deferred<void>(), deferred<void>()];
    const bothStarted = deferred<void>();
    const refreshStarted = deferred<void>();
    const publishRefresh = deferred<void>();
    const events: Array<{ path: string; changeType: string }> = [];
    let active = 0;
    let maximumActive = 0;
    let observation = snapshot(null);
    const acquisition: ProviderChildSource = {
      observe: async () => {
        const value = observation;
        if (value.version === "v2") {
          refreshStarted.resolve();
          await publishRefresh.promise;
        }
        return value;
      },
      isCurrent: async () => true,
      ownsFileChange: () => true,
      async handleFileChange(event) {
        const index = events.length;
        events.push(event);
        maximumActive = Math.max(maximumActive, ++active);
        if (index === 1) bothStarted.resolve();
        if (index < 2) await held[index]!.promise;
        active--;
        return false;
      },
    };
    f.service.demand(native("parent"), owner, acquisition);
    await f.committed.promise;
    await nextTurn();
    const event = (name: string, changeType: "create" | "modify" = "modify") =>
      f.service.notifyNativeFileChange({
        type: "file-change",
        provider: "claude",
        path: `/owned/parent/subagents/agent-${name}.jsonl`,
        relativePath: "unused",
        changeType,
        timestamp: "2026-11-04T00:00:00.000Z",
        fileType: "agent-session",
      });
    event("held-0");
    event("held-1");
    await bothStarted.promise;
    event("coalesced", "create");
    event("coalesced");
    observation = snapshot("child", "v2");
    for (let i = 0; i < 200; i++) event(`overflow-${i}`);
    held[0]!.resolve();
    await refreshStarted.promise;
    for (let i = 200; i < 400; i++) event(`overflow-${i}`);
    publishRefresh.resolve();
    // With one event still held, overflow must refresh truth rather than let
    // the queued event stream starve the bounded acquisition worker.
    await vi.waitFor(() =>
      expect(
        f.service.accepted(native("parent"), owner.sessionId)?.[0]?.id,
      ).toBe("child"),
    );
    held[1]!.resolve();
    await vi.waitFor(() => expect(events.length).toBe(130));
    expect(maximumActive).toBe(2);
    expect(
      events.find((entry) => entry.path.includes("coalesced"))?.changeType,
    ).toBe("create");
    await f.service.close();
    event("after-close", "create");
    await nextTurn();
    expect(events).toHaveLength(130);
  });

  it("returns known SQL immediately while acquisition is held, publishes outside request context and reopens without discovery", async () => {
    const f = fixture();
    const held = deferred<ProviderChildObservation>(),
      started = deferred<void>();
    const context = new AsyncLocalStorage<string>();
    const acquisition: ProviderChildSource = {
      async observe() {
        expect(context.getStore()).toBeUndefined();
        started.resolve();
        return held.promise;
      },
      isCurrent: async () => true,
    };
    context.run("request-data", () =>
      f.service.demand(native("parent"), owner, acquisition),
    );
    expect(
      f.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
    await started.promise;
    expect(
      f.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
    held.resolve(snapshot("child"));
    await f.committed.promise;
    expect(f.service.accepted(native("parent"), owner.sessionId)).toMatchObject(
      [{ id: "child", parentSessionId: owner.sessionId, toolUseId: "spawn" }],
    );
    expect(
      new SessionIdentityStore(f.db.getDatabase()).lookupNative(
        native("child"),
      ),
    ).toBeUndefined();
    await f.service.close();
    f.db.close();
    const reopened = fixture(f.root);
    expect(
      reopened.service.accepted(native("parent"), owner.sessionId),
    ).toMatchObject([{ id: "child", parentSessionId: owner.sessionId }]);
  });

  it("keeps unknown, partial and accepted empty distinct and preserves accepted facts on source failure", async () => {
    const f = fixture();
    f.service.demand(native("parent"), owner, source(snapshot(null)));
    await f.committed.promise;
    expect(f.service.accepted(native("parent"), owner.sessionId)).toEqual([]);
    const error = new Error("native source unavailable");
    f.service.demand(native("parent"), owner, {
      observe: async () => {
        throw error;
      },
      isCurrent: async () => true,
    });
    expect(await f.failed.promise).toBe(error);
    expect(f.service.accepted(native("parent"), owner.sessionId)).toEqual([]);
    const partial = deferred<void>();
    f.service.demand(native("parent"), owner, {
      observe: async () => snapshot(null, "partial", "partial"),
      isCurrent: async () => {
        partial.resolve();
        return true;
      },
    });
    await partial.promise;
    await nextTurn();
    expect(f.service.accepted(native("parent"), owner.sessionId)).toEqual([]);
    const unknown = fixture();
    unknown.service.demand(
      native("parent"),
      owner,
      source(snapshot(null, "partial", "partial")),
    );
    await unknown.committed.promise;
    expect(
      unknown.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
  });

  it("discards a superseded in-flight observation and coalesces repeated demand", async () => {
    const f = fixture();
    const held = deferred<ProviderChildObservation>(),
      started = deferred<void>();
    let reads = 0;
    const acquisition: ProviderChildSource = {
      async observe() {
        reads++;
        if (reads === 1) {
          started.resolve();
          return held.promise;
        }
        return snapshot("new", "v2");
      },
      isCurrent: async () => true,
    };
    f.service.demand(native("parent"), owner, acquisition);
    await started.promise;
    for (let i = 0; i < 20; i++)
      f.service.demand(native("parent"), owner, acquisition);
    f.service.invalidate(native("parent"));
    held.resolve(snapshot("old"));
    await f.committed.promise;
    expect(reads).toBe(2);
    expect(
      f.service.accepted(native("parent"), owner.sessionId)?.map((c) => c.id),
    ).toEqual(["new"]);
  });

  it("rolls back the checkpoint and every child when a batch fails validation", async () => {
    const f = fixture();
    const value = snapshot("valid");
    value.children = [
      ...value.children,
      {
        native: native("other"),
        summary: { ...value.children[0]!.summary, id: "wrong-handle" },
      },
    ];
    f.service.demand(native("parent"), owner, source(value));
    expect(await f.failed.promise).toBeInstanceOf(Error);
    expect(
      f.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
    const reopened = fixture(f.root);
    expect(
      reopened.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
  });

  it("retries a consumed source invalidation once and stays finite when the source cannot stabilize", async () => {
    const f = fixture();
    let reads = 0;
    f.service.demand(native("parent"), owner, {
      observe: async () =>
        snapshot(++reads === 1 ? "stale" : "current", `v${reads}`),
      isCurrent: async () => reads > 1,
    });
    await f.committed.promise;
    expect(reads).toBe(2);
    expect(f.service.accepted(native("parent"), owner.sessionId)).toMatchObject(
      [{ id: "current" }],
    );
    const unstable = fixture();
    let attempts = 0;
    unstable.service.demand(native("parent"), owner, {
      observe: async () => {
        attempts++;
        return snapshot("unstable");
      },
      isCurrent: async () => false,
    });
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(attempts).toBe(2);
    expect(
      unstable.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
  });

  it("accepts explicit corrected parent proof without deleting missing historical child facts", async () => {
    const f = fixture();
    f.service.demand(native("parent"), owner, source(snapshot("child")));
    await f.committed.promise;
    await nextTurn();
    const corrected = snapshot("child", "v2");
    corrected.children[0]!.summary.parentSessionId = "new-parent";
    const done = deferred<void>();
    f.service.demand(
      native("new-parent"),
      { sessionId: "other-ya" },
      {
        observe: async () => corrected,
        isCurrent: async () => {
          done.resolve();
          return true;
        },
      },
    );
    await done.promise;
    await nextTurn();
    expect(f.service.accepted(native("parent"), owner.sessionId)).toEqual([]);
    expect(f.service.accepted(native("new-parent"), "other-ya")).toMatchObject([
      { id: "child" },
    ]);
    expect(f.ownerChanges.slice(-2)).toEqual(
      expect.arrayContaining([owner.sessionId, "other-ya"]),
    );
    f.service.demand(
      native("new-parent"),
      { sessionId: "other-ya" },
      source(snapshot(null, "missing")),
    );
    await nextTurn();
    await nextTurn();
    expect(f.service.accepted(native("new-parent"), "other-ya")).toMatchObject([
      { id: "child" },
    ]);
  });

  it("resumes the same partial version after interruption between bounded SQL batches", async () => {
    const f = fixture();
    const value = snapshot("child-0", "same-version", "partial");
    value.children = Array.from(
      { length: 205 },
      (_, index) => snapshot(`child-${index}`).children[0]!,
    );
    let observations = 0;
    f.service.demand(native("parent"), owner, {
      observe: async () => {
        observations++;
        return value;
      },
      isCurrent: async () => {
        if (observations === 1)
          setImmediate(() => f.service.invalidate(native("parent")));
        return true;
      },
    });
    await f.committed.promise;
    for (let i = 0; i < 8; i++) await nextTurn();
    expect(observations).toBe(2);
    expect(f.service.accepted(native("parent"), owner.sessionId)).toHaveLength(
      205,
    );
  });

  it("withholds an ambiguous parent instead of returning a false accepted empty", async () => {
    const f = fixture();
    f.service.demand(native("parent"), owner, source(snapshot("child")));
    await f.committed.promise;
    const store = new SessionRelationshipStore(f.db.getDatabase());
    try {
      store.record(
        {
          producer: "another-provider-proof",
          sourceKey: "another-proof",
          sourceVersion: "v1",
          extractorVersion: 1,
          observedAt: "2026-11-04T00:00:00.000Z",
        },
        [
          {
            type: "provider_child",
            recordKey: "native-parent",
            trust: "provider-observed",
            source: {
              kind: "native",
              serverId: "local",
              native: native("other-parent"),
            },
            target: {
              kind: "native",
              serverId: "local",
              native: native("child"),
            },
          },
        ],
      );
      expect(
        f.service.accepted(native("parent"), owner.sessionId),
      ).toBeUndefined();
    } finally {
      store.dispose();
    }
  });

  it("retires immediately without awaiting an uncooperative native read or touching finalized SQL", async () => {
    const f = fixture();
    const started = deferred<void>(),
      held = deferred<ProviderChildObservation>();
    f.service.demand(native("parent"), owner, {
      observe: async () => {
        started.resolve();
        return held.promise;
      },
      isCurrent: async () => true,
    });
    await started.promise;
    await f.service.close();
    expect(
      f.service.accepted(native("parent"), owner.sessionId),
    ).toBeUndefined();
    f.db.close();
    held.resolve(snapshot("late"));
    await nextTurn();
    expect(
      f.service.demand(native("parent"), owner, source(snapshot("later"))),
    ).toBe(false);
  });

  it("coalesces changes per native scope and refreshes only the proved parent", async () => {
    const f = fixture();
    const reads = [0, 0, 0];
    let lookups = 0;
    const changedId = "64c067f8-b6e0-4eca-b27a-fc3ccf55331c";
    for (let index = 0; index < 3; index++) {
      f.service.demand(
        native(`parent-${index}`),
        { sessionId: `public-${index}` },
        {
          observe: async () => {
            reads[index]++;
            return snapshot(null, "empty");
          },
          isCurrent: async () => true,
          ownsFileChange: (event) =>
            event.path.startsWith("/owned/native/sessions/"),
          parentsForChanges: async () => {
            lookups++;
            return ["parent-0"];
          },
        },
      );
    }
    for (let i = 0; i < 8; i++) await nextTurn();
    expect(reads).toEqual([1, 1, 1]);
    const event = {
      type: "file-change" as const,
      provider: "codex" as const,
      path: `/owned/native/sessions/rollout-${changedId}.jsonl`,
      relativePath: "unused",
      changeType: "create" as const,
      timestamp: "2026-11-04T00:00:00.000Z",
      fileType: "session" as const,
    };
    for (let i = 0; i < 10; i++) f.service.notifyNativeFileChange(event);
    for (let i = 0; i < 8; i++) await nextTurn();
    expect(lookups).toBe(1);
    expect(reads).toEqual([2, 1, 1]);
    f.service.notifyNativeFileChange({
      ...event,
      path: `/another/profile/rollout-${changedId}.jsonl`,
    });
    for (let i = 0; i < 3; i++) await nextTurn();
    expect(lookups).toBe(1);
    expect(reads).toEqual([2, 1, 1]);
  });

  it("converges across lists larger than the registry without evicting the viewed parent", async () => {
    const seed = fixture();
    for (let index = 0; index < 150; index++) {
      const id = `published-${index}`;
      seed.service.demand(
        native(id),
        { sessionId: id },
        source(snapshot(null)),
      );
      while (!seed.ownerChanges.includes(id)) await nextTurn();
      await nextTurn();
    }
    await seed.service.close();
    seed.db.close();
    const f = fixture(seed.root);
    f.service.demand(
      native("viewed"),
      { sessionId: "viewed" },
      source(snapshot(null)),
    );
    await f.committed.promise;
    let reads = 0;
    const reader = {
      getProviderChildSource: () => ({
        observe: async () => {
          reads++;
          return snapshot(null);
        },
        isCurrent: async () => true,
      }),
    };
    const list = async () => {
      for (let index = 0; index < 150; index++) {
        const id = `published-${index}`;
        expect(
          await resolveProviderChildSessions(reader, id, "accepted-or-cheap", {
            service: f.service,
            native: native(id),
            publicSessionId: id,
          }),
        ).toEqual([]);
      }
    };
    await list();
    for (let i = 0; i < 150; i++) await nextTurn();
    expect(reads).toBe(127);
    expect(f.service.hasSource(native("viewed"))).toBe(true);
    reads = 0;
    await list();
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(reads).toBe(0);
    expect(f.service.hasSource(native("viewed"))).toBe(true);

    // A corrupt/headerless file can keep every childless parent unknown. Those
    // registrations must also converge; opening a parent still retries it.
    const unknown = fixture();
    unknown.service.demand(
      native("viewed"),
      { sessionId: "viewed" },
      source(snapshot(null)),
    );
    await unknown.committed.promise;
    let partialReads = 0;
    const partialReader = {
      getProviderChildSource: () => ({
        observe: async () => {
          partialReads++;
          return snapshot(null, "partial", "partial");
        },
        isCurrent: async () => true,
      }),
    };
    const partialList = async () => {
      for (let index = 0; index < 150; index++) {
        const id = `unknown-${index}`;
        expect(
          await resolveProviderChildSessions(
            partialReader,
            id,
            "accepted-or-cheap",
            {
              service: unknown.service,
              native: native(id),
              publicSessionId: id,
            },
          ),
        ).toBeUndefined();
      }
    };
    await partialList();
    for (let i = 0; i < 150; i++) await nextTurn();
    expect(partialReads).toBe(127);
    partialReads = 0;
    await partialList();
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(partialReads).toBe(0);
    expect(unknown.service.hasSource(native("viewed"))).toBe(true);
    await resolveProviderChildSessions(partialReader, "unknown-0", "fresh", {
      service: unknown.service,
      native: native("unknown-0"),
      publicSessionId: "unknown-0",
    });
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(partialReads).toBe(1);
  });

  it("falls back to live scope owners when a change lookup fails", async () => {
    const f = fixture();
    let reads = 0;
    f.service.demand(native("parent"), owner, {
      observe: async () => {
        reads++;
        return snapshot(null);
      },
      isCurrent: async () => true,
      ownsFileChange: () => true,
      parentsForChanges: async () => {
        throw new Error("transient source failure");
      },
    });
    await f.committed.promise;
    await nextTurn();
    f.service.notifyNativeFileChange({
      type: "file-change",
      provider: "codex",
      path: "/owned/native/sessions/rollout-64c067f8-b6e0-4eca-b27a-fc3ccf55331c.jsonl",
      relativePath: "unused",
      changeType: "create",
      timestamp: "2026-11-04T00:00:00.000Z",
      fileType: "session",
    });
    await f.failed.promise;
    for (let i = 0; i < 5; i++) await nextTurn();
    expect(reads).toBe(2);
    expect(f.service.accepted(native("parent"), owner.sessionId)).toEqual([]);
  });
});
