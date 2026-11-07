import { SpeechDraftField } from "./SpeechDraftField";
import { DraftSyncNotice } from "./DraftSyncNotice";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDefaultNewSessionModel } from "../hooks/useDefaultNewSessionModel";
import { useComposerSpeechHandlers } from "../hooks/useComposerSpeechHandlers";
import { useComposerSpeechState } from "../hooks/useComposerSpeechState";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { handleSpeechEscapeKey } from "../lib/composerKeys";
import { createFabDraftKey } from "../hooks/useDrafts";
import { useFabVisibility } from "../hooks/useFabVisibility";
import { useFloatingActionButtonEnabled } from "../hooks/useFloatingActionButtonEnabled";
import {
  extractProjectIdFromPath,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import {
  getSpeechInterimPreview,
  getSpeechVisibleDraftText,
  textBeforeSpeechCursor,
} from "../lib/speechRecognition";
import type { SpeechTranscriptionContext } from "../lib/speechProviders/SpeechProvider";
import { ProviderBadge } from "./ProviderBadge";
import {
  VoiceInputButton,
  type SpeechCycleSettlement,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

/**
 * Informational default-model chip for the expanded floating composer: shows
 * the provider + model a session started from here will launch with. Mounted
 * only while expanded so the providers/settings fetch waits for the click.
 * Changing the model happens on the New Session page this composer submits to.
 */
function FloatingComposerModelChip() {
  const { t } = useI18n();
  const defaultNewSessionModel = useDefaultNewSessionModel();
  if (!defaultNewSessionModel) return null;
  return (
    <span
      className="composer-model-chip-static"
      title={t("floatingComposerModelChipTitle")}
    >
      <ProviderBadge
        provider={defaultNewSessionModel.provider}
        model={defaultNewSessionModel.modelId ?? undefined}
      />
    </span>
  );
}

/**
 * Floating Action Button for quick session creation.
 * Desktop-only feature that appears in the right margin when there's room.
 */
export function FloatingActionButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const clientSummarySourceKey = useClientSummarySourceKey();
  const fabDraftKey = useMemo(
    () => createFabDraftKey(clientSummarySourceKey),
    [clientSummarySourceKey],
  );
  const fabVisibility = useFabVisibility();
  const { floatingActionButtonEnabled } = useFloatingActionButtonEnabled();
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage, draftControls] = useDraftPersistence(fabDraftKey);
  const {
    speechState,
    interimTranscript,
    setInterimTranscript,
    interimTranscriptRef,
    speechPending,
    setSpeechPending,
    speechPendingRef,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    speechInsertionRangesRef,
    pendingSpeechRetargetRef,
    clearPendingSpeechFinal,
    noteSpeechDraftEdit,
    restorePendingTextareaSelection,
  } = useComposerSpeechState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingSpeechDeliveryRef = useRef<string | null>(null);
  // Only mutable provisional speech uses the textarea mirror. Capture and
  // post-capture status live with the mic so the real draft and caret stay
  // untouched while transcription is pending.
  const { interimDisplayTranscript, interimInsertion } =
    getSpeechInterimPreview(
      message,
      interimTranscript,
      speechInsertionRangeRef.current,
    );

  // Extract projectId from current URL if we're in a project context
  const projectIdFromUrl = extractProjectIdFromPath(location.pathname);

  // Update recent project when navigating to a project page
  useEffect(() => {
    if (projectIdFromUrl) {
      setRecentProjectId(projectIdFromUrl);
    }
  }, [projectIdFromUrl]);

  // Focus textarea when expanded
  useEffect(() => {
    if (isExpanded) {
      textareaRef.current?.focus();
      voiceButtonRef.current?.prewarm();
    }
  }, [isExpanded]);

  useLayoutEffect(() => {
    restorePendingTextareaSelection(message, textareaRef.current);
  }, [message]);

  // Close on click outside
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const handleSubmit = useCallback(
    (messageOverride?: unknown) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      const voice = voiceButtonRef.current;
      if (
        override === undefined &&
        (voice?.isListening === true || speechPendingRef.current !== null)
      ) {
        pendingSpeechDeliveryRef.current = getSpeechVisibleDraftText(
          draftControls.getDraft(),
          interimTranscriptRef.current,
          speechInsertionRangeRef.current,
        );
        if (voice?.isListening) voice.stopAndFinalize();
        return;
      }
      const trimmed = (override ?? message).trim();
      if (!trimmed) return;

      // Store the message for NewSessionForm to pick up
      setNewSessionPrefill(clientSummarySourceKey, trimmed);
      draftControls.clearDraft();
      setIsExpanded(false);

      // Navigate to new session page
      if (projectIdFromUrl) {
        navigate(
          `${basePath}/new-session?projectId=${encodeURIComponent(projectIdFromUrl)}`,
        );
        return;
      }

      navigate(`${basePath}/new-session`);
    },
    [
      message,
      projectIdFromUrl,
      navigate,
      draftControls,
      basePath,
      clientSummarySourceKey,
    ],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
    if (e.key === "Enter" && e.nativeEvent.isComposing) return;

    if (
      handleSpeechEscapeKey(e, {
        speechPending,
        voice: voiceButtonRef.current,
        cancelTranscription: handleCancelTranscription,
      })
    ) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setIsExpanded(false);
    }
    // Shift+Enter naturally adds newline (default behavior)
  };

  const handleButtonClick = useCallback(() => {
    setIsExpanded(true);
  }, []);

  // Voice input handlers
  // The floating composer submits a pending delivery only when the cycle
  // ends completed, from its own pending-state handler (plan 178 F1), so the
  // shared hook's settled flag, attribution and delivery run are inert here.
  const unusedSpeechDeliverySettledRef = useRef(false);
  const noSpeechDeliveryStep = useCallback(() => {}, []);
  const dropPendingSpeechDelivery = useCallback(() => {
    pendingSpeechDeliveryRef.current = null;
  }, []);
  const {
    handleListeningStart,
    handleSpeechSelectionTarget,
    clearSpeechSelectionTarget,
    handleVoiceTranscript,
    handleListeningStop,
    handleInterimTranscript,
  } = useComposerSpeechHandlers({
    speechState,
    draftControls,
    textareaRef,
    voiceButtonRef,
    pendingSpeechDeliveryRef,
    pendingSpeechDeliverySettledRef: unusedSpeechDeliverySettledRef,
    noteSpeechAttribution: noSpeechDeliveryStep,
    maybeRunPendingSpeechDelivery: noSpeechDeliveryStep,
    abandonPendingDelivery: dropPendingSpeechDelivery,
    onSmartTurnSend: handleSubmit,
  });
  // Select, pointer-up and key-up are manual caret moves here (plan 178 F4).
  const handleManualSpeechSelection = useCallback(
    () => handleSpeechSelectionTarget(true),
    [handleSpeechSelectionTarget],
  );

  useEffect(() => clearPendingSpeechFinal, []);

  const handleSpeechSelectionClick = useCallback(() => {
    window.setTimeout(() => handleSpeechSelectionTarget(true), 0);
  }, [handleSpeechSelectionTarget]);

  const handlePendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      speechPendingRef.current = kind;
      if (kind === "listening") handleSpeechSelectionTarget();
      if (kind === null) {
        // Active recording finished: forget its target so completed targets do
        // not accumulate (see MessageInput).
        const targetId = activeSpeechTargetIdRef.current;
        if (targetId) {
          speechInsertionRangesRef.current.delete(targetId);
        }
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        pendingSpeechRetargetRef.current = null;
        const pendingDelivery = pendingSpeechDeliveryRef.current;
        pendingSpeechDeliveryRef.current = null;
        if (settlement === "completed" && pendingDelivery !== null) {
          handleSubmit(pendingDelivery);
        }
      }
      setSpeechPending(kind);
    },
    [handleSpeechSelectionTarget, handleSubmit],
  );

  // Cancel a pending transcription/finalization. The provider discards the
  // in-flight result (keeping committed text); here we drop the pending speech
  // target.
  const handleCancelTranscription = useCallback(() => {
    voiceButtonRef.current?.cancelProcessing();
    clearPendingSpeechFinal();
    const targetId = activeSpeechTargetIdRef.current;
    if (targetId) {
      speechInsertionRangesRef.current.delete(targetId);
    }
    speechInsertionRangeRef.current = null;
    activeSpeechTargetIdRef.current = null;
    pendingSpeechRetargetRef.current = null;
    pendingSpeechDeliveryRef.current = null;
    setSpeechPending(null);
    setInterimTranscript("");
  }, []);

  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      const draft = draftControls.getDraft();
      return {
        draftKey: fabDraftKey,
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
        textBeforeCursor: textBeforeSpeechCursor(
          draft,
          speechInsertionRangeRef.current,
          textareaRef.current,
        ),
      };
    }, [draftControls, fabDraftKey]);

  // Hide (but don't unmount) when not visible, on new-session page, or while
  // supervising an active session. On session pages it duplicates the sidebar
  // new-session affordance and competes with the real composer.
  // This preserves expanded state and draft across navigation
  const isSessionPage = /\/sessions\/[^/]+/.test(location.pathname);
  const isHidden =
    !floatingActionButtonEnabled ||
    !fabVisibility ||
    location.pathname.endsWith("/new-session") ||
    isSessionPage;

  const { right, bottom, maxWidth } = fabVisibility ?? {
    right: 24,
    bottom: 80,
    maxWidth: 200,
  };

  return (
    <div
      ref={containerRef}
      className={`fab-container ${isExpanded ? "fab-expanded" : "fab-collapsed"}`}
      style={{
        right: `${right}px`,
        bottom: `${bottom}px`,
        width: `${maxWidth}px`, // Always use maxWidth so button stays centered
        display: isHidden ? "none" : undefined,
      }}
    >
      {/* Input panel appears above the button */}
      {isExpanded && (
        <div className="fab-input-panel">
          <DraftSyncNotice draftKey={fabDraftKey} />
          <SpeechDraftField
            interimDisplayTranscript={interimDisplayTranscript}
            interimInsertion={interimInsertion}
            interimTranscript={interimTranscript}
          >
            <textarea
              data-draft-key={fabDraftKey}
              ref={textareaRef}
              value={message}
              onChange={(e) => {
                const nextMessage = e.target.value;
                noteSpeechDraftEdit(message, nextMessage);
                handleSpeechSelectionTarget(true, nextMessage);
                setMessage(nextMessage);
              }}
              onKeyDown={handleKeyDown}
              onSelect={handleManualSpeechSelection}
              onPointerUp={handleManualSpeechSelection}
              onClick={handleSpeechSelectionClick}
              onKeyUp={handleManualSpeechSelection}
              onCut={clearSpeechSelectionTarget}
              onCopy={clearSpeechSelectionTarget}
              onPaste={clearSpeechSelectionTarget}
              placeholder={t("fabPlaceholder")}
              className="fab-textarea"
              rows={3}
            />
          </SpeechDraftField>
          <div className="fab-input-toolbar">
            <FloatingComposerModelChip />
            <VoiceInputButton
              ref={voiceButtonRef}
              onTranscript={handleVoiceTranscript}
              onInterimTranscript={handleInterimTranscript}
              onListeningStart={handleListeningStart}
              onListeningStop={handleListeningStop}
              onPendingSpeechChange={handlePendingSpeechChange}
              getTranscriptionContext={getTranscriptionContext}
              className="toolbar-button"
            />
            <button
              type="button"
              className="fab-submit"
              onClick={handleSubmit}
              disabled={
                !(message.trim() || speechPending !== null || interimTranscript)
              }
              aria-label={t("fabGoToNewSession")}
            >
              ↵
            </button>
          </div>
        </div>
      )}
      {/* FAB button always at the bottom */}
      <button
        type="button"
        className={`fab-button ${isExpanded ? "fab-button-active" : ""}`}
        onClick={isExpanded ? () => setIsExpanded(false) : handleButtonClick}
        aria-label={isExpanded ? t("fabClose") : t("fabNewSession")}
      >
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
          className={isExpanded ? "fab-icon-rotated" : ""}
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
