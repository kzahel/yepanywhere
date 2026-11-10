import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UrlProjectId, SessionRewindRecord } from "@yep-anywhere/shared";
import { openDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  createClaudeTranscriptCache,
  ClaudeTranscriptCache,
} from "../../src/sessions/claude-transcript-cache.js";
import { DurableClaudeSourceIndex } from "../../src/sessions/claude-durable-index.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { buildSummaryFromState } from "../../src/sessions/claude-summary.js";
import { projectTaskListSnapshots } from "../../src/augments/task-list-augments.js";
import {
  sliceAtCompactBoundaries,
  sliceAfterMessageIdWithMatch,
  isUserTurn,
} from "../../src/sessions/pagination.js";
let dir: string,
  file: string,
  db: ReturnType<typeof openDiscoveryDatabase>,
  cache: ClaudeTranscriptCache,
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
  dir = await mkdtemp(join(tmpdir(), "ya-claude-writer-"));
  file = join(dir, "session.jsonl");
  seq = 0;
  db = openDiscoveryDatabase({
    dataDir: join(dir, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  cache = createClaudeTranscriptCache(db);
});
afterEach(async () => {
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
  const messages = projectTaskListSnapshots(
    normalizeSession(
      {
        summary,
        transcriptSnapshotUpdatedAt: "",
        data: { provider: "claude", session: { messages: full.entries } },
      },
      { rewindRecords: records },
    ).messages,
  );
  const selected = (await indexed.sourceIndex!.window(file, {
    compactions: 2,
    generation: indexed.sourceGeneration!,
    afterMessageId: after,
    beforeMessageId: before,
    rewindRecords: records,
    fence: indexed.appendFence,
  }))!;
  expect(selected).not.toBeNull();
  expect(selected.totals.messages).toBe(messages.length);
  expect(selected.totals.userTurns).toBe(
    messages.filter(
      (m) => isUserTurn(m) && typeof m.rewoundGroupId !== "string",
    ).length,
  );
  const expected = after
    ? sliceAfterMessageIdWithMatch(messages, after).messages
    : sliceAtCompactBoundaries(messages, 2, before).messages;
  const actual = after
    ? sliceAfterMessageIdWithMatch(selected.messages, after).messages
    : sliceAtCompactBoundaries(selected.messages, 2).messages;
  expect(actual).toEqual(expected);
  return { indexed, selected };
}
function guard(index: DurableClaudeSourceIndex) {
  return vi.spyOn(index.store, "materialize").mockImplementation(() => {
    throw Error("Historical metadata restoration forbidden");
  });
}
it("keeps initial, restarted and active committed reads SQL-owned without a historical graph", async () => {
  const rows: unknown[] = [
    user("u", null),
    answer("huge", "u", [{ type: "text", text: "x".repeat(3 * 1024 ** 2) }]),
  ];
  let parent = "huge";
  for (let n = 0; n < 100; n++) {
    const id = `a${n}`;
    rows.push(answer(id, parent));
    parent = id;
    if (n % 25 === 0) {
      const c = `c${n}`;
      rows.push(compact(c, parent));
      parent = c;
    }
  }
  await writeFile(file, jsonl(rows));
  let read = await parity();
  expect(read.indexed.sourceIndex).toBeInstanceOf(DurableClaudeSourceIndex);
  expect(read.indexed.entries).toEqual([]);
  await restart();
  read = await parity();
  const trap = guard(read.indexed.sourceIndex as DurableClaudeSourceIndex);
  for (let n = 0; n < 4; n++) {
    const next = `new${n}`;
    await appendFile(file, jsonl([answer(next, parent)]));
    await parity(parent);
    parent = next;
    expect(cache.getStats().retainedSourceBytes).toBeLessThan(100000);
  }
  await appendFile(
    file,
    jsonl([
      compact("last-compact", parent),
      user("last-user", "last-compact"),
      answer("last-answer", "last-user"),
    ]),
  );
  await parity(parent);
  await parity(undefined, "last-compact");
  expect(trap).not.toHaveBeenCalled();
});
it("resumes pending task inputs across restart and snapshots from omitted history", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("create", "u", [
        {
          type: "tool_use",
          id: "create-task",
          name: "TaskCreate",
          input: { subject: "first" },
        },
      ]),
      compact("c1", "create"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
    ]),
  );
  await parity();
  await restart();
  const read = await parity();
  const trap = guard(read.indexed.sourceIndex as DurableClaudeSourceIndex);
  await appendFile(
    file,
    jsonl([
      row("user", "result", "a3", {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-task",
              content: "Task #1 created successfully: first",
            },
          ],
        },
      }),
    ]),
  );
  await parity("a3");
  await parity("u");
  await restart();
  const current = await parity();
  const trap2 = guard(current.indexed.sourceIndex as DurableClaudeSourceIndex);
  await appendFile(
    file,
    jsonl([
      answer("update", "result", [
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
  await parity("result");
  expect(trap).not.toHaveBeenCalled();
  expect(trap2).not.toHaveBeenCalled();
});
it("replays and retracts provisional rows without retaining or materializing history", async () => {
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
  const first = await parity();
  const trap = guard(first.indexed.sourceIndex as DurableClaudeSourceIndex);
  const pending = JSON.stringify(answer("provisional", "a3"));
  await appendFile(file, pending);
  await parity("a3");
  const q = db.prepare(
    "SELECT header FROM claude_transcript_sources WHERE path=?",
  );
  const checkpoint = JSON.parse(q.get<{ header: string }>(file)!.header);
  q.finalize();
  expect(checkpoint.committedEntries).toBe(8);
  await restart();
  const next = await parity("a3");
  const trap2 = guard(next.indexed.sourceIndex as DurableClaudeSourceIndex);
  await appendFile(file, " invalid\n");
  await parity("a3");
  const committed = answer("committed", "a3");
  const chunk = JSON.stringify(user("fresh", "committed", "hé 🦊"));
  await appendFile(file, jsonl([committed]) + chunk);
  await parity("a3");
  await appendFile(file, "\n");
  await parity("committed");
  expect(trap).not.toHaveBeenCalled();
  expect(trap2).not.toHaveBeenCalled();
  expect(cache.getStats().retainedSourceBytes).toBeLessThan(100000);
});
it("delivers a recently persisted queue with global cursor positions across restart", async () => {
  await writeFile(
    file,
    jsonl([
      user("u", null),
      answer("a", "u"),
      compact("c1", "a"),
      user("u2", "c1"),
      answer("a2", "u2"),
      compact("c2", "a2"),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, seq++)).toISOString(),
        content: "queued prompt",
      },
      user("active", "c2"),
      answer("answer", "active"),
    ]),
  );
  await parity();
  await restart();
  const first = await parity();
  const trap = guard(first.indexed.sourceIndex as DurableClaudeSourceIndex);
  const removal = JSON.stringify({
    type: "queue-operation",
    operation: "remove",
    timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, seq++)).toISOString(),
  });
  await appendFile(file, removal);
  await parity("answer");
  await appendFile(file, "\n");
  await parity("answer");
  expect(trap).not.toHaveBeenCalled();
});

it("closes deferred rewind bounds before resuming incremental SQL state", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      user("u2", "a1"),
      answer("a2", "u2"),
    ]),
  );
  const record: SessionRewindRecord = {
    id: "deferred",
    at: "2026-11-10T00:05:00Z",
    cutMessageId: "a1",
    cutTurnIndex: 1,
    droppedThroughMessageId: "ending",
    droppedTurnCount: 2,
    reason: "clear",
  };
  await parity(undefined, undefined, [record]);
  await appendFile(file, jsonl([answer("ending", "a2")]));
  await parity(undefined, undefined, [record]);
  await appendFile(file, jsonl([user("new", "a1")]));
  await parity(undefined, undefined, [record]);
  await restart();
  const current = await parity(undefined, undefined, [record]);
  const trap = guard(current.indexed.sourceIndex as DurableClaudeSourceIndex);
  await appendFile(
    file,
    jsonl([
      answer("new-answer", "new"),
      compact("new-compact", "new-answer"),
      user("last", "new-compact"),
    ]),
  );
  await parity("new", undefined, [record]);
  expect(trap).not.toHaveBeenCalled();
});

it("publishes complete writer facts after a provisional branch falls back and retracts", async () => {
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
  const create = answer("create", "a3", [
    {
      type: "tool_use",
      id: "task",
      name: "TaskCreate",
      input: { subject: "durable" },
    },
  ]);
  const branch = JSON.stringify(answer("branch", "a"));
  await appendFile(file, jsonl([create]) + branch);
  await parity();
  await appendFile(file, " invalid\n");
  await parity();
  const index = (await cache.loadIndexed(file))!
    .sourceIndex as DurableClaudeSourceIndex;
  expect(index).toBeInstanceOf(DurableClaudeSourceIndex);
  const trap = guard(index);
  await appendFile(
    file,
    jsonl([
      row("user", "result", "create", {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "task",
              content: "Task #1 created successfully: durable",
            },
          ],
        },
      }),
    ]),
  );
  await parity("a3");
  expect(trap).not.toHaveBeenCalled();
});
it("preserves a provisional row when rewind context changes without a source write", async () => {
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
  await appendFile(file, JSON.stringify(answer("pending", "a3")));
  await parity();
  const record: SessionRewindRecord = {
    id: "change-view",
    at: "2026-11-10T00:05:00Z",
    cutMessageId: "a",
    cutTurnIndex: 1,
    droppedThroughMessageId: "pending",
    droppedTurnCount: 3,
    reason: "clear",
  };
  await parity(undefined, undefined, [record]);
  await appendFile(file, "\n");
  expect((await cache.peek(file))!.sourceIndex).toBeInstanceOf(
    DurableClaudeSourceIndex,
  );
  await parity(undefined, undefined, [record]);
  expect((await cache.loadIndexed(file, [record]))!.sourceIndex).toBeInstanceOf(
    DurableClaudeSourceIndex,
  );
});

it("seeks compaction ordinals without scanning historical visible rows", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      compact("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
    ]),
  );
  await cache.loadIndexed(file);
  const prepare = db.prepare.bind(db);
  const plans: string[] = [];
  vi.spyOn(db, "prepare").mockImplementation((query) => {
    if (
      query.startsWith("SELECT position,compact_ordinal,record") &&
      query.endsWith("compact_ordinal=?")
    ) {
      const explain = prepare(`EXPLAIN QUERY PLAN ${query}`);
      try {
        plans.push(
          ...explain
            .all<{ detail: string }>("generation", 1)
            .map((row) => row.detail),
        );
      } finally {
        explain.finalize();
      }
    }
    return prepare(query);
  });
  await parity();
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).toMatch(/compact_ordinal=\?/);
});
