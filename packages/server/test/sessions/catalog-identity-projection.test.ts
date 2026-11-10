import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { readRetainedSessionItems } from "../../src/routes/retained-session-collections.js";
import type { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

const dirs: string[] = [];
afterEach(async () => {
  closeTestDiscoveryDatabases();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

function row(
  sessionId: string,
  projectPath: string,
  extra: Partial<SessionCatalogRow> = {},
): SessionCatalogRow {
  return {
    catalogFamily: "claude",
    storeKey: "/store",
    nativeStorageScope: "/store",
    sessionId,
    projectId: toUrlProjectId(projectPath),
    projectPath,
    projectIdentityKey: projectPath,
    updatedAt: "2026-11-01T00:00:00.000Z",
    title: `title ${sessionId}`,
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "file", path: `/store/${sessionId}.jsonl` },
    ...extra,
  };
}

it("projects a bound row once per published row object and per identity store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-catalog-projection-"));
  dirs.push(dir);
  const metadata = createTestSessionMetadataService(dir);
  await metadata.initialize();
  const lookups = vi.spyOn(metadata.identities, "lookupNativeBatch");
  const bound = row("11111111-1111-4111-8111-111111111111", "/p");
  const unscoped = row("grok-1", "/p", {
    catalogFamily: "grok",
    nativeStorageScope: undefined,
  });

  // The first read adopts the row; the second finds its binding.
  const [adopted] = await projectCatalogIdentities([bound], metadata);
  const [second, plain] = await projectCatalogIdentities(
    [bound, unscoped],
    metadata,
  );
  expect(second).toEqual(adopted);
  expect(lookups.mock.calls.at(-1)?.[0]).toHaveLength(1);

  // From then on the same row object reads no identity at all.
  const [third, plainAgain] = await projectCatalogIdentities(
    [bound, unscoped],
    metadata,
  );
  expect(third).toBe(second);
  expect(Object.isFrozen(third)).toBe(true);
  expect(lookups.mock.calls.at(-1)?.[0]).toHaveLength(0);
  expect(plainAgain).not.toBe(plain);
  expect(plainAgain).toEqual(plain);

  // A changed row is a new object and is projected again.
  const changed = { ...bound, title: "renamed" };
  const [renamed] = await projectCatalogIdentities([changed], metadata);
  expect(renamed).toEqual({ ...second, title: "renamed" });
  expect(lookups.mock.calls.at(-1)?.[0]).toHaveLength(1);

  // Another identity store (a restarted service) keeps its own projections.
  const reopened = createTestSessionMetadataService(dir);
  await reopened.initialize();
  const reopenedLookups = vi.spyOn(reopened.identities, "lookupNativeBatch");
  const [again] = await projectCatalogIdentities([bound], reopened);
  expect(again).toEqual(second);
  expect(reopenedLookups.mock.calls.at(-1)?.[0]).toHaveLength(1);
});

it("projects an OpenCode row moved to its bound project on every read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-catalog-projection-"));
  dirs.push(dir);
  const metadata = createTestSessionMetadataService(dir);
  await metadata.initialize();
  const id = "22222222-2222-4222-8222-222222222222";
  const opencode = { catalogFamily: "opencode", provider: "opencode" } as const;
  const [adopted] = await projectCatalogIdentities(
    [row(id, "/bound", opencode)],
    metadata,
  );
  expect(adopted?.projectId).toBe(toUrlProjectId("/bound"));
  // The same session now listed under another worktree, in the directory of
  // its bound project: projected to the bound project, which depends on the
  // filesystem, so it is not kept.
  const moved = row(id, "/worktree", {
    ...opencode,
    nativeDirectoryProjectId: toUrlProjectId("/bound"),
  });
  const lookups = vi.spyOn(metadata.identities, "lookupNativeBatch");
  for (let read = 0; read < 2; read++) {
    const [projected] = await projectCatalogIdentities([moved], metadata);
    expect(projected?.projectId).toBe(toUrlProjectId("/bound"));
    expect(Object.isFrozen(projected)).toBe(false);
    expect(lookups.mock.calls.at(-1)?.[0]).toHaveLength(1);
  }
});

it("orders project options with equal names by id, not by row order", async () => {
  const rows = [
    row("a", "/z/checkout", { nativeStorageScope: undefined }),
    row("b", "/a/checkout", { nativeStorageScope: undefined }),
    row("c", "/m/beta", { nativeStorageScope: undefined }),
  ];
  const read = (order: SessionCatalogRow[]) =>
    readRetainedSessionItems(
      {
        read: async () => ({ rows: order, catalog: {} }),
      } as unknown as RetainedSessionCollections,
      {},
    );
  const expected = [
    { id: toUrlProjectId("/m/beta"), name: "beta" },
    { id: toUrlProjectId("/a/checkout"), name: "checkout" },
    { id: toUrlProjectId("/z/checkout"), name: "checkout" },
  ].sort((a, b) =>
    a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  expect((await read(rows)).projects).toEqual(expected);
  expect((await read([...rows].reverse())).projects).toEqual(expected);
});

it("shares one walk between requests that ask before it starts", async () => {
  const rows = [
    row("a", "/p", { nativeStorageScope: undefined }),
    row("b", "/p", {
      nativeStorageScope: undefined,
      updatedAt: "2026-11-02T00:00:00.000Z",
    }),
  ];
  const read = vi.fn(async () => ({ rows, catalog: {} }));
  const service = { read } as unknown as RetainedSessionCollections;
  const deps = {};
  const [first, second] = await Promise.all([
    readRetainedSessionItems(service, deps),
    readRetainedSessionItems(service, deps, (sessions) => sessions.slice(0, 1)),
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(second.sessions).toEqual(first.sessions);
  expect(second.sessions).not.toBe(first.sessions);
  expect(second.stats).not.toBe(first.stats);

  // Child enrichment is per request: one sharer's children never reach the
  // other's items.
  const accepted = vi.fn(() => []);
  const scopedRows = rows.map((r) => ({ ...r, nativeStorageScope: "/store" }));
  const scoped = {
    read: vi.fn(async () => ({ rows: scopedRows, catalog: {} })),
  } as unknown as RetainedSessionCollections;
  const [withChildren, without] = await Promise.all([
    readRetainedSessionItems(
      scoped,
      { providerChildRelationships: { accepted } } as never,
      (sessions) => sessions,
    ),
    readRetainedSessionItems(scoped, {}),
  ]);
  expect(accepted).toHaveBeenCalledTimes(2);
  expect(withChildren.sessions.map((s) => s.providerChildren)).toEqual([
    [],
    [],
  ]);
  expect(without.sessions.map((s) => "providerChildren" in s)).toEqual([
    false,
    false,
  ]);

  // A request after the walk started gets a walk of its own.
  await readRetainedSessionItems(service, deps);
  expect(read).toHaveBeenCalledTimes(2);
  // Different inputs never share.
  await Promise.all([
    readRetainedSessionItems(service, deps),
    readRetainedSessionItems(service, { sessionAutoArchiveDays: 0 }),
  ]);
  expect(read).toHaveBeenCalledTimes(4);
});
