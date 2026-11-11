import { retainedSessionQuery } from "../../src/services/retained-session-query.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  applyCollectionUpdate,
  collectionView,
  type CollectionUpdate,
} from "@yep-anywhere/shared/collection-updates";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { CollectionUpdates } from "../../src/services/CollectionUpdates.js";
import {
  createCollectionUpdateStream,
  collectionReadPath,
} from "../../src/routes/collection-updates.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { seedRetainedCollection } from "../utils/retained-query-fixture.js";
import { closeTestDiscoveryDatabases } from "../utils/session-metadata-database.js";
import { createGlobalSessionsRoutes } from "../../src/routes/global-sessions.js";
import { createInboxRoutes } from "../../src/routes/inbox.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import type { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";

const owners: CollectionUpdates[] = [];
const folders: string[] = [];
const collections: RetainedSessionCollections[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
  await Promise.all(collections.splice(0).map((owner) => owner.dispose()));
  closeTestDiscoveryDatabases();
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const catalog = {
  catalogEpoch: "epoch",
  catalogGeneration: 1,
  complete: true,
  refreshing: false,
};
const content = (n: number) => ({
  sessions: [{ id: "same", title: String(n) }],
  catalog,
});
const event = (bus: EventBus) =>
  bus.emit({
    type: "session-seen",
    sessionId: "same",
    timestamp: new Date().toISOString(),
  });

it("shares acquisition and a trailing race across tabs, keeps audiences separate, and goes quiet on release", async () => {
  vi.useFakeTimers();
  const bus = new EventBus();
  const owner = new CollectionUpdates(bus);
  owners.push(owner);
  let value = 1;
  let unblock!: () => void;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const read = vi.fn(async () => {
    const captured = value;
    if (captured === 1) await held;
    return content(captured);
  });
  const received: CollectionUpdate[][] = Array.from({ length: 20 }, () => []);
  const releases = received.map((frames) =>
    owner.retain("owner", "/sessions", read, {
      send: (frame) => {
        frames.push(frame);
      },
      fail: (error) => {
        throw error;
      },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  value = 2;
  event(bus);
  unblock();
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  for (const frames of received) {
    expect(frames).toHaveLength(2);
    let decoded: ReturnType<typeof applyCollectionUpdate> | undefined;
    for (const frame of frames) decoded = applyCollectionUpdate(decoded, frame);
    expect(decoded!.body).toEqual(content(2));
  }
  const privateFrames: CollectionUpdate[] = [];
  const privateRelease = owner.retain(
    "limited",
    "/sessions",
    async () => ({ sessions: [], catalog }),
    {
      send: (frame) => {
        privateFrames.push(frame);
      },
      fail: (error) => {
        throw error;
      },
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(privateFrames[0]!.upserts).toEqual([]);
  for (const release of releases) release();
  privateRelease();
  expect(owner.getStats()).toEqual({
    views: 0,
    bytes: 0,
    listening: false,
    timer: false,
  });
  event(bus);
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("sends exact bounded SQL views and changes one row without provider discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-views-"));
  folders.push(dir);
  const now = Date.now();
  const projectId = toUrlProjectId("/collection/project");
  const rows: SessionCatalogRow[] = Array.from({ length: 40 }, (_, n) => ({
    catalogFamily: "claude",
    storeKey: "store",
    sessionId: "session-" + n,
    projectId,
    projectPath: "/collection/project",
    projectIdentityKey: "/collection/project",
    projectName: "Project",
    updatedAt: new Date(now - n * 1000).toISOString(),
    title: "Session " + n,
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "provider", recordId: "session-" + n },
  }));
  rows[30]!.updatedAt = new Date(now - 1_800_000 + 60_000).toISOString();
  const retained = await seedRetainedCollection(dir, rows);
  collections.push(retained);
  const bus = new EventBus();
  const lifetime = new AbortController();
  const owner = new CollectionUpdates(bus, lifetime.signal);
  owners.push(owner);
  const scanner = new ProjectScanner({ projectsDir: join(dir, "no-native") });
  const scan = vi.spyOn(scanner, "listProjects");
  const deps = {
    retainedCollections: retained,
    eventBus: bus,
    scanner,
    readerFactory: vi.fn(
      () => new ClaudeSessionReader({ sessionDir: join(dir, "no-native") }),
    ),
  };
  const app = new Hono();
  app.route("/api/sessions", createGlobalSessionsRoutes(deps));
  app.route("/api/inbox", createInboxRoutes(deps));
  const reads = vi.fn(
    async (_context: unknown, path: string, signal: AbortSignal) =>
      app.request(path, { signal }),
  );
  app.get(
    "/api/activity/collections",
    createCollectionUpdateStream(owner, reads),
  );
  const query = "/sessions?limit=20";
  const response = await app.request(
    "/api/activity/collections?queries=" +
      encodeURIComponent(JSON.stringify([query])),
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = JSON.parse(
    new TextDecoder().decode((await reader.read()).value!).trim(),
  ) as CollectionUpdate;
  const decoded = applyCollectionUpdate(undefined, first);
  expect(decoded.body).toEqual(
    await (await app.request(collectionReadPath(query))).json(),
  );
  expect(first.upserts).toHaveLength(20);
  expect(first.groups!.sessions).toHaveLength(20);
  const inbox = (await (
    await app.request("/api/inbox?summaryMode=retained")
  ).json()) as {
    nextTransitionAt: number;
    recentActivity: Array<{ sessionId: string }>;
  };
  expect(
    inbox.recentActivity.some((row) => row.sessionId === rows[30]!.sessionId),
  ).toBe(false);
  expect(inbox.nextTransitionAt).toBe(now + 60_001);
  const prepare = retained.queryDatabase.prepare.bind(retained.queryDatabase);
  const plans: string[] = [];
  vi.spyOn(retained.queryDatabase, "prepare").mockImplementation((query) => {
    if (
      query.startsWith("SELECT updated_ms") &&
      query.includes("ORDER BY updated_ms ASC")
    ) {
      const explain = prepare("EXPLAIN QUERY PLAN " + query);
      try {
        plans.push(
          ...explain
            .all<{ detail: string }>(projectId, now)
            .map((row) => row.detail),
        );
      } finally {
        explain.finalize();
      }
    }
    return prepare(query);
  });
  await retainedSessionQuery(retained, deps).inbox({
    accessibleProjectIds: [projectId],
    queueIds: [],
    now,
  });
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).toContain("project_id=?");

  const snapshot = collectionView(decoded.body);
  const changed = structuredClone(rows[0]!);
  changed.title = "Changed";
  changed.sourceVersion = "v2";
  Object.assign(rows[0]!, changed);
  await retained.refresh();
  event(bus);
  const next = JSON.parse(
    new TextDecoder().decode((await reader.read()).value!).trim(),
  ) as CollectionUpdate;
  expect(next.base).toBe(first.revision);
  expect(next.upserts.map(([id]) => id)).toEqual([rows[0]!.sessionId]);
  expect(next.groups).toBeUndefined();
  const result = applyCollectionUpdate(
    { revision: first.revision, view: snapshot },
    next,
  );
  expect((result.body.sessions as Array<{ title: string }>)[0]!.title).toBe(
    "Changed",
  );
  expect(scan).not.toHaveBeenCalled();
  expect(deps.readerFactory).not.toHaveBeenCalled();
  lifetime.abort();
  await reader.cancel();
  expect(owner.getStats().views).toBe(0);
});

it("rejects arbitrary reads and enforces the subscription budget before allocation", () => {
  for (const path of [
    "//other/sessions",
    "/settings",
    "/sessions?limit=501",
    "/sessions?q=private",
    "/sessions?after=old",
    "/inbox?projectId=a&projectId=b",
    "/sessions#fragment",
  ])
    expect(() => collectionReadPath(path)).toThrow();
  const bus = new EventBus();
  const owner = new CollectionUpdates(bus);
  owners.push(owner);
  const releases = Array.from({ length: 64 }, (_, n) =>
    owner.retain("actor", String(n), async () => content(n), {
      send: () => {},
      fail: () => {},
    }),
  );
  expect(() =>
    owner.retain("actor", "overflow", async () => content(0), {
      send: () => {},
      fail: () => {},
    }),
  ).toThrow("limit");
  releases.forEach((release) => {
    release();
  });
  expect(owner.getStats().views).toBe(0);
});

it("rearms the shared clock wake for independent views and acquires no idle polling timer", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const owner = new CollectionUpdates(new EventBus());
  owners.push(owner);
  const observed: string[] = [];
  const releases = [20, 250].map((offset) =>
    owner.retain(
      "owner",
      String(offset),
      async () => ({
        ...content(Date.now() >= now + offset ? 2 : 1),
        ...(Date.now() < now + offset
          ? { nextTransitionAt: now + offset }
          : {}),
      }),
      {
        send: (frame) => {
          observed.push(frame.query);
        },
        fail: (error) => {
          throw error;
        },
      },
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toEqual(["20", "250"]);
  await vi.advanceTimersByTimeAsync(400);
  expect(observed).toEqual(["20", "250", "20", "250"]);
  expect(owner.getStats().timer).toBe(false);
  releases.forEach((release) => {
    release();
  });
});

it("releases a departed reader's authentication context while peer viewers remain", async () => {
  vi.useFakeTimers();
  const bus = new EventBus();
  const owner = new CollectionUpdates(bus);
  owners.push(owner);
  const first = vi.fn(async () => content(1));
  const second = vi.fn(async () => content(2));
  const frames: CollectionUpdate[] = [];
  const releaseFirst = owner.retain("same-principal", "/sessions", first, {
    send: () => {},
    fail: (error) => {
      throw error;
    },
  });
  const releaseSecond = owner.retain("same-principal", "/sessions", second, {
    send: (frame) => {
      frames.push(frame);
    },
    fail: (error) => {
      throw error;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  releaseFirst();
  event(bus);
  await vi.advanceTimersByTimeAsync(100);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(frames.at(-1)!.upserts[0]![1].title).toBe("2");
  releaseSecond();
});

it("shares same-credential tabs across referrers without merging independent credentials", async () => {
  const owner = new CollectionUpdates(new EventBus());
  owners.push(owner);
  const read = vi.fn(async () => Response.json(content(1)));
  const app = new Hono();
  app.get("/collections", createCollectionUpdateStream(owner, read));
  const query =
    "/collections?queries=" + encodeURIComponent(JSON.stringify(["/sessions"]));
  const responses = await Promise.all([
    app.request(query, {
      headers: { Cookie: "auth=one", Referer: "http://host/a" },
    }),
    app.request(query, {
      headers: { Cookie: "auth=one", Referer: "http://host/b" },
    }),
  ]);
  const readers = responses.map((response) => response.body!.getReader());
  try {
    await Promise.all(readers.map((reader) => reader.read()));
    expect(read).toHaveBeenCalledTimes(1);
    const peer = await app.request(query, { headers: { Cookie: "auth=two" } });
    const peerReader = peer.body!.getReader();
    await peerReader.read();
    expect(read).toHaveBeenCalledTimes(2);
    await peerReader.cancel();
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
  expect(owner.getStats().views).toBe(0);
});

it.each(["resolve", "reject"] as const)(
  "fences an in-flight departed reader before its late %s and retries a surviving peer",
  async (completion) => {
    vi.useFakeTimers();
    const owner = new CollectionUpdates(new EventBus());
    owners.push(owner);
    let resolve!: (body: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    const held = new Promise<Record<string, unknown>>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const failures = vi.fn();
    const frames: CollectionUpdate[] = [];
    const release = owner.retain(
      "credential",
      "/sessions",
      async (value) => {
        signal = value;
        return held;
      },
      { send: () => {}, fail: failures },
    );
    await vi.advanceTimersByTimeAsync(0);
    const peer = owner.retain(
      "credential",
      "/sessions",
      async () => content(2),
      {
        send: (frame) => {
          frames.push(frame);
        },
        fail: failures,
      },
    );
    release();
    expect(signal.aborted).toBe(true);
    if (completion === "resolve") resolve(content(1));
    else reject(new Error("Departed credential"));
    await vi.advanceTimersByTimeAsync(200);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.upserts[0]![1].title).toBe("2");
    expect(failures).not.toHaveBeenCalled();
    peer();
  },
);

it("retains the existing UTC archive boundary and schedules a view crossing it during acquisition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-midnight-"));
  folders.push(dir);
  const midnight = Date.UTC(2026, 10, 12);
  const projectId = toUrlProjectId("/archive/project");
  const row: SessionCatalogRow = {
    catalogFamily: "claude",
    storeKey: "archive",
    sessionId: "archive-row",
    projectId,
    projectPath: "/archive/project",
    projectIdentityKey: "/archive/project",
    projectName: "Archive",
    updatedAt: new Date(midnight - 36 * 3_600_000).toISOString(),
    fidelity: "head",
    sourceVersion: "one",
    location: { kind: "provider", recordId: "archive-row" },
  };
  const retained = await seedRetainedCollection(dir, [row]);
  collections.push(retained);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(midnight - 1);
  const deps = {
    sessionAutoArchiveDays: 1,
    scanner: new ProjectScanner({ projectsDir: join(dir, "none") }),
    readerFactory: () =>
      new ClaudeSessionReader({ sessionDir: join(dir, "none") }),
  };
  const query = retainedSessionQuery(retained, deps);
  const before = await query.page({ limit: 20 });
  expect(before.sessions).toHaveLength(1);
  expect(before.nextTransitionAt).toBe(midnight);
  vi.setSystemTime(midnight + 1);
  const after = await query.page({ limit: 20 });
  expect(after.sessions).toEqual([]);
  expect(after.nextTransitionAt).toBeUndefined();
});

it("reacquires an overdue clock boundary instead of freezing the pre-boundary snapshot", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const owner = new CollectionUpdates(new EventBus());
  owners.push(owner);
  let reads = 0;
  const frames: CollectionUpdate[] = [];
  const release = owner.retain(
    "owner",
    "/sessions",
    async () => {
      if (++reads === 1) {
        vi.setSystemTime(start + 2);
        return { ...content(1), nextTransitionAt: start + 1 };
      }
      return { sessions: [], catalog };
    },
    {
      send: (frame) => {
        frames.push(frame);
      },
      fail: (error) => {
        throw error;
      },
    },
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(reads).toBe(2);
  expect(frames.at(-1)!.removed).toEqual(["same"]);
  expect(owner.getStats().timer).toBe(false);
  release();
});

it("keeps a project page's global statistics on every accessible archive deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "collection-stats-clock-"));
  folders.push(dir);
  const midnight = Date.UTC(2026, 10, 12),
    a = toUrlProjectId("/stats/a"),
    b = toUrlProjectId("/stats/b");
  const rows: SessionCatalogRow[] = [a, b].map((projectId, n) => ({
    catalogFamily: "claude",
    storeKey: "stats",
    sessionId: "stats-" + n,
    projectId,
    projectPath: n ? "/stats/b" : "/stats/a",
    projectIdentityKey: n ? "/stats/b" : "/stats/a",
    projectName: n ? "B" : "A",
    updatedAt: new Date(midnight - (n ? 36 : 12) * 3_600_000).toISOString(),
    fidelity: "head",
    sourceVersion: "one",
    location: { kind: "provider", recordId: "stats-" + n },
  }));
  const retained = await seedRetainedCollection(dir, rows);
  collections.push(retained);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(midnight - 1);
  const query = retainedSessionQuery(retained, {
    sessionAutoArchiveDays: 1,
    scanner: new ProjectScanner({ projectsDir: join(dir, "none") }),
    readerFactory: () =>
      new ClaudeSessionReader({ sessionDir: join(dir, "none") }),
  });
  const before = await query.page({
    filterProjectId: a,
    accessibleProjectIds: [a, b],
    limit: 20,
  });
  expect(before.sessions.map((row) => row.projectId)).toEqual([a]);
  expect(before.stats.totalCount).toBe(2);
  expect(before.nextTransitionAt).toBe(midnight);
  vi.setSystemTime(midnight + 1);
  const after = await query.page({
    filterProjectId: a,
    accessibleProjectIds: [a, b],
    limit: 20,
  });
  expect(after.sessions.map((row) => row.projectId)).toEqual([a]);
  expect(after.stats.totalCount).toBe(1);
  expect(after.nextTransitionAt).toBe(midnight + 86_400_000);
});

it("shares project publications and queue deadlines without file-event reacquisition or stale-clock spinning", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const bus = new EventBus();
  const owner = new CollectionUpdates(bus);
  owners.push(owner);
  const projects = vi.fn(async () => ({
    projects: [{ id: "a", caption: "one" }],
    catalog,
  }));
  let state = "waiting",
    caption = "one";
  const queue = vi.fn(async () => ({
    items: [{ id: "q", message: { text: caption } }],
    recoveredSessionQueues: [],
    projectStatuses: {
      a: {
        projectId: "a",
        state,
        quietEligibleAt: new Date(11000).toISOString(),
      },
    },
  }));
  const frames: CollectionUpdate[] = [];
  const listeners = {
    send: (frame: CollectionUpdate) => {
      frames.push(frame);
    },
    fail: (error: unknown) => {
      throw error;
    },
  };
  const releaseProjects = owner.retain(
    "auth",
    "/projects?summaryMode=retained",
    projects,
    listeners,
  );
  const releaseQueue = owner.retain("auth", "/project-queue", queue, {
    ...listeners,
  });
  const releasePeer = owner.retain("auth", "/project-queue", queue, {
    ...listeners,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(projects).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledTimes(1);
  event(bus);
  await vi.advanceTimersByTimeAsync(200);
  expect(projects).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledTimes(1);
  bus.emit({
    type: "projects-changed",
    projectIds: [],
    collectionRefresh: true,
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(projects).toHaveBeenCalledTimes(2);
  expect(queue).toHaveBeenCalledTimes(1);
  caption = "two";
  state = "ready";
  await vi.advanceTimersByTimeAsync(600);
  expect(queue).toHaveBeenCalledTimes(2);
  expect(
    frames.filter((frame) => frame.query === "/project-queue").at(-1)!.upserts,
  ).toContainEqual(["items:q", { id: "q", message: { text: "two" } }]);
  state = "blocked";
  await vi.advanceTimersByTimeAsync(5000);
  expect(queue).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(20000);
  expect(queue).toHaveBeenCalledTimes(3);
  releasePeer();
  releaseQueue();
  releaseProjects();
  expect(owner.getStats()).toEqual({
    views: 0,
    bytes: 0,
    listening: false,
    timer: false,
  });
});

it("refuses normalized path aliases instead of allocating differently classified project interests", () => {
  expect(collectionReadPath("/projects")).toBe(
    "/api/projects?summaryMode=retained",
  );
  expect(collectionReadPath("/project-queue")).toBe("/api/project-queue?");
  for (const query of [
    "/x/../projects",
    "/%2e/projects",
    "//collection.invalid/projects",
    "/x/../project-queue",
    "/project-queue?summaryMode=retained",
  ])
    expect(() => collectionReadPath(query)).toThrow();
});
