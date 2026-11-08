import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import {
  composeGeneratedRetitle,
  createSessionRetitleSubmittedTurnText,
  type GeneratedRetitleInsertion,
} from "../lib/sessionTitleHelpers";
import type { DraftControls } from "./useDraftPersistence";

type TitleEditMode = "manual" | "retitle";

interface GeneratedRetitleState {
  requestId: number;
  status: "generating" | "ready" | "error";
  submittedTurnText: string;
  title?: string;
  error?: string;
  deferredInsertion?: GeneratedRetitleInsertion;
}

/**
 * One session page's title editing: the rename field (inline or in a
 * dialog), the generated retitle (suggest, accept, apply when ready), the
 * `/title` command, and the blur, Enter and Escape handling. The local title
 * it saves (`setLocalCustomTitle`) stays with the page's other optimistic
 * metadata. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 3).
 */
export function useSessionTitleEditing({
  projectId,
  sessionId,
  displayTitle,
  condensedHeader,
  titleRowRef,
  setShowRecentSessions,
  supportsTitleGeneration,
  routedSession,
  generatedTitleLength,
  draftControlsRef,
  setLocalCustomTitle,
  isDomLingerParked,
}: {
  projectId: string;
  sessionId: string;
  displayTitle: string;
  condensedHeader: boolean;
  titleRowRef: RefObject<HTMLDivElement | null>;
  setShowRecentSessions: (show: boolean) => void;
  supportsTitleGeneration: boolean;
  routedSession: boolean;
  generatedTitleLength: number;
  draftControlsRef: RefObject<DraftControls | null>;
  setLocalCustomTitle: (title: string | undefined) => void;
  isDomLingerParked: boolean;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renamePresentation, setRenamePresentation] = useState<
    "inline" | "dialog"
  >("dialog");
  const [titleEditMode, setTitleEditMode] = useState<TitleEditMode>("manual");
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [generatedRetitle, setGeneratedRetitle] =
    useState<GeneratedRetitleState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const titleInputWantsFocusRef = useRef(false);
  const attachTitleInput = useCallback((input: HTMLInputElement | null) => {
    renameInputRef.current = input;
    if (!input || !titleInputWantsFocusRef.current) return;
    titleInputWantsFocusRef.current = false;
    input.focus();
    input.select();
  }, []);
  const titleEditControlsRef = useRef<HTMLDivElement>(null);
  const isSavingTitleRef = useRef(false);
  const retitleRequestIdRef = useRef(0);
  const generatedRetitleRef = useRef<GeneratedRetitleState | null>(null);

  useEffect(() => {
    generatedRetitleRef.current = generatedRetitle;
  }, [generatedRetitle]);

  const setRetitleState = (state: GeneratedRetitleState | null) => {
    generatedRetitleRef.current = state;
    setGeneratedRetitle(state);
  };

  const invalidateGeneratedRetitle = () => {
    retitleRequestIdRef.current += 1;
    setRetitleState(null);
  };

  // Asking to edit the title means the user is about to type, so focus lands
  // in the commit that creates the input (attachTitleInput) instead of a
  // timer hop later, during which keys reach the page's own shortcuts. When
  // the input is already mounted this focuses it directly.
  const focusAndSelectTitleInput = () => {
    const input = renameInputRef.current;
    if (!input) {
      titleInputWantsFocusRef.current = true;
      return;
    }
    input.focus();
    input.select();
  };

  const captureGeneratedRetitleInsertion = (): GeneratedRetitleInsertion => {
    const input = renameInputRef.current;
    const value = input?.value ?? renameValue;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    return {
      prefix: value.slice(0, start),
      suffix: value.slice(end),
    };
  };

  const saveTitleValue = async (nextTitle: string): Promise<boolean> => {
    const trimmed = nextTitle.trim();
    if (!trimmed || isRenaming) return false;
    if (trimmed === displayTitle) {
      handleCancelEditingTitle();
      return true;
    }

    invalidateGeneratedRetitle();
    isSavingTitleRef.current = true;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: trimmed });
      setLocalCustomTitle(trimmed);
      activityBus.emitLocal("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId,
        title: trimmed,
        timestamp: new Date().toISOString(),
      });
      setIsEditingTitle(false);
      setTitleEditMode("manual");
      setRenameValue("");
      showToast(t("sessionRenamed"), "success");
      return true;
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
      return false;
    } finally {
      setIsRenaming(false);
      isSavingTitleRef.current = false;
    }
  };

  const handleStartEditingTitle = () => {
    setShowRecentSessions(false);
    invalidateGeneratedRetitle();
    setTitleEditMode("manual");
    // Decide once: a keyboard resize or rotation must not remount the editor.
    setRenamePresentation(
      !condensedHeader &&
        (titleRowRef.current?.getBoundingClientRect().width ?? 0) >= 420
        ? "inline"
        : "dialog",
    );
    setIsEditingTitle(true);
  };

  const handleStartRetitleTitle = (options?: { applyWhenReady?: boolean }) => {
    setShowRecentSessions(false);
    setTitleEditMode("retitle");
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    if (!options?.applyWhenReady) {
      focusAndSelectTitleInput();
    }

    const requestId = retitleRequestIdRef.current + 1;
    retitleRequestIdRef.current = requestId;
    const submittedTurnText = createSessionRetitleSubmittedTurnText(
      displayTitle,
      generatedTitleLength,
    );
    if (!supportsTitleGeneration) {
      setRetitleState({
        requestId,
        status: "error",
        submittedTurnText,
        error: routedSession
          ? t("routedSessionTitleUnavailable")
          : t("sessionRetitleUnsupported"),
      });
      return;
    }

    setRetitleState({
      requestId,
      status: "generating",
      submittedTurnText,
      ...(options?.applyWhenReady
        ? { deferredInsertion: { prefix: "", suffix: "" } }
        : {}),
    });
    void (async () => {
      try {
        const result = await api.proposeSessionRetitle(projectId, sessionId, {
          currentTitle: displayTitle,
          lengthTarget: generatedTitleLength,
        });
        if (retitleRequestIdRef.current !== requestId) return;
        const current = generatedRetitleRef.current;
        if (!current || current.requestId !== requestId) return;
        if (current.deferredInsertion) {
          await saveTitleValue(
            composeGeneratedRetitle(result.title, current.deferredInsertion),
          );
          return;
        }
        setRetitleState({
          requestId,
          status: "ready",
          submittedTurnText,
          title: result.title,
        });
      } catch (err) {
        if (retitleRequestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setRetitleState({
          requestId,
          status: "error",
          submittedTurnText,
          error: message || t("sessionRetitleFailed"),
        });
      }
    })();
  };

  const handleGenerateAndApplyTitle = () => {
    handleStartRetitleTitle({ applyWhenReady: true });
  };

  const handleLocalTitleCommand = async (title: string | null) => {
    if (title !== null) {
      const saved = await saveTitleValue(title);
      if (saved) {
        draftControlsRef.current?.confirmInputClear();
      } else {
        draftControlsRef.current?.restoreFromStorage();
      }
      return;
    }

    handleGenerateAndApplyTitle();
    if (supportsTitleGeneration) {
      draftControlsRef.current?.confirmInputClear();
    } else {
      draftControlsRef.current?.restoreFromStorage();
    }
  };

  const handleCancelEditingTitle = () => {
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    invalidateGeneratedRetitle();
    setIsEditingTitle(false);
    setTitleEditMode("manual");
    setRenameValue("");
  };
  const handleCancelEditingTitleRef = useRef(handleCancelEditingTitle);
  handleCancelEditingTitleRef.current = handleCancelEditingTitle;

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const nextTarget = e.relatedTarget;
    if (
      nextTarget instanceof Node &&
      titleEditControlsRef.current?.contains(nextTarget)
    ) {
      return;
    }
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    if (titleEditMode === "retitle") {
      handleCancelEditingTitle();
      return;
    }
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = () => {
    void saveTitleValue(renameValue);
  };

  const handleAcceptGeneratedRetitle = () => {
    if (titleEditMode !== "retitle") {
      handleSaveTitle();
      return;
    }
    const current = generatedRetitleRef.current;
    if (!current || current.status === "error") return;
    const insertion = captureGeneratedRetitleInsertion();
    if (current.status === "ready" && current.title) {
      void saveTitleValue(composeGeneratedRetitle(current.title, insertion));
      return;
    }
    if (current.status === "generating") {
      const next = { ...current, deferredInsertion: insertion };
      setRetitleState(next);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (titleEditMode === "retitle" && !e.ctrlKey) {
        handleAcceptGeneratedRetitle();
      } else {
        handleSaveTitle();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleCancelEditingTitle();
    }
  };

  useEffect(() => {
    if (isDomLingerParked) handleCancelEditingTitleRef.current();
  }, [isDomLingerParked]);

  useEffect(() => {
    if (isDomLingerParked || !isEditingTitle) return;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleCancelEditingTitleRef.current();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [isDomLingerParked, isEditingTitle]);

  return {
    isEditingTitle,
    renamePresentation,
    titleEditMode,
    renameValue,
    setRenameValue,
    isRenaming,
    generatedRetitle,
    attachTitleInput,
    titleEditControlsRef,
    saveTitleValue,
    handleStartEditingTitle,
    handleGenerateAndApplyTitle,
    handleLocalTitleCommand,
    handleCancelEditingTitle,
    handleTitleBlur,
    handleSaveTitle,
    handleAcceptGeneratedRetitle,
    handleTitleKeyDown,
  };
}
