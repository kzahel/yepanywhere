import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { CodexRolloutWindowReader } from "../../src/sessions/codex-rollout-window.js";
import type { SessionSummary } from "../../src/supervisor/types.js";

const projectId = "test-project" as UrlProjectId;
const timestamp = "2026-11-15T00:00:00.000Z";
// Over the two-boundary size estimate (4 MiB), so the decision has to scan.
const filler = (bytes: number) =>
  JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "agent_message", message: "x".repeat(bytes) },
  });
const compacted = (message: string) =>
  JSON.stringify({ type: "compacted", timestamp, payload: { message } });
const row = (text: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });

async function readRange(path: string, start: number, length: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

describe("Codex compact-boundary memo", () => {
  let dir: string;
  let id: string;
  let path: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codex-boundary-memo-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    id = randomUUID();
    path = join(dir, `rollout-2026-11-15T00-00-00-${id}.jsonl`);
    const meta = JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: { id, cwd: dir, timestamp },
    });
    await writeFile(
      path,
      `${[meta, filler(4.5 * 1024 * 1024), compacted("one"), row("a")].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads only appended bytes to decide again on warm open and catch-up", async () => {
    // A second rollout with no boundaries at all, for the smaller-count case.
    const otherId = randomUUID();
    const other = join(dir, `rollout-2026-11-15T00-00-01-${otherId}.jsonl`);
    const otherMeta = JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: { id: otherId, cwd: dir, timestamp },
    });
    await writeFile(
      other,
      `${[otherMeta, filler(4.5 * 1024 * 1024), row("a")].join("\n")}\n`,
    );
    const reader = new CodexSessionReader({ sessionsDir: dir });
    const reads = vi.spyOn(
      CodexSessionReader.prototype as unknown as {
        readFileRange(
          path: string,
          start: number,
          length: number,
        ): Promise<Buffer>;
      },
      "readFileRange",
    );
    const bytesRead = () => {
      const total = reads.mock.calls.reduce((sum, call) => sum + call[2], 0);
      reads.mockClear();
      return total;
    };
    const summaryHint = {
      id,
      projectId,
      provider: "codex",
      updatedAt: new Date(0).toISOString(),
    } as SessionSummary;
    const load = (afterMessageId?: string) =>
      reader.getSession(id, projectId, afterMessageId, {
        tailCompactions: 2,
        summaryHint,
      });
    const size = (await stat(path)).size;

    // Cold: one decision scan, then the complete read the contract requires.
    expect((await load())?.readWindow).toBeUndefined();
    expect(bytesRead()).toBeGreaterThanOrEqual(2 * size);
    await load();
    expect(bytesRead()).toBe(0);
    await load("cursor");
    expect(bytesRead()).toBe(0);

    const appended = `${row("b")}\n`;
    await appendFile(path, appended);
    const loaded = await load("cursor");
    expect(loaded?.readWindow).toBeUndefined();
    const session = loaded?.data.session;
    expect(session && "entries" in session && session.entries.length).toBe(5);
    // New bytes for both the decision and the cache, plus 1 KiB fence probes.
    expect(bytesRead()).toBeLessThan(2 * appended.length + 32 * 1024);
    await load("cursor");
    expect(bytesRead()).toBe(0);

    const loadOther = (tailCompactions: number) =>
      reader.getSession(otherId, projectId, undefined, {
        tailCompactions,
        summaryHint: { ...summaryHint, id: otherId },
      });
    // A smaller count answered early keeps the memo for the larger one.
    const opened = await loadOther(2);
    expect(opened).not.toBeNull();
    expect(opened?.readWindow).toBeUndefined();
    bytesRead();
    const boundary = `${compacted("first")}\n${row("b")}\n`;
    await appendFile(other, boundary);
    expect((await loadOther(1))?.readWindow).toBeDefined();
    bytesRead();
    expect((await loadOther(2))?.readWindow).toBeUndefined();
    expect(bytesRead()).toBeLessThan(2 * boundary.length + 32 * 1024);
    await reader.close();
  });

  it("answers as a fresh scan when appends complete or add boundaries", async () => {
    const remembered = new CodexRolloutWindowReader(readRange);
    const expectFreshAnswer = async (boundaries: number) => {
      const stats = await stat(path);
      const fresh = await new CodexRolloutWindowReader(
        readRange,
      ).findCompactTailStart(path, stats, boundaries);
      expect(
        await remembered.findCompactTailStart(path, stats, boundaries),
      ).toBe(fresh);
      return fresh;
    };

    expect(await expectFreshAnswer(2)).toBeNull();
    // Another count reuses the remembered boundary without a scan.
    expect(await expectFreshAnswer(1)).toBeGreaterThan(0);

    // A provisional line is not final: it later completes into a boundary.
    const second = compacted("two");
    await appendFile(path, second.slice(0, 20));
    expect(await expectFreshAnswer(2)).toBeNull();
    await appendFile(path, `${second.slice(20)}\n${row("c")}\n`);
    // The second boundary from the end is the remembered one.
    const rememberedStart = await expectFreshAnswer(2);
    expect(rememberedStart).toBeGreaterThan(0);

    // A valid unterminated record counts, as it does in a full scan.
    await appendFile(path, compacted("three"));
    expect(await expectFreshAnswer(2)).toBeGreaterThan(rememberedStart ?? 0);
  });

  it("answers as a fresh scan when the remembered prefix changes mid-scan", async () => {
    // An old event row and a compact record of exactly the same length.
    const event = JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "agent_message", message: "y".repeat(100) },
    });
    const pad = (n: number) =>
      JSON.stringify({
        type: "compacted",
        timestamp,
        payload: { message: "z".repeat(n) },
      });
    const rewrite = pad(100 + event.length - pad(100).length);
    expect(Buffer.byteLength(rewrite)).toBe(Buffer.byteLength(event));
    await appendFile(path, `${event}\n`);
    const eventStart = (await stat(path)).size - event.length - 1;

    let inject: { after: number } | null = null;
    const racingRead = async (file: string, start: number, length: number) => {
      // The rewrite lands after the remembered prefix was validated.
      if (inject && start >= inject.after && length > 1024) {
        inject = null;
        const handle = await open(path, "r+");
        await handle.write(rewrite, eventStart);
        await handle.close();
      }
      return readRange(file, start, length);
    };
    const remembered = new CodexRolloutWindowReader(racingRead);
    expect(
      await remembered.findCompactTailStart(path, await stat(path), 2),
    ).toBeNull();

    // A new boundary, padded so the old end probe is not inside the new one.
    const oldSize = (await stat(path)).size;
    await appendFile(path, `${compacted("two")}\n${filler(2048)}\n`);
    inject = { after: oldSize };
    const answer = await remembered.findCompactTailStart(
      path,
      await stat(path),
      2,
    );
    expect(inject).toBeNull();
    const fresh = await new CodexRolloutWindowReader(
      readRange,
    ).findCompactTailStart(path, await stat(path), 2);
    expect(fresh).toBe(eventStart);
    expect(answer).toBe(fresh);
  });

  it("does not trust the memo after an in-place rewrite", async () => {
    const remembered = new CodexRolloutWindowReader(readRange);
    expect(
      await remembered.findCompactTailStart(path, await stat(path), 2),
    ).toBeNull();

    // Same inode, larger file, the old boundary gone and one new one after the
    // remembered prefix: trusting the memo would report two boundaries.
    const meta = JSON.stringify({
      type: "session_meta",
      timestamp,
      payload: { id, cwd: dir, timestamp },
    });
    await writeFile(
      path,
      `${[meta, filler(4.6 * 1024 * 1024), row("a"), compacted("new"), row("b")].join("\n")}\n`,
    );
    const stats = await stat(path);
    expect(
      await new CodexRolloutWindowReader(readRange).findCompactTailStart(
        path,
        stats,
        2,
      ),
    ).toBeNull();
    expect(await remembered.findCompactTailStart(path, stats, 2)).toBeNull();
  });
});
