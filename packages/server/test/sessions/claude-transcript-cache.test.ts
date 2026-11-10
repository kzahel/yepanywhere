import * as ingestion from "../../src/sessions/transcript-ingestion.js";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSummaryFromState } from "../../src/sessions/claude-summary.js";
import { ClaudeTranscriptCache } from "../../src/sessions/claude-transcript-cache.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function uuids(entries: readonly unknown[] | undefined): string[] {
  return (entries ?? []).map((e) => (e as { uuid?: string }).uuid ?? "");
}

function userLine(uuid: string, parentUuid: string | null, text: string) {
  return line({
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-08-07T00:00:00.000Z",
    message: { content: text },
  });
}

function assistantLine(uuid: string, parentUuid: string | null, text: string) {
  return line({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-08-07T00:00:01.000Z",
    message: { content: [{ type: "text", text }], model: "claude-fable-5" },
  });
}

describe("ClaudeTranscriptCache", () => {
  let testDir: string;
  let filePath: string;
  let cache: ClaudeTranscriptCache;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-transcript-cache-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    filePath = join(testDir, "session.jsonl");
    cache = new ClaudeTranscriptCache();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each(["other-path", "same-path", "replacement", "rejected"])(
    "fences a %s invalidation while an append is being acquired",
    async (mode) => {
      const other = join(testDir, "other.jsonl");
      await writeFile(filePath, userLine("u1", null, "old") + "\n");
      await writeFile(other, userLine("other", null, "other") + "\n");
      await cache.load(filePath);
      await cache.load(other);
      await appendFile(filePath, assistantLine("a1", "u1", "append") + "\n");
      const original = ingestion.readTranscriptFile;
      let started!: () => void, release!: () => void;
      const observed = new Promise<void>((resolve) => {
          started = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      let held = false;
      const spy = vi
        .spyOn(ingestion, "readTranscriptFile")
        .mockImplementation(async (...args) => {
          if (args[0] === filePath && args[1] > 0 && !held) {
            held = true;
            started();
            await gate;
            if (mode === "rejected") throw new Error("obsolete read rejected");
          }
          return original(...args);
        });
      let newer: Awaited<ReturnType<typeof cache.load>> | undefined;
      try {
        const pending = cache.load(filePath);
        await observed;
        if (mode === "other-path") cache.invalidate(other);
        if (mode === "same-path" || mode === "rejected") {
          cache.invalidate(filePath);
          newer = await cache.load(filePath);
        }
        if (mode === "replacement") {
          const path = join(testDir, "replacement.jsonl");
          await writeFile(
            path,
            userLine("new", null, "replacement".repeat(200)) + "\n",
          );
          await rename(path, filePath);
        }
        release();
        const accepted = await pending;
        expect(accepted).not.toBeNull();
        const fresh = await new ClaudeTranscriptCache({
          maxSourceBytes: 0,
        }).load(filePath);
        expect(accepted?.entries).toEqual(fresh?.entries);
        if (newer)
          expect((await cache.load(filePath))?.entries).toBe(newer.entries);
      } finally {
        release();
        spy.mockRestore();
      }
    },
  );

  it("parses entries and reuses the array for an unchanged file", async () => {
    await writeFile(
      filePath,
      `${userLine("u1", null, "hello")}\n${assistantLine("a1", "u1", "hi")}\n`,
    );

    const first = await cache.load(filePath);
    expect(uuids(first?.entries)).toEqual(["u1", "a1"]);

    const second = await cache.load(filePath);
    expect(second?.entries).toBe(first?.entries);
  });

  it("reports bounded process-level cache diagnostics", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);

    expect(cache.getStats()).toMatchObject({
      inFlightLoads: 0,
      retainedFiles: 0,
      retainedSourceBytes: 0,
    });
    expect(cache.getStats().budgetBytes).toBeGreaterThan(0);

    await cache.load(filePath);
    const stats = cache.getStats();
    expect(stats.inFlightLoads).toBe(0);
    expect(stats.retainedFiles).toBe(1);
    expect(stats.retainedSourceBytes).toBeGreaterThan(0);
  });

  it("extends the same array in place when the file grows", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    const first = await cache.load(filePath);
    expect(uuids(first?.entries)).toEqual(["u1"]);

    await appendFile(filePath, `${assistantLine("a1", "u1", "hi")}\n`);
    const second = await cache.load(filePath);
    expect(second?.entries).toBe(first?.entries);
    expect(uuids(second?.entries)).toEqual(["u1", "a1"]);
  });

  it("keeps the incremental summary state consistent with a fresh parse", async () => {
    await writeFile(filePath, `${userLine("u1", null, "first prompt")}\n`);
    await cache.load(filePath);
    await appendFile(filePath, `${assistantLine("a1", "u1", "answer")}\n`);
    const incremental = await cache.load(filePath);

    const fresh = new ClaudeTranscriptCache();
    const reparsed = await fresh.load(filePath);
    expect(incremental).not.toBeNull();
    expect(reparsed).not.toBeNull();
    if (!incremental || !reparsed) return;

    const options = {
      filePath,
      stats: reparsed.stats,
      sessionId: "session",
      projectId: "project" as UrlProjectId,
    };
    expect(buildSummaryFromState(incremental.summaryState, options)).toEqual(
      buildSummaryFromState(reparsed.summaryState, options),
    );
  });

  it("re-parses fully when the file shrinks", async () => {
    await writeFile(
      filePath,
      `${userLine("u1", null, "hello")}\n${assistantLine("a1", "u1", "hi")}\n`,
    );
    const first = await cache.load(filePath);
    expect(first?.entries).toHaveLength(2);

    await writeFile(filePath, `${userLine("u2", null, "rewritten")}\n`);
    const second = await cache.load(filePath);
    expect(second?.entries).not.toBe(first?.entries);
    expect(uuids(second?.entries)).toEqual(["u2"]);
  });

  it("re-parses fully when a changed file keeps the same size", async () => {
    const original = `${userLine("u1", null, "hello")}`;
    const replacement = `${userLine("u9", null, "hellp")}`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(filePath, `${original}\n`);
    const first = await cache.load(filePath);

    await writeFile(filePath, `${replacement}\n`);
    const forcedMtime = new Date((first?.stats.mtimeMs ?? Date.now()) + 1000);
    await utimes(filePath, forcedMtime, forcedMtime);
    const second = await cache.load(filePath);

    expect(second?.entries).not.toBe(first?.entries);
    expect(uuids(second?.entries)).toEqual(["u9"]);
  });

  it("re-parses a replaced inode instead of extending cached state", async () => {
    const original = `${userLine("u1", null, "hello")}\n`;
    await writeFile(filePath, original);
    const first = await cache.load(filePath);

    const replacementPath = join(testDir, "replacement.jsonl");
    await writeFile(
      replacementPath,
      `${original}${assistantLine("a1", "u1", "hi")}\n`,
    );
    await rename(replacementPath, filePath);
    const second = await cache.load(filePath);

    expect(second?.entries).not.toBe(first?.entries);
    expect(uuids(second?.entries)).toEqual(["u1", "a1"]);
  });

  it("re-parses fully when bytes before the parse offset changed", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    const first = await cache.load(filePath);
    expect(uuids(first?.entries)).toEqual(["u1"]);

    // Same prefix length, different content, plus growth: the boundary probe
    // must reject the incremental path.
    await writeFile(
      filePath,
      `${userLine("u9", null, "hellp")}\n${assistantLine("a1", "u9", "hi")}\n`,
    );
    const second = await cache.load(filePath);
    expect(second?.entries).not.toBe(first?.entries);
    expect(uuids(second?.entries)).toEqual(["u9", "a1"]);
  });

  it("serves an unterminated final line and re-reads it on growth", async () => {
    const complete = userLine("u1", null, "hello");
    const partial = assistantLine("a1", "u1", "hi");
    await writeFile(filePath, `${complete}\n${partial}`);

    const first = await cache.load(filePath);
    expect(uuids(first?.entries)).toEqual(["u1", "a1"]);

    await appendFile(filePath, `\n${userLine("u2", "a1", "next")}\n`);
    const second = await cache.load(filePath);
    expect(uuids(second?.entries)).toEqual(["u1", "a1", "u2"]);
  });

  it("ignores a torn (unparseable) trailing line until it completes", async () => {
    const torn = `{"type":"user","uuid":"u2","parentU`;
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n${torn}`);

    const first = await cache.load(filePath);
    expect(uuids(first?.entries)).toEqual(["u1"]);

    await appendFile(filePath, `uid":"u1","message":{"content":"finished"}}\n`);
    const second = await cache.load(filePath);
    expect(uuids(second?.entries)).toEqual(["u1", "u2"]);
  });

  it("peek returns null for a cold file and refreshes a warm one", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    expect(await cache.peek(filePath)).toBeNull();

    const loaded = await cache.load(filePath);
    await appendFile(filePath, `${assistantLine("a1", "u1", "hi")}\n`);
    const peeked = await cache.peek(filePath);
    expect(peeked?.entries).toBe(loaded?.entries);
    expect(uuids(peeked?.entries)).toEqual(["u1", "a1"]);
  });

  it("evicts the least recently used file beyond the byte budget", async () => {
    const small = new ClaudeTranscriptCache({ maxSourceBytes: 150 });
    const fileA = join(testDir, "a.jsonl");
    const fileB = join(testDir, "b.jsonl");
    await writeFile(fileA, `${userLine("a", null, "aaaa")}\n`);
    await writeFile(fileB, `${userLine("b", null, "bbbb")}\n`);

    await small.load(fileA);
    await small.load(fileB);

    // fileA should have been evicted to fit fileB.
    expect(await small.peek(fileA)).toBeNull();
    expect(await small.peek(fileB)).not.toBeNull();
  });

  it("never retains a file larger than the whole budget", async () => {
    const small = new ClaudeTranscriptCache({ maxSourceBytes: 10 });
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    const loaded = await small.load(filePath);
    expect(uuids(loaded?.entries)).toEqual(["u1"]);
    expect(await small.peek(filePath)).toBeNull();
  });

  it("coalesces concurrent loads into one parse", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    const [a, b] = await Promise.all([
      cache.load(filePath),
      cache.load(filePath),
    ]);
    expect(a?.entries).toBe(b?.entries);
  });

  it("returns null for a missing file and drops stale state", async () => {
    await writeFile(filePath, `${userLine("u1", null, "hello")}\n`);
    await cache.load(filePath);
    await rm(filePath);
    expect(await cache.load(filePath)).toBeNull();
    expect(await cache.peek(filePath)).toBeNull();
  });
});

describe("claude normalization cache", () => {
  function loadedSessionFor(rawMessages: unknown[]): LoadedSession {
    return {
      summary: {
        id: "session",
        projectId: "project" as UrlProjectId,
        title: null,
        fullTitle: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:01.000Z",
        messageCount: rawMessages.length,
        ownership: { owner: "none" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          // biome-ignore lint/suspicious/noExplicitAny: loose fixture rows by design
          messages: rawMessages as any,
        },
      },
    };
  }

  it("reuses converted messages for an unchanged entries array", () => {
    const rawMessages = [
      JSON.parse(userLine("u1", null, "hello")),
      JSON.parse(assistantLine("a1", "u1", "hi")),
    ];
    const loaded = loadedSessionFor(rawMessages);

    const first = normalizeSession(loaded);
    const second = normalizeSession(loaded);
    expect(second.messages).toBe(first.messages);
  });

  it("reconverts when the entries array grows in place", () => {
    const rawMessages = [
      JSON.parse(userLine("u1", null, "hello")),
      JSON.parse(assistantLine("a1", "u1", "hi")),
    ];
    const loaded = loadedSessionFor(rawMessages);

    const first = normalizeSession(loaded);
    rawMessages.push(JSON.parse(userLine("u2", "a1", "more")));
    const second = normalizeSession(loaded);
    expect(second.messages).not.toBe(first.messages);
    expect(second.messages).toHaveLength(3);
  });
});
