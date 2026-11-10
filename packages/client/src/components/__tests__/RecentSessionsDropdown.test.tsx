// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import "../../../test/pointerEventShim";
import { RecentSessionsDropdown } from "../RecentSessionsDropdown";

const { globalSessionsState } = vi.hoisted(() => ({
  globalSessionsState: {
    sessions: [] as GlobalSessionItem[],
  },
}));

vi.mock("../../hooks/useGlobalSessionsFeed", () => ({
  useGlobalSessionsFeed: () => ({
    query: { scope: "global-sessions" },
  }),
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useSessionCollectionQueryRecords: () => globalSessionsState.sessions,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function session(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-2",
    title: "Shortened title...",
    fullTitle:
      "Longer complete title text that should be visible in the recent sessions dropdown",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:05:00.000Z",
    messageCount: 3,
    provider: "codex",
    projectId: "project-1",
    projectName: "yepanywhere",
    ownership: { owner: "none" },
    ...overrides,
  };
}

function triggerRef() {
  const element = document.createElement("button");
  // A popover closes when its trigger leaves the page, so it is on one.
  document.body.append(element);
  element.getBoundingClientRect = () =>
    ({
      bottom: 48,
      height: 24,
      left: 120,
      right: 240,
      top: 24,
      width: 120,
      x: 120,
      y: 24,
      toJSON: () => ({}),
    }) as DOMRect;

  const ref = createRef<HTMLElement>();
  Object.defineProperty(ref, "current", {
    value: element,
  });
  return ref;
}

describe("RecentSessionsDropdown", () => {
  afterEach(() => {
    cleanup();
    globalSessionsState.sessions = [];
    document.body.replaceChildren();
  });

  it("pins the live title even when archived, missing from the feed, or renamed", () => {
    const fullTitle = "Complete current session title ".repeat(25);
    const onNavigate = vi.fn();
    const renderDropdown = (title: string) => (
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle={title}
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={onNavigate}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>
    );
    const view = render(renderDropdown(fullTitle));
    expect(screen.getByText(fullTitle.trim())).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();

    // A stale/archived feed row must neither duplicate nor replace the title
    // from the open session; opening its text must not navigate away.
    globalSessionsState.sessions = [
      session({ id: "session-1", isArchived: true, fullTitle: "Stale title" }),
      session(),
    ];
    view.rerender(renderDropdown("Locally renamed title"));
    fireEvent.click(screen.getByText("Locally renamed title"));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Stale title")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("renders the full title instead of the shortened list title", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    // A navigation panel, not an action menu.
    expect(
      screen.getByRole("dialog", { name: "sessionRecentSessions" }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Longer complete title text that should be visible in the recent sessions dropdown",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Shortened title...")).toBeNull();
  });

  it("keeps session-switch tooltips off touch activation", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const item = screen.getByRole("link");
    expect(item.getAttribute("title")).toBeNull();

    fireEvent.pointerEnter(item, { pointerType: "touch" });
    expect(item.getAttribute("title")).toBeNull();
    expect(item.getAttribute("data-tooltip")).toBeNull();

    fireEvent.pointerEnter(item, { pointerType: "mouse" });
    expect(item.getAttribute("data-tooltip")).toBe(
      "Longer complete title text that should be visible in the recent sessions dropdown",
    );

    fireEvent.pointerDown(item, { pointerType: "touch" });
    expect(item.getAttribute("title")).toBeNull();
  });

  it("exposes the complete session title to keyboard focus", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const item = screen.getByRole("link");
    fireEvent.focus(item);

    expect(item.getAttribute("data-tooltip")).toBe(
      "Longer complete title text that should be visible in the recent sessions dropdown",
    );
  });

  it("identifies /btw rows and their parent navigation", () => {
    globalSessionsState.sessions = [
      session({
        title: "/btw check the flaky test",
        fullTitle: "/btw check the flaky test",
        parentSessionId: "session-parent",
      }),
    ];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("link", { name: /check the flaky test/ });
    expect(row.hasAttribute("data-btw-aside-session")).toBe(true);

    expect(screen.getByText("/btw")).toBeTruthy();
  });

  it("does not mark ordinary rows as /btw", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-btw-aside-session")).toBe(false);
  });

  it("does not label an ordinary parent-linked Clone as /btw", () => {
    globalSessionsState.sessions = [
      session({
        title: "Clone: investigate the cache",
        fullTitle: "Clone: investigate the cache",
        parentSessionId: "source-session",
      }),
    ];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          currentSessionTitle="Current title"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("link", { name: /Clone: investigate/ });
    expect(row.hasAttribute("data-btw-aside-session")).toBe(false);
    expect(screen.queryByText("/btw")).toBeNull();
  });
});
