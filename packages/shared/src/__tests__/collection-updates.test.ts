import { expect, it } from "vitest";
import {
  collectionView,
  diffCollectionView,
  applyCollectionUpdate,
} from "../collection-updates.js";

it("round-trips query membership, absent fields, removals and shared unchanged rows", () => {
  const first = collectionView({
    sessions: [{ id: "a", optional: "old" }, { id: "b" }],
    hasMore: true,
    stats: { total: 2 },
  });
  const seed = diffCollectionView("query", 1, undefined, first)!;
  const saved = applyCollectionUpdate(undefined, seed);
  const next = collectionView({
    sessions: [{ id: "c" }, { id: "a" }],
    hasMore: false,
    stats: { total: 2 },
  });
  const change = diffCollectionView("query", 2, first, next)!;
  expect(change.removed).toEqual(["b"]);
  expect(change.upserts.map(([id]) => id)).toEqual(["c", "a"]);
  expect(applyCollectionUpdate(saved, change).body).toEqual({
    sessions: [{ id: "c" }, { id: "a" }],
    hasMore: false,
    stats: { total: 2 },
  });
  const changedOne = collectionView({
    sessions: [{ id: "a", optional: "new" }, { id: "b" }],
    hasMore: true,
    stats: { total: 2 },
  });
  const result = applyCollectionUpdate(
    saved,
    diffCollectionView("query", 2, first, changedOne)!,
  );
  expect((result.body.sessions as unknown[])[1]).toBe(
    (saved.body.sessions as unknown[])[1],
  );
  expect(
    diffCollectionView("query", 3, changedOne, changedOne),
  ).toBeUndefined();
});
it("fails closed on missed, duplicated, stale or incomplete messages and accepts an explicit replacement", () => {
  const view = collectionView({
    active: [{ sessionId: "id" }],
    recentActivity: [],
  });
  const seed = diffCollectionView("inbox", 7, undefined, view)!;
  const saved = applyCollectionUpdate(undefined, seed);
  for (const change of [
    { ...seed, base: 5, revision: 6 },
    { ...seed, base: 7, revision: 9 },
    { ...seed, base: 7, revision: 7 },
    { ...seed, base: null, revision: 6 },
    { ...seed, base: 7, revision: 8, groups: { active: ["missing"] } },
  ])
    expect(() => applyCollectionUpdate(saved, change)).toThrow();
  const replacement = diffCollectionView(
    "inbox",
    9,
    undefined,
    collectionView({ active: [], recentActivity: [] }),
  )!;
  expect(applyCollectionUpdate(saved, replacement).body).toEqual({
    active: [],
    recentActivity: [],
  });
});

it("round-trips queue groups with colliding ids and project fields without stale metadata", () => {
  const first = {
    items: [{ id: "same", message: { text: "queued" }, targetTitle: "old" }],
    recoveredSessionQueues: [{ id: "same", content: "patient" }],
    projectStatuses: { same: { projectId: "same", state: "ready" } },
    dispatchState: { paused: true },
  };
  const start = collectionView(first, "/project-queue");
  expect(start.rows).toHaveLength(3);
  const saved = applyCollectionUpdate(
    undefined,
    diffCollectionView("/project-queue", 1, undefined, start)!,
  );
  expect(saved.body).toEqual(first);
  const next = {
    ...first,
    items: [{ id: "same", message: { text: "changed" } }],
    projectStatuses: {},
  };
  const change = diffCollectionView(
    "/project-queue",
    2,
    start,
    collectionView(next, "/project-queue"),
  )!;
  expect(change.upserts).toHaveLength(1);
  const accepted = applyCollectionUpdate(saved, change);
  expect(accepted.body).toEqual(next);
  expect((accepted.body.recoveredSessionQueues as unknown[])[0]).toBe(
    first.recoveredSessionQueues[0],
  );
  const projects = {
    projects: [{ id: "a", caption: "old" }, { id: "b" }],
    catalog: { complete: false },
  };
  const view = collectionView(projects, "/projects");
  const initial = applyCollectionUpdate(
    undefined,
    diffCollectionView("/projects", 1, undefined, view)!,
  );
  const updated = {
    projects: [{ id: "a" }, { id: "b" }],
    catalog: { complete: true },
  };
  const delta = diffCollectionView(
    "/projects",
    2,
    view,
    collectionView(updated, "/projects"),
  )!;
  expect(delta.upserts).toEqual([["projects:a", { id: "a" }]]);
  expect(applyCollectionUpdate(initial, delta).body).toEqual(updated);
  // Project options stay metadata on the older session/Inbox protocol.
  expect(collectionView({ sessions: [], ...projects }).groups).toEqual({
    sessions: [],
  });
  expect(() =>
    collectionView(
      {
        projects: Array.from({ length: 501 }, (_, id) => ({ id: String(id) })),
      },
      "/projects",
    ),
  ).toThrow("Oversized");
});

it("enforces project row bounds after URL normalization", () => {
  const body = {
    projects: Array.from({ length: 501 }, (_, n) => ({ id: String(n) })),
  };
  for (const query of [
    "/projects",
    "/x/../projects",
    "/%2e/projects",
    "/projects?",
  ])
    expect(() => collectionView(body, query)).toThrow("Oversized");
});

it("retains unchanged options through metadata edits, removals, mixed formats and recovery", () => {
  const projects = [{ id: "p", name: "Stable" }];
  const first = collectionView({
    sessions: [{ id: "a" }],
    projects,
    catalog: { generation: 1 },
    nextTransitionAt: 10,
  });
  const seed = diffCollectionView("q", 1, undefined, first, true)!;
  expect(seed.metaFields).toBeUndefined();
  let accepted = applyCollectionUpdate(undefined, seed);
  const next = collectionView({
    sessions: [{ id: "a" }],
    projects: [...projects],
    catalog: { generation: 2 },
  });
  const change = diffCollectionView("q", 2, first, next, true)!;
  expect(change.meta).toBeUndefined();
  expect(change.metaFields).toEqual({
    set: { catalog: { generation: 2 } },
    removed: ["nextTransitionAt"],
  });
  const updated = applyCollectionUpdate(
    accepted,
    JSON.parse(JSON.stringify(change)),
  );
  expect(updated.body).toEqual({
    sessions: [{ id: "a" }],
    projects,
    catalog: { generation: 2 },
  });
  expect(updated.body.projects).toBe(accepted.body.projects);
  expect(accepted.body.nextTransitionAt).toBe(10);
  // Legacy peers still get complete replacements; the current decoder accepts both.
  const legacy = diffCollectionView("q", 3, next, first)!;
  expect(legacy.meta).toEqual(first.meta);
  accepted = applyCollectionUpdate(updated, legacy);
  const replacement = diffCollectionView("q", 5, undefined, next, true)!;
  expect(applyCollectionUpdate(accepted, replacement).body).toEqual(
    updated.body,
  );
  for (const invalid of [
    { ...change, meta: {} },
    { ...change, base: null },
    { ...change, metaFields: { set: [], removed: [] } },
    { ...change, metaFields: { set: { same: 1 }, removed: ["same"] } },
    { ...change, metaFields: { set: {}, removed: ["x", "x"] } },
  ])
    expect(() =>
      applyCollectionUpdate(
        applyCollectionUpdate(undefined, seed),
        JSON.parse(JSON.stringify(invalid)),
      ),
    ).toThrow();
  const reordered = {
    ...first,
    meta: { nextTransitionAt: 10, catalog: { generation: 1 }, projects },
  };
  const reorderFrame = diffCollectionView("q", 2, first, reordered, true)!;
  // A metadata-key order change cannot silently skip a shared stream revision.
  expect(
    applyCollectionUpdate(applyCollectionUpdate(undefined, seed), reorderFrame)
      .revision,
  ).toBe(2);
});
