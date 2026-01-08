import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useNeedsAttentionBadge } from "../hooks/useNeedsAttentionBadge";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { type SessionSummary, toUrlProjectId } from "../types";
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

// Convert GlobalSessionItem to SessionSummary for SessionListItem
function toSessionSummary(session: GlobalSessionItem): SessionSummary {
  return {
    id: session.id,
    projectId: toUrlProjectId(session.projectId),
    title: session.title,
    fullTitle: session.customTitle || session.title,
    customTitle: session.customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    provider: session.provider,
    status: session.status,
    pendingInputType: session.pendingInputType,
    processState: session.processState,
    hasUnread: session.hasUnread,
    isArchived: session.isArchived,
    isStarred: session.isStarred,
  };
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
  // Fetch global sessions for sidebar (non-starred only for recent/older sections)
  const { sessions: globalSessions } = useGlobalSessions({ limit: 50 });

  // Fetch starred sessions separately to ensure we get ALL starred sessions
  const { sessions: starredSessions } = useGlobalSessions({
    starred: true,
    limit: 100,
  });

  // Global inbox count
  const inboxCount = useNeedsAttentionBadge();
  const { recentProjects } = useRecentProjects();

  const sidebarRef = useRef<HTMLElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef<boolean>(false);
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

  // Starred sessions come from dedicated fetch (filtered by server)
  // Filter out archived just in case
  const filteredStarredSessions = useMemo(() => {
    return starredSessions.filter((s) => !s.isArchived);
  }, [starredSessions]);

  // Sessions updated in the last 24 hours (non-starred, non-archived)
  const recentDaySessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isWithinLastDay = (date: Date) => date.getTime() >= oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred && !s.isArchived && isWithinLastDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

  // Older sessions (non-starred, non-archived, NOT in last 24 hours)
  const olderSessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isOlderThanOneDay = (date: Date) => date.getTime() < oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred &&
        !s.isArchived &&
        isOlderThanOneDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

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
          aria-label="Close sidebar"
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
              title="Expand sidebar"
              aria-label="Expand sidebar"
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
                aria-label="Close sidebar"
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
          {recentProjects[0] && (
            <SidebarNavItem
              to={`/new-session?projectId=${encodeURIComponent(recentProjects[0].id)}`}
              icon={SidebarIcons.newSession}
              label="New Session"
              onClick={onNavigate}
            />
          )}
        </div>

        <div className="sidebar-sessions">
          {/* Navigation items that scroll with content */}
          <SidebarNavSection>
            <SidebarNavItem
              to="/inbox"
              icon={SidebarIcons.inbox}
              label="Inbox"
              badge={inboxCount}
              onClick={onNavigate}
            />
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label="All Sessions"
              onClick={onNavigate}
            />
            <SidebarNavItem
              to="/recents"
              icon={SidebarIcons.recents}
              label="Recents"
              onClick={onNavigate}
            />
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label="Projects"
              onClick={onNavigate}
            />
            <AgentsNavItem onClick={onNavigate} />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label="Settings"
              onClick={onNavigate}
            />
          </SidebarNavSection>

          {/* Global sessions list */}
          {filteredStarredSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Starred</h3>
              <ul className="sidebar-session-list">
                {filteredStarredSessions
                  .slice(0, starredSessionsLimit)
                  .map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={toSessionSummary(session)}
                      projectId={session.projectId}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      processState={session.processState}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
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
                  Show{" "}
                  {Math.min(
                    RECENT_SESSIONS_INCREMENT,
                    filteredStarredSessions.length - starredSessionsLimit,
                  )}{" "}
                  more
                </button>
              )}
            </div>
          )}

          {recentDaySessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Last 24 Hours</h3>
              <ul className="sidebar-session-list">
                {recentDaySessions
                  .slice(0, recentSessionsLimit)
                  .map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={toSessionSummary(session)}
                      projectId={session.projectId}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      processState={session.processState}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
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
                  Show{" "}
                  {Math.min(
                    RECENT_SESSIONS_INCREMENT,
                    recentDaySessions.length - recentSessionsLimit,
                  )}{" "}
                  more
                </button>
              )}
            </div>
          )}

          {olderSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Older</h3>
              <ul className="sidebar-session-list">
                {olderSessions.slice(0, olderSessionsLimit).map((session) => (
                  <SessionListItem
                    key={session.id}
                    session={toSessionSummary(session)}
                    projectId={session.projectId}
                    mode="compact"
                    isCurrent={session.id === currentSessionId}
                    processState={session.processState}
                    onNavigate={onNavigate}
                    showProjectName
                    projectName={session.projectName}
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
                  Show{" "}
                  {Math.min(
                    RECENT_SESSIONS_INCREMENT,
                    olderSessions.length - olderSessionsLimit,
                  )}{" "}
                  more
                </button>
              )}
            </div>
          )}

          {filteredStarredSessions.length === 0 &&
            recentDaySessions.length === 0 &&
            olderSessions.length === 0 && (
              <p className="sidebar-empty">No sessions yet</p>
            )}
        </div>

        {/* Resize handle - desktop only, when expanded */}
        {isDesktop && !isCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}
