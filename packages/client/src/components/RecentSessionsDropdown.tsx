import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import type { ProcessStateType } from "../hooks/useFileActivity";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { ThinkingIndicator } from "./ThinkingIndicator";

const MAX_RECENT_SESSIONS = 10;

interface RecentSessionsDropdownProps {
  /** Current session ID (will be excluded from list) */
  currentSessionId: string;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Called when dropdown should close */
  onClose: () => void;
  /** Called when navigating to a session */
  onNavigate: (sessionId: string, projectId: string) => void;
  /** Trigger element ref for positioning */
  triggerRef: React.RefObject<HTMLElement | null>;
}

/** Format time as "Xm ago" style */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Get display title with truncation */
function getDisplayTitle(session: GlobalSessionItem): string {
  const title = session.customTitle || session.title || "Untitled";
  return title.length > 30 ? `${title.slice(0, 30)}...` : title;
}

/** Compact status indicator */
function StatusIndicator({ session }: { session: GlobalSessionItem }) {
  const processState = session.processState as ProcessStateType | undefined;

  // Running/thinking indicator
  if (processState === "running") {
    return <ThinkingIndicator />;
  }

  // Needs input
  if (session.pendingInputType) {
    const label = session.pendingInputType === "tool-approval" ? "Appr" : "Q";
    return <span className="recent-sessions-badge needs-input">{label}</span>;
  }

  // External session
  if (session.status.state === "external") {
    return <span className="recent-sessions-badge external">Ext</span>;
  }

  return null;
}

export function RecentSessionsDropdown({
  currentSessionId,
  isOpen,
  onClose,
  onNavigate,
  triggerRef,
}: RecentSessionsDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch recent sessions across all projects
  const { sessions } = useGlobalSessions({ limit: MAX_RECENT_SESSIONS + 5 });

  // Filter out current session and limit
  const recentSessions = sessions
    .filter((s) => s.id !== currentSessionId && !s.isArchived)
    .slice(0, MAX_RECENT_SESSIONS);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on scroll
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Position dropdown below trigger
  const triggerRect = triggerRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = triggerRect
    ? {
        position: "fixed",
        top: triggerRect.bottom + 4,
        left: Math.max(8, triggerRect.left - 100), // Offset left to align better
        maxWidth: "calc(100vw - 16px)",
      }
    : {};

  const dropdown = (
    <div ref={dropdownRef} className="recent-sessions-dropdown" style={style}>
      <div className="recent-sessions-header">Recent Sessions</div>
      {recentSessions.length === 0 ? (
        <div className="recent-sessions-empty">No other sessions</div>
      ) : (
        <div className="recent-sessions-list">
          {recentSessions.map((session) => (
            <Link
              key={session.id}
              to={`/projects/${session.projectId}/sessions/${session.id}`}
              className="recent-session-item"
              onClick={() => {
                onNavigate(session.id, session.projectId);
                onClose();
              }}
            >
              <div className="recent-session-content">
                <span className="recent-session-title">
                  {session.isStarred && (
                    <svg
                      className="recent-session-star"
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
                  {getDisplayTitle(session)}
                </span>
                <span className="recent-session-project">
                  {session.projectName}
                </span>
              </div>
              <div className="recent-session-meta">
                <StatusIndicator session={session} />
                <span className="recent-session-time">
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  // Use portal to escape any overflow clipping
  return createPortal(dropdown, document.body);
}
