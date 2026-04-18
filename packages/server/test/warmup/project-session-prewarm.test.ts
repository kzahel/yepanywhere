import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/supervisor/types.js";
import { prewarmProjectSessions } from "../../src/warmup/project-session-prewarm.js";

function createProject(
  id: string,
  path: string,
  lastActivity: string | null,
): Project {
  return {
    id: id as Project["id"],
    path,
    name: path.split("/").pop() ?? path,
    sessionCount: 1,
    sessionDir: `/sessions/${id}`,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity,
    provider: "claude",
    hasCodexSessions: false,
    hasGeminiSessions: false,
  };
}

describe("prewarmProjectSessions", () => {
  it("warms the most recent projects with one shared provider catalog", async () => {
    const projects = [
      createProject("old", "/work/old", "2026-04-15T00:00:00.000Z"),
      createProject("new", "/work/new", "2026-04-17T00:00:00.000Z"),
      createProject("mid", "/work/mid", "2026-04-16T00:00:00.000Z"),
    ];
    const providerCatalog = { codexPaths: new Set<string>(), geminiPaths: new Set<string>() };

    const buildProviderCatalog = vi.fn(async () => providerCatalog);
    const warmProject = vi.fn(async () => {});

    await prewarmProjectSessions({
      listProjects: async () => projects,
      buildProviderCatalog,
      warmProject,
      limit: 2,
    });

    expect(buildProviderCatalog).toHaveBeenCalledTimes(1);
    expect(buildProviderCatalog).toHaveBeenCalledWith(projects);
    expect(warmProject).toHaveBeenCalledTimes(2);
    expect(warmProject.mock.calls[0]?.[0].id).toBe("new");
    expect(warmProject.mock.calls[1]?.[0].id).toBe("mid");
    expect(warmProject.mock.calls[0]?.[1]).toBe(providerCatalog);
    expect(warmProject.mock.calls[1]?.[1]).toBe(providerCatalog);
  });

  it("continues warming later projects after an earlier failure", async () => {
    const projects = [
      createProject("first", "/work/first", "2026-04-17T00:00:00.000Z"),
      createProject("second", "/work/second", "2026-04-16T00:00:00.000Z"),
    ];

    const warmProject = vi
      .fn<Parameters<NonNullable<Parameters<typeof prewarmProjectSessions>[0]["warmProject"]>>, ReturnType<NonNullable<Parameters<typeof prewarmProjectSessions>[0]["warmProject"]>>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    await prewarmProjectSessions({
      listProjects: async () => projects,
      buildProviderCatalog: async () => ({
        codexPaths: new Set<string>(),
        geminiPaths: new Set<string>(),
      }),
      warmProject,
      limit: 2,
    });

    expect(warmProject).toHaveBeenCalledTimes(2);
    expect(warmProject.mock.calls[1]?.[0].id).toBe("second");
  });

  it("prioritizes recent and frequently visited projects ahead of pure lastActivity ordering", async () => {
    const projects = [
      createProject("cold", "/work/cold", "2026-04-17T00:00:00.000Z"),
      createProject(
        "playgrounds",
        "/work/playgrounds",
        "2026-04-15T00:00:00.000Z",
      ),
      createProject("ghost", "/work/ghost", "2026-04-16T00:00:00.000Z"),
    ];

    const warmed: string[] = [];

    await prewarmProjectSessions({
      listProjects: async () => projects,
      buildProviderCatalog: async () => ({
        codexPaths: new Set<string>(),
        geminiPaths: new Set<string>(),
      }),
      warmProject: async (project) => {
        warmed.push(project.id);
      },
      recentProjectIds: ["playgrounds", "ghost", "playgrounds"],
      limit: 2,
    });

    expect(warmed).toEqual(["playgrounds", "ghost"]);
  });
});
