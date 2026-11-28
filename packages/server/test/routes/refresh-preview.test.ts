import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createSessionsRoutes } from "../../src/routes/sessions.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import type { EventBus } from "../../src/watcher/index.js";
import { stubSessionReader } from "./route-fixtures.js";

const projectId = "proj-preview" as UrlProjectId;

function fixture(reader: Partial<ISessionReader>) {
  const project = {
    id: projectId,
    path: "/repo/main",
    name: "repo",
    sessionCount: 0,
    sessionDir: "/sessions/repo",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "codex",
  } satisfies Project;
  const emit = vi.fn();
  const routes = createSessionsRoutes({
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as ProjectScanner,
    supervisor: {
      getProcessForSession: vi.fn(),
    } as unknown as Supervisor,
    sessionMetadataService: {
      getMetadata: vi.fn(() => ({})),
      getProvider: vi.fn(() => "codex"),
    } as unknown as SessionMetadataService,
    readerFactory: vi.fn(() => stubSessionReader(reader)),
    eventBus: { emit } as unknown as EventBus,
  });
  const refresh = () =>
    routes.request(`/projects/${project.id}/sessions/s1/refresh-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  return { emit, refresh };
}

describe("refresh-preview", () => {
  it("keeps a bounded reader's unknown answer instead of reading the whole history", async () => {
    // A complete read of this session would find prose; the route must not
    // reach it once the bounded reader has answered.
    const summary: SessionSummary = {
      id: "s1",
      projectId,
      provider: "codex",
      title: null,
      fullTitle: null,
      createdAt: "2026-11-14T00:00:00.000Z",
      updatedAt: "2026-11-14T00:00:00.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
    };
    const getSession = vi.fn(
      async (): Promise<LoadedSession> => ({
        summary,
        transcriptSnapshotUpdatedAt: summary.updatedAt,
        data: { provider: "codex", session: { entries: [] } },
        projectedMessages: [
          {
            type: "assistant",
            message: { role: "assistant", content: "Far back prose" },
          },
        ],
      }),
    );
    const { emit, refresh } = fixture({
      getLastAgentExcerpt: vi.fn(async () => undefined),
      getSessionListSummary: vi.fn(async () => summary),
      getSession,
    });
    const response = await refresh();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lastAgentText: null });
    expect(getSession).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("publishes a bounded reader's answer", async () => {
    const { emit, refresh } = fixture({
      getLastAgentExcerpt: vi.fn(async () => "Latest prose"),
    });
    expect(await (await refresh()).json()).toEqual({
      lastAgentText: "Latest prose",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-updated",
        lastAgentText: "Latest prose",
      }),
    );
  });
});
