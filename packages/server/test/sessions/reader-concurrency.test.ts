import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileSpy = vi.fn();

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );

  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      readFileSpy(args[0]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return actual.readFile(...args);
    }),
  };
});

import { SessionReader } from "../../src/sessions/reader.js";

describe("SessionReader concurrency", () => {
  let testDir: string;
  let reader: SessionReader;

  beforeEach(async () => {
    readFileSpy.mockClear();
    testDir = join(tmpdir(), `claude-reader-concurrency-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new SessionReader({ sessionDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("并发读取同一会话时只解析一次文件", async () => {
    const sessionId = "concurrent-session";
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { content: "hello" },
        uuid: "msg-1",
        timestamp: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "world", model: "claude-opus-4-7" },
        uuid: "msg-2",
        timestamp: new Date("2026-04-19T00:00:01.000Z").toISOString(),
      }),
    ].join("\n");

    await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

    const [first, second] = await Promise.all([
      reader.getSession(sessionId, "test-project" as UrlProjectId),
      reader.getSession(sessionId, "test-project" as UrlProjectId),
    ]);

    expect(first?.summary.id).toBe(sessionId);
    expect(second?.summary.id).toBe(sessionId);
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });
});
