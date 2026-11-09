import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionCatalogService,
  type SessionCatalogServiceOptions,
} from "../../src/services/SessionCatalogService.js";
import { SessionCatalogSqliteStore } from "../../src/services/session-catalog-sqlite.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../../src/sessions/catalog-types.js";
import type { SqliteDatabase } from "../../src/storage/sqlite.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

interface RowSpec {
  sessionId: string;
  project: string;
  updatedAt?: string;
  title?: string;
}

function row(spec: RowSpec): SessionCatalogRow {
  return {
    catalogFamily: "codex",
    storeKey: "default",
    sessionId: spec.sessionId,
    projectId: `id-${spec.project}` as UrlProjectId,
    projectPath: `/projects/${spec.project}`,
    projectIdentityKey: `/projects/${spec.project}`,
    updatedAt: spec.updatedAt ?? "2026-08-01T00:00:00.000Z",
    ...(spec.title === undefined ? {} : { title: spec.title }),
    fidelity: "identity",
    sourceVersion: `${spec.sessionId}@${spec.updatedAt ?? "base"}`,
    location: { kind: "file", path: `/store/${spec.sessionId}.jsonl` },
  };
}

interface CountingAdapter extends NativeSessionCatalogAdapter {
  scans: number;
}

function adapter(
  rows: readonly SessionCatalogRow[],
  options: { failWith?: Error; storeKey?: string } = {},
): CountingAdapter {
  const instance: CountingAdapter = {
    catalogFamily: "codex",
    storeKey: options.storeKey ?? "default",
    scans: 0,
    scan: async () => {
      instance.scans += 1;
      if (options.failWith) throw options.failWith;
      return {
        sourceVersion: "store-v1",
        rows: rows.map((candidate) => ({ ...candidate })),
      };
    },
  };
  return instance;
}

const ids = (rows: readonly Readonly<SessionCatalogRow>[]) =>
  rows.map((entry) => entry.sessionId).sort();

describe("SessionCatalogService", () => {
  let dataDir: string;
  const services: SessionCatalogService[] = [];

  /** A service on a new connection, as a restarted server would have. */
  function createService(
    overrides: Partial<SessionCatalogServiceOptions> = {},
  ): SessionCatalogService {
    const service = new SessionCatalogService({
      database: openTestDiscoveryDatabase(dataDir),
      ...overrides,
    });
    services.push(service);
    return service;
  }

  function storedRows(database: SqliteDatabase) {
    return database
      .prepare(
        "SELECT native_id, changed_gen, deleted FROM session_catalog ORDER BY native_id",
      )
      .all<{ native_id: string; changed_gen: number; deleted: number }>();
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "session-catalog-"));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.stop();
    closeTestDiscoveryDatabases();
    await chmod(dataDir, 0o755).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the stored generation after restart without scanning", async () => {
    const first = createService();
    await first.initialize();
    const source = adapter([
      row({ sessionId: "a", project: "alpha" }),
      row({ sessionId: "b", project: "beta" }),
    ]);
    await first.reconcile([source]);

    const restarted = createService();
    const snapshot = await restarted.initialize();
    const alpha = await restarted.readProjectRows("/projects/alpha");

    expect(snapshot.catalogGeneration).toBe(1);
    expect(snapshot.providerSources).toEqual([
      { catalogFamily: "codex", storeKey: "default" },
    ]);
    expect(alpha.rows.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect((await restarted.readRows()).rows).toEqual(
      (await first.readRows()).rows,
    );
    expect(source.scans).toBe(1);
    expect(restarted.getToken()).toEqual(first.getToken());
  });

  it("advances no generation and writes nothing when a scan changes nothing", async () => {
    const service = createService();
    await service.initialize();
    const rows = [
      row({ sessionId: "a", project: "a" }),
      row({ sessionId: "b", project: "a" }),
    ];
    await service.reconcile([adapter(rows)]);
    const database = openTestDiscoveryDatabase(dataDir);
    const before = storedRows(database);

    const unchanged = await service.reconcile([adapter(rows)]);

    expect(unchanged.metrics).toMatchObject({ changed: false, rowsWritten: 0 });
    expect(unchanged.snapshot.catalogGeneration).toBe(1);
    expect(storedRows(database)).toEqual(before);
    expect(service.getMetrics()).toMatchObject({
      publications: 1,
      unchangedReconciliations: 1,
    });
  });

  it("writes one row for one changed session and tombstones a removed one", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "a" }),
        row({ sessionId: "b", project: "a" }),
        row({ sessionId: "c", project: "a" }),
      ]),
    ]);

    const changed = await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "a" }),
        // Moved to another project: the same key, upserted, never deleted.
        row({ sessionId: "b", project: "z", title: "moved" }),
      ]),
    ]);

    expect(changed.metrics).toMatchObject({
      changed: true,
      rowsWritten: 1,
      rowsTombstoned: 1,
    });
    expect(storedRows(openTestDiscoveryDatabase(dataDir))).toEqual([
      { native_id: "a", changed_gen: 1, deleted: 0 },
      { native_id: "b", changed_gen: 2, deleted: 0 },
      { native_id: "c", changed_gen: 2, deleted: 1 },
    ]);
    expect(ids((await service.readProjectRows("/projects/z")).rows)).toEqual([
      "b",
    ]);
    expect(ids((await service.readProjectRows("/projects/a")).rows)).toEqual([
      "a",
    ]);
    const restarted = createService();
    await restarted.initialize();
    expect(ids((await restarted.readProjectRows("/projects/z")).rows)).toEqual([
      "b",
    ]);
  });

  it("publishes a change of store coverage alone", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    const result = await service.reconcile([
      adapter([row({ sessionId: "a", project: "a" })]),
      adapter([], { storeKey: "empty" }),
    ]);
    expect(result.metrics.changed).toBe(true);
    expect(result.snapshot.providerSources).toHaveLength(2);
  });

  it("purges tombstones once they fall behind the retained generations", async () => {
    const service = createService({ tombstoneGenerations: 10 });
    await service.initialize();
    const keep = row({ sessionId: "keep", project: "a" });
    await service.reconcile([
      adapter([keep, row({ sessionId: "gone", project: "a" })]),
    ]);
    // Generation 2 tombstones `gone`; then publish until it is 10 behind.
    for (let generation = 2; generation <= 13; generation += 1) {
      await service.reconcile([
        adapter([{ ...keep, sourceVersion: `keep@${generation}` }]),
      ]);
    }
    const database = openTestDiscoveryDatabase(dataDir);
    expect(storedRows(database).map((entry) => entry.native_id)).toEqual([
      "keep",
    ]);
    expect(
      new SessionCatalogSqliteStore(database).readState()?.tombstoneHorizon,
    ).toBe(3);
  });

  it("reads the rows changed and the keys removed since a generation", async () => {
    const service = createService();
    await service.initialize();
    const a = row({ sessionId: "a", project: "alpha" });
    await service.reconcile([
      adapter([
        a,
        row({ sessionId: "b", project: "alpha" }),
        row({ sessionId: "c", project: "beta" }),
      ]),
    ]);
    const first = service.getToken();
    expect(service.readChanges()).toMatchObject({ full: true, removed: [] });
    expect(ids(service.readChanges().rows)).toEqual(["a", "b", "c"]);
    expect(service.readChanges(first)).toMatchObject({
      ...first,
      full: false,
      rows: [],
      removed: [],
    });

    await service.reconcile([
      adapter([
        { ...a, title: "renamed" },
        row({ sessionId: "b", project: "alpha" }),
      ]),
    ]);
    const second = service.readChanges(first);
    expect(second).toMatchObject({
      catalogGeneration: first.catalogGeneration + 1,
      full: false,
      removed: [
        { catalogFamily: "codex", storeKey: "default", sessionId: "c" },
      ],
    });
    expect(second.rows.map((entry) => entry.title)).toEqual(["renamed"]);

    // Another lineage, or a generation this one never reached, reads in full.
    for (const since of [
      { ...first, catalogEpoch: "another" },
      { ...first, catalogGeneration: first.catalogGeneration + 5 },
    ])
      expect(service.readChanges(since)).toMatchObject({ full: true });

    // The log is in the tables, so a restarted server answers the same.
    service.stop();
    const restarted = createService();
    await restarted.initialize();
    expect(restarted.readChanges(first)).toMatchObject({
      full: false,
      removed: [{ sessionId: "c" }],
    });
    expect(
      restarted.readRow(JSON.stringify(["codex", "default", "a"])),
    ).toMatchObject({ title: "renamed" });
  });

  it("reads in full from memory when the change log cannot be read", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    let busy = false;
    const service = createService({
      database: {
        ...database,
        prepare(sql: string) {
          if (busy && sql.includes("changed_gen >"))
            throw new Error("database is locked");
          return database.prepare(sql);
        },
      },
    });
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "p" })])]);
    const before = service.getToken();
    await service.reconcile([adapter([row({ sessionId: "b", project: "p" })])]);
    busy = true;
    const changes = service.readChanges(before);
    expect(changes).toMatchObject({ full: true, removed: [] });
    expect(ids(changes.rows)).toEqual(["b"]);
  });

  it("reads in full from a generation whose deletions were purged", async () => {
    const service = createService({ tombstoneGenerations: 10 });
    await service.initialize();
    const keep = row({ sessionId: "keep", project: "a" });
    await service.reconcile([
      adapter([keep, row({ sessionId: "gone", project: "a" })]),
    ]);
    const before = service.getToken();
    const tokens = [before];
    for (let generation = 2; generation <= 13; generation += 1) {
      await service.reconcile([
        adapter([{ ...keep, sourceVersion: `keep@${generation}` }]),
      ]);
      tokens.push(service.getToken());
    }
    // `gone` was tombstoned at generation 2 and purged with horizon 3.
    expect(service.readChanges(before)).toMatchObject({ full: true });
    expect(service.readChanges(tokens[2])).toMatchObject({
      full: false,
      removed: [],
    });
  });

  it("reads in full across a generation stored over tables that moved", async () => {
    const service = createService();
    await service.initialize();
    const a = row({ sessionId: "a", project: "alpha" });
    await service.reconcile([adapter([a])]);
    const before = service.getToken();
    // Something outside this process rewrote the tables meanwhile.
    openTestDiscoveryDatabase(dataDir).exec(
      "UPDATE catalog_state SET generation = generation + 3",
    );
    await service.reconcile([adapter([{ ...a, title: "changed" }])]);
    expect(service.readChanges(before)).toMatchObject({ full: true });
    expect(service.readChanges(service.getToken())).toMatchObject({
      full: false,
      rows: [],
    });
  });

  it("keeps the last generation when a scan fails", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);

    await expect(
      service.reconcile([
        adapter([row({ sessionId: "b", project: "a" })], {
          failWith: new Error("provider store unavailable"),
        }),
      ]),
    ).rejects.toThrow("provider store unavailable");

    const rows = await service.readProjectRows("/projects/a");
    expect(rows.rows.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(service.getMetrics().catalogGeneration).toBe(1);
  });

  it("keeps memory and the store in step when a write fails", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    const service = createService({ database });
    await service.initialize();
    await service.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    database.exec(
      "CREATE TRIGGER refuse BEFORE INSERT ON session_catalog BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const next = [
      row({ sessionId: "a", project: "a" }),
      row({ sessionId: "b", project: "a" }),
    ];
    await expect(service.reconcile([adapter(next)])).rejects.toThrow("refused");
    expect(service.getToken().catalogGeneration).toBe(1);
    expect(ids((await service.readRows()).rows)).toEqual(["a"]);

    database.exec("DROP TRIGGER refuse");
    await service.reconcile([adapter(next)]);
    const restarted = createService();
    await restarted.initialize();
    expect(ids((await restarted.readRows()).rows)).toEqual(["a", "b"]);
    expect(restarted.getToken().catalogGeneration).toBe(2);
  });

  it("keeps one row per key when a scan yields a session twice", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({ sessionId: "a", project: "a" }),
        row({ sessionId: "a", project: "b", title: "later" }),
      ]),
    ]);
    const rows = (await service.readRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("later");
    expect(service.getMetrics().duplicateRows).toBe(1);
    const restarted = createService();
    await restarted.initialize();
    expect((await restarted.readRows()).rows).toEqual(rows);
  });

  it("upserts rows as one generation, skipping rows that moved on", async () => {
    const service = createService();
    await service.initialize();
    const a = row({ sessionId: "a", project: "a" });
    const b = row({ sessionId: "b", project: "a" });
    await service.reconcile([adapter([a, b])]);

    const token = await service.upsertRows([
      { ...a, title: "with questions" },
      // Read at an older source version: the next scan owns it.
      { ...b, sourceVersion: "b@older", title: "stale" },
      row({ sessionId: "unknown", project: "a" }),
    ]);

    expect(token.catalogGeneration).toBe(2);
    const rows = (await service.readRows()).rows;
    expect(rows.map((entry) => entry.title)).toEqual([
      "with questions",
      undefined,
    ]);
    expect(storedRows(openTestDiscoveryDatabase(dataDir))).toEqual([
      { native_id: "a", changed_gen: 2, deleted: 0 },
      { native_id: "b", changed_gen: 1, deleted: 0 },
    ]);
    // Nothing to change: no generation.
    expect((await service.upsertRows([rows[0]!])).catalogGeneration).toBe(2);
  });

  it("coalesces concurrent reconciliation of the same scope", async () => {
    const service = createService();
    await service.initialize();
    const source = adapter([row({ sessionId: "a", project: "a" })]);

    const results = await Promise.all([
      service.reconcile([source]),
      service.reconcile([source]),
      service.reconcile([source]),
    ]);

    expect(source.scans).toBe(1);
    expect(
      results.filter((result) => result.status === "computed"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "joined")).toHaveLength(
      2,
    );
    expect(service.getMetrics().reconciliationRequests).toBe(3);
  });

  it("starts a fresh epoch when stored rows cannot be reassembled", async () => {
    const first = createService({ createEpoch: () => "first" });
    await first.initialize();
    await first.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
    openTestDiscoveryDatabase(dataDir).exec(
      "UPDATE session_catalog SET async_questions = '{'",
    );

    const restarted = createService({ createEpoch: () => "second" });
    const snapshot = await restarted.initialize();

    expect(snapshot).toMatchObject({
      catalogEpoch: "second",
      catalogGeneration: 0,
      rowCount: 0,
    });
    expect(restarted.getMetrics().resetFailures).toBe(1);
    expect(storedRows(openTestDiscoveryDatabase(dataDir))).toEqual([]);
  });

  it("rejects a row that does not belong to its adapter", async () => {
    const service = createService();
    await service.initialize();
    const mismatched: NativeSessionCatalogAdapter = {
      catalogFamily: "codex",
      storeKey: "default",
      scan: async () => ({
        sourceVersion: "store-v1",
        rows: [{ ...row({ sessionId: "a", project: "a" }), storeKey: "other" }],
      }),
    };

    await expect(service.reconcile([mismatched])).rejects.toThrow(
      /yielded store other/,
    );
    expect(service.getMetrics().catalogGeneration).toBe(0);
  });

  it("returns a project's rows newest first", async () => {
    const service = createService();
    await service.initialize();
    await service.reconcile([
      adapter([
        row({
          sessionId: "old",
          project: "a",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
        row({
          sessionId: "new",
          project: "a",
          updatedAt: "2026-03-01T00:00:00Z",
        }),
        row({
          sessionId: "mid",
          project: "a",
          updatedAt: "2026-02-01T00:00:00Z",
        }),
      ]),
    ]);
    const project = await service.readProjectRows("/projects/a");
    expect(project.rows.map((entry) => entry.sessionId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(project.catalogGeneration).toBe(1);
  });

  describe("files an earlier version wrote", () => {
    const catalogDir = () => join(dataDir, "session-catalog");

    async function writeLegacy(
      generation: number,
      rows: SessionCatalogRow[],
      manifest: Record<string, unknown> = {},
    ) {
      const directory = `gen-${generation}-0a1b2c3d-0000-4000-8000-000000000000`;
      await mkdir(join(catalogDir(), "generations", directory), {
        recursive: true,
      });
      await writeFile(
        join(catalogDir(), "generations", directory, "bucket-007.jsonl"),
        rows.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
      await writeFile(
        join(catalogDir(), "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          bucketCount: 64,
          catalogEpoch: "files",
          catalogGeneration: generation,
          completedAt: "2026-11-09T00:00:00.000Z",
          generationDirectory: directory,
          rowCount: rows.length,
          rowsBytes: 0,
          shards: [{ bucket: 7, file: "bucket-007.jsonl" }],
          providerSources: [
            {
              catalogFamily: "codex",
              storeKey: "default",
              sourceVersion: "reconciliation:1",
              rowCount: rows.length,
              metrics: {},
            },
          ],
          recentRows: [],
          deltas: [],
          ...manifest,
        }),
      );
    }

    const legacyService = (
      overrides: Partial<SessionCatalogServiceOptions> = {},
    ) => createService({ legacyCatalogDir: catalogDir(), ...overrides });

    it("imports their generation with its epoch and number, then deletes them", async () => {
      const rows = [
        row({ sessionId: "a", project: "a", title: "kept" }),
        row({ sessionId: "b", project: "b" }),
      ];
      await writeLegacy(870_603, rows);

      const service = legacyService();
      const snapshot = await service.initialize();

      expect(snapshot).toMatchObject({
        catalogEpoch: "files",
        catalogGeneration: 870_603,
        rowCount: 2,
        providerSources: [{ catalogFamily: "codex", storeKey: "default" }],
      });
      expect((await service.readRows()).rows).toEqual(rows);
      expect(service.getMetrics().legacyImport).toMatchObject({
        status: "imported",
        rows: 2,
        deleted: true,
      });
      expect(await readdir(dataDir)).not.toContain("session-catalog");

      // The next publication continues the numbering and writes only changes.
      const next = await service.reconcile([
        adapter([...rows, row({ sessionId: "c", project: "a" })]),
      ]);
      expect(next.snapshot.catalogGeneration).toBe(870_604);
      expect(next.metrics.rowsWritten).toBe(1);
    });

    it("deletes them without importing when the tables already hold that generation", async () => {
      const first = createService({ createEpoch: () => "files" });
      await first.initialize();
      for (let generation = 1; generation <= 3; generation += 1)
        await first.reconcile([
          adapter([row({ sessionId: `s${generation}`, project: "a" })]),
        ]);
      await writeLegacy(2, [row({ sessionId: "older", project: "a" })]);

      const service = legacyService();
      await service.initialize();

      expect(service.getToken().catalogGeneration).toBe(3);
      expect(ids((await service.readRows()).rows)).toEqual(["s3"]);
      expect(service.getMetrics().legacyImport?.status).toBe("superseded");
      expect(await readdir(dataDir)).not.toContain("session-catalog");
    });

    it("starts a fresh lineage and deletes them when they are damaged", async () => {
      await writeLegacy(5, [row({ sessionId: "a", project: "a" })]);
      await writeFile(
        join(
          catalogDir(),
          "generations",
          "gen-5-0a1b2c3d-0000-4000-8000-000000000000",
          "bucket-007.jsonl",
        ),
        "{ torn",
      );

      const service = legacyService({ createEpoch: () => "fresh" });
      const snapshot = await service.initialize();

      expect(snapshot).toMatchObject({
        catalogEpoch: "fresh",
        catalogGeneration: 0,
      });
      expect(service.getMetrics()).toMatchObject({
        resetFailures: 1,
        legacyImport: { status: "unreadable", deleted: true },
      });
      expect(await readdir(dataDir)).not.toContain("session-catalog");
    });

    it("treats files missing rows the manifest counts as damaged", async () => {
      await writeLegacy(5, [row({ sessionId: "a", project: "a" })], {
        rowCount: 2,
      });
      const service = legacyService({ createEpoch: () => "fresh" });
      expect((await service.initialize()).catalogEpoch).toBe("fresh");
      expect(service.getMetrics().legacyImport?.status).toBe("unreadable");
    });

    it("starts a fresh lineage rather than continue tables behind damaged files", async () => {
      const first = createService({ createEpoch: () => "files" });
      await first.initialize();
      await first.reconcile([adapter([row({ sessionId: "a", project: "a" })])]);
      await writeLegacy(9, [row({ sessionId: "b", project: "a" })], {
        rowCount: 7,
      });

      const service = legacyService({ createEpoch: () => "fresh" });
      const snapshot = await service.initialize();

      expect(snapshot).toMatchObject({
        catalogEpoch: "fresh",
        catalogGeneration: 0,
        rowCount: 0,
      });
      expect(await readdir(dataDir)).not.toContain("session-catalog");
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "keeps them and fails the start on an error that does not prove damage",
      async () => {
        await writeLegacy(5, [row({ sessionId: "a", project: "a" })]);
        await chmod(join(catalogDir(), "manifest.json"), 0o000);

        const service = legacyService();
        await expect(service.initialize()).rejects.toThrow(/EACCES/);
        expect(await readdir(dataDir)).toContain("session-catalog");

        // The next caller retries the start.
        await chmod(join(catalogDir(), "manifest.json"), 0o644);
        expect((await service.initialize()).catalogGeneration).toBe(5);
        expect(await readdir(dataDir)).not.toContain("session-catalog");
      },
    );
  });
});
