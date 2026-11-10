import { mkdtemp, writeFile, appendFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  createClaudeTranscriptCache,
  ClaudeTranscriptCache,
} from "../../src/sessions/claude-transcript-cache.js";
import {
  ClaudeSourceIndex,
  ClaudeProjectionChangedError,
} from "../../src/sessions/claude-source-index.js";
import { DurableClaudeSourceIndex } from "../../src/sessions/claude-durable-index.js";
import { SessionReader } from "../../src/sessions/reader.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { buildSummaryFromState } from "../../src/sessions/claude-summary.js";
import { projectTaskListSnapshots } from "../../src/augments/task-list-augments.js";
import {
  sliceAtCompactBoundaries,
  sliceAfterMessageIdWithMatch,
} from "../../src/sessions/pagination.js";
import {
  collectHarnessHistory,
  emptyHarnessHistory,
} from "../../src/sessions/claude-harness-history.js";
import type { UrlProjectId, SessionRewindRecord } from "@yep-anywhere/shared";
let dir: string,
  file: string,
  cache: ClaudeTranscriptCache,
  db: ReturnType<typeof openDiscoveryDatabase>,
  seq: number;
const projectId = "project" as UrlProjectId;
const jsonl = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function row(
  type: string,
  uuid: string,
  parentUuid: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    uuid,
    parentUuid,
    timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, seq++)).toISOString(),
    ...extra,
  };
}
const user = (id: string, parent: string | null, text = id) =>
  row("user", id, parent, { message: { role: "user", content: text } });
const answer = (
  id: string,
  parent: string,
  content: unknown = [{ type: "text", text: id }],
) =>
  row("assistant", id, parent, {
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  });
const compact = (id: string, parent: string) =>
  row("system", id, null, {
    subtype: "compact_boundary",
    logicalParentUuid: parent,
    compactMetadata: { preTokens: 150 },
  });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ya-claude-sql-"));
  file = join(dir, "session.jsonl");
  seq = 0;
  db = openDiscoveryDatabase({
    dataDir: join(dir, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  cache = createClaudeTranscriptCache(db);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cache.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});
async function restart() {
  await cache.close();
  db.close();
  db = openDiscoveryDatabase({
    dataDir: join(dir, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  cache = createClaudeTranscriptCache(db);
}
async function parity(
  after?: string,
  before?: string,
  records: SessionRewindRecord[] = [],
) {
  const indexed = (await cache.loadIndexed(file, records))!;
  const full = (await new ClaudeTranscriptCache({ maxSourceBytes: 0 }).load(
    file,
  ))!;
  const options = {
    filePath: file,
    stats: full.stats,
    sessionId: "session",
    projectId,
  };
  const summary = buildSummaryFromState(full.summaryState, options)!;
  expect(buildSummaryFromState(indexed.summaryState, options)).toEqual(summary);
  const visible = projectTaskListSnapshots(
    normalizeSession(
      {
        summary,
        transcriptSnapshotUpdatedAt: "",
        data: { provider: "claude", session: { messages: full.entries } },
      },
      { rewindRecords: records },
    ).messages,
  );
  const projected = (await indexed.sourceIndex!.window(file, {
    compactions: 2,
    generation: indexed.sourceGeneration!,
    afterMessageId: after,
    beforeMessageId: before,
    rewindRecords: records,
    fence: indexed.appendFence,
  }))!;
  expect(projected).not.toBeNull();
  const expected = after
    ? sliceAfterMessageIdWithMatch(visible, after).messages
    : sliceAtCompactBoundaries(visible, 2, before).messages;
  const actual = after
    ? sliceAfterMessageIdWithMatch(projected.messages, after).messages
    : sliceAtCompactBoundaries(projected.messages, 2).messages;
  expect(actual).toEqual(expected);
  return { indexed, projected, visible };
}
it("reopens selected SQL windows without constructing historical source metadata", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("a", "u", [{ type: "text", text: "x".repeat(3 * 1024 ** 2) }]),
      compact("c1", "a"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
      compact("c3", "a3"),
      user("u4", "c3"),
      answer("a4", "u4"),
    ]),
  );
  await parity();
  await restart();
  const capture = vi
    .spyOn(ClaudeSourceIndex.prototype, "capture")
    .mockImplementation(() => {
      throw Error("Historical decode forbidden");
    });
  const { indexed } = await parity();
  expect(indexed.sourceIndex).toBeInstanceOf(DurableClaudeSourceIndex);
  expect(indexed.entries).toEqual([]);
  expect(cache.getStats().retainedSourceBytes).toBeLessThan(100000);
  await parity("a3");
  await parity(undefined, "c3");
  await parity("missing");
  capture.mockRestore();
});
it("restores compact SQL facts on append, writes only changed rows, and preserves tasks", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("a", "u", [
        {
          type: "tool_use",
          id: "create",
          name: "TaskCreate",
          input: { subject: "first" },
        },
      ]),
      row("user", "r", "a", {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "create",
              content: "Task #1 created successfully: first",
            },
          ],
        },
      }),
      compact("c1", "r"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
    ]),
  );
  await parity();
  await restart();
  await parity();
  await appendFile(
    file,
    jsonl([
      answer("update", "a3", [
        {
          type: "tool_use",
          id: "update-task",
          name: "TaskUpdate",
          input: { taskId: "1", status: "completed" },
        },
      ]),
      row("user", "updated", "update", {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "update-task", content: "{}" },
          ],
        },
      }),
    ]),
  );
  await parity("a3");
  const query = db.prepare(
    "SELECT generation,revision FROM claude_transcript_sources WHERE path=?",
  );
  const before = query.get<{ generation: string; revision: number }>(file)!;
  query.finalize();
  await appendFile(file, jsonl([answer("last", "updated")]));
  await parity("updated");
  const q = db.prepare(
    "SELECT generation,revision FROM claude_transcript_sources WHERE path=?",
  );
  const after = q.get<{ generation: string; revision: number }>(file)!;
  q.finalize();
  expect(after.generation).toBe(before.generation);
  expect(after.revision).toBe(before.revision + 1);
  await restart();
  await parity("a3");
});
it("rejects replaced sources and stale SQL generations and preserves provisional replay", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("a", "u"),
      compact("c1", "a"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
    ]),
  );
  await parity();
  await restart();
  const old = await cache.loadIndexed(file);
  await appendFile(
    file,
    jsonl([user("other", "u"), answer("branch", "other")]),
  );
  await parity();
  await expect(
    old!.sourceIndex!.window(file, {
      compactions: 2,
      generation: old!.sourceGeneration!,
      fence: old!.appendFence,
    }),
  ).rejects.toBeInstanceOf(ClaudeProjectionChangedError);
  await restart();
  await parity();
  await rename(file, file + ".old");
  await writeFile(
    file,
    jsonl([user("replacement", null), answer("new", "replacement")]),
  );
  await parity();
  await restart();
  await parity();
  const partial = JSON.stringify(user("partial", "new"));
  await appendFile(file, partial);
  await parity();
  await appendFile(file, "\n");
  await parity();
  await restart();
  await parity();
});
it("uses bounded SQL history evidence with original row slots and retires it on generation changes", async () => {
  const nativeId = "12345678-1234-4000-8000-123456789012",
    target = "12345678-1234-4000-8000-123456789013";
  const rows = [
    user("u", null),
    answer("a", "u", [
      { type: "text", text: "slot" },
      {
        type: "tool_use",
        id: "launch",
        name: "Bash",
        input: {
          command: `cd /tmp/project && claude --session-id ${target} --print go`,
        },
      },
    ]),
    row("user", "r", "a", {
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "launch", content: "ok" },
        ],
      },
    }),
  ];
  for (const row of rows) Object.assign(row, { sessionId: nativeId });
  await writeFile(file, jsonl(rows));
  await parity();
  await restart();
  const reader = new SessionReader({ sessionDir: dir, transcriptCache: cache });
  const loaded = (await reader.getSession("session", projectId, undefined, {
    tailCompactions: 2,
  }))!;
  const source = loaded.harnessHistorySource!;
  expect(source.length).toBe(3);
  expect(source.isCurrent()).toBe(true);
  const full = (await new ClaudeTranscriptCache({ maxSourceBytes: 0 }).load(
    file,
  ))!;
  expect(
    collectHarnessHistory(
      source,
      emptyHarnessHistory(),
      nativeId,
      "2026-01-01T00:00:00Z",
      8,
      3,
    ).hints,
  ).toHaveLength(1);
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  expect(
    collectHarnessHistory(
      source,
      emptyHarnessHistory(),
      nativeId,
      "2026-01-01T00:00:00Z",
      8,
      3,
    ).hints,
  ).toEqual(
    collectHarnessHistory(
      full.entries,
      emptyHarnessHistory(),
      nativeId,
      "2026-01-01T00:00:00Z",
      8,
      3,
    ).hints,
  );
  await appendFile(file, jsonl([answer("new", "r")]));
  await parity();
  expect(source.isCurrent()).toBe(false);
  vi.useRealTimers();
  await reader.close();
});
it("rolls back failed append publication and never exposes a cancelled staged generation", async () => {
  const rows: unknown[] = [user("u", null)];
  let parent = "u";
  for (let n = 0; n < 300; n++) {
    const id = `a${n}`;
    rows.push(answer(id, parent));
    parent = id;
  }
  await writeFile(file, jsonl(rows));
  await parity();
  await restart();
  db.exec(
    "CREATE TRIGGER fail_claude_header BEFORE UPDATE ON claude_transcript_sources BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
  );
  await appendFile(file, jsonl([answer("next", parent)]));
  await expect(cache.loadIndexed(file)).rejects.toThrow(
    "injected publication failure",
  );
  db.exec("DROP TRIGGER fail_claude_header");
  await restart();
  await parity();
  const original = ClaudeSourceIndex.prototype.sourceRecords;
  let cancelled = false;
  const spy = vi
    .spyOn(ClaudeSourceIndex.prototype, "sourceRecords")
    .mockImplementation(function* (this: ClaudeSourceIndex, from = 0) {
      for (const record of original.call(this, from)) {
        if (!cancelled && record.ordinal === 256) {
          cancelled = true;
          cache.invalidate(file);
        }
        yield record;
      }
    });
  // A replacement forces a staged rebuild instead of a changed-row transaction.
  await writeFile(file, jsonl([...rows, answer("replacement", parent)]));
  await parity();
  spy.mockRestore();
  expect(cancelled).toBe(true);
  const q = db.prepare(
    "SELECT COUNT(*) AS count FROM claude_transcript_generations",
  );
  expect(q.get<{ count: number }>()!.count).toBe(1);
  q.finalize();
});

it("keeps enclosing rewind groups across SQL selection and stale projection owners", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      user("u2", "a1"),
      answer("a2", "u2"),
      user("u3", "a2"),
      compact("c1", "u3"),
      user("u31", "c1"),
      answer("a31", "u31"),
      compact("c2", "a31"),
      user("u32", "c2"),
      answer("a32", "u32"),
      user("u4", "a2"),
      answer("a4", "u4"),
      user("u5", "a1"),
      answer("a5", "u5"),
    ]),
  );
  const inner: SessionRewindRecord = {
    id: "inner",
    at: "2026-11-10T00:01:00Z",
    cutMessageId: "a2",
    cutTurnIndex: 2,
    droppedThroughMessageId: "a32",
    droppedTurnCount: 3,
    reason: "clear",
  };
  const outer: SessionRewindRecord = {
    ...inner,
    id: "outer",
    at: "2026-11-10T00:02:00Z",
    cutMessageId: "a1",
    cutTurnIndex: 1,
    droppedThroughMessageId: "a4",
  };
  const records = [inner, outer];
  await parity(undefined, undefined, records);
  await restart();
  const old = (await parity(undefined, undefined, records)).indexed;
  expect(old.sourceIndex).toBeInstanceOf(DurableClaudeSourceIndex);
  const { projected } = await parity(undefined, undefined, records);
  expect(projected.messages.some((m) => m.uuid === "rewound-group-outer")).toBe(
    true,
  );
  // Another owner publishes a projection at the same source size/mtime.
  const peer = createClaudeTranscriptCache(db);
  try {
    await peer.loadIndexed(file, []);
  } finally {
    await peer.close();
  }
  const fresh = await cache.loadIndexed(file, records);
  expect(fresh!.sourceIndex).not.toBe(old.sourceIndex);
  await parity(undefined, undefined, records);
});
it("recovers expired stages in bounded reads without reclaiming active or accepted generations", async () => {
  await writeFile(file, jsonl([user("u", null), answer("a", "u")]));
  await parity();
  const stage = db.prepare(
    "INSERT INTO claude_transcript_generations(generation,path,owner,lease_until) VALUES(?,?,?,?)",
  );
  stage.run("expired", file, "dead-owner", 0);
  stage.run("live", file, "peer-owner", Date.now() + 60000);
  stage.finalize();
  const insert = db.prepare(
    "INSERT INTO claude_transcript_records(generation,ordinal,record) VALUES(?,?,?)",
  );
  for (let n = 0; n < 300; n++) insert.run("expired", n, "{}");
  insert.run("live", 0, "{}");
  insert.finalize();
  await appendFile(file, jsonl([answer("new", "a")]));
  await parity();
  const live = db.prepare(
    "SELECT count(*) AS n FROM claude_transcript_records WHERE generation='live'",
  );
  expect(live.get<{ n: number }>()!.n).toBe(1);
  live.finalize();
  await restart();
  await parity();
  const count = () => {
    const q = db.prepare(
      "SELECT count(*) AS n FROM claude_transcript_records WHERE generation='expired'",
    );
    try {
      return q.get<{ n: number }>()!.n;
    } finally {
      q.finalize();
    }
  };
  expect(count()).toBe(44);
  cache.invalidate();
  await parity();
  expect(count()).toBe(0);
  const q = db.prepare(
    "SELECT count(*) AS n FROM claude_transcript_records WHERE generation='live'",
  );
  expect(q.get<{ n: number }>()!.n).toBe(1);
  q.finalize();
});
it("does not install or charge metadata after invalidation during paged materialization", async () => {
  const rows: unknown[] = [user("u", null)];
  let parent = "u";
  for (let n = 0; n < 600; n++) {
    const id = `a${n}`;
    rows.push(answer(id, parent));
    parent = id;
  }
  await writeFile(file, jsonl(rows));
  await parity();
  await restart();
  const first = (await cache.loadIndexed(file))!;
  const source = first.sourceIndex as DurableClaudeSourceIndex;
  const original = source.store.materialize.bind(source.store);
  let retired = false;
  const spy = vi
    .spyOn(source.store, "materialize")
    .mockImplementation(async (index) => {
      const pending = original(index);
      if (!retired) {
        retired = true;
        cache.invalidate(file);
      }
      return pending;
    });
  const record: SessionRewindRecord = {
    id: "irrelevant",
    at: "2026-11-10T00:02:00Z",
    cutMessageId: "absent",
    cutTurnIndex: 1,
    droppedThroughMessageId: parent,
    droppedTurnCount: 1,
    reason: "clear",
  };
  const current = (await cache.loadIndexed(file, [record]))!;
  spy.mockRestore();
  expect(retired).toBe(true);
  expect(current.sourceIndex).not.toBe(source);
  expect(cache.getStats().retainedSourceBytes).toBe(
    current.sourceIndex!.retainedBytes + current.sourceIndex!.decodedBytes,
  );
});
it("uses the durable cache in the production profile reader", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("a", "u"),
      compact("c1", "a"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
    ]),
  );
  let reader = new SessionReader({ sessionDir: dir, transcriptCache: cache });
  await reader.getSession("session", projectId, undefined, {
    tailCompactions: 2,
  });
  await reader.close();
  const q = db.prepare("SELECT count(*) AS n FROM claude_transcript_sources");
  expect(q.get<{ n: number }>()!.n).toBe(1);
  q.finalize();
  await restart();
  reader = new SessionReader({ sessionDir: dir, transcriptCache: cache });
  const capture = vi
    .spyOn(ClaudeSourceIndex.prototype, "capture")
    .mockImplementation(() => {
      throw Error("Historical decode forbidden after restart");
    });
  const loaded = await reader.getSession("session", projectId, undefined, {
    tailCompactions: 2,
  });
  expect(loaded!.harnessHistorySource).toBeDefined();
  capture.mockRestore();
  await reader.close();
});
it("keeps accepted SQL rows complete when two profile writers replace a projection", async () => {
  const rows: unknown[] = [user("u", null)];
  let parent = "u";
  for (let n = 0; n < 600; n++) {
    const id = `a${n}`;
    rows.push(answer(id, parent));
    parent = id;
  }
  await writeFile(file, jsonl(rows));
  await parity();
  const peer = createClaudeTranscriptCache(db);
  const record: SessionRewindRecord = {
    id: "first",
    at: "2026-11-10T00:02:00Z",
    cutMessageId: "absent",
    cutTurnIndex: 1,
    droppedThroughMessageId: parent,
    droppedTurnCount: 1,
    reason: "clear",
  };
  try {
    await Promise.all([
      cache.loadIndexed(file, [record]),
      peer.loadIndexed(file, [{ ...record, id: "second" }]),
    ]);
    const q = db.prepare(
      "SELECT (SELECT count(*) FROM claude_transcript_records WHERE generation=s.generation) AS records,(SELECT count(*) FROM claude_transcript_visible WHERE generation=s.generation) AS visible FROM claude_transcript_sources s WHERE path=?",
    );
    expect(q.get<{ records: number; visible: number }>(file)).toEqual({
      records: 601,
      visible: 601,
    });
    q.finalize();
  } finally {
    await peer.close();
  }
  await restart();
  await parity();
});
it("releases fallback statements and retries a generation retired during SQL selection", async () => {
  await writeFile(file, jsonl([user("u", null), answer("a", "u")]));
  await parity();
  await cache.close();
  let live = 0,
    retire = false;
  const tracked: import("../../src/storage/sqlite.js").SqliteDatabase = {
    ...db,
    prepare(query) {
      const statement = db.prepare(query);
      live++;
      let closed = false;
      return {
        ...statement,
        all<Row>(
          ...parameters: import("../../src/storage/sqlite.js").SqliteValue[]
        ) {
          if (
            retire &&
            query.startsWith(
              "SELECT position,record FROM claude_transcript_visible WHERE",
            )
          ) {
            retire = false;
            db.transaction(() => {
              const q = db.prepare(
                "SELECT generation FROM claude_transcript_sources WHERE path=?",
              );
              const old = q.get<{ generation: string }>(file)!.generation;
              q.finalize();
              const next = "replacement-generation";
              const m = db.prepare(
                "INSERT INTO claude_transcript_generations(generation,path,owner,lease_until) VALUES(?,?,?,0)",
              );
              m.run(next, file, "peer");
              m.finalize();
              for (const [table, columns] of [
                ["claude_transcript_records", "ordinal,record"],
                [
                  "claude_transcript_visible",
                  "position,message_id,compact_ordinal,group_id,delivered_ms,record",
                ],
                ["claude_transcript_orphans", "tool_id"],
              ]) {
                const c = db.prepare(
                  `INSERT INTO ${table} SELECT ?,${columns} FROM ${table} WHERE generation=?`,
                );
                c.run(next, old);
                c.finalize();
                const d = db.prepare(`DELETE FROM ${table} WHERE generation=?`);
                d.run(old);
                d.finalize();
              }
              const u = db.prepare(
                "UPDATE claude_transcript_sources SET generation=?,revision=revision+1 WHERE path=?",
              );
              u.run(next, file);
              u.finalize();
            });
          }
          return statement.all<Row>(...parameters);
        },
        finalize() {
          if (!closed) {
            closed = true;
            live--;
            statement.finalize();
          }
        },
      };
    },
  };
  const { ClaudeDurableIndexStore } = await import(
    "../../src/sessions/claude-durable-index.js"
  );
  cache = new ClaudeTranscriptCache({
    durableStore: new ClaudeDurableIndexStore(tracked),
  });
  const indexed = (await cache.loadIndexed(file))!;
  expect(
    await indexed.sourceIndex!.window(file, {
      compactions: 2,
      generation: indexed.sourceGeneration!,
      fence: indexed.appendFence,
      maxBytes: 1,
    }),
  ).toBeNull();
  expect(live).toBe(0);
  retire = true;
  await expect(
    indexed.sourceIndex!.window(file, {
      compactions: 2,
      generation: indexed.sourceGeneration!,
      fence: indexed.appendFence,
    }),
  ).rejects.toBeInstanceOf(ClaudeProjectionChangedError);
  expect(live).toBe(0);
  await parity();
});
