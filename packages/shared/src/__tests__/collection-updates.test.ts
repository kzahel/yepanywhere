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
