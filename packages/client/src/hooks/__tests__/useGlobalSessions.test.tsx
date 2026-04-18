import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { emitProjectsChanged } from "../../lib/projectEvents";
import { useGlobalSessions } from "../useGlobalSessions";

vi.mock("../../api/client", () => ({
  api: {
    getGlobalSessions: vi.fn(),
  },
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: () => {},
}));

describe("useGlobalSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refetches sidebar session data when projects changed is emitted", async () => {
    const getGlobalSessions = vi.mocked(api.getGlobalSessions);
    getGlobalSessions
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "s1",
            title: "session one",
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z",
            messageCount: 1,
            provider: "claude",
            projectId: "p1",
            projectName: "one",
            ownership: { owner: "none" },
          },
        ],
        hasMore: false,
        stats: {
          totalCount: 0,
          unreadCount: 0,
          starredCount: 0,
          archivedCount: 0,
          providerCounts: {},
          executorCounts: {},
        },
        projects: [{ id: "p1", name: "one" }],
      })
      .mockResolvedValueOnce({
        sessions: [],
        hasMore: false,
        stats: {
          totalCount: 0,
          unreadCount: 0,
          starredCount: 0,
          archivedCount: 0,
          providerCounts: {},
          executorCounts: {},
        },
        projects: [],
      });

    const { result } = renderHook(() => useGlobalSessions({ limit: 50 }));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      emitProjectsChanged();
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(0);
    });

    expect(getGlobalSessions).toHaveBeenCalledTimes(2);
  });
});
