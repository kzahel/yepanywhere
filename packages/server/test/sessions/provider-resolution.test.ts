import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  findSessionListSummaryAcrossProviders,
  findSessionSummaryAcrossProviders,
  getSessionSourceForProvider,
  getSessionSources,
  listSessionListSummariesAcrossProviders,
  listSessionsAcrossProviders,
} from "../../src/sessions/provider-resolution.js";
import type { ISessionIndexService } from "../../src/indexes/types.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { MergedSessionReader } from "../../src/sessions/merged-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

describe("provider resolution", () => {
  it("uses an OpenCode reader when metadata prefers opencode", async () => {
    const projectId = "proj-1" as UrlProjectId;
    const summary: SessionSummary = {
      id: "ses_opencode",
      projectId,
      title: "OpenCode",
      fullTitle: "OpenCode",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      messageCount: 2,
      ownership: { owner: "none" },
      provider: "opencode",
    };
    const claudeReader = makeReader(null);
    const opencodeReader = makeReader(summary);
    const readerFactory = vi.fn((project: Project) =>
      project.provider === "opencode" ? opencodeReader : claudeReader,
    );

    const resolved = await findSessionSummaryAcrossProviders(
      {
        id: projectId,
        path: "/tmp/project",
        name: "project",
        sessionCount: 1,
        sessionDir: "/tmp/project/.claude-sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      },
      "ses_opencode",
      projectId,
      { readerFactory },
      "opencode",
    );

    expect(resolved?.source.provider).toBe("opencode");
    expect(resolved?.summary).toBe(summary);
    expect(readerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencode" }),
    );
  });

  it("uses the session index when resolving one summary", async () => {
    const projectId = "proj-indexed" as UrlProjectId;
    const summary: SessionSummary = {
      id: "session-indexed",
      projectId,
      title: "Indexed",
      fullTitle: "Indexed",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "claude",
    };
    const reader = makeReader(null);
    const sessionIndexService = makeSessionIndexService(summary);

    const resolved = await findSessionSummaryAcrossProviders(
      {
        id: projectId,
        path: "/tmp/indexed",
        name: "indexed",
        sessionCount: 1,
        sessionDir: "/tmp/indexed/.claude-sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      },
      "session-indexed",
      projectId,
      {
        readerFactory: vi.fn(() => reader),
        sessionIndexService,
      },
      "claude",
    );

    expect(resolved?.summary).toBe(summary);
    expect(sessionIndexService.getSessionSummaryWithCache).toHaveBeenCalledWith(
      "/tmp/indexed/.claude-sessions",
      projectId,
      "session-indexed",
      reader,
    );
    expect(reader.getSessionSummary).not.toHaveBeenCalled();
  });

  it("keeps typed list-summary resolution on the cheap reader path", async () => {
    const projectId = "proj-head" as UrlProjectId;
    const summary: SessionSummary = {
      id: "session-head",
      projectId,
      title: "Head",
      fullTitle: "Head",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "codex",
    };
    const reader = makeReader(summary);
    reader.getSessionListSummary = vi.fn(async () => ({
      id: summary.id,
      projectId,
      title: summary.title,
      fullTitle: summary.fullTitle,
      updatedAt: summary.updatedAt,
      provider: summary.provider,
    }));
    const sessionIndexService = makeSessionIndexService(null);

    const resolved = await findSessionListSummaryAcrossProviders(
      {
        id: projectId,
        path: "/tmp/head",
        name: "head",
        sessionCount: 1,
        sessionDir: "/tmp/head/.codex-sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      },
      "session-head",
      projectId,
      {
        readerFactory: vi.fn(() => reader),
        codexSessionsDir: "/tmp/head/.codex-sessions",
        codexReaderFactory: vi.fn(
          () => reader as unknown as CodexSessionReader,
        ),
        sessionIndexService,
      },
      "codex",
    );

    expect(resolved?.summary).toEqual({
      id: "session-head",
      projectId,
      title: "Head",
      fullTitle: "Head",
      updatedAt: "2026-06-01T00:01:00.000Z",
      provider: "codex",
    });
    expect(reader.getSessionListSummary).toHaveBeenCalledWith(
      "session-head",
      projectId,
      undefined,
    );
    expect(reader.getSessionSummary).not.toHaveBeenCalled();
    expect(sessionIndexService.getCachedSessionSummary).toHaveBeenCalledWith(
      "/tmp/head/.codex-sessions",
      projectId,
      "session-head",
      reader,
    );
    expect(
      sessionIndexService.getSessionSummaryWithCache,
    ).not.toHaveBeenCalled();
  });

  it("keeps lightweight list results out of the complete index path", async () => {
    const projectId = "proj-list" as UrlProjectId;
    const cachedSummary: SessionSummary = {
      id: "cached-session",
      projectId,
      title: "Cached title",
      fullTitle: "Cached full title",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:02:00.000Z",
      messageCount: 442,
      ownership: { owner: "none" },
      provider: "codex",
      model: "late-model",
      lastAgentText: "Complete tail",
      asyncQuestions: { questions: [], omitted: false },
    };
    const reader = makeReader(null);
    reader.listSessionFiles = vi.fn(async () => [
      {
        sessionId: cachedSummary.id,
        filePath: `/tmp/list/${cachedSummary.id}.jsonl`,
      },
      {
        sessionId: "dirty-session",
        filePath: "/tmp/list/dirty-session.jsonl",
      },
    ]);
    reader.getSessionListSummary = vi.fn(async (sessionId) => ({
      id: sessionId,
      projectId,
      title: "Bounded title",
      fullTitle: "Bounded full title",
      updatedAt: "2026-06-01T00:03:00.000Z",
      provider: "codex",
    }));
    const sessionIndexService = makeSessionIndexService(null);
    vi.mocked(sessionIndexService.getCachedSessionSummary).mockImplementation(
      async (_dir, _projectId, sessionId) =>
        sessionId === cachedSummary.id ? cachedSummary : null,
    );

    const sessions = await listSessionListSummariesAcrossProviders(
      {
        id: projectId,
        path: "/tmp/list",
        name: "list",
        sessionCount: 2,
        sessionDir: "/tmp/list",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      },
      {
        // Antigravity's always-listed native source gets its own empty reader.
        readerFactory: vi.fn((project) =>
          project.provider === "antigravity" ? makeReader(null) : reader,
        ),
        sessionIndexService,
      },
    );

    expect(sessions).toEqual([
      {
        id: "dirty-session",
        projectId,
        title: "Bounded title",
        fullTitle: "Bounded full title",
        updatedAt: "2026-06-01T00:03:00.000Z",
        provider: "codex",
      },
      {
        id: "cached-session",
        projectId,
        title: "Cached title",
        fullTitle: "Cached full title",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:02:00.000Z",
        provider: "codex",
        asyncQuestions: { questions: [], omitted: false },
      },
    ]);
    expect(reader.getSessionListSummary).toHaveBeenCalledTimes(1);
    expect(reader.getSessionSummary).not.toHaveBeenCalled();
    expect(sessionIndexService.getSessionsWithCache).not.toHaveBeenCalledWith(
      "/tmp/list",
      projectId,
      reader,
      undefined,
    );
    expect(sessions[1]).not.toHaveProperty("messageCount");
    expect(sessions[1]).not.toHaveProperty("model");
    expect(sessions[1]).not.toHaveProperty("lastAgentText");
  });

  it("carries the indexed hint through a merged reader's roots", async () => {
    const projectId = "proj-merged" as UrlProjectId;
    // A sandboxed Codex project reads through MergedSessionReader, so the hint
    // the index supplies has to survive the extra hop.
    const cachedSummary: SessionSummary = {
      id: "session-sandboxed",
      projectId,
      title: "Cached title",
      fullTitle: "Cached full title",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:02:00.000Z",
      messageCount: 7,
      ownership: { owner: "none" },
      provider: "codex",
    };
    const inner = makeReader(null);
    inner.getSessionListSummary = vi.fn(
      async (sessionId, resolvedProjectId) => ({
        id: sessionId,
        projectId: resolvedProjectId,
        title: "Bounded title",
        fullTitle: "Bounded full title",
        updatedAt: "2026-06-01T00:03:00.000Z",
        provider: "codex" as const,
      }),
    );
    const merged = new MergedSessionReader([inner]);
    const sessionIndexService = makeSessionIndexService(cachedSummary);

    const resolved = await findSessionListSummaryAcrossProviders(
      {
        id: projectId,
        path: "/tmp/sandboxed",
        name: "sandboxed",
        sessionCount: 1,
        sessionDir: "/tmp/sandboxed/.codex-sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "codex",
      },
      "session-sandboxed",
      projectId,
      {
        readerFactory: vi.fn(() => merged),
        codexSessionsDir: "/tmp/sandboxed/.codex-sessions",
        codexReaderFactory: vi.fn(
          () => merged as unknown as CodexSessionReader,
        ),
        sessionIndexService,
      },
      "codex",
    );

    expect(resolved?.summary).toEqual({
      id: "session-sandboxed",
      projectId,
      title: "Bounded title",
      fullTitle: "Bounded full title",
      updatedAt: "2026-06-01T00:03:00.000Z",
      provider: "codex",
    });
    expect(inner.getSessionListSummary).toHaveBeenCalledWith(
      "session-sandboxed",
      projectId,
      {
        id: "session-sandboxed",
        projectId,
        title: "Cached title",
        fullTitle: "Cached full title",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:02:00.000Z",
        provider: "codex",
      },
      undefined,
    );
  });

  it("lists OpenCode sessions for a project whose primary provider is Claude", async () => {
    const projectId = "proj-2" as UrlProjectId;
    const opencodeSummary: SessionSummary = {
      id: "ses_oc_listed",
      projectId,
      title: "OpenCode in a Claude project",
      fullTitle: "OpenCode in a Claude project",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:00.000Z",
      messageCount: 3,
      ownership: { owner: "none" },
      provider: "opencode",
    };
    const emptyReader = makeReader(null);
    const opencodeReader = makeReader(opencodeSummary);
    const readerFactory = vi.fn((project: Project) =>
      project.provider === "opencode" ? opencodeReader : emptyReader,
    );

    const deps = {
      readerFactory,
      // Stub grok so the source list stays hermetic (no real ~/.grok read).
      grokReaderFactory: () => emptyReader,
    } as unknown as Parameters<typeof listSessionsAcrossProviders>[1];

    const sessions = await listSessionsAcrossProviders(
      {
        id: projectId,
        path: "/tmp/project2",
        name: "project2",
        sessionCount: 0,
        sessionDir: "/tmp/project2/.claude-sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      },
      deps,
    );

    // OpenCode is now a candidate source for every project, so its sessions
    // surface even when the project's primary provider is Claude.
    expect(sessions.map((s) => s.id)).toContain("ses_oc_listed");
    expect(readerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencode" }),
    );
  });
});

describe("session source for one provider", () => {
  const claudeProject: Project = {
    id: "proj-one-provider" as UrlProjectId,
    path: "/tmp/one-provider",
    name: "one-provider",
    sessionCount: 0,
    sessionDir: "/tmp/one-provider/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };

  function claudeOnlyDeps(reader: ISessionReader) {
    // No Codex sessions dir or factory, so the Codex group has no reader here.
    // Grok and pi are stubbed to keep the source list off the real home dir.
    return {
      readerFactory: vi.fn(() => reader),
      grokReaderFactory: () => reader,
      piReaderFactory: () => reader,
    } as unknown as Parameters<typeof getSessionSourceForProvider>[1];
  }

  it("reads a Claude-family session with the project's own reader", () => {
    const claudeReader = makeReader(null);

    const source = getSessionSourceForProvider(
      claudeProject,
      claudeOnlyDeps(claudeReader),
      "claude-gateway",
    );

    expect(source?.reader).toBe(claudeReader);
  });

  it("returns no source when the provider has no reader in this project", () => {
    const claudeReader = makeReader(null);
    const deps = claudeOnlyDeps(claudeReader);

    expect(
      getSessionSourceForProvider(claudeProject, deps, "codex"),
    ).toBeNull();
    // The ordered candidate list still answers with another provider's reader,
    // which is why asking for one provider may not read from that list.
    expect(getSessionSources(claudeProject, deps, "codex")[0]?.reader).toBe(
      claudeReader,
    );
  });

  it("returns no source for a name that belongs to no provider", () => {
    const claudeReader = makeReader(null);

    expect(
      getSessionSourceForProvider(
        claudeProject,
        claudeOnlyDeps(claudeReader),
        "not-a-provider",
      ),
    ).toBeNull();
  });
});

function makeReader(summary: SessionSummary | null): ISessionReader {
  return {
    listSessions: vi.fn(async () => (summary ? [summary] : [])),
    getSessionSummary: vi.fn(async () => summary),
    getSession: vi.fn(async () => null),
    getSessionSummaryIfChanged: vi.fn(async () => null),
    getAgentMappings: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => null),
  };
}

function makeSessionIndexService(
  summary: SessionSummary | null,
): ISessionIndexService {
  return {
    initialize: vi.fn(async () => {}),
    getSessionsWithCache: vi.fn(async () => (summary ? [summary] : [])),
    getSessionSummaryWithCache: vi.fn(async () => summary),
    getCachedSessionSummary: vi.fn(async () => summary),
    getSessionTitle: vi.fn(async () => summary?.title ?? null),
    invalidateSession: vi.fn(),
    clearCache: vi.fn(),
  };
}
