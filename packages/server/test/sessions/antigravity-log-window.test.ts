import * as fs from "node:fs";
import { createReadStream } from "node:fs";
import {
  appendFile,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  const MiB = 1024 * 1024;
  const at = "2026-11-22T08:00:00Z";
  const head = (step: number, type: string, source: string) => ({
    step_index: step,
    source,
    type,
    status: "DONE",
    created_at: at,
  });
  const prompt = (step: number) => ({
    ...head(step, "USER_INPUT", "USER_EXPLICIT"),
    content: `<USER_REQUEST>\nPROMPT_${step}\n</USER_REQUEST>`,
  });
  const reply = (step: number, content: string, extra = {}) => ({
    ...head(step, "PLANNER_RESPONSE", "MODEL"),
    content,
    ...extra,
  });
  const reminder = (step: number, text: string) => ({
    ...head(step, "SYSTEM_MESSAGE", "SYSTEM"),
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n${text}\n</SYSTEM_MESSAGE>`,
  });
  const put = async (records: object[]) => {
    await mkdir(join(logPath, ".."), { recursive: true });
    await writeFile(
      logPath,
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
  };
  /** Every page from the latest back, each with its bytes read. */
  async function pageAll(pageBytes?: number) {
    const pages: Message[][] = [];
    const reads: number[] = [];
    let window = await known({ kind: "latest", compactions: 2 }, { pageBytes });
    for (;;) {
      pages.unshift(window.messages);
      reads.push(window.bytesRead);
      if (!window.omittedPrefix) break;
      window = await known(
        {
          kind: "before",
          messageId: window.messages[0]!.uuid!,
          compactions: 2,
        },
        { pageBytes },
      );
    }
    return { messages: pages.flat(), pages, reads };
  }
  const textOf = (messages: Message[]) =>
    messages.map((m) =>
      typeof m.message?.content === "string"
        ? m.message.content.slice(0, 40)
        : (m.uuid ?? ""),
    );

  it("shows a 12 MiB record on the page before a short reply", async () => {
    await put([
      prompt(0),
      reply(3, "EARLY"),
      reply(5, "z".repeat(12 * MiB)),
      reply(6, "LATE"),
    ]);
    const latest = await known({ kind: "latest", compactions: 2 });
    expect(textOf(latest.messages)).toEqual(["LATE"]);
    expect(latest.cut).toBe("bytes");
    // The real Load older cursor: the latest page's first message.
    const older = await known({
      kind: "before",
      messageId: latest.messages[0]!.uuid!,
      compactions: 2,
    });
    expect(older.messages.map((m) => m.uuid)).toEqual([`${ID}:step-5:text`]);
    expect(older.messages[0]!.message!.content).toHaveLength(12 * MiB);
    // The search crosses the record once, and showing it reads it once more.
    expect(older.bytesRead).toBeLessThan(28 * MiB);
    const all = await pageAll();
    expect(all.messages).toEqual(await whole());
    expect(textOf(all.messages)).toEqual([
      "PROMPT_0",
      "EARLY",
      "z".repeat(40),
      "LATE",
    ]);
  });

  it("pages from a cursor before a 24 MiB record, and shows that record as a placeholder", async () => {
    await put([
      prompt(0),
      reply(3, "EARLY"),
      reply(5, "z".repeat(24 * MiB)),
      reply(6, "LATE"),
    ]);
    const early = await known({
      kind: "before",
      messageId: `${ID}:step-3:text`,
      compactions: 2,
    });
    expect(textOf(early.messages)).toEqual(["PROMPT_0"]);
    expect(early.omittedPrefix).toBe(false);
    const all = await pageAll();
    expect(textOf(all.messages)).toEqual([
      "PROMPT_0",
      "EARLY",
      expect.stringMatching(/^This step is too large to show here/),
      "LATE",
    ]);
    // The complete read shows the same placeholder.
    expect(all.messages).toEqual((await known({ kind: "complete" })).messages);
  });

  it("reads the latest reply after a record larger than any budget, and pages past it", async () => {
    // Text that looks like a record's start must not confuse the search.
    const body = '{"step_index":27,'.repeat(2 * MiB);
    await put([prompt(0), reply(3, "EARLY"), reply(5, body), reply(6, "LATE")]);
    // A placeholder weighs little, so the page reaches past it.
    const latest = await known({ kind: "latest", compactions: 2 });
    expect(textOf(latest.messages).at(-1)).toBe("LATE");
    const all = await pageAll();
    expect(textOf(all.messages)).toEqual([
      "PROMPT_0",
      "EARLY",
      expect.stringMatching(/^This step is too large to show here/),
      "LATE",
    ]);
    expect(all.messages).toEqual((await known({ kind: "complete" })).messages);
    // A page that crosses the large record holds only a fixed part of it.
    expect(Math.max(...all.reads)).toBeLessThan(3 * body.length);
  });

  it("crosses a 35 MiB run of hidden reminders to the prompt before it", async () => {
    await put([
      prompt(0),
      ...Array.from({ length: 400 }, (_, i) =>
        reminder(i + 1, "X".repeat(90 * 1024)),
      ),
    ]);
    const latest = await known({ kind: "latest", compactions: 2 });
    expect(textOf(latest.messages)).toEqual(["PROMPT_0"]);
    expect(latest.omittedPrefix).toBe(false);
    // Each byte of the run is read about once, not once per extension.
    expect(latest.bytesRead).toBeLessThan(40 * MiB);
  });

  it("keeps a planner's error unless the next record reports it, across page boundaries", async () => {
    await put([
      prompt(0),
      reply(1, "PARTIAL", {
        status: "ERROR",
        error: "context canceled by user",
      }),
      {
        ...head(2, "ERROR_MESSAGE", "SYSTEM"),
        error: "API error (attempt 1): context canceled by user",
      },
      prompt(3),
      reply(4, "", { status: "ERROR", error: "quota refused" }),
      prompt(5),
      // A planner error, a tool group, then a different error: both stay.
      reply(6, "", {
        status: "ERROR",
        error: "Original error",
        tool_calls: [{ name: "read_file", args: {} }],
      }),
      { ...head(7, "GENERIC", "MODEL"), content: "result" },
      { ...head(8, "ERROR_MESSAGE", "SYSTEM"), error: "Different error" },
      prompt(9),
      reply(10, "", { status: "ERROR", error: "late cause" }),
    ]);
    const errors = (messages: Message[]) =>
      messages.filter((m) => m.type === "error").map((m) => [m.uuid, m.error]);
    const all = await whole();
    expect(errors(all)).toEqual([
      [`${ID}:step-2`, "API error (attempt 1): context canceled by user"],
      [`${ID}:step-4:error`, "quota refused"],
      [`${ID}:step-6:error`, "Original error"],
      [`${ID}:step-8`, "Different error"],
      [`${ID}:step-10:error`, "late cause"],
    ]);
    for (const pageBytes of [1, 200, 4096])
      expect((await pageAll(pageBytes)).messages).toEqual(all);
    // The repeating ERROR_MESSAGE lands after the old end of the file.
    const before = await known({ kind: "complete" });
    expect(errors(before.messages).at(-1)).toEqual([
      `${ID}:step-10:error`,
      "late cause",
    ]);
    await appendFile(
      logPath,
      `${JSON.stringify({ ...head(11, "ERROR_MESSAGE", "SYSTEM"), error: "API error: late cause" })}\n`,
    );
    const after = await whole();
    expect(errors(after).slice(-1)).toEqual([
      [`${ID}:step-11`, "API error: late cause"],
    ]);
    for (const pageBytes of [1, 4096])
      expect((await pageAll(pageBytes)).messages).toEqual(after);
  });

  it("retries a file truncated between opening it and taking its fence", async () => {
    await put([prompt(0), reply(1, "x".repeat(4096)), reply(2, "LAST")]);
    const keep = (await readFile(logPath)).indexOf(10) + 1;
    const open = fs.promises.open;
    let truncated = false;
    const spy = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (!truncated && String(args[0]).endsWith("transcript_full.jsonl")) {
          const stat = handle.stat.bind(handle);
          handle.stat = (async () => {
            const info = await stat();
            truncated = true;
            await truncate(logPath, keep);
            return info;
          }) as typeof handle.stat;
        }
        return handle;
      });
    try {
      const window = await known({ kind: "latest", compactions: 2 });
      expect(truncated).toBe(true);
      expect(textOf(window.messages)).toEqual(["PROMPT_0"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("retries a file replaced between opening it and checking its identity", async () => {
    await put([prompt(0), reply(1, "OLD")]);
    const replacement = join(root, "replacement.jsonl");
    await writeFile(
      replacement,
      [prompt(0), reply(1, "NEW")]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );
    const open = fs.promises.open;
    let replaced = false;
    const spy = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (!replaced && String(args[0]).endsWith("transcript_full.jsonl")) {
          const stat = handle.stat.bind(handle);
          handle.stat = (async () => {
            const info = await stat();
            replaced = true;
            await rename(replacement, logPath);
            return info;
          }) as typeof handle.stat;
        }
        return handle;
      });
    try {
      const window = await known({ kind: "latest", compactions: 2 });
      expect(replaced).toBe(true);
      expect(textOf(window.messages)).toEqual(["PROMPT_0", "NEW"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a short latest row after a large tool group without holding the group", async () => {
    const results = 26;
    const child = "c0ffee00-0000-4000-8000-0000000001ff";
    const calls = [
      ...Array.from({ length: results }, () => ({
        name: "read_file",
        args: {},
      })),
      { name: "invoke_subagent", args: { Role: "helper" } },
      // The last call has no result: it was interrupted.
      { name: "read_file", args: {} },
    ];
    await put([
      prompt(0),
      reply(1, "", { tool_calls: calls }),
      ...Array.from({ length: results }, (_, i) => ({
        ...head(2 + i, "GENERIC", "MODEL"),
        content: `RESULT_${i} ${"r".repeat(MiB)}`,
      })),
      {
        ...head(2 + results, "GENERIC", "MODEL"),
        content: `Created the following subagent:\n{\n  "conversationId": "${child}"\n}`,
      },
      prompt(30),
      reply(31, "LATEST"),
    ]);
    const latest = await known({ kind: "latest", compactions: 2 });
    expect(textOf(latest.messages)).toEqual(["PROMPT_30", "LATEST"]);
    expect(latest.bytesRead).toBeLessThan(6 * MiB);
    expect(latest.heldPeak).toBeLessThan(64 * 1024);
    // Load older crosses the group holding about one result at a time.
    const older = await known({
      kind: "before",
      messageId: latest.messages[0]!.uuid!,
      compactions: 2,
    });
    expect(older.heldPeak).toBeLessThan(2 * MiB);
    const contents = older.messages.flatMap((m) =>
      Array.isArray(m.message?.content)
        ? m.message.content.flatMap((b) =>
            b.type === "tool_result" ? [String(b.content)] : [],
          )
        : [],
    );
    expect(
      contents.filter((c) =>
        c.startsWith("This result is part of a tool step"),
      ),
    ).toHaveLength(results);
    // A short result in the group is read normally and keeps its child link.
    expect(contents.at(-1)).toContain(child);
    expect(
      older.messages.find((m) => m.uuid === `${ID}:step-1:tool-27:call`)
        ?.orphanedToolUseIds,
    ).toEqual([`${ID}:step-1:tool-27`]);
    // The page is what the complete read shows between the prompts.
    expect(older.messages).toEqual(
      (await known({ kind: "complete" })).messages.slice(1, -2),
    );
  });

  it("pages across a 34 MiB record from the reply after it, both ways", async () => {
    await put([
      prompt(0),
      reply(3, "EARLY"),
      reply(5, "z".repeat(34 * MiB)),
      reply(6, "LATE"),
    ]);
    const before = await known({
      kind: "before",
      messageId: `${ID}:step-6:text`,
      compactions: 2,
    });
    expect(textOf(before.messages)).toEqual([
      expect.stringMatching(/^This step is too large to show here/),
    ]);
    const after = await known({
      kind: "after",
      messageId: `${ID}:step-3:text`,
      compactions: 2,
    });
    expect(textOf(after.messages).at(-1)).toBe("LATE");
  });

  it("shows a 17 MiB record of escaped newlines in milliseconds", async () => {
    await put([
      prompt(0),
      reply(1, "\n".repeat((17 * MiB) / 2)),
      reply(2, "LATE"),
    ]);
    const started = performance.now();
    const all = await pageAll();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(textOf(all.messages)).toEqual([
      "PROMPT_0",
      expect.stringMatching(/^This step is too large to show here/),
      "LATE",
    ]);
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
