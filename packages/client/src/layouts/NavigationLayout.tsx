import launcherStyles from "../components/SidebarLauncher.module.css";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { ProviderHostDegradedBanner } from "../components/ProviderHostDegradedBanner";
import styles from "./NavigationLayout.module.css";
import { Sidebar, SidebarToggleIcon } from "../components/Sidebar";
import { GlossaryProjectProvider } from "../contexts/GlossaryContext";
import { MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO } from "../lib/mobileKeyboardViewport";
import {
  readSessionViewerPath,
  useNativeViewerVersion,
  viewerYaSessionId,
} from "../lib/sessionViewerUrl";
import { useSidebarPreference } from "../hooks/useSidebarPreference";
import { usePanelSlideAnimations } from "../hooks/usePanelSlideAnimations";
import {
  DESKTOP_BREAKPOINT,
  MIN_CONTENT_WIDTH,
  useSidebarWidth,
} from "../hooks/useSidebarWidth";
import { SidebarSessionFeedsProvider } from "../hooks/useSidebarSessionFeeds";
import { useI18n } from "../i18n";
import {
  NativeSessionPathRoute,
  SessionDomLingerHost,
  SessionDomLingerRouteMarker,
  type SessionDomLingerElement,
} from "./SessionDomLingerHost";

export { NativeSessionPathRoute, SessionDomLingerRouteMarker };

export interface NavigationLayoutContext {
  /** Open the mobile sidebar */
  openSidebar: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isSidebarCollapsed: boolean;
  /** Desktop mode: callback to toggle sidebar expanded/collapsed state */
  toggleSidebar: () => void;
  /** Temporary sidebar collapse owned by the visible route's right pane. */
  setRightPaneExpanded?: (expanded: boolean) => void;
}

const NOOP = () => {};
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const NavigationLayoutReactContext =
  createContext<NavigationLayoutContext | null>(null);

interface NavigationLayoutProps {
  sessionElement?: SessionDomLingerElement;
}

interface ResponsiveLayoutState {
  isWideScreen: boolean;
  canShowExpandedSidebar: boolean;
}

function getViewportWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

function isKeyboardTextEntry(
  target: EventTarget | null,
): target is HTMLElement {
  if (target instanceof HTMLTextAreaElement) {
    return !target.disabled && !target.readOnly;
  }
  if (target instanceof HTMLInputElement) {
    return (
      !target.disabled &&
      !target.readOnly &&
      !NON_TEXT_INPUT_TYPES.has(target.type)
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function getVisualViewportBottomInset(
  activeElement: EventTarget | null = document.activeElement,
): number {
  const visualViewport = window.visualViewport;
  const layoutViewportHeight = window.innerHeight;
  if (
    !visualViewport ||
    Math.abs((visualViewport.scale ?? 1) - 1) > 0.01 ||
    !(
      isKeyboardTextEntry(activeElement) ||
      activeElement instanceof HTMLIFrameElement
    ) ||
    layoutViewportHeight <= 0 ||
    visualViewport.height >=
      layoutViewportHeight * MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO
  ) {
    return 0;
  }

  const visualViewportBottom =
    Math.max(0, visualViewport.offsetTop) + Math.max(0, visualViewport.height);
  return Math.ceil(Math.max(0, layoutViewportHeight - visualViewportBottom));
}

function getResponsiveLayoutState(
  sidebarWidth: number,
  viewportWidth = getViewportWidth(),
): ResponsiveLayoutState {
  return {
    isWideScreen: viewportWidth >= DESKTOP_BREAKPOINT,
    canShowExpandedSidebar: viewportWidth >= sidebarWidth + MIN_CONTENT_WIDTH,
  };
}

function responsiveLayoutStateEquals(
  left: ResponsiveLayoutState,
  right: ResponsiveLayoutState,
): boolean {
  return (
    left.isWideScreen === right.isWideScreen &&
    left.canShowExpandedSidebar === right.canShowExpandedSidebar
  );
}

function readSidebarSessionRouteFromPathname(
  pathname: string,
  search: string,
): { projectId: string; sessionId: string } | null {
  const viewer = readSessionViewerPath(pathname, search);
  if (viewer) {
    return viewer.sessionId
      ? { projectId: viewer.projectId, sessionId: viewer.sessionId }
      : null;
  }
  // Pages under a session, such as a provider child agent, keep its row.
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)\/sessions\/([^/]+)/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    sessionId: viewerYaSessionId(decodeURIComponent(match[2]), search),
  };
}

function readProjectIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isContentFrameRoutePathname(pathname: string): boolean {
  return /(?:^|\/)projects\/[^/]+\/file\/?$/.test(pathname);
}

/**
 * Shared layout for all pages that need a sidebar.
 * Renders the Sidebar once so it persists across route changes.
 */
export function NavigationLayout(props: NavigationLayoutProps) {
  return <NavigationLayoutFrame {...props} />;
}

function NavigationLayoutFrame({ sessionElement }: NavigationLayoutProps) {
  const { t } = useI18n();
  const { panelSlideDurationMs } = usePanelSlideAnimations();

  const location = useLocation();
  const nativeViewerVersion = useNativeViewerVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a native path resolving changes the result
  const sidebarSessionMatch = useMemo(
    () =>
      readSidebarSessionRouteFromPathname(location.pathname, location.search),
    [location.pathname, location.search, nativeViewerVersion],
  );
  const currentProjectId = useMemo(
    () => readProjectIdFromPathname(location.pathname),
    [location.pathname],
  );
  const isContentFrameRoute = useMemo(
    () => isContentFrameRoutePathname(location.pathname),
    [location.pathname],
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightPaneSidebar, setRightPaneSidebar] = useState<{
    path: string;
    collapse: boolean;
  } | null>(null);
  const setRightPaneExpanded = useCallback(
    (expanded: boolean) => {
      if (expanded) setSidebarOpen(false);
      setRightPaneSidebar((previous) =>
        expanded
          ? { path: location.pathname, collapse: true }
          : previous?.path === location.pathname
            ? null
            : previous,
      );
    },
    [location.pathname],
  );
  const rightPaneCollapsesSidebar =
    rightPaneSidebar?.path === location.pathname && rightPaneSidebar.collapse;
  const forceExpandedSidebar =
    new URLSearchParams(location.search).get("sidebar") === "expanded";
  const {
    isExpanded,
    isMinimized,
    toggleExpanded,
    minimizeToFloatingToggle,
    restoreCollapsedSidebar,
  } = useSidebarPreference(
    forceExpandedSidebar,
    /^(?:\/-\/relay\/[^/]+)?\/settings(?:\/|$)/.test(location.pathname)
      ? "collapsed"
      : null,
  );
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    isResizing,
    setIsResizing,
  } = useSidebarWidth();
  const [responsiveLayout, setResponsiveLayout] = useState(() =>
    getResponsiveLayoutState(sidebarWidth),
  );
  const layoutFrameRef = useRef<HTMLDivElement | null>(null);
  const updateResponsiveLayout = useCallback(() => {
    const next = getResponsiveLayoutState(sidebarWidth);
    setResponsiveLayout((previous) =>
      responsiveLayoutStateEquals(previous, next) ? previous : next,
    );
  }, [sidebarWidth]);

  useEffect(() => {
    updateResponsiveLayout();

    let frameId = 0;
    const handleResize = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateResponsiveLayout();
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [updateResponsiveLayout]);

  const { isWideScreen, canShowExpandedSidebar } = responsiveLayout;

  useEffect(() => {
    const frame = layoutFrameRef.current;
    if (!frame) {
      return;
    }

    const applyInset = (activeElement: EventTarget | null) => {
      const inset = getVisualViewportBottomInset(activeElement);
      if (inset > 0) {
        frame.style.paddingBottom = `calc(env(safe-area-inset-bottom, 0px) + ${inset}px)`;
      } else {
        frame.style.removeProperty("padding-bottom");
      }
    };
    const updateInset = () => applyInset(document.activeElement);
    const handleFocusIn = (event: FocusEvent) => applyInset(event.target);
    const handleFocusOut = (event: FocusEvent) =>
      applyInset(event.relatedTarget);

    updateInset();
    window.addEventListener("resize", updateInset);
    window.visualViewport?.addEventListener("resize", updateInset);
    window.visualViewport?.addEventListener("scroll", updateInset);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      window.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("scroll", updateInset);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  // Auto-collapse if viewport too narrow for expanded sidebar, or if user prefers collapsed
  const effectivelyCollapsed =
    !isExpanded || !canShowExpandedSidebar || rightPaneCollapsesSidebar;

  // Close mobile sidebar overlay when viewport becomes wide enough for expanded desktop sidebar
  // This prevents having both sidebars visible after window resize/device rotation
  // Only auto-close when desktop sidebar is actually visible (isWideScreen)
  useEffect(() => {
    if (
      !isContentFrameRoute &&
      sidebarOpen &&
      isWideScreen &&
      canShowExpandedSidebar
    ) {
      setSidebarOpen(false);
    }
  }, [canShowExpandedSidebar, isContentFrameRoute, isWideScreen, sidebarOpen]);

  // Smart toggle: if viewport can support expanded, toggle preference; otherwise open overlay
  const handleToggleExpanded = useCallback(() => {
    if (rightPaneCollapsesSidebar && canShowExpandedSidebar) {
      setRightPaneSidebar({ path: location.pathname, collapse: false });
      if (!isExpanded) toggleExpanded();
      return;
    }
    if (canShowExpandedSidebar) {
      toggleExpanded();
    } else {
      // Viewport too narrow for expanded sidebar - open mobile-style overlay instead
      setSidebarOpen(true);
    }
  }, [
    canShowExpandedSidebar,
    toggleExpanded,
    rightPaneCollapsesSidebar,
    location.pathname,
    isExpanded,
  ]);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleResizeStart = useCallback(
    () => setIsResizing(true),
    [setIsResizing],
  );
  const handleResizeEnd = useCallback(
    () => setIsResizing(false),
    [setIsResizing],
  );

  const context: NavigationLayoutContext = useMemo(
    () => ({
      openSidebar,
      isWideScreen,
      isSidebarCollapsed: effectivelyCollapsed,
      toggleSidebar: handleToggleExpanded,
      setRightPaneExpanded,
    }),
    [
      effectivelyCollapsed,
      handleToggleExpanded,
      isWideScreen,
      openSidebar,
      setRightPaneExpanded,
    ],
  );

  const containerStyle = useMemo(
    () =>
      ({
        "--sidebar-width": isWideScreen ? `${sidebarWidth}px` : undefined,
        "--panel-slide-duration": `${panelSlideDurationMs}ms`,
        "--panel-fade-duration": panelSlideDurationMs ? undefined : "0s",
      }) as React.CSSProperties,
    [isWideScreen, sidebarWidth, panelSlideDurationMs],
  );
  const desktopSidebarStyle = useMemo(
    () => ({ width: effectivelyCollapsed ? undefined : sidebarWidth }),
    [effectivelyCollapsed, sidebarWidth],
  );

  const sidebarFeedsEnabled = isContentFrameRoute
    ? sidebarOpen
    : (isWideScreen && !isMinimized) || (!isWideScreen && sidebarOpen);

  return (
    <SessionDomLingerHost sessionElement={sessionElement}>
      {({ onSessionNavigate, renderRouteStack }) => (
        <SidebarSessionFeedsProvider enabled={sidebarFeedsEnabled}>
          <div className={styles.shell}>
            <ProviderHostDegradedBanner />
            <div
              ref={layoutFrameRef}
              data-desktop-layout={isWideScreen || undefined}
              className={`${styles.frame} ${styles["session-page"]} ${isWideScreen ? styles.desktopLayout : ""} ${
                isContentFrameRoute ? "" : ""
              } ${isResizing ? styles.resizing : ""}`}
              data-session-page
              style={containerStyle}
            >
              {/* Desktop sidebar - always visible on wide screens; the minimized mode
          renders the floating restore toggle in its place */}
              {isWideScreen &&
                !isContentFrameRoute &&
                (isMinimized ? (
                  <Link
                    to={{
                      pathname: location.pathname,
                      search: location.search,
                      hash: location.hash,
                    }}
                    className={`${launcherStyles.sidebarToggle} ${styles.sidebarFloatingRestore}`}
                    data-sidebar-toggle
                    data-sidebar-floating-restore
                    role="button"
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      ) {
                        return;
                      }
                      event.preventDefault();
                      restoreCollapsedSidebar();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== " ") {
                        return;
                      }
                      event.preventDefault();
                      restoreCollapsedSidebar();
                    }}
                    title={t("actionRestoreSidebar")}
                    aria-label={t("actionRestoreSidebar")}
                  >
                    <SidebarToggleIcon />
                  </Link>
                ) : (
                  <aside
                    className={`${styles.sidebarDesktop} ${effectivelyCollapsed ? styles.sidebarCollapsed : ""} ${isResizing ? styles.resizing : ""}`}
                    data-sidebar-desktop
                    data-sidebar-collapsed={effectivelyCollapsed || undefined}
                    style={desktopSidebarStyle}
                  >
                    <Sidebar
                      isOpen={true}
                      onClose={NOOP}
                      onNavigate={NOOP}
                      onSessionNavigate={onSessionNavigate}
                      currentSessionId={sidebarSessionMatch?.sessionId}
                      isDesktop={true}
                      isCollapsed={effectivelyCollapsed}
                      onToggleExpanded={handleToggleExpanded}
                      onMinimize={minimizeToFloatingToggle}
                      sidebarWidth={sidebarWidth}
                      onResizeStart={handleResizeStart}
                      onResize={setSidebarWidth}
                      onResizeEnd={handleResizeEnd}
                    />
                  </aside>
                ))}

              {/* Mobile sidebar - modal overlay (also used for constrained desktop overlay) */}
              {(isContentFrameRoute
                ? sidebarOpen
                : !isWideScreen || sidebarOpen) && (
                <Sidebar
                  isOpen={sidebarOpen}
                  onClose={closeSidebar}
                  onNavigate={closeSidebar}
                  onSessionNavigate={onSessionNavigate}
                  currentSessionId={sidebarSessionMatch?.sessionId}
                />
              )}

              <GlossaryProjectProvider
                projectId={currentProjectId ?? ""}
                enabled={currentProjectId !== null}
              >
                <NavigationLayoutReactContext.Provider value={context}>
                  {renderRouteStack(<Outlet context={context} />)}
                </NavigationLayoutReactContext.Provider>
              </GlossaryProjectProvider>
            </div>
          </div>
        </SidebarSessionFeedsProvider>
      )}
    </SessionDomLingerHost>
  );
}

/**
 * Hook for child routes to access the shared navigation layout context.
 */
export function useNavigationLayout(): NavigationLayoutContext {
  const context = useContext(NavigationLayoutReactContext);
  const outletContext = useOutletContext<NavigationLayoutContext | null>();
  if (context) {
    return context;
  }
  if (outletContext) {
    return outletContext;
  }
  throw new Error("useNavigationLayout must be used under NavigationLayout");
}
