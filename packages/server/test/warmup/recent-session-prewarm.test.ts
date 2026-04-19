import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { RecentEntry } from "../../src/recents/RecentsService.js";
import type { ISessionReader, LoadedSession } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";
import { prewarmRecentSessions } from "../../src/warmup/recent-session-prewarm.js";

function createProject(id: UrlProjectId, path = "/tmp/project"): Project {
  return {
    id,
    path,
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createRecentEntry(
  sessionId: string,
  projectId: UrlProjectId,
  visitedAt: string,
): RecentEntry {
  return {
    sessionId,
    projectId,
    visitedAt,
  };
}

function createLoadedSession(sessionId: string, projectId: UrlProjectId): LoadedSession {
  return {
    summary: {
      id: sessionId,
      projectId,
      title: sessionId,
      fullTitle: sessionId,
      createdAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-04-19T00:00:01.000Z").toISOString(),
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "claude",
    },
    data: {
      provider: "claude",
      session: {
        messages: [
          {
            type: "user",
            uuid: `${sessionId}-user`,
            timestamp: new Date("2026-04-19T00:00:00.000Z").toISOString(),
            message: {
              content: "hello",
            },
          },
          {
            type: "assistant",
            uuid: `${sessionId}-assistant`,
            timestamp: new Date("2026-04-19T00:00:01.000Z").toISOString(),
            message: {
              content: "world",
              model: "claude-opus-4-7",
            },
          },
        ],
      },
    } as unknown as LoadedSession["data"],
  };
}

describe("prewarmRecentSessions", () => {
  it("只预热最近且去重后的会话", async () => {
    const projectId = "proj-1" as UrlProjectId;
    const project = createProject(projectId);
    const reader = {
      getSession: vi.fn(async (sessionId: string) =>
        createLoadedSession(sessionId, projectId),
      ),
    } as unknown as ISessionReader;
    const resolveProject = vi.fn(async () => project);

    await prewarmRecentSessions({
      resolveProject,
      providerDeps: {
        readerFactory: () => reader,
      },
      recentEntries: [
        createRecentEntry("sess-new", projectId, "2026-04-19T00:00:03.000Z"),
        createRecentEntry("sess-new", projectId, "2026-04-19T00:00:02.000Z"),
        createRecentEntry("sess-next", projectId, "2026-04-19T00:00:01.000Z"),
        createRecentEntry("sess-skip", projectId, "2026-04-19T00:00:00.000Z"),
      ],
      limit: 2,
    });

    expect(resolveProject).toHaveBeenCalledTimes(2);
    expect(reader.getSession).toHaveBeenCalledTimes(2);
    expect(reader.getSession).toHaveBeenNthCalledWith(
      1,
      "sess-new",
      projectId,
      undefined,
      undefined,
    );
    expect(reader.getSession).toHaveBeenNthCalledWith(
      2,
      "sess-next",
      projectId,
      undefined,
      undefined,
    );
  });

  it("单个会话预热失败后继续后续会话", async () => {
    const projectId = "proj-1" as UrlProjectId;
    const project = createProject(projectId);
    const reader = {
      getSession: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(createLoadedSession("sess-next", projectId)),
    } as unknown as ISessionReader;

    await prewarmRecentSessions({
      resolveProject: async () => project,
      providerDeps: {
        readerFactory: () => reader,
      },
      recentEntries: [
        createRecentEntry("sess-fail", projectId, "2026-04-19T00:00:02.000Z"),
        createRecentEntry("sess-next", projectId, "2026-04-19T00:00:01.000Z"),
      ],
      limit: 2,
    });

    expect(reader.getSession).toHaveBeenCalledTimes(2);
    expect(reader.getSession).toHaveBeenNthCalledWith(
      1,
      "sess-fail",
      projectId,
      undefined,
      undefined,
    );
    expect(reader.getSession).toHaveBeenNthCalledWith(
      2,
      "sess-next",
      projectId,
      undefined,
      undefined,
    );
  });
});
