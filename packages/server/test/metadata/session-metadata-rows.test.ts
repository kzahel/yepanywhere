import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it } from "vitest";
import type { SessionMetadata } from "../../src/metadata/SessionMetadataService.js";
import {
  decodeMetadata,
  encodeMetadata,
  METADATA_QUERIES,
  readStoredMetadata,
  SessionMetadataRows,
} from "../../src/metadata/session-metadata-rows.js";
import {
  discoveryMigrationPrefix,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import {
  openSqliteOrThrow,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { storedRows } from "../storage/sqlite-rows.js";

const databases: SqliteDatabase[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  closeTestDiscoveryDatabases();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

function legacyDatabase(rows: Record<string, string>): SqliteDatabase {
  const database = openSqliteOrThrow(":memory:");
  databases.push(database);
  migrateDiscoveryDatabase(database, discoveryMigrationPrefix(30));
  const insert = database.prepare("INSERT INTO session_metadata VALUES (?, ?)");
  try {
    for (const [id, text] of Object.entries(rows)) insert.run(id, text);
  } finally {
    insert.finalize();
  }
  migrateDiscoveryDatabase(database);
  return database;
}

/** Top-level key order is not kept: column keys come back after `extra`. */
const sorted = (value: unknown) =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : value,
  );

it("moves typed values into columns and keeps every row's object exactly", () => {
  const rows: Record<string, string> = {
    full: JSON.stringify({
      provider: "codex",
      workingProjectId: "L3RtcC9w",
      isArchived: true,
      isStarred: false,
      customTitle: 'Title "quoted" \\ back\nline',
      sidebarCategory: "work",
      parentSessionId: "parent",
      parentSessionKind: "btw-aside",
      forkedFromSessionId: "source",
      executor: "host",
      sandboxLevel: "project-write",
      initialPrompt: "prompt é 😀",
      effectiveLaunchSettings: { model: "m", revision: 3, ratio: 1.5 },
      numbers: [1e21, 0.1, -5e-7, 12345678901234567000],
      heartbeatTurnText: "unknown key kept",
    }),
    mistyped: JSON.stringify({
      provider: 5,
      isArchived: "yes",
      isStarred: null,
      customTitle: { text: "object" },
      executor: "",
    }),
    lone: JSON.stringify({ customTitle: "cut \ud83d", provider: "claude" }),
    nul: JSON.stringify({ initialPrompt: "a\u0000b", sandboxLevel: "none" }),
    literal: JSON.stringify({ customTitle: "\\ud83d is text" }),
    empty: "{}",
    array: "[1,2]",
    nullish: "null",
  };
  const database = legacyDatabase(rows);
  const stored = readStoredMetadata(database);
  for (const [id, text] of Object.entries(rows))
    expect(sorted(stored.get(id)), id).toBe(sorted(JSON.parse(text)));
  // Every row encodes back to what the migration stored, so loading and saving
  // an unchanged object writes nothing.
  const store = new SessionMetadataRows(database);
  try {
    for (const [id, metadata] of stored) {
      const matches = store.matches(id, encodeMetadata(metadata));
      // A literal backslash before "ud83d" is a GLOB false match: the value
      // stays in `extra` until the next save moves it.
      expect(matches, id).toBe(id !== "literal");
    }
  } finally {
    store.dispose();
  }
  expect(
    storedRows(
      database,
      "SELECT session_id, provider, is_archived, is_starred, custom_title, executor, sandbox_level, initial_prompt, extra FROM session_metadata ORDER BY id",
    ),
  ).toEqual([
    {
      session_id: "array",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: null,
      initial_prompt: null,
      extra: "[1,2]",
    },
    {
      session_id: "empty",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: null,
      initial_prompt: null,
      extra: "{}",
    },
    {
      session_id: "full",
      provider: "codex",
      is_archived: 1,
      is_starred: 0,
      custom_title: 'Title "quoted" \\ back\nline',
      executor: "host",
      sandbox_level: "project-write",
      initial_prompt: "prompt é 😀",
      extra: JSON.stringify({
        effectiveLaunchSettings: { model: "m", revision: 3, ratio: 1.5 },
        numbers: [1e21, 0.1, -5e-7, 12345678901234567000],
        heartbeatTurnText: "unknown key kept",
      }),
    },
    {
      session_id: "literal",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: null,
      initial_prompt: null,
      extra: rows.literal,
    },
    {
      session_id: "lone",
      provider: "claude",
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: null,
      initial_prompt: null,
      extra: JSON.stringify({ customTitle: "cut \ud83d" }),
    },
    {
      session_id: "mistyped",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: "",
      sandbox_level: null,
      initial_prompt: null,
      extra: JSON.stringify({
        provider: 5,
        isArchived: "yes",
        isStarred: null,
        customTitle: { text: "object" },
      }),
    },
    {
      session_id: "nul",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: "none",
      initial_prompt: null,
      extra: JSON.stringify({ initialPrompt: "a\u0000b" }),
    },
    {
      session_id: "nullish",
      provider: null,
      is_archived: null,
      is_starred: null,
      custom_title: null,
      executor: null,
      sandbox_level: null,
      initial_prompt: null,
      extra: "null",
    },
  ]);
});

it("carries a row that is not JSON over unchanged", () => {
  const database = legacyDatabase({ broken: "{not json" });
  expect(
    storedRows(database, "SELECT provider, extra FROM session_metadata"),
  ).toEqual([{ provider: null, extra: "{not json" }]);
  expect(() => readStoredMetadata(database)).toThrow();
});

it("lets a value kept in extra win over its column", () => {
  expect(
    decodeMetadata({
      provider: "column",
      is_archived: 0,
      extra: '{"provider":"extra"}',
    }),
  ).toEqual({ provider: "extra", isArchived: false });
  const lone = { customTitle: "x\ud800", isStarred: true } as SessionMetadata;
  expect(decodeMetadata(rowOf(encodeMetadata(lone)))).toEqual(lone);
});

function rowOf(encoded: ReturnType<typeof encodeMetadata>) {
  const names = [
    "provider",
    "working_project_id",
    "is_archived",
    "is_starred",
    "custom_title",
    "sidebar_category",
    "parent_session_id",
    "parent_session_kind",
    "forked_from_session_id",
    "executor",
    "sandbox_level",
    "initial_prompt",
    "extra",
  ];
  return Object.fromEntries(names.map((name, index) => [name, encoded[index]]));
}

it("answers point queries from indexes and uncommitted sessions from memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-metadata-rows-"));
  dirs.push(dir);
  const service = createTestSessionMetadataService(dir);
  await service.initialize();
  await service.setSessionSandbox("stored-codex", {
    level: "project-write",
    stateKey: "state",
    projectPath: "/p",
    projectId: "L3A" as UrlProjectId,
    provider: "codex",
  });
  await service.setProvider("moved", "codex");
  await service.setStarred("moved", true);
  expect(service.getProjectWriteSandboxSessions()).toHaveLength(1);

  // A refused save leaves both changes uncommitted; answers follow memory.
  const database = openTestDiscoveryDatabase(dir);
  database.exec(
    "CREATE TRIGGER refuse BEFORE UPDATE ON session_metadata BEGIN SELECT RAISE(ABORT, 'refused'); END; CREATE TRIGGER refuse_insert BEFORE INSERT ON session_metadata BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  await expect(service.setProvider("moved", "claude-ollama")).rejects.toThrow(
    "refused",
  );
  await expect(service.setStarred("new", true)).rejects.toThrow("refused");
  expect(service.getRecordedProviders().sort()).toEqual([
    "claude-ollama",
    "codex",
  ]);
  expect(service.hasRecordedProvider("claude-ollama")).toBe(true);
  expect(service.getCounts()).toEqual({
    sessions: 3,
    starred: 2,
    archived: 0,
  });
  await expect(service.setProvider("stored-codex", "claude")).rejects.toThrow(
    "refused",
  );
  expect(service.getRecordedProviders().sort()).toEqual([
    "claude",
    "claude-ollama",
  ]);
  expect(
    service.getProjectWriteSandboxSessions().map((m) => m.provider),
  ).toEqual(["claude"]);

  const pending = '["moved"]';
  for (const [sql, index, values] of [
    [METADATA_QUERIES.sandboxed, "session_metadata_sandbox", [pending]],
    [METADATA_QUERIES.providers, "session_metadata_provider", [pending]],
    [
      METADATA_QUERIES.hasProvider,
      "session_metadata_provider",
      ["codex", pending],
    ],
    // Step 7's project pages select by working project.
    [
      "SELECT session_id FROM session_metadata WHERE working_project_id = ?",
      "session_metadata_working_project",
      ["p"],
    ],
  ] as const)
    expect(
      JSON.stringify(
        storedRows(database, `EXPLAIN QUERY PLAN ${sql}`, ...values),
      ),
      sql,
    ).toContain(index);
});
