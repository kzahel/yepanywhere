import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

describe("api.updateServerSettings", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          serviceWorkerEnabled: true,
          persistRemoteSessionsToDisk: false,
        },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes undefined setting values as null so clears reach the server", async () => {
    await api.updateServerSettings({
      globalInstructions: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ globalInstructions: null }));
  });
});

describe("api.deleteProject", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        removed: true,
        projectId: "proj-123",
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a DELETE request to the project endpoint", async () => {
    await api.deleteProject("proj-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-123",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });
});

describe("api.hiddenProjects", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            id: "proj-123",
            name: "project-one",
            path: "C:/code/project-one",
            hiddenAt: "2026-04-18T00:00:00.000Z",
          },
        ],
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the hidden projects list", async () => {
    await api.getHiddenProjects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/hidden",
      expect.any(Object),
    );
  });

  it("posts to restore a hidden project", async () => {
    await api.restoreProject("proj-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-123/restore",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
