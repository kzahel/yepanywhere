import {
  MAX_SIDEBAR_CATEGORY_LENGTH,
  type PromptSuggestionMode,
  normalizeSidebarCategory,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import styles from "./SessionMenu.module.css";
import { IconButton } from "./ui/Button";
import { TextInput } from "./ui/Field";
import { Menu, MenuGroup, MenuItem, useMenuTrigger } from "./ui/Menu";

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
  /** The session's current sidebar category, if any. */
  sidebarCategory?: string;
  /** Existing categories to offer, besides creating a new one. */
  sidebarCategoryNames?: readonly string[];
  /** File the session under a category, or none with null. Omit to hide. */
  onSetSidebarCategory?: (category: string | null) => void | Promise<void>;
  onToggleArchive: () => void | Promise<void>;
  onToggleRead?: () => void | Promise<void>;
  onRename: () => void;
  /** Open Session Info directly, without visiting model configuration. */
  onShowInfo?: () => void;
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
  shareLabel?: ReactNode;
  additionalItems?: (close: () => void) => ReactNode;
  triggerClassName?: string;
  /** Additional class for the wrapper */
  className?: string;
  /** Remove the trigger from layout so its caller can overlay it on a row. */
  overlayTrigger?: boolean;
  /** Notified when the menu opens/closes so callers can react to open state. */
  onOpenChange?: (open: boolean) => void;
}

export function SessionMenu({
  sessionId,
  isStarred,
  isArchived,
  hasUnread,
  processId,
  onToggleStar,
  sidebarCategory,
  sidebarCategoryNames = [],
  onSetSidebarCategory,
  onToggleArchive,
  onToggleRead,
  onRename,
  onShowInfo,
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
  onConfigureProjectSettings,
  onConfigureRecaps,
  promptSuggestionMode,
  onTogglePromptSuggestions,
  warningRestoreAvailable = false,
  onRestoreWarnings,
  onShare,
  shareLabel,
  additionalItems,
  triggerClassName,
  useEllipsisIcon = false,
  className = "",
  overlayTrigger = false,
  onOpenChange,
}: SessionMenuProps) {
  const { t } = useI18n();
  // Notifies the caller of every open/close (toggle, outside press, Escape,
  // item select), not just the trigger click.
  const menu = useMenuTrigger({ onOpenChange });
  const isOpen = menu.open;
  const closeMenu = menu.close;
  const [isTerminating, setIsTerminating] = useState(false);
  const [isRestartingProvider, setIsRestartingProvider] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  // A copied id leaves nothing on screen to confirm it, so the entry reports
  // the outcome in place and closes the menu once the reader has seen it.
  const [copiedSessionId, setCopiedSessionId] = useState<"ok" | "failed">();
  // The category choices stay folded until asked for, so the menu keeps its
  // length; a new name is typed in place rather than in a separate dialog.
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [newCategoryDraft, setNewCategoryDraft] = useState<string | null>(null);
  // Identifies the current opening, so a copy that finishes after its menu
  // closed cannot report into, or close, a later one.
  const openingRef = useRef<object | null>(null);
  // Escape in the new-category field cancels the name and puts focus back
  // on the entry that opened it, rather than closing the menu.
  const newCategoryItemRef = useRef<HTMLButtonElement>(null);
  const newCategoryInputRef = useRef<HTMLInputElement>(null);
  const refocusNewCategoryRef = useRef(false);

  useEffect(() => {
    openingRef.current = isOpen ? {} : null;
    if (!isOpen) {
      setCopiedSessionId(undefined);
      setCategoryPickerOpen(false);
      setNewCategoryDraft(null);
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (newCategoryDraft !== null || !refocusNewCategoryRef.current) return;
    refocusNewCategoryRef.current = false;
    newCategoryItemRef.current?.focus({ preventScroll: true });
  }, [newCategoryDraft]);

  // A failure stays on the entry until the menu closes; only success is
  // transient, because the clipboard already carries the proof.
  useEffect(() => {
    if (!isOpen || copiedSessionId !== "ok") return;
    const timer = setTimeout(closeMenu, 1000);
    return () => clearTimeout(timer);
  }, [isOpen, copiedSessionId, closeMenu]);

  const handleAction = (action: () => void | Promise<void>) => {
    closeMenu();
    action();
  };

  const handleTerminate = async () => {
    if (isTerminating || !onTerminate) return;
    setIsTerminating(true);
    closeMenu();
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
    closeMenu();
    try {
      await onShare();
    } catch (error) {
      console.error("Failed to share session:", error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopySessionId = async () => {
    const opening = openingRef.current;
    const copied = await writeClipboardText(sessionId);
    if (openingRef.current !== opening) return;
    setCopiedSessionId(copied ? "ok" : "failed");
  };

  const handleClone = async () => {
    if (isCloning || cloneDisabled || !onClone) return;
    setIsCloning(true);
    closeMenu();
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

  return (
    <div className={wrapperClasses}>
      <IconButton
        {...menu.triggerProps}
        size="small"
        label={t("sessionMenuOptions")}
        className={["session-menu-trigger", triggerClassName]
          .filter(Boolean)
          .join(" ")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menu.setOpen(!isOpen);
        }}
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
      </IconButton>
      <Menu
        open={isOpen}
        onClose={closeMenu}
        anchorRef={menu.anchorRef}
        placement="bottom-end"
        aria-label={t("sessionMenuOptions")}
        data-session-menu-open
        onEscapeKeyDown={(event) => {
          if (event.target !== newCategoryInputRef.current) return;
          event.preventDefault();
          refocusNewCategoryRef.current = true;
          setNewCategoryDraft(null);
        }}
      >
        {onShowInfo && (
          <MenuItem
            icon={
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v6M12 7h.01" />
              </svg>
            }
            onSelect={() => handleAction(onShowInfo)}
          >
            {t("sessionInfoShortcut")}
          </MenuItem>
        )}
        <MenuItem
          icon={
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
          }
          onSelect={() => handleAction(onToggleStar)}
        >
          {isStarred ? t("sessionMenuUnstar") : t("sessionMenuStar")}
        </MenuItem>
        {onSetSidebarCategory && (
          <>
            <MenuItem
              keepOpen
              aria-expanded={categoryPickerOpen}
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              }
              onSelect={() => setCategoryPickerOpen((open) => !open)}
            >
              {t("sessionMenuMoveToCategory")}
            </MenuItem>
            {categoryPickerOpen && (
              <div className={styles.categoryChoices}>
                <MenuGroup>
                  {sidebarCategoryNames.map((name) => (
                    <MenuItem
                      key={name}
                      kind="radio"
                      checked={name === sidebarCategory}
                      onSelect={() =>
                        handleAction(() =>
                          onSetSidebarCategory(
                            name === sidebarCategory ? null : name,
                          ),
                        )
                      }
                    >
                      {name}
                    </MenuItem>
                  ))}
                  {newCategoryDraft === null ? (
                    <MenuItem
                      ref={newCategoryItemRef}
                      keepOpen
                      icon={
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
                      }
                      onSelect={() => setNewCategoryDraft("")}
                    >
                      {t("sessionMenuNewCategory")}
                    </MenuItem>
                  ) : (
                    <form
                      className={styles.newCategoryForm}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = normalizeSidebarCategory(newCategoryDraft);
                        if (name)
                          handleAction(() => onSetSidebarCategory(name));
                      }}
                    >
                      <TextInput
                        ref={newCategoryInputRef}
                        size="small"
                        className={styles.newCategoryInput}
                        autoFocus
                        value={newCategoryDraft}
                        maxLength={MAX_SIDEBAR_CATEGORY_LENGTH}
                        placeholder={t("sessionMenuNewCategoryPlaceholder")}
                        aria-label={t("sessionMenuNewCategory")}
                        onChange={(event) =>
                          setNewCategoryDraft(event.target.value)
                        }
                      />
                    </form>
                  )}
                  {sidebarCategory && (
                    <MenuItem
                      icon={
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      }
                      onSelect={() =>
                        handleAction(() => onSetSidebarCategory(null))
                      }
                    >
                      {t("sessionMenuRemoveFromCategory")}
                    </MenuItem>
                  )}
                </MenuGroup>
              </div>
            )}
          </>
        )}
        <MenuItem
          icon={
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
          }
          onSelect={() => handleAction(onRename)}
        >
          {t("sessionMenuRename")}
        </MenuItem>
        {onOpenNewTab && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onOpenNewTab)}
          >
            {t("sessionMenuOpenNewTab")}
          </MenuItem>
        )}
        {(onClone || cloneUnavailableMessage) && (
          <MenuItem
            icon={
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
            }
            onSelect={handleClone}
            disabled={Boolean(
              cloneUnavailableMessage || cloneDisabled || isCloning,
            )}
            tooltip={
              cloneUnavailableMessage ??
              (cloneDisabled ? t("sessionMenuCloneDisabled") : undefined)
            }
          >
            {isCloning
              ? t("sessionMenuCloning")
              : cloneUnavailableMessage
                ? t("sessionMenuCloneUpdateRequired")
                : t("sessionMenuClone")}
          </MenuItem>
        )}
        {onGenerateTitle && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onGenerateTitle)}
          >
            {t("sessionMenuGenerateTitle")}
          </MenuItem>
        )}
        {onCopyPrompt && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onCopyPrompt)}
          >
            {t("sessionMenuCopyPrompt")}
          </MenuItem>
        )}
        <MenuItem
          keepOpen
          icon={
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
          }
          onSelect={handleCopySessionId}
        >
          {copiedSessionId === "ok"
            ? t("sessionMenuCopiedSessionId")
            : copiedSessionId === "failed"
              ? t("sessionMenuCopySessionIdFailed")
              : t("sessionMenuCopySessionId")}
        </MenuItem>
        {onConfigureProjectSettings && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onConfigureProjectSettings)}
          >
            {t("sessionMenuProjectSettings")}
          </MenuItem>
        )}
        {onConfigureRecaps && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onConfigureRecaps)}
          >
            {t("sessionMenuRecaps")}
          </MenuItem>
        )}
        {onTogglePromptSuggestions && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onTogglePromptSuggestions)}
          >
            {promptSuggestionMode === "native"
              ? t("sessionMenuPromptSuggestionsOn")
              : t("sessionMenuPromptSuggestionsOff")}
          </MenuItem>
        )}
        {warningRestoreAvailable && onRestoreWarnings && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onRestoreWarnings)}
          >
            {t("sessionMenuRestoreWarnings")}
          </MenuItem>
        )}
        {onCompact && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onCompact)}
            disabled={compactDisabled}
            tooltip={
              compactDisabled ? t("sessionCompactTurnActive") : undefined
            }
          >
            {t(
              compactDisabled
                ? "sessionMenuCompactTurnActive"
                : "sessionMenuCompact",
            )}
          </MenuItem>
        )}
        {onHandoff && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onHandoff)}
          >
            {t("sessionMenuHandoff")}
          </MenuItem>
        )}
        {onClear && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onClear)}
          >
            {t("sessionMenuClear")}
          </MenuItem>
        )}
        {onShare && (
          <MenuItem
            icon={
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
            }
            onSelect={handleShare}
            disabled={isSharing}
          >
            {isSharing
              ? t("sessionMenuSharing")
              : (shareLabel ?? t("sessionMenuShare"))}
          </MenuItem>
        )}
        {additionalItems?.(closeMenu)}
        <MenuItem
          icon={
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
          }
          onSelect={() => handleAction(onToggleArchive)}
        >
          {isArchived ? t("sessionMenuUnarchive") : t("sessionMenuArchive")}
        </MenuItem>
        {onToggleRead && (
          <MenuItem
            icon={
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
            }
            shortcut={hasUnread ? "R" : "U"}
            onSelect={() => handleAction(onToggleRead)}
          >
            {hasUnread ? t("sessionMenuMarkRead") : t("sessionMenuMarkUnread")}
          </MenuItem>
        )}
        {processId && onRestartProvider && (
          <MenuItem
            icon={
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
            }
            disabled={isRestartingProvider || isTerminating}
            tooltip={t("sessionMenuRestartProviderHint")}
            onSelect={async () => {
              if (isRestartingProvider) return;
              setIsRestartingProvider(true);
              closeMenu();
              try {
                await onRestartProvider();
              } finally {
                setIsRestartingProvider(false);
              }
            }}
          >
            {isRestartingProvider
              ? t("sessionMenuRestartingProvider")
              : t("sessionMenuRestartProvider")}
          </MenuItem>
        )}
        {processId && onTerminate && (
          <MenuItem
            tone="danger"
            icon={
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
            }
            onSelect={handleTerminate}
            disabled={isTerminating}
          >
            {isTerminating
              ? t("sessionMenuTerminating")
              : t("sessionMenuTerminate")}
          </MenuItem>
        )}
        {onReload && (
          <MenuItem
            icon={
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
            }
            onSelect={() => handleAction(onReload)}
          >
            Reload page
          </MenuItem>
        )}
      </Menu>
    </div>
  );
}
