import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSidebarSessionOrder } from "../useSidebarSessionOrder";
import {
  getSessionInteractionStore,
  recordSessionInteraction,
} from "../../lib/sessionInteractionOrder";
import {
  createClientSummaryHostSourceKey,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import type { SessionCollectionRecord } from "../../lib/clientSummaryCollections";

afterEach(() => {
  cleanup();
  localStorage.clear();
  invalidateLocalStorageValues();
});

describe("sidebar user chronology", () => {
  it("retains user recency across remounts and isolates sources", () => {
    const first = createClientSummaryHostSourceKey("order-first");
    const other = createClientSummaryHostSourceKey("order-other");
    setCurrentClientSummarySourceKey(first);
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    const rows: SessionCollectionRecord[] = [
      {
        id: "old",
        createdAt: old,
        updatedAt: new Date().toISOString(),
        observedAt: 0,
      },
      { id: "new", createdAt: new Date().toISOString(), observedAt: 0 },
    ];
    const mounted = renderHook(() => useSidebarSessionOrder(rows, []));
    expect(mounted.result.current.recent.map((row) => row.id)).toEqual(["new"]);
    expect(mounted.result.current.older.map((row) => row.id)).toEqual(["old"]);
    act(() => recordSessionInteraction(first, "old"));
    expect(mounted.result.current.recent.map((row) => row.id)).toEqual([
      "old",
      "new",
    ]);
    mounted.unmount();
    invalidateLocalStorageValues();
    const remounted = renderHook(() => useSidebarSessionOrder(rows, []));
    expect(remounted.result.current.recent.map((row) => row.id)).toEqual([
      "old",
      "new",
    ]);
    act(() => setCurrentClientSummarySourceKey(other));
    expect(remounted.result.current.recent.map((row) => row.id)).toEqual([
      "new",
    ]);
    act(() => recordSessionInteraction(first, "new"));
    expect(remounted.result.current.older.map((row) => row.id)).toEqual([
      "old",
    ]);
  });

  it("places a session the reader answered on another device", () => {
    // Nothing stored here: this browser has never opened either session, the
    // position a second device would otherwise have kept to itself.
    setCurrentClientSummarySourceKey(
      createClientSummaryHostSourceKey("fresh-browser"),
    );
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    const rows: SessionCollectionRecord[] = [
      {
        id: "answered-elsewhere",
        createdAt: old,
        lastHumanTurnAt: new Date(Date.now() - 60000).toISOString(),
        updatedAt: new Date().toISOString(),
        observedAt: 0,
      },
      { id: "untouched", createdAt: old, observedAt: 0 },
    ];
    const { result } = renderHook(() => useSidebarSessionOrder(rows, []));
    expect(result.current.recent.map((row) => row.id)).toEqual([
      "answered-elsewhere",
    ]);
    expect(result.current.older.map((row) => row.id)).toEqual(["untouched"]);
  });

  it("keeps a local send ahead of an older turn from elsewhere", () => {
    const source = createClientSummaryHostSourceKey("local-send");
    setCurrentClientSummarySourceKey(source);
    const rows: SessionCollectionRecord[] = [
      {
        id: "answered-elsewhere",
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        lastHumanTurnAt: new Date(Date.now() - 60000).toISOString(),
        observedAt: 0,
      },
      {
        id: "sent-here",
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        observedAt: 0,
      },
    ];
    const { result } = renderHook(() => useSidebarSessionOrder(rows, []));
    act(() => recordSessionInteraction(source, "sent-here"));
    expect(result.current.recent.map((row) => row.id)).toEqual([
      "sent-here",
      "answered-elsewhere",
    ]);
  });

  it("forgets visits recorded before only submissions counted", () => {
    const source = createClientSummaryHostSourceKey("pre-submission-visits");
    const legacyKey = `yep-sidebar-interactions:${encodeURIComponent(source)}`;
    localStorage.setItem(legacyKey, JSON.stringify([["visited", Date.now()]]));
    setCurrentClientSummarySourceKey(source);
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    const rows: SessionCollectionRecord[] = [
      { id: "visited", createdAt: old, isStarred: true, observedAt: 0 },
      {
        id: "answered",
        createdAt: old,
        lastHumanTurnAt: new Date(Date.now() - 60000).toISOString(),
        isStarred: true,
        observedAt: 0,
      },
    ];
    const { result } = renderHook(() => useSidebarSessionOrder(rows, rows));
    expect(result.current.starred.map((row) => row.id)).toEqual([
      "answered",
      "visited",
    ]);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it("ignores malformed stored history and bounds retained interactions", () => {
    const source = "bounded-order";
    localStorage.setItem(`yep-sidebar-submissions:${source}`, '{"bad":true}');
    expect(getSessionInteractionStore(source).read()).toBe("[]");
    for (let index = 0; index < 1002; index++) {
      recordSessionInteraction(source, `session-${index}`, 1000);
    }
    const saved = JSON.parse(getSessionInteractionStore(source).read());
    expect(saved).toHaveLength(1000);
    expect(saved[0][0]).toBe("session-1001");
    expect(saved.at(-1)[0]).toBe("session-2");
  });
});

describe("sidebar named sections", () => {
  it("files each session once: starred, category, API client, creator, then by time", () => {
    setCurrentClientSummarySourceKey(
      createClientSummaryHostSourceKey("named-sections"),
    );
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    const row = (
      id: string,
      fields: Partial<SessionCollectionRecord> = {},
    ): SessionCollectionRecord => ({
      id,
      createdAt: now,
      observedAt: 0,
      ...fields,
    });
    const starredFiled = row("starred-filed", {
      isStarred: true,
      sidebarCategory: "Paper",
    });
    const records = [
      starredFiled,
      row("paper", { sidebarCategory: "Paper", createdByUser: "bob" }),
      row("bob-new", { createdByUser: "bob" }),
      row("bob-old", { createdByUser: "bob", createdAt: old }),
      row("alice", { createdByUser: "alice" }),
      row("mine"),
      row("archived", { sidebarCategory: "Paper", isArchived: true }),
      row("harness-run", { apiClient: "learn-harness" }),
      row("harness-bob", { apiClient: "learn-harness", createdByUser: "bob" }),
      row("harness-filed", {
        apiClient: "learn-harness",
        sidebarCategory: "pii",
      }),
    ];
    // Named-section sessions beyond the recent page arrive through the
    // categorized feed: a category's, and a limited user's.
    const categorized = [
      row("pii-old", { sidebarCategory: "pii", createdAt: old }),
      row("carol-old", { createdByUser: "carol", createdAt: old }),
    ];

    const grouped = renderHook(() =>
      useSidebarSessionOrder(records, [starredFiled], categorized, true),
    ).result.current;
    const names = (groups: typeof grouped.categories) =>
      groups.map(({ name, rows }) => [name, rows.map(({ id }) => id)]);
    expect(grouped.starred.map(({ id }) => id)).toEqual(["starred-filed"]);
    expect(names(grouped.categories)).toEqual([
      ["Paper", ["paper"]],
      ["pii", ["harness-filed", "pii-old"]],
    ]);
    expect(
      grouped.apiClients.map(({ name, rows }) => [
        name,
        rows.map(({ id }) => id).sort(),
      ]),
    ).toEqual([["learn-harness", ["harness-bob", "harness-run"]]]);
    expect(names(grouped.creators)).toEqual([
      ["alice", ["alice"]],
      ["bob", ["bob-new", "bob-old"]],
      ["carol", ["carol-old"]],
    ]);
    expect(grouped.recent.map(({ id }) => id)).toEqual(["mine"]);
    expect(grouped.older).toEqual([]);

    // Without creator grouping, limited users' sessions stay in time order.
    const ungrouped = renderHook(() =>
      useSidebarSessionOrder(records, [starredFiled], categorized, false),
    ).result.current;
    expect(ungrouped.creators).toEqual([]);
    // API-client sessions stay grouped either way.
    expect(ungrouped.apiClients.map(({ name }) => name)).toEqual([
      "learn-harness",
    ]);
    expect(ungrouped.recent.map(({ id }) => id).sort()).toEqual([
      "alice",
      "bob-new",
      "mine",
    ]);
    // A feed-only session waits for the recent pages to reach it.
    expect(ungrouped.older.map(({ id }) => id)).toEqual(["bob-old"]);
  });
});
