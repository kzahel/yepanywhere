import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastRewindableClaudeRowId } from "../../src/sessions/claude-messages.js";
import { readSessionRewindBoundRowId } from "../../src/sessions/claude-rewind-bound.js";
import { ClaudeTranscriptCache } from "../../src/sessions/claude-transcript-cache.js";
import { MergedSessionReader } from "../../src/sessions/merged-reader.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { TRANSCRIPT_TAIL_POINT_BYTE_BUDGET } from "../../src/sessions/transcript-tail.js";
import type { ISessionReader } from "../../src/sessions/types.js";

// Past V8's maximum string length, so a whole-file read cannot succeed: an
// answer from a transcript with this hole proves the read stayed at the tail.
const UNREADABLE_HOLE_BYTES = 600 * 1024 * 1024;
const projectId = "rewind-bound-project" as UrlProjectId;
const ts = "2026-11-15T00:00:00.000Z";

let dir: string;
let caches: ClaudeTranscriptCache[];
beforeEach(async () => {
  dir = join(tmpdir(), `claude-rewind-bound-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  caches = [];
});
afterEach(async () => {
  await Promise.all(caches.map((cache) => cache.close()));
  await rm(dir, { recursive: true, force: true });
});

async function readerFor(name: string): Promise<ClaudeSessionReader> {
  const sessionDir = join(dir, name);
  await mkdir(sessionDir, { recursive: true });
  const transcriptCache = new ClaudeTranscriptCache({ maxSourceBytes: 0 });
  caches.push(transcriptCache);
  return new ClaudeSessionReader({ sessionDir, transcriptCache });
}

const row = (uuid: string | undefined, type = "user") => ({
  ...(uuid !== undefined ? { uuid } : {}),
  parentUuid: null,
  sessionId: "s",
  timestamp: ts,
  type,
  message: { role: type, content: "x" },
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Bytes read through file handles while `work` runs. */
async function handleBytesRead(work: () => Promise<unknown>): Promise<number> {
  const probe = await open(join(dir, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as {
    read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  };
  await probe.close();
  const original = prototype.read;
  let total = 0;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: unknown,
    ...args: unknown[]
  ) {
    const result = await original.apply(this, args);
    total += result.bytesRead;
    return result;
  });
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return total;
}

/** Today's answer: the whole-session read the bound used before. */
async function completeBound(reader: ISessionReader, id: string) {
  const loaded = await reader.getSession(id, projectId, undefined, {
    includeOrphans: false,
  });
  const data = loaded?.data;
  return data?.provider === "claude"
    ? lastRewindableClaudeRowId(data.session.messages)
    : undefined;
}

describe("Claude rewind bound", () => {
  it("answers from the tail of a transcript no complete read can load", async () => {
    const reader = await readerFor("big");
    const path = join(dir, "big", "big.jsonl");
    const head = Buffer.from(line(row("u1")));
    // Rows the bound skips: progress, no uuid, malformed, blank, and a
    // record still being written.
    const tail = Buffer.from(
      `\n${line(row("a1", "assistant"))}${line(row("p1", "progress"))}${line(
        row(undefined, "queue-operation"),
      )}{not json\n\n${JSON.stringify(row("w1")).slice(0, 40)}`,
    );
    const file = await open(path, "w");
    try {
      await file.write(head, 0, head.length, 0);
      await file.write(
        tail,
        0,
        tail.length,
        head.length + UNREADABLE_HOLE_BYTES,
      );
    } finally {
      await file.close();
    }
    let bound: string | undefined;
    const bytes = await handleBytesRead(async () => {
      bound = await readSessionRewindBoundRowId(reader, "big", projectId);
    });
    expect(bound).toBe("a1");
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(128 * 1024);
  });

  it("matches the complete read on unterminated, BOM, CRLF, falsy and empty-uuid rows", async () => {
    const reader = await readerFor("shapes");
    const cases: Record<string, string> = {
      // A valid record without its newline is part of the complete read.
      unterminated: `${line(row("u1"))}${JSON.stringify(row("u2"))}`,
      bom: `\uFEFF${JSON.stringify(row("u1"))}\n`,
      // The complete reader trims every line, so a BOM mid-file is dropped.
      midFileBom: `${line(row("u1"))}\uFEFF${line(row("u2"))}`,
      crlf: `${JSON.stringify(row("u1"))}\r\n${JSON.stringify(row("u2"))}\r\n`,
      falsy: `${line(row("u1"))}null\n0\nfalse\n""\n[]\n`,
      emptyUuid: `${line(row("u1"))}${line(row(""))}`,
    };
    for (const [id, content] of Object.entries(cases)) {
      await writeFile(join(dir, "shapes", `${id}.jsonl`), content);
      expect(await reader.readRewindBound(id), id).toEqual({
        rowId: await completeBound(reader, id),
      });
      expect(await completeBound(reader, id), id).toBeDefined();
    }
    // A non-object row has no uuid and is skipped, including after the
    // bound, where the complete read happens to throw on it.
    await writeFile(
      join(dir, "shapes", "primitive.jsonl"),
      `${line(row("u1"))}42\n"x"\ntrue\n`,
    );
    expect(
      await readSessionRewindBoundRowId(reader, "primitive", projectId),
    ).toBe("u1");
  });

  it("takes the complete read when the tail cannot decide", async () => {
    const reader = await readerFor("unknown");
    const write = (id: string, content: string) =>
      writeFile(join(dir, "unknown", `${id}.jsonl`), content);
    // The last rewindable row lies beyond the byte budget.
    await write(
      "far",
      `${line(row("u1"))}${line({
        ...row("p1", "progress"),
        data: "y".repeat(TRANSCRIPT_TAIL_POINT_BYTE_BUDGET),
      })}`,
    );
    expect(await reader.readRewindBound("far")).toBe("unknown");
    expect(await readSessionRewindBoundRowId(reader, "far", projectId)).toBe(
      "u1",
    );
    // No row with a uuid: the complete read still decides there is no bound.
    await write("none", line(row(undefined, "summary")));
    expect(await reader.readRewindBound("none")).toBe("unknown");
    expect(
      await readSessionRewindBoundRowId(reader, "none", projectId),
    ).toBeUndefined();
  });

  it("does not answer from a later root when an earlier root holds the session", async () => {
    const first = await readerFor("first");
    const second = await readerFor("second");
    await writeFile(
      join(dir, "first", "s.jsonl"),
      line(row(undefined, "summary")),
    );
    await writeFile(join(dir, "second", "s.jsonl"), line(row("other")));
    const merged = new MergedSessionReader([first, second]);
    expect(await merged.readRewindBound("s")).toBe("unknown");
    expect(await readSessionRewindBoundRowId(merged, "s", projectId)).toBe(
      await completeBound(merged, "s"),
    );
    expect(await completeBound(merged, "s")).toBeUndefined();
  });
});
