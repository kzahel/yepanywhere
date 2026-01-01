import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProcessStateType } from "../hooks/useFileActivity";
import { type SessionSummary, getSessionDisplayTitle } from "../types";

const SWIPE_THRESHOLD = 50; // Minimum distance to trigger close

// Time threshold for stable sorting: sessions within this window use ID as tiebreaker
// This prevents rapid shuffling when multiple active sessions update frequently
const STABLE_SORT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Stable sort: primarily by updatedAt, but use session ID as tiebreaker
// when sessions are within the threshold. This prevents rapid shuffling
// when multiple active sessions update frequently.
function stableSort(a: SessionSummary, b: SessionSummary): number {
  const aTime = new Date(a.updatedAt).getTime();
  const bTime = new Date(b.updatedAt).getTime();
  const timeDiff = bTime - aTime;

  // If time difference is significant, sort by time
  if (Math.abs(timeDiff) > STABLE_SORT_THRESHOLD_MS) {
    return timeDiff;
  }

  // Within threshold: use session ID for stable ordering
  return a.id.localeCompare(b.id);
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  currentSessionId?: string;
  sessions: SessionSummary[];
  processStates: Record<string, ProcessStateType>;
  onNavigate: () => void;
  /** Desktop mode: sidebar is always visible, no overlay */
  isDesktop?: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isCollapsed?: boolean;
  /** Desktop mode: callback to toggle expanded/collapsed state */
  onToggleExpanded?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  projectId,
  currentSessionId,
  sessions,
  processStates,
  onNavigate,
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
}: SidebarProps) {
  const navigate = useNavigate();
  const sidebarRef = useRef<HTMLElement>(null);
  const touchStartX = useRef<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const currentX = e.touches[0]?.clientX;
    if (currentX === undefined) return;
    const diff = currentX - touchStartX.current;
    // Only allow swiping left (negative offset)
    if (diff < 0) {
      setSwipeOffset(diff);
    }
  };

  const handleTouchEnd = () => {
    if (swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    setSwipeOffset(0);
  };

  // Starred sessions (sorted with stable sort, limit 10)
  const starredSessions = useMemo(() => {
    return sessions
      .filter((s) => s.isStarred && !s.isArchived)
      .sort(stableSort)
      .slice(0, 10);
  }, [sessions]);

  // Sessions updated in the last 24 hours (non-starred, non-archived)
  const recentDaySessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isWithinLastDay = (date: Date) => date.getTime() >= oneDayAgo;

    return sessions
      .filter(
        (s) =>
          !s.isStarred &&
          !s.isArchived &&
          isWithinLastDay(new Date(s.updatedAt)),
      )
      .sort(stableSort)
      .slice(0, 10);
  }, [sessions]);

  // Older sessions (non-starred, non-archived, NOT in last 24 hours, limit 10)
  const olderSessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isOlderThanOneDay = (date: Date) => date.getTime() < oneDayAgo;

    return sessions
      .filter(
        (s) =>
          !s.isStarred &&
          !s.isArchived &&
          isOlderThanOneDay(new Date(s.updatedAt)),
      )
      .sort(stableSort)
      .slice(0, 10);
  }, [sessions]);

  const handleNavClick = (path: string) => {
    onNavigate();
    navigate(path);
  };

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
          {isDesktop ? (
            /* Desktop mode: toggle button */
            <button
              type="button"
              className="sidebar-toggle"
              onClick={onToggleExpanded}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <SidebarToggleIcon />
            </button>
          ) : (
            /* Mobile mode: brand text */
            <span className="sidebar-brand">Claude Anywhere</span>
          )}
          {!isDesktop && (
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
          )}
          {isDesktop && !isCollapsed && (
            <span className="sidebar-brand">Claude Anywhere</span>
          )}
        </div>

        <div className="sidebar-actions">
          <Link
            to={`/projects/${projectId}/new-session`}
            className="sidebar-new-session-button"
            onClick={onNavigate}
            title="New Session"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="sidebar-nav-text">New Session</span>
          </Link>

          <button
            type="button"
            className="sidebar-nav-button"
            onClick={() => handleNavClick("/projects")}
            title="Projects"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="sidebar-nav-text">Projects</span>
          </button>

          <button
            type="button"
            className="sidebar-nav-button"
            onClick={() => handleNavClick(`/projects/${projectId}`)}
            title="All Sessions"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span className="sidebar-nav-text">All Sessions</span>
          </button>

          <button
            type="button"
            className="sidebar-nav-button"
            onClick={() => handleNavClick("/settings")}
            title="Settings"
          >
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
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="sidebar-nav-text">Settings</span>
          </button>
        </div>

        <div className="sidebar-sessions">
          {starredSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Starred</h3>
              <ul className="sidebar-session-list">
                {starredSessions.map((session) => (
                  <SidebarSessionItem
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    isCurrent={session.id === currentSessionId}
                    processState={processStates[session.id]}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          )}

          {recentDaySessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Last 24 Hours</h3>
              <ul className="sidebar-session-list">
                {recentDaySessions.map((session) => (
                  <SidebarSessionItem
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    isCurrent={session.id === currentSessionId}
                    processState={processStates[session.id]}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          )}

          {olderSessions.length > 0 && (
            <div className="sidebar-section">
              <h3 className="sidebar-section-title">Older</h3>
              <ul className="sidebar-session-list">
                {olderSessions.map((session) => (
                  <SidebarSessionItem
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    isCurrent={session.id === currentSessionId}
                    processState={processStates[session.id]}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          )}

          {starredSessions.length === 0 &&
            recentDaySessions.length === 0 &&
            olderSessions.length === 0 && (
              <p className="sidebar-empty">No sessions yet</p>
            )}
        </div>
      </aside>
    </>
  );
}

interface SidebarSessionItemProps {
  session: SessionSummary;
  projectId: string;
  isCurrent: boolean;
  processState?: ProcessStateType;
  onNavigate: () => void;
}

function SidebarSessionItem({
  session,
  projectId,
  isCurrent,
  processState,
  onNavigate,
}: SidebarSessionItemProps) {
  // Determine activity indicator
  const getActivityIndicator = () => {
    // External sessions always show external badge
    if (session.status.state === "external") {
      return <span className="sidebar-badge sidebar-badge-external">Ext</span>;
    }

    // Priority 1: Needs input
    if (session.pendingInputType) {
      const label = session.pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="sidebar-badge sidebar-badge-needs-input">{label}</span>
      );
    }

    // Priority 2: Running (thinking)
    const effectiveProcessState = processState ?? session.processState;
    if (effectiveProcessState === "running") {
      return (
        <span className="sidebar-badge sidebar-badge-running">
          <span className="sidebar-thinking-dot" />
        </span>
      );
    }

    // Unread - handled via CSS class on <li>, not a badge
    // Active (owned) sessions don't need a dot - "Thinking" badge shows when running
    return null;
  };

  const liClassName = [isCurrent && "current", session.hasUnread && "unread"]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={liClassName || undefined}>
      <Link
        to={`/projects/${projectId}/sessions/${session.id}`}
        onClick={onNavigate}
        title={session.fullTitle || getSessionDisplayTitle(session)}
      >
        <span className="sidebar-session-title">
          {session.isStarred && (
            <svg
              className="sidebar-star"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          )}
          {getSessionDisplayTitle(session)}
        </span>
        {getActivityIndicator()}
      </Link>
    </li>
  );
}
