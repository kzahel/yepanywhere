import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravitySessionCatalogAdapter } from "../../src/sessions/catalog-adapters/antigravity-catalog-adapter.js";
import { createCollectionCatalogAdapters } from "../../src/sessions/catalog-adapters/collection-catalog-adapters.js";
import { readAntigravityMetadata } from "../../src/sessions/antigravity-metadata.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import {
  AntigravitySummariesReader,
  antigravitySessionWatcherSpec,
  parseAntigravitySummaryTime,
  parseAntigravityWorkspaceUri,
} from "../../src/sessions/antigravity-summaries.js";
import { ChildActivityOverlay } from "../../src/sessions/child-source-activity.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD_ID = "33333333-3333-4333-8333-333333333333";
const FOURTH_ID = "44444444-4444-4444-8444-444444444444";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});

async function createSummariesFixture(options: { oldSchema?: boolean } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-agy-summaries-")),
  );
  const project = join(root, "project");
  const cliDir = join(root, "antigravity-cli");
  const conversationsDir = join(cliDir, "conversations");
  const dbPath = join(cliDir, "conversation_summaries.db");
  await mkdir(project, { recursive: true });
  await mkdir(conversationsDir, { recursive: true });

  const db = loadSqliteDriver()!.open(dbPath);
  if (options.oldSchema) {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL
      );
    `);
  } else {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        not_fully_idle NUMERIC NOT NULL DEFAULT 0,
        killed NUMERIC NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00+00:00'
      );
    `);
  }
  const projectUri = JSON.stringify([pathToFileURL(project).href]);
  const reader = new AntigravitySummariesReader(dbPath);
  cleanup.push(async () => {
    reader.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    projectUri,
    cliDir,
    conversationsDir,
    dbPath,
    db,
    reader,
  };
}

describe("AntigravitySummariesReader & top-level child exclusion", () => {
  it("parses space-separated timestamps, ignores year-0001 sentinels, and picks the last workspace URI", async () => {
    const f = await createSummariesFixture();
    const resolvedPath = join(f.root, "resolved-dir");
    const givenPath = join(f.root, "given-dir");
    expect(parseAntigravitySummaryTime("0001-01-01 00:00:00+00:00")).toBe(
      undefined,
    );
    expect(parseAntigravitySummaryTime("")).toBe(undefined);
    expect(
      parseAntigravitySummaryTime("2026-11-21 17:10:18.409203+00:00"),
    ).toBe(Date.parse("2026-11-21T17:10:18.409203+00:00"));
    expect(
      parseAntigravityWorkspaceUri(
        JSON.stringify([
          pathToFileURL(resolvedPath).href,
          pathToFileURL(givenPath).href,
        ]),
      ),
    ).toBe(givenPath);
  });

  it("sees post-open WAL commits, WAL schema upgrades, relatedIds ancestors, and atomic DB replacement", async () => {
    const f = await createSummariesFixture({ oldSchema: true });
    const insertOld = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?)",
    );
    try {
      insertOld.run(PARENT_ID, "Parent Session", f.projectUri);
    } finally {
      insertOld.finalize();
    }

    // Open and warm the reader BEFORE the WAL schema upgrade and child writes.
    expect(f.reader.readRow(PARENT_ID)?.title).toBe("Parent Session");
    expect(f.reader.readRow(PARENT_ID)?.isChild).toBe(false);
    expect(f.reader.readChildStatuses([CHILD_ID])?.size).toBe(0);
    expect(f.reader.readRelationshipSnapshot([PARENT_ID]).hasParentIds).toBe(
      false,
    );

    // Commit a WAL-only schema upgrade and insert descendants on the live writer.
    f.db.exec(`
      ALTER TABLE conversation_summaries ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversation_summaries ADD COLUMN parent_conversation_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversation_summaries ADD COLUMN nesting_depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_summaries ADD COLUMN status TEXT NOT NULL DEFAULT '';
      ALTER TABLE conversation_summaries ADD COLUMN not_fully_idle NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE conversation_summaries ADD COLUMN killed NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE conversation_summaries ADD COLUMN last_modified_time DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00+00:00';
    `);
    const insertNew = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insertNew.run(
        CHILD_ID,
        "",
        f.projectUri,
        "research",
        PARENT_ID,
        1,
        "CASCADE_RUN_STATUS_RUNNING",
        1,
        0,
        "0001-01-01 00:00:00+00:00",
      );
      insertNew.run(
        GRANDCHILD_ID,
        "Deep task",
        f.projectUri,
        "self",
        CHILD_ID,
        2,
        "CASCADE_RUN_STATUS_IDLE",
        0,
        0,
        "2026-11-21 17:05:00+00:00",
      );
    } finally {
      insertNew.finalize();
    }

    // Reused handle must observe both the WAL schema upgrade and the new rows.
    const childRow = f.reader.readRow(CHILD_ID);
    expect(childRow?.parentConversationId).toBe(PARENT_ID);
    expect(childRow?.isChild).toBe(true);
    expect(childRow?.agentName).toBe("research");
    expect(f.reader.readChildStatuses([CHILD_ID])?.get(CHILD_ID)).toEqual({
      conversationId: CHILD_ID,
      parentConversationId: PARENT_ID,
      status: "CASCADE_RUN_STATUS_RUNNING",
      notFullyIdle: true,
      killed: false,
    });

    // Ancestor traversal via relatedIds reaches PARENT_ID from GRANDCHILD_ID.
    const ancestorSnap = f.reader.readRelationshipSnapshot([], [GRANDCHILD_ID]);
    expect(ancestorSnap.hasParentIds).toBe(true);
    expect(ancestorSnap.truncated).toBe(false);
    expect(ancestorSnap.rows.map((r) => r.conversation_id).sort()).toEqual(
      [PARENT_ID, CHILD_ID, GRANDCHILD_ID].sort(),
    );

    // Repeated calls reuse prepared statements without exceeding statement ceilings.
    for (let i = 0; i < 40; i++) {
      expect(f.reader.readRow(CHILD_ID)?.parentConversationId).toBe(PARENT_ID);
      expect(f.reader.readRelationshipSnapshot([PARENT_ID]).rows).toHaveLength(
        3,
      );
    }

    // Atomic replacement of conversation_summaries.db forces handle reopen.
    const replacementPath = join(f.cliDir, "replacement.db");
    const replacementDb = loadSqliteDriver()!.open(replacementPath);
    try {
      replacementDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          workspace_uris TEXT NOT NULL,
          parent_conversation_id TEXT NOT NULL DEFAULT ''
        );
      `);
      const ins = replacementDb.prepare(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)",
      );
      ins.run(FOURTH_ID, "Replaced Title", f.projectUri, "");
      ins.finalize();
    } finally {
      replacementDb.close();
    }
    await rename(replacementPath, f.dbPath);
    await rm(`${f.dbPath}-wal`, { force: true });
    await rm(`${f.dbPath}-shm`, { force: true });
    expect(f.reader.readRow(FOURTH_ID)?.title).toBe("Replaced Title");
    expect(f.reader.readRow(CHILD_ID)).toBeUndefined();
  });

  it("bounds lineage snapshots accurately for exact-fit, deep chains, and wide trees", async () => {
    const f = await createSummariesFixture();
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(PARENT_ID, "P", f.projectUri, "", "", 0, "", 0, 0, "");
      insert.run(CHILD_ID, "C", f.projectUri, "", PARENT_ID, 1, "", 0, 0, "");
      insert.run(
        GRANDCHILD_ID,
        "G",
        f.projectUri,
        "",
        CHILD_ID,
        2,
        "",
        0,
        0,
        "",
      );
      insert.run(
        FOURTH_ID,
        "F",
        f.projectUri,
        "",
        GRANDCHILD_ID,
        3,
        "",
        0,
        0,
        "",
      );
    } finally {
      insert.finalize();
    }

    // Passing a previously known child in relatedIds must still expand new descendants.
    const withRelated = f.reader.readRelationshipSnapshot(
      [PARENT_ID],
      [CHILD_ID],
    );
    expect(withRelated.truncated).toBe(false);
    expect(withRelated.rows.map((r) => r.conversation_id).sort()).toEqual(
      [PARENT_ID, CHILD_ID, GRANDCHILD_ID, FOURTH_ID].sort(),
    );

    // Exact-fit 4-row tree must NOT report truncation (both unindexed and indexed).
    const exactFit = f.reader.readRelationshipSnapshot([PARENT_ID], [], {
      maxRows: 4,
    });
    expect(exactFit.truncated).toBe(false);
    expect(exactFit.rows).toHaveLength(4);

    // A partial index that the wave-BFS query cannot use must NOT be selected,
    // and the unindexed fallback must cap source rows examined before filtering.
    f.db.exec(
      "CREATE INDEX idx_partial_parent ON conversation_summaries(parent_conversation_id) WHERE status = 'running'",
    );
    f.db.exec("BEGIN");
    const rootInsert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      for (let i = 0; i < 60; i++) {
        rootInsert.run(
          `root-${i}`,
          `R${i}`,
          f.projectUri,
          "",
          "",
          0,
          "",
          0,
          0,
          "",
        );
      }
      rootInsert.run(
        "late-child",
        "Late",
        f.projectUri,
        "",
        PARENT_ID,
        1,
        "",
        0,
        0,
        "",
      );
      f.db.exec("COMMIT");
    } finally {
      rootInsert.finalize();
    }
    const scanCapped = f.reader.readRelationshipSnapshot([PARENT_ID], [], {
      maxRows: 10,
      maxScanRows: 10,
    });
    expect(scanCapped.truncated).toBe(true);
    expect(
      scanCapped.rows.some((r) => r.conversation_id === "late-child"),
    ).toBe(false);

    // Adding a usable full index on parent_conversation_id switches to indexed
    // wave BFS and finds the late child without scanning root rows.
    f.db.exec("DROP INDEX idx_partial_parent");
    f.db.exec(
      "CREATE INDEX idx_parent_conv ON conversation_summaries(parent_conversation_id)",
    );
    const indexedWithRelated = f.reader.readRelationshipSnapshot(
      [PARENT_ID],
      [CHILD_ID],
      { maxRows: 5, maxScanRows: 10 },
    );
    expect(indexedWithRelated.truncated).toBe(false);
    expect(
      indexedWithRelated.rows.map((r) => r.conversation_id).sort(),
    ).toEqual(
      [PARENT_ID, CHILD_ID, GRANDCHILD_ID, FOURTH_ID, "late-child"].sort(),
    );

    // An analyzed composite index can cover `SELECT conversation_id` while
    // SQLite still plans a full table scan for the wider metadata projection.
    // The reader must explain the exact BFS query and switch back to the
    // bounded fallback.
    f.db.exec("DROP INDEX idx_parent_conv");
    f.db.exec(
      "CREATE INDEX idx_parent_covering ON conversation_summaries(parent_conversation_id, conversation_id)",
    );
    f.db.exec("BEGIN");
    const skewInsert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      for (let i = 0; i < 400; i++) {
        skewInsert.run(
          `skew-${i}`,
          `S${i}`,
          f.projectUri,
          "",
          `skew-p-${i % 40}`,
          1,
          "",
          0,
          0,
          "",
        );
      }
      f.db.exec("COMMIT");
    } finally {
      skewInsert.finalize();
    }
    f.db.exec("ANALYZE");
    const idOnlyStmt = f.db.prepare(
      "EXPLAIN QUERY PLAN SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id IN (SELECT value FROM json_each(?)) AND conversation_id NOT IN (SELECT value FROM json_each(?)) LIMIT ?",
    );
    const fullColsStmt = f.db.prepare(
      "EXPLAIN QUERY PLAN SELECT conversation_id, workspace_uris, title, parent_conversation_id FROM conversation_summaries WHERE parent_conversation_id IN (SELECT value FROM json_each(?)) AND conversation_id NOT IN (SELECT value FROM json_each(?)) LIMIT ?",
    );
    try {
      const idOnlyPlan = idOnlyStmt.all<{ detail: string }>(
        '["skew-p-0"]',
        "[]",
        10,
      );
      const fullColsPlan = fullColsStmt.all<{ detail: string }>(
        '["skew-p-0"]',
        "[]",
        10,
      );
      expect(idOnlyPlan.some((r) => /COVERING INDEX/i.test(r.detail))).toBe(
        true,
      );
      expect(
        fullColsPlan.some((r) => /SCAN conversation_summaries/i.test(r.detail)),
      ).toBe(true);
    } finally {
      idOnlyStmt.finalize();
      fullColsStmt.finalize();
    }
    const analyzedFallback = f.reader.readRelationshipSnapshot(
      [PARENT_ID],
      [],
      { maxRows: 10, maxScanRows: 10 },
    );
    expect(analyzedFallback.truncated).toBe(true);
    expect(
      analyzedFallback.rows.some((r) => r.conversation_id === "late-child"),
    ).toBe(false);

    // Clean up extra rows and statistics before subsequent assertions below.
    f.db.exec("DROP INDEX idx_parent_covering");
    f.db.exec("DELETE FROM sqlite_stat1");
    f.db.exec(
      "DELETE FROM conversation_summaries WHERE conversation_id LIKE 'root-%' OR conversation_id LIKE 'skew-%' OR conversation_id = 'late-child'",
    );
    f.db.exec(
      "CREATE INDEX idx_parent_conv ON conversation_summaries(parent_conversation_id)",
    );

    // A failed COMMIT propagates and rolls back/recovers so the next read still succeeds.
    const internalDb = (
      f.reader as unknown as { db?: { exec(sql: string): void } }
    ).db;
    expect(internalDb).toBeDefined();
    const originalExec = internalDb!.exec.bind(internalDb);
    const execSpy = vi
      .spyOn(internalDb!, "exec")
      .mockImplementation((sql: string) => {
        if (sql === "COMMIT") throw new Error("simulated commit failure");
        return originalExec(sql);
      });
    try {
      expect(() => f.reader.readRelationshipSnapshot([PARENT_ID])).toThrow(
        "simulated commit failure",
      );
    } finally {
      execSpy.mockRestore();
    }
    expect(f.reader.readRelationshipSnapshot([PARENT_ID]).rows).toHaveLength(4);

    const rowLimited = f.reader.readRelationshipSnapshot([PARENT_ID], [], {
      maxRows: 2,
    });
    expect(rowLimited.truncated).toBe(true);
    expect(rowLimited.rows).toHaveLength(2);

    const depthLimited = f.reader.readRelationshipSnapshot([PARENT_ID], [], {
      maxDepth: 1,
    });
    expect(depthLimited.truncated).toBe(true);

    const seedLimited = f.reader.readRelationshipSnapshot(
      [PARENT_ID, CHILD_ID],
      [],
      { maxSeeds: 1 },
    );
    expect(seedLimited.truncated).toBe(true);

    // Complete 17-edge chain must NOT report truncation under default maxDepth=32.
    f.db.exec("BEGIN");
    const chainInsert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      let prev = "chain-00";
      chainInsert.run(prev, prev, f.projectUri, "", "", 0, "", 0, 0, "");
      for (let i = 1; i <= 17; i++) {
        const id = `chain-${String(i).padStart(2, "0")}`;
        chainInsert.run(id, id, f.projectUri, "", prev, i, "", 0, 0, "");
        prev = id;
      }
      // Wide 1-level tree exceeding maxRows stops scanning early and reports truncation.
      chainInsert.run("wide-root", "W", f.projectUri, "", "", 0, "", 0, 0, "");
      for (let i = 0; i < 200; i++) {
        chainInsert.run(
          `wide-child-${i}`,
          `C${i}`,
          f.projectUri,
          "",
          "wide-root",
          1,
          "",
          0,
          0,
          "",
        );
      }
      f.db.exec("COMMIT");
    } finally {
      chainInsert.finalize();
    }
    const chainSnap = f.reader.readRelationshipSnapshot(["chain-00"]);
    expect(chainSnap.truncated).toBe(false);
    expect(chainSnap.rows).toHaveLength(18);

    const wideSnap = f.reader.readRelationshipSnapshot(["wide-root"], [], {
      maxRows: 4,
    });
    expect(wideSnap.truncated).toBe(true);
    expect(wideSnap.rows).toHaveLength(4);

    const missing = new AntigravitySummariesReader(
      join(f.root, "missing", "conversation_summaries.db"),
    );
    expect(() => missing.readRelationshipSnapshot([PARENT_ID])).toThrow();
    expect(missing.readRow(PARENT_ID)).toBeUndefined();
    missing.close();
  });

  it("falls back to a strict point read on an incomplete bulk-cache miss", async () => {
    const f = await createSummariesFixture();
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent");
    await writeFile(join(f.conversationsDir, `${CHILD_ID}.db`), "child");
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(PARENT_ID, "Parent", f.projectUri, "", "", 0, "", 0, 0, "");
      insert.run(
        CHILD_ID,
        "",
        f.projectUri,
        "research",
        PARENT_ID,
        1,
        "",
        0,
        0,
        "",
      );
    } finally {
      insert.finalize();
    }
    const meta = await readAntigravityMetadata(f.conversationsDir, CHILD_ID, {
      summaryBulkLimit: 1,
    });
    expect(meta?.isChild).toBe(true);
    expect(meta?.parentConversationId).toBe(PARENT_ID);

    // A point-read failure on a capped cache miss must propagate, never default to root.
    const pointSpy = vi
      .spyOn(AntigravitySummariesReader.prototype, "readRowStrict")
      .mockImplementationOnce(() => {
        throw new Error("simulated sqlite point-read failure");
      });
    try {
      await expect(
        readAntigravityMetadata(f.conversationsDir, CHILD_ID, {
          summaryBulkLimit: 1,
        }),
      ).rejects.toThrow("simulated sqlite point-read failure");
    } finally {
      pointSpy.mockRestore();
    }
  });

  it("summarizes from the summaries index without starting agy, excluding a child once linked", async () => {
    if (process.platform === "win32") return;
    const f = await createSummariesFixture();
    await writeFile(join(f.conversationsDir, `${CHILD_ID}.db`), "child");
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(
        CHILD_ID,
        "Initially Root",
        f.projectUri,
        "",
        "",
        0,
        "",
        0,
        0,
        "",
      );
    } finally {
      insert.finalize();
    }
    const started = join(f.root, "agy-started");
    const peerBin = join(f.root, "agy");
    await writeFile(
      peerBin,
      `#!/bin/sh\necho started >> '${started}'\nexit 1\n`,
    );
    await chmod(peerBin, 0o755);
    vi.stubEnv("GEMINI_HOME", f.root);
    vi.stubEnv("CLOUD_CODE_URL", "http://127.0.0.1:1");
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", peerBin);
    const reader = new AntigravitySessionReader({
      projectPath: f.project,
      sessionsDir: f.conversationsDir,
    });
    try {
      const projectId = toUrlProjectId(f.project);
      expect((await reader.getSessionSummary(CHILD_ID, projectId))?.title).toBe(
        "Initially Root",
      );
      const link = f.db.prepare(
        "UPDATE conversation_summaries SET parent_conversation_id = ?, nesting_depth = 1 WHERE conversation_id = ?",
      );
      try {
        link.run(PARENT_ID, CHILD_ID);
      } finally {
        link.finalize();
      }
      expect(await reader.getSessionSummary(CHILD_ID, projectId)).toBeNull();
      await expect(readFile(started, "utf8")).rejects.toThrow();
    } finally {
      await reader.close();
    }
  });

  it("enforces physical store boundaries against symlinked conversations dirs and summaries DBs", async () => {
    const f = await createSummariesFixture();
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent");
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(
        PARENT_ID,
        "Store A Title",
        f.projectUri,
        "",
        "",
        0,
        "CASCADE_RUN_STATUS_IDLE",
        0,
        0,
        "2026-11-21 17:00:00+00:00",
      );
    } finally {
      insert.finalize();
    }

    const storeB = join(f.root, "store-b");
    await mkdir(storeB, { recursive: true });
    const storeBConvs = join(storeB, "conversations");
    await symlink(f.conversationsDir, storeBConvs);
    const foreignDbPath = join(storeB, "conversation_summaries.db");
    const foreignDb = loadSqliteDriver()!.open(foreignDbPath);
    try {
      foreignDb.exec(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT);",
      );
      const ins = foreignDb.prepare(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)",
      );
      ins.run(PARENT_ID, "Poisoned Foreign Title", f.projectUri, CHILD_ID);
      ins.finalize();
    } finally {
      foreignDb.close();
    }
    const viaAlias = await readAntigravityMetadata(storeBConvs, PARENT_ID);
    expect(viaAlias?.title).toBe("Store A Title");
    expect(viaAlias?.isChild).toBe(false);

    const storeC = join(f.root, "store-c");
    const storeCConvs = join(storeC, "conversations");
    await mkdir(storeCConvs, { recursive: true });
    await writeFile(join(storeCConvs, `${PARENT_ID}.db`), "parent");
    await symlink(foreignDbPath, join(storeC, "conversation_summaries.db"));
    await expect(
      readAntigravityMetadata(storeCConvs, PARENT_ID),
    ).rejects.toThrow("escapes");
  });

  it("treats overlong parent IDs as children and skips ACP on child reads", async () => {
    const f = await createSummariesFixture();
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent");
    await writeFile(join(f.conversationsDir, `${CHILD_ID}.db`), "child");
    await writeFile(
      join(f.conversationsDir, `${GRANDCHILD_ID}.db`),
      "overlong",
    );
    const overlongParent = "x".repeat(1_200);
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(PARENT_ID, "Parent", f.projectUri, "", "", 0, "", 0, 0, "");
      insert.run(
        CHILD_ID,
        "",
        f.projectUri,
        "research",
        PARENT_ID,
        1,
        "CASCADE_RUN_STATUS_RUNNING",
        1,
        0,
        "0001-01-01 00:00:00+00:00",
      );
      insert.run(
        GRANDCHILD_ID,
        "",
        f.projectUri,
        "research",
        overlongParent,
        1,
        "",
        0,
        0,
        "",
      );
    } finally {
      insert.finalize();
    }

    const childMeta = await readAntigravityMetadata(
      f.conversationsDir,
      CHILD_ID,
    );
    expect(childMeta?.isChild).toBe(true);
    expect(childMeta?.parentConversationId).toBe(PARENT_ID);
    const overlongMeta = await readAntigravityMetadata(
      f.conversationsDir,
      GRANDCHILD_ID,
    );
    expect(overlongMeta?.isChild).toBe(true);
    expect(overlongMeta?.parentConversationId).toBeUndefined();

    const scan = await new AntigravitySessionCatalogAdapter({
      sessionsDir: f.conversationsDir,
    }).scan({
      catalogEpoch: "test",
      targetGeneration: 1,
      mode: { kind: "complete" },
      signal: new AbortController().signal,
    });
    expect(scan.rows.map((r) => r.sessionId)).toEqual([PARENT_ID]);

    if (process.platform !== "win32") {
      const spyLog = join(f.root, "acp-spy.log");
      const spyBin = join(f.root, "acp-spy.cjs");
      await writeFile(
        spyBin,
        `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(spyLog)}, 'spawned\\n');\nprocess.exit(1);\n`,
      );
      await chmod(spyBin, 0o755);
      vi.stubEnv("ANTIGRAVITY_ACP_PATH", spyBin);
      const reader = new AntigravitySessionReader({
        projectPath: f.project,
        sessionsDir: f.conversationsDir,
      });
      try {
        const projectId = toUrlProjectId(f.project);
        expect(await reader.getSessionSummary(CHILD_ID, projectId)).toBeNull();
        expect(await reader.getSession(CHILD_ID, projectId)).toBeNull();
        expect(await readFile(spyLog, "utf8").catch(() => "")).toBe("");
      } finally {
        await reader.close();
      }
    }
  });

  it("invalidates RetainedSessionCollections before watcher startup, after baseline, via symlink, and without false rescan deletes", async () => {
    const f = await createSummariesFixture();
    await writeFile(join(f.conversationsDir, `${PARENT_ID}.db`), "parent");
    await writeFile(join(f.conversationsDir, `${CHILD_ID}.db`), "child");
    await writeFile(join(f.conversationsDir, `${GRANDCHILD_ID}.db`), "child2");
    const insert = f.db.prepare(
      "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    try {
      insert.run(PARENT_ID, "Parent", f.projectUri, "", "", 0, "", 0, 0, "");
      insert.run(CHILD_ID, "Unlinked 1", f.projectUri, "", "", 0, "", 0, 0, "");
      insert.run(
        GRANDCHILD_ID,
        "Unlinked 2",
        f.projectUri,
        "",
        "",
        0,
        "",
        0,
        0,
        "",
      );
    } finally {
      insert.finalize();
    }

    const aliasStore = join(f.root, "alias-store");
    await mkdir(aliasStore, { recursive: true });
    const aliasConvs = join(aliasStore, "conversations");
    await symlink(f.conversationsDir, aliasConvs);

    const eventBus = new EventBus();
    const profileDir = join(f.root, "profile");
    const profile = new DiscoverySqliteService({
      dataDir: profileDir,
      probeNetworkFilesystem: () => undefined,
    });
    const antigravityAdapter = new AntigravitySessionCatalogAdapter({
      sessionsDir: aliasConvs,
    });
    const adapters = createCollectionCatalogAdapters({
      scanner: {
        listFileCatalogProjects: async () => [],
      } as never,
      readerFactory: () => {
        throw new Error("unexpected file reader");
      },
      getCatalogFamilies: () => ["antigravity"],
      antigravitySessionsDir: aliasConvs,
    });
    const retained = new RetainedSessionCollections({
      dataDir: profileDir,
      database: profile.getDatabase(),
      eventBus,
      projectStores: () => [antigravityAdapter],
      adapters,
      debounceMs: 10,
    });
    const watcherSpec = antigravitySessionWatcherSpec(aliasConvs);
    expect(watcherSpec.recursive).toBe(false);
    expect(watcherSpec.watchDir).toBe(f.conversationsDir);
    expect(watcherSpec.companionWatchDir).toEqual({
      dir: f.cliDir,
      files: ["conversation_summaries.db", "conversation_summaries.db-wal"],
    });
    expect(antigravityAdapter.ownsPath(`${f.dbPath}-wal`)).toBe(true);

    let baselineReady!: () => void;
    const baseline = new Promise<void>((resolve) => {
      baselineReady = resolve;
    });
    const watcher = new FileWatcher({
      ...watcherSpec,
      debounceMs: 20,
      eventBus,
      onInitialBaseline: () => {
        retained.observationReady("antigravity");
        baselineReady();
      },
    });
    cleanup.push(async () => {
      watcher.stop();
      await retained.dispose();
      profile.close();
    });

    await retained.refresh();
    expect((await retained.read()).rows.map((r) => r.sessionId).sort()).toEqual(
      [PARENT_ID, CHILD_ID, GRANDCHILD_ID].sort(),
    );

    // 1) WAL lineage commit BEFORE watcher startup converges on baseline handover.
    const update = f.db.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ?, nesting_depth = 1 WHERE conversation_id = ?",
    );
    try {
      update.run(PARENT_ID, CHILD_ID);
    } finally {
      update.finalize();
    }

    watcher.start();
    await baseline;
    await vi.waitFor(
      async () => {
        const rows = (await retained.read()).rows;
        expect(rows.map((r) => r.sessionId).sort()).toEqual(
          [PARENT_ID, GRANDCHILD_ID].sort(),
        );
      },
      { timeout: 3000, interval: 25 },
    );

    // 2) WAL lineage commit AFTER baseline observed via companion watch.
    const update2 = f.db.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ?, nesting_depth = 1 WHERE conversation_id = ?",
    );
    try {
      update2.run(PARENT_ID, GRANDCHILD_ID);
    } finally {
      update2.finalize();
    }
    await vi.waitFor(
      async () => {
        const rows = (await retained.read()).rows;
        expect(rows.map((r) => r.sessionId)).toEqual([PARENT_ID]);
      },
      { timeout: 3000, interval: 25 },
    );

    // 3) Fallback rescan must preserve unchanged companion files (no false delete).
    const deleteEvents: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "file-change" && event.changeType === "delete") {
        deleteEvents.push(event.path);
      }
    });
    try {
      await (
        watcher as unknown as { runRescan(reason: "fallback"): Promise<void> }
      ).runRescan("fallback");
      expect(deleteEvents).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not publish baseline readiness if stopped while companion file stat is in flight", async () => {
    const f = await createSummariesFixture();
    const eventBus = new EventBus();
    const onBaseline = vi.fn();
    const watcher = new FileWatcher({
      ...antigravitySessionWatcherSpec(f.conversationsDir),
      debounceMs: 20,
      eventBus,
      onInitialBaseline: onBaseline,
    });
    cleanup.push(async () => {
      watcher.stop();
    });
    let releaseStat!: () => void;
    let statEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      statEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = vi
      .spyOn(fs.promises, "stat")
      .mockImplementation(async (...args) => {
        if (String(args[0]).endsWith("conversation_summaries.db")) {
          statEntered();
          await gate;
        }
        return realStat(...args);
      });
    try {
      watcher.start();
      await entered;
      watcher.stop();
      releaseStat();
      await watcher.waitForInitialBaseline();
      expect(onBaseline).not.toHaveBeenCalled();
      expect(watcher.getInitialBaselineState()).toBe("stopped");
    } finally {
      releaseStat();
      statSpy.mockRestore();
    }
  });

  it("overlays child activity monotonically with insertion-order eviction", () => {
    const overlay = new ChildActivityOverlay(2);
    overlay.remember("a", "2026-11-21T17:00:00.000Z");
    overlay.remember("b", "2026-11-21T17:01:00.000Z");
    overlay.remember("a", "2026-11-21T17:02:00.000Z");
    overlay.remember("a", "2026-11-21T16:00:00.000Z");
    expect(overlay.get("a")).toBe("2026-11-21T17:02:00.000Z");
    overlay.remember("c", "2026-11-21T17:03:00.000Z");
    expect(overlay.get("a")).toBeUndefined();
    expect(overlay.get("b")).toBe("2026-11-21T17:01:00.000Z");

    const base = [
      {
        id: "b",
        parentSessionId: "p",
        updatedAt: "2026-11-21T17:00:00.000Z",
      },
      {
        id: "c",
        parentSessionId: "p",
        updatedAt: "2026-11-21T17:03:00.000Z",
      },
    ];
    const updated = overlay.overlay(base);
    expect(updated).not.toBe(base);
    expect(updated.map((c) => c.id)).toEqual(["c", "b"]);
    expect(updated.find((c) => c.id === "b")?.updatedAt).toBe(
      "2026-11-21T17:01:00.000Z",
    );
    expect(overlay.overlay(updated)).toBe(updated);
  });
});
