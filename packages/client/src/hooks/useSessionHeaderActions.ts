import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { PromptSuggestionMode } from "@yep-anywhere/shared";
import { api } from "../api/client";
import type { ModalAnchorRect } from "../components/ui/Modal";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { useSessionCollectionRecord } from "../lib/clientSummaryStore";
import {
  sessionReadShortcut,
  setSessionUnread,
} from "../lib/sessionReadActions";
import type { DraftControls } from "./useDraftPersistence";
import type { useSession } from "./useSession";

/**
 * One session page's header actions: archive, star, prompt suggestions,
 * read and unread (with the keyboard shortcut), terminate and restart
 * provider, and the share manager's open state. The optimistic metadata
 * state stays in the page, which title editing also writes.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 1).
 */
export function useSessionHeaderActions({
  sessionId,
  projectId,
  actualSessionId,
  session,
  sessionCollectionRecord,
  status,
  setStatus,
  isArchived,
  isStarred,
  promptSuggestionMode,
  localPromptSuggestionMode,
  setLocalIsArchived,
  setLocalIsStarred,
  setLocalPromptSuggestionMode,
  isDomLingerParked,
  loading,
  draftControlsRef,
  publicShareManagementAvailable,
}: {
  sessionId: string;
  projectId: string;
  actualSessionId: string;
  session: ReturnType<typeof useSession>["session"];
  sessionCollectionRecord: ReturnType<typeof useSessionCollectionRecord>;
  status: ReturnType<typeof useSession>["status"];
  setStatus: ReturnType<typeof useSession>["setStatus"];
  isArchived: boolean;
  isStarred: boolean;
  promptSuggestionMode: PromptSuggestionMode;
  localPromptSuggestionMode: PromptSuggestionMode | undefined;
  setLocalIsArchived: Dispatch<SetStateAction<boolean | undefined>>;
  setLocalIsStarred: Dispatch<SetStateAction<boolean | undefined>>;
  setLocalPromptSuggestionMode: Dispatch<
    SetStateAction<PromptSuggestionMode | undefined>
  >;
  isDomLingerParked: boolean;
  loading: boolean;
  draftControlsRef: RefObject<DraftControls | null>;
  publicShareManagementAvailable: boolean;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareModalView, setShareModalView] = useState<"manage" | "session">(
    "session",
  );
  const [shareModalAnchor, setShareModalAnchor] =
    useState<ModalAnchorRect | null>(null);

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      setLocalIsArchived(newArchived);
      showToast(
        newArchived ? t("sessionArchived") : t("sessionUnarchived"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(t("sessionArchiveFailed"), "error");
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? t("sessionStarred") : t("sessionUnstarred"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast(t("sessionStarFailed"), "error");
    }
  };

  const handleTogglePromptSuggestions = async () => {
    const next: PromptSuggestionMode =
      promptSuggestionMode === "native" ? "off" : "native";
    const previous = localPromptSuggestionMode;
    setLocalPromptSuggestionMode(next);
    try {
      await api.updateSessionMetadata(sessionId, {
        promptSuggestionMode: next,
      });
      showToast(
        next === "native"
          ? t("sessionPromptSuggestionsEnabled")
          : t("sessionPromptSuggestionsDisabled"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update prompt suggestion mode:", err);
      setLocalPromptSuggestionMode(previous);
      showToast(t("sessionPromptSuggestionsFailed"), "error");
    }
  };

  const hasUnread =
    sessionCollectionRecord?.hasUnread ?? session?.hasUnread ?? false;

  const handleSetUnread = useCallback(
    async (newHasUnread: boolean) => {
      try {
        await setSessionUnread(sessionId, newHasUnread);
        showToast(
          newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
          "success",
        );
      } catch (err) {
        console.error("Failed to update read status:", err);
        showToast(t("sessionReadFailed"), "error");
      }
    },
    [sessionId, showToast, t],
  );
  const handleToggleRead = () => handleSetUnread(!hasUnread);

  useEffect(() => {
    if (isDomLingerParked || loading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const unread = sessionReadShortcut(event);
      if (unread === null) return;
      const target = event.target as Element;
      if (
        target !== document.body &&
        target
          .closest("[data-session-read-scope]")
          ?.getAttribute("data-session-read-scope") !== sessionId
      )
        return;
      event.preventDefault();
      void handleSetUnread(unread);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDomLingerParked, loading, sessionId, handleSetUnread]);

  const handleTerminate = async () => {
    if (status.owner === "self" && status.processId) {
      try {
        await api.abortProcess(status.processId, { blockResume: true });
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleRestartProvider = async () => {
    if (status.owner !== "self" || !status.processId) return;
    draftControlsRef.current?.flushDraft();
    try {
      await api.abortProcess(status.processId);
      setStatus({ owner: "none" });
      await api.reactivateSession(projectId, actualSessionId);
      window.location.reload();
    } catch (error) {
      showToast(
        t("sessionRestartProviderFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    }
  };

  const handleShare = useCallback(() => {
    if (showShareModal) {
      setShowShareModal(false);
      setShareModalAnchor(null);
      return;
    }
    setShareModalAnchor(null);
    setShareModalView(publicShareManagementAvailable ? "manage" : "session");
    setShowShareModal(true);
  }, [publicShareManagementAvailable, showShareModal]);

  const handleShareIndicatorClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (showShareModal) {
        setShowShareModal(false);
        setShareModalAnchor(null);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setShareModalAnchor({
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      });
      setShareModalView(publicShareManagementAvailable ? "manage" : "session");
      setShowShareModal(true);
    },
    [publicShareManagementAvailable, showShareModal],
  );

  const handleShareIndicatorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!publicShareManagementAvailable) return;
      event.preventDefault();
      handleShareIndicatorClick(event);
    },
    [handleShareIndicatorClick, publicShareManagementAvailable],
  );

  return {
    showShareModal,
    setShowShareModal,
    shareModalView,
    shareModalAnchor,
    setShareModalAnchor,
    handleToggleArchive,
    handleToggleStar,
    handleTogglePromptSuggestions,
    hasUnread,
    handleToggleRead,
    handleTerminate,
    handleRestartProvider,
    handleShare,
    handleShareIndicatorClick,
    handleShareIndicatorContextMenu,
  };
}
