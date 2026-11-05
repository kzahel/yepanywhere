import {
  Profiler,
  memo,
  startTransition,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type { SessionNavigationIntent } from "../components/SessionListItem";
import { useSessionPerformanceSettings } from "../hooks/useSessionPerformanceSettings";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import {
  sessionViewerSearch,
  viewerYaSessionId,
} from "../lib/sessionViewerUrl";

const SESSION_DOM_LINGER_TTL_MS = 60_000;
const SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS = 5_000;
const SESSION_DOM_LINGER_RESOURCE_TRANSITION_DELAY_MS = 500;

interface SessionRouteLocationSnapshot {
  hash: string;
  key: string;
  pathname: string;
  search: string;
  state: unknown;
}

export interface SessionDomLingerRoute {
  key: string;
  sourceKey: string;
  projectId: string;
  sessionId: string;
  location: SessionRouteLocationSnapshot;
  status: "active" | "parked";
  parkedAtMs?: number;
  expiresAtMs?: number;
}

interface PendingSessionDomLingerSwap {
  fromKey: string;
  retainOutgoing: boolean;
  targetKey: string;
}

export interface SessionDomLingerRenderSignal {
  current: boolean;
  activationVersion?: number;
  supportsCompaction: boolean;
}

export type SessionDomLingerElement = (
  route: SessionDomLingerRoute,
  options: {
    onSessionNavigate: (intent: SessionNavigationIntent) => void;
    parked: boolean;
    progressiveRenderPauseSignal: SessionDomLingerRenderSignal;
  },
) => ReactNode;

interface SessionDomLingerLayerHandle {
  element: HTMLDivElement;
  progressiveRenderPauseSignal: SessionDomLingerRenderSignal;
}

interface SessionDomLingerLayerProps {
  parked: boolean;
  route: SessionDomLingerRoute;
  sessionElement: SessionDomLingerElement;
  layerRefs: React.MutableRefObject<Map<string, SessionDomLingerLayerHandle>>;
  onSessionNavigate: (intent: SessionNavigationIntent) => void;
  subtreeParked: boolean;
}

interface SessionDomLingerSubtreeProps {
  onSessionNavigate: (intent: SessionNavigationIntent) => void;
  parked: boolean;
  progressiveRenderPauseSignal: SessionDomLingerRenderSignal;
  route: SessionDomLingerRoute;
  sessionElement: SessionDomLingerElement;
}

const SessionDomLingerSubtree = memo(function SessionDomLingerSubtree({
  onSessionNavigate,
  parked,
  progressiveRenderPauseSignal,
  route,
  sessionElement,
}: SessionDomLingerSubtreeProps) {
  return sessionElement(route, {
    onSessionNavigate,
    parked,
    progressiveRenderPauseSignal,
  });
});

function SessionDomLingerLayer({
  parked,
  route,
  sessionElement,
  layerRefs,
  onSessionNavigate,
  subtreeParked,
}: SessionDomLingerLayerProps) {
  const parentLocationContext = useContext(UNSAFE_LocationContext);
  const parentRouteContext = useContext(UNSAFE_RouteContext);
  if (!parentLocationContext) {
    throw new Error("Session DOM linger requires a router location context");
  }
  const [sessionRoute] = useState(route);
  const [progressiveRenderPauseSignal] = useState(() => ({
    current: parked,
    supportsCompaction: false,
    activationVersion: 0,
  }));
  if (progressiveRenderPauseSignal.current !== parked)
    progressiveRenderPauseSignal.activationVersion++;
  progressiveRenderPauseSignal.current = parked;
  const [committedSubtreeParked, setCommittedSubtreeParked] =
    useState(subtreeParked);
  useEffect(() => {
    if (committedSubtreeParked === subtreeParked) {
      return;
    }
    let timeoutId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        startTransition(() => setCommittedSubtreeParked(subtreeParked));
      }, SESSION_DOM_LINGER_RESOURCE_TRANSITION_DELAY_MS);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [committedSubtreeParked, subtreeParked]);
  const [sessionLocationContext] = useState(() => ({
    location: sessionRoute.location,
    navigationType: parentLocationContext.navigationType,
  }));
  const [sessionRouteContext] = useState(parentRouteContext);
  const scopedSubtree = (
    <UNSAFE_LocationContext.Provider value={sessionLocationContext}>
      <UNSAFE_RouteContext.Provider value={sessionRouteContext}>
        <SessionDomLingerSubtree
          onSessionNavigate={onSessionNavigate}
          parked={committedSubtreeParked}
          progressiveRenderPauseSignal={progressiveRenderPauseSignal}
          route={sessionRoute}
          sessionElement={sessionElement}
        />
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_LocationContext.Provider>
  );
  const handleRender = useCallback<React.ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration) => {
      markReloadPerfPhase("session_dom_linger_layer_render", {
        actualDuration,
        baseDuration,
        phase,
        sessionId: sessionRoute.sessionId,
        subtreeParked: committedSubtreeParked,
      });
    },
    [committedSubtreeParked, sessionRoute.sessionId],
  );

  return (
    <div
      ref={(element) => {
        if (element) {
          layerRefs.current.set(sessionRoute.key, {
            element,
            progressiveRenderPauseSignal,
          });
        } else {
          layerRefs.current.delete(sessionRoute.key);
        }
      }}
      className={`navigation-route-layer session-dom-linger-layer ${
        parked ? "is-parked" : "is-active"
      }`}
      aria-hidden={parked ? true : undefined}
      data-session-dom-linger={parked ? "parked" : "active"}
    >
      {typeof window !== "undefined" &&
      window.__YA_RELOAD_PERF_PROBE__?.mark ? (
        <Profiler id={sessionRoute.key} onRender={handleRender}>
          {scopedSubtree}
        </Profiler>
      ) : (
        scopedSubtree
      )}
    </div>
  );
}

function createSessionDomLingerKey(options: {
  sourceKey: string;
  projectId: string;
  sessionId: string;
  search: string;
}): string {
  return [
    encodeURIComponent(options.sourceKey),
    encodeURIComponent(options.projectId),
    encodeURIComponent(options.sessionId),
    encodeURIComponent(sessionViewerSearch(options.search)),
  ].join(":");
}

function readSessionRouteFromPathname(
  pathname: string,
  search: string,
): { projectId: string; sessionId: string } | null {
  const match = pathname.match(
    /(?:^|\/)projects\/([^/]+)\/sessions\/([^/]+)\/?$/,
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    sessionId: viewerYaSessionId(decodeURIComponent(match[2]), search),
  };
}

export interface SessionDomLingerHostState {
  onSessionNavigate: (intent: SessionNavigationIntent) => void;
  renderRouteStack: (foreground: ReactNode) => ReactNode;
}

interface SessionDomLingerHostProps {
  children: (state: SessionDomLingerHostState) => ReactNode;
  sessionElement?: SessionDomLingerElement;
}

export function SessionDomLingerRouteMarker() {
  return null;
}

export function SessionDomLingerHost({
  children,
  sessionElement,
}: SessionDomLingerHostProps) {
  const { sessionDomLingerEnabled } = useSessionPerformanceSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const sourceKey = useClientSummarySourceKey();
  const currentSessionMatch = useMemo(
    () => readSessionRouteFromPathname(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const currentSessionRoute = useMemo<SessionDomLingerRoute | null>(() => {
    if (!currentSessionMatch) {
      return null;
    }
    const { projectId, sessionId } = currentSessionMatch;
    return {
      key: createSessionDomLingerKey({
        sourceKey,
        projectId,
        sessionId,
        search: location.search,
      }),
      sourceKey,
      projectId,
      sessionId,
      location: {
        hash: location.hash,
        key: location.key,
        pathname: location.pathname.replace(
          /[^/]+\/?$/,
          encodeURIComponent(sessionId),
        ),
        search: sessionViewerSearch(location.search),
        state: location.state,
      },
      status: "active",
    };
  }, [
    currentSessionMatch,
    location.hash,
    location.key,
    location.pathname,
    location.search,
    location.state,
    sourceKey,
  ]);
  const [parkedSessionRoute, setParkedSessionRoute] =
    useState<SessionDomLingerRoute | null>(null);
  const [committedActiveSessionRoute, setCommittedActiveSessionRoute] =
    useState(currentSessionRoute);
  const pendingSessionSwapRef = useRef<PendingSessionDomLingerSwap | null>(
    null,
  );
  const pendingSessionSwap = pendingSessionSwapRef.current;
  const sessionLayerRefs = useRef(
    new Map<string, SessionDomLingerLayerHandle>(),
  );
  const pendingSwapRejectsOutgoing =
    pendingSessionSwap?.retainOutgoing === false &&
    committedActiveSessionRoute?.key === pendingSessionSwap.fromKey &&
    currentSessionRoute?.key === pendingSessionSwap.targetKey;
  const transitioningFromSessionRoute =
    sessionDomLingerEnabled &&
    !pendingSwapRejectsOutgoing &&
    committedActiveSessionRoute &&
    committedActiveSessionRoute.key !== currentSessionRoute?.key &&
    committedActiveSessionRoute.sourceKey === sourceKey &&
    (!currentSessionRoute ||
      (committedActiveSessionRoute.projectId ===
        currentSessionRoute.projectId &&
        committedActiveSessionRoute.sessionId !==
          currentSessionRoute.sessionId))
      ? committedActiveSessionRoute
      : null;
  const parkedSessionCandidate =
    transitioningFromSessionRoute ?? parkedSessionRoute;
  const renderedParkedSessionRoute =
    sessionDomLingerEnabled &&
    parkedSessionCandidate &&
    parkedSessionCandidate.key !== currentSessionRoute?.key &&
    parkedSessionCandidate.sourceKey === sourceKey &&
    (!currentSessionRoute ||
      parkedSessionCandidate.projectId === currentSessionRoute.projectId)
      ? { ...parkedSessionCandidate, status: "parked" as const }
      : null;
  // Layer order must not follow which session is active: swapping the order
  // of keyed siblings makes React move one layer's DOM node, and a moved node
  // loses its scroll position, so a parked reader returned to the top of the
  // transcript. Z-index classes, not DOM order, decide which layer shows.
  const renderedSessionRoutes = [
    currentSessionRoute,
    renderedParkedSessionRoute,
  ]
    .filter((route): route is SessionDomLingerRoute => route !== null)
    .sort((left, right) => left.key.localeCompare(right.key));

  useLayoutEffect(() => {
    const pendingSwap = pendingSessionSwapRef.current;
    if (
      pendingSwap &&
      (!sessionDomLingerEnabled ||
        currentSessionRoute?.key !== pendingSwap.fromKey)
    ) {
      pendingSessionSwapRef.current = null;
    }
  }, [currentSessionRoute?.key, sessionDomLingerEnabled]);

  useLayoutEffect(() => {
    const previousActiveRoute = committedActiveSessionRoute;
    setCommittedActiveSessionRoute(currentSessionRoute);
    setParkedSessionRoute((previousParkedRoute) => {
      if (!sessionDomLingerEnabled) {
        return null;
      }

      let nextParkedRoute = previousParkedRoute;
      if (
        previousActiveRoute &&
        previousActiveRoute.key !== currentSessionRoute?.key &&
        previousActiveRoute.sourceKey === sourceKey &&
        (!currentSessionRoute ||
          (previousActiveRoute.projectId === currentSessionRoute.projectId &&
            previousActiveRoute.sessionId !== currentSessionRoute.sessionId))
      ) {
        const now = Date.now();
        nextParkedRoute = {
          ...previousActiveRoute,
          status: "parked",
          parkedAtMs: now,
          expiresAtMs: now + SESSION_DOM_LINGER_TTL_MS,
        };
      }

      if (!nextParkedRoute) {
        return null;
      }
      if (
        nextParkedRoute.key === currentSessionRoute?.key ||
        nextParkedRoute.sourceKey !== sourceKey ||
        (currentSessionRoute &&
          nextParkedRoute.projectId !== currentSessionRoute.projectId)
      ) {
        return null;
      }
      if (currentSessionRoute) {
        const layer = sessionLayerRefs.current.get(nextParkedRoute.key);
        if (
          !layer ||
          (!layer.progressiveRenderPauseSignal.supportsCompaction &&
            layer.element.querySelectorAll("*").length >
              SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS)
        ) {
          return null;
        }
      }
      return nextParkedRoute;
    });
  }, [
    committedActiveSessionRoute,
    currentSessionRoute,
    sessionDomLingerEnabled,
    sourceKey,
  ]);

  useEffect(() => {
    if (parkedSessionRoute?.status !== "parked") {
      return;
    }
    const timeoutMs = Math.max(
      0,
      (parkedSessionRoute.expiresAtMs ?? 0) - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setParkedSessionRoute((previous) =>
        previous?.key === parkedSessionRoute.key && previous.status === "parked"
          ? null
          : previous,
      );
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [parkedSessionRoute]);

  useLayoutEffect(() => {
    for (const [key, layer] of sessionLayerRefs.current) {
      (layer.element as HTMLDivElement & { inert?: boolean }).inert =
        key !== currentSessionRoute?.key;
      layer.progressiveRenderPauseSignal.current =
        key !== currentSessionRoute?.key;
    }
  }, [currentSessionRoute?.key]);

  const onSessionNavigate = useCallback(
    (intent: SessionNavigationIntent) => {
      const { event, projectId, sessionId, href } = intent;
      if (
        !sessionDomLingerEnabled ||
        !currentSessionRoute ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        projectId !== currentSessionRoute.projectId ||
        sessionId === currentSessionRoute.sessionId
      ) {
        return;
      }
      const targetUrl = new URL(href, window.location.href);
      if (targetUrl.origin !== window.location.origin) {
        return;
      }
      const targetKey = createSessionDomLingerKey({
        sourceKey,
        projectId,
        sessionId,
        search: targetUrl.search,
      });
      if (!sessionLayerRefs.current.has(targetKey)) {
        return;
      }
      const outgoingLayer = sessionLayerRefs.current.get(
        currentSessionRoute.key,
      );
      const retainOutgoing =
        outgoingLayer !== undefined &&
        (outgoingLayer.progressiveRenderPauseSignal.supportsCompaction ||
          outgoingLayer.element.querySelectorAll("*").length <=
            SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS);

      event.preventDefault();
      for (const [key, layer] of sessionLayerRefs.current) {
        const active = key === targetKey;
        const { element, progressiveRenderPauseSignal } = layer;
        if (progressiveRenderPauseSignal.current !== !active)
          progressiveRenderPauseSignal.activationVersion =
            (progressiveRenderPauseSignal.activationVersion ?? 0) + 1;
        progressiveRenderPauseSignal.current = !active;
        element.classList.toggle("is-active", active);
        element.classList.toggle("is-parked", !active);
        if (active) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", "true");
        }
        element.dataset.sessionDomLinger = active ? "active" : "parked";
        (element as HTMLDivElement & { inert?: boolean }).inert = !active;
      }
      pendingSessionSwapRef.current = {
        fromKey: currentSessionRoute.key,
        retainOutgoing,
        targetKey,
      };
      markReloadPerfPhase("session_dom_linger_visual_swap", { sessionId });
      const basename = navigationContext?.basename ?? "/";
      const pathname =
        basename !== "/" &&
        (targetUrl.pathname === basename ||
          targetUrl.pathname.startsWith(`${basename}/`))
          ? targetUrl.pathname.slice(basename.length) || "/"
          : targetUrl.pathname;
      navigate({ hash: targetUrl.hash, pathname, search: targetUrl.search });
    },
    [
      currentSessionRoute,
      navigate,
      navigationContext?.basename,
      sessionDomLingerEnabled,
      sourceKey,
    ],
  );

  const renderRouteStack = useCallback(
    (foreground: ReactNode) => (
      <div className="navigation-route-stack">
        {sessionElement &&
          renderedSessionRoutes.map((route) => {
            const parked = route.key !== currentSessionRoute?.key;
            return (
              <SessionDomLingerLayer
                key={route.key}
                parked={parked}
                route={route}
                sessionElement={sessionElement}
                layerRefs={sessionLayerRefs}
                onSessionNavigate={onSessionNavigate}
                subtreeParked={parked}
              />
            );
          })}
        <div
          className={`navigation-route-layer navigation-route-foreground ${
            currentSessionRoute ? "is-hidden" : "is-active"
          }`}
          aria-hidden={currentSessionRoute ? true : undefined}
        >
          {foreground}
        </div>
      </div>
    ),
    [
      currentSessionRoute,
      onSessionNavigate,
      renderedSessionRoutes,
      sessionElement,
    ],
  );

  return children({
    onSessionNavigate,
    renderRouteStack,
  });
}
