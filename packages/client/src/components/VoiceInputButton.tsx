import {
  type ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
} from "react";
import { useModelSettings } from "../hooks/useModelSettings";
import {
  SPEECH_STATUS_LABELS,
  useSpeechRecognition,
} from "../hooks/useSpeechRecognition";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { hasCoarsePointer } from "../lib/deviceDetection";

export interface VoiceInputButtonRef {
  /** Stop listening and return any pending interim text */
  stopAndFinalize: () => string;
  /** Toggle listening on/off */
  toggle: () => void;
  /** Whether currently listening */
  isListening: boolean;
  /** Whether voice input is available (supported and enabled) */
  isAvailable: boolean;
}

interface VoiceInputButtonProps {
  /** Callback when final transcript is received - appends to input */
  onTranscript: (text: string) => void;
  /** Callback for interim results - shows live preview */
  onInterimTranscript?: (text: string) => void;
  /** Callback when listening starts - useful for focusing input */
  onListeningStart?: () => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
}

/**
 * Microphone button for voice input using Web Speech API.
 * Only renders when:
 * 1. Web Speech API is supported (Chrome/Edge)
 * 2. Voice input is enabled in settings
 */
export const VoiceInputButton = forwardRef(function VoiceInputButton(
  {
    onTranscript,
    onInterimTranscript,
    onListeningStart,
    disabled,
    className = "",
  }: VoiceInputButtonProps,
  ref: ForwardedRef<VoiceInputButtonRef>,
) {
  const { voiceInputEnabled } = useModelSettings();
  const viewportWidth = useViewportWidth();

  // Show status text on desktop with sufficient width
  const showStatusText =
    !hasCoarsePointer() && viewportWidth >= 600 && voiceInputEnabled;

  const handleResult = useCallback(
    (transcript: string) => {
      onTranscript(transcript);
    },
    [onTranscript],
  );

  const handleInterim = useCallback(
    (transcript: string) => {
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
    error,
    interimTranscript,
  } = useSpeechRecognition({
    onResult: handleResult,
    onInterimResult: handleInterim,
  });

  const isAvailable = isSupported && voiceInputEnabled;

  // Get display text for status
  const statusLabel = error || SPEECH_STATUS_LABELS[status];

  // Expose methods and state to parent
  useImperativeHandle(
    ref,
    () => ({
      stopAndFinalize: () => {
        const pending = interimTranscript;
        if (isListening) {
          stopListening();
        }
        return pending;
      },
      toggle: toggleListening,
      isListening,
      isAvailable,
    }),
    [
      interimTranscript,
      isListening,
      stopListening,
      toggleListening,
      isAvailable,
    ],
  );

  // Clear interim when listening stops
  useEffect(() => {
    if (!isListening && interimTranscript) {
      onInterimTranscript?.("");
    }
  }, [isListening, interimTranscript, onInterimTranscript]);

  // Handle click - toggle listening and notify when starting
  const handleClick = useCallback(() => {
    const wasListening = isListening;
    toggleListening();
    // If we weren't listening, we're now starting - notify parent
    if (!wasListening) {
      onListeningStart?.();
    }
  }, [isListening, toggleListening, onListeningStart]);

  // Don't render if not supported or disabled in settings
  if (!isAvailable) {
    return null;
  }

  // Determine status class for styling
  const statusClass =
    status === "error" || error
      ? "status-error"
      : status === "reconnecting"
        ? "status-reconnecting"
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
      className={`voice-input-button ${isListening ? "listening" : ""} ${className}`}
      onClick={handleClick}
      disabled={disabled}
      title={
        error
          ? error
          : isListening
            ? "Stop voice input (Ctrl+Space)"
            : "Start voice input (Ctrl+Space)"
      }
      aria-label={isListening ? "Stop voice input" : "Start voice input"}
      aria-pressed={isListening}
    >
      {isListening ? (
        // Recording indicator - animated bars
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="voice-input-recording"
        >
          <rect x="4" y="8" width="3" height="8" rx="1" className="bar bar-1" />
          <rect
            x="10.5"
            y="5"
            width="3"
            height="14"
            rx="1"
            className="bar bar-2"
          />
          <rect
            x="17"
            y="8"
            width="3"
            height="8"
            rx="1"
            className="bar bar-3"
          />
        </svg>
      ) : (
        // Microphone icon
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );

  // If showing status text, wrap in container; otherwise just return the button
  if (showStatusText && isListening) {
    return (
      <div
        className={`voice-input-container ${isListening ? "listening" : ""} ${statusClass}`}
      >
        {button}
        <span className="voice-input-status">{statusLabel}</span>
      </div>
    );
  }

  return button;
});
