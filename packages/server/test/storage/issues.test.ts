import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiscoverySqliteService,
  DISCOVERY_MIGRATIONS,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteValue,
} from "../../src/storage/sqlite.js";
import { DEFAULT_JIRA_KEY_BLOCKLIST } from "@yep-anywhere/shared";
import { IssueStore } from "../../src/services/issues/IssueStore.js";
import {
  EXTRACTOR_VERSION,
  extractIssueReferences,
  issueUrl,
} from "../../src/services/issues/extract.js";
import { visibleMessageText } from "../../src/sessions/message-text.js";
import { storedRows } from "./sqlite-rows.js";
const dirs: string[] = [];
const services: DiscoverySqliteService[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ya-issues-"));
  dirs.push(dir);
  const service = new DiscoverySqliteService({ dataDir: dir });
  services.push(service);
  return {
    dir,
    store: new IssueStore(service.getDatabase(), () => ({
      enabled: true,
      scope: "viewed",
      recentDays: 7,
      aggressiveMatching: true,
    })),
    service,
  };
}
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("issue reference extraction", () => {
  it("discovers keys and URLs without a registry, preserving repeat occurrences", () => {
    const refs = extractIssueReferences(
      "ABC-123 then ABC-123 and [Fix the crash](https://github.com/Owner/Repo/pull/42?token=secret)",
    );
    expect(refs.map((r) => r.key)).toEqual([
      "owner/repo#42",
      "ABC-123",
      "ABC-123",
    ]);
    expect(refs[0]).toMatchObject({
      title: "Fix the crash",
      url: "https://github.com/owner/repo/pull/42",
      kind: "pr",
    });
  });
  it("takes no title from a label that only names the item or a part of it", () => {
    const pr = "https://github.com/Owner/Repo/pull/42";
    const titles = (label: string, url = pr) =>
      extractIssueReferences(`[${label}](${url})`)[0]?.title;
    for (const label of ["#42", "Repo#42", "`owner/repo#42`", "PR #42"])
      expect(titles(label)).toBeNull();
    expect(titles("gate.sh:82", `${pr}/files#diff-1R82`)).toBeNull();
    expect(titles("this comment", `${pr}#issuecomment-7`)).toBeNull();
    expect(titles("#4200")).toBe("#4200");
    expect(
      extractIssueReferences(
        "[**ABC-1 — Login fails**](https://t.test/browse/ABC-1)",
      )[0]?.title,
    ).toBe("**ABC-1 — Login fails**");
  });
  it("ignores references inside fenced code blocks", () => {
    const keys = (text: string) =>
      extractIssueReferences(text).map((ref) => ref.key);
    expect(
      keys(
        [
          "Shipped https://github.com/a/b/pull/1 and ABC-1.",
          "```json",
          '{"content":"See https://github.com/o/r/pull/12 and XYZ-9"}',
          "```",
          "~~~",
          "```",
          "https://github.com/o/r/pull/13",
          "~~~",
          "Then a/b#2.",
          "```",
          "unclosed https://github.com/o/r/pull/14",
        ].join("\n"),
      ),
    ).toEqual(["a/b#1", "ABC-1", "a/b#2"]);
    // A fenced repository URL does not supply context for a bare number.
    expect(keys("```\nhttps://github.com/o/r\n```\nsee PR #5")).toEqual([]);
  });
  it("ignores prose that is shaped like a bare Jira key", () => {
    const text =
      "UTF-8 and ISO-8601 and COVID-19 and an H-1 visa, but PROJ-7 is real";
    expect(
      extractIssueReferences(text, {
        blockedJiraProjects: DEFAULT_JIRA_KEY_BLOCKLIST,
      }).map((r) => r.key),
    ).toEqual(["PROJ-7"]);
    // A one-letter key cannot exist in Jira, so no list is needed for `H-1`.
    expect(extractIssueReferences(text).map((r) => r.key)).toEqual([
      "UTF-8",
      "ISO-8601",
      "COVID-19",
      "PROJ-7",
    ]);
    // Blocking a name never hides an explicit URL for that same project.
    expect(
      extractIssueReferences("https://jira.example.test/browse/ISO-8601", {
        blockedJiraProjects: DEFAULT_JIRA_KEY_BLOCKLIST,
      }).map((r) => r.key),
    ).toEqual(["ISO-8601"]);
  });
  it("requires explicit wording and an unambiguous local repository for bare numbers", () => {
    expect(
      extractIssueReferences("https://github.com/A/B issue #7 PR #8 #9").map(
        (r) => r.key,
      ),
    ).toEqual(["a/b#7", "a/b#8"]);
    expect(extractIssueReferences("issue #7")).toEqual([]);
    expect(
      extractIssueReferences(
        "https://github.com/A/B https://github.com/C/D issue #7",
      ),
    ).toEqual([]);
  });
  it("does not double count a key enclosed by a URL or label", () => {
    expect(
      extractIssueReferences("[ABC-123](https://tracker.test/browse/ABC-123)"),
    ).toHaveLength(1);
  });
  it("keeps tenants distinct and rejects credential-bearing or nonweb URLs", () => {
    expect(issueUrl("https://a.test/browse/ABC-123")?.identity).not.toBe(
      issueUrl("https://b.test/browse/ABC-123")?.identity,
    );
    expect(issueUrl("https://user:pass@a.test/browse/ABC-123")).toBeNull();
    expect(issueUrl("javascript:ABC-123")).toBeNull();
    expect(extractIssueReferences("123 #123 helloABC-123suffix")).toHaveLength(
      0,
    );
  });
  it("reads nested normalized text and excludes tool results, reasoning and setup", () => {
    expect(
      visibleMessageText({
        uuid: "one",
        type: "user",
        message: {
          content: [
            { type: "text", text: "ABC-123" },
            { type: "tool_result", content: "SECRET-456" },
          ],
        },
      })?.text,
    ).toBe("ABC-123");
    expect(
      visibleMessageText({ uuid: "one", type: "system", content: "ABC-123" }),
    ).toBeNull();
    expect(
      visibleMessageText({
        uuid: "one",
        type: "user",
        content: "# AGENTS.md instructions ABC-123",
      }),
    ).toBeNull();
  });
});

describe("durable issue evidence", () => {
  it("starts empty, discovers many sessions, resolves a scoped key, and survives restart", () => {
    const { store, service, dir } = fixture();
    expect(store.list()).toEqual([]);
    for (const sessionId of ["one", "two"])
      store.capture(
        { sessionId, projectId: "project" },
        { id: "message", text: "Working on ABC-123" },
      );
    expect(store.list("ABC-123")[0]).toMatchObject({
      sessionCount: 2,
      unresolved: true,
    });
    store.capture(
      { sessionId: "two", projectId: "project" },
      { id: "url", text: "https://tracker.test/browse/ABC-123" },
    );
    const item = store.list("ABC-123")[0]!;
    expect(item).toMatchObject({ sessionCount: 2, unresolved: false });
    expect(store.evidence(item.id)).toHaveLength(3);
    service.close();
    const reopened = new DiscoverySqliteService({ dataDir: dir });
    services.push(reopened);
    expect(new IssueStore(reopened.getDatabase()).list("ABC-123")).toEqual([
      item,
    ]);
  });
  it("deduplicates redelivery while retaining repeats and dismissal", () => {
    const { store } = fixture();
    const source = { sessionId: "one", projectId: "project" };
    const m = {
      id: "m",
      text: "https://github.com/a/b/pull/9 twice https://github.com/a/b/pull/9",
    };
    store.capture(source, m);
    store.capture(source, m);
    const item = store.list()[0]!;
    expect(store.evidence(item.id)).toHaveLength(2);
    store.decide(item.id, "one", "dismissed");
    store.capture(source, { ...m, id: "later" });
    expect(store.list()).toEqual([]);
    store.decide(item.id, "one", "discovered");
    expect(store.evidence(item.id)).toHaveLength(4);
  });
  it("records the extraction rules version that produced each evidence row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ya-issues-"));
    dirs.push(dir);
    const service = new DiscoverySqliteService({ dataDir: dir });
    services.push(service);
    const database = service.getDatabase();
    // The column's schema default answers a stored-row query whether or not
    // the insert supplies a version, so watch what the insert itself binds.
    const bound: SqliteValue[][] = [];
    const watched: SqliteDatabase = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!/^\s*INSERT INTO session_issue_evidence/i.test(sql))
          return statement;
        return {
          ...statement,
          run: (...values: SqliteValue[]) => {
            bound.push(values);
            return statement.run(...values);
          },
        };
      },
    };
    const store = new IssueStore(watched, () => ({
      enabled: true,
      scope: "viewed",
      recentDays: 7,
      aggressiveMatching: true,
    }));
    store.capture(
      { sessionId: "s", projectId: "p" },
      { id: "m", text: "ABC-123" },
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]?.at(-1)).toBe(EXTRACTOR_VERSION);
    expect(
      storedRows(
        database,
        "SELECT extractor_version FROM session_issue_evidence",
      )[0]?.extractor_version,
    ).toBe(EXTRACTOR_VERSION);
  });
  it("retains unresolved suppression on resolution and separates project contexts", () => {
    const { store } = fixture();
    for (const projectId of ["a", "b"])
      store.capture(
        { sessionId: projectId, projectId },
        { id: "m", text: "ABC-123" },
      );
    expect(store.list()).toHaveLength(2);
    const item = store.list("", "a")[0]!;
    store.decide(item.id, "a", "dismissed");
    store.capture(
      { sessionId: "a", projectId: "a" },
      { id: "url", text: "https://tracker.test/browse/ABC-123" },
    );
    expect(
      store
        .evidence(store.list("", "a")[0]!.id)
        .find((e) => e.messageId === "m")?.state,
    ).toBe("dismissed");
    expect(store.list("", "b")[0]?.unresolved).toBe(false);
  });
  it("restores ambiguity when a second Jira tenant is observed in the same project", () => {
    const { store } = fixture();
    const source = { sessionId: "s", projectId: "p" };
    store.capture(source, { id: "key", text: "ABC-123" });
    store.capture(source, {
      id: "first",
      text: "https://a.test/browse/ABC-123",
    });
    expect(store.list()).toHaveLength(1);
    store.capture(source, {
      id: "second",
      text: "https://b.test/browse/ABC-123",
    });
    expect(store.list()).toHaveLength(3);
    expect(store.list().filter((x) => x.unresolved)).toHaveLength(1);
  });
  it("supports literal search, bounded pages, title overrides and deletion", () => {
    const { store } = fixture();
    store.capture(
      { sessionId: "s", projectId: "p" },
      {
        id: "m",
        text: "[Fix 100%](https://github.com/a/b/issues/1) https://github.com/a/b/issues/2",
      },
    );
    expect(store.list("%")).toHaveLength(1);
    expect(store.list("_")).toHaveLength(0);
    expect(store.list("", "", "", false, 1)).toHaveLength(1);
    const item = store.list("%")[0]!;
    expect(store.title(item.id, "New title")).toBe("New title");
    expect(store.list("New title")).toHaveLength(1);
    expect(store.title(item.id, null)).toBe("Fix 100%");
    store.delete(item.id);
    expect(store.list()).toHaveLength(1);
  });
  it("reads a title saved under earlier label rules as absent, unless a user chose it", () => {
    const { store, service } = fixture();
    store.capture(
      { sessionId: "s", projectId: "p" },
      { id: "m", text: "https://github.com/a/b/pull/7" },
    );
    // Version 1 kept `[#7](…)` labels, and the first observed title is kept.
    service
      .getDatabase()
      .prepare("UPDATE external_issues SET title='#7'")
      .run();
    const item = store.list()[0]!;
    expect(item.title).toBeNull();
    store.title(item.id, "#7");
    expect(store.list()[0]?.title).toBe("#7");
  });
});

describe("append-only discovery migrations", () => {
  it.each(Array.from({ length: DISCOVERY_MIGRATIONS.length }, (_, i) => i))(
    "upgrades prefix %i without losing unrelated data",
    (prefix) => {
      const db = loadSqliteDriver()!.open(":memory:");
      try {
        db.exec("PRAGMA foreign_keys=ON");
        if (prefix)
          migrateDiscoveryDatabase(db, DISCOVERY_MIGRATIONS.slice(0, prefix));
        if (prefix) {
          db.exec(
            "CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('keep')",
          );
        }
        migrateDiscoveryDatabase(db);
        migrateDiscoveryDatabase(db);
        const store = new IssueStore(db);
        expect(storedRows(db, "PRAGMA user_version")[0]?.user_version).toBe(
          DISCOVERY_MIGRATIONS.length,
        );
        if (prefix)
          expect(storedRows(db, "SELECT value FROM retained")[0]?.value).toBe(
            "keep",
          );
        expect(store.list()).toEqual([]);
        expect(() =>
          migrateDiscoveryDatabase(db, DISCOVERY_MIGRATIONS.slice(0, 3)),
        ).toThrow("newer");
        expect(storedRows(db, "PRAGMA user_version")[0]?.user_version).toBe(
          DISCOVERY_MIGRATIONS.length,
        );
      } finally {
        db.close();
      }
    },
  );
  it("keys issue jobs by their catalog row instead of a copy of it", () => {
    const db = loadSqliteDriver()!.open(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDiscoveryDatabase(db, DISCOVERY_MIGRATIONS.slice(0, 28));
      const copy = (row: object) => JSON.stringify(row);
      const store = { catalogFamily: "claude", storeKey: "/store" };
      const insert = db.prepare(
        "INSERT INTO issue_index_jobs(session_id,project_id,source_version,cursor,state,error,updated_at,source_json,priority) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const [session, source] of [
        // Recorded its native id.
        [
          "public-1",
          copy({
            ...store,
            sessionId: "public-1",
            nativeSessionId: "native-1",
          }),
        ],
        // Older copy without it; the identity binds the native id.
        ["public-2", copy({ ...store, sessionId: "public-2" })],
        // No identity: the job's id is the native one.
        ["native-3", copy({ ...store, sessionId: "native-3" })],
        // A viewed window has no catalog row.
        ["viewed", "null"],
      ] as const)
        insert.run(session, "p", "v", "c", "indexed", null, 7, source, 1);
      insert.finalize();
      db.exec(
        "INSERT INTO session_identities(session_id,provider,project_id,created_at,native_family,native_scope,native_id) VALUES ('public-2','claude','p','t','claude','/store','native-2')",
      );
      migrateDiscoveryDatabase(db);
      expect(
        storedRows(
          db,
          "SELECT session_id,project_id,source_version,cursor,state,updated_at,catalog_key,priority FROM issue_index_jobs ORDER BY session_id",
        ),
      ).toEqual(
        [
          ["native-3", JSON.stringify(["claude", "/store", "native-3"])],
          ["public-1", JSON.stringify(["claude", "/store", "native-1"])],
          ["public-2", JSON.stringify(["claude", "/store", "native-2"])],
          ["viewed", null],
        ].map(([session_id, catalog_key]) => ({
          session_id,
          project_id: "p",
          source_version: "v",
          cursor: "c",
          state: "indexed",
          updated_at: 7,
          catalog_key,
          priority: 1,
        })),
      );
      expect(
        storedRows(
          db,
          "SELECT name FROM pragma_table_info('issue_index_jobs')",
        ).map((column) => column.name),
      ).not.toContain("source_json");
    } finally {
      db.close();
    }
  });
  it("rolls back an entire failing upgrade sequence", () => {
    const db = loadSqliteDriver()!.open(":memory:");
    try {
      migrateDiscoveryDatabase(db, DISCOVERY_MIGRATIONS.slice(0, 3));
      expect(() =>
        migrateDiscoveryDatabase(db, [
          ...DISCOVERY_MIGRATIONS,
          {
            version: DISCOVERY_MIGRATIONS.length + 1,
            sql: "CREATE TABLE broken (",
          },
        ]),
      ).toThrow();
      expect(storedRows(db, "PRAGMA user_version")[0]?.user_version).toBe(3);
      expect(
        storedRows(
          db,
          "SELECT name FROM sqlite_schema WHERE name='external_issues'",
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
