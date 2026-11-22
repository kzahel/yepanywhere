import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravityLogLines,
  projectAntigravityLog,
} from "../../src/sessions/antigravity-log-projection.js";
import {
  type AntigravityLogWindowOptions,
  antigravityMessageStep,
  readAntigravityLogWindow,
} from "../../src/sessions/antigravity-log-window.js";
import type { Message } from "../../src/supervisor/types.js";
import {
  type AntigravityScaleOptions,
  writeAntigravityScaleConversation,
} from "../utils/antigravity-scale-log.js";

const ID = "c0ffee00-0000-4000-8000-000000000196";
let root: string;
let store: string;
let scope: string;
let logPath: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ya-agy-window-")));
  store = join(root, "antigravity-cli");
  scope = join(store, "conversations");
  logPath = join(
    store,
    "brain",
    ID,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = (
  options: Pick<AntigravityScaleOptions, "steps" | "targetBytes"> &
    Partial<AntigravityScaleOptions>,
) =>
  writeAntigravityScaleConversation({
    store,
    id: ID,
    cwd: root,
    checkpointEvery: 150,
    skipEvery: 170,
    interruptedGroupEvery: 90,
    interiorGapGroupEvery: 70,
    shortLog: false,
    summaries: false,
    ...options,
  });

async function whole(path = logPath): Promise<Message[]> {
  const result = await projectAntigravityLog(
    antigravityLogLines(createReadStream(path)),
    { conversationId: ID, ownerLive: false },
  );
  if (result.status !== "known") throw Error(result.reason);
  return result.messages;
}

const read = (
  request: AntigravityLogWindowOptions["request"],
  options: Partial<AntigravityLogWindowOptions> = {},
) =>
  readAntigravityLogWindow({
    scope,
    conversationId: ID,
    ownerLive: false,
    request,
    ...options,
  });

async function known(
  request: AntigravityLogWindowOptions["request"],
  options: Partial<AntigravityLogWindowOptions> = {},
) {
  const window = await read(request, options);
  if (window.status !== "known")
    throw Error(`${window.status}: ${"reason" in window ? window.reason : ""}`);
  return window;
}

const ids = (messages: readonly Message[]) => messages.map((m) => m.uuid);

describe("Antigravity log windows", () => {
  it("pages backward to the start, giving exactly one forward projection", async () => {
    const scale = await write({ steps: 900, targetBytes: 600_000 });
    expect(scale.interruptedGroups.map((group) => group.shape)).toEqual(
      expect.arrayContaining(["suffix", "interior"]),
    );
    const all = await whole();
    // Every window names the conversation's first prompt, read from the head.
    const firstPrompt = all.find((m) => m.type === "user")?.message?.content;
    expect(firstPrompt).toMatch(/^TURN_1_PROMPT STEP_0 /);
    expect((await known({ kind: "complete" })).firstPrompt).toBe(firstPrompt);
    expect(
      (await known({ kind: "latest", compactions: 1 }, { pageBytes: 4096 }))
        .firstPrompt,
    ).toBe(firstPrompt);
    for (const [pageBytes, compactions] of [
      [16 * 1024, 2],
      [1024 * 1024, 1],
      [700, 2],
    ] as const) {
      const pages: Message[][] = [];
      let window = await known({ kind: "latest", compactions }, { pageBytes });
      pages.unshift(window.messages);
      while (window.omittedPrefix) {
        const first = window.messages[0]!;
        // A page starts at a record that is not a tool result.
        expect(first.uuid).not.toMatch(/:result$/);
        window = await known(
          { kind: "before", messageId: first.uuid!, compactions },
          { pageBytes },
        );
        expect(window.anchor).toBe("found");
        expect(window.messages.length).toBeGreaterThan(0);
        pages.unshift(window.messages);
      }
      // Each page holds every result's call: no page renders a result alone.
      for (const page of pages) {
        const calls = new Set(
          page.flatMap((m) =>
            Array.isArray(m.message?.content)
              ? m.message.content.flatMap((b) =>
                  b.type === "tool_use" ? [b.id] : [],
                )
              : [],
          ),
        );
        for (const m of page)
          if (Array.isArray(m.message?.content))
            for (const block of m.message.content)
              if (block.type === "tool_result")
                expect(calls.has(block.tool_use_id)).toBe(true);
      }
      expect(pages.flat()).toEqual(all);
      if (pageBytes === 700) expect(pages.length).toBeGreaterThan(100);
    }
  });

  it("resolves every message ID it emits as a page boundary and as an incremental anchor", async () => {
    await write({ steps: 260, targetBytes: 90_000, seed: 7 });
    const all = await whole();
    expect(ids(all).some((id) => id?.endsWith(":result"))).toBe(true);
    for (const [index, message] of all.entries()) {
      const id = message.uuid!;
      expect(antigravityMessageStep(ID, id)).toBeTypeOf("number");
      const before = await known(
        { kind: "before", messageId: id, compactions: 1 },
        { pageBytes: 2048 },
      );
      expect(before.anchor).toBe("found");
      expect(before.messages).toEqual(
        all.slice(index - before.messages.length, index),
      );
      const after = await known(
        { kind: "after", messageId: id, compactions: 1 },
        { pageBytes: 1024 * 1024 },
      );
      expect(after.anchor).toBe("found");
      const at = ids(after.messages).indexOf(id);
      expect(after.messages.slice(at + 1)).toEqual(all.slice(index + 1));
    }
  });

  it("misses a stale or foreign ID cleanly instead of anchoring elsewhere", async () => {
    await write({ steps: 120, targetBytes: 40_000 });
    const latest = await known({ kind: "latest", compactions: 2 });
    for (const stale of [
      `${ID}:12`,
      "8f1c2b3a-0000-4000-8000-000000000001:call",
      `${ID}:step-1:tool-0:call:extra`,
      `${ID}:step-99999`,
      `00000000-0000-4000-8000-000000000000:step-1`,
    ]) {
      const before = await known({
        kind: "before",
        messageId: stale,
        compactions: 2,
      });
      expect([before.anchor, before.messages, before.omittedPrefix]).toEqual([
        "missed",
        [],
        false,
      ]);
      const after = await known({
        kind: "after",
        messageId: stale,
        compactions: 2,
      });
      expect(after.anchor).toBe("missed");
      expect(after.messages).toEqual(latest.messages);
    }
  });

  it("reads afresh when the file is replaced or truncated during a read", async () => {
    await write({ steps: 200, targetBytes: 80_000 });
    const original = await readFile(logPath);
    const replacement = join(root, "replacement.jsonl");
    const newer = await write({ steps: 120, targetBytes: 50_000, seed: 3 });
    const fresh = await whole();
    await rename(newer.fullPath, replacement);
    await writeFile(logPath, original);

    // Replaced: the first attempt's answer describes a file that is gone.
    let attempts = 0;
    const replaced = await known(
      { kind: "latest", compactions: 9 },
      {
        pageBytes: 1024 * 1024,
        afterRead: async (attempt) => {
          attempts = attempt;
          if (attempt === 1) await rename(replacement, logPath);
        },
      },
    );
    expect(attempts).toBe(2);
    expect(replaced.messages).toEqual(fresh);

    // Truncated, then appended to its old size: the boundary check fails.
    await writeFile(logPath, original);
    const cut = original.lastIndexOf(10, original.length / 2) + 1;
    await writeFile(join(root, "cut.jsonl"), original.subarray(0, cut));
    const truncatedAll = await whole(join(root, "cut.jsonl"));
    const truncated = await known(
      { kind: "latest", compactions: 9 },
      {
        pageBytes: 1024 * 1024,
        afterRead: async (attempt) => {
          if (attempt === 1) await truncate(logPath, cut);
        },
      },
    );
    expect(truncated.messages).toEqual(truncatedAll);

    // Rewritten on every attempt: unknown, never a mix of two files.
    const always = await read(
      { kind: "latest", compactions: 2 },
      {
        afterRead: async () => {
          const copy = join(root, "copy.jsonl");
          await writeFile(copy, original);
          await rename(copy, logPath);
        },
      },
    );
    expect(always.status).toBe("unknown");
  });

  it("treats a spent budget as an unknown log, never as the end of the log", async () => {
    const at = "2026-11-22T08:00:00Z";
    const big = "x".repeat(20_000);
    const lines = [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: at,
        content: "<USER_REQUEST>\nhi\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at,
        tool_calls: [0, 1, 2].map(() => ({ name: "read_file", args: {} })),
      },
      ...[2, 3, 4].map((step) => ({
        step_index: step,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: at,
        content: big,
      })),
    ];
    await mkdir(join(logPath, ".."), { recursive: true });
    await writeFile(
      logPath,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    const latest = await read(
      { kind: "latest", compactions: 2 },
      { pageBytes: 1024, readBudget: 40_000 },
    );
    expect(latest).toMatchObject({ status: "unknown" });
    // The lookahead for the page before the last result is budgeted too.
    const before = await read(
      {
        kind: "before",
        messageId: `${ID}:step-1:tool-1:result`,
        compactions: 2,
      },
      { readBudget: 30_000 },
    );
    expect(before).toMatchObject({ status: "unknown" });
    const enough = await known(
      {
        kind: "before",
        messageId: `${ID}:step-1:tool-1:result`,
        compactions: 2,
      },
      { readBudget: 200_000 },
    );
    expect(enough.messages.some((m) => m.orphanedToolUseIds)).toBe(false);
  });

  it("reports a missing log, and one with no complete record, as missing", async () => {
    expect((await read({ kind: "latest", compactions: 2 })).status).toBe(
      "missing",
    );
    await mkdir(join(logPath, ".."), { recursive: true });
    await writeFile(logPath, '{"step_index":0,');
    expect((await read({ kind: "latest", compactions: 2 })).status).toBe(
      "missing",
    );
  });

  it("reads a bounded number of bytes for a page of the 500 MB scale target", async () => {
    const scale = await write({
      steps: 100_000,
      targetBytes: 500_000_000,
      checkpointEvery: 2000,
      skipEvery: 25_000,
      interruptedGroupEvery: 30_000,
      interiorGapGroupEvery: 40_000,
    });
    expect(scale.fullBytes).toBeGreaterThan(450_000_000);
    const latest = await known({ kind: "latest", compactions: 2 });
    expect(latest.omittedPrefix).toBe(true);
    expect(latest.messages.length).toBeGreaterThan(100);
    // The 4 MiB page, at most one more read chunk and the source checks.
    expect(latest.bytesRead).toBeLessThan(6 * 1024 * 1024);
    const older = await known({
      kind: "before",
      messageId: latest.messages[0]!.uuid!,
      compactions: 2,
    });
    expect(older.messages.length).toBeGreaterThan(100);
    // The search for the cursor adds a few probes of one record each.
    expect(older.bytesRead).toBeLessThan(8 * 1024 * 1024);
    // An ID its record does not have misses after one page's reads.
    const step = antigravityMessageStep(ID, latest.messages[0]!.uuid!);
    const absent = await known({
      kind: "before",
      messageId: `${ID}:step-${step}:tool-99:call`,
      compactions: 2,
    });
    expect([absent.anchor, absent.messages]).toEqual(["missed", []]);
    expect(absent.bytesRead).toBeLessThan(8 * 1024 * 1024);
    const caughtUp = await known({
      kind: "after",
      messageId: latest.messages.at(-1)!.uuid!,
      compactions: 2,
    });
    expect(caughtUp.anchor).toBe("found");
    expect(caughtUp.bytesRead).toBeLessThan(2 * 1024 * 1024);
  }, 60_000);
});
