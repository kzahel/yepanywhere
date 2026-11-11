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
