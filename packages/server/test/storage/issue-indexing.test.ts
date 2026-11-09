import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { IssueStore } from "../../src/services/issues/IssueStore.js";
import {
  type CatalogMark,
  IssueIndexer,
  type IssueIndexerDeps,
  type IssueSettings,
} from "../../src/services/issues/IssueIndexer.js";
import { readIssueTextBatch } from "../../src/sessions/issue-text-reader.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import type { SqliteDatabase, SqliteValue } from "../../src/storage/sqlite.js";
import { storedRows } from "./sqlite-rows.js";
const dirs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "ya-issue-index-"));
  dirs.push(dir);
  return dir;
}
/**
 * A catalog that answers every sweep with all of its rows, each keyed by its
 * session id, at the next generation unless `mark` says otherwise.
 */
function wholeCatalog(
  rows: () => readonly SessionCatalogRow[],
  mark?: () => CatalogMark,
): Pick<IssueIndexerDeps, "changes" | "row"> {
  let generation = 0;
  const keyed = (row: SessionCatalogRow) => ({
    ...row,
    catalogKey: row.sessionId,
  });
  return {
    changes: async () => ({
      mark: mark?.() ?? { catalogEpoch: "e", catalogGeneration: ++generation },
      full: true,
      rows: rows().map(keyed),
      removed: [],
      excluded: [],
    }),
    row: async (key) => {
      const row = rows().find((candidate) => candidate.sessionId === key);
      return row && keyed(row);
    },
  };
}
const claude = (id: string, text: string) =>
  `${JSON.stringify({
    type: "user",
    uuid: id,
    timestamp: "2026-09-10T10:00:00Z",
    message: { role: "user", content: text },
  })}\n`;

it("reads bounded batches, retains repeat IDs, continues automatically and handles oversized records", async () => {
  const file = join(directory(), "s.jsonl");
  writeFileSync(
    file,
    Array.from({ length: 2005 }, (_, i) =>
      claude(String(i), `ABC-${i + 1}`),
    ).join("") +
      claude("large", "x".repeat(2 * 1024 * 1024)) +
      claude("after", "END-42"),
  );
  const signal = new AbortController().signal;
  const first = await readIssueTextBatch("claude", [{ path: file }], {
    signal,
  });
  expect(first.done).toBe(false);
  expect(first.messages).toHaveLength(2000);
  expect(first.bytesRead).toBeLessThanOrEqual(8 * 1024 * 1024);
  const second = await readIssueTextBatch("claude", [{ path: file }], {
    signal,
    cursor: first.cursor,
  });
  expect(second.done).toBe(true);
  expect(second.partial).toBe(true);
  expect(second.messages.at(-1)?.text).toBe("END-42");
});
it("resumes appends, detects rewritten boundaries and stops on incomplete source without spinning", async () => {
  const file = join(directory(), "s.jsonl");
  writeFileSync(file, claude("one", "ABC-1"));
  const signal = new AbortController().signal;
  const one = await readIssueTextBatch("claude", [{ path: file }], { signal });
  appendFileSync(file, claude("two", "ABC-2"));
  const two = await readIssueTextBatch("claude", [{ path: file }], {
    signal,
    cursor: one.cursor,
  });
  expect(two.messages.map((m) => m.id)).toEqual(["two"]);
  writeFileSync(file, claude("new", "XYZ-3"));
  const rewrite = await readIssueTextBatch("claude", [{ path: file }], {
    signal,
    cursor: two.cursor,
  });
  expect(rewrite.messages[0]?.text).toBe("XYZ-3");
  appendFileSync(file, '{"type":');
  const partial = await readIssueTextBatch("claude", [{ path: file }], {
    signal,
    cursor: rewrite.cursor,
  });
  expect(partial.done).toBe(true);
  expect(partial.partial).toBe(true);
});
it("indexes Codex visible user/assistant text with stable source identity and excludes tools/context", async () => {
  const file = join(directory(), "s.jsonl");
  const timestamp = "2026-09-10T10:00:00Z";
  writeFileSync(
    file,
    [
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "SECRET-1" }],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "ABC-123" }],
        },
      },
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "user_message",
          message: "ABC-123",
          client_id: "human-1",
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "assistant",
          id: "reply-1",
          content: [
            { type: "output_text", text: "https://github.com/a/b/pull/4" },
          ],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: "tool",
          output: "SECRET-2",
        },
      },
    ]
      .map((x) => `${JSON.stringify(x)}\n`)
      .join(""),
  );
  const batch = await readIssueTextBatch("codex", [{ path: file }], {
    signal: new AbortController().signal,
  });
  expect(batch.messages.map((m) => m.id)).toEqual(["human-1", "reply-1"]);
  expect(
    batch.messages.every((m) => m.sourceId?.startsWith("codex-byte-")),
  ).toBe(true);
});
it("automatically drains a durable recent queue larger than its in-memory batch and preserves state on restart", async () => {
  const dir = directory();
  const service = new DiscoverySqliteService({ dataDir: dir });
  const store = new IssueStore(service.getDatabase(), () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  let settings: IssueSettings = {
    enabled: true,
    scope: "recent",
    recentDays: 7,
  };
  const rows = Array.from(
    { length: 20 },
    (_, i) =>
      ({
        sessionId: `s${i}`,
        projectId: "p",
        sourceVersion: "one",
        updatedAt: new Date().toISOString(),
        location: { kind: "file", path: "unused" },
      }) as SessionCatalogRow,
  );
  const read: string[] = [];
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    ...wholeCatalog(() => [
      ...rows,
      { ...rows[0]!, sessionId: "old", updatedAt: "2000-01-01T00:00:00Z" },
    ]),
    read: async (row) => {
      read.push(row.sessionId);
      return {
        messages: [{ id: "m", text: "ABC-123" }],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 20,
      };
    },
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });
  indexer.refresh();
  await indexer.settled();
  expect(read).toHaveLength(20);
  expect(store.list()[0]?.sessionCount).toBe(20);
  indexer.refresh();
  await indexer.settled();
  expect(read).toHaveLength(20);
  settings = { ...settings, enabled: false };
  indexer.configure();
  indexer.observe({ sessionId: "disabled", projectId: "p" }, [
    { type: "user", uuid: "m", content: "NOPE-9" },
  ]);
  await indexer.settled();
  expect(store.list("NOPE")).toEqual([]);
});
it("automatic viewed windows need no registered issues and disable fences delayed writes", async () => {
  const service = new DiscoverySqliteService({
    dataDir: directory(),
  });
  const store = new IssueStore(service.getDatabase(), () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  let settings: IssueSettings = {
    enabled: true,
    scope: "viewed",
    recentDays: 7,
  };
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    ...wholeCatalog(() => []),
    read: async () => null,
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });
  indexer.observe({ sessionId: "one", projectId: "p" }, [
    { type: "user", uuid: "m", message: { content: "ABC-123" } },
  ]);
  await indexer.settled();
  expect(store.list()[0]?.key).toBe("ABC-123");
  indexer.observe({ sessionId: "two", projectId: "p" }, [
    { type: "user", uuid: "m", message: { content: "SECRET-123" } },
  ]);
  settings = { ...settings, enabled: false };
  indexer.configure();
  await indexer.settled();
  expect(store.list("SECRET")).toEqual([]);
});

it("keeps a Codex paired user response intact across the batch boundary", async () => {
  const file = join(directory(), "boundary.jsonl");
  const timestamp = "2026-09-10T10:00:00Z";
  const prefix = Array.from(
    { length: 1999 },
    () =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "token_count", info: null },
      })}\n`,
  ).join("");
  writeFileSync(
    file,
    prefix +
      [
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ABC-123" }],
          },
        },
        {
          type: "event_msg",
          timestamp,
          payload: {
            type: "user_message",
            message: "ABC-123",
            client_id: "user-at-boundary",
          },
        },
      ]
        .map((x) => `${JSON.stringify(x)}\n`)
        .join(""),
  );
  const signal = new AbortController().signal;
  const first = await readIssueTextBatch("codex", [{ path: file }], { signal });
  expect(first.messages).toHaveLength(0);
  const second = await readIssueTextBatch("codex", [{ path: file }], {
    signal,
    cursor: first.cursor,
  });
  expect(second.messages.map((x) => x.id)).toEqual(["user-at-boundary"]);
});

it("retains ordinal identity across frozen Codex lineage segments", async () => {
  const dir = directory();
  const a = join(dir, "a.jsonl"),
    b = join(dir, "b.jsonl");
  const entry = (ordinal: number, text: string) =>
    `${JSON.stringify({
      type: "response_item",
      ordinal,
      timestamp: "2026-09-10T10:00:00Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    })}\n`;
  const prefix = entry(1, "ABC-123");
  writeFileSync(a, prefix + entry(2, "EXCLUDED-1"));
  writeFileSync(b, entry(3, "ABC-456"));
  const batch = await readIssueTextBatch(
    "codex",
    [
      { path: a, end: Buffer.byteLength(prefix), ordinal: true },
      { path: b, ordinal: true },
    ],
    { signal: new AbortController().signal },
  );
  expect(batch.messages.map((x) => x.sourceId)).toEqual([
    "codex-ordinal-1",
    "codex-ordinal-3",
  ]);
  expect(batch.messages.map((x) => x.text)).toEqual(["ABC-123", "ABC-456"]);
});

it("deletion fences an in-flight batch without losing other references in the same session", async () => {
  const service = new DiscoverySqliteService({
    dataDir: directory(),
  });
  const store = new IssueStore(service.getDatabase(), () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  const source = { sessionId: "s", projectId: "p", sourceVersion: "v1" };
  store.capture(source, { id: "m", text: "https://github.com/a/b/pull/42" });
  const id = store.list()[0]!.id;
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const row = {
    ...source,
    updatedAt: new Date().toISOString(),
    location: { kind: "file", path: "unused" },
  } as SessionCatalogRow;
  const indexer = new IssueIndexer(store, {
    settings: () => ({ enabled: true, scope: "recent", recentDays: 7 }),
    ...wholeCatalog(() => [row]),
    read: async () => {
      if (++calls === 1) {
        started();
        await waiting;
      }
      return {
        messages: [
          { id: "m", text: "https://github.com/a/b/pull/42 OTHER-123" },
        ],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 50,
      };
    },
  });
  cleanup.push(async () => {
    release();
    await indexer.close();
    service.close();
  });
  indexer.refresh();
  await reading;
  indexer.delete(id);
  release();
  await indexer.settled();
  expect(store.list("a/b#42")).toEqual([]);
  expect(store.list("OTHER-123")).toHaveLength(1);
  store.capture(
    { ...source, sourceVersion: "v2" },
    { id: "later", text: "https://github.com/a/b/pull/42" },
  );
  expect(store.list("a/b#42")).toHaveLength(1);
});
it("sweeps a catalog for moved projects without a write transaction per session", async () => {
  const dir = directory();
  const service = new DiscoverySqliteService({ dataDir: dir });
  const database = service.getDatabase();
  let transactions = 0;
  // SQLite takes a file lock per transaction, and on a network data directory
  // each lock is a round trip on the event loop, so the count itself is the
  // contract: a sweep costs transactions only for sessions that really moved.
  const counted: SqliteDatabase = {
    ...database,
    transaction<T>(operation: () => T): T {
      transactions += 1;
      return database.transaction(operation);
    },
  };
  const store = new IssueStore(counted, () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  while (store.processResolutions()) {
    /* Finish one-time schema backfill before measuring idle sweeps. */
  }
  transactions = 0;
  let project = "p";
  const rows = Array.from(
    { length: 200 },
    (_, i) =>
      ({
        sessionId: `s${i}`,
        projectId: project,
        sourceVersion: "one",
        updatedAt: new Date().toISOString(),
        location: { kind: "file", path: "unused" },
      }) as SessionCatalogRow,
  );
  const indexer = new IssueIndexer(store, {
    settings: () => ({ enabled: true, scope: "viewed", recentDays: 7 }),
    ...wholeCatalog(() =>
      rows.map((row) => ({ ...row, projectId: project }) as SessionCatalogRow),
    ),
    read: async () => null,
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });

  indexer.refresh();
  await indexer.settled();
  expect(transactions).toBe(0);

  // One session gains evidence, so it is the only one a later sweep can move.
  store.capture(
    { sessionId: "s7", projectId: "p", sourceVersion: "one" },
    { id: "m", text: "ABC-123" },
  );
  transactions = 0;
  project = "moved";
  indexer.refresh();
  await indexer.settled();
  expect(transactions).toBe(1);
  expect(store.evidence(store.list()[0]!.id)[0]?.projectId).toBe("moved");

  // Sweeping again over the same catalog moves nothing, and a session whose
  // rows already file under the current project costs no transaction at all —
  // the update statements would match no row, but the lock is taken anyway.
  transactions = 0;
  indexer.refresh();
  await indexer.settled();
  expect(transactions).toBe(0);
});
// Disk-bound: 200 sessions through three publish/settle sweeps. 34ms here,
// 1295-2353ms across CI runs that passed, and past the 5000ms default on a
// loaded runner. Budget is 4x the observed maximum, which is that 5000ms
// limit rather than this host's time or the fastest run that beat it.
it("re-admits an unchanged recent catalog without a write per session", {
  timeout: 20_000,
}, async () => {
  const service = new DiscoverySqliteService({
    dataDir: directory(),
  });
  const database = service.getDatabase();
  let writes = 0;
  let admissions = 0;
  // Recent scope admits every recent session on every publication, and the
  // admitting upsert runs in autocommit, so it never reached the transaction
  // counter above while still taking one file lock per session per
  // publication. Count the write statements themselves.
  const counted: SqliteDatabase = {
    ...database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return statement;
      return {
        ...statement,
        run: (...values: SqliteValue[]) => {
          writes += 1;
          if (/^\s*INSERT INTO issue_index_jobs/i.test(sql)) admissions += 1;
          return statement.run(...values);
        },
      };
    },
  };
  const settings: IssueSettings = {
    enabled: true,
    scope: "recent",
    recentDays: 7,
  };
  const store = new IssueStore(counted, () => settings);
  while (store.processResolutions()) {
    /* Finish one-time schema backfill before measuring idle sweeps. */
  }
  const rows = Array.from(
    { length: 200 },
    (_, i) =>
      ({
        sessionId: `s${i}`,
        projectId: "p",
        sourceVersion: "one",
        updatedAt: new Date().toISOString(),
        location: { kind: "file", path: "unused" },
      }) as SessionCatalogRow,
  );
  const read: string[] = [];
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    ...wholeCatalog(() => rows),
    read: async (row) => {
      read.push(row.sessionId);
      return {
        messages: [],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 0,
      };
    },
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });

  admissions = 0;
  indexer.refresh();
  await indexer.settled();
  expect(admissions).toBe(200);

  // Every session update republishes the catalog, so this is what an idle
  // server pays between real changes: nothing at all, not merely less.
  writes = 0;
  indexer.refresh();
  await indexer.settled();
  expect(writes).toBe(0);

  // A session whose source really changed is still admitted, and alone.
  rows[3] = { ...rows[3]!, sourceVersion: "two" } as SessionCatalogRow;
  admissions = 0;
  read.length = 0;
  indexer.refresh();
  await indexer.settled();
  expect(admissions).toBe(1);
  expect(read).toEqual(["s3"]);
});
it("re-queues a paused job when the catalog admits it again", async () => {
  const service = new DiscoverySqliteService({
    dataDir: directory(),
  });
  const settings: IssueSettings = {
    enabled: true,
    scope: "recent",
    recentDays: 60,
  };
  const store = new IssueStore(service.getDatabase(), () => settings);
  // Thirty days old, so only the wide window admits it.
  const row = {
    sessionId: "s",
    projectId: "p",
    sourceVersion: "one",
    updatedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    location: { kind: "file", path: "unused" },
  } as SessionCatalogRow;
  let narrowsAfterAdmission = true;
  const read: string[] = [];
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    changes: async () => ({
      mark: { catalogEpoch: "e", catalogGeneration: 1 },
      full: true,
      rows: [{ ...row, catalogKey: "s" }],
      removed: [],
      excluded: [],
    }),
    row: async () => {
      // The window narrows between admission and the worker reaching the job.
      if (narrowsAfterAdmission) settings.recentDays = 7;
      return { ...row, catalogKey: "s" };
    },
    read: async (candidate) => {
      read.push(candidate.sessionId);
      return {
        messages: [],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 0,
      };
    },
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });

  indexer.refresh();
  await indexer.settled();
  expect(read).toEqual([]);
  expect(
    storedRows(store.database, "SELECT state FROM issue_index_jobs")[0]?.state,
  ).toBe("paused");

  // Widened again, and nothing about the catalog row changed. Only the upsert
  // returns a paused job to the queue, so skipping it as unchanged would
  // leave this session indefinitely unindexed.
  settings.recentDays = 60;
  narrowsAfterAdmission = false;
  indexer.refresh();
  await indexer.settled();
  expect(read).toEqual(["s"]);
});
it("skips a republished catalog that has not changed, and still sweeps on demand", async () => {
  const dir = directory();
  const service = new DiscoverySqliteService({ dataDir: dir });
  const store = new IssueStore(service.getDatabase(), () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  let enumerations = 0;
  const rows = Array.from(
    { length: 5 },
    (_, i) =>
      ({
        sessionId: `s${i}`,
        projectId: "p",
        sourceVersion: "one",
        updatedAt: new Date().toISOString(),
        location: { kind: "file", path: "unused" },
      }) as SessionCatalogRow,
  );
  let mark: CatalogMark = { catalogEpoch: "e1", catalogGeneration: 7 };
  const indexer = new IssueIndexer(store, {
    settings: () => ({ enabled: true, scope: "viewed", recentDays: 7 }),
    ...wholeCatalog(
      () => {
        enumerations++;
        return rows;
      },
      () => mark,
    ),
    read: async () => null,
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });

  indexer.refresh(mark);
  await indexer.settled();
  expect(enumerations).toBe(1);

  // The catalog republishes every few seconds; an unchanged generation must
  // cost nothing at all, not merely less than it used to.
  for (let repeat = 0; repeat < 5; repeat++) indexer.refresh(mark);
  await indexer.settled();
  expect(enumerations).toBe(1);

  mark = { catalogEpoch: "e1", catalogGeneration: 8 };
  indexer.refresh(mark);
  await indexer.settled();
  expect(enumerations).toBe(2);

  // A rebuilt catalog reuses generation numbers, so the epoch has to count.
  mark = { catalogEpoch: "e2", catalogGeneration: 8 };
  indexer.refresh(mark);
  await indexer.settled();
  expect(enumerations).toBe(3);

  // A caller with its own reason always runs, whatever the catalog says.
  indexer.refresh();
  await indexer.settled();
  expect(enumerations).toBe(4);
});

it("reads a reference straddling a capture chunk boundary, and none in a code block opened chunks earlier", async () => {
  // The reference starts five bytes before the 32 KiB boundary and ends after
  // it, so only a chunk that reads past its own range sees it whole; the chunk
  // that starts after it does not own it and would never file it. The sample
  // URL lies two chunks past its fence's opening line, beyond any overlap.
  const text = `${"x".repeat(32 * 1024 - 6)} https://github.com/a/b/pull/42 tail
\`\`\`json
${"y".repeat(40 * 1024)}
{"content":"See https://github.com/o/r/pull/12"}
\`\`\`
`;
  const service = new DiscoverySqliteService({
    dataDir: directory(),
  });
  const store = new IssueStore(service.getDatabase(), () => ({
    enabled: true,
    scope: "viewed",
    recentDays: 7,
    aggressiveMatching: true,
  }));
  const row = {
    sessionId: "background",
    projectId: "p",
    sourceVersion: "v1",
    updatedAt: new Date().toISOString(),
    location: { kind: "file", path: "unused" },
  } as SessionCatalogRow;
  const indexer = new IssueIndexer(store, {
    settings: () => ({ enabled: true, scope: "recent", recentDays: 7 }),
    ...wholeCatalog(() => [row]),
    read: async () => ({
      messages: [{ id: "m", text }],
      cursor: "end",
      done: true,
      partial: false,
      bytesRead: text.length,
    }),
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });

  indexer.refresh();
  await indexer.settled();
  expect(store.list("a/b#42")).toHaveLength(1);
  expect(store.list("o/r#12")).toHaveLength(0);

  // The viewed window captures through the same loop, so it answers the same.
  indexer.observe({ sessionId: "viewed", projectId: "p" }, [
    { type: "user", uuid: "m", message: { content: text } },
  ]);
  await indexer.settled();
  expect(
    storedRows(
      store.database,
      "SELECT session_id FROM session_issue_evidence WHERE ref_key='a/b#42' ORDER BY session_id",
    ).map((evidence) => evidence.session_id),
  ).toEqual(["background", "viewed"]);
});
it("follows catalog changes: only changed rows, removals end jobs, moved sessions keep theirs, unprojected rows retried", async () => {
  const service = new DiscoverySqliteService({ dataDir: directory() });
  const settings: IssueSettings = {
    enabled: true,
    scope: "recent",
    recentDays: 7,
  };
  const store = new IssueStore(service.getDatabase(), () => settings);
  const now = new Date().toISOString();
  const row = (sessionId: string, catalogKey: string, extra = {}) =>
    ({
      sessionId,
      catalogKey,
      projectId: "p",
      sourceVersion: "one",
      updatedAt: now,
      location: { kind: "file", path: "unused" },
      ...extra,
    }) as SessionCatalogRow & { catalogKey: string };
  // An old session with a job from before; its row moves to a new key.
  store.admitJob({
    sessionId: "old",
    projectId: "p",
    sourceVersion: "one",
    catalogKey: "k-old",
    priority: 0,
  });
  store.markJob("old", "indexed");
  store.recordViewedJob("viewed", "p", "viewed", null);
  const calls: { since?: CatalogMark; retry: string[] }[] = [];
  const answers = [
    {
      mark: { catalogEpoch: "e", catalogGeneration: 1 },
      full: true,
      rows: [row("s1", "k1"), row("s2", "k2")],
      removed: [],
      excluded: ["k4"],
    },
    {
      mark: { catalogEpoch: "e", catalogGeneration: 2 },
      full: false,
      rows: [
        row("s2", "k2", { sourceVersion: "two" }),
        row("s4", "k4"),
        row("old", "k-moved", { updatedAt: "2000-01-01T00:00:00Z" }),
      ],
      removed: ["k1", "k-unknown"],
      excluded: [],
    },
  ];
  // The catalog as the worker finds it when it reaches a job.
  const rows = new Map(answers[0]!.rows.map((r) => [r.catalogKey, r]));
  const read: string[] = [];
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    changes: async (since, retry) => {
      calls.push({ since, retry: [...retry] });
      return answers[calls.length - 1]!;
    },
    row: async (key) => rows.get(key),
    read: async (candidate) => {
      read.push(`${candidate.sessionId}@${candidate.sourceVersion}`);
      return {
        messages: [],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 0,
      };
    },
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });
  const jobs = () =>
    storedRows(
      store.database,
      "SELECT session_id,catalog_key,state FROM issue_index_jobs ORDER BY session_id",
    );

  indexer.refresh({ catalogEpoch: "e", catalogGeneration: 1 });
  await indexer.settled();
  expect(read.sort()).toEqual(["s1@one", "s2@one"]);
  for (const r of answers[1]!.rows) rows.set(r.catalogKey, r);
  rows.delete("k1");
  indexer.refresh({ catalogEpoch: "e", catalogGeneration: 2 });
  await indexer.settled();
  expect(calls).toEqual([
    { since: undefined, retry: [] },
    { since: { catalogEpoch: "e", catalogGeneration: 1 }, retry: ["k4"] },
  ]);
  expect(read.slice(2).sort()).toEqual(["s2@two", "s4@one"]);
  expect(jobs()).toEqual([
    { session_id: "old", catalog_key: "k-moved", state: "indexed" },
    { session_id: "s2", catalog_key: "k2", state: "indexed" },
    { session_id: "s4", catalog_key: "k4", state: "indexed" },
    { session_id: "viewed", catalog_key: null, state: "viewed" },
  ]);

  // A queued job whose row is gone from the catalog waits as paused.
  rows.delete("k2");
  store.admitJob({
    sessionId: "s2",
    projectId: "p",
    sourceVersion: "three",
    catalogKey: "k2",
    priority: 0,
  });
  indexer.resumePendingWork();
  await indexer.settled();
  expect(jobs().find((job) => job.session_id === "s2")?.state).toBe("paused");
});
it("resumes a job paused because its row was briefly unprojectable", async () => {
  const service = new DiscoverySqliteService({ dataDir: directory() });
  const settings: IssueSettings = {
    enabled: true,
    scope: "recent",
    recentDays: 7,
  };
  const store = new IssueStore(service.getDatabase(), () => settings);
  const row = {
    sessionId: "grok-1",
    catalogKey: "k",
    projectId: "p",
    sourceVersion: "one",
    updatedAt: new Date().toISOString(),
    location: { kind: "file", path: "unused" },
  } as SessionCatalogRow & { catalogKey: string };
  // A pending allocation of its family hides the row when the worker
  // reaches the job; it projects again afterwards, unchanged.
  let projectable = false;
  const retried: string[][] = [];
  let generation = 0;
  const read: string[] = [];
  const indexer = new IssueIndexer(store, {
    settings: () => settings,
    changes: async (since, retry) => {
      generation += 1;
      retried.push([...retry]);
      const rows =
        since === undefined || (projectable && retry.has("k")) ? [row] : [];
      return {
        mark: { catalogEpoch: "e", catalogGeneration: generation },
        full: since === undefined,
        rows,
        removed: [],
        excluded: [],
      };
    },
    row: async () => (projectable ? row : undefined),
    read: async (candidate) => {
      read.push(candidate.sessionId);
      return {
        messages: [],
        cursor: "end",
        done: true,
        partial: false,
        bytesRead: 0,
      };
    },
  });
  cleanup.push(async () => {
    await indexer.close();
    service.close();
  });
  indexer.refresh({ catalogEpoch: "e", catalogGeneration: 1 });
  await indexer.settled();
  expect(read).toEqual([]);
  expect(
    storedRows(store.database, "SELECT state FROM issue_index_jobs")[0]?.state,
  ).toBe("paused");
  projectable = true;
  indexer.refresh({ catalogEpoch: "e", catalogGeneration: 2 });
  await indexer.settled();
  expect(retried[1]).toEqual(["k"]);
  expect(read).toEqual(["grok-1"]);
});
