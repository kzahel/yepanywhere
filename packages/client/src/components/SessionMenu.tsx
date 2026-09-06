import type { PromptSuggestionMode } from "@yep-anywhere/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import styles from "./SessionMenu.module.css";

export interface SessionMenuProps {
  sessionId: string;
  projectId: string;
  isStarred: boolean;
  isArchived: boolean;
  hasUnread?: boolean;
  /** Provider name - used for capability checks like cloning support */
  provider?: string;
  /** Process ID if session has an active process (enables terminate option) */
  processId?: string;
  onToggleStar: () => void | Promise<void>;
  onToggleArchive: () => void | Promise<void>;
  onToggleRead?: () => void | Promise<void>;
  onRename: () => void;
  /** Generate and apply a title through the provider helper flow. */
  onGenerateTitle?: () => void | Promise<void>;
  /** Copy the session's initial prompt, when available. */
  onCopyPrompt?: () => void | Promise<void>;
  /** Open this session in a new browser tab/window. */
  onOpenNewTab?: () => void | Promise<void>;
  /** Create a cold provider-native clone of the latest completed transcript. */
  onClone?: () => void | Promise<void>;
  /** Why Clone is visible but unavailable on this server. */
  cloneUnavailableMessage?: string;
  /** Clone waits for the current provider response to complete. */
  cloneDisabled?: boolean;
  /** Called to request compaction in the current session */
  onCompact?: () => void | Promise<void>;
  compactDisabled?: boolean;
  /** Called to hand off the session into a fresh agent session */
  onHandoff?: () => void | Promise<void>;
  /** Start an empty session in the same project with the same provider/model */
  onClear?: () => void | Promise<void>;
  /** Called to terminate the session's process */
  onTerminate?: () => void | Promise<void>;
  /** Stop the provider, reopen its saved session, and refresh the view. */
  onRestartProvider?: () => Promise<void>;
  /** Reload the page (non-swipe alternative for mobile) */
  onReload?: () => void;
  /** Called to configure session heartbeat settings */
  onConfigureHeartbeat?: () => void;
  /** Called to configure defaults for this session's project */
  onConfigureProjectSettings?: () => void;
  /** Called to configure session recap settings */
  onConfigureRecaps?: () => void;
  /**
   * Current per-session prompt-suggestion mode. When provided alongside
   * onTogglePromptSuggestions, a toggle entry is shown.
   */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Toggle the per-session prompt-suggestion preference (off <-> native) */
  onTogglePromptSuggestions?: () => void | Promise<void>;
  /** Whether dismissed warnings can be restored */
  warningRestoreAvailable?: boolean;
  /** Restore dismissed per-session warnings */
  onRestoreWarnings?: () => void | Promise<void>;
  /** Use "..." icon instead of chevron */
  useEllipsisIcon?: boolean;
  /** @deprecated Public share availability is checked when the modal creates the link. */
  sharingConfigured?: boolean;
  /** Called to open the public share flow */
  onShare?: () => void | Promise<void>;
  /** Additional class for the wrapper */
  className?: string;
  /** Remove the trigger from layout so its caller can overlay it on a row. */
  overlayTrigger?: boolean;
  /** Use fixed positioning for dropdown (escapes overflow clipping) */
  useFixedPositioning?: boolean;
  /** Notified when the menu opens/closes so callers can react to open state. */
  onOpenChange?: (open: boolean) => void;
}

export function SessionMenu({
  isStarred,
  isArchived,
  hasUnread,
  processId,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  onGenerateTitle,
  onCopyPrompt,
  onOpenNewTab,
  onClone,
  cloneUnavailableMessage,
  cloneDisabled = false,
  onCompact,
  compactDisabled = false,
  onHandoff,
  onClear,
  onTerminate,
  onRestartProvider,
  onReload,
  onConfigureHeartbeat,
  onConfigureProjectSettings,
  onConfigureRecaps,
  promptSuggestionMode,
  onTogglePromptSuggestions,
  warningRestoreAvailable = false,
  onRestoreWarnings,
  onShare,
  useEllipsisIcon = false,
  className = "",
  overlayTrigger = false,
  useFixedPositioning = false,
  onOpenChange,
}: SessionMenuProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [isRestartingProvider, setIsRestartingProvider] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside or scrolling (mobile)
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check both wrapper and dropdown (dropdown may be in portal)
      const clickedInWrapper = wrapperRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInDropdown) {
        setIsOpen(false);
        triggerRef.current?.blur();
      }
    };
    const handleScroll = (e: Event) => {
      // Only close if scroll happens in an ancestor of the menu trigger
      // This prevents closing when unrelated areas (like main content pane) scroll
      const scrollTarget = e.target as Node;
      if (
        scrollTarget instanceof Node &&
        wrapperRef.current &&
        !scrollTarget.contains(wrapperRef.current)
      ) {
        return; // Scroll is not in an ancestor of the menu, ignore
      }
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [isOpen]);

  // Notify the caller of every open/close (covers toggle, outside-click,
  // scroll, and item-select close paths), not just the trigger click.
  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  const handleToggleOpen = () => {
    if (isOpen) {
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    } else {
      setIsOpen(true);
    }
  };

  useLayoutEffect(() => {
    if (!isOpen || !useFixedPositioning) return;
    const trigger = triggerRef.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown) return;
    const rect = trigger.getBoundingClientRect();
    const { width, height } = dropdown.getBoundingClientRect();
    const margin = 8;
    const below = rect.bottom + margin;
    const preferredTop =
      below + height <= window.innerHeight - margin
        ? below
        : rect.top - height - margin;
    setDropdownPosition({
      top: Math.max(
        margin,
        Math.min(preferredTop, window.innerHeight - height - margin),
      ),
      left: Math.max(
        margin,
        Math.min(rect.right - width, window.innerWidth - width - margin),
      ),
    });
  }, [isOpen, useFixedPositioning]);

  const handleAction = (action: () => void | Promise<void>) => {
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    action();
  };

  const handleTerminate = async () => {
    if (isTerminating || !onTerminate) return;
    setIsTerminating(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onTerminate();
    } catch (error) {
      console.error("Failed to terminate session:", error);
    } finally {
      setIsTerminating(false);
    }
  };

  const handleShare = async () => {
    if (isSharing || !onShare) return;
    setIsSharing(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onShare();
    } catch (error) {
      console.error("Failed to share session:", error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleClone = async () => {
    if (isCloning || cloneDisabled || !onClone) return;
    setIsCloning(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onClone();
    } finally {
      setIsCloning(false);
    }
  };

  const wrapperClasses = [
    styles.wrapper,
    overlayTrigger && styles.overlayTrigger,
    "session-menu-wrapper",
    className,
    isOpen && "is-open",
  ]
    .filter(Boolean)
    .join(" ");

  // For portal mode, we must have fixed positioning with calculated coordinates
  // Fall back to a visible position if calculation failed
  const dropdownStyle = useFixedPositioning
    ? {
        position: "fixed" as const,
        marginTop: 0,
        top: dropdownPosition?.top ?? 100,
        ...(dropdownPosition?.left !== undefined
          ? { left: dropdownPosition.left }
          : { right: dropdownPosition?.right ?? 20 }),
      }
    : undefined;

  const dropdownContent = (
    <div ref={dropdownRef} className={styles.dropdown} style={dropdownStyle}>
      <button type="button" onClick={() => handleAction(onToggleStar)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={isStarred ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        {isStarred ? t("sessionMenuUnstar") : t("sessionMenuStar")}
      </button>
      <button type="button" onClick={() => handleAction(onRename)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        {t("sessionMenuRename")}
      </button>
      {onOpenNewTab && (
        <button type="button" onClick={() => handleAction(onOpenNewTab)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
          {t("sessionMenuOpenNewTab")}
        </button>
      )}
      {(onClone || cloneUnavailableMessage) && (
        <button
          type="button"
          onClick={handleClone}
          disabled={Boolean(
            cloneUnavailableMessage || cloneDisabled || isCloning,
          )}
          title={
            cloneUnavailableMessage ??
            (cloneDisabled ? t("sessionMenuCloneDisabled") : undefined)
          }
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
          {isCloning
            ? t("sessionMenuCloning")
            : cloneUnavailableMessage
              ? t("sessionMenuCloneUpdateRequired")
              : t("sessionMenuClone")}
        </button>
      )}
      {onGenerateTitle && (
        <button type="button" onClick={() => handleAction(onGenerateTitle)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
            <path d="m11 8 4 4-4 4" />
            <path d="M8 12h7" />
          </svg>
          {t("sessionMenuGenerateTitle")}
        </button>
      )}
      {onCopyPrompt && (
        <button type="button" onClick={() => handleAction(onCopyPrompt)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {t("sessionMenuCopyPrompt")}
        </button>
      )}
      {onConfigureProjectSettings && (
        <button
          type="button"
          onClick={() => handleAction(onConfigureProjectSettings)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.36.72.6 1 .3.35.7.55 1.1.6h.09v4h-.09a1.7 1.7 0 0 0-1.7.4Z" />
          </svg>
          {t("sessionMenuProjectSettings")}
        </button>
      )}
      {onConfigureHeartbeat && (
        <button
          type="button"
          onClick={() => handleAction(onConfigureHeartbeat)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="m4.93 4.93 2.83 2.83" />
            <path d="m16.24 16.24 2.83 2.83" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
            <path d="m4.93 19.07 2.83-2.83" />
            <path d="m16.24 7.76 2.83-2.83" />
          </svg>
          {t("sessionMenuHeartbeat")}
        </button>
      )}
      {onConfigureRecaps && (
        <button type="button" onClick={() => handleAction(onConfigureRecaps)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 19h16" />
            <path d="M6 5h12" />
            <path d="M6 9h12" />
            <path d="M6 13h8" />
          </svg>
          {t("sessionMenuRecaps")}
        </button>
      )}
      {onTogglePromptSuggestions && (
        <button
          type="button"
          onClick={() => handleAction(onTogglePromptSuggestions)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M9.5 2A7.5 7.5 0 0 0 5 15.5V18a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2.5A7.5 7.5 0 0 0 9.5 2Z" />
            <path d="M9 22h2" />
          </svg>
          {promptSuggestionMode === "native"
            ? t("sessionMenuPromptSuggestionsOn")
            : t("sessionMenuPromptSuggestionsOff")}
        </button>
      )}
      {warningRestoreAvailable && onRestoreWarnings && (
        <button type="button" onClick={() => handleAction(onRestoreWarnings)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          {t("sessionMenuRestoreWarnings")}
        </button>
      )}
      {onCompact && (
        <button
          type="button"
          onClick={() => handleAction(onCompact)}
          disabled={compactDisabled}
          title={compactDisabled ? t("sessionCompactTurnActive") : undefined}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 14h6v6" />
            <path d="m4 20 7-7" />
            <path d="M20 10h-6V4" />
            <path d="m20 4-7 7" />
          </svg>
          {t(
            compactDisabled
              ? "sessionMenuCompactTurnActive"
              : "sessionMenuCompact",
          )}
        </button>
      )}
      {onHandoff && (
        <button type="button" onClick={() => handleAction(onHandoff)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M17 1l4 4-4 4" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <path d="M7 23l-4-4 4-4" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {t("sessionMenuHandoff")}
        </button>
      )}
      {onClear && (
        <button type="button" onClick={() => handleAction(onClear)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          {t("sessionMenuClear")}
        </button>
      )}
      {onShare && (
        <button type="button" onClick={handleShare} disabled={isSharing}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="m8.6 13.5 6.8 4" />
            <path d="m15.4 6.5-6.8 4" />
          </svg>
          {isSharing ? t("sessionMenuSharing") : t("sessionMenuShare")}
        </button>
      )}
      <button type="button" onClick={() => handleAction(onToggleArchive)}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
        {isArchived ? t("sessionMenuUnarchive") : t("sessionMenuArchive")}
      </button>
      {onToggleRead && (
        <button type="button" onClick={() => handleAction(onToggleRead)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {hasUnread ? (
              // Checkmark icon for "Mark as read"
              <polyline points="20 6 9 17 4 12" />
            ) : (
              // Envelope/circle icon for "Mark as unread"
              <circle cx="12" cy="12" r="10" />
            )}
          </svg>
          {hasUnread ? t("sessionMenuMarkRead") : t("sessionMenuMarkUnread")}
        </button>
      )}
      {processId && onRestartProvider && (
        <button
          type="button"
          disabled={isRestartingProvider || isTerminating}
          title={t("sessionMenuRestartProviderHint")}
          onClick={async () => {
            if (isRestartingProvider) return;
            setIsRestartingProvider(true);
            setIsOpen(false);
            triggerRef.current?.blur();
            try {
              await onRestartProvider();
            } finally {
              setIsRestartingProvider(false);
            }
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7" />
          </svg>
          {isRestartingProvider
            ? t("sessionMenuRestartingProvider")
            : t("sessionMenuRestartProvider")}
        </button>
      )}
      {processId && onTerminate && (
        <button
          type="button"
          onClick={handleTerminate}
          disabled={isTerminating}
          className={styles.terminateButton}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {/* X in a square (stop/terminate icon) */}
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="9" x2="15" y2="15" />
            <line x1="15" y1="9" x2="9" y2="15" />
          </svg>
          {isTerminating
            ? t("sessionMenuTerminating")
            : t("sessionMenuTerminate")}
        </button>
      )}
      {onReload && (
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            onReload();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Reload page
        </button>
      )}
    </div>
  );

  // Render dropdown via portal when using fixed positioning to escape overflow clipping
  const renderDropdown = () => {
    if (useFixedPositioning) {
      return createPortal(dropdownContent, document.body);
    }
    return dropdownContent;
  };

  return (
    <div className={wrapperClasses} ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={[styles.trigger, "session-menu-trigger"].join(" ")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleToggleOpen();
        }}
        aria-label={t("sessionMenuOptions")}
        aria-expanded={isOpen}
      >
        {useEllipsisIcon ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {isOpen && renderDropdown()}
    </div>
  );
}
