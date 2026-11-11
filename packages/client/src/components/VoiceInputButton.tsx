import {
  VOICE_INPUT_CAPABILITY,
  SERVER_CAPABILITIES,
  hasServerCapabilityAdvertisement,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  type ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useModelSettings } from "../hooks/useModelSettings";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useSpeechSourceRuntime } from "../hooks/useSpeechSourceRuntime";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useVersion } from "../hooks/useVersion";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { type MessageKey, useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { setSpeechCaptureActivity } from "../lib/speechCaptureActivity";
import { setMicTitleActivity } from "../lib/micTitleActivity";
import type { SpeechCommitOutcome } from "../lib/speechDraftTransaction";
import {
  armSpeechFollowUp,
  cancelSpeechFollowUp,
  claimSpeechFollowUp,
  getSpeechFollowUpSnapshot,
  noteSpeechFollowUpActivity,
  releaseSpeechFollowUpOwner,
  subscribeSpeechFollowUp,
} from "../lib/speechFollowUp";
import {
  DEFAULT_SPEECH_METHOD,
  canSpeechMethodStream,
  getCompactSpeechMethodLabel,
  getSpeechMethodCapabilities,
  isBrowserNativeSpeechAvailable,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import {
  isParakeetModelBackend,
  reconcileParakeetBackendForModel,
  requestedParakeetModel,
} from "../lib/speechProviders/parakeetModels";
import {
  clearSpeechWaveform,
  publishSpeechWaveformSamples,
} from "../lib/speechWaveform";
import styles from "./VoiceInputButton.module.css";
import { SpeechWaveform } from "./SpeechWaveform";
import type {
  SpeechProviderStatus,
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import { MicrophoneGlyph } from "./MicrophoneIcon";

const SPEECH_STATUS_MESSAGE_KEYS: Record<SpeechProviderStatus, MessageKey> = {
  idle: "speechReadyStatus",
  starting: "speechStartingStatus",
  listening: "speechSpeakNowStatus",
  receiving: "speechListeningPlaceholder",
  processing: "speechTranscribingPlaceholder",
  finalizing: "speechFinalizingPlaceholder",
  reconnecting: "speechStartingStatus",
  error: "speechErrorStatus",
};

/**
 * A cancellable in-progress speech state the composer uses for lifecycle:
 * `listening` during active capture, `transcribing` for a batch wait, and
 * `finalizing` for a streaming flush. Already-committed finals stay in the
 * draft when the remaining work is cancelled.
 */
export type SpeechPendingKind =
  | "starting"
  | "listening"
  | "transcribing"
  | "finalizing";
export type SpeechCycleSettlement = "completed" | "failed";

export interface VoiceInputButtonRef {
  /** Stop listening and return any pending interim text */
  stopAndFinalize: () => string;
  /** Toggle listening on/off */
  toggle: () => void;
  /** Abandon an in-flight post-capture transcription; late result is discarded. */
  cancelProcessing: () => void;
  /** Speculatively warm capture resources before the first click. */
  prewarm: () => void;
  /** Keep cumulative provider finals after a newly selected insertion target. */
  beginInsertionBoundary: () => void;
  /** Keep listening briefly after a speech-triggered Smart Turn send. */
  continueAfterSpeechSend: () => void;
  /** Whether currently listening */
  isListening: boolean;
  /** Whether voice input is available (supported and enabled) */
  isAvailable: boolean;
}

interface VoiceInputButtonProps {
  /** Callback when final transcript is received - appends to input */
  onTranscript: (
    text: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => SpeechCommitOutcome | undefined;
  /** Callback for interim results - shows live preview */
  onInterimTranscript?: (text: string) => void;
  /** Callback when listening starts - useful for focusing input */
  onListeningStart?: () => void;
  /**
   * Callback when the user explicitly stops active capture. Return true when
   * the composer committed its visible provisional text and later provider
   * revisions for that capture must be ignored.
   */
  onListeningStop?: () => boolean | undefined;
  /** Callback when a post-capture pending state (transcribing/finalizing) starts or ends. */
  onPendingSpeechChange?: (
    kind: SpeechPendingKind | null,
    settlement?: SpeechCycleSettlement,
  ) => void;
  /** Callback when one batch transcription target reaches a terminal state. */
  onTranscriptionSettled?: (settlement: SpeechTranscriptionSettlement) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
  /** Speech method selected by an enclosing in-session selector. */
  speechMethod?: SpeechMethodId | null;
  /** Context attached to YA-server transcription requests. */
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
  /** Smart Turn settings for streaming STT backends that support it. */
  smartTurn?: SpeechSmartTurnSettings;
  /** Publish real mic samples for the enclosing session-toolbar waveform. */
  showWaveform?: boolean;
  /** Render the live waveform inside this button's touch target. */
  inlineWaveform?: boolean;
  /** Reports whether this button currently has a real inline waveform. */
  onWaveformActiveChange?: (active: boolean) => void;
}

/**
 * Microphone button for the selected speech provider. While an enabled speech
 * context is still resolving, it remains visible but disabled so a reserved
 * toolbar slot never turns into an unexplained gap.
 */
export const VoiceInputButton = forwardRef(function VoiceInputButton(
  {
    onTranscript,
    onInterimTranscript,
    onListeningStart,
    onListeningStop,
    onPendingSpeechChange,
    onTranscriptionSettled,
    disabled,
    className = "",
    speechMethod: selectedSpeechMethod,
    getTranscriptionContext,
    smartTurn,
    showWaveform = false,
    inlineWaveform = false,
    onWaveformActiveChange,
  }: VoiceInputButtonProps,
  ref: ForwardedRef<VoiceInputButtonRef>,
) {
  const { t } = useI18n();
  const {
    voiceInputEnabled,
    speechMethod: storedSpeechMethod,
    hasStoredSpeechMethod,
    speechSmartTurnSettings,
    parakeetSpeechModel,
    whisperSpeechModel,
  } = useModelSettings();
  const { version: versionInfo, loading: versionLoading } = useVersion();
  const recentModels = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.localSpeechModelSelection.name,
  );
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();
  const basePath = useRemoteBasePath();
  const {
    relayTransport,
    relayedServerSpeechAvailable,
    openRelayedSpeechSocket,
  } = useSpeechSourceRuntime();
  const {
    keepMicWarm,
    micDeviceId,
    reducePlayback,
    unspokenPunctuation,
    followUpListenMs,
  } = useSpeechCaptureSettings();
  const serverVoiceEnabled =
    !hasServerCapabilityAdvertisement(versionInfo) ||
    serverHasCapability(versionInfo, VOICE_INPUT_CAPABILITY);
  const speechMethod = useMemo(() => {
    const resolved =
      selectedSpeechMethod !== undefined
        ? selectedSpeechMethod
        : resolveSpeechMethod(
            storedSpeechMethod,
            versionInfo?.voiceBackends,
            hasStoredSpeechMethod,
            {
              directXaiAvailable: hasBrowserXaiSttApiKey,
              browserNativeAvailable: isBrowserNativeSpeechAvailable(),
            },
          );
    if (resolved === null) return null;
    // Never pair a Parakeet model with a backend that can't run it: a NeMo-only
    // model (rnnt-1.1b) routes to ya-nemo, not ya-parakeet — even if a backend
    // flap left the selection on ya-parakeet. Keeps the chosen model.
    return reconcileParakeetBackendForModel(
      resolved,
      parakeetSpeechModel,
      versionInfo?.voiceBackends ?? [],
    ) as SpeechMethodId;
  }, [
    selectedSpeechMethod,
    storedSpeechMethod,
    versionInfo?.voiceBackends,
    hasStoredSpeechMethod,
    hasBrowserXaiSttApiKey,
    parakeetSpeechModel,
  ]);
  const serverStreaming =
    speechMethod !== null &&
    canSpeechMethodStream({
      methodId: speechMethod,
      serverCapabilities: versionInfo?.voiceBackendCapabilities,
      relayTransport,
      relayedServerSpeechAvailable,
    });
  const supportsSmartTurn =
    speechMethod !== null &&
    serverStreaming &&
    getSpeechMethodCapabilities(
      speechMethod,
      versionInfo?.voiceBackendCapabilities,
    ).smartTurn === true;
  const activeSmartTurn = supportsSmartTurn
    ? (smartTurn ?? speechSmartTurnSettings)
    : undefined;
  const followUpEnabled =
    activeSmartTurn?.enabled === true && followUpListenMs > 0;
  const viewportWidth = useViewportWidth();

  // Show status text on desktop with sufficient width
  const showStatusText =
    !hasCoarsePointer() && viewportWidth >= 600 && voiceInputEnabled;
  const suppressResultsAfterVisibleStopRef = useRef(false);
  const speechCaptureOwnerRef = useRef<object>({});
  const temporarilyKeepMicWarm = useCallback(() => {
    const current = getSpeechFollowUpSnapshot();
    return (
      (followUpEnabled || current.active) &&
      (current.owner === null ||
        current.owner === speechCaptureOwnerRef.current)
    );
  }, [followUpEnabled]);

  const handleResult = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      if (suppressResultsAfterVisibleStopRef.current) return;
      if (transcript.trim()) {
        noteSpeechFollowUpActivity(speechCaptureOwnerRef.current);
      }
      const outcome = onTranscript(transcript, metadata);
      if (
        outcome === "wait" ||
        outcome === "cancelled" ||
        outcome === "send-held" ||
        outcome === "send-unhandled"
      ) {
        cancelSpeechFollowUp(speechCaptureOwnerRef.current);
      }
    },
    [onTranscript],
  );

  const handleInterim = useCallback(
    (transcript: string) => {
      if (transcript.trim()) {
        noteSpeechFollowUpActivity(speechCaptureOwnerRef.current);
      }
      onInterimTranscript?.(transcript);
    },
    [onInterimTranscript],
  );

  const {
    isSupported,
    isListening,
    status,
    toggleListening,
    stopListening,
    startListening,
    cancelProcessing,
    prewarm,
    beginInsertionBoundary,
    error,
    interimTranscript,
  } = useSpeechRecognition({
    speechMethod,
    basePath,
    getTranscriptionContext,
    serverStreaming,
    smartTurn: activeSmartTurn,
    keepMicWarm,
    temporarilyKeepMicWarm,
    micDeviceId,
    reducePlayback,
    unspokenPunctuation,
    onAudioSamples: showWaveform ? publishSpeechWaveformSamples : undefined,
    parakeetModel:
      speechMethod !== null && isParakeetModelBackend(speechMethod)
        ? requestedParakeetModel(parakeetSpeechModel, recentModels)
        : undefined,
    whisperModel:
      speechMethod === "ya-whisper" && recentModels
        ? whisperSpeechModel?.trim() || undefined
        : undefined,
    openRelayedSpeechSocket,
    onResult: handleResult,
    onInterimResult: handleInterim,
    onTranscriptionSettled,
  });
  const isStarting = status === "starting";
  const isCaptureStarting = isStarting || status === "reconnecting";
  const isCapturing =
    isListening ||
    status === "listening" ||
    (status === "receiving" && isListening);
  const isFinalizing = status === "finalizing";
  const isBusy = isCaptureStarting || isFinalizing;
  const isActive = isCapturing || isBusy;
  const isPressed = isCapturing || isStarting || status === "reconnecting";
  const isProcessing = status === "processing";
  const speechActivityDetected = status === "receiving";
  const wasCapturingRef = useRef(false);
  const previousPendingKindRef = useRef<SpeechPendingKind | null>(null);
  const onPendingSpeechChangeRef = useRef(onPendingSpeechChange);
  onPendingSpeechChangeRef.current = onPendingSpeechChange;
  const followUpSnapshot = useSyncExternalStore(
    subscribeSpeechFollowUp,
    getSpeechFollowUpSnapshot,
    getSpeechFollowUpSnapshot,
  );
  const compactSpeechMethodLabel =
    speechMethod === null ? "STT" : getCompactSpeechMethodLabel(speechMethod);
  const speechCapturePhase = isCapturing
    ? "capturing"
    : isCaptureStarting
      ? "starting"
      : null;
  const [retainWaveformSlot, setRetainWaveformSlot] = useState(false);
  useEffect(() => {
    if (isCapturing) {
      setRetainWaveformSlot(true);
      return;
    }
    const timer = setTimeout(() => setRetainWaveformSlot(false), 300);
    return () => clearTimeout(timer);
  }, [isCapturing]);
  const waveformVisible =
    showWaveform &&
    speechMethod !== null &&
    speechMethod !== DEFAULT_SPEECH_METHOD &&
    (isCapturing || (followUpEnabled && retainWaveformSlot && !error));
  const showPostCaptureStatus =
    isProcessing || (isFinalizing && !waveformVisible);
  // Keep the parent informed for insertion-target and keyboard-cancel
  // lifecycle. Visual capture/processing status stays with this mic control;
  // the composer never inserts it into the textarea mirror.
  const pendingKind: SpeechPendingKind | null = isCaptureStarting
    ? "starting"
    : isProcessing
      ? "transcribing"
      : isFinalizing
        ? "finalizing"
        : isCapturing
          ? "listening"
          : null;
  const isAvailable =
    speechMethod !== null &&
    isSupported &&
    voiceInputEnabled &&
    serverVoiceEnabled;
  const unavailableLabel = versionLoading
    ? t("speechStartingStatus")
    : t("speechUnavailableStatus");

  // Translate provider lifecycle states into familiar dictation language.
  // "reconnecting" is an internal recognizer restart, not a network failure.
  const statusLabel = error || t(SPEECH_STATUS_MESSAGE_KEYS[status]);

  const endFollowUpListening = useCallback(() => {
    stopListening();
  }, [stopListening]);

  const handleUserToggle = useCallback(() => {
    if (isActive) {
      suppressResultsAfterVisibleStopRef.current =
        suppressResultsAfterVisibleStopRef.current ||
        onListeningStop?.() === true;
      if (
        followUpSnapshot.active &&
        (followUpSnapshot.owner === null ||
          followUpSnapshot.owner === speechCaptureOwnerRef.current)
      ) {
        cancelSpeechFollowUp(speechCaptureOwnerRef.current);
        return;
      }
      toggleListening();
      return;
    }
    suppressResultsAfterVisibleStopRef.current = false;
    onListeningStart?.();
    toggleListening();
  }, [
    followUpSnapshot.active,
    followUpSnapshot.owner,
    isActive,
    onListeningStart,
    onListeningStop,
    toggleListening,
  ]);

  // Expose methods and state to parent
  useImperativeHandle(
    ref,
    () => ({
      stopAndFinalize: () => {
        const pending = interimTranscript;
        if (
          followUpSnapshot.active &&
          (followUpSnapshot.owner === null ||
            followUpSnapshot.owner === speechCaptureOwnerRef.current)
        ) {
          cancelSpeechFollowUp(speechCaptureOwnerRef.current);
          return pending;
        }
        if (isActive) {
          stopListening();
        }
        return pending;
      },
      toggle: handleUserToggle,
      cancelProcessing,
      prewarm,
      beginInsertionBoundary,
      continueAfterSpeechSend: () => {
        if (!followUpEnabled) return;
        armSpeechFollowUp(
          followUpListenMs,
          speechCaptureOwnerRef.current,
          endFollowUpListening,
        );
      },
      isListening: isActive,
      isAvailable,
    }),
    [
      interimTranscript,
      followUpEnabled,
      followUpListenMs,
      followUpSnapshot.active,
      followUpSnapshot.owner,
      isActive,
      cancelProcessing,
      beginInsertionBoundary,
      endFollowUpListening,
      handleUserToggle,
      prewarm,
      stopListening,
      isAvailable,
    ],
  );

  // Clear interim when listening stops
  useEffect(() => {
    if (!isCapturing && interimTranscript) {
      onInterimTranscript?.("");
    }
  }, [isCapturing, interimTranscript, onInterimTranscript]);

  useEffect(() => {
    if (wasCapturingRef.current && !isCapturing) {
      clearSpeechWaveform();
    }
    wasCapturingRef.current = isCapturing;
    return () => {
      if (isCapturing) clearSpeechWaveform();
    };
  }, [isCapturing]);

  useEffect(
    () => () => {
      setSpeechCaptureActivity(speechCaptureOwnerRef.current, null);
      setMicTitleActivity(speechCaptureOwnerRef.current, null);
      releaseSpeechFollowUpOwner(speechCaptureOwnerRef.current);
    },
    [],
  );

  // Must run before the follow-up start effect below: settling a finished
  // capture lets the composer forget its insertion target, so it has to
  // happen before `onListeningStart` creates the follow-up capture's target.
  // Effects run in declaration order within one commit.
  useEffect(() => {
    const previousKind = previousPendingKindRef.current;
    if (previousKind === pendingKind) return;
    const settlement =
      previousKind !== null && pendingKind === null
        ? status === "error" || error
          ? "failed"
          : "completed"
        : undefined;
    previousPendingKindRef.current = pendingKind;
    if (settlement === "failed") {
      cancelSpeechFollowUp(speechCaptureOwnerRef.current);
    }
    if (settlement) {
      onPendingSpeechChange?.(pendingKind, settlement);
    } else {
      onPendingSpeechChange?.(pendingKind);
    }
  }, [error, pendingKind, onPendingSpeechChange, status]);

  useEffect(() => {
    if (!followUpSnapshot.active || !followUpEnabled) return;
    const owner = speechCaptureOwnerRef.current;
    if (followUpSnapshot.owner !== null && followUpSnapshot.owner !== owner) {
      return;
    }
    if (!claimSpeechFollowUp(owner, endFollowUpListening)) return;
    if (status === "receiving") {
      noteSpeechFollowUpActivity(owner);
      return;
    }
    if (followUpSnapshot.expired) {
      if (status === "idle" || status === "error") {
        cancelSpeechFollowUp(owner);
      }
      return;
    }
    if (status === "idle" && !disabled && isAvailable) {
      onListeningStart?.();
      startListening();
    }
  }, [
    disabled,
    endFollowUpListening,
    followUpEnabled,
    followUpSnapshot.active,
    followUpSnapshot.expired,
    followUpSnapshot.owner,
    isAvailable,
    onListeningStart,
    startListening,
    status,
  ]);

  useEffect(() => {
    if (
      followUpEnabled ||
      followUpSnapshot.owner !== speechCaptureOwnerRef.current
    ) {
      return;
    }
    cancelSpeechFollowUp(speechCaptureOwnerRef.current);
  }, [followUpEnabled, followUpSnapshot.owner]);

  useEffect(() => {
    setSpeechCaptureActivity(
      speechCaptureOwnerRef.current,
      reducePlayback ? speechCapturePhase : null,
    );
  }, [reducePlayback, speechCapturePhase]);

  useEffect(() => {
    setMicTitleActivity(speechCaptureOwnerRef.current, speechCapturePhase);
  }, [speechCapturePhase]);

  useEffect(
    () => () => {
      const hadPendingSpeech = previousPendingKindRef.current !== null;
      previousPendingKindRef.current = null;
      onPendingSpeechChangeRef.current?.(
        null,
        hadPendingSpeech ? "failed" : undefined,
      );
    },
    [],
  );

  useEffect(() => {
    const inlineWaveformActive = inlineWaveform && waveformVisible;
    onWaveformActiveChange?.(inlineWaveformActive);
    return () => {
      if (inlineWaveformActive) onWaveformActiveChange?.(false);
    };
  }, [inlineWaveform, onWaveformActiveChange, waveformVisible]);

  // A disabled setting or a host without speech support removes the control.
  // Provider discovery leaves a disabled Mic in place until it can run.
  if (!voiceInputEnabled || !serverVoiceEnabled) {
    return null;
  }

  // Determine status class for styling
  const statusClass =
    status === "error" || error
      ? styles.statusError
      : status === "reconnecting"
        ? "status-reconnecting"
        : status === "finalizing"
          ? "status-finalizing"
          : status === "processing"
            ? "status-processing"
            : status === "starting"
              ? "status-starting"
              : status === "receiving"
                ? "status-receiving"
                : status === "listening"
                  ? "status-listening"
                  : "";

  const button = (
    <button
      type="button"
      className={`${styles.voiceInputButton} ${styles.button} ${isCaptureStarting ? styles.starting : ""} ${isCapturing ? styles.listening : ""} ${inlineWaveform ? styles.inlineWaveform : ""} ${className}`}
      data-listening={isCapturing || undefined}
      data-voice-input-button
      data-inline-waveform={inlineWaveform || undefined}
      data-speech-method={speechMethod ?? undefined}
      data-speech-phase={speechCapturePhase ?? "idle"}
      onClick={handleUserToggle}
      disabled={disabled || !isAvailable}
      title={
        error
          ? error
          : !isAvailable
            ? unavailableLabel
            : isFinalizing
              ? statusLabel
              : isActive
                ? t("voiceInputStop" as never)
                : t("voiceInputStart" as never)
      }
      aria-label={
        !isAvailable
          ? unavailableLabel
          : isFinalizing
            ? statusLabel
            : isActive
              ? t("voiceInputStopLabel" as never)
              : t("voiceInputStartLabel" as never)
      }
      aria-pressed={isPressed}
      data-speech-streaming={serverStreaming}
    >
      <span className={styles.backendLabel} aria-hidden="true">
        {compactSpeechMethodLabel}
      </span>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={
          isCapturing
            ? `${styles.voiceInputRecording} ${speechActivityDetected ? styles["is-speech-active"] : ""}`
            : undefined
        }
        data-voice-input-recording={isCapturing || undefined}
        data-is-speech-active={
          (isCapturing && speechActivityDetected) || undefined
        }
      >
        {isCapturing && (
          <circle
            cx="12"
            cy="12"
            r="11.5"
            fill="currentColor"
            className={styles.voiceInputLevelDisc}
          />
        )}
        <g
          className={isCapturing ? styles.voiceInputLevelGlyph : undefined}
          stroke="currentColor"
          strokeWidth="2"
        >
          <MicrophoneGlyph />
        </g>
      </svg>
      {inlineWaveform && waveformVisible && <SpeechWaveform />}
    </button>
  );

  // Active-capture status text remains a wide-screen enhancement. Post-capture
  // waits and errors always remain visible beside the mic, including on phones:
  // the textarea must stay entirely real/editable while those states are
  // pending, so the toolbar is their single visual home.
  if (
    (showStatusText && isActive && !waveformVisible) ||
    showPostCaptureStatus ||
    error
  ) {
    return (
      <div
        className={`${styles.voiceInputContainer} ${isCapturing ? styles.listening : ""} ${statusClass}`}
        data-listening={isCapturing || undefined}
      >
        {button}
        <span
          className={styles.voiceInputStatus}
          data-voice-input-status
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>
    );
  }

  return button;
});
