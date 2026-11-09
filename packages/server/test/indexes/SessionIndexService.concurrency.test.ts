import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { SqliteSessionSummaryIndex } from "../../src/indexes/SqliteSessionSummaryIndex.js";
import { SessionReader } from "../../src/sessions/reader.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

describe("SessionIndexService concurrency", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    closeTestDiscoveryDatabases();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("shares one cold index state across list and single-summary APIs", async () => {
    const testDir = join(tmpdir(), `session-index-load-${randomUUID()}`);
    tempDirs.push(testDir);
    const projectsDir = join(testDir, "projects");
    const sessionDir = join(projectsDir, "project");
    await mkdir(sessionDir, { recursive: true });
    for (const sessionId of ["session-a", "session-b"]) {
      await writeFile(
        join(sessionDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          message: { content: sessionId },
          uuid: `message-${sessionId}`,
          timestamp: "2026-08-24T12:00:00.000Z",
        })}\n`,
      );
    }

    const service = new SessionIndexService({
      database: openTestDiscoveryDatabase(testDir),
      dataDir: join(testDir, "indexes"),
      projectsDir,
      fullValidationIntervalMs: 60_000,
    });
    await service.initialize();
    const reader = new SessionReader({ sessionDir });
    const projectId = toUrlProjectId("/project");
    const read = vi.spyOn(SqliteSessionSummaryIndex.prototype, "read");

    const listRequest = service.getSessionsWithCache(
      sessionDir,
      projectId,
      reader,
    );
    const summaryRequest = service.getSessionSummaryWithCache(
      sessionDir,
      projectId,
      "session-a",
      reader,
    );
    expect(await listRequest).toHaveLength(2);
    expect((await summaryRequest)?.id).toBe("session-a");
    expect(
      (await service.getSessionsWithCache(sessionDir, projectId, reader))
        .map((session) => session.id)
        .sort(),
    ).toEqual(["session-a", "session-b"]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
