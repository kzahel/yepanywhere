import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_DRAFT,
  draftHasContent,
  type DraftRead,
  type DraftSlot,
  type DraftSnapshot,
  type DraftWrite,
  type DraftWriteResult,
} from "@yep-anywhere/shared";
import {
  DraftSyncClient,
  acceptPendingDraft,
  draftAddress,
  draftPayloadFromStorage,
  draftPayloadToStorage,
  draftStorage,
  draftSyncPending,
  setDraftAccount,
  subscribeDraftStorage,
} from "../draftSyncStorage";
import { subscribeDraftPresenceChanges } from "../draftPresenceEvents";
import {
  getSyncedDraftSessionIds,
  setSyncedDraftSessionIds,
} from "../syncedDraftPresence";
import {
  getClientSummarySnapshotForSource,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  resetClientSummaryStoreForTests,
  retainClientSummaryDraftDecorations,
} from "../clientSummaryStore";
import {
  saveSessionDraft,
  updateSessionDraftIndex,
} from "../sessionDraftStorage";
import type { SourceTransport } from "../transport/types";
const key = "draft-new-session:local";
const raw = (text: string) => JSON.stringify({ version: 1, text });
function server(owner = "", slot: DraftSlot = { kind: "new-session" }) {
  let current: DraftRead = {
    snapshot: {
      slot,
      revision: null,
      sequence: 0,
      payload: EMPTY_DRAFT,
      updatedAt: 0,
    },
    ticket: "ticket",
  };
  let next = 0;
  let indexedSessionIds: string[] = [];
  const receipts = new Map<string, DraftWriteResult>();
  let hold:
    | ((value: DraftWriteResult) => Promise<DraftWriteResult>)
    | undefined;
  const fetch = vi.fn(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      if (path.startsWith("/drafts/index"))
        return {
          owner,
          entries: [
            ...(current.snapshot.revision
              ? [
                  {
                    slot: current.snapshot.slot,
                    revision: current.snapshot.revision,
                    empty: !draftHasContent(current.snapshot.payload),
                  },
                ]
              : []),
            ...indexedSessionIds.map((sessionId) => ({
              slot: { kind: "session" as const, sessionId },
              revision: "r",
              empty: false,
            })),
          ],
          next: null,
          sequence: next,
        };
      if (path.startsWith("/drafts/changes")) return { sequence: next };
      if (path.endsWith("/read")) return structuredClone(current);
      if (path.endsWith("/write") || path.endsWith("/clear")) {
        const op = JSON.parse(String(init?.body)) as DraftWrite;
        const prior = receipts.get(op.operationId);
        if (prior) return structuredClone(prior);
        if (op.baseRevision !== current.snapshot.revision)
          return {
            ...structuredClone(current),
            outcome: "conflict",
            operationId: op.operationId,
          };
        current = {
          snapshot: {
            ...current.snapshot,
            revision: `rev-${++next}`,
            sequence: next,
            payload: path.endsWith("/clear") ? EMPTY_DRAFT : op.payload,
          },
          ticket: "ticket",
        };
        const result: DraftWriteResult = {
          ...structuredClone(current),
          outcome: "accepted",
          operationId: op.operationId,
        };
        receipts.set(op.operationId, result);
        return hold ? await hold(result) : result;
      }
      throw new Error(`Unexpected request ${path}`);
    },
  );
  const transport = {
    fetch,
    status: {
      getSnapshot: () => ({ state: "ready" }),
      subscribe: () => () => {},
    },
  } as unknown as SourceTransport;
  return {
    transport,
    fetch,
    get: () => current.snapshot,
    index: (ids: string[]) => {
      indexedSessionIds = ids;
    },
    remote: (text: string) => {
      current = {
        snapshot: {
          ...current.snapshot,
          revision: `rev-${++next}`,
          sequence: next,
          payload: { fields: { text }, attachments: [] },
        },
        ticket: "ticket",
      };
    },
    hold: (fn: typeof hold) => {
      hold = fn;
    },
  };
}
const clients: DraftSyncClient[] = [];
const subscriptions: Array<() => void> = [];
beforeEach(() => {
  localStorage.clear();
  resetClientSummaryStoreForTests();
  setDraftAccount("local", "");
  setSyncedDraftSessionIds("local", new Set());
  vi.useFakeTimers();
});
afterEach(() => {
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions.length = 0;
  for (const client of clients) client.stop();
  clients.length = 0;
  resetClientSummaryStoreForTests();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function client(s: ReturnType<typeof server>) {
  const c = new DraftSyncClient("local", "", s.transport);
  clients.push(c);
  return c;
}
it.each([400, 403, 404, 413, 422])(
  "pauses rejected draft requests (%s) without losing local text",
  async (status) => {
    const s = server();
    s.fetch.mockRejectedValue(Object.assign(new Error("Rejected"), { status }));
    const c = client(s);
    localStorage.setItem(key, raw("Keep my draft"));
    const e = c.register(key)!;
    await c.sync(e);
    await vi.advanceTimersByTimeAsync(60_000);
    c.observe(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(raw("Keep my draft"));
    expect(e.error).toBe("sync");
    c.retryEntry(e);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  },
);
it("retains the retry pause for an inactive empty slot", async () => {
  const s = server();
  s.fetch.mockRejectedValue(
    Object.assign(new Error("Missing context"), { status: 404 }),
  );
  const c = client(s);
  localStorage.setItem(key, raw(""));
  await c.sync(c.register(key)!);
  c.release(key);
  c.observe(key);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.fetch).toHaveBeenCalledTimes(1);
});
it("saves corrected input after a rejected write without replaying its invalid payload", async () => {
  const s = server();
  const fetch = s.transport.fetch;
  s.transport.fetch = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    if (path === "/drafts/write" && String(init?.body).includes("invalid"))
      throw Object.assign(new Error("Invalid draft payload"), { status: 400 });
    return fetch<T>(path, init);
  };
  const c = client(s);
  localStorage.setItem(key, raw("invalid"));
  const e = c.register(key)!;
  await c.sync(e);
  localStorage.setItem(key, raw("corrected"));
  c.edit(key, raw("corrected"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(s.get().payload.fields.text).toBe("corrected");
  expect(e.error).toBeUndefined();
});
it("preserves an unacknowledged write when the next read is rejected", async () => {
  const s = server();
  s.hold(async () => {
    throw new Error("Lost acknowledgement");
  });
  const c = client(s);
  localStorage.setItem(key, raw("Keep my draft"));
  const e = c.register(key)!;
  await c.sync(e);
  const pending = e.saved.pending;
  expect(pending).toBeDefined();
  s.fetch.mockRejectedValueOnce(
    Object.assign(new Error("Rejected read"), { status: 400 }),
  );
  await c.sync(e);
  expect(e.saved.pending).toBe(pending);
  c.retryEntry(e);
  await vi.advanceTimersByTimeAsync(0);
  expect(e.saved.pending).toBeUndefined();
  expect(s.get().payload.fields.text).toBe("Keep my draft");
});
it.each([undefined, 408, 429, 500, 503])(
  "retries transient draft failures (%s)",
  async (status) => {
    const s = server();
    s.fetch.mockRejectedValueOnce(
      Object.assign(new Error("Unavailable"), { status }),
    );
    const c = client(s);
    localStorage.setItem(key, raw("Keep my draft"));
    await c.sync(c.register(key)!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.get().payload.fields.text).toBe("Keep my draft");
  },
);
it("discards recovery durably while offline and clears the server on reconnect", async () => {
  const s = server();
  s.remote("Stale draft");
  localStorage.setItem(key, raw("Stale draft"));
  localStorage.setItem(
    metadataKey(key),
    JSON.stringify({
      raw: raw("Stale draft"),
      base: s.get(),
      submitted: { payload: s.get().payload, revision: s.get().revision },
    }),
  );
  const first = client(s);
  const entry = first.register(key)!;
  first.discard(entry);
  expect(
    draftPayloadFromStorage(draftAddress(key)!, localStorage.getItem(key)),
  ).toEqual(EMPTY_DRAFT);
  first.stop();
  const reloaded = client(s);
  const restored = reloaded.register(key)!;
  expect(restored.needsRecovery).toBe(false);
  await reloaded.sync(restored);
  expect(s.get().payload).toEqual(EMPTY_DRAFT);
  expect(
    JSON.parse(localStorage.getItem(metadataKey(key))!),
  ).not.toHaveProperty("submitted");
});
it("does not resurrect a discarded draft when an in-flight save finishes", async () => {
  const s = server();
  let finish!: (value: DraftWriteResult) => void;
  let held!: DraftWriteResult;
  s.hold((result) => {
    held = result;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const c = client(s);
  c.edit(key, raw("Discarded"));
  const entry = c.register(key)!;
  const saving = c.sync(entry);
  await vi.waitFor(() => expect(finish).toBeDefined());
  c.discard(entry);
  c.edit(key, raw("Next draft"));
  s.hold(undefined);
  finish(held);
  await saving;
  await c.sync(entry);
  expect(s.get().payload).toEqual(EMPTY_DRAFT);
  await c.sync(entry);
  expect(s.get().payload.fields.text).toBe("Next draft");
});

it("adopts a sibling discard instead of restoring unresolved recovery", async () => {
  const s = server();
  const c = client(s);
  c.start();
  c.edit(key, raw("Stale"));
  const entry = c.register(key)!;
  entry.needsRecovery = true;
  entry.saved.submitted = {
    payload: { fields: { text: "Stale" }, attachments: [] },
    revision: null,
  };
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: metadataKey(key),
      newValue: JSON.stringify({
        raw: null,
        base: null,
        discard: {},
        discardId: "sibling-discard",
      }),
    }),
  );
  expect(draftStorage.getItem(key)).toBeNull();
  expect(draftSyncPending("local")).toEqual([]);
  expect(entry.saved.submitted).toBeUndefined();
  expect(entry.needsRecovery).toBe(false);
});

function observe(key: string) {
  const unsubscribe = subscribeDraftStorage(key, () => {});
  subscriptions.push(unsubscribe);
  return unsubscribe;
}
it("does not report a fictitious saved draft when an empty slot cannot be read", async () => {
  const s = server();
  const c = client(s);
  c.start();
  await c.refresh();
  s.fetch.mockRejectedValue(new Error("Draft context not found"));
  const entry = c.register(key)!;
  await c.sync(entry);
  expect(draftSyncPending("local")).toEqual([]);
});
function metadataKey(key: string) {
  return `draft-sync-v1:local::${encodeURIComponent(key)}`;
}
function seedAcknowledged(key: string, snapshot: DraftSnapshot) {
  const value = raw(snapshot.payload.fields.text ?? "");
  localStorage.setItem(key, value);
  localStorage.setItem(
    metadataKey(key),
    JSON.stringify({ raw: value, base: snapshot }),
  );
}
describe("paginated draft index catch-up", () => {
  it("applies changed-slot presence without rereading or erasing untouched drafts", async () => {
    const s = server(),
      c = client(s);
    s.remote("unchanged editor");
    seedAcknowledged(key, s.get());
    observe(key);
    s.index(["keep", "cleared"]);
    c.start();
    await c.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const original = s.fetch.getMockImplementation()!;
    s.fetch.mockClear();
    s.fetch.mockImplementation(async (path, init) => {
      if (
        path.startsWith("/drafts/index") &&
        new URL(path, "http://draft.test").searchParams.has("since")
      )
        return {
          owner: "",
          sequence: s.get().sequence,
          next: null,
          entries: [
            {
              slot: { kind: "session", sessionId: "cleared" },
              revision: "clear",
              empty: true,
            },
            {
              slot: { kind: "session", sessionId: "added" },
              revision: "added",
              empty: false,
            },
          ],
        };
      return original(path, init);
    });
    await c.refresh(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSyncedDraftSessionIds("local")).toEqual(
      new Set(["keep", "added"]),
    );
    expect(draftStorage.getItem(key)).toBe(raw("unchanged editor"));
    expect(s.fetch.mock.calls.some(([path]) => path.endsWith("/read"))).toBe(
      false,
    );
  });
  it("coalesces a full refresh requested while changed-slot catch-up is in flight", async () => {
    const s = server(),
      c = client(s);
    const original = s.fetch.getMockImplementation()!;
    let release!: (value: unknown) => void;
    s.fetch.mockImplementation(async (path, init) => {
      if (path.includes("since="))
        return new Promise((resolve) => {
          release = resolve;
        });
      return original(path, init);
    });
    const partial = c.refresh(0);
    const full = c.refresh(),
      siblingFull = c.refresh();
    release({ owner: "", sequence: 0, entries: [], next: null });
    await Promise.all([partial, full, siblingFull]);
    expect(
      s.fetch.mock.calls
        .filter(([path]) => path.startsWith("/drafts/index"))
        .map(([path]) => path),
    ).toEqual(["/drafts/index?after=&since=0", "/drafts/index?after="]);
  });
  it("rebuilds from the full index when the account counter moved behind its cursor", async () => {
    const s = server(),
      c = client(s);
    setSyncedDraftSessionIds("local", new Set(["old-account-draft"]));
    await c.refresh(42);
    expect(getSyncedDraftSessionIds("local")).toEqual(new Set());
    expect(s.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/drafts/index?after=&since=42",
      "/drafts/index?after=",
    ]);
  });
  it("uses a full index after a day without an acknowledged refresh", async () => {
    const s = server(),
      c = client(s);
    s.remote("old draft");
    seedAcknowledged(key, s.get());
    observe(key);
    c.start();
    await c.refresh();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 86_400_000);
    s.fetch.mockClear();
    s.remote("new draft after long sleep");
    await vi.advanceTimersByTimeAsync(1100);
    expect(
      s.fetch.mock.calls.some(([path]) => path === "/drafts/index?after="),
    ).toBe(true);
    expect(s.fetch.mock.calls.some(([path]) => path.includes("since="))).toBe(
      false,
    );
    expect(draftStorage.getItem(key)).toBe(raw("new draft after long sleep"));
  });
  it.each(["updated on the phone", ""])(
    "catches an earlier page's concurrent edit or clear (%j) without another change",
    async (remoteText) => {
      const s = server(),
        c = client(s);
      s.remote("old remote draft");
      seedAcknowledged(key, s.get());
      observe(key);
      const original = s.fetch.getMockImplementation()!;
      let changed = false;
      let changeDuringPagination = false;
      s.fetch.mockImplementation(async (path, init) => {
        if (!path.startsWith("/drafts/index")) return original(path, init);
        if (new URL(path, "http://draft.test").searchParams.get("after") === "")
          return {
            owner: "",
            sequence: s.get().sequence,
            entries: [
              { slot: s.get().slot, revision: s.get().revision, empty: false },
              ...Array.from({ length: 99 }, (_, i) => ({
                slot: { kind: "new-session" as const, projectId: `old-${i}` },
                revision: `cleared-${i}`,
                empty: true,
              })),
            ],
            next: "page-two",
          };
        if (changeDuringPagination && !changed) {
          changed = true;
          if (remoteText) s.remote(remoteText);
          else
            await original("/drafts/clear", {
              body: JSON.stringify({
                slot: s.get().slot,
                baseRevision: s.get().revision,
                operationId: "phone-clear",
                ticket: "ticket",
                payload: EMPTY_DRAFT,
              }),
            });
        }
        return {
          owner: "",
          sequence: s.get().sequence,
          entries: [],
          next: null,
        };
      });
      c.start();
      await c.refresh();
      await vi.advanceTimersByTimeAsync(0);
      changeDuringPagination = true;
      const refreshing = c.refresh();
      expect(c.refresh()).toBe(refreshing);
      await refreshing;
      await vi.advanceTimersByTimeAsync(1100);
      expect(
        draftPayloadFromStorage(draftAddress(key)!, draftStorage.getItem(key))
          .fields.text ?? "",
      ).toBe(remoteText);
      expect(
        s.fetch.mock.calls.some(([path]) => path === "/drafts/changes?after=1"),
      ).toBe(true);
      expect(s.get().sequence).toBe(2);
      expect(s.fetch.mock.calls.some(([path]) => path.endsWith("/write"))).toBe(
        false,
      );
    },
  );
  it("retries an incomplete index without acknowledging unread pages", async () => {
    const s = server(),
      c = client(s);
    s.remote("old remote draft");
    seedAcknowledged(key, s.get());
    observe(key);
    s.remote("unread second-page draft");
    const original = s.fetch.getMockImplementation()!;
    let failed = false;
    s.fetch.mockImplementation(async (path, init) => {
      if (!path.startsWith("/drafts/index")) return original(path, init);
      if (new URL(path, "http://draft.test").searchParams.get("after") === "")
        return {
          owner: "",
          sequence: s.get().sequence,
          entries: [],
          next: "page-two",
        };
      if (!failed) {
        failed = true;
        throw new Error("Second page unavailable");
      }
      return {
        owner: "",
        sequence: s.get().sequence,
        next: null,
        entries: [
          { slot: s.get().slot, revision: s.get().revision, empty: false },
        ],
      };
    });
    c.start();
    await c.refresh();
    await vi.advanceTimersByTimeAsync(1100);
    expect(draftStorage.getItem(key)).toBe(raw("unread second-page draft"));
    expect(s.get().sequence).toBe(2);
  });
});
describe("local-first snapshot synchronization", () => {
  it("evicts acknowledged drafts after the last editor closes and restores their base offline", async () => {
    const s = server(),
      c = client(s);
    s.remote("saved text");
    seedAcknowledged(key, s.get());
    const stored = localStorage.getItem(metadataKey(key));
    const ready = vi
      .spyOn(s.transport.status, "getSnapshot")
      .mockReturnValue({ state: "disconnected" } as ReturnType<
        SourceTransport["status"]["getSnapshot"]
      >);
    const first = observe(key),
      second = observe(key);
    c.start();
    await c.refresh();
    const e = c.entries.get(key)!;
    first();
    expect(c.entries.get(key)).toBe(e);
    second();
    expect(c.entries.has(key)).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw("saved text"));
    expect(localStorage.getItem(metadataKey(key))).toBe(stored);
    const reopen = observe(key);
    const restored = c.entries.get(key)!;
    expect(restored).not.toBe(e);
    expect(restored.saved.base).toEqual(s.get());
    expect(draftStorage.getItem(key)).toBe(raw("saved text"));
    // Three-way merge must use the restored base, not concatenate the old draft.
    draftStorage.setItem(key, raw("edited offline"));
    s.remote("");
    ready.mockReturnValue({ state: "ready" } as ReturnType<
      SourceTransport["status"]["getSnapshot"]
    >);
    await c.refresh();
    await c.sync(restored);
    expect(s.get().payload.fields.text).toBe("edited offline");
    reopen();
    expect(c.entries.has(key)).toBe(false);
  });
  it("does not retain a corpus of acknowledged drafts on startup", async () => {
    const s = server(),
      c = client(s);
    s.remote("saved text");
    for (let i = 0; i < 500; i++) {
      const slotKey = `draft-new-session:local:project-${i}`;
      seedAcknowledged(slotKey, {
        ...s.get(),
        slot: { kind: "new-session", projectId: `project-${i}` },
      });
    }
    const storedKeys = localStorage.length;
    c.start();
    await c.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.entries.size).toBe(0);
    expect(localStorage.length).toBe(storedKeys);
    expect(
      s.fetch.mock.calls.some(
        ([path]) => path.endsWith("/read") || path.endsWith("/write"),
      ),
    ).toBe(false);
    expect(localStorage.getItem("draft-new-session:local:project-499")).toBe(
      raw("saved text"),
    );
  });
  it("keeps wildcard-observed drafts until their last matching editor closes", () => {
    const s = server(),
      c = client(s);
    s.remote("saved text");
    seedAcknowledged(key, s.get());
    const wildcard = observe("draft-new-session:local*");
    const exact = observe(key);
    c.start();
    exact();
    expect(c.entries.has(key)).toBe(true);
    wildcard();
    expect(c.entries.has(key)).toBe(false);
  });
  it.each(["dirty", "pending", "submitted", "pending-send"])(
    "protects %s state when its editor closes",
    async (kind) => {
      const s = server(),
        c = client(s);
      s.remote("base");
      seedAcknowledged(key, s.get());
      const saved = JSON.parse(localStorage.getItem(metadataKey(key))!);
      if (kind === "dirty") localStorage.setItem(key, raw("offline edit"));
      if (kind === "pending")
        saved.pending = {
          slot: { kind: "new-session" },
          baseRevision: "base",
          ticket: "ticket",
          operationId: "retry-this-operation",
          payload: s.get().payload,
        };
      if (kind === "submitted")
        saved.submitted = {
          payload: s.get().payload,
          revision: s.get().revision,
        };
      if (kind === "pending-send")
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            text: "base",
            pendingSendAt: Date.now(),
          }),
        );
      localStorage.setItem(metadataKey(key), JSON.stringify(saved));
      vi.spyOn(s.transport.status, "getSnapshot").mockReturnValue({
        state: "disconnected",
      } as ReturnType<SourceTransport["status"]["getSnapshot"]>);
      const unsubscribe = observe(key);
      c.start();
      const e = c.entries.get(key)!;
      unsubscribe();
      expect(c.entries.get(key)).toBe(e);
      expect(localStorage.getItem(metadataKey(key))).toBe(
        JSON.stringify(saved),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(c.entries.get(key)).toBe(e);
    },
  );
  it("keeps a save in flight after navigation, then evicts only once newer typing is acknowledged", async () => {
    const s = server(),
      c = client(s);
    const unsubscribe = observe(key);
    c.start();
    await c.refresh();
    draftStorage.setItem(key, raw("first"));
    const e = c.entries.get(key)!;
    let release!: (value: DraftWriteResult) => void;
    let accepted!: DraftWriteResult;
    s.hold((value) => {
      accepted = value;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const saving = c.sync(e);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    unsubscribe();
    expect(c.entries.get(key)).toBe(e);
    draftStorage.setItem(key, raw("second"));
    s.hold(undefined);
    release(accepted);
    await saving;
    expect(c.entries.get(key)).toBe(e);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("second");
    expect(localStorage.getItem(key)).toBe(raw("second"));
    expect(c.entries.has(key)).toBe(false);
  });
  it("keeps focused remote changes and local storage failures after navigation", async () => {
    const s = server(),
      c = client(s);
    const unsubscribe = observe(key);
    c.start();
    await c.refresh();
    draftStorage.setItem(key, raw("desktop"));
    const e = c.entries.get(key)!;
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    s.remote("phone");
    await c.sync(e);
    unsubscribe();
    expect(c.entries.get(key)).toBe(e);
    expect(e.remote).toBeDefined();
    c.accept(e);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    c.edit(key, raw("memory only"));
    await c.sync(e);
    expect(e.error).toBe("local");
    expect(c.entries.get(key)).toBe(e);
    expect(draftStorage.getItem(key)).toBe(raw("memory only"));
  });
  it("keeps a conditional clear in flight after navigation and releases its acknowledged empty entry", async () => {
    const s = server(),
      c = client(s);
    const unsubscribe = observe(key);
    c.start();
    await c.refresh();
    draftStorage.setItem(key, raw("send this"));
    const e = c.entries.get(key)!;
    await c.sync(e);
    draftStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        text: "send this",
        pendingSendAt: Date.now(),
      }),
    );
    await e.submissionTask;
    let release!: (value: DraftWriteResult) => void;
    let accepted!: DraftWriteResult;
    s.hold((value) => {
      accepted = value;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const clearing = c.confirm(key);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    draftStorage.removeItem(key);
    unsubscribe();
    expect(c.entries.get(key)).toBe(e);
    s.hold(undefined);
    release(accepted);
    await clearing;
    expect(c.entries.has(key)).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(metadataKey(key))!).base.payload,
    ).toEqual(EMPTY_DRAFT);
  });
  it("releases entries and timers when the source coordinator stops", async () => {
    const s = server(),
      c = client(s);
    c.start();
    draftStorage.setItem(key, raw("offline edit"));
    c.stop();
    expect(c.entries.size).toBe(0);
    const requests = s.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.fetch.mock.calls.length).toBe(requests);
    expect(localStorage.getItem(key)).toBe(raw("offline edit"));
    // A later coordinator restores the text and still owes it a save.
    const restored = client(s).register(key)!;
    expect(restored.saved.raw).toBe(raw("offline edit"));
    expect(restored.saved.base).toBeNull();
  });
  it("publishes only index presence changes while preserving evicted local drafts", async () => {
    const s = server(),
      c = client(s);
    const sessionKey = "draft-message-local-draft";
    seedAcknowledged(sessionKey, {
      ...s.get(),
      slot: { kind: "session", sessionId: "local-draft" },
      payload: { fields: { text: "local text" }, attachments: [] },
    });
    s.index(["local-draft", "remote-draft"]);
    const changes = vi.fn();
    subscriptions.push(subscribeDraftPresenceChanges(changes));
    c.start();
    await c.refresh();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(c.entries.has(sessionKey)).toBe(false);
    changes.mockClear();
    await c.refresh();
    expect(changes).not.toHaveBeenCalled();
    s.index([]);
    await c.refresh();
    expect(
      changes.mock.calls.map(([change]) => [
        change.sessionDraft.sessionId,
        change.hasContent,
      ]),
    ).toEqual([
      ["local-draft", true],
      ["remote-draft", false],
    ]);
  });
  it("keeps edits made while a save waits for its acknowledgement", async () => {
    const s = server(),
      c = client(s);
    let release!: (v: DraftWriteResult) => void;
    let accepted!: DraftWriteResult;
    s.hold((v) => {
      accepted = v;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    c.edit(key, raw("Hello"));
    const e = c.register(key)!;
    const saving = c.sync(e);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    c.edit(key, raw("Hello there"));
    release(accepted);
    await saving;
    expect(e.saved.raw).toBe(raw("Hello there"));
    expect(e.saved.base?.payload.fields.text).toBe("Hello");
    s.hold(undefined);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("Hello there");
  });
  it("retries the same operation after a lost response without duplicating a merge", async () => {
    const s = server(),
      c = client(s);
    s.remote("phone");
    c.edit(key, raw("desktop"));
    const e = c.register(key)!;
    s.hold(async () => {
      throw new Error("lost response");
    });
    await c.sync(e);
    c.accept(e);
    await c.sync(e);
    const operation = e.saved.pending?.operationId;
    expect(operation).toBeTruthy();
    s.hold(undefined);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("phone\n\ndesktop");
    expect(e.saved.pending).toBeUndefined();
    const writes = s.fetch.mock.calls.filter(([path]) =>
      path.endsWith("/write"),
    );
    expect(JSON.parse(String(writes[0]?.[1]?.body)).operationId).toBe(
      JSON.parse(String(writes[1]?.[1]?.body)).operationId,
    );
  });
  it("holds remote text while typing, then combines only on explicit acceptance", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("desktop"));
    const e = c.register(key)!;
    const input = document.createElement("textarea");
    document.body.append(input);
    input.value = "desktop";
    input.focus();
    input.setSelectionRange(3, 3);
    s.remote("phone");
    await c.sync(e);
    expect(e.saved.raw).toBe(raw("desktop"));
    expect(input.selectionStart).toBe(3);
    expect(e.remote).toBeDefined();
    input.blur();
    c.accept(e);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("phone\n\ndesktop");
  });
  it("clears a stale sync error when reconnect requires explicit combination", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("desktop"));
    const e = c.register(key)!;
    s.fetch.mockRejectedValueOnce(new Error("offline"));
    await c.sync(e);
    expect(e.error).toBe("sync");
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    s.remote("phone");
    await c.sync(e);
    expect(e.remote).toBeDefined();
    expect(e.saved.raw).toBe(raw("desktop"));
    expect(e.error).toBeUndefined();
  });
  it("conditionally clears a submitted revision but keeps the next local draft", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("first"));
    const e = c.register(key)!;
    await c.sync(e);
    c.edit(
      key,
      JSON.stringify({ version: 1, text: "first", pendingSendAt: Date.now() }),
    );
    c.edit(key, raw("second"));
    await c.confirm(key);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("second");
    expect(e.saved.raw).toBe(raw("second"));
  });
  it("preserves an offline edit when another device clears its base", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("base"));
    const e = c.register(key)!;
    await c.sync(e);
    c.edit(key, raw("new offline text"));
    s.remote("");
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("new offline text");
  });
  it("separates account caches without importing the operator's legacy text", () => {
    localStorage.setItem(key, raw("operator"));
    setDraftAccount("local", "alice");
    expect(draftStorage.getItem(key)).toBeNull();
    draftStorage.setItem(key, raw("alice"));
    setDraftAccount("local", "");
    expect(draftStorage.getItem(key)).toBe(raw("operator"));
  });
  it("waits for autosave before flushing a submitted snapshot", async () => {
    const s = server(),
      c = client(s);
    let release!: (v: DraftWriteResult) => void;
    let accepted!: DraftWriteResult;
    s.hold((v) => {
      accepted = v;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    c.edit(key, raw("first"));
    const e = c.register(key)!;
    const saving = c.sync(e);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    c.edit(
      key,
      JSON.stringify({ version: 1, text: "first", pendingSendAt: Date.now() }),
    );
    const clearing = c.confirm(key);
    expect(
      s.fetch.mock.calls.filter(([path]) => path.endsWith("/write")),
    ).toHaveLength(1);
    s.hold(undefined);
    release(accepted);
    await saving;
    await clearing;
    expect(s.get().payload).toEqual(EMPTY_DRAFT);
  });
  it("does not clear a newer revision from another device", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("first"));
    const e = c.register(key)!;
    await c.sync(e);
    c.edit(
      key,
      JSON.stringify({ version: 1, text: "first", pendingSendAt: Date.now() }),
    );
    s.remote("other device's next draft");
    await c.confirm(key);
    expect(s.get().payload.fields.text).toBe("other device's next draft");
  });
  it("adopts a sibling tab's keystrokes without echoing or concatenating them", async () => {
    const s = server(),
      c = client(s);
    const changed = vi.fn();
    subscriptions.push(subscribeDraftStorage(key, changed));
    localStorage.setItem(key, raw("c"));
    c.start();
    await c.refresh();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    const setItem = vi.spyOn(localStorage, "setItem");
    // The sibling tab writes the shared storage on every keystroke.
    for (const text of ["co", "cod", "codex", "codex updated."]) {
      localStorage.setItem(key, raw(text));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: raw(text) }),
      );
    }
    const siblingWrites = 4;
    expect(setItem).toHaveBeenCalledTimes(siblingWrites);
    expect(draftStorage.getItem(key)).toBe(raw("codex updated."));
    expect(changed).toHaveBeenCalledTimes(4);
    expect(draftSyncPending("local")).toEqual([]);
    input.blur();
    setItem.mockRestore();
    // The typing tab saves its own text; this tab takes over only once that
    // tab has gone quiet without saving.
    await c.sync(c.register(key)!);
    expect(s.get().payload.fields.text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.get().payload.fields.text).toBe("codex updated.");
  });
  it("never mistakes a sibling tab's save of this draft for another device", async () => {
    const s = server(),
      typing = client(s),
      sibling = client(s);
    // The browser delivers a tab's storage writes only to its siblings.
    const deliver = (to: DraftSyncClient, storageKey: string) =>
      (to as unknown as { storage: (event: StorageEvent) => void }).storage(
        new StorageEvent("storage", {
          key: storageKey,
          newValue: localStorage.getItem(storageKey),
        }),
      );
    const type = (text: string) => {
      localStorage.setItem(key, raw(text));
      typing.edit(key, raw(text));
      deliver(sibling, key);
    };
    type("about h");
    const mine = typing.register(key)!;
    const theirs = sibling.register(key)!;
    await typing.sync(mine);
    deliver(sibling, metadataKey(key));
    type("about ha");
    // The sibling leaves saving the shared text to the tab typing it, so the
    // two never race each other's merges.
    const writes = () =>
      s.fetch.mock.calls.filter(([path]) => path === "/drafts/write").length;
    const before = writes();
    await sibling.sync(theirs);
    expect(writes()).toBe(before);
    expect(s.get().payload.fields.text).toBe("about h");
    type("about hav");
    await typing.sync(mine);
    expect(mine.remote).toBeUndefined();
    expect(s.get().payload.fields.text).toBe("about hav");
    expect(mine.saved.raw).toBe(raw("about hav"));
  });
  it("lets a change notice wait for the typing debounce", async () => {
    const s = server(),
      c = client(s);
    c.start();
    await c.refresh();
    const reads = () =>
      s.fetch.mock.calls.filter(([path]) => path === "/drafts/read").length;
    localStorage.setItem(key, raw("abc"));
    c.edit(key, raw("abc"));
    // A sibling tab saved the same shared text.
    s.remote("abc");
    await c.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads()).toBe(1);
  });
  it("preserves a newer physical sibling draft when its storage event is held past creation acknowledgement", async () => {
    setDraftAccount("local", "alice");
    const s = server("alice");
    const owner = new DraftSyncClient("local", "alice", s.transport);
    clients.push(owner);
    const draftKey = "draft-new-session:local";
    const sent = JSON.stringify({
      version: 1,
      text: "submitted creation",
      pendingSendAt: Date.now(),
    });
    const physicalKey = draftStorage.physicalKey(draftKey);
    expect(physicalKey).not.toBe(draftKey);
    localStorage.setItem(physicalKey, sent);
    owner.edit(draftKey, sent);
    const entry = owner.register(draftKey)!;
    await entry.submissionTask;
    const newer = raw("sibling's newer unsent draft");
    // Do not deliver the storage event: the coordinator still holds sent.
    localStorage.setItem(physicalKey, newer);
    expect(entry.saved.raw).toBe(sent);
    expect(
      owner.confirmCapturedSubmission({
        key: draftKey,
        physicalKey,
        raw: sent,
      }),
    ).toBe(false);
    expect(localStorage.getItem(physicalKey)).toBe(newer);
    expect(entry.saved.raw).toBe(newer);
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem(physicalKey)).toBe(newer);
  });

  it.each(["local", "held sibling"])(
    "cancels a captured refusal without replacing newer %s text or files",
    async (edit) => {
      setDraftAccount("local", "alice");
      const s = server("alice");
      const owner = new DraftSyncClient("local", "alice", s.transport);
      clients.push(owner);
      const physicalKey = draftStorage.physicalKey(key);
      const sent = JSON.stringify({
        version: 1,
        text: "Submitted",
        pendingSendAt: Date.now(),
      });
      localStorage.setItem(physicalKey, sent);
      owner.edit(key, sent);
      const entry = owner.register(key)!;
      await entry.submissionTask;
      const newer = JSON.stringify({
        version: 1,
        text: "Submitted with newer work",
        attachments: {
          batchId: "new-batch",
          updatedAt: "2026-11-03T00:00:00Z",
          refs: [
            {
              id: "new-file",
              batchId: "new-batch",
              originalName: "new.txt",
              name: "new-file_new.txt",
              size: 3,
              mimeType: "text/plain",
              createdAt: "2026-11-03T00:00:00Z",
              updatedAt: "2026-11-03T00:00:00Z",
            },
          ],
        },
      });
      localStorage.setItem(physicalKey, newer);
      if (edit === "local") owner.edit(key, newer);
      // In the sibling case its storage event has deliberately not arrived.
      owner.cancelCapturedSubmission({ key, physicalKey, raw: sent });
      expect(localStorage.getItem(physicalKey)).toBe(newer);
      expect(entry.saved.raw).toBe(newer);
      expect(entry.saved.submitted).toBeUndefined();
      expect(
        draftPayloadFromStorage(entry.address, entry.saved.recovery ?? null)
          .fields.text,
      ).toBe("Submitted");
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.getItem(physicalKey)).toBe(newer);
      owner.stop();
      const reopened = new DraftSyncClient("local", "alice", s.transport);
      clients.push(reopened);
      expect(reopened.register(key)!.saved.raw).toBe(newer);
      expect(reopened.register(key)!.needsRecovery).toBe(false);
    },
  );

  it("keeps newer in-memory input when cancellation follows a failed local write", async () => {
    const owner = client(server());
    const physicalKey = draftStorage.physicalKey(key);
    const sent = JSON.stringify({
      version: 1,
      text: "Submitted",
      pendingSendAt: Date.now(),
    });
    localStorage.setItem(physicalKey, sent);
    owner.edit(key, sent);
    const entry = owner.register(key)!;
    await entry.submissionTask;
    owner.edit(key, raw("Newer text that could not be stored"));
    owner.localFailure(key);
    owner.cancelCapturedSubmission({ key, physicalKey, raw: sent });
    expect(entry.saved.raw).toBe(raw("Newer text that could not be stored"));
    expect(localStorage.getItem(physicalKey)).toBe(sent);
    expect(entry.error).toBe("local");
    expect(entry.saved.submitted).toBeUndefined();
  });

  it("does not cancel a captured draft in a replacement account", async () => {
    setDraftAccount("local", "alice");
    const owner = new DraftSyncClient(
      "local",
      "alice",
      server("alice").transport,
    );
    clients.push(owner);
    const physicalKey = draftStorage.physicalKey(key);
    const sent = JSON.stringify({
      version: 1,
      text: "Alice submitted",
      pendingSendAt: Date.now(),
    });
    localStorage.setItem(physicalKey, sent);
    owner.edit(key, sent);
    const entry = owner.register(key)!;
    await entry.submissionTask;
    setDraftAccount("local", "bob");
    const replacement = draftStorage.physicalKey(key);
    localStorage.setItem(replacement, raw("Bob's newer draft"));
    owner.cancelCapturedSubmission({ key, physicalKey, raw: sent });
    expect(localStorage.getItem(physicalKey)).toBe(sent);
    expect(localStorage.getItem(replacement)).toBe(raw("Bob's newer draft"));
    expect(entry.saved.submitted).toBeDefined();
  });

  it("never restores a typed prefix from a read older than the sent draft", async () => {
    const s = server(),
      typing = client(s),
      sibling = client(s);
    const deliver = (to: DraftSyncClient, storageKey: string) =>
      (to as unknown as { storage: (event: StorageEvent) => void }).storage(
        new StorageEvent("storage", {
          key: storageKey,
          newValue: localStorage.getItem(storageKey),
        }),
      );
    const type = (text: string) => {
      localStorage.setItem(key, text);
      typing.edit(key, text);
      deliver(sibling, key);
    };
    const prefix = "the quick brown fox jumps over";
    const sent = `${prefix} the lazy dog again`;
    type(raw(prefix));
    const mine = typing.register(key)!;
    const theirs = sibling.register(key)!;
    await typing.sync(mine);
    // A busy background tab reads while the server still holds the prefix
    // and handles the response only after the send has been cleared.
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const respond = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementationOnce(async (path, init) => {
      const response = await respond(path, init);
      await readHeld;
      return response;
    });
    const staleSync = sibling.sync(theirs);
    await vi.waitFor(() =>
      expect(s.fetch.mock.calls.at(-1)?.[0]).toBe("/drafts/read"),
    );
    type(JSON.stringify({ version: 1, text: sent, pendingSendAt: Date.now() }));
    await typing.confirm(key);
    localStorage.removeItem(key);
    typing.edit(key, null);
    deliver(sibling, key);
    deliver(sibling, metadataKey(key));
    expect(s.get().payload).toEqual(EMPTY_DRAFT);
    releaseRead();
    await staleSync;
    expect(localStorage.getItem(key)).toBeNull();
    expect(theirs.saved.raw).toBeNull();
    expect(theirs.remote).toBeUndefined();
    expect(s.get().payload).toEqual(EMPTY_DRAFT);
  });
  it("never writes server text over a focused sibling's newer typing", async () => {
    const s = server(),
      background = client(s);
    localStorage.setItem(key, raw("about h"));
    background.edit(key, raw("about h"));
    const e = background.register(key)!;
    await background.sync(e);
    // The focused sibling typed on and saved; this busy background tab has
    // not yet received the sibling's latest keystrokes.
    localStorage.setItem("draft-sync-foreground", "sibling-tab");
    s.remote("about ha");
    localStorage.setItem(key, raw("about hav"));
    await background.sync(e);
    expect(localStorage.getItem(key)).toBe(raw("about hav"));
    expect(e.remote?.snapshot.payload.fields.text).toBe("about ha");
  });
  it("fills an empty focused composer with a draft begun in another window", async () => {
    const s = server(),
      c = client(s);
    const input = document.createElement("textarea");
    input.dataset.draftKey = key;
    document.body.append(input);
    input.focus();
    const e = c.register(key)!;
    s.remote("begun elsewhere");
    await c.sync(e);
    expect(e.saved.raw).toBe(raw("begun elsewhere"));
    expect(e.remote).toBeUndefined();
  });
  it("brings an unfocused window's composer up to date with another window", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("begun here"));
    const e = c.register(key)!;
    await c.sync(e);
    // The caret stays in this composer while another window has the focus.
    const input = document.createElement("textarea");
    input.dataset.draftKey = key;
    document.body.append(input);
    input.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    s.remote("begun here, continued elsewhere");
    await c.sync(e);
    expect(e.saved.raw).toBe(raw("begun here, continued elsewhere"));
    expect(e.remote).toBeUndefined();
  });
  it("retries a failed browser write when the notice's retry is chosen", async () => {
    const s = server(),
      c = client(s);
    c.start();
    await c.refresh();
    const e = c.register(key)!;
    const full = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    expect(() => draftStorage.setItem(key, raw("kept in memory"))).toThrow();
    expect(draftSyncPending().map((p) => p.error)).toEqual(["local"]);
    c.accept(e);
    expect(e.error).toBe("local");
    full.mockRestore();
    acceptPendingDraft(key);
    expect(e.error).toBeUndefined();
    expect(localStorage.getItem(key)).toBe(raw("kept in memory"));
    expect(draftSyncPending()).toEqual([]);
    await c.sync(e);
    expect(s.get().payload.fields.text).toBe("kept in memory");
  });
  it("drops a stored sibling merge left by earlier builds", () => {
    const s = server(),
      c = client(s);
    localStorage.setItem(key, raw("codex"));
    localStorage.setItem(
      metadataKey(key),
      JSON.stringify({
        base: null,
        alternative: { fields: { text: "codex\n\ncode" }, attachments: [] },
      }),
    );
    const e = c.register(key)!;
    expect("alternative" in e.saved).toBe(false);
    expect(draftSyncPending()).toEqual([]);
  });
  it("refuses to sync when the server's acting account differs from the client", async () => {
    const s = server("alice"),
      c = client(s);
    localStorage.setItem(key, raw("operator"));
    c.start();
    await c.refresh();
    await vi.advanceTimersByTimeAsync(4000);
    expect(
      s.fetch.mock.calls.some(
        ([path]) => path.endsWith("/read") || path.endsWith("/write"),
      ),
    ).toBe(false);
  });
  it("retains in-memory text and reports unavailable browser storage", async () => {
    const s = server(),
      c = client(s);
    const e = c.register(key)!;
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    expect(() => c.edit(key, raw("still here"))).not.toThrow();
    await c.sync(e);
    expect(e.saved.raw).toBe(raw("still here"));
    expect(e.error).toBe("local");
    expect(s.get().payload.fields.text).toBe("still here");
  });
  it("round-trips question fields, comment anchors and multi-batch attachments", () => {
    const address = draftAddress("session-file-comments:local:s:p:file.ts")!;
    const original = JSON.stringify([
      {
        id: "a",
        text: "comment",
        location: "line",
        quote: "code",
        afterLine: 3,
      },
    ]);
    expect(
      JSON.parse(
        draftPayloadToStorage(
          address,
          draftPayloadFromStorage(address, original),
          original,
        )!,
      ),
    ).toEqual(JSON.parse(original));
    setDraftAccount("host:abc", "");
    expect(
      draftAddress("yep-async-questions:host:abc:session:message:question")
        ?.slot,
    ).toEqual({
      kind: "async-question",
      sessionId: "session",
      field: "message:question",
    });
  });
});

describe("session-scoped handoff and conflict review", () => {
  it("quietly holds a phone clear while focused, then clears after blur", async () => {
    const s = server(),
      c = client(s);
    c.start();
    await c.refresh();
    subscriptions.push(subscribeDraftStorage(key, () => {}));
    c.edit(key, raw("already sent"));
    const e = c.register(key)!;
    await c.sync(e);
    const input = document.createElement("textarea");
    input.dataset.draftKey = key;
    input.value = "already sent";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(3, 3);
    s.remote("");
    await c.sync(e);
    expect(e.saved.raw).toBe(raw("already sent"));
    expect(input.selectionStart).toBe(3);
    expect(draftSyncPending()).toEqual([]);
    input.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.saved.raw).toBeNull();
    expect(e.remote).toBeUndefined();
  });
  it("refreshes a held phone edit when that phone subsequently clears it", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("base"));
    const e = c.register(key)!;
    await c.sync(e);
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    s.remote("phone revision");
    await c.sync(e);
    expect(e.remote?.snapshot.payload.fields.text).toBe("phone revision");
    s.remote("");
    await c.sync(e);
    expect(e.remote?.snapshot.payload.fields.text).toBe("");
    input.blur();
    await c.sync(e);
    expect(e.saved.raw).toBeNull();
    expect(s.get().payload).toEqual(EMPTY_DRAFT);
  });
  it("another composer holding focus does not pause this draft", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("base"));
    const e = c.register(key)!;
    await c.sync(e);
    const input = document.createElement("textarea");
    input.dataset.draftKey = "draft-message-other-session";
    document.body.append(input);
    input.focus();
    s.remote("");
    await c.sync(e);
    expect(e.saved.raw).toBeNull();
    expect(e.remote).toBeUndefined();
  });
  it.each(["local", "remote", "combine"] as const)(
    "reviews one conflicting draft using %s",
    async (choice) => {
      const s = server(),
        c = client(s);
      c.edit(key, raw("base"));
      const e = c.register(key)!;
      await c.sync(e);
      c.edit(key, raw("desktop edit"));
      s.remote("phone edit");
      await c.sync(e);
      expect(e.remote).toBeDefined();
      const other = c.register("draft-message-unrelated")!;
      other.saved.raw = raw("unrelated draft");
      expect(await c.resolve(e, choice, s.get().revision)).toBe(true);
      await c.sync(e);
      const expected =
        choice === "local"
          ? "desktop edit"
          : choice === "remote"
            ? "phone edit"
            : "phone edit\n\ndesktop edit";
      expect(s.get().payload.fields.text).toBe(expected);
      expect(other.saved.raw).toBe(raw("unrelated draft"));
    },
  );
  it("requires another review if the remote version changed before a choice", async () => {
    const s = server(),
      c = client(s);
    c.edit(key, raw("base"));
    const e = c.register(key)!;
    await c.sync(e);
    c.edit(key, raw("desktop edit"));
    s.remote("phone edit");
    await c.sync(e);
    const reviewed = s.get().revision;
    s.remote("new phone edit");
    expect(await c.resolve(e, "remote", reviewed)).toBe(false);
    expect(e.saved.raw).toBe(raw("desktop edit"));
    expect(e.remote?.snapshot.payload.fields.text).toBe("new phone edit");
    expect(s.get().payload.fields.text).toBe("new phone edit");
  });
  it("does not show a conflict for independently edited question fields", async () => {
    const s = server(),
      c = client(s);
    const e = c.register("draft-question-other:local:session")!;
    e.saved.base = {
      ...s.get(),
      payload: { fields: { one: "first", two: "second" }, attachments: [] },
    };
    e.saved.raw = JSON.stringify({ one: "local first", two: "second" });
    e.remote = {
      ticket: "ticket",
      snapshot: {
        ...s.get(),
        payload: {
          fields: { one: "first", two: "remote second" },
          attachments: [],
        },
      },
    };
    c.start();
    expect(draftSyncPending()).toEqual([]);
  });
});

it("preserves typing that arrives while a review choice waits for the server", async () => {
  const s = server(),
    c = client(s);
  c.edit(key, raw("base"));
  const e = c.register(key)!;
  await c.sync(e);
  c.edit(key, raw("desktop edit"));
  s.remote("phone edit");
  await c.sync(e);
  const read = structuredClone(e.remote!);
  let finish!: (value: DraftRead) => void;
  s.fetch.mockImplementationOnce(
    () =>
      new Promise<DraftRead>((resolve) => {
        finish = resolve;
      }),
  );
  const choosing = c.resolve(e, "remote", read.snapshot.revision);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  c.edit(key, raw("desktop edit plus newer typing"));
  finish(read);
  expect(await choosing).toBe(false);
  expect(e.saved.raw).toBe(raw("desktop edit plus newer typing"));
  expect(e.remote?.snapshot.payload.fields.text).toBe("phone edit");
});
it("a failed review refresh cannot apply its cached remote version", async () => {
  const s = server(),
    c = client(s);
  c.edit(key, raw("base"));
  const e = c.register(key)!;
  await c.sync(e);
  c.edit(key, raw("desktop edit"));
  s.remote("phone edit");
  await c.sync(e);
  const revision = e.remote!.snapshot.revision;
  s.fetch.mockRejectedValueOnce(new Error("offline"));
  expect(await c.resolve(e, "remote", revision)).toBe(false);
  expect(e.saved.raw).toBe(raw("desktop edit"));
  expect(e.error).toBe("sync");
});

describe("synchronized session draft badges", () => {
  const sessionId = "badge-session";
  const sessionKey = `draft-message-${sessionId}`;
  const sourceKey = LOCAL_CLIENT_SUMMARY_SOURCE_KEY;
  const reference = { sourceKey, sessionId };
  const hasBadge = () =>
    getClientSummarySnapshotForSource(
      sourceKey,
    ).localDecorations.draftSessionIds.has(sessionId);

  function mountedSession() {
    const s = server("", { kind: "session", sessionId });
    s.remote("previous draft");
    seedAcknowledged(sessionKey, s.get());
    updateSessionDraftIndex(reference, raw("previous draft"));
    // The sidebar can subscribe before the coordinator/editor mounts.
    subscriptions.push(retainClientSummaryDraftDecorations(sourceKey));
    subscriptions.push(subscribeDraftStorage(sessionKey, () => {}));
    const c = client(s);
    c.start();
    return { s, c };
  }

  it("removes the badge when a remote clear reaches the local body after its index", async () => {
    const { s, c } = mountedSession();
    await c.refresh();
    expect(hasBadge()).toBe(true);
    s.remote("");
    await c.refresh();
    expect(hasBadge()).toBe(true);
    await c.sync(c.entries.get(sessionKey)!);
    expect(draftStorage.getItem(sessionKey)).toBeNull();
    expect(
      localStorage.getItem(`draft-presence-message:local:${sessionId}`),
    ).toBeNull();
    expect(hasBadge()).toBe(false);
    await c.refresh();
    expect(hasBadge()).toBe(false);
  });

  it("keeps the badge and newer local text when the server clears the previous draft", async () => {
    const { s, c } = mountedSession();
    await c.refresh();
    saveSessionDraft(reference, "next local draft");
    s.remote("");
    await c.refresh();
    await c.sync(c.entries.get(sessionKey)!);
    expect(draftStorage.getItem(sessionKey)).toBe(raw("next local draft"));
    expect(hasBadge()).toBe(true);
  });

  it("keeps a focused draft badge until the deferred clear applies after blur", async () => {
    const { s, c } = mountedSession();
    await c.refresh();
    const input = document.createElement("textarea");
    input.dataset.draftKey = sessionKey;
    document.body.append(input);
    input.focus();
    s.remote("");
    await c.refresh();
    await c.sync(c.entries.get(sessionKey)!);
    expect(hasBadge()).toBe(true);
    expect(draftStorage.getItem(sessionKey)).toBe(raw("previous draft"));
    input.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(draftStorage.getItem(sessionKey)).toBeNull();
    expect(hasBadge()).toBe(false);
  });

  it("adopts sibling-tab presence without echoing the draft body or metadata", async () => {
    const { s, c } = mountedSession();
    await c.refresh();
    s.remote("");
    await c.refresh();
    const setItem = vi.spyOn(localStorage, "setItem");
    for (const value of [null, raw("sibling draft"), null]) {
      if (value === null) localStorage.removeItem(sessionKey);
      else localStorage.setItem(sessionKey, value);
      setItem.mockClear();
      window.dispatchEvent(
        new StorageEvent("storage", { key: sessionKey, newValue: value }),
      );
      expect(hasBadge()).toBe(value !== null);
      expect(
        setItem.mock.calls.every(([key]) =>
          key.startsWith("draft-presence-message:"),
        ),
      ).toBe(true);
    }
  });
});
