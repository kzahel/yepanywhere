import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { emitProjectsChanged } from "../../lib/projectEvents";
import { useRecentSessions } from "../useRecentSessions";

vi.mock("../../api/client", () => ({
  api: {
    getRecents: vi.fn(),
    recordVisit: vi.fn(),
    clearRecents: vi.fn(),
  },
}));

describe("useRecentSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches recent sessions when projects changed is emitted", async () => {
    const getRecents = vi.mocked(api.getRecents);
    getRecents
      .mockResolvedValueOnce({
        recents: [
          {
            sessionId: "s1",
            projectId: "p1",
            visitedAt: "2026-04-18T00:00:00.000Z",
            title: "session one",
            projectName: "one",
            provider: "claude",
          },
        ],
      })
      .mockResolvedValueOnce({
        recents: [],
      });

    const { result } = renderHook(() => useRecentSessions());

    await waitFor(() => {
      expect(result.current.recentSessions).toHaveLength(1);
    });

    await act(async () => {
      emitProjectsChanged();
    });

    await waitFor(() => {
      expect(result.current.recentSessions).toHaveLength(0);
    });

    expect(getRecents).toHaveBeenCalledTimes(2);
  });
});
