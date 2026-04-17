import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";

describe("Codex session file index persistence", () => {
  let testRoot: string;
  let sessionsDir: string;
  let dataDir: string;

  beforeEach(async () => {
    testRoot = join(tmpdir(), `codex-session-file-index-${randomUUID()}`);
    sessionsDir = join(testRoot, "sessions");
    dataDir = join(testRoot, "data");
    await mkdir(join(sessionsDir, "2026", "04", "17"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("reuses persisted session file metadata across reader instances", async () => {
    const now = new Date().toISOString();
    const projectA = "C:/work/project-a";
    const projectB = "C:/work/project-b";

    await writeFile(
      join(sessionsDir, "2026", "04", "17", "rollout-a.jsonl"),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: "session-a",
            cwd: projectA,
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "hello from project a",
          },
        }),
      ].join("\n")}\n`,
    );

    await writeFile(
      join(sessionsDir, "2026", "04", "17", "rollout-b.jsonl"),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: "session-b",
            cwd: projectB,
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "hello from project b",
          },
        }),
      ].join("\n")}\n`,
    );

    const readerA1 = new CodexSessionReader({
      sessionsDir,
      projectPath: projectA,
      dataDir,
    });
    const filesA1 = await readerA1.listSessionFiles(sessionsDir);
    expect(filesA1.map((file) => file.sessionId)).toEqual(["session-a"]);

    const readerB1 = new CodexSessionReader({
      sessionsDir,
      projectPath: projectB,
      dataDir,
    });
    const filesB1 = await readerB1.listSessionFiles(sessionsDir);
    expect(filesB1.map((file) => file.sessionId)).toEqual(["session-b"]);

    const readerA2 = new CodexSessionReader({
      sessionsDir,
      projectPath: projectA,
      dataDir,
    });

    (
      CodexSessionReader as unknown as {
        sharedScanCache: Map<string, unknown>;
      }
    ).sharedScanCache.clear();

    const findJsonlFilesSpy = vi.spyOn(
      CodexSessionReader.prototype as unknown as {
        findJsonlFiles(dir: string): Promise<string[]>;
      },
      "findJsonlFiles",
    );

    const filesA2 = await readerA2.listSessionFiles(sessionsDir);

    expect(filesA2.map((file) => file.sessionId)).toEqual(["session-a"]);
    expect(findJsonlFilesSpy).not.toHaveBeenCalled();
  });
});
