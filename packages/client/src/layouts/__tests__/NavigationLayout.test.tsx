import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  GlossaryProjectProvider: vi.fn(
    ({
      children,
      enabled,
      projectId,
    }: {
      children: ReactNode;
      enabled?: boolean;
      projectId: string;
    }) => (
      <div
        data-testid="glossary-project-provider"
        data-enabled={enabled ? "true" : "false"}
        data-project-id={projectId}
      >
        {children}
      </div>
    ),
  ),
  SidebarSessionFeedsProvider: vi.fn(
    ({
      children,
      enabled,
    }: {
      children: React.ReactNode;
      enabled?: boolean;
    }) => (
      <div
        data-testid="sidebar-session-feeds-provider"
        data-enabled={enabled === false ? "false" : "true"}
      >
        {children}
      </div>
    ),
  ),
  Sidebar: vi.fn(
    ({
      isDesktop,
      onMinimize,
      onClose,
      currentSessionId,
    }: {
      isDesktop?: boolean;
      onMinimize?: () => void;
      onClose: () => void;
      currentSessionId?: string;
    }) => (
      <div
        data-testid={isDesktop ? "desktop-sidebar" : "mobile-sidebar"}
        data-current-session-id={currentSessionId ?? ""}
      >
        {onMinimize && (
          <button type="button" onClick={onMinimize}>
            Minimize sidebar
          </button>
        )}
        {!isDesktop && (
          <button type="button" onClick={onClose}>
            Close sidebar
          </button>
        )}
      </div>
    ),
  ),
}));

vi.mock("../../components/Sidebar", () => ({
  Sidebar: mocks.Sidebar,
  SidebarToggleIcon: () => <svg aria-hidden="true" />,
}));

// Layout tests do not own the banner's asynchronous version polling.
// The degraded-host E2E cases exercise the real banner and navigation together.
vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: null }),
}));

vi.mock("../../contexts/GlossaryContext", () => ({
  GlossaryProjectProvider: mocks.GlossaryProjectProvider,
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  SidebarSessionFeedsProvider: mocks.SidebarSessionFeedsProvider,
}));

import {
  NavigationLayout,
  SessionDomLingerRouteMarker,
  useNavigationLayout,
} from "../NavigationLayout";

function ContentFrameRoute() {
  const { openSidebar } = useNavigationLayout();
  return (
    <div data-testid="file-frame">
      <button type="button" onClick={openSidebar}>
        Open file sidebar
      </button>
      <Link to="/projects/project-1/sessions/session-1">Session 1</Link>
    </div>
  );
}

function renderNavigationLayout(path = "/agents") {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<NavigationLayout />}>
            <Route
              path="/agents"
              element={
                <div data-testid="route-content">
                  <textarea aria-label="Composer" />
                  <input aria-label="Toggle" type="checkbox" />
                </div>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function renderNavigationLayoutWithSessionLinger(
  path = "/projects/project-1/sessions/session-1",
  options: {
    onSessionRender?: (parked: boolean, sessionId: string) => void;
    sessionElementCount?: number | ((sessionId: string) => number);
  } = {},
) {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            element={
              <NavigationLayout
                sessionElement={(route, { onSessionNavigate, parked }) => {
                  options.onSessionRender?.(parked, route.sessionId);
                  return (
                    <div
                      data-testid="session-layer"
                      data-session-id={route.sessionId}
                      data-parked={parked ? "true" : "false"}
                    >
                      <Link to="/agents">Agents</Link>
                      <Link to="/projects/project-1/file?path=README.md">
                        File
                      </Link>
                      <Link
                        to="/projects/project-1/sessions/session-2"
                        onClick={(event) =>
                          onSessionNavigate({
                            event,
                            href: "/projects/project-1/sessions/session-2",
                            projectId: "project-1",
                            sessionId: "session-2",
                          })
                        }
                      >
                        Session 2
                      </Link>
                      {route.sessionId === "session-2" && (
                        <Link
                          to="/projects/project-1/sessions/session-1"
                          onClick={(event) =>
                            onSessionNavigate({
                              event,
                              href: "/projects/project-1/sessions/session-1",
                              projectId: "project-1",
                              sessionId: "session-1",
                            })
                          }
                        >
                          Session 1
                        </Link>
                      )}
                      {Array.from(
                        {
                          length:
                            typeof options.sessionElementCount === "function"
                              ? options.sessionElementCount(route.sessionId)
                              : (options.sessionElementCount ?? 0),
                        },
                        (_, index) => (
                          <span key={index} />
                        ),
                      )}
                    </div>
                  );
                }}
              />
            }
          >
            <Route
              path="/agents"
              element={
                <div data-testid="route-content">
                  <Link to="/projects/project-1/sessions/session-1">
                    Session 1
                  </Link>
                </div>
              }
            />
            <Route
              path="/projects/:projectId/file"
              element={<ContentFrameRoute />}
            />
            <Route
              path="/projects/:projectId/sessions/:sessionId"
              element={<SessionDomLingerRouteMarker />}
            />
            <Route
              path="/projects/:projectId/sessions/:sessionId/agents/:agentId"
              element={
                <div data-testid="provider-child-page">
                  <Link to="/projects/project-1/sessions/session-1">
                    Parent
                  </Link>
                </div>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function enableSessionDomLinger() {
  window.localStorage.setItem(UI_KEYS.sessionDomLinger, "true");
}

function installMobileVisualViewport(initialHeight = 800) {
  const previousInnerHeight = Object.getOwnPropertyDescriptor(
    window,
    "innerHeight",
  );
  const previousVisualViewport = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  let layoutHeight = initialHeight;
  let visualHeight = initialHeight;
  let offsetTop = 0;
  const visualViewport = new EventTarget();
  Object.defineProperties(visualViewport, {
    height: {
      configurable: true,
      get: () => visualHeight,
    },
    offsetTop: {
      configurable: true,
      get: () => offsetTop,
    },
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    get: () => layoutHeight,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });

  return {
    setGeometry(nextHeight: number, nextOffsetTop = 0) {
      visualHeight = nextHeight;
      offsetTop = nextOffsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    },
    setLayoutHeight(nextHeight: number) {
      layoutHeight = nextHeight;
      window.dispatchEvent(new Event("resize"));
    },
    restore() {
      if (previousInnerHeight) {
        Object.defineProperty(window, "innerHeight", previousInnerHeight);
      } else {
        Reflect.deleteProperty(window, "innerHeight");
      }
      if (previousVisualViewport) {
        Object.defineProperty(window, "visualViewport", previousVisualViewport);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
  };
}

describe("NavigationLayout", () => {
  beforeEach(() => {
    mocks.GlossaryProjectProvider.mockClear();
    mocks.SidebarSessionFeedsProvider.mockClear();
    mocks.Sidebar.mockClear();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.clear();
    delete window.__YA_RELOAD_PERF_PROBE__;
  });

  it("mounts sidebar session coverage once, above everything that reads it", () => {
    renderNavigationLayout();

    const provider = screen.getByTestId("sidebar-session-feeds-provider");
    expect(provider).toBeTruthy();
    // Both the rail and the overlay read the feeds the provider owns, so the
    // provider has to enclose them rather than sit beside them.
    expect(
      provider.querySelector('[data-testid="route-content"]'),
    ).toBeTruthy();
    expect(mocks.SidebarSessionFeedsProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps focused text-entry chrome inside a visual-only mobile viewport", () => {
    const viewport = installMobileVisualViewport();
    renderNavigationLayout();

    try {
      const frame = document.querySelector(".session-page") as HTMLElement;
      const composer = screen.getByRole("textbox", { name: "Composer" });

      act(() => composer.focus());
      act(() => viewport.setGeometry(480));
      expect(frame.style.paddingBottom).toContain("320px");

      act(() => viewport.setGeometry(800));
      fireEvent.change(composer, { target: { value: "voice transcript" } });
      act(() => viewport.setGeometry(480));
      expect(frame.style.paddingBottom).toContain("320px");

      act(() => viewport.setGeometry(480, 80));
      expect(frame.style.paddingBottom).toContain("240px");

      act(() => composer.blur());
      expect(frame.style.paddingBottom).toBe("");
    } finally {
      viewport.restore();
    }
  });

  it("does not double-inset when the layout viewport already resized", () => {
    const viewport = installMobileVisualViewport();
    renderNavigationLayout();

    try {
      const frame = document.querySelector(".session-page") as HTMLElement;
      const composer = screen.getByRole("textbox", { name: "Composer" });

      act(() => composer.focus());
      act(() => {
        viewport.setGeometry(480);
        viewport.setLayoutHeight(480);
      });

      expect(frame.style.paddingBottom).toBe("");
    } finally {
      viewport.restore();
    }
  });

  it("resizes both tablet panes for composer or iframe focus, but ignores pinch zoom", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    const viewport = installMobileVisualViewport();
    renderNavigationLayout();
    const app = document.createElement("iframe");
    document.body.append(app);
    try {
      const frame = document.querySelector(".session-page") as HTMLElement;
      act(() => screen.getByRole("textbox", { name: "Composer" }).focus());
      act(() => viewport.setGeometry(480));
      expect(frame.style.paddingBottom).toContain("320px");
      act(() => app.focus());
      act(() => viewport.setGeometry(500));
      expect(frame.style.paddingBottom).toContain("300px");
      Object.defineProperty(window.visualViewport, "scale", {
        configurable: true,
        value: 2,
      });
      act(() => viewport.setGeometry(400));
      expect(frame.style.paddingBottom).toBe("");
    } finally {
      app.remove();
      viewport.restore();
    }
  });

  it("does not reserve keyboard space for non-text controls", () => {
    const viewport = installMobileVisualViewport();
    renderNavigationLayout();

    try {
      const frame = document.querySelector(".session-page") as HTMLElement;
      const toggle = screen.getByRole("checkbox", { name: "Toggle" });

      act(() => toggle.focus());
      act(() => viewport.setGeometry(480));

      expect(frame.style.paddingBottom).toBe("");
    } finally {
      viewport.restore();
    }
  });

  it("removes the collapsed desktop rail and restores it from the floating toggle", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    window.localStorage.setItem(UI_KEYS.sidebarExpanded, "false");
    renderNavigationLayout();

    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByText("Minimize sidebar"));

    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    expect(
      screen.getByTestId("sidebar-session-feeds-provider").dataset.enabled,
    ).toBe("false");
    const restoreButton = screen.getByRole("button", {
      name: "Restore sidebar",
    });
    expect(restoreButton.hasAttribute("data-sidebar-floating-restore")).toBe(
      true,
    );
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("true");

    fireEvent.click(restoreButton);

    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();
    expect(
      screen.getByTestId("sidebar-session-feeds-provider").dataset.enabled,
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Restore sidebar" }),
    ).toBeNull();
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("false");
  });

  it("leaves the minimized restore link's auxiliary activation to the browser", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    window.localStorage.setItem(UI_KEYS.sidebarExpanded, "false");
    window.localStorage.setItem(UI_KEYS.sidebarMinimized, "true");
    renderNavigationLayout("/agents?view=active#recent");

    const restoreLink = screen.getByRole("button", {
      name: "Restore sidebar",
    });
    expect(restoreLink.tagName).toBe("A");
    expect(restoreLink.getAttribute("href")).toBe("/agents?view=active#recent");

    const auxiliaryClick = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    fireEvent(restoreLink, auxiliaryClick);

    expect(auxiliaryClick.defaultPrevented).toBe(false);
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("true");
    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
  });

  it("restores the minimized sidebar with Space", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    window.localStorage.setItem(UI_KEYS.sidebarExpanded, "false");
    window.localStorage.setItem(UI_KEYS.sidebarMinimized, "true");
    renderNavigationLayout();

    fireEvent.keyDown(screen.getByRole("button", { name: "Restore sidebar" }), {
      key: " ",
    });

    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("false");
  });

  it("parks one session DOM layer under a non-session route and reveals it", async () => {
    enableSessionDomLinger();
    renderNavigationLayoutWithSessionLinger();

    const sessionLayer = screen.getByTestId("session-layer");
    expect(sessionLayer.dataset.sessionId).toBe("session-1");
    expect(sessionLayer.dataset.parked).toBe("false");

    fireEvent.click(screen.getByText("Agents"));

    expect(screen.getByTestId("route-content")).toBeTruthy();
    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
    expect(
      screen
        .getByTestId("session-layer")
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");
    await waitFor(() => {
      expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");
    });

    fireEvent.click(screen.getByText("Session 1"));

    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(
      sessionLayer
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("active");
    await waitFor(() => {
      expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
    });
  });

  it("parks the session DOM under a full-frame project file route", async () => {
    enableSessionDomLinger();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    renderNavigationLayoutWithSessionLinger();

    const sessionLayer = screen.getByTestId("session-layer");

    fireEvent.click(screen.getByText("File"));

    expect(screen.getByTestId("file-frame")).toBeTruthy();
    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    expect(screen.queryByTestId("mobile-sidebar")).toBeNull();
    expect(
      screen.getByTestId("sidebar-session-feeds-provider").dataset.enabled,
    ).toBe("false");
    expect(
      screen
        .getByTestId("session-layer")
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");
    await waitFor(() => {
      expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");
    });

    fireEvent.click(screen.getByText("Open file sidebar"));

    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    expect(screen.getByTestId("mobile-sidebar")).toBeTruthy();
    expect(
      screen.getByTestId("sidebar-session-feeds-provider").dataset.enabled,
    ).toBe("true");
    expect(screen.getByTestId("file-frame")).toBeTruthy();

    fireEvent.click(screen.getByText("Close sidebar"));

    expect(screen.queryByTestId("mobile-sidebar")).toBeNull();
    expect(
      screen.getByTestId("sidebar-session-feeds-provider").dataset.enabled,
    ).toBe("false");
    expect(screen.getByTestId("file-frame")).toBeTruthy();

    fireEvent.click(screen.getByText("Session 1"));

    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");
    expect(
      sessionLayer
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("active");
    await waitFor(() => {
      expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
    });
  });

  it("parks the parent session under a read-only child page and keeps sidebar highlight", () => {
    enableSessionDomLinger();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    renderNavigationLayoutWithSessionLinger(
      "/projects/project-1/sessions/session-1/agents/child-1",
    );

    expect(screen.getByTestId("provider-child-page")).toBeTruthy();
    expect(screen.queryByTestId("session-layer")).toBeNull();
    expect(
      screen
        .getByTestId("desktop-sidebar")
        .getAttribute("data-current-session-id"),
    ).toBe("session-1");
  });

  it("expires the parked session DOM after the linger window", () => {
    enableSessionDomLinger();
    vi.useFakeTimers();
    renderNavigationLayoutWithSessionLinger();

    fireEvent.click(screen.getByText("Agents"));
    expect(
      screen
        .getByTestId("session-layer")
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.queryByTestId("session-layer")).toBeNull();
    expect(screen.getByTestId("route-content")).toBeTruthy();
  });

  it("does not park session DOM when session linger is disabled", () => {
    const sessionRenders: string[] = [];
    renderNavigationLayoutWithSessionLinger(
      "/projects/project-1/sessions/session-1",
      {
        onSessionRender: (parked, sessionId) => {
          sessionRenders.push(`${sessionId}:${parked ? "parked" : "active"}`);
        },
      },
    );

    fireEvent.click(screen.getByText("Agents"));

    expect(sessionRenders).not.toContain("session-1:parked");
    expect(screen.queryByTestId("session-layer")).toBeNull();
    expect(screen.getByTestId("route-content")).toBeTruthy();
  });

  it("parks one compact session during direct session switching and reuses it", async () => {
    enableSessionDomLinger();
    const mark = vi.fn();
    window.__YA_RELOAD_PERF_PROBE__ = { mark };
    renderNavigationLayoutWithSessionLinger();

    const firstSessionLayer = screen.getByTestId("session-layer");
    fireEvent.click(screen.getByText("Session 2"));

    const switchedLayers = screen.getAllByTestId("session-layer");
    const secondSessionLayer = switchedLayers.find(
      (layer) => layer.dataset.sessionId === "session-2",
    );
    const parkedFirstSessionLayer = switchedLayers.find(
      (layer) => layer.dataset.sessionId === "session-1",
    );
    expect(switchedLayers).toHaveLength(2);
    expect(parkedFirstSessionLayer).toBe(firstSessionLayer);
    expect(parkedFirstSessionLayer?.dataset.parked).toBe("false");
    expect(
      parkedFirstSessionLayer
        ?.closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");
    expect(secondSessionLayer).not.toBe(firstSessionLayer);
    expect(secondSessionLayer?.dataset.parked).toBe("false");
    await waitFor(() => {
      expect(parkedFirstSessionLayer?.dataset.parked).toBe("true");
    });

    fireEvent.click(
      within(secondSessionLayer as HTMLElement).getByText("Session 1"),
    );

    const returnedLayers = screen.getAllByTestId("session-layer");
    expect(returnedLayers).toHaveLength(2);
    expect(
      returnedLayers.find((layer) => layer.dataset.sessionId === "session-1"),
    ).toBe(firstSessionLayer);
    expect(firstSessionLayer.dataset.parked).toBe("true");
    expect(secondSessionLayer?.dataset.parked).toBe("false");
    expect(
      firstSessionLayer
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("active");
    await waitFor(() => {
      expect(firstSessionLayer.dataset.parked).toBe("false");
      expect(secondSessionLayer?.dataset.parked).toBe("true");
    });
    expect(mark).toHaveBeenCalledWith("session_dom_linger_visual_swap", {
      sessionId: "session-1",
    });
  });

  it("expires a directly parked session while the next session stays active", () => {
    enableSessionDomLinger();
    vi.useFakeTimers();
    renderNavigationLayoutWithSessionLinger();

    fireEvent.click(screen.getByText("Session 2"));
    expect(screen.getAllByTestId("session-layer")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    const remainingLayer = screen.getByTestId("session-layer");
    expect(remainingLayer.dataset.sessionId).toBe("session-2");
    expect(remainingLayer.dataset.parked).toBe("false");
  });

  it("does not retain an oversized session beside another session", () => {
    enableSessionDomLinger();
    renderNavigationLayoutWithSessionLinger(undefined, {
      sessionElementCount: 5_001,
    });

    fireEvent.click(screen.getByText("Session 2"));

    const remainingLayer = screen.getByTestId("session-layer");
    expect(remainingLayer.dataset.sessionId).toBe("session-2");
    expect(remainingLayer.dataset.parked).toBe("false");
  });

  it("discards an oversized outgoing session before rendering it parked", () => {
    enableSessionDomLinger();
    const sessionRenders: string[] = [];
    renderNavigationLayoutWithSessionLinger(undefined, {
      onSessionRender: (parked, sessionId) => {
        sessionRenders.push(`${sessionId}:${parked ? "parked" : "active"}`);
      },
      sessionElementCount: (sessionId) =>
        sessionId === "session-2" ? 5_001 : 0,
    });

    fireEvent.click(screen.getByText("Session 2"));
    expect(screen.getAllByTestId("session-layer")).toHaveLength(2);
    sessionRenders.length = 0;

    fireEvent.click(
      within(
        screen
          .getAllByTestId("session-layer")
          .find((layer) => layer.dataset.sessionId === "session-2")!,
      ).getByText("Session 1"),
    );

    expect(sessionRenders).not.toContain("session-2:parked");
    const remainingLayer = screen.getByTestId("session-layer");
    expect(remainingLayer.dataset.sessionId).toBe("session-1");
    expect(remainingLayer.dataset.parked).toBe("false");
  });

  it("retains one project glossary owner across same-project sessions", () => {
    renderNavigationLayoutWithSessionLinger();

    const glossaryProvider = screen.getByTestId("glossary-project-provider");
    expect(glossaryProvider.dataset.projectId).toBe("project-1");
    expect(glossaryProvider.dataset.enabled).toBe("true");

    fireEvent.click(screen.getByText("Session 2"));

    expect(screen.getByTestId("glossary-project-provider")).toBe(
      glossaryProvider,
    );
    expect(
      screen.getByTestId("glossary-project-provider").dataset.projectId,
    ).toBe("project-1");
  });
});
