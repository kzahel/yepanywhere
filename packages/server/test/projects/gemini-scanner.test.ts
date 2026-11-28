import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiSessionScanner } from "../../src/projects/gemini-scanner.js";

function makeGeminiSession(
  sessionId: string,
  projectHash: string,
  messages: Array<{ type: "user" | "gemini"; content: string }> = [],
): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    sessionId,
    projectHash,
    startTime: now,
    lastUpdated: now,
    messages: messages.map((m, i) => ({
      id: `msg-${i}`,
      timestamp: now,
      type: m.type,
      content: m.content,
    })),
  });
}

describe("GeminiSessionScanner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers sessions from project-hash/chats/ directory structure", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const projectHash = "abc123def456";
    const chatsDir = join(sessionsDir, projectHash, "chats");
    await mkdir(chatsDir, { recursive: true });

    const sessionId = randomUUID();
    await writeFile(
      join(chatsDir, `session-${sessionId}.json`),
      makeGeminiSession(sessionId, projectHash, [
        { type: "user", content: "hello" },
        { type: "gemini", content: "hi there" },
      ]),
    );

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toHaveProperty("provider", "gemini");
    expect(projects[0]).toHaveProperty("sessionCount", 1);
    expect(projects[0]).toHaveProperty("sessionCountsByProvider", {
      gemini: 1,
    });
  });

  it("groups sessions from the same project directory", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const projectHash = "same-project-hash";
    const chatsDir = join(sessionsDir, projectHash, "chats");
    await mkdir(chatsDir, { recursive: true });

    const id1 = randomUUID();
    const id2 = randomUUID();
    await writeFile(
      join(chatsDir, `session-${id1}.json`),
      makeGeminiSession(id1, projectHash),
    );
    await writeFile(
      join(chatsDir, `session-${id2}.json`),
      makeGeminiSession(id2, projectHash),
    );

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toHaveProperty("sessionCount", 2);
  });

  it("discovers sessions from slug-based directories (Gemini ≥ v0.29)", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    // Newer Gemini CLI uses human-readable slugs instead of hashes
    const slugDir = "my-cool-project";
    const chatsDir = join(sessionsDir, slugDir, "chats");
    await mkdir(chatsDir, { recursive: true });

    const sessionId = randomUUID();
    const realHash = "deadbeef12345678";
    await writeFile(
      join(chatsDir, `session-${sessionId}.json`),
      makeGeminiSession(sessionId, realHash),
    );

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toHaveProperty("sessionCount", 1);
  });

  it("skips invalid JSON files", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const chatsDir = join(sessionsDir, "some-project", "chats");
    await mkdir(chatsDir, { recursive: true });

    await writeFile(join(chatsDir, "session-bad.json"), "not valid json {{{");

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("skips files that don't match session-*.json pattern", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    const chatsDir = join(sessionsDir, "some-project", "chats");
    await mkdir(chatsDir, { recursive: true });

    // This file doesn't match the session-*.json pattern
    await writeFile(
      join(chatsDir, "config.json"),
      makeGeminiSession(randomUUID(), "hash123"),
    );

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("returns empty when sessions directory does not exist", async () => {
    const scanner = new GeminiSessionScanner({
      sessionsDir: join(tmpdir(), `nonexistent-${randomUUID()}`),
    });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });

  it.each(["file", "full"])(
    "preserves %s invalidation during a shared acquisition",
    async (invalidation) => {
      const sessionsDir = join(tmpdir(), `gemini-race-${randomUUID()}`);
      tempDirs.push(sessionsDir);
      const chatsDir = join(sessionsDir, "project", "chats");
      await mkdir(chatsDir, { recursive: true });
      const file = join(chatsDir, "session-one.json");
      await writeFile(file, makeGeminiSession("before", "project-hash"));
      const scanner = new GeminiSessionScanner({ sessionsDir });
      const internals = scanner as unknown as {
        readSessionMeta: (file: string, dir: string) => Promise<unknown>;
      };
      const read = internals.readSessionMeta.bind(scanner);
      let release!: () => void;
      let signal!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const reads = vi
        .spyOn(internals, "readSessionMeta")
        .mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          signal();
          await gate;
          return result;
        });
      const first = scanner.getSessionsForProject("gemini:project-hash");
      await started;
      const followers = Array.from({ length: 10 }, () =>
        scanner.getSessionsForProject("gemini:project-hash"),
      );
      try {
        expect(reads).toHaveBeenCalledTimes(1);
        await writeFile(file, makeGeminiSession("after", "project-hash"));
        scanner.invalidateCache(invalidation === "file" ? file : undefined);
      } finally {
        release();
        await first;
      }
      const results = await Promise.all(followers);
      for (const sessions of results) {
        expect(sessions.map((session) => session.id)).toEqual(["after"]);
      }
      expect(reads).toHaveBeenCalledTimes(2);
      expect(
        (await scanner.getSessionsForProject("gemini:project-hash")).map(
          (session) => session.id,
        ),
      ).toEqual(["after"]);
    },
  );

  it("handles project directories without chats/ subdirectory", async () => {
    const sessionsDir = join(tmpdir(), `gemini-scan-${randomUUID()}`);
    tempDirs.push(sessionsDir);

    // Create a project directory without a chats/ subdirectory
    await mkdir(join(sessionsDir, "no-chats-project"), { recursive: true });

    const scanner = new GeminiSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(0);
  });
});
