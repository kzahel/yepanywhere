// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { draftTextIsAccountedFor } from "../../lib/draftSendReconcile";
import type { Message } from "../../types";
import { useDraftPersistence } from "../useDraftPersistence";

function readStoredText(key: string): string | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  return (JSON.parse(raw) as { text?: string }).text ?? null;
}

function readStoredPendingSend(key: string): boolean {
  const raw = window.localStorage.getItem(key);
  if (!raw) return false;
  return (
    typeof (JSON.parse(raw) as { pendingSendAt?: unknown }).pendingSendAt ===
    "number"
  );
}

function readStoredAttachmentCount(key: string): number {
  const raw = window.localStorage.getItem(key);
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { attachments?: { refs?: unknown[] } };
  return parsed.attachments?.refs?.length ?? 0;
}

function installLocalStorageMock(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(() => store.clear()),
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      key: vi.fn((index: number) => [...store.keys()][index] ?? null),
      get length() {
        return store.size;
      },
    },
  });
  return store;
}

describe("useDraftPersistence", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = installLocalStorageMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.clear();
  });

  it("keeps a leading space adopted before passive draft hydration", () => {
    const { result, rerender } = renderHook(
      ({ draftKey }) => {
        const draft = useDraftPersistence(draftKey);
        const setDraft = draft[1];
        useLayoutEffect(() => {
          setDraft(" ");
        }, [setDraft]);
        return draft;
      },
      { initialProps: { draftKey: "early-draft" } },
    );
    expect(result.current[0]).toBe(" ");
    expect(result.current[2].getDraft()).toBe(" ");
    act(() => result.current[1](result.current[0] + "across startup"));
    expect(result.current[0]).toBe(" across startup");
    // A genuinely different draft still hydrates rather than inheriting text.
    rerender({ draftKey: "other-draft" });
    expect(result.current[0]).toBe("");
  });

  it("persists each draft edit immediately", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("still typing");
    });

    expect(readStoredText("draft-test")).toBe("still typing");

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(readStoredText("draft-test")).toBe("still typing");
  });

  it("keeps the explicit flush control harmless for blur handlers", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("blur save");
    });

    expect(readStoredText("draft-test")).toBe("blur save");

    act(() => {
      result.current[2].flushDraft();
    });

    expect(readStoredText("draft-test")).toBe("blur save");
  });

  it("does not let a delayed submission acknowledgement clear a newer draft", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("submitted turn");
      result.current[2].clearInput();
      result.current[1]("next turn draft");
      result.current[2].confirmInputClear();
    });

    expect(result.current[0]).toBe("next turn draft");
    expect(readStoredText("draft-test")).toBe("next turn draft");
  });

  it("acknowledges a captured creation without clearing a newer edit or another slot", () => {
    const { result, rerender } = renderHook(
      ({ draftKey }) => useDraftPersistence(draftKey),
      { initialProps: { draftKey: "creation-slot" } },
    );
    act(() => result.current[1]("submitted prompt"));
    let captured: ReturnType<
      NonNullable<(typeof result.current)[2]["captureSubmission"]>
    >;
    act(() => {
      captured = result.current[2].captureSubmission!();
    });
    act(() => result.current[1]("newer unsent prompt"));
    act(() => captured!.confirm());
    expect(result.current[0]).toBe("newer unsent prompt");
    expect(readStoredText("creation-slot")).toBe("newer unsent prompt");
    act(() => {
      captured = result.current[2].captureSubmission!();
    });
    rerender({ draftKey: "different-slot" });
    act(() => result.current[1]("another slot's text"));
    act(() => captured!.confirm());
    expect(result.current[0]).toBe("another slot's text");
    expect(readStoredText("different-slot")).toBe("another slot's text");
  });

  it("preserves a sibling edit arriving after creation capture and before acknowledgement", () => {
    const { result } = renderHook(() =>
      useDraftPersistence("creation-sibling-slot"),
    );
    act(() => result.current[1]("submitted prompt"));
    let captured: ReturnType<
      NonNullable<(typeof result.current)[2]["captureSubmission"]>
    >;
    act(() => {
      captured = result.current[2].captureSubmission!();
    });
    const newer = JSON.stringify({
      version: 1,
      text: "sibling's unsent prompt",
    });
    act(() => {
      store.set("creation-sibling-slot", newer);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "creation-sibling-slot",
          newValue: newer,
        }),
      );
    });
    act(() => captured!.confirm());
    expect(readStoredText("creation-sibling-slot")).toBe(
      "sibling's unsent prompt",
    );
  });

  it("removes the recovery copy when the cleared input stays empty", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("submitted turn");
      result.current[2].clearInput();
      result.current[2].confirmInputClear();
    });

    expect(result.current[0]).toBe("");
    expect(window.localStorage.getItem("draft-test")).toBe(null);
  });

  it("marks the surviving recovery copy as a pending send", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("submitted turn");
      result.current[2].clearInput();
    });

    expect(result.current[0]).toBe("");
    expect(readStoredText("draft-test")).toBe("submitted turn");
    expect(readStoredPendingSend("draft-test")).toBe(true);
  });

  it("discards a hydrated recovery copy the session already accounts for", () => {
    const { result: sender } = renderHook(() =>
      useDraftPersistence("draft-test"),
    );

    act(() => {
      sender.current[1]("submitted turn");
      sender.current[2].clearInput();
    });

    // A second tab on the same session hydrates the marked recovery copy.
    const { result: sibling } = renderHook(() =>
      useDraftPersistence("draft-test"),
    );
    expect(sibling.current[0]).toBe("submitted turn");

    let discarded = false;
    act(() => {
      discarded = sibling.current[2].discardPendingSendDraft(
        ({ text }) => text === "submitted turn",
      );
    });

    expect(discarded).toBe(true);
    expect(sibling.current[0]).toBe("");
    expect(window.localStorage.getItem("draft-test")).toBe(null);
  });

  it("keeps a recovery copy the session cannot account for", () => {
    const { result: sender } = renderHook(() =>
      useDraftPersistence("draft-test"),
    );

    act(() => {
      sender.current[1]("never landed");
      sender.current[2].clearInput();
    });

    const { result: sibling } = renderHook(() =>
      useDraftPersistence("draft-test"),
    );

    let discarded = true;
    act(() => {
      discarded = sibling.current[2].discardPendingSendDraft(() => false);
    });

    expect(discarded).toBe(false);
    expect(sibling.current[0]).toBe("never landed");
    expect(readStoredText("draft-test")).toBe("never landed");
  });

  it("answers an unmarked draft without reading storage", () => {
    store.set(
      "draft-test",
      JSON.stringify({ version: 1, text: "hydrated draft" }),
    );
    const { result } = renderHook(() => useDraftPersistence("draft-test"));
    expect(result.current[0]).toBe("hydrated draft");

    // The session reconciles on every transcript update, so this is the
    // steady-state cost of a streamed turn.
    const getItem = vi.mocked(window.localStorage.getItem);
    getItem.mockClear();

    let discarded = true;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(() => true);
    });

    expect(discarded).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("learns a sibling tab's recovery marker from the storage event", () => {
    store.set(
      "draft-test",
      JSON.stringify({ version: 1, text: "submitted turn" }),
    );
    // This tab was already open with the shared draft when the other tab sent.
    const { result } = renderHook(() => useDraftPersistence("draft-test"));
    expect(result.current[0]).toBe("submitted turn");

    const marked = JSON.stringify({
      version: 1,
      text: "submitted turn",
      pendingSendAt: Date.now(),
    });
    act(() => {
      store.set("draft-test", marked);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "draft-test",
          newValue: marked,
        }),
      );
    });

    let discarded = false;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(
        ({ text }) => text === "submitted turn",
      );
    });

    expect(discarded).toBe(true);
    expect(result.current[0]).toBe("");
    expect(window.localStorage.getItem("draft-test")).toBe(null);
  });

  it("never discards a draft the user typed or recalled", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("submitted turn");
      result.current[2].clearInput();
      // Composer recall puts an already-sent turn back for deliberate resend.
      result.current[2].setDraft("submitted turn");
    });

    expect(readStoredPendingSend("draft-test")).toBe(false);

    let discarded = true;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(() => true);
    });

    expect(discarded).toBe(false);
    expect(result.current[0]).toBe("submitted turn");
  });

  it("reconciles an untouched recovery copy when delivery is proven after failure", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("submitted turn");
      result.current[2].clearInput();
      result.current[2].restoreFromStorage();
    });

    expect(result.current[0]).toBe("submitted turn");

    let discarded = true;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(() => true);
    });

    expect(discarded).toBe(true);
    expect(result.current[0]).toBe("");
  });

  it("keeps a restored failed send when only an earlier identical prompt was delivered", () => {
    vi.setSystemTime(Date.parse("2026-09-27T12:00:00.000Z"));
    const { result } = renderHook(() => useDraftPersistence("draft-test"));
    const earlierContinue: Message = {
      uuid: "earlier-continue",
      type: "user",
      _source: "jsonl",
      timestamp: "2026-09-27T11:55:00.000Z",
      message: { role: "user", content: "continue" },
    };

    act(() => {
      result.current[1]("continue");
      result.current[2].clearInput();
      // The request failed without delivery; the composer shows it again.
      result.current[2].restoreFromStorage();
    });
    expect(result.current[0]).toBe("continue");

    let discarded = true;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(
        ({ text, sentAtMs }) =>
          draftTextIsAccountedFor({
            draftText: text,
            sentAtMs,
            messages: [earlierContinue],
          }),
      );
    });

    expect(discarded).toBe(false);
    expect(result.current[0]).toBe("continue");
    expect(readStoredText("draft-test")).toBe("continue");

    const deliveredNow: Message = {
      ...earlierContinue,
      uuid: "delivered-continue",
      timestamp: "2026-09-27T12:00:02.000Z",
    };
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(
        ({ text, sentAtMs }) =>
          draftTextIsAccountedFor({
            draftText: text,
            sentAtMs,
            messages: [earlierContinue, deliveredNow],
          }),
      );
    });

    expect(discarded).toBe(true);
    expect(result.current[0]).toBe("");
  });

  it("reads an older client's undated recovery marker as an ordinary draft", () => {
    store.set(
      "draft-test",
      JSON.stringify({ version: 1, text: "submitted turn", pendingSend: true }),
    );
    const { result } = renderHook(() => useDraftPersistence("draft-test"));
    expect(result.current[0]).toBe("submitted turn");

    let discarded = true;
    act(() => {
      discarded = result.current[2].discardPendingSendDraft(() => true);
    });

    expect(discarded).toBe(false);
    expect(result.current[0]).toBe("submitted turn");
  });

  it("reads legacy raw-string drafts and rewrites them as envelopes", () => {
    store.set("draft-test", "legacy draft");

    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    expect(result.current[0]).toBe("legacy draft");

    act(() => {
      result.current[1]("updated draft");
    });

    expect(readStoredText("draft-test")).toBe("updated draft");
  });

  it("ignores malformed envelope values without crashing", () => {
    store.set("draft-test", '{"version":1,');

    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    expect(result.current[0]).toBe("");

    act(() => {
      result.current[1]("recovered");
    });

    expect(readStoredText("draft-test")).toBe("recovered");
  });

  it("removes empty text-only envelopes", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));

    act(() => {
      result.current[1]("temporary draft");
    });
    act(() => {
      result.current[1]("");
    });

    expect(window.localStorage.getItem("draft-test")).toBe(null);
  });

  it("persists attachment state in the same draft envelope", () => {
    const { result } = renderHook(() => useDraftPersistence("draft-test"));
    const attachmentState = {
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
    };

    act(() => {
      result.current[1]("draft text");
    });
    act(() => {
      result.current[2].setAttachmentState(attachmentState);
    });

    expect(readStoredText("draft-test")).toBe("draft text");
    expect(readStoredAttachmentCount("draft-test")).toBe(1);
    expect(result.current[2].getAttachmentState()).toEqual(attachmentState);

    act(() => {
      result.current[2].setAttachmentState(null);
    });

    expect(readStoredText("draft-test")).toBe("draft text");
    expect(readStoredAttachmentCount("draft-test")).toBe(0);
  });

  it("updates source draft indexes for session drafts", () => {
    const sourceKey = asClientSummarySourceKey("host:macbook");
    const { result } = renderHook(() =>
      useDraftPersistence("draft-message:host%3Amacbook:session-a", {
        sessionDraft: { sourceKey, sessionId: "session-a" },
      }),
    );

    act(() => {
      result.current[1]("indexed draft");
    });

    const setItem = vi.mocked(window.localStorage.setItem);
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      "draft-message:host%3Amacbook:session-a",
      "draft-presence-message:host%3Amacbook:session-a",
    ]);
    expect(
      window.localStorage.getItem("draft-message:host%3Amacbook:session-a"),
    ).not.toBe(null);
    expect(readStoredText("draft-message:host%3Amacbook:session-a")).toBe(
      "indexed draft",
    );
    expect(
      window.localStorage.getItem(
        "draft-presence-message:host%3Amacbook:session-a",
      ),
    ).toBe("1");

    setItem.mockClear();
    act(() => {
      result.current[1]("indexed draft keeps changing");
    });
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      "draft-message:host%3Amacbook:session-a",
    ]);

    act(() => {
      result.current[2].clearDraft();
    });

    expect(
      window.localStorage.getItem("draft-message:host%3Amacbook:session-a"),
    ).toBe(null);
    expect(
      window.localStorage.getItem(
        "draft-presence-message:host%3Amacbook:session-a",
      ),
    ).toBe(null);
  });
});
