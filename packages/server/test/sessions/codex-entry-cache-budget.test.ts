import { codexEntries } from "./provider-session-fixtures.js";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexEntryCacheBudget } from "../../src/sessions/codex-entry-cache-budget.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { isZstdJsonlSupported } from "../../src/utils/jsonl.js";

const projectId = "test-project" as UrlProjectId;

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;
const itIfNativeZstd =
  typeof zstdCompressSync === "function" && isZstdJsonlSupported()
    ? it
    : it.skip;

function zstdCompressed(content: Buffer): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(content);
}

function userMessageLine(message: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: new Date().toISOString(),
    payload: { type: "user_message", message },
  });
}

describe("CodexEntryCacheBudget", () => {
  it("evicts least recently used entries and honors touch", () => {
    const budget = new CodexEntryCacheBudget({ maxSourceBytes: 100 });
    const released: string[] = [];
    const a = {};
    const b = {};
    const c = {};

    expect(budget.admit(a, 40, () => released.push("a"))).toBe(true);
    expect(budget.admit(b, 40, () => released.push("b"))).toBe(true);
    budget.touch(a);
    expect(budget.admit(c, 40, () => released.push("c"))).toBe(true);

    expect(released).toEqual(["b"]);
    expect(budget.getStats()).toEqual({
      budgetBytes: 100,
      retainedEntries: 2,
      retainedSourceBytes: 80,
    });
  });

  it("rejects an entry larger than the whole budget", () => {
    const budget = new CodexEntryCacheBudget({ maxSourceBytes: 100 });
    const released: string[] = [];
    const small = {};
    const growing = {};

    budget.admit(small, 30, () => released.push("small"));
    budget.admit(growing, 50, () => released.push("growing"));
    expect(budget.admit(growing, 101, () => released.push("growing"))).toBe(
      false,
    );

    expect(released).toEqual([]);
    expect(budget.getStats()).toMatchObject({
      retainedEntries: 1,
      retainedSourceBytes: 30,
    });
  });

  it("resizes an entry in place and evicts others to fit", () => {
    const budget = new CodexEntryCacheBudget({ maxSourceBytes: 100 });
    const released: string[] = [];
    const a = {};
    const b = {};

    budget.admit(a, 40, () => released.push("a"));
    budget.admit(b, 40, () => released.push("b"));
    budget.admit(b, 70, () => released.push("b"));

    expect(released).toEqual(["a"]);
    expect(budget.getStats()).toMatchObject({
      retainedEntries: 1,
      retainedSourceBytes: 70,
    });

    budget.release(b);
    expect(budget.getStats()).toMatchObject({
      retainedEntries: 0,
      retainedSourceBytes: 0,
    });
  });
});

describe("CodexSessionReader entry cache budget", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-entry-budget-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createSession(
    sessionId: string,
    messages: number,
    options: { compressed?: boolean } = {},
  ): Promise<{ path: string; size: number; decodedSize: number }> {
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
    ];
    for (let i = 0; i < messages; i++) {
      lines.push(userMessageLine(`message ${i} ${"x".repeat(200)}`));
    }
    const content = Buffer.from(`${lines.join("\n")}\n`);
    const path = join(
      testDir,
      options.compressed ? `${sessionId}.jsonl.zst` : `${sessionId}.jsonl`,
    );
    await writeFile(
      path,
      options.compressed ? zstdCompressed(content) : content,
    );
    return {
      path,
      size: (await stat(path)).size,
      decodedSize: content.length,
    };
  }

  it("evicts the least recently used session across readers", async () => {
    const first = await createSession("budget-first", 10);
    const second = await createSession("budget-second", 10);
    const budget = new CodexEntryCacheBudget({
      maxSourceBytes: first.size + second.size - 1,
    });
    const readerA = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: budget,
    });
    const readerB = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: budget,
    });

    await readerA.getSession("budget-first", projectId);
    expect(readerA.getEntryCacheStats().sessions).toBe(1);

    const loaded = await readerB.getSession("budget-second", projectId);
    expect(codexEntries(loaded)).toHaveLength(11);
    expect(readerA.getEntryCacheStats().sessions).toBe(0);
    expect(readerB.getEntryCacheStats().sessions).toBe(1);
    expect(budget.getStats()).toEqual({
      budgetBytes: first.size + second.size - 1,
      retainedEntries: 1,
      retainedSourceBytes: second.size,
    });
  });

  it("serves a session larger than the budget without retaining it", async () => {
    const session = await createSession("budget-oversized", 20);
    const budget = new CodexEntryCacheBudget({
      maxSourceBytes: session.size - 1,
    });
    const reader = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: budget,
    });

    const [loaded, concurrent] = await Promise.all([
      reader.getSession("budget-oversized", projectId),
      reader.getSession("budget-oversized", projectId),
    ]);
    expect(codexEntries(loaded)).toHaveLength(21);
    expect(codexEntries(concurrent)).toHaveLength(21);
    expect(reader.getEntryCacheStats().sessions).toBe(0);
    expect(budget.getStats().retainedEntries).toBe(0);
  });

  // A sweep over zstd rollouts once retained ~2.6 GB of heap under a 256 MB
  // budget because entries were charged their compressed file size.
  itIfNativeZstd("charges a compressed rollout its decoded size", async () => {
    const session = await createSession("budget-compressed", 40, {
      compressed: true,
    });
    expect(session.size * 4).toBeLessThan(session.decodedSize);

    const tight = new CodexEntryCacheBudget({
      maxSourceBytes: session.decodedSize - 1,
    });
    const tightReader = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: tight,
    });
    const loaded = await tightReader.getSession("budget-compressed", projectId);
    expect(codexEntries(loaded)).toHaveLength(41);
    expect(tightReader.getEntryCacheStats().sessions).toBe(0);

    const roomy = new CodexEntryCacheBudget({
      maxSourceBytes: session.decodedSize,
    });
    const roomyReader = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: roomy,
    });
    await roomyReader.getSession("budget-compressed", projectId);
    expect(roomy.getStats()).toMatchObject({
      retainedEntries: 1,
      retainedSourceBytes: session.decodedSize,
    });
  });

  it("drops a cached session once appends grow it past the budget", async () => {
    const session = await createSession("budget-growing", 5);
    const budget = new CodexEntryCacheBudget({
      maxSourceBytes: session.size + 300,
    });
    const reader = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: budget,
    });

    await reader.getSession("budget-growing", projectId);
    expect(budget.getStats().retainedSourceBytes).toBe(session.size);

    await appendFile(
      session.path,
      `${userMessageLine("appended")}\n${userMessageLine("x".repeat(400))}\n`,
    );
    const loaded = await reader.getSession("budget-growing", projectId);
    expect(codexEntries(loaded)).toHaveLength(8);
    expect(reader.getEntryCacheStats().sessions).toBe(0);
    expect(budget.getStats()).toMatchObject({
      retainedEntries: 0,
      retainedSourceBytes: 0,
    });
  });

  it("releases budget accounting on invalidation", async () => {
    await createSession("budget-invalidated", 5);
    const budget = new CodexEntryCacheBudget({ maxSourceBytes: 1024 * 1024 });
    const reader = new CodexSessionReader({
      sessionsDir: testDir,
      entryCacheBudget: budget,
    });

    await reader.getSession("budget-invalidated", projectId);
    expect(budget.getStats().retainedEntries).toBe(1);

    reader.invalidateCache();
    expect(budget.getStats()).toMatchObject({
      retainedEntries: 0,
      retainedSourceBytes: 0,
    });
  });
});
