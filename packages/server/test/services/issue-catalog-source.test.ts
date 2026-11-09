import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import { issueCatalogSource } from "../../src/services/issues/issue-catalog-source.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import {
  DISCOVERY_MIGRATIONS,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  closeTestDiscoveryDatabases();
});

/**
 * The three spellings of a catalog key must agree: the indexer's (from the
 * projected row's native id), the catalog's own, and migration 029's (JSON
 * functions over an old copied row). A store key with characters JSON escapes
 * makes a disagreement visible.
 */
it("keys a public row as the catalog and migration 029 do", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "issue-catalog-source-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const database = openTestDiscoveryDatabase(dataDir);
  const store = '/st"o\\re é😀';
  const projectId = "id-project" as UrlProjectId;
  database
    .prepare(
      "INSERT INTO session_identities (session_id, provider, project_id, created_at, native_family, native_scope, native_id) VALUES ('public-1', 'claude', ?, '2026-11-09T00:00:00.000Z', 'claude', ?, 'native-1')",
    )
    .run(projectId, store);
  const metadata = new SessionMetadataService({ dataDir, database });
  await metadata.initialize();
  const catalog = new SessionCatalogService({ database });
  await catalog.initialize();
  const row: SessionCatalogRow = {
    catalogFamily: "claude",
    storeKey: store,
    sessionId: "native-1",
    nativeStorageScope: store,
    projectId,
    projectPath: "/project",
    projectIdentityKey: "/project",
    updatedAt: "2026-11-09T00:00:00.000Z",
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "file", path: "/store/native-1.jsonl" },
  };
  const adapter = (rows: SessionCatalogRow[]) => ({
    catalogFamily: "claude" as const,
    storeKey: store,
    scan: async () => ({ sourceVersion: "s", rows }),
  });
  await catalog.reconcile([adapter([row])]);
  const source = issueCatalogSource(
    {
      readChanges: async (since) => catalog.readChanges(since),
      readRow: async (key) => catalog.readRow(key),
    },
    metadata,
  );

  const first = await source.changes(undefined, new Set());
  expect(first.rows).toHaveLength(1);
  const [projected] = first.rows;
  expect(projected?.sessionId).toBe("public-1");
  expect(catalog.readRow(projected!.catalogKey)).toMatchObject({
    sessionId: "native-1",
  });
  expect(await source.row(projected!.catalogKey)).toMatchObject({
    sessionId: "public-1",
    catalogKey: projected!.catalogKey,
  });

  // An old job copied the projected row; the migration derives the same key.
  const old = loadSqliteDriver()!.open(":memory:");
  try {
    migrateDiscoveryDatabase(old, DISCOVERY_MIGRATIONS.slice(0, 28));
    const { catalogKey: _key, ...copied } = projected!;
    old
      .prepare(
        "INSERT INTO issue_index_jobs(session_id,project_id,source_version,state,updated_at,source_json,priority) VALUES ('public-1','p','v1','indexed',1,?,0)",
      )
      .run(JSON.stringify({ ...copied, nativeSessionId: "native-1" }));
    migrateDiscoveryDatabase(old);
    expect(
      old.prepare("SELECT catalog_key FROM issue_index_jobs").get<{
        catalog_key: string;
      }>()?.catalog_key,
    ).toBe(projected!.catalogKey);
  } finally {
    old.close();
  }

  // Its removal names the same key.
  await catalog.reconcile([adapter([])]);
  const second = await source.changes(first.mark, new Set());
  expect(second).toMatchObject({
    full: false,
    rows: [],
    removed: [projected!.catalogKey],
  });
  catalog.stop();
});
