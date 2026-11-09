// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { DEFAULT_HOVERCARD_SHOW_DELAY_MS } from "../../hooks/useHoverCardAppearance";
import {
  clearTooltipWarmth,
  DEFAULT_TOOLTIP_DELAY_MS,
} from "../../hooks/useTooltipAppearance";
import { I18nProvider } from "../../i18n";
import { activityBus } from "../../lib/activityBus";
import { UI_KEYS } from "../../lib/storageKeys";
import "../../../test/pointerEventShim";
import styles from "../SessionListItem.module.css";
import { SessionListItem } from "../SessionListItem";

const mockWindowOpen = vi.fn();
const originalClipboard = navigator.clipboard;

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("SessionListItem links", () => {
  beforeEach(() => {
    clearTooltipWarmth();
    localStorage.clear();
    mockWindowOpen.mockReset();
    vi.stubGlobal("open", mockWindowOpen);
  });

  afterEach(() => {
    cleanup();
    clearTooltipWarmth();
    localStorage.clear();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    vi.unstubAllGlobals();
  });

  function renderItem(onNavigate = vi.fn()) {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Build logs"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );
    return {
      link: screen.getByRole("link", { name: /Build logs/ }),
      onNavigate,
    };
  }

  it("shows creation age only when the creation timestamp is known", () => {
    const updatedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const knownCreation = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const renderCard = (createdAt?: string) => (
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Build logs"
              mode="card"
              updatedAt={updatedAt}
              createdAt={createdAt}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>
    );
    const view = render(renderCard());
    expect(view.container.querySelector(".session-list-item__age")).toBeNull();

    view.rerender(renderCard(knownCreation));
    expect(screen.getByText("Created 2d ago")).toBeTruthy();

    view.rerender(renderCard(new Date(0).toISOString()));
    expect(view.container.querySelector(".session-list-item__age")).toBeNull();
  });

  it("opens the session in a new window on middle click", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.mouseDown(link, { button: 1 });
    link.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("opens a new window on modified clicks without closing the current view", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.click(link, { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("publishes typed session navigation intent for an ordinary click", () => {
    const onSessionNavigate = vi.fn();
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Build logs"
              mode="compact"
              onSessionNavigate={onSessionNavigate}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: /Build logs/ }));

    expect(onSessionNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "/projects/project-1/sessions/session-1",
        projectId: "project-1",
        sessionId: "session-1",
      }),
    );
  });

  it("labels /btw aside sessions separately from their truncated title text", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              parentSessionId="source-1"
              parentSessionKind="btw-aside"
              title="/btw check the side path"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("check the side path")).toBeTruthy();
  });

  it("does not label an ordinary parent-linked Clone as /btw", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="clone-1"
              projectId="project-1"
              title="Clone: Main session"
              parentSessionId="source-1"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.queryByText("/btw")).toBeNull();
    expect(screen.getByText("Clone: Main session")).toBeTruthy();
  });

  it("keeps an explicitly typed /btw aside recognizable after rename", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="Renamed side investigation"
              parentSessionId="parent-1"
              parentSessionKind="btw-aside"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("Renamed side investigation")).toBeTruthy();
  });

  it("opens the parent /btw view when the aside badge is clicked", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={["/remote/test/projects/project-1/sessions/aside-1"]}
        >
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("location").textContent).toBe(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
    );
  });

  it("opens the parent /btw view in a new window on modified badge clicks", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"), { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
      "_blank",
      "noopener",
    );
  });

  it("focuses the rename field as it appears, with the title selected", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="rename-1"
              projectId="project-1"
              title="Old title"
              fullTitle="Old title"
              hasCustomTitle
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename..." }));

    // No timer flush: asking to rename means the next keystroke is the new
    // title, so focus cannot wait for a later turn of the event loop.
    const input = document.querySelector<HTMLInputElement>(
      "input.session-rename-input",
    );
    if (!input) throw new Error("expected the rename input");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([
      0,
      "Old title".length,
    ]);
  });

  it("copies the initial prompt from the session menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="failed-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Full initial prompt that should be recoverable"
              hasCustomTitle
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy prompt" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Full initial prompt that should be recoverable",
      );
    });
  });

  it("opens the session in a new tab from the session menu", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu new tab"
              provider="claude"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new tab" }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("attaches a measured native hint to the visible title owner", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              hasCustomTitle
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const link = screen.getByRole("link", { name: /Custom title/ });
    const title = link.querySelector<HTMLElement>(
      ".session-list-item__title-text",
    );
    expect(title).toBeTruthy();
    expect(link.getAttribute("title")).toBeNull();
    expect(title?.getAttribute("title")).toBeNull();

    fireEvent.pointerEnter(title!, { pointerType: "mouse", clientX: 20 });
    expect(title?.getAttribute("title")).toBe("Custom title");
  });

  it("exposes a known truncated card title in native mode", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="A visibly shortened title..."
              fullTitle="A visibly shortened title with its omitted ending"
              provider="claude"
              mode="card"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const title = screen
      .getByText("A visibly shortened title...")
      .closest("strong");
    expect(title?.getAttribute("title")).toBe(
      "A visibly shortened title with its omitted ending",
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a card-mode thinking dot when requested for active rows", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Active row"
              activity="in-turn"
              mode="card"
              showActivityIndicator
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const title = screen
      .getByRole("link", { name: "Active row" })
      .querySelector("strong");
    expect(title?.firstElementChild?.firstElementChild).not.toBeNull();
  });

  it("leaves card-mode activity hidden unless requested", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Active row"
              activity="in-turn"
              mode="card"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const title = screen
      .getByRole("link", { name: "Active row" })
      .querySelector("strong");
    expect(title?.children).toHaveLength(1);
  });

  it("uses custom titles for session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              initialPrompt="Original first turn"
              hasCustomTitle
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Custom title/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    // The prompt block is the hover card's first child; assert on the rendered
    // text rather than a class name the owning module now scopes.
    const hoverCard = screen.getByRole("tooltip");
    expect(hoverCard.firstElementChild?.textContent).toBe("Custom title");
    expect(hoverCard.textContent).not.toContain("Original first turn");
  });

  it("delays session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Delayed hover"
              initialPrompt="Delayed hover prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Delayed hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    expect(screen.queryByText("Delayed hover prompt")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Delayed hover prompt")).toBeTruthy();
  });

  it("restarts the session preview delay until the pointer rests", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Rested hover"
              initialPrompt="Rested hover prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Rested hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    fireEvent.pointerMove(item!, { pointerType: "mouse", clientX: 24 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    expect(screen.queryByText("Rested hover prompt")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Rested hover prompt")).toBeTruthy();
  });

  it("ignores touch compatibility mouse events for session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Touch navigation"
              initialPrompt="Touch navigation prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Touch navigation/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "touch", clientX: 20 });
    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    expect(screen.queryByText("Touch navigation prompt")).toBeNull();
  });

  it("uses only an ellipsis-aware title hint in native tooltip mode", () => {
    vi.useFakeTimers();
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    const refreshSpy = vi
      .spyOn(api, "refreshSessionPreview")
      .mockResolvedValue(undefined as never);

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Native delay"
              initialPrompt="Native delay prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Native delay/ })
      .closest("li");
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText("Native delay prompt")).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();

    const title = item?.querySelector<HTMLElement>(
      ".session-list-item__title-text",
    );
    expect(title).toBeTruthy();
    let scrollWidth = 100;
    Object.defineProperties(title!, {
      clientHeight: { configurable: true, value: 20 },
      clientWidth: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 20 },
      scrollWidth: { configurable: true, get: () => scrollWidth },
    });
    title!.getBoundingClientRect = () =>
      ({
        bottom: 30,
        height: 20,
        left: 10,
        right: 110,
        top: 10,
        width: 100,
      }) as DOMRect;

    fireEvent.pointerEnter(title!, { pointerType: "mouse", clientX: 20 });
    expect(title?.getAttribute("title")).toBeNull();

    scrollWidth = 200;
    fireEvent.pointerEnter(title!, { pointerType: "mouse", clientX: 20 });
    expect(title?.getAttribute("title")).toBe("Native delay");
    expect(title?.getAttribute("data-tooltip")).toBeNull();

    refreshSpy.mockRestore();
  });

  it("keeps a session hover preview open while the pointer is over the card", async () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Selectable hover"
              initialPrompt="Selectable hover prompt"
              lastAgentText="Selectable recap text"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Selectable hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    const hoverCard = screen.getByRole("tooltip");
    expect(hoverCard).toBeTruthy();
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.pointerLeave(item!, {
      pointerType: "mouse",
      relatedTarget: hoverCard,
    });
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.mouseLeave(hoverCard);
    expect(screen.queryByText("Selectable recap text")).toBeNull();
  });

  it("retains the configured delay between warm session previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="First session"
              initialPrompt="First session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
            <SessionListItem
              sessionId="session-2"
              projectId="project-1"
              title="Second session"
              initialPrompt="Second session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-2" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const firstItem = screen
      .getByRole("link", { name: /First session/ })
      .closest("li");
    const secondItem = screen
      .getByRole("link", { name: /Second session/ })
      .closest("li");
    expect(firstItem).toBeTruthy();
    expect(secondItem).toBeTruthy();

    fireEvent.pointerEnter(firstItem!, {
      pointerType: "mouse",
      clientX: 20,
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });
    expect(screen.getByText("First session prompt")).toBeTruthy();

    fireEvent.pointerLeave(firstItem!, {
      pointerType: "mouse",
      relatedTarget: secondItem,
    });
    fireEvent.pointerEnter(secondItem!, {
      pointerType: "mouse",
      clientX: 20,
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOOLTIP_DELAY_MS - 1);
    });
    expect(screen.queryByText("First session prompt")).toBeNull();
    expect(screen.queryByText("Second session prompt")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Second session prompt")).toBeTruthy();
  });

  it("keeps session hover previews open during unrelated scrolls", async () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <div data-testid="transcript-scroll" />
          <div data-testid="sidebar-scroll">
            <ul>
              <SessionListItem
                sessionId="session-1"
                projectId="project-1"
                title="Scoped scroll"
                initialPrompt="Scoped scroll prompt"
                provider="claude"
                status={{ owner: "self", processId: "pid-1" }}
                mode="compact"
              />
            </ul>
          </div>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Scoped scroll/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("transcript-scroll"));
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("sidebar-scroll"));
    expect(screen.queryByText("Scoped scroll prompt")).toBeNull();
  });

  it("does not use a native title tooltip for session menu options", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu title"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByLabelText("Session options").getAttribute("title")).toBe(
      null,
    );
  });

  it("does not show a hover card while the session menu is open", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu open"
              initialPrompt="Menu open prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Menu open/ }).closest("li");
    expect(item).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByLabelText("Session options"));
    });
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS + 50);
    });

    expect(screen.queryByText("Menu open prompt")).toBeNull();
  });

  it("emits a local metadata event after starring from the menu", async () => {
    const updateSpy = vi
      .spyOn(api, "updateSessionMetadata")
      .mockResolvedValue({ updated: true });
    const emitSpy = vi.spyOn(activityBus, "emitLocal");

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Star me"
              provider="claude"
              isStarred={false}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Star" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("session-1", { starred: true });
      expect(emitSpy).toHaveBeenCalledWith(
        "session-metadata-changed",
        expect.objectContaining({
          type: "session-metadata-changed",
          sessionId: "session-1",
          starred: true,
        }),
      );
    });

    updateSpy.mockRestore();
    emitSpy.mockRestore();
  });

  it("refreshes an idle preview only when the rested card is due", () => {
    vi.useFakeTimers();
    const refreshSpy = vi
      .spyOn(api, "refreshSessionPreview")
      .mockResolvedValue(undefined as never);

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Idle row"
              initialPrompt="Idle row prompt"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Idle row/ }).closest("li");
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });

    expect(refreshSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(refreshSpy).toHaveBeenCalledWith("project-1", "session-1");

    refreshSpy.mockRestore();
  });

  it("publishes only the latest pending session preview", () => {
    vi.useFakeTimers();
    const refreshSpy = vi
      .spyOn(api, "refreshSessionPreview")
      .mockResolvedValue(undefined as never);

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="First idle row"
              initialPrompt="First idle prompt"
              provider="claude"
              mode="compact"
            />
            <SessionListItem
              sessionId="session-2"
              projectId="project-1"
              title="Second idle row"
              initialPrompt="Second idle prompt"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );
    const first = screen
      .getByRole("link", { name: /First idle row/ })
      .closest("li");
    const second = screen
      .getByRole("link", { name: /Second idle row/ })
      .closest("li");

    fireEvent.pointerEnter(first!, { pointerType: "mouse", clientX: 20 });
    fireEvent.pointerEnter(second!, { pointerType: "mouse", clientX: 20 });
    act(() => vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS));

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("project-1", "session-2");
    expect(screen.queryByText("First idle prompt")).toBeNull();
    expect(screen.getByText("Second idle prompt")).toBeTruthy();

    refreshSpy.mockRestore();
  });

  it("opens the capable session-filtered share manager from the menu", async () => {
    const getPublicShares = vi.spyOn(api, "getPublicShares").mockResolvedValue({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Managed session"
              provider="claude"
              mode="compact"
              publicShareManagementAvailable
              publicShareCreationReady={false}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    expect(screen.getByText("Manage Public Shares")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Create and copy/ }),
    ).toBeNull();
    await waitFor(() => {
      expect(getPublicShares).toHaveBeenCalledWith({
        projectId: "project-1",
        sessionId: "session-1",
        mode: undefined,
      });
    });
    getPublicShares.mockRestore();
  });

  it("preserves the legacy share popup without management capability", async () => {
    const getStatus = vi
      .spyOn(api, "getPublicSessionShareStatus")
      .mockResolvedValue({
        activeCount: 0,
        frozenCount: 0,
        liveCount: 0,
        activeViewerCount: 0,
        viewers: [],
      });
    const getPublicShares = vi.spyOn(api, "getPublicShares");

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Legacy session"
              provider="claude"
              mode="compact"
              publicShareCreationReady
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));

    expect(screen.getByText("Public Session Share")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Copy Frozen Snapshot Link/ }),
    ).toBeTruthy();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(getPublicShares).not.toHaveBeenCalled();
    getStatus.mockRestore();
    getPublicShares.mockRestore();
  });

  it("hides the share menu action when neither path is available", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="No sharing"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("shows provider child work inside its parent session row", () => {
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname}</div>;
    }

    render(
      <I18nProvider>
        <MemoryRouter>
          <LocationProbe />
          <Routes>
            <Route
              path="/"
              element={
                <ul>
                  <SessionListItem
                    sessionId="session-parent"
                    projectId="project-1"
                    title="Parent session"
                    provider="claude"
                    mode="card"
                    providerChildren={[
                      {
                        id: "child-native-1",
                        parentSessionId: "session-parent",
                        title: "Audit the child-session API",
                        agentType: "general-purpose",
                        updatedAt: "2026-07-19T12:00:00.000Z",
                      },
                    ]}
                  />
                </ul>
              }
            />
            <Route
              path="/projects/:projectId/sessions/:sessionId/agents/:agentId"
              element={<div>opened child</div>}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("Audit the child-session API")).toBeTruthy();
    expect(screen.getByText("general-purpose")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("link", { name: /Audit the child-session API/ }),
    );
    expect(screen.getByText("opened child")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/project-1/sessions/session-parent/agents/child-native-1",
    );
  });

  it("shows number-only child counts with read and unread emphasis", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-parent"
              projectId="project-1"
              projectName="yepanywhere"
              showProjectName
              title="Parent session"
              provider="claude"
              mode="compact"
              providerChildren={[
                {
                  id: "child-native-1",
                  parentSessionId: "session-parent",
                  title: "First delegated task",
                  updatedAt: "2026-07-19T12:00:00.000Z",
                },
                {
                  id: "child-native-2",
                  parentSessionId: "session-parent",
                  title: "Second delegated task",
                  updatedAt: "2026-07-19T12:01:00.000Z",
                },
              ]}
            />
            <SessionListItem
              sessionId="session-unread"
              projectId="project-1"
              projectName="another-project"
              showProjectName
              hasUnread
              title="Unread parent session"
              provider="claude"
              mode="compact"
              providerChildren={[
                {
                  id: "child-native-3",
                  parentSessionId: "session-unread",
                  title: "New delegated task",
                  updatedAt: "2026-07-19T12:02:00.000Z",
                },
              ]}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const readBadge = screen.getByRole("img", {
      name: "2 provider subagents",
    });
    const unreadBadge = screen.getByRole("img", {
      name: "1 provider subagent",
    });

    expect(readBadge.textContent).toBe("2");
    expect(readBadge.className).not.toContain(
      styles.providerChildrenBadgeUnread,
    );
    expect(readBadge.getAttribute("title")).toBe(
      "2 provider subagents\nFirst delegated task\nSecond delegated task",
    );
    expect(unreadBadge.textContent).toBe("1");
    expect(unreadBadge.className).toContain(styles.providerChildrenBadgeUnread);
    expect(unreadBadge.getAttribute("title")).toBe(
      "1 provider subagent\nNew delegated task",
    );
    expect(screen.getByText("yepanywhere")).toBeTruthy();
  });

  it("discloses compact provider children without opening the parent", () => {
    const onNavigate = vi.fn();
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/"]}>
          <LocationProbe />
          <Routes>
            <Route
              path="/"
              element={
                <ul>
                  <SessionListItem
                    sessionId="session-parent"
                    projectId="project-1"
                    title="Parent session"
                    provider="claude"
                    mode="compact"
                    onNavigate={onNavigate}
                    providerChildren={[
                      {
                        id: "child-native-1",
                        parentSessionId: "session-parent",
                        title: "Audit the child-session API",
                        agentType: "general-purpose",
                        updatedAt: "2026-07-19T12:00:00.000Z",
                      },
                    ]}
                  />
                  <SessionListItem
                    sessionId="session-empty"
                    projectId="project-1"
                    title="No subagents"
                    provider="claude"
                    mode="compact"
                  />
                </ul>
              }
            />
            <Route
              path="/projects/:projectId/sessions/:sessionId/agents/:agentId"
              element={<div>opened compact child</div>}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    const disclosure = screen.getByRole("button", {
      name: "Show subagents for Parent session",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", {
        name: "Show subagents for No subagents",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Audit the child-session API/ }),
    ).toBeNull();

    fireEvent.click(disclosure);
    expect(screen.getByLabelText("location").textContent).toBe("/");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", {
          name: "Hide subagents for Parent session",
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("general-purpose")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide subagents for Parent session",
      }),
    );
    expect(
      screen.queryByRole("link", { name: /Audit the child-session API/ }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show subagents for Parent session",
      }),
    );
    fireEvent.click(
      screen.getByRole("link", { name: /Audit the child-session API/ }),
    );
    expect(screen.getByText("opened compact child")).toBeTruthy();
    expect(screen.getByLabelText("location").textContent).toBe(
      "/projects/project-1/sessions/session-parent/agents/child-native-1",
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("marks the most recently active subagent in the outline gutter", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-parent"
              projectId="project-1"
              title="Parent session"
              provider="claude"
              mode="compact"
              providerChildren={[
                {
                  id: "child-newest",
                  parentSessionId: "session-parent",
                  title: "Newest child",
                  updatedAt: "2026-07-19T12:00:00.000Z",
                },
                {
                  id: "child-nearby",
                  parentSessionId: "session-parent",
                  title: "Nearby child",
                  updatedAt: "2026-07-19T11:58:00.000Z",
                },
                {
                  id: "child-stale",
                  parentSessionId: "session-parent",
                  title: "Stale child",
                  updatedAt: "2026-07-19T09:00:00.000Z",
                },
              ]}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show subagents for Parent session" }),
    );

    const levelFor = (childTitle: string) =>
      screen
        .getByRole("link", { name: new RegExp(childTitle) })
        .querySelector("[data-activity]")
        ?.getAttribute("data-activity");

    expect(levelFor("Newest child")).toBe("latest");
    expect(levelFor("Nearby child")).toBe("recent");
    expect(levelFor("Stale child")).toBe("older");
  });

  it("keeps compact session rows free of Resume actions", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-interrupted"
              projectId="project-1"
              projectName="yepanywhere"
              showProjectName
              title="Interrupted session"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const project = screen.getByText("yepanywhere");
    const sessionLink = screen.getByRole("link", {
      name: /Interrupted session/i,
    });

    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    // The project name opens the same session as the title, but sits beside
    // the title area rather than inside it: the hover ... overlay fills the
    // right edge of that area and would otherwise cover the name and the
    // status letter next to it.
    const projectLink = project.closest("a");
    expect(projectLink?.getAttribute("href")).toBe(
      sessionLink.getAttribute("href"),
    );
    const overlayHost = document.querySelector(
      ".session-list-item__menu",
    )?.parentElement;
    expect(overlayHost).not.toBeNull();
    expect(overlayHost?.contains(project)).toBe(false);
  });
});
