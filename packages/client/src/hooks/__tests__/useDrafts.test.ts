// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNewSessionDraftKey,
  createQuestionOtherDraftKey,
  createToolApprovalFeedbackDraftKey,
  setsEqual,
  useNewSessionDraft,
  useQuestionOtherDrafts,
  useToolApprovalFeedbackDraft,
} from "../useDrafts";
import { useDraftPersistence } from "../useDraftPersistence";
import {
  createClientSummaryHostSourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";

beforeEach(() => {
  resetClientSummaryStoreForTests();
  const store = new Map<string, string>();
  const localStorageMock = {
    get length() {
      return store.size;
    },
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
});

afterEach(() => {
  cleanup();
  resetClientSummaryStoreForTests();
  vi.clearAllMocks();
});

describe("setsEqual", () => {
  it("returns prev when both sets are empty", () => {
    const prev = new Set<string>();
    const next = new Set<string>();
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns prev when contents are identical", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["a", "b", "c"]);
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns next when an element is added", () => {
    const prev = new Set(["a", "b"]);
    const next = new Set(["a", "b", "c"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when an element is removed", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["a", "b"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when an element is swapped (same size, different content)", () => {
    const prev = new Set(["a", "b"]);
    const next = new Set(["a", "c"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when going from empty to non-empty", () => {
    const prev = new Set<string>();
    const next = new Set(["a"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when going from non-empty to empty", () => {
    const prev = new Set(["a"]);
    const next = new Set<string>();
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns prev for single identical element", () => {
    const prev = new Set(["x"]);
    const next = new Set(["x"]);
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns next when completely disjoint sets of same size", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["x", "y", "z"]);
    expect(setsEqual(prev, next)).toBe(next);
  });
});

describe("useNewSessionDraft", () => {
  it("detects the current source's shared new-session draft key", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });
    localStorage.setItem(
      createNewSessionDraftKey(macbook),
      "draft the migration plan",
    );

    const { result } = renderHook(() => useNewSessionDraft());

    expect(result.current).toBe(true);
  });

  it("keeps new-session drafts invisible across source switches", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");
    localStorage.setItem(createNewSessionDraftKey(macbook), "mac draft");

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    const { result } = renderHook(() => useNewSessionDraft());

    expect(result.current).toBe(false);

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    expect(result.current).toBe(true);
  });

  it("detects project-scoped new-session draft keys within the current source", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });
    localStorage.setItem(
      createNewSessionDraftKey(macbook, "project-1"),
      "draft the fix",
    );

    const { result } = renderHook(() => useNewSessionDraft("project-1"));

    expect(result.current).toBe(true);
  });

  it("detects attachment-only new-session draft envelopes", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });
    localStorage.setItem(
      createNewSessionDraftKey(macbook),
      JSON.stringify({
        version: 1,
        text: "",
        attachments: {
          batchId: "batch-a",
          updatedAt: "2026-06-28T00:00:00.000Z",
          refs: [
            {
              id: "file-a",
              batchId: "batch-a",
              originalName: "screenshot.png",
              name: "uuid_screenshot.png",
              size: 123,
              mimeType: "image/png",
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const { result } = renderHook(() => useNewSessionDraft());

    expect(result.current).toBe(true);
  });

  it("ignores malformed new-session draft envelopes", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });
    localStorage.setItem(createNewSessionDraftKey(macbook), '{"version":1,');

    const { result } = renderHook(() => useNewSessionDraft());

    expect(result.current).toBe(false);
  });

  it("updates from owned same-tab persistence events without polling", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });
    const key = createNewSessionDraftKey(macbook);
    const observed = renderHook(() => useNewSessionDraft());
    const persisted = renderHook(() => useDraftPersistence(key));

    expect(observed.result.current).toBe(false);

    act(() => {
      persisted.result.current[1]("new session draft");
    });
    expect(observed.result.current).toBe(true);

    act(() => {
      persisted.result.current[2].clearDraft();
    });
    expect(observed.result.current).toBe(false);
  });

  it("acknowledges captured creation drafts without a reload and preserves newer drafts", () => {
    const key = createNewSessionDraftKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
    const observed = renderHook(() => useNewSessionDraft());
    const editor = renderHook(() => useDraftPersistence(key));
    act(() => editor.result.current[1]("Submitted request"));
    let captured!: ReturnType<
      NonNullable<(typeof editor.result.current)[2]["captureSubmission"]>
    >;
    act(() => {
      captured = editor.result.current[2].captureSubmission!();
    });
    expect(observed.result.current).toBe(true);
    act(() => {
      expect(captured.confirm()).toBe(true);
    });
    expect(observed.result.current).toBe(false);
    expect(editor.result.current[0]).toBe("");

    act(() => editor.result.current[1]("Another submitted request"));
    act(() => {
      captured = editor.result.current[2].captureSubmission!();
    });
    act(() => editor.result.current[1]("Newer unsent work"));
    act(() => {
      expect(captured.confirm()).toBe(false);
    });
    expect(observed.result.current).toBe(true);
    expect(editor.result.current[0]).toBe("Newer unsent work");
  });
});

describe("useToolApprovalFeedbackDraft", () => {
  it("keeps feedback drafts invisible across source switches", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");
    const sessionId = "session-1";
    localStorage.setItem(
      createToolApprovalFeedbackDraftKey(macbook, sessionId),
      "mac feedback",
    );

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const { result } = renderHook(() =>
      useToolApprovalFeedbackDraft(sessionId),
    );

    expect(result.current[0]).toBe("mac feedback");

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    await waitFor(() => {
      expect(result.current[0]).toBe("");
    });

    act(() => {
      result.current[1]("win feedback");
    });

    expect(
      localStorage.getItem(
        createToolApprovalFeedbackDraftKey(winnative, sessionId),
      ),
    ).toBe("win feedback");
    expect(
      localStorage.getItem(
        createToolApprovalFeedbackDraftKey(macbook, sessionId),
      ),
    ).toBe("mac feedback");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    await waitFor(() => {
      expect(result.current[0]).toBe("mac feedback");
    });
  });
});

describe("useQuestionOtherDrafts", () => {
  it("keeps question other drafts invisible across source switches", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");
    const sessionId = "session-1";
    localStorage.setItem(
      createQuestionOtherDraftKey(macbook, sessionId),
      JSON.stringify({ "Choose deployment": "mac answer" }),
    );

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    const { result } = renderHook(() => useQuestionOtherDrafts(sessionId));

    expect(result.current[0]).toEqual({ "Choose deployment": "mac answer" });

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual({});
    });

    act(() => {
      result.current[1]("Choose deployment", "win answer");
    });

    expect(
      JSON.parse(
        localStorage.getItem(
          createQuestionOtherDraftKey(winnative, sessionId),
        ) ?? "{}",
      ),
    ).toEqual({ "Choose deployment": "win answer" });
    expect(
      JSON.parse(
        localStorage.getItem(createQuestionOtherDraftKey(macbook, sessionId)) ??
          "{}",
      ),
    ).toEqual({ "Choose deployment": "mac answer" });

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        "Choose deployment": "mac answer",
      });
    });
  });
});
