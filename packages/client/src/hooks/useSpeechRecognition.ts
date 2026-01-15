import { useCallback, useEffect, useRef, useState } from "react";
import { computeSpeechDelta } from "../lib/speechRecognition";

// Web Speech API types (not included in lib.dom by default)
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error:
    | "no-speech"
    | "aborted"
    | "audio-capture"
    | "network"
    | "not-allowed"
    | "service-not-allowed"
    | "bad-grammar"
    | "language-not-supported";
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

// Extend Window interface for vendor-prefixed API
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export interface UseSpeechRecognitionOptions {
  /** Language for recognition (default: browser default) */
  lang?: string;
  /** Callback when final transcript is available */
  onResult?: (transcript: string) => void;
  /** Callback for interim results (live transcription) */
  onInterimResult?: (transcript: string) => void;
  /** Callback when recognition ends */
  onEnd?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

/**
 * Granular status of the speech recognition system.
 * - idle: Not listening
 * - starting: Called start(), waiting for cloud service connection
 * - listening: Connected and listening for speech
 * - receiving: Actively receiving interim results from cloud
 * - reconnecting: Auto-restarting after Chrome's ~60s timeout
 * - error: An error occurred
 */
export type SpeechRecognitionStatus =
  | "idle"
  | "starting"
  | "listening"
  | "receiving"
  | "reconnecting"
  | "error";

/** Human-readable labels for each status */
export const SPEECH_STATUS_LABELS: Record<SpeechRecognitionStatus, string> = {
  idle: "Ready",
  starting: "Connecting...",
  listening: "Listening...",
  receiving: "Receiving...",
  reconnecting: "Reconnecting...",
  error: "Error",
};

export interface UseSpeechRecognitionReturn {
  /** Whether the Web Speech API is supported */
  isSupported: boolean;
  /** Whether currently listening */
  isListening: boolean;
  /** Granular status of the recognition system */
  status: SpeechRecognitionStatus;
  /** Current interim transcript (updates in real-time) */
  interimTranscript: string;
  /** Start listening */
  startListening: () => void;
  /** Stop listening */
  stopListening: () => void;
  /** Toggle listening state */
  toggleListening: () => void;
  /** Last error message */
  error: string | null;
}

/**
 * Get the SpeechRecognition constructor if available.
 */
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Hook for using the Web Speech Recognition API.
 * Only works in Chrome/Edge browsers.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const { lang, onResult, onInterimResult, onEnd, onError } = options;

  const [isSupported] = useState(() => !!getSpeechRecognition());
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<SpeechRecognitionStatus>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isStoppingRef = useRef(false);
  // Track time of last result to detect stale connections
  const lastResultTimeRef = useRef<number>(0);
  // Timer to transition from "receiving" back to "listening" after silence
  const receivingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Track the last final transcript to compute deltas on mobile
  // Mobile Chrome marks cumulative results as isFinal, so we need to dedupe
  const lastFinalTranscriptRef = useRef<string>("");

  // Store callbacks in refs to avoid recreating recognition on callback changes
  const onResultRef = useRef(onResult);
  const onInterimResultRef = useRef(onInterimResult);
  const onEndRef = useRef(onEnd);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onResultRef.current = onResult;
    onInterimResultRef.current = onInterimResult;
    onEndRef.current = onEnd;
    onErrorRef.current = onError;
  }, [onResult, onInterimResult, onEnd, onError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (receivingTimeoutRef.current) {
        clearTimeout(receivingTimeoutRef.current);
      }
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const startListening = useCallback(() => {
    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) {
      setError("Speech recognition not supported");
      setStatus("error");
      return;
    }

    // Clean up any existing instance
    if (recognitionRef.current) {
      recognitionRef.current.abort();
    }
    if (receivingTimeoutRef.current) {
      clearTimeout(receivingTimeoutRef.current);
      receivingTimeoutRef.current = null;
    }

    setError(null);
    setInterimTranscript("");
    setStatus("starting");
    isStoppingRef.current = false;
    lastFinalTranscriptRef.current = "";
    lastResultTimeRef.current = 0;

    const recognition = new SpeechRecognitionAPI();
    recognitionRef.current = recognition;

    // Configure for streaming
    recognition.continuous = true;
    recognition.interimResults = true;
    if (lang) {
      recognition.lang = lang;
    }

    recognition.onstart = () => {
      setIsListening(true);
      setStatus("listening");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Track that we're actively receiving results
      lastResultTimeRef.current = Date.now();
      setStatus("receiving");

      // Clear any pending timeout to transition back to "listening"
      if (receivingTimeoutRef.current) {
        clearTimeout(receivingTimeoutRef.current);
      }
      // After 1.5s of no results, transition back to "listening"
      receivingTimeoutRef.current = setTimeout(() => {
        setStatus("listening");
        receivingTimeoutRef.current = null;
      }, 1500);

      let interimText = "";
      let latestFinal = "";

      // Find the latest (highest index) final result - on mobile each result
      // is a complete transcript, not a fragment to concatenate
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result) {
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) {
            latestFinal = transcript;
          } else {
            interimText += transcript;
          }
        }
      }

      // Compute delta: what's new since last final result
      const deltaTranscript = computeSpeechDelta(
        latestFinal,
        lastFinalTranscriptRef.current,
      );
      if (deltaTranscript) {
        lastFinalTranscriptRef.current = latestFinal;
      }

      // Trim interim text to avoid visual shifting from leading/trailing spaces
      const trimmedInterim = interimText.trim();
      if (trimmedInterim) {
        setInterimTranscript(trimmedInterim);
        onInterimResultRef.current?.(trimmedInterim);
      } else if (interimText && !trimmedInterim) {
        // Clear interim if it was just whitespace
        setInterimTranscript("");
      }

      const trimmedDelta = deltaTranscript.trim();
      if (trimmedDelta) {
        setInterimTranscript("");
        onResultRef.current?.(trimmedDelta);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Don't report aborted as an error (happens on manual stop)
      if (event.error === "aborted") {
        return;
      }

      // Handle "no-speech" specially - it's not a fatal error, just means silence
      // The recognition will auto-restart via onend, so just show a transient warning
      if (event.error === "no-speech") {
        // Don't stop listening - let it auto-restart
        // Just briefly show the status (will be cleared when onend restarts)
        setError("No speech detected");
        return;
      }

      let errorMessage = "Speech recognition error";
      switch (event.error) {
        case "audio-capture":
          errorMessage = "No microphone found";
          break;
        case "not-allowed":
          errorMessage = "Microphone permission denied";
          break;
        case "network":
          errorMessage = "Network error - check connection";
          break;
        case "service-not-allowed":
          errorMessage = "Speech service not available";
          break;
        default:
          errorMessage = `Error: ${event.error}`;
      }

      setError(errorMessage);
      setStatus("error");
      onErrorRef.current?.(errorMessage);
      setIsListening(false);
    };

    recognition.onend = () => {
      // Clear the receiving timeout if present
      if (receivingTimeoutRef.current) {
        clearTimeout(receivingTimeoutRef.current);
        receivingTimeoutRef.current = null;
      }

      // Auto-restart if not manually stopped (handles Chrome's ~60s timeout)
      if (!isStoppingRef.current && recognitionRef.current === recognition) {
        // Show reconnecting status during auto-restart
        setStatus("reconnecting");
        setError(null); // Clear any transient "no speech" error
        try {
          recognition.start();
          // Note: isListening stays true conceptually, onstart will confirm
        } catch {
          // Restart failed - truly end
          setIsListening(false);
          setInterimTranscript("");
          setStatus("idle");
          onEndRef.current?.();
        }
      } else {
        setIsListening(false);
        setInterimTranscript("");
        setStatus("idle");
        onEndRef.current?.();
      }
    };

    try {
      recognition.start();
    } catch (err) {
      setError("Failed to start speech recognition");
      setStatus("error");
      onErrorRef.current?.("Failed to start speech recognition");
    }
  }, [lang]);

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;
    if (receivingTimeoutRef.current) {
      clearTimeout(receivingTimeoutRef.current);
      receivingTimeoutRef.current = null;
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterimTranscript("");
    setStatus("idle");
    setError(null);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  return {
    isSupported,
    isListening,
    status,
    interimTranscript,
    startListening,
    stopListening,
    toggleListening,
    error,
  };
}
