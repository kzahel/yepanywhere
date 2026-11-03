import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createSessionsRoutes } from "../../src/routes/sessions.js";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import type { StartSessionOptions } from "../../src/sdk/providers/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { Project } from "../../src/supervisor/types.js";

function fixture(executor?: string) {
  const project = {
    id: "proj-removed-target" as UrlProjectId,
    path: "/repo/main",
    name: "repo",
    sessionCount: 0,
    sessionDir: "/sessions/repo",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  } satisfies Project;
  const startSession = vi.fn();
  const resumeSession = vi.fn();
  const readerFactory = vi.fn();
  const routes = createSessionsRoutes({
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as ProjectScanner,
    supervisor: {
      startSession,
      resumeSession,
      getProcessForSession: vi.fn(),
    } as unknown as Supervisor,
    sessionMetadataService: {
      getMetadata: vi.fn(() => ({ executor })),
      getProvider: vi.fn(() => "claude"),
    } as unknown as SessionMetadataService,
    readerFactory,
  });
  return {
    routes,
    project,
    startSession,
    resumeSession,
    readerFactory,
  };
}

function post(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("Removed execution targets", () => {
  it("keeps a retired remote transcript's preview readable without launching", async () => {
    const f = fixture("old-host");
    const getLastAgentExcerpt = vi.fn(
      async () => "Historical assistant output",
    );
    f.readerFactory.mockReturnValue({ getLastAgentExcerpt });
    const response = await f.routes.request(
      `/projects/${f.project.id}/sessions/historical/refresh-preview`,
      post({}),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lastAgentText: "Historical assistant output",
    });
    expect(getLastAgentExcerpt).toHaveBeenCalledWith("historical");
    expect(f.startSession).not.toHaveBeenCalled();
    expect(f.resumeSession).not.toHaveBeenCalled();
  });

  it.each(["resume", "reactivate", "restart", "fork", "clone"])(
    "refuses %s of a saved remote session even when the caller requests local",
    async (action) => {
      const f = fixture("old-host");
      const response = await f.routes.request(
        `/projects/${f.project.id}/sessions/historical/${action}`,
        post({ message: "Continue", executor: null }),
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: "SSH executors have been removed; this session is read-only",
      });
      expect(f.startSession).not.toHaveBeenCalled();

      expect(f.resumeSession).not.toHaveBeenCalled();
    },
  );

  it("refuses SSH at the direct Claude adapter boundary before creating a query", async () => {
    await expect(
      new ClaudeProvider().startSession({
        cwd: "/repo/main",
        executor: "old-host",
      } as StartSessionOptions),
    ).rejects.toThrow("SSH executors have been removed");
  });
});
