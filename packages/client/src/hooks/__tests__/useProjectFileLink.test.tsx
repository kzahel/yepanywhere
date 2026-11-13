import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectFileLink } from "../useProjectFileLink";

const draft = { id: toUrlProjectId("/home/u/draft"), path: "/home/u/draft" };
const agents = { id: toUrlProjectId("/home/u/agents"), path: "/home/u/agents" };
const mocks = vi.hoisted(() => ({
  runtime: {} as Record<string, unknown>,
}));
vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => mocks.runtime,
}));
vi.mock("../../contexts/PublicShareContext", () => ({
  usePublicShareContext: () => null,
}));
vi.mock("../useVersion", () => ({
  useRetainedVersionInfo: () => ({ capabilities: ["project-service"] }),
}));

const fetched: string[] = [];
mocks.runtime = {
  sourceKey: "local",
  transport: {
    fetch: async (url: string) => {
      fetched.push(url);
      const host = url.includes(encodeURIComponent(agents.id))
        ? "agents"
        : "draft";
      return {
        fileLinks: {
          baseUrl: `https://${host}.example/?ya_access=t`,
          pathTemplate: "/{path}",
        },
      };
    },
  },
  summary: {
    getSnapshot: () => ({
      projects: { entities: new Map([draft, agents].map((p) => [p.id, p])) },
    }),
  },
};

afterEach(() => {
  cleanup();
  fetched.length = 0;
});

it("links a file under another registered project to that project's app", async () => {
  const { result } = renderHook(() =>
    useProjectFileLink({
      projectId: draft.id,
      path: "/home/u/agents/topics/a b.md",
    }),
  );
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current).toBe(
    "https://agents.example/topics/a%20b.md?ya_access=t",
  );
  expect(fetched).toEqual([`/projects/${encodeURIComponent(agents.id)}/app`]);
});

it("keeps relative paths on the viewing project", async () => {
  const { result } = renderHook(() =>
    useProjectFileLink({ projectId: draft.id, path: "./notes/x.md" }),
  );
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current).toBe("https://draft.example/notes/x.md?ya_access=t");
});
