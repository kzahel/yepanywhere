import { computeSpeechDelta } from "../speechRecognition";
import {
  INITIAL_SPEECH_STATE,
  type SpeechProvider,
  type SpeechProviderOptions,
  type SpeechProviderState,
  type SpeechProviderSubscriber,
} from "./SpeechProvider";

const SPEECH_ACTIVITY_IDLE_MS = 1200;

// Web Speech API types (not included in lib.dom by default).
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
  unspokenPunctuation?: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
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

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Browser-native provider using the Web Speech API.
 *
 * Owns: auto-restart across Chrome's ~60s idle timeout, mobile
 * cumulative-final dedup via computeSpeechDelta, status state machine,
 * error mapping, interim trim.
 */
export class BrowserNativeProvider implements SpeechProvider {
  readonly id = "browser-native";

  private readonly options: SpeechProviderOptions;
  private state: SpeechProviderState = { ...INITIAL_SPEECH_STATE };
  private readonly subscribers = new Set<SpeechProviderSubscriber>();
  private recognition: SpeechRecognition | null = null;
  private isStopping = false;
  private terminalError = false;
  private lastFinalTranscript = "";
  private disposed = false;
  private speechActivityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SpeechProviderOptions = {}) {
    this.options = options;
  }

  get isSupported(): boolean {
    return getSpeechRecognition() !== null;
  }

  getState(): SpeechProviderState {
    return this.state;
  }

  subscribe(subscriber: SpeechProviderSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  start(): void {
    if (this.disposed) return;
    if (this.state.isListening) return;

    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      this.setState({
        status: "error",
        error: "Speech recognition not supported",
      });
      this.options.onError?.("Speech recognition not supported");
      return;
    }

    if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }

    this.isStopping = false;
    this.terminalError = false;
    this.lastFinalTranscript = "";
    this.setState({
      status: "starting",
      isListening: false,
      interimTranscript: "",
      error: null,
    });

    const recognition = new Ctor();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    // Chrome 151+ can infer punctuation from pauses and prosody. Keep older
    // browsers on their existing raw-transcript path without UA sniffing.
    if ("unspokenPunctuation" in recognition) {
      recognition.unspokenPunctuation = true;
    }
    // Always set lang explicitly so we don't depend on the browser's
    // locale guess. Caller's override wins; otherwise fall back to the
    // browser's reported preferred language.
    recognition.lang =
      this.options.lang ??
      (typeof navigator !== "undefined" ? navigator.language : "en-US");

    recognition.onstart = () => {
      if (this.recognition !== recognition || this.isStopping) return;
      this.clearSpeechActivityTimer();
      if (!this.state.isListening) {
        this.setState({ isListening: false, status: "starting" });
      }
    };
    const markCaptureReady = () => {
      if (this.recognition !== recognition || this.isStopping) return;
      this.markAudioStarted("listening");
    };
    const markSpeechStarted = () => {
      if (this.recognition !== recognition || this.isStopping) return;
      this.markSpeechActivity(recognition);
    };
    recognition.onaudiostart = markCaptureReady;
    recognition.onsoundstart = markSpeechStarted;
    recognition.onspeechstart = markSpeechStarted;
    const markSpeechEnded = () => {
      if (this.recognition !== recognition || this.isStopping) return;
      this.clearSpeechActivityTimer();
      if (this.state.isListening) {
        this.setState({ status: "listening" });
      }
    };
    recognition.onsoundend = markSpeechEnded;
    recognition.onspeechend = markSpeechEnded;

    recognition.onresult = (event) => {
      if (this.recognition !== recognition || this.isStopping) return;

      // Result changes are the reliable speech-activity fallback on browsers
      // that omit or delay the optional sound/speech boundary events.
      this.markSpeechActivity(recognition);

      let interimText = "";
      let latestFinal = "";

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

      const deltaTranscript = computeSpeechDelta(
        latestFinal,
        this.lastFinalTranscript,
      );
      if (deltaTranscript) {
        this.lastFinalTranscript = latestFinal;
      }

      const trimmedInterim = interimText.trim();
      if (trimmedInterim) {
        this.setState({ interimTranscript: trimmedInterim });
        this.options.onInterimResult?.(trimmedInterim);
      } else if (interimText && !trimmedInterim) {
        this.setState({ interimTranscript: "" });
      }

      const trimmedDelta = deltaTranscript.trim();
      if (trimmedDelta) {
        this.setState({ interimTranscript: "" });
        this.options.onResult?.(trimmedDelta);
      }
    };

    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      if (event.error === "aborted") return;

      if (event.error === "no-speech") {
        this.setState({ error: "No speech detected" });
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

      this.terminalError = true;
      this.setState({
        error: errorMessage,
        status: "error",
        isListening: false,
      });
      this.options.onError?.(errorMessage);
    };

    recognition.onend = () => {
      this.clearSpeechActivityTimer();
      if (
        !this.isStopping &&
        !this.terminalError &&
        this.recognition === recognition
      ) {
        // Auto-restart after Chrome's ~60s idle timeout, but never after a
        // recognition error: retrying a failed speech service immediately can
        // create a tight start/error/end loop.
        this.setState({ status: "reconnecting", error: null });
        try {
          recognition.start();
        } catch {
          this.setState({
            isListening: false,
            interimTranscript: "",
            status: "idle",
          });
          this.options.onEnd?.();
        }
      } else {
        this.setState({
          isListening: false,
          interimTranscript: "",
          status: this.terminalError ? "error" : "idle",
        });
        this.options.onEnd?.();
      }
    };

    try {
      recognition.start();
    } catch {
      this.setState({
        error: "Failed to start speech recognition",
        status: "error",
      });
      this.options.onError?.("Failed to start speech recognition");
    }
  }

  stop(): void {
    if (this.disposed) return;
    this.isStopping = true;
    this.clearSpeechActivityTimer();
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    this.setState({
      isListening: false,
      interimTranscript: "",
      status: "idle",
      error: null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isStopping = true;
    this.clearSpeechActivityTimer();
    if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }
    this.subscribers.clear();
  }

  private markAudioStarted(status: "listening" | "receiving"): void {
    this.setState({ isListening: true, status });
  }

  private markSpeechActivity(recognition: SpeechRecognition): void {
    this.markAudioStarted("receiving");
    this.clearSpeechActivityTimer();
    this.speechActivityTimer = setTimeout(() => {
      this.speechActivityTimer = null;
      if (
        this.recognition !== recognition ||
        this.isStopping ||
        !this.state.isListening
      ) {
        return;
      }
      this.setState({ status: "listening" });
    }, SPEECH_ACTIVITY_IDLE_MS);
  }

  private clearSpeechActivityTimer(): void {
    if (this.speechActivityTimer !== null) {
      clearTimeout(this.speechActivityTimer);
      this.speechActivityTimer = null;
    }
  }

  private setState(patch: Partial<SpeechProviderState>): void {
    this.state = { ...this.state, ...patch };
    for (const subscriber of this.subscribers) {
      subscriber(this.state);
    }
  }
}
