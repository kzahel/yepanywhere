import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { findLoadedSessionAcrossProviders } from "../../src/sessions/provider-resolution.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createLoadedSession(): LoadedSession {
  return {
    summary: {
      id: "sess-1",
      projectId: "proj-1" as UrlProjectId,
      title: "Session",
      fullTitle: "Session",
      createdAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-04-19T00:00:01.000Z").toISOString(),
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "codex",
    },
    data: {
      session: {
        id: "sess-1",
      },
      messages: [],
    } as unknown as LoadedSession["data"],
  };
}

describe("findLoadedSessionAcrossProviders", () => {
  it("透传读取选项到跨 provider 回退链", async () => {
    const project = createProject();
    const loadedSession = createLoadedSession();
    const primaryReader = {
      getSession: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSession: vi.fn(async () => loadedSession),
    } as unknown as ISessionReader;

    const result = await findLoadedSessionAcrossProviders(
      project,
      "sess-1",
      project.id,
      {
        readerFactory: () => primaryReader,
        codexSessionsDir: "/tmp/codex",
        codexReaderFactory: () => codexReader as never,
      },
      "msg-123",
      undefined,
      undefined,
      { includeOrphans: false },
    );

    expect(primaryReader.getSession).toHaveBeenCalledWith(
      "sess-1",
      project.id,
      "msg-123",
      { includeOrphans: false },
    );
    expect(codexReader.getSession).toHaveBeenCalledWith(
      "sess-1",
      project.id,
      "msg-123",
      { includeOrphans: false },
    );
    expect(result?.loaded).toBe(loadedSession);
    expect(result?.source.provider).toBe("codex");
  });
});
