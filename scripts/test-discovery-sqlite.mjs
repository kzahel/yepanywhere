// Runs the same contract against Node and the pinned desktop Bun. Accept the
// npm staging storage directory to also verify the actual published modules.
// Node 22/24 may emit its built-in SQLite ExperimentalWarning here. This is
// intentional runtime provenance for the approved built-in driver, not a test
// failure or a warning to intercept; Bun does not emit that Node notice.
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [expected, storageDir = "packages/server/dist/storage", sharedFile] =
  process.argv.slice(2);
// SQLite is required: every supported runtime must provide it.
assert.equal(expected, "ready", "Pass ready");
const {
  DISCOVERY_MIGRATIONS,
  DiscoverySqliteService,
  migrateDiscoveryDatabase,
} = await import(
  pathToFileURL(resolve(storageDir, "discovery-sqlite.js")).href
);
const { loadSqliteDriver } = await import(
  pathToFileURL(resolve(storageDir, "sqlite.js")).href
);
const { SessionRelationshipStore } = await import(
  pathToFileURL(resolve(storageDir, "../sessions/SessionRelationshipStore.js"))
    .href
);
const { SessionMetadataService } = await import(
  pathToFileURL(resolve(storageDir, "../metadata/SessionMetadataService.js"))
    .href
);
const { SessionCatalogSqliteStore } = await import(
  pathToFileURL(resolve(storageDir, "../services/session-catalog-sqlite.js"))
    .href
);
const { SqliteSessionSummaryIndex } = await import(
  pathToFileURL(resolve(storageDir, "../indexes/SqliteSessionSummaryIndex.js"))
    .href
);
const { ApiReceiptStore } = await import(
  pathToFileURL(resolve(storageDir, "../core-api/receipt-store.js")).href
);
const { reconcileSessionRelationships } = await import(
  pathToFileURL(
    resolve(storageDir, "../sessions/session-relationship-reconciliation.js"),
  ).href
);

// This must execute on both engines: Bun includes trigger writes in changes,
// while Node reports only the direct row. A migration-only probe misses that.
function relationshipContract(database) {
  const store = new SessionRelationshipStore(database);
  const parent = {
    kind: "session",
    serverId: "owned-runtime",
    sessionId: "parent",
  };
  const observation = (version) => ({
    producer: "runtime-contract",
    sourceKey: "parent",
    sourceVersion: version,
    extractorVersion: 1,
    observedAt: "2026-11-04T00:00:00.000Z",
  });
  const fact = (id) => ({
    type: "provider_child",
    source: parent,
    target: { ...parent, sessionId: id },
    recordKey: id,
    trust: "provider-observed",
  });
  const publish = (version, expectedRevision, state, facts) =>
    store.publish({
      observation: observation(version),
      expectedRevision,
      facts,
      progress: { state, cursor: "{}" },
      replaceSource: true,
    });
  const children = () =>
    store
      .list({ resource: parent })
      .edges.map((edge) => edge.target.sessionId)
      .sort();
  try {
    store.record(observation("v1"), [fact("one")]);
    store.record(observation("v1"), [fact("one")]);
    assert.deepEqual(children(), ["one"]);
    assert.throws(
      () =>
        store.record(observation("v1"), [
          { ...fact("one"), trust: "local-authenticated" },
        ]),
      /trust/,
    );
    assert.equal(
      publish("v1", null, "complete", [
        fact("one"),
        fact("two"),
        fact("three"),
      ]),
      true,
    );
    assert.equal(publish("v2", 1, "partial", [fact("one")]), true);
    assert.deepEqual(children(), ["one", "three", "two"]);
    assert.equal(publish("v2", 2, "complete", [fact("two")]), true);
    assert.deepEqual(children(), ["one", "two"]);
    store.record(observation("v1"), [fact("three")]);
    assert.deepEqual(children(), ["one", "two"]);
    assert.equal(publish("stale", 2, "complete", []), false);
    assert.equal(publish("v3", 3, "complete", [fact("three")]), true);
    assert.deepEqual(children(), ["three"]);
    assert.equal(store.checkpoint("runtime-contract", "parent").revision, 4);
  } finally {
    store.dispose();
  }
}
const temporary = mkdtempSync(join(tmpdir(), "ya-sqlite-contract-"));
const connections = [];
function openService(dataDir, extra = {}) {
  const service = new DiscoverySqliteService({ dataDir, ...extra });
  connections.push(service);
  return service;
}
async function relationshipWriterContract(dataDir) {
  const service = openService(dataDir),
    database = service.getDatabase();
  const metadata = new SessionMetadataService({ dataDir, database });
  await metadata.initialize();
  const receipts = new ApiReceiptStore(database);
  assert.equal(receipts.relationshipWriter, metadata.relationships);
  const serverId = metadata.relationships.serverId;
  const { receipt } = receipts.reserve({
    requestId: "runtime-create-0001",
    kind: "createSession",
    projectId: "fixture",
    sessionId: null,
    creator: {
      serverId,
      sessionId: "initiator",
      launchId: "launch",
      principal: { kind: "superuser" },
    },
    destinationServerId: serverId,
    payload: { message: "private prompt" },
  });
  const projectPath = join(dataDir, "project");
  const input = {
    requestId: receipt.id,
    context: {
      owner: { kind: "superuser" },
      source: { kind: "request", provenance: { surface: "api" } },
    },
    request: {
      provider: "claude",
      projectId: Buffer.from(projectPath).toString("base64url"),
      projectPath,
      message: "private prompt",
      settings: {
        permissionMode: "default",
        requestedModel: null,
        serviceTier: null,
        thinking: null,
        effort: null,
      },
      lineage: { continuedFrom: "previous" },
      input: { schemaVersion: 1, nativeReceiptId: receipt.id },
    },
  };
  database.exec(
    "CREATE TRIGGER fail_relationship BEFORE INSERT ON session_relationship_evidence BEGIN SELECT RAISE(ABORT, 'atomic projection failure'); END;",
  );
  assert.throws(
    () => metadata.creations.admit(input),
    /atomic projection failure/,
  );
  assert.deepEqual(metadata.getAllMetadata(), {});
  assert.equal(
    metadata.creations.get({ kind: "superuser" }, receipt.id),
    undefined,
  );
  database.exec("DROP TRIGGER fail_relationship");
  const saved = metadata.creations.admit(input);
  const read = () =>
    metadata.relationships.index.list({
      resource: metadata.relationships.session(saved.sessionId),
    }).edges;
  assert.deepEqual(
    read()
      .map((edge) => edge.type)
      .sort(),
    ["continued_from", "created_session"],
  );
  assert.equal(receipts.get(receipt.id).sessionId, null);
  const legacy = database.prepare(
    "INSERT INTO session_metadata(session_id, metadata) VALUES (?, ?)",
  );
  try {
    database.transaction(() => {
      for (const id of [
        ...Array.from(
          { length: 98 },
          (_, i) => `ascii-${String(i).padStart(3, "0")}`,
        ),
        "\uE000",
        "\u{10000}",
      ])
        legacy.run(id, '{"forkedFromSessionId":"origin"}');
    });
  } finally {
    legacy.finalize();
  }
  // Rebuild from the existing owners and their exact correlation, without
  // changing the receipt's unresolved outcome or dispatching any provider.
  database.exec(
    "DELETE FROM session_relationship_evidence; DELETE FROM session_relationship_edges; DELETE FROM session_relationship_checkpoints;",
  );
  await reconcileSessionRelationships(
    database,
    metadata.relationships,
    new AbortController().signal,
  );
  assert.equal(read().length, 2);
  assert.equal(
    metadata.relationships.index.list({
      resource: metadata.relationships.session("\u{10000}"),
    }).edges.length,
    1,
  );
  receipts.update(receipt.id, {
    sessionId: saved.sessionId,
    state: "accepted",
  });
  assert.equal(metadata.creations.admit(input).sessionId, saved.sessionId);
  receipts.close();
  service.close();
  const reopened = openService(dataDir);
  const next = new SessionMetadataService({
    dataDir,
    database: reopened.getDatabase(),
  });
  await next.initialize();
  assert.equal(next.relationships.serverId, serverId);
  assert.equal(
    next.relationships.index.list({
      resource: next.relationships.session(saved.sessionId),
    }).edges.length,
    2,
  );
  reopened.close();
}
// The catalog publication's UPSERTs, INSERT ... SELECT ... ON CONFLICT and
// cascading text rows, on whichever SQLite each runtime links.
function catalogContract(database) {
  const store = new SessionCatalogSqliteStore(database);
  const row = (sessionId, title) => ({
    catalogFamily: "codex",
    storeKey: "/store",
    sessionId,
    projectId: "id",
    projectPath: "/p",
    projectIdentityKey: "/p",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ...(title === undefined ? {} : { title }),
    fidelity: "head",
    sourceVersion: sessionId,
    location: { kind: "file", path: `/store/${sessionId}` },
  });
  const long = "t".repeat(600);
  const state = (generation) => ({
    epoch: "e",
    generation,
    completedAt: "2026-11-09T00:00:00.000Z",
  });
  store.writeGeneration(state(1), [row("a", long), row("b", null)], []);
  assert.deepEqual(store.readRows(), [row("a", long), row("b", null)]);
  const next = store.writeGeneration(state(2), [row("a", "short")], []);
  assert.deepEqual(next, {
    rowsWritten: 1,
    rowsTombstoned: 1,
    tombstonesPurged: 0,
    lineageReplaced: false,
  });
  assert.deepEqual(store.readRows(), [row("a", "short")]);
  // A publication's changes: resurrect a tombstone, tombstone by key.
  const changed = store.applyChanges(
    state(3),
    2,
    [
      { type: "upsert", row: row("b", long) },
      { type: "delete", key: row("a") },
    ],
    [],
  );
  assert.deepEqual(changed, {
    rowsWritten: 1,
    rowsTombstoned: 1,
    tombstonesPurged: 0,
    lineageReplaced: false,
  });
  assert.deepEqual(store.readRows(), [row("b", long)]);
  // Change readers follow changed_gen: what generation 3 wrote or removed.
  assert.deepEqual(
    store
      .readChangedKeys(2)
      .sort((x, y) => x.key.sessionId.localeCompare(y.key.sessionId)),
    [
      {
        key: { catalogFamily: "codex", storeKey: "/store", sessionId: "a" },
        deleted: true,
      },
      {
        key: { catalogFamily: "codex", storeKey: "/store", sessionId: "b" },
        deleted: false,
      },
    ],
  );
  assert.deepEqual(store.readChangedKeys(3), []);
  // A moved row is an upsert and a delete of one key; the upsert wins.
  store.applyChanges(
    state(4),
    3,
    [
      { type: "upsert", row: row("b", "moved") },
      { type: "delete", key: row("b") },
    ],
    [],
  );
  assert.deepEqual(store.readRows(), [row("b", "moved")]);
  // A tombstone loses its text at once and its row at the horizon.
  store.applyChanges(
    state(5),
    4,
    [{ type: "upsert", row: row("c", long) }],
    [],
  );
  store.applyChanges(state(6), 5, [{ type: "delete", key: row("c") }], []);
  assert.equal(
    database.prepare("SELECT count(*) AS n FROM session_catalog_text").get().n,
    0,
  );
  const purged = store.applyChanges(state(7), 6, [], [], 6);
  assert.equal(purged.tombstonesPurged, 2);
  assert.equal(store.readState().tombstoneHorizon, 6);
  assert.deepEqual(
    store.readRowsWithHashes().map(({ row }) => row),
    [row("b", "moved")],
  );
  assert.throws(() => store.applyChanges(state(8), 3.5, [], []), /follow/);
  store.writeGeneration({ ...state(0), epoch: "f" }, [], []);
  assert.equal(
    database.prepare("SELECT count(*) AS n FROM session_catalog_text").get().n,
    0,
  );
}
/** Migration 029 derives each issue job's catalog key with JSON functions. */
function issueJobMigrationContract() {
  const database = loadSqliteDriver().open(":memory:");
  try {
    migrateDiscoveryDatabase(database, DISCOVERY_MIGRATIONS.slice(0, 28));
    const insert = database.prepare(
      "INSERT INTO issue_index_jobs(session_id,project_id,source_version,state,updated_at,source_json,priority) VALUES (?,'p','v','indexed',1,?,0)",
    );
    insert.run(
      "a",
      JSON.stringify({
        catalogFamily: "codex",
        storeKey: "/s",
        nativeSessionId: "n",
      }),
    );
    insert.run("b", JSON.stringify({ catalogFamily: "codex", storeKey: "/s" }));
    // JSON functions must spell the key as JSON.stringify does.
    const odd = '/s"t\\o\u2028r\u0001e😀';
    insert.run("c", JSON.stringify({ catalogFamily: "codex", storeKey: odd }));
    insert.run("v", "null");
    insert.finalize();
    migrateDiscoveryDatabase(database);
    assert.deepEqual(
      database
        .prepare(
          "SELECT session_id, catalog_key FROM issue_index_jobs ORDER BY session_id",
        )
        .all()
        .map((job) => ({ ...job })),
      [
        { session_id: "a", catalog_key: '["codex","/s","n"]' },
        { session_id: "b", catalog_key: '["codex","/s","b"]' },
        { session_id: "c", catalog_key: JSON.stringify(["codex", odd, "c"]) },
        { session_id: "v", catalog_key: null },
      ],
    );
  } finally {
    database.close();
  }
}
/**
 * Migration 030 moves `fullTitle` out with JSON functions; the rest of each
 * summary must read back as written, numbers and escapes included, or every
 * scope would be rewritten on its next save.
 */
function summaryTitleMigrationContract() {
  const database = loadSqliteDriver().open(":memory:");
  try {
    migrateDiscoveryDatabase(database, DISCOVERY_MIGRATIONS.slice(0, 29));
    database.exec("INSERT INTO session_summary_scopes VALUES ('s', 'p', 5)");
    const odd = 'a"b\\c\u2028d\u0001e😀\ud800f';
    const written = {
      plain: {
        title: "t",
        fullTitle: "t long",
        createdAt: "2026-01-01T00:00:00.000Z",
        messageCount: 3,
        contextUsage: { inputTokens: 12345, percentage: 0.6170000000000001 },
        indexedBytes: 9007199254740991,
        fileMtime: 1731111111111.1235,
        provider: "codex",
      },
      odd: {
        title: odd,
        fullTitle: odd.repeat(500),
        lastAgentText: odd,
        n: -0.5e-7,
      },
      // Escapes JSON functions must keep as written, in a summary that
      // json_remove does rewrite (no lone surrogate or NUL).
      escaped: {
        title: "q",
        fullTitle: 'a"b\\c\u2028d\u0001e😀/\t'.repeat(500),
        lastAgentText: 'x"y\\z\u0001',
        sizes: [1.5, 1e21, 12345678901234567000, 0.1, -5e-7],
      },
      nul: { title: "n", fullTitle: "before\u0000after" },
      untitled: { title: null, fullTitle: null, isEmpty: true },
    };
    const insert = database.prepare(
      "INSERT INTO session_summary_index (scope, session_id, summary) VALUES ('s', ?, ?)",
    );
    for (const [id, summary] of Object.entries(written))
      insert.run(id, JSON.stringify(summary));
    insert.finalize();
    migrateDiscoveryDatabase(database);
    assert.deepEqual(
      database
        .prepare(
          "SELECT session_id, full_title IS NOT NULL AS split FROM session_summary_index ORDER BY session_id",
        )
        .all()
        .map((row) => [row.session_id, Number(row.split)]),
      [
        ["escaped", 1],
        ["nul", 0],
        ["odd", 0],
        ["plain", 1],
        ["untitled", 0],
      ],
    );
    const store = new SqliteSessionSummaryIndex(database);
    try {
      const sessions = store.read("s").sessions;
      for (const [id, summary] of Object.entries(written)) {
        assert.deepEqual(sessions[id], summary);
        assert.equal(JSON.stringify(sessions[id]), JSON.stringify(summary));
      }
    } finally {
      store.dispose();
    }
  } finally {
    database.close();
  }
}
try {
  issueJobMigrationContract();
  summaryTitleMigrationContract();
  const catalog = openService(join(temporary, "catalog"));
  catalogContract(catalog.getDatabase());
  // A transaction larger than the page cache must fail fast, not stall, while
  // an outside reader holds its shared lock (cache_spill is off).
  const reader = loadSqliteDriver().open(
    join(temporary, "catalog", "discovery.sqlite"),
  );
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM session_catalog").get();
  const started = Date.now();
  assert.throws(
    () =>
      new SessionCatalogSqliteStore(catalog.getDatabase()).writeGeneration(
        { epoch: "g", generation: 1, completedAt: "2026-11-09T00:00:00.000Z" },
        Array.from({ length: 5000 }, (_, index) => ({
          catalogFamily: "codex",
          storeKey: "/store",
          sessionId: `big-${index}`,
          projectId: "id",
          projectPath: "/p",
          projectIdentityKey: "/p",
          updatedAt: "2026-11-09T00:00:00.000Z",
          title: "w".repeat(1000),
          fidelity: "head",
          sourceVersion: "v",
          location: { kind: "file", path: `/store/big-${index}` },
        })),
        [],
      ),
    /locked|busy/i,
  );
  assert.ok(Date.now() - started < 5000, "a blocked write must fail fast");
  reader.exec("ROLLBACK");
  reader.close();
  catalog.close();
  const relationships = openService(join(temporary, "relationships"));
  relationshipContract(relationships.getDatabase());
  relationships.close();
  await relationshipWriterContract(join(temporary, "relationship-writers"));

  const unsupportedDir = join(temporary, "unsupported");
  assert.throws(
    () => openService(unsupportedDir, { loadDriver: () => undefined }),
    /no built-in SQLite/,
  );
  assert.equal(existsSync(unsupportedDir), false);

  const dataDir = join(temporary, "enabled");
  const service = openService(dataDir);
  assert.deepEqual(service.getStatus(), { state: expected });
  // Status snapshots cannot mutate retained readiness.
  service.getStatus().state = "error";
  assert.equal(service.getStatus().state, expected);
  {
    const db = service.getDatabase();
    assert.ok(db);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 250);
    db.exec(
      "CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT, payload BLOB)",
    );
    const insert = db.prepare("INSERT INTO entries VALUES (?, ?, ?)");
    const finalized = db.prepare("SELECT 1");
    finalized.finalize();
    finalized.finalize();
    assert.throws(() => finalized.get(), /closed/);
    const title = "PR #1691: 'quoted'; DROP TABLE entries; --";
    insert.run(1, title, new Uint8Array([0, 255]));
    insert.run(2, null, null);
    assert.equal(
      db.prepare("SELECT title FROM entries WHERE id = ?").get(1).title,
      title,
    );
    assert.deepEqual(
      Array.from(
        db.prepare("SELECT payload FROM entries WHERE id = ?").get(1).payload,
      ),
      [0, 255],
    );
    assert.equal(
      db.prepare("SELECT title FROM entries WHERE id = ?").get(2).title,
      null,
    );
    assert.equal(
      db.prepare("SELECT * FROM entries WHERE id = ?").get(3),
      undefined,
    );
    assert.equal(db.prepare("SELECT * FROM entries").all().length, 2);
    assert.throws(
      () =>
        db.transaction(() => {
          insert.run(3, "rolled back", null);
          throw new Error("abort");
        }),
      /abort/,
    );
    assert.equal(
      db.prepare("SELECT * FROM entries WHERE id = 3").get(),
      undefined,
    );
    assert.equal(
      db.transaction(() => {
        insert.run(4, "committed", null);
        return 42;
      }),
      42,
    );
    assert.throws(
      () => db.transaction(() => db.transaction(() => {})),
      /Nested/,
    );
    assert.throws(() => db.transaction(() => Promise.resolve()), /synchronous/);
    db.exec(
      "CREATE TABLE unique_entries (value INTEGER UNIQUE ON CONFLICT ROLLBACK)",
    );
    assert.throws(
      () =>
        db.transaction(() => {
          db.exec("INSERT INTO unique_entries VALUES (1), (1)");
        }),
      /UNIQUE constraint failed/,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM unique_entries").get().n,
      0,
    );

    const other = openService(dataDir);
    assert.equal(other.getStatus().state, "ready");
    db.transaction(() => {
      assert.throws(
        () =>
          other
            .getDatabase()
            .exec("INSERT INTO entries VALUES (5, 'locked', NULL)"),
        /locked|busy/i,
      );
    });
    other.close();
    service.close();
    service.close();
    assert.throws(() => insert.run(6, "after close", null), /closed/);
    assert.throws(() => service.getDatabase(), /closed/);
    assert.equal(service.getStatus().state, "disabled");
    const reopened = openService(dataDir);
    assert.equal(
      reopened.getDatabase().prepare("SELECT count(*) AS n FROM entries").get()
        .n,
      3,
    );

    const db2 = reopened.getDatabase();
    const schemaVersion = db2.prepare("PRAGMA user_version").get().user_version;
    const migrations = [
      ...Array.from({ length: schemaVersion }, (_, index) => ({
        version: index + 1,
        sql: "",
      })),
      {
        version: schemaVersion + 1,
        sql: "CREATE TABLE next_feature (id INTEGER)",
      },
    ];
    assert.throws(() =>
      migrateDiscoveryDatabase(db2, [
        ...migrations,
        { version: schemaVersion + 2, sql: "INVALID SQL" },
      ]),
    );
    assert.equal(
      db2.prepare("PRAGMA user_version").get().user_version,
      schemaVersion,
    );
    assert.equal(
      db2
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'next_feature'")
        .get(),
      undefined,
    );
    migrateDiscoveryDatabase(db2, migrations);
    migrateDiscoveryDatabase(db2, migrations);
    assert.equal(
      db2.prepare("PRAGMA user_version").get().user_version,
      schemaVersion + 1,
    );
    reopened.close();
    const databaseFile = join(dataDir, "discovery.sqlite");
    const newerBytes = readFileSync(databaseFile);
    assert.throws(() => openService(dataDir), /newer/);
    assert.deepEqual(readFileSync(databaseFile), newerBytes);

    const corruptDir = join(temporary, "corrupt");
    // First create the directory through a successful service, then corrupt only
    // this test-owned file after closing its connection.
    openService(corruptDir).close();
    const corruptFile = join(corruptDir, "discovery.sqlite");
    const corruptBytes = Buffer.from("This is not a SQLite database");
    writeFileSync(corruptFile, corruptBytes);
    assert.throws(() => openService(corruptDir), /Cannot open/);
    assert.deepEqual(readFileSync(corruptFile), corruptBytes);

    const invalidDirectory = join(temporary, "file-instead-of-directory");
    writeFileSync(invalidDirectory, "keep");
    assert.throws(() => openService(invalidDirectory));
    assert.equal(readFileSync(invalidDirectory, "utf8"), "keep");

    const closeFailure = openService(join(temporary, "close-failure"), {
      loadDriver: () => ({
        open(path) {
          const native = loadSqliteDriver().open(path);
          return {
            ...native,
            close() {
              native.close();
              throw new Error("simulated close failure");
            },
          };
        },
      }),
    });
    assert.equal(closeFailure.getStatus().state, "ready");
    const warn = console.warn;
    let closeError;
    console.warn = (_prefix, error) => {
      closeError = error;
    };
    try {
      closeFailure.close();
    } finally {
      console.warn = warn;
    }
    assert.equal(closeFailure.getStatus().state, "disabled");
    assert.throws(() => closeFailure.getDatabase(), /closed/);
    assert.match(closeError.message, /close failure/);

    // CI supplies the same path to Node then Bun: the second runtime must read
    // the first runtime's actual file before appending its own row.
    if (sharedFile) {
      const existed = existsSync(sharedFile);
      const shared = loadSqliteDriver().open(sharedFile);
      connections.push(shared);
      migrateDiscoveryDatabase(shared);
      shared.exec("CREATE TABLE IF NOT EXISTS runtimes (name TEXT)");
      if (existed)
        assert.ok(shared.prepare("SELECT name FROM runtimes").all().length > 0);
      shared
        .prepare("INSERT INTO runtimes VALUES (?)")
        .run(process.versions.bun ? "bun" : "node");
    }
  }
  console.log(
    `Discovery SQLite contract passed (${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}, ${expected})`,
  );
} finally {
  for (const connection of connections.reverse()) connection.close();
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
