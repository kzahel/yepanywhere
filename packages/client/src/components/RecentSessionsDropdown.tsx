import { useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useGlobalSessionsFeed } from "../hooks/useGlobalSessionsFeed";
import { setElementTextTooltip } from "../hooks/useTooltipAppearance";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
  isBtwAsideSession,
  isBtwAsideSessionTitle,
} from "../lib/btwAsideSessions";
import { toBrowserAppHref } from "../lib/appHref";
import { sessionCollectionRecordsToGlobalSessionItems } from "../lib/sessionCollectionRecords";
import { useSessionCollectionQueryRecords } from "../lib/clientSummaryStore";
import { useI18n } from "../i18n";
import { ProviderBadge } from "./ProviderBadge";
import { SessionTitleDetails } from "./SessionTitleDetails";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { Badge } from "./ui/Badge";
import { Popover } from "./ui/Popover";
import styles from "./RecentSessionsDropdown.module.css";

const MAX_RECENT_SESSIONS = 10;

/**
 * Literal class names kept on `/btw` aside rows and badges purely so the two
 * global rules in `index.css` that SessionListItem shares still match. They
 * carry no styling of their own; everything else is module-owned.
 */
const BTW_ROW_INTEROP_CLASSES = "recent-session-item btw-aside-session";
const BTW_TITLE_INTEROP_CLASS = "recent-session-title";
const BTW_BADGE_INTEROP_CLASSES = "recent-sessions-badge btw";

function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

interface RecentSessionsDropdownProps {
  /** Current session is pinned above the other recent sessions. */
  currentSessionId: string;
  /** Complete title from the open session, even when absent from the feed. */
  currentSessionTitle: string;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Called when dropdown should close */
  onClose: () => void;
  /** Called when navigating to a session */
  onNavigate: (sessionId: string, projectId: string) => void;
  /** Anchors the popover; presses inside it (the triggers) do not dismiss. */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
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

/** Get display title */
function getDisplayTitle(session: GlobalSessionItem): string {
  return (
    session.customTitle || session.fullTitle || session.title || "Untitled"
  );
}

function getVisibleDisplayTitle(title: string): string {
  return isBtwAsideSessionTitle(title)
    ? getBtwAsideSessionDisplayTitle(title)
    : title;
}

function getTitleTooltip(session: GlobalSessionItem, title: string): string {
  return session.customTitle ? title : (session.fullTitle ?? title);
}

/** Compact status indicator */
function StatusIndicator({ session }: { session: GlobalSessionItem }) {
  const activity = session.activity as AgentActivity | undefined;

  if (activity === "in-turn") {
    return <ThinkingIndicator />;
  }

  if (session.pendingInputType) {
    const label = session.pendingInputType === "tool-approval" ? "Appr" : "Q";
    return (
      <Badge tone="warning" size="small">
        {label}
      </Badge>
    );
  }

  if (session.ownership.owner === "external") {
    return <Badge size="small">Ext</Badge>;
  }

  return null;
}

export function RecentSessionsDropdown({
  currentSessionId,
  currentSessionTitle,
  isOpen,
  onClose,
  onNavigate,
  triggerRef,
  basePath = "",
}: RecentSessionsDropdownProps) {
  const lastTouchPointerAtRef = useRef(0);
  const navigate = useNavigate();
  const { t } = useI18n();

  // Feed recent sessions across all projects; rows render from the collection.
  const feed = useGlobalSessionsFeed({
    limit: MAX_RECENT_SESSIONS + 5,
    includeStats: false,
  });
  const sessionRecords = useSessionCollectionQueryRecords(feed.query);
  const sessions = useMemo(
    () => sessionCollectionRecordsToGlobalSessionItems(sessionRecords),
    [sessionRecords],
  );

  // The current session has its own full-title section; avoid duplicating it.
  const recentSessions = sessions
    .filter((s) => s.id !== currentSessionId && !s.isArchived)
    .slice(0, MAX_RECENT_SESSIONS);

  return (
    <Popover
      open={isOpen}
      onClose={onClose}
      anchorRef={triggerRef}
      placement="bottom-start"
      role="dialog"
      aria-label={t("sessionRecentSessions")}
      className={styles.dropdown}
    >
      <div className={styles.current}>
        <SessionTitleDetails
          title={currentSessionTitle}
          label={t("sessionCurrentSession")}
          singleLine
          showCopy={false}
        />
      </div>
      <div className={styles.header}>{t("sessionRecentSessions")}</div>
      {recentSessions.length === 0 ? (
        <div className={styles.empty}>{t("sessionNoOtherSessions")}</div>
      ) : (
        <div>
          {recentSessions.map((session) => {
            const title = getDisplayTitle(session);
            const titleTooltip = getTitleTooltip(session, title);
            const isBtwAside = isBtwAsideSession({
              parentSessionId: session.parentSessionId,
              parentSessionKind: session.parentSessionKind,
              title,
              fullTitle: session.fullTitle,
            });
            const parentSessionId = session.parentSessionId;
            const parentHref =
              parentSessionId && isBtwAside
                ? buildBtwAsideParentHref(
                    basePath,
                    session.projectId,
                    parentSessionId,
                    session.id,
                  )
                : null;
            return (
              <Link
                key={session.id}
                to={`${basePath}/projects/${session.projectId}/sessions/${session.id}`}
                className={classNames(
                  styles.item,
                  session.hasUnread && styles.unread,
                  isBtwAside && BTW_ROW_INTEROP_CLASSES,
                )}
                onClick={() => {
                  onNavigate(session.id, session.projectId);
                  onClose();
                }}
                onPointerEnter={(event) => {
                  setElementTextTooltip(
                    event.currentTarget,
                    event.pointerType === "touch" ? null : titleTooltip,
                  );
                }}
                onPointerDown={(event) => {
                  if (event.pointerType === "touch") {
                    lastTouchPointerAtRef.current = Date.now();
                    setElementTextTooltip(event.currentTarget, null);
                  }
                }}
                onFocus={(event) => {
                  if (Date.now() - lastTouchPointerAtRef.current > 1000) {
                    setElementTextTooltip(event.currentTarget, titleTooltip);
                  }
                }}
                onBlur={(event) => {
                  setElementTextTooltip(event.currentTarget, null);
                }}
              >
                <div className={styles.content}>
                  <span
                    className={classNames(
                      styles.title,
                      isBtwAside && BTW_TITLE_INTEROP_CLASS,
                    )}
                  >
                    {session.isStarred && (
                      <svg
                        className={styles.star}
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
                    {isBtwAside && (
                      // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                      <span
                        className={`${styles.btwBadge} ${BTW_BADGE_INTEROP_CLASSES}`}
                        title={
                          parentHref
                            ? "Open parent session with this /btw aside visible"
                            : "/btw aside session"
                        }
                        role={parentHref ? "link" : undefined}
                        tabIndex={parentHref ? 0 : undefined}
                        onClick={(e) => {
                          if (!parentHref || !parentSessionId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.metaKey || e.ctrlKey || e.shiftKey) {
                            window.open(
                              toBrowserAppHref(parentHref),
                              "_blank",
                              "noopener",
                            );
                            return;
                          }
                          navigate(parentHref);
                          onNavigate(parentSessionId, session.projectId);
                          onClose();
                        }}
                        onKeyDown={(e) => {
                          if (
                            !parentHref ||
                            !parentSessionId ||
                            (e.key !== "Enter" && e.key !== " ")
                          ) {
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          navigate(parentHref);
                          onNavigate(parentSessionId, session.projectId);
                          onClose();
                        }}
                      >
                        /btw
                      </span>
                    )}
                    <span className={styles.titleText}>
                      {getVisibleDisplayTitle(title)}
                    </span>
                  </span>
                  <span className={styles.details}>
                    <ProviderBadge
                      provider={session.provider}
                      model={session.model}
                      className={styles.providerBadge}
                    />
                    <span className={styles.project}>
                      {session.projectName}
                    </span>
                    <span className={styles.time}>
                      {formatRelativeTime(session.updatedAt)}
                    </span>
                    <StatusIndicator session={session} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
