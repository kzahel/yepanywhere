import { seedRetainedCollection } from "../utils/retained-query-fixture.js";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { readRetainedSessionItems } from "../../src/routes/retained-session-collections.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  projectCatalogIdentities,
  projectCatalogIdentityResult,
} from "../../src/sessions/catalog-identity.js";
import { retainedSessionQuery } from "../../src/services/retained-session-query.js";
import { issueCatalogSource } from "../../src/services/issues/issue-catalog-source.js";
import { sessionCatalogRowKey } from "../../src/sessions/catalog-types.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const dirs: string[] = [];
const owned: RetainedSessionCollections[] = [];
afterEach(async () => {
  for (const collection of owned.splice(0)) await collection.dispose();
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

it("keeps a bound Claude project alias in retained lists and rechecks a changed symlink", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ya-claude-alias-")));
  dirs.push(dir);
  const physical = join(dir, "physical");
  const other = join(dir, "other");
  const alias = join(dir, "alias");
  await Promise.all([physical, other].map((path) => mkdir(path)));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(physical, alias, linkType);
  const metadata = createTestSessionMetadataService(dir);
  await metadata.initialize();
  const id = "33333333-3333-4333-8333-333333333333";
  const native = row(id, physical);
  const healthy = row("44444444-4444-4444-8444-444444444444", other);
  await projectCatalogIdentities([row(id, alias)], metadata);

  const collection = await seedRetainedCollection(dir, [native, healthy]);
  owned.push(collection);
  const deps = { sessionMetadataService: metadata };
  const result = await readRetainedSessionItems(collection, deps);
  expect(result.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, projectId: toUrlProjectId(alias) }),
    ]),
  );
  expect(result.projects).toEqual(
    expect.arrayContaining([{ id: toUrlProjectId(alias), name: "alias" }]),
  );
  const inbox = await retainedSessionQuery(collection, deps).inbox({
    queueIds: [],
    now: Date.parse(native.updatedAt),
  });
  expect(inbox.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, projectId: toUrlProjectId(alias) }),
    ]),
  );
  await expect(
    projectCatalogIdentities(
      [{ ...native, nativeStorageScope: "/unrelated-native-store" }],
      metadata,
    ),
  ).resolves.toEqual([]);

  // Keep the same published row object: filesystem-dependent projections must
  // not inherit the permanent cache used for a matching project id.
  await projectCatalogIdentities([native], metadata);
  await rm(alias);
  await symlink(other, alias, linkType);
  const conflicted = await projectCatalogIdentityResult([native], metadata);
  expect(conflicted.rows).toEqual([]);
  expect(conflicted.conflicts).toEqual([native]);
  const partial = await readRetainedSessionItems(collection, deps);
  expect(partial.sessions.map((session) => session.id)).toEqual([
    healthy.sessionId,
  ]);
  expect(partial.catalog).toMatchObject({
    complete: false,
    refreshError: expect.any(String),
  });
  const partialInbox = await retainedSessionQuery(collection, deps).inbox({
    queueIds: [],
    now: Date.parse(native.updatedAt),
  });
  expect(partialInbox.sessions.map((session) => session.id)).toEqual([
    healthy.sessionId,
  ]);
  expect(partialInbox.catalog.complete).toBe(false);
  const reopened = new RetainedSessionCollections({
    dataDir: dir,
    database: openTestDiscoveryDatabase(dir),
    adapters: async () => [],
  });
  owned.push(reopened);
  const restored = await readRetainedSessionItems(reopened, deps);
  expect(restored.sessions.map((session) => session.id)).toEqual([
    healthy.sessionId,
  ]);
  expect(restored.catalog.complete).toBe(false);
  const issues = issueCatalogSource(collection, metadata);
  const issueChanges = await issues.changes(undefined, new Set());
  expect(issueChanges.rows.map((row) => row.sessionId)).toEqual([
    healthy.sessionId,
  ]);
  expect(issueChanges.excluded).toEqual([sessionCatalogRowKey(native)]);
  expect(await issues.row(sessionCatalogRowKey(native))).toBeUndefined();
  await rm(alias);
  await expect(projectCatalogIdentities([native], metadata)).resolves.toEqual(
    [],
  );
  await symlink(physical, alias, linkType);
  const recovered = await readRetainedSessionItems(collection, deps);
  expect(recovered.sessions.map((session) => session.id).sort()).toEqual(
    [id, healthy.sessionId].sort(),
  );
  expect(recovered.catalog.complete).toBe(true);
  expect(recovered.catalog.refreshError).toBeUndefined();
  expect(
    (await readRetainedSessionItems(reopened, deps)).catalog.complete,
  ).toBe(true);
  const issueRecovery = await issues.changes(
    issueChanges.mark,
    new Set([sessionCatalogRowKey(native)]),
  );
  expect(issueRecovery.rows.map((row) => row.sessionId)).toContain(id);
});

it("orders project options with equal names by id, not by row order", async () => {
  const rows = [
    row("a", "/z/checkout", { nativeStorageScope: undefined }),
    row("b", "/a/checkout", { nativeStorageScope: undefined }),
    row("c", "/m/beta", { nativeStorageScope: undefined }),
  ];
  const read = async (order: SessionCatalogRow[]) => {
    const dir = await mkdtemp(join(tmpdir(), "ya-query-sort-"));
    dirs.push(dir);
    const collection = await seedRetainedCollection(dir, order);
    owned.push(collection);
    return readRetainedSessionItems(collection, {});
  };
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
