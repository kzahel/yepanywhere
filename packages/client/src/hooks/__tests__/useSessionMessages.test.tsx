import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { primeSessionLoadCache } from "../../lib/sessionLoadCache";
import { useSessionMessages } from "../useSessionMessages";

vi.mock("../../api/client", () => ({
  api: {
    getSession: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSessionMessages", () => {
  it("preserves newer stream messages when a cached load is refreshed by an older network snapshot", async () => {
    const projectId = "project-cached-race";
    const sessionId = "session-cached-race";
    const networkLoad = deferred<{
      session: { id: string; provider: "claude" };
      messages: Array<Record<string, unknown>>;
      ownership: { owner: "self"; processId: string };
      pagination: { hasMoreBefore: false };
    }>();

    vi.mocked(api.getSession).mockReturnValueOnce(networkLoad.promise as never);

    primeSessionLoadCache(projectId, sessionId, {
      session: { id: sessionId, provider: "claude" } as never,
      messages: [
        {
          uuid: "jsonl-1",
          type: "assistant",
          message: { role: "assistant", content: "cached" },
        } as never,
      ],
      ownership: { owner: "self", processId: "process-1" },
      pagination: { hasMoreBefore: false } as never,
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId,
        sessionId,
      }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.messages).toHaveLength(1);
    });

    act(() => {
      result.current.handleStreamMessageEvent({
        uuid: "stream-2",
        type: "assistant",
        message: { role: "assistant", content: "stream fresh" },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.uuid)).toContain(
        "stream-2",
      );
    });

    await act(async () => {
      networkLoad.resolve({
        session: { id: sessionId, provider: "claude" },
        messages: [
          {
            uuid: "jsonl-1",
            type: "assistant",
            message: { role: "assistant", content: "cached" },
          },
        ],
        ownership: { owner: "self", processId: "process-1" },
        pagination: { hasMoreBefore: false },
      });
      await networkLoad.promise;
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.uuid)).toEqual(
        expect.arrayContaining(["jsonl-1", "stream-2"]),
      );
    });
  });
});
