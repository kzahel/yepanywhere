import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectReviewSessions } from "../useProjectReviewSessions";

const getGlobalSessions = vi.fn();
const resolveMode = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    getGlobalSessions: (...args: unknown[]) => getGlobalSessions(...args),
  },
}));

vi.mock("../../lib/collectionRequestMode", () => ({
  resolveCollectionRequestMode: (...args: unknown[]) => resolveMode(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const row = (id: string, title?: string) => ({
  id,
  title,
  provider: "claude",
  projectId: "p",
  updatedAt: "2026-11-06T00:00:00.000Z",
});

describe("useProjectReviewSessions", () => {
  beforeEach(() => {
    getGlobalSessions.mockReset();
    resolveMode.mockReset();
  });

  it("offers retained rows before the slow complete walk, then replaces them", async () => {
    const complete = deferred<unknown>();
    resolveMode.mockResolvedValue("retained");
    getGlobalSessions.mockImplementation((params: { summaryMode?: string }) =>
      params.summaryMode === "retained"
        ? Promise.resolve({ sessions: [row("a")], hasMore: false })
        : complete.promise,
    );

    const { result } = renderHook(() => useProjectReviewSessions("p"));
    await waitFor(() =>
      expect(result.current.sessions?.map((s) => s.id)).toEqual(["a"]),
    );

    await act(async () => {
      complete.resolve({
        sessions: [row("a", "Implementing")],
        hasMore: false,
      });
    });
    expect(result.current.sessions?.[0]?.title).toBe("Implementing");
  });

  it("never lets a late retained list overwrite the complete one", async () => {
    const retained = deferred<unknown>();
    resolveMode.mockResolvedValue("retained");
    getGlobalSessions.mockImplementation((params: { summaryMode?: string }) =>
      params.summaryMode === "retained"
        ? retained.promise
        : Promise.resolve({ sessions: [row("a", "Full")], hasMore: false }),
    );

    const { result } = renderHook(() => useProjectReviewSessions("p"));
    await waitFor(() =>
      expect(result.current.sessions?.[0]?.title).toBe("Full"),
    );
    await act(async () => {
      retained.resolve({ sessions: [row("stale")], hasMore: false });
    });
    expect(result.current.sessions?.map((s) => s.id)).toEqual(["a"]);
  });

  it("skips the retained read when the server lacks the capability", async () => {
    resolveMode.mockResolvedValue("complete");
    getGlobalSessions.mockResolvedValue({
      sessions: [row("a")],
      hasMore: false,
    });

    const { result } = renderHook(() => useProjectReviewSessions("p"));
    await waitFor(() => expect(result.current.sessions).not.toBeNull());
    expect(getGlobalSessions).toHaveBeenCalledTimes(1);
    expect(getGlobalSessions.mock.calls[0]?.[0]).not.toHaveProperty(
      "summaryMode",
    );
  });
});
