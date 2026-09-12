import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { SessionAsyncQuestionsButton } from "./SessionAsyncQuestionsButton";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useHoverCardSettings } from "../hooks/useHoverCardAppearance";
import { useSessionHoverCardController } from "../hooks/useSessionHoverCardController";
import {
  useTooltipMode,
  useVisibilityAwareTextTooltip,
} from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import { toBrowserAppHref } from "../lib/appHref";
import { formatBriefAge, formatSessionHoverAge } from "../lib/sessionAge";
import {
  providerChildActivityLevels,
  providerChildSessionHref,
  providerChildTitle,
} from "../lib/providerChildSessions";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
  isBtwAsideSession,
} from "../lib/btwAsideSessions";
import type {
  ContextUsage,
  PendingInputType,
  ProviderName,
  ProviderChildSessionSummary,
  SessionStatus,
} from "../types";
import { ProviderChildNavTarget } from "./ProviderChildNavTarget";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ProviderBadge } from "./ProviderBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { PublicShareManagerModal } from "./PublicShareManagerModal";
import { SessionMenu } from "./SessionMenu";
import { LegacySessionShareModal } from "./SessionShareModal";
import { SessionStatusBadge } from "./StatusBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";
import styles from "./SessionListItem.module.css";

export interface SessionNavigationIntent {
  event: React.MouseEvent<HTMLAnchorElement>;
  href: string;
  projectId: string;
  sessionId: string;
}

interface SessionListItemProps {
  // Core (required)
  sessionId: string;
  projectId: string;
  title: string | null;

  // Optional display data
  fullTitle?: string | null;
  initialPrompt?: string | null;
  /** True when title is a user-provided override rather than the first turn. */
  hasCustomTitle?: boolean;
  /** Capped excerpt of the most recent regular agent turn, for the hover card. */
  lastAgentText?: string | null;
  projectName?: string;
  updatedAt?: string;
  hasUnread?: boolean;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  contextUsage?: ContextUsage;
  status?: SessionStatus;
  provider?: ProviderName;
  /** Last active model, shown as a provider+model badge (card mode / hover). */
  model?: string;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Parent session when this item is a YA-owned /btw aside. */
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  /** Provider-native child work attached to this canonical YA session. */
  providerChildren?: ProviderChildSessionSummary[];

  // Feature toggles
  mode: "card" | "compact";
  showProjectName?: boolean;
  showTimestamp?: boolean;
  /** Hide session management when the enclosing surface owns its actions. */
  showMenu?: boolean;
  showContextUsage?: boolean;
  showStatusBadge?: boolean;
  showActivityIndicator?: boolean;

  // Custom badge (for Inbox)
  customBadge?: { label: string; className: string } | null;

  // Actions (menu hidden when all undefined)
  isStarred?: boolean;
  isArchived?: boolean;
  onToggleStar?: () => void;
  onToggleArchive?: () => void;
  onToggleRead?: () => void;
  onRename?: () => void;
  // Selection (for All Sessions page)
  isCurrent?: boolean;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  onSelect?: (sessionId: string, selected: boolean) => void;
  onNavigate?: () => void;
  onSessionNavigate?: (intent: SessionNavigationIntent) => void;

  // For sidebar compact mode
  hasDraft?: boolean;
  hasProjectQueue?: boolean;

  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;

  /** Number of messages in session (0 indicates brand new session) */
  messageCount?: number;

  /** Creation time for age display in detailed lists (brief d/h/m) */
  createdAt?: string;

  /** Cached user vs system/assistant turn counts (for heavier list views) */
  userTurnCount?: number;
  systemTurnCount?: number;
  /** Whether legacy public-share creation is currently ready. */
  publicShareCreationReady?: boolean;
  /** Whether the permanent public-share management capability is available. */
  publicShareManagementAvailable?: boolean;
  /** @deprecated Use publicShareCreationReady. */
  publicShareControlsVisible?: boolean;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

/**
 * Shared session list item component used by Sidebar (compact), SessionsPage (card),
 * RecentsPage, and InboxContent.
 *
 * Features:
 * - Star indicator, title, draft badge
 * - SessionMenu (star, archive, rename actions) - hidden when no action handlers
 * - Inline rename editing with optimistic updates
 * - Card mode: context usage indicator, full status badge, time display
 * - Compact mode: abbreviated badges (Appr/Q/Running)
 * - Optional checkbox for selection mode
 * - Custom badge support (for Inbox)
 */
export function SessionListItem({
  // Core
  sessionId,
  projectId,
  title,
  // Optional display data
  fullTitle,
  initialPrompt,
  hasCustomTitle = false,
  lastAgentText,
  projectName,
  updatedAt,
  hasUnread: hasUnreadProp,
  activity,
  pendingInputType,
  contextUsage,
  status,
  provider,
  model,
  executor,
  parentSessionId,
  parentSessionKind,
  providerChildren = [],
  // Feature toggles
  mode,
  showProjectName = false,
  showTimestamp = true,
  showMenu = true,
  showContextUsage = true,
  showStatusBadge = true,
  showActivityIndicator = false,
  // Custom badge
  customBadge,
  // Actions
  isStarred: isStarredProp,
  isArchived: isArchivedProp,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  // Selection
  isCurrent = false,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onNavigate,
  onSessionNavigate,
  // Sidebar
  hasDraft = false,
  hasProjectQueue = false,
  // Relay mode
  basePath = "",
  // New session detection
  messageCount,
  createdAt,
  userTurnCount,
  systemTurnCount,
  publicShareCreationReady,
  publicShareManagementAvailable = false,
  publicShareControlsVisible = false,
}: SessionListItemProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  // Local state for optimistic updates (only used when action handlers are provided)
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [providerChildrenExpanded, setProviderChildrenExpanded] =
    useState(false);
  const providerChildrenOutlineId = useId();
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState<string | undefined>(undefined);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // Hover card for every list surface (sidebar compact + all-sessions / search
  // cards): a rich hover panel (full first user turn, status line, and the most
  // recent agent turn). The panel (SessionHoverCard) self-positions from this
  // row geometry, preferring open space beyond the row before it falls back to
  // a cursor-relative viewport clamp.
  const {
    showDelayMs: hoverCardShowDelayMs,
    warmShowDelayMs: hoverCardWarmShowDelayMs,
    maxHeightPx: hoverCardMaxHeightPx,
  } = useHoverCardSettings();
  const tooltipMode = useTooltipMode();
  const liRef = useRef<HTMLLIElement>(null);
  // True while this row's ... menu is open; suppresses new card shows.
  const menuOpenRef = useRef(false);

  // Computed values with optimistic fallback
  const isStarred = localIsStarred ?? isStarredProp;
  const isArchived = localIsArchived ?? isArchivedProp;
  // Detect brand new sessions that haven't received a title yet
  // Use messageCount === 0, or if messageCount is unknown but session is actively running
  const isNewSession =
    !localTitle &&
    !title &&
    (messageCount === 0 || (messageCount == null && activity === "in-turn"));
  const showCardThinkingIndicator =
    isNewSession || (showActivityIndicator && activity === "in-turn");
  const displayTitle =
    localTitle ?? title ?? (isNewSession ? "New session" : "Untitled session");
  const hasEffectiveCustomTitle = !!localTitle || hasCustomTitle;
  const isBtwAside = isBtwAsideSession({
    parentSessionId,
    parentSessionKind,
    title: displayTitle,
    fullTitle,
  });
  const visibleTitle = isBtwAside
    ? getBtwAsideSessionDisplayTitle(displayTitle)
    : displayTitle;
  const copyPromptText = (initialPrompt ?? fullTitle ?? "").trim();
  const publicShareCreationAvailable =
    publicShareCreationReady ?? publicShareControlsVisible;
  const publicShareMenuVisible =
    publicShareManagementAvailable || publicShareCreationAvailable;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [isEditing]);

  const hasUnread = hasUnreadProp;

  // Handlers for menu actions
  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    setLocalIsStarred(newStarred);
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      activityBus.emitLocal("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId,
        starred: newStarred,
        timestamp: new Date().toISOString(),
      });
      onToggleStar?.();
    } catch (err) {
      console.error("Failed to update star status:", err);
      setLocalIsStarred(undefined); // Revert on error
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    setLocalIsArchived(newArchived);
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      activityBus.emitLocal("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId,
        archived: newArchived,
        timestamp: new Date().toISOString(),
      });
      onToggleArchive?.();
    } catch (err) {
      console.error("Failed to update archive status:", err);
      setLocalIsArchived(undefined); // Revert on error
    }
  };

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      onToggleRead?.();
    } catch (err) {
      console.error("Failed to update read status:", err);
    }
  };

  const handleCopyPrompt = useCallback(() => {
    if (!copyPromptText) return;
    void copyTextToClipboard(copyPromptText).catch((err) => {
      console.error("Failed to copy initial prompt:", err);
    });
  }, [copyPromptText]);

  const handleCancelEditing = () => {
    if (isSavingRef.current) return;
    setIsEditing(false);
    setRenameValue("");
  };

  const handleSaveRename = async () => {
    const trimmedTitle = renameValue.trim();
    if (!trimmedTitle || isSaving) return;
    if (trimmedTitle === displayTitle) {
      handleCancelEditing();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await api.updateSessionMetadata(sessionId, {
        title: trimmedTitle,
      });
      setLocalTitle(trimmedTitle);
      activityBus.emitLocal("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId,
        title: trimmedTitle,
        timestamp: new Date().toISOString(),
      });
      setIsEditing(false);
      onRename?.();
    } catch (err) {
      console.error("Failed to rename session:", err);
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
  };

  const handleRenameBlur = () => {
    if (isSavingRef.current) return;
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    handleSaveRename();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditing();
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelect?.(sessionId, e.target.checked);
  };

  // Activity indicator for compact mode
  const getCompactActivityIndicator = () => {
    // External sessions always show external badge
    if (status?.owner === "external") {
      return <span className="session-badge session-badge-external">Ext</span>;
    }

    // Priority 1: Needs input
    if (pendingInputType) {
      const label = pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="session-badge session-badge-needs-input">{label}</span>
      );
    }

    // Priority 2: In-turn (thinking)
    if (activity === "in-turn") {
      return <ThinkingIndicator />;
    }

    return null;
  };

  // Project name and status letter close a compact row. They sit outside the
  // title area so the hover ... overlay covers only title text, and they stay
  // their own navigation target rather than disappearing under that overlay.
  const compactActivityIndicator =
    mode === "compact" ? getCompactActivityIndicator() : null;
  const compactTrailing =
    mode === "compact" &&
    ((showProjectName && projectName) || compactActivityIndicator) ? (
      <>
        {showProjectName && projectName && (
          <span className="session-list-item__project-compact">
            {projectName}
          </span>
        )}
        {compactActivityIndicator}
      </>
    ) : null;

  // Format relative time for card mode
  const formatRelativeTime = (timestamp: string): string => {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  // Brief age since creation for detailed (card) lists and the compact hover
  // card. `formatBriefAge` returns null for unknown/default (epoch) timestamps,
  // so a missing creation time renders nothing rather than "Created 20625d ago".
  const briefAge = formatBriefAge(createdAt);

  // Hover tooltip age shows both: time since last activity (primary) with the
  // creation time as an "established" aside — "5m ago (est. 2d)". Either half
  // drops out when its timestamp is unknown/default.
  const hoverAgeLabel = formatSessionHoverAge(updatedAt, createdAt);

  // Themed mode may enrich every provider-backed list row with a rich preview.
  // Native mode stays browser-owned and falls back to the title only when the
  // rendered row actually clips it.
  const showHoverCard = !!provider && tooltipMode === "themed";

  // The full first user turn (body) and the most recent agent turn (reply)
  // shown in the replacement tooltip.
  const titleTooltip = hasEffectiveCustomTitle
    ? displayTitle
    : fullTitle || displayTitle;
  const hoverPrompt = (
    hasEffectiveCustomTitle
      ? displayTitle
      : initialPrompt || fullTitle || displayTitle || ""
  ).trim();
  const hoverLastAgent = lastAgentText?.trim() || undefined;
  const knownOmittedTitle =
    !showHoverCard &&
    !hasEffectiveCustomTitle &&
    fullTitle &&
    fullTitle !== displayTitle
      ? titleTooltip
      : null;
  const titleTooltipAttributes = useVisibilityAwareTextTooltip<HTMLElement>(
    showHoverCard ? null : titleTooltip,
    knownOmittedTitle,
  );

  const {
    anchor: previewPos,
    hoverCardId,
    clear: clearPreview,
    onPointerEnter: enterPreview,
    onPointerMove: movePreview,
    onPointerLeave: leavePreview,
  } = useSessionHoverCardController({
    targetRef: liRef,
    showDelayMs: hoverCardShowDelayMs,
    warmShowDelayMs: hoverCardWarmShowDelayMs,
    enabled: showHoverCard,
    refreshPreview: {
      projectId,
      sessionId,
      lastAgentText: hoverLastAgent,
      owner: status?.owner,
    },
  });

  const handlePreviewEnter = useCallback(
    (e: React.PointerEvent<HTMLLIElement>) => {
      if (menuOpenRef.current) return;
      enterPreview(e);
    },
    [enterPreview],
  );

  // A fixed card would drift if the sidebar scrolls under it; clear only when
  // the row's own scroll ancestors move. Transcript autoscroll elsewhere should
  // not dismiss a sidebar preview.
  useEffect(() => {
    if (!previewPos) return;
    const handleScroll = (event: Event) => {
      const row = liRef.current;
      const target = event.target;
      if (!row || target === window || !(target instanceof Node)) {
        clearPreview();
        return;
      }
      if (target.contains(row)) {
        clearPreview();
      }
    };
    const handleResize = () => clearPreview();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [previewPos, clearPreview]);

  // The ... menu opening dismisses the card and, while open, suppresses new
  // shows so cursor moves over the row/menu do not pop cards. Hovering the
  // trigger itself no longer cancels — the card sits under the menu anyway.
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpenRef.current = open;
      if (open) clearPreview();
    },
    [clearPreview],
  );

  // Build CSS classes
  const liClasses = [
    "session-list-item",
    mode === "card" ? "session-list-item--card" : "session-list-item--compact",
    isCurrent && "current",
    hasUnread && "unread",
    isBtwAside && "btw-aside-session",
    isSelected && "selected",
    isArchived && "archived",
    mode === "compact" && styles.compactRow,
    mode === "compact" &&
      providerChildren.length > 0 &&
      styles.compactWithProviderChildren,
  ]
    .filter(Boolean)
    .join(" ");

  const sessionHref = `${basePath}/projects/${projectId}/sessions/${sessionId}`;
  const parentHref =
    parentSessionId && isBtwAside
      ? buildBtwAsideParentHref(basePath, projectId, parentSessionId, sessionId)
      : null;
  const providerChildrenLabel = t(
    providerChildren.length === 1
      ? "providerChildrenCountOne"
      : "providerChildrenCountMany",
    { count: providerChildren.length },
  );
  const providerChildrenTooltip = [
    providerChildrenLabel,
    ...providerChildren.map(
      (child) => child.title || child.agentType || t("providerChildFallback"),
    ),
  ].join("\n");
  const providerChildrenDisclosureLabel = t(
    providerChildrenExpanded
      ? "providerChildrenCollapse"
      : "providerChildrenExpand",
    { title: visibleTitle },
  );
  // Children arrive newest-transcript-activity first; the rail marks which of
  // them actually ran last so the order is readable without a timestamp column.
  const providerChildActivity = useMemo(
    () => providerChildActivityLevels(providerChildren),
    [providerChildren],
  );

  const handleBtwBadgeClick = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      if (!parentHref) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        window.open(toBrowserAppHref(parentHref), "_blank", "noopener");
        return;
      }
      navigate(parentHref);
      onNavigate?.();
    },
    [navigate, onNavigate, parentHref],
  );

  const handleBtwBadgeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLSpanElement>) => {
      if (!parentHref || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(parentHref);
      onNavigate?.();
    },
    [navigate, onNavigate, parentHref],
  );

  const handleSessionClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (isSelectionMode) {
        e.preventDefault();
        onNavigate?.();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.open(toBrowserAppHref(sessionHref), "_blank", "noopener");
        return;
      }

      if (e.altKey) {
        return;
      }

      onSessionNavigate?.({
        event: e,
        href: sessionHref,
        projectId,
        sessionId,
      });
      onNavigate?.();
    },
    [
      isSelectionMode,
      onNavigate,
      onSessionNavigate,
      projectId,
      sessionHref,
      sessionId,
    ],
  );

  const handleSessionMouseDown = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    },
    [],
  );

  const handleSessionAuxClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(toBrowserAppHref(sessionHref), "_blank", "noopener");
    },
    [sessionHref],
  );

  const handleOpenNewTab = useCallback(() => {
    window.open(toBrowserAppHref(sessionHref), "_blank", "noopener");
  }, [sessionHref]);

  // Star icon SVG
  const StarIcon = ({
    filled,
    size = 10,
  }: {
    filled: boolean;
    size?: number;
  }) => (
    <svg
      className="session-star-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );

  return (
    <li
      ref={liRef}
      className={liClasses}
      onPointerEnter={showHoverCard ? handlePreviewEnter : undefined}
      onPointerMove={showHoverCard ? movePreview : undefined}
      onPointerLeave={showHoverCard ? leavePreview : undefined}
      onWheel={showHoverCard ? clearPreview : undefined}
    >
      {/* Checkbox for multi-select (only shown when onSelect is provided) */}
      {onSelect && (
        <input
          type="checkbox"
          className="session-list-item__checkbox"
          checked={isSelected}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${displayTitle}`}
        />
      )}

      {mode === "compact" && providerChildren.length > 0 && (
        <button
          type="button"
          className={styles.providerChildrenDisclosure}
          aria-label={providerChildrenDisclosureLabel}
          aria-expanded={providerChildrenExpanded}
          aria-controls={providerChildrenOutlineId}
          onPointerEnter={(event) => {
            event.stopPropagation();
            clearPreview();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            clearPreview();
            setProviderChildrenExpanded((expanded) => !expanded);
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m4 2 4 4-4 4" />
          </svg>
        </button>
      )}

      <div className={styles.body}>
        {isEditing ? (
          <input
            ref={renameInputRef}
            type="text"
            className="session-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameBlur}
            onKeyDown={handleRenameKeyDown}
            disabled={isSaving}
          />
        ) : (
          <Link
            to={sessionHref}
            onClick={handleSessionClick}
            onMouseDown={handleSessionMouseDown}
            onAuxClick={handleSessionAuxClick}
            className={`session-list-item__link ${
              mode === "compact" ? styles.compactLink : ""
            }`}
          >
            {mode === "card" ? (
              // Card mode: title on one line, meta on second line
              <>
                <strong
                  className="session-list-item__title"
                  {...titleTooltipAttributes}
                >
                  {isStarred && <StarIcon filled size={12} />}
                  {showCardThinkingIndicator && <ThinkingIndicator />}
                  {isBtwAside && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                    <span
                      className="session-badge session-badge-btw"
                      title={
                        parentHref
                          ? "Open parent session with this /btw aside visible"
                          : "/btw aside session"
                      }
                      role={parentHref ? "link" : undefined}
                      tabIndex={parentHref ? 0 : undefined}
                      onClick={handleBtwBadgeClick}
                      onKeyDown={handleBtwBadgeKeyDown}
                    >
                      /btw
                    </span>
                  )}
                  <span>{visibleTitle}</span>
                  {hasDraft && (
                    <span className="session-draft-badge">Draft</span>
                  )}
                  {hasProjectQueue && (
                    <span
                      className="session-project-queue-badge"
                      title={t("projectQueueSidebarBadge")}
                    >
                      Q
                    </span>
                  )}
                  {isArchived && (
                    <span className="session-archived-badge">Archived</span>
                  )}
                </strong>
                <span className="session-list-item__meta">
                  {provider && (
                    <ProviderBadge
                      provider={provider}
                      model={model}
                      className="session-list-item__provider-badge"
                    />
                  )}
                  {showProjectName && projectName && (
                    <span className="session-list-item__project">
                      {projectName}
                    </span>
                  )}
                  {showTimestamp && updatedAt && formatRelativeTime(updatedAt)}
                  {briefAge && (
                    <span
                      className="session-list-item__age"
                      title={t("sessionListAgeTitle")}
                    >
                      Created {briefAge} ago
                    </span>
                  )}
                  {(userTurnCount != null || systemTurnCount != null) && (
                    <span
                      className="session-list-item__turns"
                      title="User / system (assistant) turns (cached)"
                    >
                      U:{userTurnCount ?? 0} S:{systemTurnCount ?? 0}
                    </span>
                  )}
                  {executor && (
                    <span
                      className="session-badge session-badge-executor"
                      title={`Running on ${executor}`}
                    >
                      {executor}
                    </span>
                  )}
                  {showContextUsage && (
                    <ContextUsageIndicator usage={contextUsage} size={14} />
                  )}
                  {customBadge && (
                    <span
                      className={`inbox-item-badge ${customBadge.className}`}
                    >
                      {customBadge.label}
                    </span>
                  )}
                  {showStatusBadge && status && (
                    <SessionStatusBadge
                      status={status}
                      pendingInputType={pendingInputType}
                      hasUnread={hasUnread}
                      activity={activity}
                    />
                  )}
                </span>
                {providerChildren.length > 0 && (
                  <span
                    className="session-list-item__provider-children"
                    role="list"
                    aria-label={providerChildrenLabel}
                  >
                    {providerChildren.map((child) => (
                      <span key={child.id} role="listitem">
                        <ProviderChildNavTarget
                          className={`session-list-item__provider-child ${styles.providerChildLink}`}
                          href={providerChildSessionHref(
                            basePath,
                            projectId,
                            sessionId,
                            child.id,
                          )}
                        >
                          <span aria-hidden>↳</span>
                          <span className="session-list-item__provider-child-title">
                            {providerChildTitle(
                              child,
                              t("providerChildFallback"),
                            )}
                          </span>
                          {child.agentType &&
                            child.agentType !==
                              providerChildTitle(
                                child,
                                t("providerChildFallback"),
                              ) && (
                              <span className="session-list-item__provider-child-type">
                                {child.agentType}
                              </span>
                            )}
                        </ProviderChildNavTarget>
                      </span>
                    ))}
                  </span>
                )}
              </>
            ) : (
              // Compact mode: single line with badges
              <>
                <span className="session-list-item__title-row">
                  {isStarred && <StarIcon filled />}
                  <span
                    className="session-list-item__title-text"
                    {...titleTooltipAttributes}
                  >
                    {isNewSession && <ThinkingIndicator />}
                    {isBtwAside && (
                      // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                      <span
                        className="session-badge session-badge-btw"
                        title={
                          parentHref
                            ? "Open parent session with this /btw aside visible"
                            : "/btw aside session"
                        }
                        role={parentHref ? "link" : undefined}
                        tabIndex={parentHref ? 0 : undefined}
                        onClick={handleBtwBadgeClick}
                        onKeyDown={handleBtwBadgeKeyDown}
                      >
                        /btw
                      </span>
                    )}
                    <span>{visibleTitle}</span>
                  </span>
                  {hasDraft && (
                    <span className="session-draft-badge">Draft</span>
                  )}
                  {hasProjectQueue && (
                    <span
                      className="session-project-queue-badge"
                      title={t("projectQueueSidebarBadge")}
                    >
                      Q
                    </span>
                  )}
                  {providerChildren.length > 0 && (
                    <span
                      className={`${styles.providerChildrenBadge} ${
                        hasUnread ? styles.providerChildrenBadgeUnread : ""
                      }`}
                      role="img"
                      title={providerChildrenTooltip}
                      aria-label={providerChildrenLabel}
                    >
                      {providerChildren.length}
                    </span>
                  )}
                </span>
              </>
            )}
          </Link>
        )}

        {/* Only show menu when provider is available (required for clone) */}
        {provider && showMenu && (
          <SessionMenu
            sessionId={sessionId}
            projectId={projectId}
            isStarred={isStarred ?? false}
            isArchived={isArchived ?? false}
            hasUnread={hasUnread ?? false}
            provider={provider}
            onToggleStar={handleToggleStar}
            onToggleArchive={handleToggleArchive}
            onToggleRead={handleToggleRead}
            onRename={() => {
              setRenameValue(displayTitle);
              setIsEditing(true);
            }}
            onCopyPrompt={copyPromptText ? handleCopyPrompt : undefined}
            onOpenNewTab={handleOpenNewTab}
            onShare={
              publicShareMenuVisible ? () => setShowShareModal(true) : undefined
            }
            useEllipsisIcon
            overlayTrigger
            useFixedPositioning
            onOpenChange={handleMenuOpenChange}
            className="session-list-item__menu"
          />
        )}
      </div>
      {compactTrailing && (
        <Link
          to={sessionHref}
          tabIndex={-1}
          className={styles.compactTrailing}
          onClick={handleSessionClick}
          onMouseDown={handleSessionMouseDown}
          onAuxClick={handleSessionAuxClick}
        >
          {compactTrailing}
        </Link>
      )}
      <span className={styles.questions}>
        <SessionAsyncQuestionsButton
          sessionId={sessionId}
          basePath={basePath}
          onNavigate={onNavigate}
        />
      </span>

      {mode === "compact" &&
        providerChildren.length > 0 &&
        providerChildrenExpanded && (
          <ul
            id={providerChildrenOutlineId}
            className={styles.providerChildrenOutline}
            aria-label={providerChildrenLabel}
            onPointerEnter={(event) => {
              event.stopPropagation();
              clearPreview();
            }}
          >
            {providerChildren.map((child) => {
              const childTitle = providerChildTitle(
                child,
                t("providerChildFallback"),
              );
              const activityLevel =
                providerChildActivity.get(child.id) ?? "older";
              const activityAge = formatBriefAge(child.updatedAt);
              return (
                <li
                  key={child.id}
                  className={styles.providerChildrenOutlineItem}
                >
                  <Link
                    to={providerChildSessionHref(
                      basePath,
                      projectId,
                      sessionId,
                      child.id,
                    )}
                    className={styles.providerChildrenOutlineLink}
                    title={
                      activityAge
                        ? `${childTitle} — ${t("providerChildActivityAge", {
                            age: activityAge,
                          })}`
                        : childTitle
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        onNavigate?.();
                      }
                    }}
                    onAuxClick={(event) => event.stopPropagation()}
                  >
                    <span
                      className={`${styles.providerChildrenActivity} ${
                        activityLevel === "latest"
                          ? styles.providerChildrenActivityLatest
                          : activityLevel === "recent"
                            ? styles.providerChildrenActivityRecent
                            : ""
                      }`}
                      data-activity={activityLevel}
                      aria-hidden
                    />
                    <span className={styles.providerChildrenOutlineTitle}>
                      {childTitle}
                    </span>
                    {child.agentType && child.agentType !== childTitle && (
                      <span className={styles.providerChildrenOutlineType}>
                        {child.agentType}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

      {showShareModal &&
        (publicShareManagementAvailable ? (
          <PublicShareManagerModal
            creationIdentity={{
              projectId,
              sessionId,
              title: displayTitle,
              initialPrompt,
            }}
            creationReady={publicShareCreationAvailable}
            onClose={() => setShowShareModal(false)}
          />
        ) : (
          <LegacySessionShareModal
            projectId={projectId}
            sessionId={sessionId}
            title={displayTitle}
            initialPrompt={initialPrompt}
            canCreateShares={publicShareCreationAvailable}
            onClose={() => setShowShareModal(false)}
          />
        ))}

      {showHoverCard && provider && previewPos && (
        <SessionHoverCard
          hoverCardId={hoverCardId}
          anchor={previewPos}
          prompt={hoverPrompt}
          lastAgentText={hoverLastAgent}
          provider={provider}
          model={model}
          projectName={projectName}
          ageLabel={hoverAgeLabel}
          status={status}
          pendingInputType={pendingInputType}
          hasUnread={hasUnread}
          activity={activity}
          maxHeightPx={hoverCardMaxHeightPx}
          onMouseLeave={clearPreview}
        />
      )}
    </li>
  );
}
