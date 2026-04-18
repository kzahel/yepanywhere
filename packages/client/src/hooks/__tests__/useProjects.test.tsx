import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { emitProjectsChanged } from "../../lib/projectEvents";
import { useProjects } from "../useProjects";

vi.mock("../../api/client", () => ({
  api: {
    getProjects: vi.fn(),
  },
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: () => {},
}));

describe("useProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches when projects changed is emitted", async () => {
    const getProjects = vi.mocked(api.getProjects);
    getProjects
      .mockResolvedValueOnce({
        projects: [
          {
            id: "p1",
            path: "C:/one",
            name: "one",
            sessionCount: 1,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        projects: [
          {
            id: "p2",
            path: "C:/two",
            name: "two",
            sessionCount: 2,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          },
        ],
      });

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.projects[0]?.id).toBe("p1");
    });

    await act(async () => {
      emitProjectsChanged();
    });

    await waitFor(() => {
      expect(result.current.projects[0]?.id).toBe("p2");
    });

    expect(getProjects).toHaveBeenCalledTimes(2);
  });
});
