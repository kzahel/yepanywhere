import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useNeedsAttentionBadge } from "../hooks/useNeedsAttentionBadge";
import {
  getRecentProjectId,
  resolvePreferredProjectId,
} from "../hooks/useRecentProject";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { prefetchSessionLoad } from "../lib/sessionLoadCache";
import { getSessionDisplayTitle, toUrlProjectId } from "../utils";
import { AgentsNavItem } from "./AgentsNavItem";
import { SessionListItem } from "./SessionListItem";
import {
  SidebarIcons,
  SidebarNavItem,
  SidebarNavSection,
} from "./SidebarNavItem";
import { YepAnywhereLogo } from "./YepAnywhereLogo";

const SWIPE_THRESHOLD = 50; // Minimum distance to trigger close
const SWIPE_ENGAGE_THRESHOLD = 15; // Minimum horizontal distance before swipe engages
const RECENT_SESSIONS_INITIAL = 12; // Initial number of recent sessions to show
const RECENT_SESSIONS_INCREMENT = 10; // How many more to show on each expand
const SESSION_LIST_DELAY_MS = 750; // Let page-critical data load first
const COMPACT_SESSION_LIST_LIMIT = 8; // Session/Agents 页只显示少量最近会话

function extractProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: () => void;

  /** Current session ID (for highlighting in sidebar) */
  currentSessionId?: string;

  /** Desktop mode: sidebar is always visible, no overlay */
  isDesktop?: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isCollapsed?: boolean;
  /** Desktop mode: callback to toggle expanded/collapsed state */
  onToggleExpanded?: () => void;
  /** Desktop mode: current sidebar width in pixels */
  sidebarWidth?: number;
  /** Desktop mode: called when resize starts */
  onResizeStart?: () => void;
  /** Desktop mode: called during resize with new width */
  onResize?: (width: number) => void;
  /** Desktop mode: called when resize ends */
  onResizeEnd?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  onNavigate,
  currentSessionId,
  // Desktop mode props
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
  sidebarWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SidebarProps) {
  const { t } = useI18n();
  // Get base path for relay mode (e.g., "/remote/my-server")
  const basePath = useRemoteBasePath();
  const location = useLocation();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const isSessionPage = /^\/projects\/[^/]+\/sessions\/[^/]+$/.test(
    location.pathname,
  );
  const isAgentsPage = /\/agents$/.test(location.pathname);
  const useCompactSessionLists = isSessionPage || isAgentsPage;
  const canShowSessionLists = isDesktop ? !isCollapsed : isOpen;
  const [sessionListsEnabled, setSessionListsEnabled] = useState(false);

  useEffect(() => {
    if (!canShowSessionLists) {
      return;
    }

    const timer = setTimeout(() => {
      setSessionListsEnabled(true);
    }, SESSION_LIST_DELAY_MS);

    return () => clearTimeout(timer);
  }, [canShowSessionLists]);

  // Fetch one shared session list for the expanded sidebar only.
  const { sessions: sidebarSessions, loading: sessionsLoading } =
    useGlobalSessions({
      limit: useCompactSessionLists ? COMPACT_SESSION_LIST_LIMIT : 100,
      includeStats: false,
      enabled: sessionListsEnabled,
    });

  // Server capabilities for feature gating
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];

  // Global inbox count
  const inboxCount = useNeedsAttentionBadge();
  const projectIdFromUrl = extractProjectIdFromPath(location.pathname);
  const shouldLoadProjectLists = !isSessionPage && !isAgentsPage;
  const { recentProjects, projects } = useRecentProjects(
    shouldLoadProjectLists,
  );
  const recentProjectId = getRecentProjectId();
  const newSessionProjectId =
    projectIdFromUrl ??
    resolvePreferredProjectId(
      projects,
      recentProjects[0]?.id ?? recentProjectId,
    ) ??
    recentProjectId;

  const sidebarRef = useRef<HTMLElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef<boolean>(false);
  const prefetchedSidebarSessionsRef = useRef<Set<string>>(new Set());
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);
  const [recentSessionsLimit, setRecentSessionsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );
  const [olderSessionsLimit, setOlderSessionsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );
  const [starredSessionsLimit, setStarredSessionsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0]?.clientX;
    const currentY = e.touches[0]?.clientY;
    if (currentX === undefined || currentY === undefined) return;

    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    // If not yet engaged, check if we should engage the swipe
    if (!swipeEngaged.current) {
      const absDiffX = Math.abs(diffX);
      const absDiffY = Math.abs(diffY);

      // Engage swipe only if:
      // 1. Horizontal movement exceeds threshold
      // 2. Horizontal movement is greater than vertical (user is swiping, not scrolling)
      // 3. Movement is to the left (closing gesture)
      if (
        absDiffX > SWIPE_ENGAGE_THRESHOLD &&
        absDiffX > absDiffY &&
        diffX < 0
      ) {
        swipeEngaged.current = true;
      } else {
        return; // Not engaged yet, don't track offset
      }
    }

    // Only allow swiping left (negative offset)
    if (diffX < 0) {
      setSwipeOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    if (swipeEngaged.current && swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  // Desktop sidebar resize handlers
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (!isDesktop || isCollapsed || !sidebarWidth) return;
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
    onResizeStart?.();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null)
        return;
      const diff = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + diff;
      onResize?.(newWidth);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onResize, onResizeEnd]);

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
    onNavigate();
  };

  const filteredStarredSessions = useMemo(() => {
    return sidebarSessions.filter((s) => s.isStarred && !s.isArchived);
  }, [sidebarSessions]);

  // Sessions updated in the last 24 hours (non-starred, non-archived)
  const recentDaySessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isWithinLastDay = (date: Date) => date.getTime() >= oneDayAgo;

    return sidebarSessions.filter(
      (s) =>
        !s.isStarred && !s.isArchived && isWithinLastDay(new Date(s.updatedAt)),
    );
  }, [sidebarSessions]);

  // Older sessions (non-starred, non-archived, NOT in last 24 hours)
  const olderSessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isOlderThanOneDay = (date: Date) => date.getTime() < oneDayAgo;

    return sidebarSessions.filter(
      (s) =>
        !s.isStarred &&
        !s.isArchived &&
        isOlderThanOneDay(new Date(s.updatedAt)),
    );
  }, [sidebarSessions]);

  useEffect(() => {
    if (!sessionListsEnabled) {
      return;
    }

    const sessionsToPrefetch = (
      useCompactSessionLists
        ? sidebarSessions
        : [...filteredStarredSessions, ...recentDaySessions, ...olderSessions]
    ).slice(0, COMPACT_SESSION_LIST_LIMIT);

    for (const session of sessionsToPrefetch) {
      if (
        session.ownership.owner === "self" ||
        session.activity === "in-turn"
      ) {
        continue;
      }
      if (prefetchedSidebarSessionsRef.current.has(session.id)) {
        continue;
      }

      prefetchedSidebarSessionsRef.current.add(session.id);
      void prefetchSessionLoad(session.projectId, session.id).catch(() => {
        prefetchedSidebarSessionsRef.current.delete(session.id);
      });
    }
  }, [
    filteredStarredSessions,
    olderSessions,
    recentDaySessions,
    sessionListsEnabled,
    sidebarSessions,
    useCompactSessionLists,
  ]);

  // Track which sessions have unsent drafts in localStorage
  const drafts = useDrafts();

  // In desktop mode, always render. In mobile mode, only render when open.
  if (!isDesktop && !isOpen) return null;

  // Sidebar toggle icon for desktop mode
  const SidebarToggleIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <>
      {/* Only show overlay in non-desktop mode */}
      {!isDesktop && (
        <div
          className="sidebar-overlay"
          onClick={onClose}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="button"
          tabIndex={0}
          aria-label={t("actionCloseSidebar")}
        />
      )}
      <aside
        ref={sidebarRef}
        className="sidebar"
        onTouchStart={!isDesktop ? handleTouchStart : undefined}
        onTouchMove={!isDesktop ? handleTouchMove : undefined}
        onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
        style={
          !isDesktop && swipeOffset < 0
            ? { transform: `translateX(${swipeOffset}px)`, transition: "none" }
            : undefined
        }
      >
        <div className="sidebar-header">
          {isDesktop && isCollapsed ? (
            /* Desktop collapsed mode: show toggle button to expand */
            <button
              type="button"
              className="sidebar-toggle"
              onClick={onToggleExpanded}
              title={t("actionExpandSidebar")}
              aria-label={t("actionExpandSidebar")}
            >
              <SidebarToggleIcon />
            </button>
          ) : isDesktop ? (
            /* Desktop expanded mode: show brand (toggle is in toolbar) */
            <span className="sidebar-brand">
              <YepAnywhereLogo />
            </span>
          ) : (
            /* Mobile mode: brand text + close button */
            <>
              <span className="sidebar-brand">
                <YepAnywhereLogo />
              </span>
              <button
                type="button"
                className="sidebar-close"
                onClick={onClose}
                aria-label={t("actionCloseSidebar")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="sidebar-actions">
          {/* New Session: link to most recent project's new session page */}
          <SidebarNavItem
            to={
              newSessionProjectId
                ? `/new-session?projectId=${encodeURIComponent(newSessionProjectId)}`
                : "/new-session"
            }
            icon={SidebarIcons.newSession}
            label={t("sidebarNewSession")}
            onClick={onNavigate}
            basePath={basePath}
          />
        </div>

        <div className="sidebar-sessions">
          {/* Navigation items that scroll with content */}
          <SidebarNavSection>
            <SidebarNavItem
              to="/inbox"
              icon={SidebarIcons.inbox}
              label={t("sidebarInbox")}
              badge={inboxCount}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label={t("sidebarAllSessions")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label={t("sidebarProjects")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {capabilities.includes("git-status") && (
              <SidebarNavItem
                to="/git-status"
                icon={SidebarIcons.sourceControl}
                label={t("sidebarSourceControl")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            {(capabilities.includes("deviceBridge") ||
              capabilities.includes("deviceBridge-download")) && (
              <SidebarNavItem
                to="/devices"
                icon={SidebarIcons.emulator}
                label={t("sidebarDevices")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            <AgentsNavItem
              onClick={onNavigate}
              basePath={basePath}
              enabled={!isAgentsPage}
            />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label={t("sidebarSettings")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {/* Switch Host - show whenever we have a remote connection */}
            {remoteConnection && (
              <button
                type="button"
                className="sidebar-nav-item sidebar-switch-host"
                onClick={handleSwitchHost}
              >
                <span className="sidebar-nav-icon">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                </span>
                <span className="sidebar-nav-label">
                  {t("sidebarSwitchHost")}
                </span>
              </button>
            )}
          </SidebarNavSection>

          {/* Global sessions list */}
          {sessionListsEnabled &&
            useCompactSessionLists &&
            sidebarSessions.length > 0 && (
              <div className="sidebar-section">
                <h3 className="sidebar-section-title">
                  {t("sidebarSectionLast24Hours")}
                </h3>
                <ul className="sidebar-session-list">
                  {sidebarSessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={getSessionDisplayTitle(session)}
                      provider={session.provider}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                    />
                  ))}
                </ul>
              </div>
            )}

          {sessionListsEnabled &&
            !useCompactSessionLists &&
            filteredStarredSessions.length > 0 && (
              <div className="sidebar-section">
                <h3 className="sidebar-section-title">
                  {t("sidebarSectionStarred")}
                </h3>
                <ul className="sidebar-session-list">
                  {filteredStarredSessions
                    .slice(0, starredSessionsLimit)
                    .map((session) => (
                      <SessionListItem
                        key={session.id}
                        sessionId={session.id}
                        projectId={session.projectId}
                        title={getSessionDisplayTitle(session)}
                        fullTitle={getSessionDisplayTitle(session)}
                        provider={session.provider}
                        status={session.ownership}
                        pendingInputType={session.pendingInputType}
                        hasUnread={session.hasUnread}
                        isStarred={session.isStarred}
                        isArchived={session.isArchived}
                        mode="compact"
                        isCurrent={session.id === currentSessionId}
                        activity={session.activity}
                        onNavigate={onNavigate}
                        showProjectName
                        projectName={session.projectName}
                        basePath={basePath}
                        messageCount={session.messageCount}
                        hasDraft={drafts.has(session.id)}
                      />
                    ))}
                </ul>
                {filteredStarredSessions.length > starredSessionsLimit && (
                  <button
                    type="button"
                    className="sidebar-show-more"
                    onClick={() =>
                      setStarredSessionsLimit(
                        (prev) => prev + RECENT_SESSIONS_INCREMENT,
                      )
                    }
                  >
                    {t("actionShowMore", {
                      count: Math.min(
                        RECENT_SESSIONS_INCREMENT,
                        filteredStarredSessions.length - starredSessionsLimit,
                      ),
                    })}
                  </button>
                )}
              </div>
            )}

          {sessionListsEnabled &&
            !useCompactSessionLists &&
            recentDaySessions.length > 0 && (
              <div className="sidebar-section">
                <h3 className="sidebar-section-title">
                  {t("sidebarSectionLast24Hours")}
                </h3>
                <ul className="sidebar-session-list">
                  {recentDaySessions
                    .slice(0, recentSessionsLimit)
                    .map((session) => (
                      <SessionListItem
                        key={session.id}
                        sessionId={session.id}
                        projectId={session.projectId}
                        title={getSessionDisplayTitle(session)}
                        fullTitle={getSessionDisplayTitle(session)}
                        provider={session.provider}
                        status={session.ownership}
                        pendingInputType={session.pendingInputType}
                        hasUnread={session.hasUnread}
                        isStarred={session.isStarred}
                        isArchived={session.isArchived}
                        mode="compact"
                        isCurrent={session.id === currentSessionId}
                        activity={session.activity}
                        onNavigate={onNavigate}
                        showProjectName
                        projectName={session.projectName}
                        basePath={basePath}
                        messageCount={session.messageCount}
                        hasDraft={drafts.has(session.id)}
                      />
                    ))}
                </ul>
                {recentDaySessions.length > recentSessionsLimit && (
                  <button
                    type="button"
                    className="sidebar-show-more"
                    onClick={() =>
                      setRecentSessionsLimit(
                        (prev) => prev + RECENT_SESSIONS_INCREMENT,
                      )
                    }
                  >
                    {t("actionShowMore", {
                      count: Math.min(
                        RECENT_SESSIONS_INCREMENT,
                        recentDaySessions.length - recentSessionsLimit,
                      ),
                    })}
                  </button>
                )}
              </div>
            )}

          {sessionListsEnabled &&
            !useCompactSessionLists &&
            olderSessions.length > 0 && (
              <div className="sidebar-section">
                <h3 className="sidebar-section-title">
                  {t("sidebarSectionOlder")}
                </h3>
                <ul className="sidebar-session-list">
                  {olderSessions.slice(0, olderSessionsLimit).map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={getSessionDisplayTitle(session)}
                      provider={session.provider}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                    />
                  ))}
                </ul>
                {olderSessions.length > olderSessionsLimit && (
                  <button
                    type="button"
                    className="sidebar-show-more"
                    onClick={() =>
                      setOlderSessionsLimit(
                        (prev) => prev + RECENT_SESSIONS_INCREMENT,
                      )
                    }
                  >
                    {t("actionShowMore", {
                      count: Math.min(
                        RECENT_SESSIONS_INCREMENT,
                        olderSessions.length - olderSessionsLimit,
                      ),
                    })}
                  </button>
                )}
              </div>
            )}

          {sessionListsEnabled &&
            ((useCompactSessionLists && sidebarSessions.length === 0) ||
              (!useCompactSessionLists &&
                filteredStarredSessions.length === 0 &&
                recentDaySessions.length === 0 &&
                olderSessions.length === 0)) && (
              <p className="sidebar-empty">
                {sessionsLoading
                  ? t("sidebarLoadingSessions")
                  : t("sidebarNoSessions")}
              </p>
            )}
        </div>

        {/* Resize handle - desktop only, when expanded */}
        {isDesktop && !isCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("actionResizeSidebar")}
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}
