import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLastAgentExcerpt } from "../../src/sessions/agent-excerpt.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { readCodexLatestAgentExcerpt } from "../../src/sessions/latest-agent-excerpt.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { SessionReader } from "../../src/sessions/reader.js";
import {
  createTailPointQuery,
  readLinesBackward,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "../../src/sessions/transcript-tail.js";
import { closeTestDiscoveryDatabases } from "../utils/session-metadata-database.js";

// Past V8's maximum string length, so a whole-file read cannot succeed: an
// answer from a transcript with this hole proves the read stayed at the tail.
const UNREADABLE_HOLE_BYTES = 600 * 1024 * 1024;
const projectId = "excerpt-project" as UrlProjectId;
const ts = "2026-11-14T00:00:00.000Z";

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `latest-agent-excerpt-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  closeTestDiscoveryDatabases();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Bytes read through file handles while `work` runs: the readers here acquire
 * transcripts by positioned handle reads, so this is their actual I/O.
 */
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

/** Head lines, then an optional sparse hole of NUL bytes, then tail lines. */
async function writeTranscript(
  path: string,
  head: unknown[],
  tail: unknown[],
  holeBytes = 0,
): Promise<void> {
  const jsonl = (rows: unknown[]) =>
    rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const headBytes = Buffer.from(jsonl(head));
  const tailBytes = Buffer.from(`\n${jsonl(tail)}`);
  const file = await open(path, "w");
  try {
    await file.write(headBytes, 0, headBytes.length, 0);
    await file.write(
      tailBytes,
      0,
      tailBytes.length,
      headBytes.length + holeBytes,
    );
  } finally {
    await file.close();
  }
}

const codexMeta = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta",
  timestamp: ts,
  payload: { id, cwd: "/test/project", timestamp: ts, ...extra },
});
const codexUser = (text: string) => ({
  type: "event_msg",
  timestamp: ts,
  payload: { type: "user_message", message: text },
});
const codexAssistant = (text: string) => ({
  type: "response_item",
  timestamp: ts,
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  },
});
const codexCall = (callId: string) => ({
  type: "response_item",
  timestamp: ts,
  payload: {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["ls"] }),
    call_id: callId,
  },
});
const codexOutput = (callId: string, output: string) => ({
  type: "response_item",
  timestamp: ts,
  payload: { type: "function_call_output", call_id: callId, output },
});
const codexTokens = {
  type: "event_msg",
  timestamp: ts,
  payload: { type: "token_count", info: null },
};

describe("bounded latest agent excerpt", () => {
  it("answers a Codex excerpt from the tail of a rollout no complete read can load", async () => {
    const id = randomUUID();
    const tail = [
      codexUser("check it"),
      codexAssistant("Looking.\nFirst line\nSecond line\nThird line"),
      codexCall("c1"),
      codexOutput("c1", "x".repeat(200_000)),
      codexTokens,
    ];
    const reader = new CodexSessionReader({ sessionsDir: dir });
    await writeTranscript(
      join(dir, `rollout-${id}.jsonl`),
      [codexMeta(id), codexUser("start")],
      tail,
      UNREADABLE_HOLE_BYTES,
    );
    let excerpt: string | undefined;
    const bytes = await handleBytesRead(async () => {
      excerpt = await reader.getLastAgentExcerpt(id);
    });
    expect(excerpt).toBe("First line\nSecond line\nThird line");
    // The answer sits within the last ~200 KB; discovery reads the head.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it("matches the complete-read excerpt, including the tool label when no prose exists", async () => {
    const reader = new CodexSessionReader({ sessionsDir: dir });
    const cases = [
      [codexUser("go"), codexAssistant("**Done**: `ok`"), codexTokens],
      [codexUser("go"), codexCall("c1"), codexOutput("c1", "out")],
      [codexUser("go"), codexAssistant("Before"), codexCall("c2")],
    ];
    const ids = cases.map(() => randomUUID());
    for (const [index, tail] of cases.entries()) {
      await writeTranscript(
        join(dir, `rollout-${ids[index]}.jsonl`),
        [codexMeta(ids[index]!)],
        tail,
      );
    }
    for (const id of ids) {
      const loaded = await reader.getSession(id, projectId);
      expect(loaded).not.toBeNull();
      const complete = extractLastAgentExcerpt(
        normalizeSession(loaded!).messages,
      );
      expect(complete).toBeDefined();
      expect(await reader.getLastAgentExcerpt(id)).toBe(complete);
    }
  });

  it("answers unknown when the excerpt lies beyond the byte budget", async () => {
    const id = randomUUID();
    const path = join(dir, `rollout-${id}.jsonl`);
    await writeTranscript(
      path,
      [codexMeta(id)],
      [
        codexAssistant("Too far back"),
        codexCall("c1"),
        codexOutput("c1", "y".repeat(TRANSCRIPT_TAIL_POINT_BYTE_BUDGET + 1)),
      ],
    );
    let excerpt: string | undefined = "unset";
    const bytes = await handleBytesRead(async () => {
      excerpt = await readCodexLatestAgentExcerpt(path);
    });
    expect(excerpt).toBeUndefined();
    expect(bytes).toBeGreaterThan(TRANSCRIPT_TAIL_POINT_BYTE_BUDGET / 2);
    expect(bytes).toBeLessThanOrEqual(TRANSCRIPT_TAIL_POINT_BYTE_BUDGET);
  });

  it("answers unknown, not a tool label, for a fork whose prose may be in its parent", async () => {
    const id = randomUUID();
    const path = join(dir, `rollout-${id}.jsonl`);
    await writeTranscript(
      path,
      [
        codexMeta(id, {
          history_base: {
            thread_id: randomUUID(),
            end_ordinal_exclusive: 4,
            end_byte_offset: 900,
          },
        }),
      ],
      [codexUser("go"), codexCall("c1")],
    );
    expect(await readCodexLatestAgentExcerpt(path)).toBeUndefined();
  });

  it("reads a byte-order mark as part of neither the fork metadata nor its absence", async () => {
    const write = async (withFork: boolean) => {
      const id = randomUUID();
      const path = join(dir, `rollout-${id}.jsonl`);
      const meta = codexMeta(
        id,
        withFork
          ? {
              history_base: {
                thread_id: randomUUID(),
                end_ordinal_exclusive: 4,
                end_byte_offset: 900,
              },
            }
          : {},
      );
      await writeFile(
        path,
        `\uFEFF${[meta, codexUser("go"), codexCall("c1")]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
      return path;
    };
    expect(
      await readCodexLatestAgentExcerpt(await write(true)),
    ).toBeUndefined();
    expect(await readCodexLatestAgentExcerpt(await write(false))).toMatch(
      /^⚙ /,
    );
  });

  it("answers unknown when the transcript changes during the read", async () => {
    const path = join(dir, "changing.jsonl");
    await writeFile(path, "old\n");
    const query = createTailPointQuery<string>({
      name: "test-changing",
      maxRetainedBytes: 1024,
      estimateBytes: () => 64,
      compute: async () => {
        // A rewrite can leave earlier chunks from one version and later
        // ones from another.
        await appendFile(path, "new\n");
        return "mixed";
      },
    });
    expect(await query(path)).toBeUndefined();
  });

  it("answers a Claude excerpt from the tail of a transcript no complete read can load", async () => {
    const sessionDir = join(dir, "claude");
    await mkdir(sessionDir);
    const reader = new SessionReader({ sessionDir });
    const row = (uuid: string, parentUuid: string | null, rest: object) => ({
      uuid,
      parentUuid,
      sessionId: "big",
      timestamp: ts,
      ...rest,
    });
    await writeTranscript(
      join(sessionDir, "big.jsonl"),
      [
        row("u1", null, {
          type: "user",
          message: { role: "user", content: "go" },
        }),
      ],
      [
        row("a1", "u1", {
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "Tail answer." }],
          },
        }),
      ],
      UNREADABLE_HOLE_BYTES,
    );
    expect(await reader.getLastAgentExcerpt("big")).toBe("Tail answer.");
  });

  it("reads lines backward across chunk boundaries and stops at the budget", async () => {
    const path = join(dir, "lines.jsonl");
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `${i}:${"z".repeat(i)}`,
    );
    await writeFile(path, `${lines.join("\n")}\n`);
    const size = Buffer.byteLength(`${lines.join("\n")}\n`);

    const all: string[] = [];
    for await (const batch of readLinesBackward(path, {
      endByte: size,
      maxBytes: size,
    })) {
      all.unshift(...batch.lines);
      expect(batch.bytesRead).toBeLessThanOrEqual(size);
    }
    expect(all).toEqual(lines);

    const seen: string[] = [];
    let last: { bytesRead: number; reachedStart: boolean } | undefined;
    for await (const batch of readLinesBackward(path, {
      endByte: size,
      maxBytes: 100_000,
    })) {
      seen.unshift(...batch.lines);
      last = batch;
    }
    expect(last?.reachedStart).toBe(false);
    expect(last!.bytesRead).toBeLessThanOrEqual(100_000);
    expect(seen).toEqual(lines.slice(lines.length - seen.length));
  });
});
