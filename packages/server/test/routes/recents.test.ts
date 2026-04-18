import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { RecentsService } from "../../src/recents/index.js";
import { createRecentsRoutes } from "../../src/routes/recents.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex recent session",
    fullTitle: "Codex recent session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

describe("Recents Routes", () => {
  it("resolves recent sessions across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "sess-1",
            projectId: "proj-1",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.recents).toHaveLength(1);
    expect(json.recents[0]).toMatchObject({
      sessionId: "sess-1",
      title: "Codex recent session",
      provider: "codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
  });

  it("skips recent entries for hidden projects that are no longer listed", async () => {
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "sess-1",
            projectId: "proj-hidden",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => []),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.recents).toEqual([]);
  });
});
