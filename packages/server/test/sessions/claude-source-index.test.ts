import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as framing from "../../src/sessions/transcript-ingestion.js";
import * as fsPromises from "node:fs/promises";
import { SessionReader } from "../../src/sessions/reader.js";
import { claudeTranscriptCache } from "../../src/sessions/claude-transcript-cache.js";
import { ClaudeProjectionChangedError } from "../../src/sessions/claude-source-index.js";
import type { SessionRewindRecord, UrlProjectId } from "@yep-anywhere/shared";
import { ClaudeTranscriptCache } from "../../src/sessions/claude-transcript-cache.js";
import { buildSummaryFromState } from "../../src/sessions/claude-summary.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import {
  sliceAtCompactBoundaries,
  sliceAfterMessageIdWithMatch,
} from "../../src/sessions/pagination.js";
import { projectTaskListSnapshots } from "../../src/augments/task-list-augments.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
let dir: string, file: string, seq: number;
let cache: ClaudeTranscriptCache;
const projectId = "project" as UrlProjectId;
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
function user(uuid: string, parent: string | null, text = uuid) {
  return row("user", uuid, parent, {
    message: { role: "user", content: text },
  });
}
function answer(
  uuid: string,
  parent: string,
  content: unknown = [{ type: "text", text: uuid }],
) {
  return row("assistant", uuid, parent, {
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content,
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  });
}
function boundary(uuid: string, parent: string) {
  return row("system", uuid, null, {
    subtype: "compact_boundary",
    logicalParentUuid: parent,
    content: "Conversation compacted",
    compactMetadata: { preTokens: 150 },
  });
}
const jsonl = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ya-claude-index-"));
  file = join(dir, "session.jsonl");
  seq = 0;
  cache = new ClaudeTranscriptCache({ maxSourceBytes: 2 * 1024 ** 2 });
});
afterEach(async () => {
  cache.invalidate();
  claudeTranscriptCache.invalidate();
  vi.restoreAllMocks();
  vi.mocked(fsPromises.open).mockImplementation(
    (await vi.importActual<typeof fsPromises>("node:fs/promises")).open,
  );
  await rm(dir, { recursive: true, force: true });
});
async function parity(
  after?: string,
  before?: string,
  records: SessionRewindRecord[] = [],
) {
  const indexed = await cache.loadIndexed(file);
  expect(indexed?.sourceIndex).toBeDefined();
  const full = await new ClaudeTranscriptCache({ maxSourceBytes: 0 }).load(
    file,
  );
  const options = {
    filePath: file,
    stats: full!.stats,
    sessionId: "session",
    projectId,
  };
  const expectedSummary = buildSummaryFromState(full!.summaryState, options)!;
  expect(buildSummaryFromState(indexed!.summaryState, options)).toEqual(
    expectedSummary,
  );
  const manual = { ...options, includeCompactionSafetyMargin: true };
  expect(buildSummaryFromState(indexed!.summaryState, manual)).toEqual(
    buildSummaryFromState(full!.summaryState, manual),
  );
  const visible = projectTaskListSnapshots(
    normalizeSession(
      {
        summary: expectedSummary,
        transcriptSnapshotUpdatedAt: "",
        data: { provider: "claude", session: { messages: full!.entries } },
      },
      { rewindRecords: records },
    ).messages,
  );
  const projected = await indexed!.sourceIndex!.window(file, {
    compactions: 2,
    generation: indexed!.sourceGeneration!,
    afterMessageId: after,
    beforeMessageId: before,
    rewindRecords: records,
    maxBytes: cache.budgetBytes(),
    fence: indexed!.appendFence,
  });
  expect(projected).not.toBeNull();
  let actual = projected!.messages;
  let expected = visible;
  if (after) {
    actual = sliceAfterMessageIdWithMatch(actual, after).messages;
    expected = sliceAfterMessageIdWithMatch(expected, after).messages;
  } else {
    actual = sliceAtCompactBoundaries(actual, 2).messages;
    expected = sliceAtCompactBoundaries(expected, 2, before).messages;
  }
  expect(actual).toEqual(expected);
  return { indexed: indexed!, actual, visible };
}
it("keeps payload bounded above the source budget and extends recent and old cursor windows", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1", [{ type: "text", text: "x".repeat(3 * 1024 ** 2) }]),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
      boundary("c3", "a3"),
      user("u4", "c3"),
      answer("a4", "u4"),
    ]),
  );
  const first = await parity();
  expect(first.actual[0]?.uuid).toBe("c2");
  expect(cache.getStats().retainedFiles).toBe(1);
  expect(cache.getStats().retainedSourceBytes).toBeLessThan(100_000);
  await appendFile(file, jsonl([user("u5", "a4"), answer("a5", "u5")]));
  await parity("a4");
  await parity("a2");
  await parity(undefined, "c3");
  const current = await cache.loadIndexed(file);
  expect(
    await current!.sourceIndex!.window(file, {
      compactions: 2,
      generation: current!.sourceGeneration!,
      afterMessageId: undefined,
      beforeMessageId: "c2",
      rewindRecords: [],
      maxBytes: cache.budgetBytes(),
      fence: current!.appendFence,
    }),
  ).toBeNull();
});
it("matches branch changes, dead tool work, connectors, progress and timestamp-tied tips", async () => {
  const rows = [
    user("u1", null),
    answer("a1", "u1"),
    boundary("c1", "a1"),
    user("u2", "c1"),
    answer("call", "u2", [
      {
        type: "tool_use",
        id: "tool",
        name: "Bash",
        input: { command: "echo hi" },
      },
    ]),
    answer("other", "u2"),
    boundary("c2", "other"),
    user("u3", "c2"),
    answer("a3", "u3"),
  ];
  await writeFile(file, jsonl(rows));
  await parity();
  await appendFile(
    file,
    jsonl([
      row("user", "result", "a3", {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool", content: "done" },
          ],
        },
      }),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([
      row("system", "connector", "u2", {
        subtype: "api_error",
        content: "retry",
      }),
      user("retry", "connector"),
      answer("retry-answer", "retry"),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([
      row("progress", "progress", "retry-answer"),
      user("after-progress", "progress"),
      answer("tie", "after-progress", [{ type: "text", text: "tie" }]),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([user("rewind", "u1"), answer("rewind-answer", "rewind")]),
  );
  await parity();
});
it("preserves queue IDs, late delivery and full turn ordinals", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, seq++)).toISOString(),
        content: "queued prompt",
      },
      user("u3", "c2"),
      answer("a3", "u3"),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, seq++)).toISOString(),
      },
    ]),
  );
  await parity();
  await parity("u3");
  await parity("a3");
});
it("seeds task snapshots from omitted history and preserves provisional replay", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("create", "u1", [
        {
          type: "tool_use",
          id: "create",
          name: "TaskCreate",
          input: { subject: "Old task", description: "Remember this" },
        },
      ]),
      row("user", "created", "create", {
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "create",
              content: "Task #1 created successfully: Old task",
            },
          ],
        },
      }),
      boundary("c1", "created"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
      user("u3", "c2"),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([
      answer("update", "u3", [
        {
          type: "tool_use",
          id: "update",
          name: "TaskUpdate",
          input: { taskId: "1", status: "completed" },
        },
      ]),
    ]),
  );
  await parity();
  const result = row("user", "updated", "update", {
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "update",
          content: "Updated task #1 status",
        },
      ],
    },
  });
  await appendFile(file, JSON.stringify(result));
  await parity();
  await appendFile(file, "not-json\n");
  await parity();
  await appendFile(file, jsonl([result]));
  await parity();
});

it("projects recorded rewinds, nested groups and boundaries inside a dropped group", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
      user("u3", "c2"),
      answer("a3", "u3"),
      boundary("c3", "a3"),
      user("u4", "c3"),
      answer("a4", "u4"),
    ]),
  );
  const record: SessionRewindRecord = {
    id: "clear",
    at: new Date(Date.UTC(2026, 10, 10, 0, 1)).toISOString(),
    cutMessageId: "a1",
    cutTurnIndex: 1,
    droppedThroughMessageId: "a4",
    droppedTurnCount: 3,
    reason: "clear",
  };
  await parity(undefined, undefined, [record]);
  await appendFile(file, jsonl([user("u5", "a1"), answer("a5", "u5")]));
  await parity(undefined, undefined, [record]);
  await parity("a1", undefined, [record]);
  await parity(undefined, "c3", [record]);
});

it("extends linear rows and newly queued delivery without walking historical metadata", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
    ]),
  );
  const snapshot = await cache.loadIndexed(file),
    index = snapshot!.sourceIndex!;
  const rowsIterator = index.rows[Symbol.iterator];
  index.rows[Symbol.iterator] = () => {
    throw new Error("historical metadata walked");
  };
  const values = index.summaryState.nodeMap.values;
  index.summaryState.nodeMap.values = () => {
    throw new Error("historical summary walked");
  };
  try {
    await appendFile(
      file,
      jsonl([
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "queued",
          timestamp: new Date(
            Date.UTC(2026, 10, 10, 0, 0, seq++),
          ).toISOString(),
        },
        user("u3", "c2"),
        answer("a3", "u3"),
        {
          type: "queue-operation",
          operation: "remove",
          timestamp: new Date(
            Date.UTC(2026, 10, 10, 0, 0, seq++),
          ).toISOString(),
        },
      ]),
    );
    const updated = await cache.loadIndexed(file);
    const projected = await updated!.sourceIndex!.window(file, {
      compactions: 2,
      generation: updated!.sourceGeneration!,
      afterMessageId: "u3",
      beforeMessageId: undefined,
      rewindRecords: [],
      maxBytes: cache.budgetBytes(),
      fence: updated!.appendFence,
    });
    expect(projected!.messages.some((m) => m.deferred)).toBe(true);
  } finally {
    index.rows[Symbol.iterator] = rowsIterator;
    index.summaryState.nodeMap.values = values;
  }
  await parity();
  await parity("u3");
});
it("keeps full-source harness extraction slots and eligibility while omitting unrelated payloads", async () => {
  const native = "11111111-1111-4111-8111-111111111111",
    target = "22222222-2222-4222-8222-222222222222";
  const command = `cd /test/project && claude --session-id ${target} --print go`;
  const rows = [
    user("u1", null),
    answer("launch", "u1", [
      "ignored string",
      { type: "tool_use", id: "launch", name: "Bash", input: { command } },
    ]),
    row("user", "done", "launch", {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "launch",
            content: "a large irrelevant result",
          },
        ],
      },
    }),
    answer("failed", "done", [
      { type: "tool_use", id: "failed", name: "Bash", input: { command } },
    ]),
    row("user", "failure", "failed", {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "failed",
            is_error: true,
            content: "failure",
          },
        ],
      },
    }),
  ].map((r) => ({ ...r, sessionId: native }));
  await writeFile(file, jsonl(rows));
  const indexed = await cache.loadIndexed(file);
  const { collectHarnessHistory, emptyHarnessHistory } = await import(
    "../../src/sessions/claude-harness-history.js"
  );
  const run = (
    input: readonly import("@yep-anywhere/shared").ClaudeSessionEntry[],
  ) => {
    const { hints, state } = collectHarnessHistory(
      input,
      emptyHarnessHistory(),
      native,
      "2026-11-09T00:00:00Z",
      32,
      input.length,
    );
    return {
      entry: state.entry,
      block: state.block,
      hints: hints.map(({ harvestedAt: _, ...hint }) => hint),
    };
  };
  expect(run(indexed!.entries)).toEqual(
    run(rows as unknown as import("@yep-anywhere/shared").ClaudeSessionEntry[]),
  );
  expect(run(indexed!.entries).hints).toHaveLength(1);
});

it("retains positive usage before zero-token rows and compaction for the safety margin", async () => {
  const zero = answer("zero", "a1");
  ((zero as Record<string, unknown>).message as Record<string, unknown>).usage =
    {
      input_tokens: 0,
      output_tokens: 1,
    };
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      zero,
      boundary("c1", "zero"),
      user("u2", "c1"),
      answer("a2", "u2"),
    ]),
  );
  await parity();
  await appendFile(file, jsonl([user("u3", "a2"), answer("a3", "u3")]));
  await parity();
});

it("serves the requested Claude window without retaining hidden payload in the production reader", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1", [{ type: "text", text: "large".repeat(650_000) }]),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
      user("u3", "c2"),
    ]),
  );
  claudeTranscriptCache.invalidate();
  const loaded = await new SessionReader({ sessionDir: dir }).getSession(
    "session",
    projectId,
    undefined,
    { tailCompactions: 2 },
  );
  expect(loaded).not.toBeNull();
  expect(claudeTranscriptCache.getStats().retainedSourceBytes).toBeLessThan(
    100_000,
  );
  expect(normalizeSession(loaded!).messages[0]?.uuid).toBe("c1");
});
it.each([true, false])(
  "coalesces mixed full/indexed callers without returning the wrong representation (index first %s)",
  async (indexFirst) => {
    await writeFile(file, jsonl([user("u1", null), answer("a1", "u1")]));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const original = framing.readTranscriptFile;
    let held = false;
    vi.spyOn(framing, "readTranscriptFile").mockImplementation(
      async (...args) => {
        if (!held) {
          held = true;
          enter();
          await gate;
        }
        return original(...args);
      },
    );
    const first = indexFirst ? cache.loadIndexed(file) : cache.load(file);
    await entered;
    const second = indexFirst ? cache.load(file) : cache.loadIndexed(file);
    release();
    const [a, b] = await Promise.all([first, second]);
    const full = indexFirst ? b : a,
      indexed = indexFirst ? a : b;
    expect(full?.sourceIndex).toBeUndefined();
    expect(indexed?.sourceIndex).toBeDefined();
    expect(
      (full!.entries[0] as { message?: { content?: unknown } }).message
        ?.content,
    ).toBe("u1");
  },
);
it("rejects a hydration snapshot whose shared projection changed while acquiring its descriptor", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
    ]),
  );
  const snapshot = await cache.loadIndexed(file);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const original = (
    await vi.importActual<typeof fsPromises>("node:fs/promises")
  ).open;
  let held = false;
  vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
    if (!held) {
      held = true;
      enter();
      await gate;
    }
    return original(...args);
  });
  const hydration = snapshot!.sourceIndex!.window(file, {
    compactions: 2,
    generation: snapshot!.sourceGeneration!,
    afterMessageId: undefined,
    beforeMessageId: undefined,
    rewindRecords: [],
    maxBytes: cache.budgetBytes(),
    fence: snapshot!.appendFence,
  });
  const observed = hydration.catch((error) => error);
  await entered;
  await appendFile(file, jsonl([user("u3", "c2"), answer("a3", "u3")]));
  await cache.loadIndexed(file);
  release();
  expect(await observed).toBeInstanceOf(ClaudeProjectionChangedError);
  await parity();
});

it("does not retain an oversized valid provisional payload after a summary refresh", async () => {
  await writeFile(file, jsonl([user("u1", null), answer("a1", "u1")]));
  await cache.loadIndexed(file);
  await appendFile(
    file,
    JSON.stringify(
      answer("large", "a1", [
        { type: "text", text: "payload".repeat(400_000) },
      ]),
    ),
  );
  const snapshot = await cache.peek(file);
  expect(snapshot).not.toBeNull();
  expect(cache.getStats().retainedFiles).toBe(0);
  expect(cache.getStats().retainedSourceBytes).toBe(0);
});

it("rejects a source snapshot superseded before window selection begins", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
    ]),
  );
  const old = await cache.loadIndexed(file);
  await appendFile(file, jsonl([user("u3", "c2"), answer("a3", "u3")]));
  await cache.loadIndexed(file);
  await expect(
    old!.sourceIndex!.window(file, {
      compactions: 2,
      generation: old!.sourceGeneration!,
      fence: old!.appendFence,
      maxBytes: cache.budgetBytes(),
    }),
  ).rejects.toBeInstanceOf(ClaudeProjectionChangedError);
  await parity();
});

it("skips null JSONL rows identically during initial, appended and provisional reads", async () => {
  await writeFile(
    file,
    jsonl([
      null,
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      null,
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
    ]),
  );
  await parity();
  await appendFile(
    file,
    jsonl([null, user("u3", "c2"), answer("a3", "u3")]) + "null",
  );
  await parity();
  await appendFile(file, "\n");
  await parity("a2");
});
it("keeps selected totals fixed when an append arrives during descriptor closure", async () => {
  await writeFile(
    file,
    jsonl([
      user("u1", null),
      answer("a1", "u1"),
      boundary("c1", "a1"),
      user("u2", "c1"),
      answer("a2", "u2"),
      boundary("c2", "a2"),
    ]),
  );
  const old = await cache.loadIndexed(file);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const original = (
    await vi.importActual<typeof fsPromises>("node:fs/promises")
  ).open;
  let held = false;
  vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (!held) {
      held = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        enter();
        await gate;
        return close();
      });
    }
    return handle;
  });
  const hydration = old!.sourceIndex!.window(file, {
    compactions: 2,
    generation: old!.sourceGeneration!,
    fence: old!.appendFence,
    maxBytes: cache.budgetBytes(),
  });
  await entered;
  await appendFile(file, jsonl([user("u3", "c2"), answer("a3", "u3")]));
  await cache.loadIndexed(file);
  release();
  const projected = await hydration;
  expect(projected!.totals).toEqual({
    messages: 6,
    compactions: 2,
    userTurns: 2,
  });
  expect(projected!.messages.at(-1)?.uuid).toBe("c2");
});
it("honors a zero cache budget without an extra indexed acquisition", async () => {
  await writeFile(file, jsonl([user("u1", null), answer("a1", "u1")]));
  const disabled = new ClaudeTranscriptCache({ maxSourceBytes: 0 });
  const reads = vi.spyOn(framing, "readTranscriptFile");
  expect(await disabled.loadIndexed(file)).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  const full = await disabled.load(file);
  expect(full?.entries).toHaveLength(2);
  expect(disabled.getStats().retainedFiles).toBe(0);
});
