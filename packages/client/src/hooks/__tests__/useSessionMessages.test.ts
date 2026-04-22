import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Message, Session, UrlProjectId } from "../../types";
import { useSessionMessages } from "../useSessionMessages";

vi.mock("../../api/client", () => ({
  api: {
    getSession: vi.fn(),
    getSessionMetadata: vi.fn(),
  },
}));

vi.mock("../useServerSettings", () => ({
  useServerSettings: vi.fn(),
}));

import { useServerSettings } from "../useServerSettings";

describe("useSessionMessages", () => {
  const projectId = "project-1" as UrlProjectId;
  const mockGetSession = vi.mocked(api.getSession);
  const mockUseServerSettings = vi.mocked(useServerSettings);

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetSession.mockResolvedValue({
      session: {
        id: "session-1",
        projectId,
        title: "Session",
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "claude",
        messages: [],
      } as unknown as Session,
      messages: [
        {
          uuid: "msg-1",
          type: "user",
          message: { role: "user", content: "hello" },
          timestamp: "2026-03-27T00:00:00.000Z",
        },
      ] as Message[],
      ownership: { owner: "none" },
      pagination: undefined,
      pendingInputRequest: null,
      slashCommands: null,
    });
  });

  it("waits for server settings before initial session fetch", async () => {
    mockUseServerSettings.mockReturnValue({
      settings: null,
      isLoading: true,
      error: null,
      updateSetting: vi.fn(),
      refetch: vi.fn(),
    });

    const { rerender } = renderHook(() =>
      useSessionMessages({
        projectId,
        sessionId: "session-1",
      }),
    );

    expect(mockGetSession).not.toHaveBeenCalled();

    mockUseServerSettings.mockReturnValue({
      settings: {
        serviceWorkerEnabled: true,
        persistRemoteSessionsToDisk: false,
        sessionHistoryPaginationMode: "messages",
        sessionHistoryPageSize: 20,
      },
      isLoading: false,
      error: null,
      updateSetting: vi.fn(),
      refetch: vi.fn(),
    });

    rerender();

    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    expect(mockGetSession).toHaveBeenCalledWith(
      projectId,
      "session-1",
      undefined,
      {
        tailMessages: 20,
      },
    );
  });
});
