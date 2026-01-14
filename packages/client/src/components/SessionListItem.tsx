import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ProcessStateType } from "../hooks/useFileActivity";
import type {
  AppSessionStatus,
  ContextUsage,
  PendingInputType,
  ProviderName,
} from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { SessionMenu } from "./SessionMenu";
import { SessionStatusBadge } from "./StatusBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface SessionListItemProps {
  // Core (required)
  sessionId: string;
  projectId: string;
  title: string | null;

  // Optional display data
  fullTitle?: string | null;
  projectName?: string;
  updatedAt?: string;
  hasUnread?: boolean;
  processState?: ProcessStateType;
  pendingInputType?: PendingInputType;
  contextUsage?: ContextUsage;
  status?: AppSessionStatus;
  provider?: ProviderName;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;

  // Feature toggles
  mode: "card" | "compact";
  showProjectName?: boolean;
  showTimestamp?: boolean;
  showContextUsage?: boolean;
  showStatusBadge?: boolean;

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

  // For sidebar compact mode
  hasDraft?: boolean;
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
  projectName,
  updatedAt,
  hasUnread: hasUnreadProp,
  processState,
  pendingInputType,
  contextUsage,
  status,
  provider,
  executor,
  // Feature toggles
  mode,
  showProjectName = false,
  showTimestamp = true,
  showContextUsage = true,
  showStatusBadge = true,
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
  // Sidebar
  hasDraft = false,
}: SessionListItemProps) {
  const navigate = useNavigate();

  // Local state for optimistic updates (only used when action handlers are provided)
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState<string | undefined>(undefined);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // Computed values with optimistic fallback
  const isStarred = localIsStarred ?? isStarredProp;
  const isArchived = localIsArchived ?? isArchivedProp;
  const displayTitle = localTitle ?? title ?? "Untitled session";

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [isEditing]);

  // Local state for optimistic unread toggle
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );
  const hasUnread = localHasUnread ?? hasUnreadProp;

  // Handlers for menu actions
  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    setLocalIsStarred(newStarred);
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
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
      onToggleArchive?.();
    } catch (err) {
      console.error("Failed to update archive status:", err);
      setLocalIsArchived(undefined); // Revert on error
    }
  };

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      onToggleRead?.();
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
    }
  };

  const handleRename = () => {
    setRenameValue(displayTitle);
    setIsEditing(true);
  };

  const handleCancelEditing = () => {
    if (isSavingRef.current) return;
    setIsEditing(false);
    setRenameValue("");
  };

  const handleSaveRename = async () => {
    if (!renameValue.trim() || isSaving) return;
    if (renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await api.updateSessionMetadata(sessionId, {
        title: renameValue.trim(),
      });
      setLocalTitle(renameValue.trim());
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
    if (status?.state === "external") {
      return <span className="session-badge session-badge-external">Ext</span>;
    }

    // Priority 1: Needs input
    if (pendingInputType) {
      const label = pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="session-badge session-badge-needs-input">{label}</span>
      );
    }

    // Priority 2: Running (thinking)
    if (processState === "running") {
      return <ThinkingIndicator />;
    }

    return null;
  };

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

  // Build CSS classes
  const liClasses = [
    "session-list-item",
    mode === "card" ? "session-list-item--card" : "session-list-item--compact",
    isCurrent && "current",
    hasUnread && "unread",
    isSelected && "selected",
    isArchived && "archived",
  ]
    .filter(Boolean)
    .join(" ");

  // Star icon SVG
  const StarIcon = ({
    filled,
    size = 10,
  }: { filled: boolean; size?: number }) => (
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
    <li className={liClasses}>
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
          to={`/projects/${projectId}/sessions/${sessionId}`}
          onClick={(e) => {
            if (isSelectionMode) {
              e.preventDefault();
            }
            onNavigate?.();
          }}
          title={fullTitle || displayTitle}
          className="session-list-item__link"
        >
          {mode === "card" ? (
            // Card mode: title on one line, meta on second line
            <>
              <strong className="session-list-item__title">
                {isStarred && <StarIcon filled size={12} />}
                {displayTitle}
                {isArchived && (
                  <span className="session-archived-badge">Archived</span>
                )}
              </strong>
              <span className="session-list-item__meta">
                {showProjectName && projectName && (
                  <span className="session-list-item__project">
                    {projectName}
                  </span>
                )}
                {showTimestamp && updatedAt && formatRelativeTime(updatedAt)}
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
                  <span className={`inbox-item-badge ${customBadge.className}`}>
                    {customBadge.label}
                  </span>
                )}
                {showStatusBadge && status && (
                  <SessionStatusBadge
                    status={status}
                    pendingInputType={pendingInputType}
                    hasUnread={hasUnread}
                    processState={processState}
                  />
                )}
              </span>
            </>
          ) : (
            // Compact mode: single line with badges
            <>
              <span className="session-list-item__title-row">
                {isStarred && <StarIcon filled />}
                <span className="session-list-item__title-text">
                  {displayTitle}
                </span>
                {hasDraft && (
                  <span className="session-draft-badge">(draft)</span>
                )}
              </span>
              {showProjectName && projectName && (
                <span className="session-list-item__project-compact">
                  {projectName}
                </span>
              )}
              {getCompactActivityIndicator()}
            </>
          )}
        </Link>
      )}

      {/* Only show menu when provider is available (required for clone) */}
      {provider && (
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
          onClone={(newSessionId) => {
            navigate(`/projects/${projectId}/sessions/${newSessionId}`);
          }}
          useEllipsisIcon
          useFixedPositioning
          className="session-list-item__menu"
        />
      )}
    </li>
  );
}
