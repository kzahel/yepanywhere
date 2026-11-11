// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { VOICE_INPUT_CAPABILITY } from "@yep-anywhere/shared";
import { createRef } from "react";
import { MIC_TITLE_ATTRIBUTE } from "../../lib/micTitleActivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseSpeechRecognitionOptions } from "../../hooks/useSpeechRecognition";
import {
  cancelSpeechFollowUp,
  getSpeechFollowUpSnapshot,
} from "../../lib/speechFollowUp";
import {
  VoiceInputButton,
  type VoiceInputButtonRef,
} from "../VoiceInputButton";

const {
  observedSpeechOptions,
  openSpeechSocket,
  sourceTransport,
  speechCaptureState,
  speechState,
  startListening,
  versionState,
} = vi.hoisted(() => {
  const openSpeechSocket = vi.fn();
  return {
    observedSpeechOptions: [] as UseSpeechRecognitionOptions[],
    openSpeechSocket,
    sourceTransport: {
      capabilities: {
        sameOriginUrls: false,
        speech: { open: openSpeechSocket },
      },
    },
    speechCaptureState: {
      keepMicWarm: false,
      micDeviceId: null as string | null,
      reducePlayback: true,
      unspokenPunctuation: false,
      followUpListenMs: 0,
    },
    startListening: vi.fn(),
    speechState: {
      isSupported: true,
      isListening: false,
      status: "idle" as
        | "idle"
        | "starting"
        | "listening"
        | "receiving"
        | "processing"
        | "finalizing"
        | "reconnecting"
        | "error",
      interimTranscript: "",
    },
    versionState: {
      capabilities: [] as string[],
      loading: false,
      voiceBackends: [] as string[],
      voiceBackendCapabilities: {} as Record<
        string,
        { streaming?: boolean; smartTurn?: boolean }
      >,
    },
  };
});

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    transport: sourceTransport,
  }),
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    voiceInputEnabled: true,
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    parakeetSpeechModel: "nvidia/parakeet-ctc-1.1b",
    whisperSpeechModel: "large-v3",
    grokSpeechAudioSettings: { uplinkMode: "pcm16" },
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/ygraehl",
}));

vi.mock("../../hooks/useSpeechCaptureSettings", () => ({
  useSpeechCaptureSettings: () => speechCaptureState,
}));

vi.mock("../../hooks/useSpeechRecognition", () => ({
  useSpeechRecognition: (options: UseSpeechRecognitionOptions) => {
    observedSpeechOptions.push(options);
    return {
      isSupported: speechState.isSupported,
      isListening: speechState.isListening,
      status: speechState.status,
      interimTranscript: speechState.interimTranscript,
      startListening,
      stopListening: vi.fn(),
      toggleListening: vi.fn(),
      prewarm: vi.fn(),
      error: null,
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
      voiceBackends: versionState.voiceBackends,
      voiceBackendCapabilities: versionState.voiceBackendCapabilities,
    },
    loading: versionState.loading,
  }),
}));

vi.mock("../../hooks/useViewportWidth", () => ({
  useViewportWidth: () => 800,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        speechReadyStatus: "Ready",
        speechStartingStatus: "Starting...",
        speechUnavailableStatus: "Speech input unavailable",
        speechSpeakNowStatus: "Speak now...",
        speechListeningPlaceholder: "Listening...",
        speechTranscribingPlaceholder: "Transcribing...",
        speechFinalizingPlaceholder: "Finalizing...",
        speechErrorStatus: "Error",
      })[key] ?? key,
  }),
}));

vi.mock("../../lib/deviceDetection", () => ({
  hasCoarsePointer: () => false,
}));

vi.mock("../SpeechWaveform", () => ({
  SpeechWaveform: () => <div className="composer-speech-waveform" />,
}));

describe("VoiceInputButton", () => {
  it("reports recording for the title even with playback reduction off", () => {
    document.title = "Session";
    speechCaptureState.reducePlayback = false;
    speechState.status = "starting";
    const view = render(<VoiceInputButton onTranscript={vi.fn()} />);
    const title = document.querySelector("title");
    expect(title?.getAttribute(MIC_TITLE_ATTRIBUTE)).toBe("starting");
    speechState.status = "listening";
    speechState.isListening = true;
    view.rerender(<VoiceInputButton onTranscript={vi.fn()} />);
    expect(title?.getAttribute(MIC_TITLE_ATTRIBUTE)).toBe("capturing");
    speechState.status = "finalizing";
    speechState.isListening = false;
    view.rerender(<VoiceInputButton onTranscript={vi.fn()} />);
    expect(title?.hasAttribute(MIC_TITLE_ATTRIBUTE)).toBe(false);
    view.unmount();
    expect(title?.hasAttribute(MIC_TITLE_ATTRIBUTE)).toBe(false);
  });
  it("keeps inactive server models out of browser recognition options when capabilities arrive", () => {
    const view = render(
      <VoiceInputButton onTranscript={vi.fn()} speechMethod="browser-native" />,
    );
    expect(observedSpeechOptions.at(-1)?.parakeetModel).toBeUndefined();
    expect(observedSpeechOptions.at(-1)?.whisperModel).toBeUndefined();
    versionState.capabilities.push("local-speech-model-selection");
    view.rerender(
      <VoiceInputButton onTranscript={vi.fn()} speechMethod="browser-native" />,
    );
    expect(observedSpeechOptions.at(-1)?.parakeetModel).toBeUndefined();
    expect(observedSpeechOptions.at(-1)?.whisperModel).toBeUndefined();
  });

  it("passes a saved Whisper choice only after the server capability is known", () => {
    const view = render(
      <VoiceInputButton onTranscript={vi.fn()} speechMethod="ya-whisper" />,
    );
    expect(observedSpeechOptions.at(-1)?.whisperModel).toBeUndefined();
    versionState.capabilities.push("local-speech-model-selection");
    view.rerender(
      <VoiceInputButton onTranscript={vi.fn()} speechMethod="ya-whisper" />,
    );
    expect(observedSpeechOptions.at(-1)?.whisperModel).toBe("large-v3");
  });
  beforeEach(() => {
    versionState.capabilities = [VOICE_INPUT_CAPABILITY];
  });

  afterEach(() => {
    cleanup();
    observedSpeechOptions.length = 0;
    openSpeechSocket.mockReset();
    speechState.isListening = false;
    speechState.isSupported = true;
    speechState.status = "idle";
    speechState.interimTranscript = "";
    speechCaptureState.keepMicWarm = false;
    speechCaptureState.micDeviceId = null;
    speechCaptureState.reducePlayback = true;
    speechCaptureState.unspokenPunctuation = false;
    speechCaptureState.followUpListenMs = 0;
    startListening.mockReset();
    versionState.loading = false;
    versionState.voiceBackends = [];
    versionState.voiceBackendCapabilities = {};
    cancelSpeechFollowUp();
    vi.useRealTimers();
  });

  it("shares the first capture for follow-up without enabling idle prewarm", () => {
    speechCaptureState.followUpListenMs = 3_000;
    versionState.voiceBackends = ["ya-grok"];
    versionState.voiceBackendCapabilities = {
      "ya-grok": { streaming: true, smartTurn: true },
    };
    const ref = createRef<VoiceInputButtonRef>();
    const onTranscript = vi.fn(() => "wait" as const);

    render(
      <VoiceInputButton
        ref={ref}
        onTranscript={onTranscript}
        speechMethod="ya-grok"
        smartTurn={{
          enabled: true,
          threshold: 0.95,
          timeoutMs: 3_000,
          graceMs: 0,
        }}
      />,
    );

    const options = observedSpeechOptions.at(-1);
    expect(options?.keepMicWarm).toBe(false);
    expect(options?.temporarilyKeepMicWarm?.()).toBe(true);

    act(() => ref.current?.continueAfterSpeechSend());
    expect(getSpeechFollowUpSnapshot().active).toBe(true);
    expect(options?.temporarilyKeepMicWarm?.()).toBe(true);

    act(() => {
      options?.onResult?.("wait", { smartTurnCommand: "wait" });
    });
    expect(getSpeechFollowUpSnapshot().active).toBe(false);
  });

  it("settles the finished capture before starting its follow-up capture", () => {
    // A follow-up capture's insertion target must survive the previous
    // capture's settlement; otherwise its revised finals append instead of
    // replacing the streamed chunks they revise.
    speechCaptureState.followUpListenMs = 3_000;
    versionState.voiceBackends = ["ya-grok"];
    versionState.voiceBackendCapabilities = {
      "ya-grok": { streaming: true, smartTurn: true },
    };
    speechState.status = "finalizing";
    const ref = createRef<VoiceInputButtonRef>();
    const order: string[] = [];
    const props = {
      ref,
      onTranscript: vi.fn(() => "send-dispatched" as const),
      onListeningStart: () => order.push("start"),
      onPendingSpeechChange: (kind: string | null) =>
        order.push(`pending:${kind}`),
      speechMethod: "ya-grok" as const,
      smartTurn: {
        enabled: true,
        threshold: 0.95,
        timeoutMs: 3_000,
        graceMs: 0,
      },
    };

    const view = render(<VoiceInputButton {...props} />);
    order.length = 0;
    act(() => {
      ref.current?.continueAfterSpeechSend();
      speechState.status = "idle";
      view.rerender(<VoiceInputButton {...props} />);
    });

    expect(startListening).toHaveBeenCalledOnce();
    expect(order).toEqual(["pending:null", "start"]);
  });

  it.each(["onInterimResult", "onResult"] as const)(
    "lets speech reported by %s finish after the follow-up deadline",
    (event) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      speechCaptureState.followUpListenMs = 3_000;
      versionState.voiceBackends = ["ya-grok"];
      versionState.voiceBackendCapabilities = {
        "ya-grok": { streaming: true, smartTurn: true },
      };
      const ref = createRef<VoiceInputButtonRef>();
      const props = {
        ref,
        onTranscript: vi.fn(() => "committed" as const),
        speechMethod: "ya-grok" as const,
        smartTurn: {
          enabled: true,
          threshold: 0.95,
          timeoutMs: 3_000,
          graceMs: 0,
        },
      };

      const view = render(<VoiceInputButton {...props} />);
      act(() => ref.current?.continueAfterSpeechSend());
      expect(startListening).toHaveBeenCalledOnce();

      speechState.status = "listening";
      speechState.isListening = true;
      view.rerender(<VoiceInputButton {...props} />);
      act(() => observedSpeechOptions.at(-1)?.[event]?.("still speaking"));
      act(() => vi.advanceTimersByTime(3_000));
      expect(getSpeechFollowUpSnapshot()).toMatchObject({
        active: true,
        deadlineMs: 13_000,
        expired: true,
      });

      const startsAtExpiry = startListening.mock.calls.length;
      speechState.status = "idle";
      speechState.isListening = false;
      view.rerender(<VoiceInputButton {...props} />);
      expect(getSpeechFollowUpSnapshot().active).toBe(false);
      expect(startListening).toHaveBeenCalledTimes(startsAtExpiry);
    },
  );

  it("keeps the relayed speech socket opener stable across rerenders", () => {
    const props = {
      onTranscript: vi.fn(),
      onInterimTranscript: vi.fn(),
      speechMethod: "browser-native",
    };

    const { rerender } = render(<VoiceInputButton {...props} />);
    const firstOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    rerender(<VoiceInputButton {...props} />);
    const secondOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    expect(firstOpenSpeechSocket).toBeDefined();
    expect(secondOpenSpeechSocket).toBe(firstOpenSpeechSocket);
    expect(observedSpeechOptions.at(-1)?.reducePlayback).toBe(true);
    expect(observedSpeechOptions.at(-1)?.unspokenPunctuation).toBe(false);
  });

  it("passes the browser punctuation preference to speech providers", () => {
    speechCaptureState.unspokenPunctuation = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    expect(observedSpeechOptions.at(-1)?.unspokenPunctuation).toBe(true);
  });

  it("keeps an unavailable enabled microphone visible but disabled", () => {
    speechState.isSupported = false;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", {
      name: "Speech input unavailable",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not fall back to unavailable browser-native speech", () => {
    render(<VoiceInputButton onTranscript={vi.fn()} />);

    expect(observedSpeechOptions.at(-1)?.speechMethod).toBeNull();
    const button = screen.getByRole("button", {
      name: "Speech input unavailable",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not render post-capture processing as active capture", () => {
    speechState.status = "processing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStartLabel" });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-voice-input-recording]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Transcribing...");
  });

  it("passes the browser-selected Parakeet model to speech providers", () => {
    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
      />,
    );

    expect(observedSpeechOptions.at(-1)?.parakeetModel).toBe(
      "nvidia/parakeet-ctc-1.1b",
    );
  });

  it("does not render streaming finalization as active capture", () => {
    speechState.status = "finalizing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "Finalizing..." });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-voice-input-recording]")).toBeNull();
  });

  it("reports a listening pending kind during active capture", () => {
    speechState.status = "listening";
    speechState.isListening = true;
    const onPendingSpeechChange = vi.fn();

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        onPendingSpeechChange={onPendingSpeechChange}
        speechMethod="browser-native"
      />,
    );

    // The composer surfaces capture as a cancellable chip too, so the ✕ can
    // abandon the in-flight utterance — not just the post-capture waits.
    expect(onPendingSpeechChange).toHaveBeenCalledWith("listening");
  });

  it("ignores provider revisions after Stop commits the visible interim", () => {
    speechState.status = "receiving";
    speechState.isListening = true;
    speechState.interimTranscript = "visible words";
    const onTranscript = vi.fn();
    const onListeningStop = vi.fn(() => true);

    render(
      <VoiceInputButton
        onTranscript={onTranscript}
        onInterimTranscript={vi.fn()}
        onListeningStop={onListeningStop}
        speechMethod="browser-native"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "voiceInputStopLabel" }),
    );
    expect(onListeningStop).toHaveBeenCalledOnce();

    observedSpeechOptions.at(-1)?.onResult?.("later backend correction");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("keeps revisions suppressed if Stop is clicked while finalizing", () => {
    speechState.status = "receiving";
    speechState.isListening = true;
    const onTranscript = vi.fn();
    const onListeningStop = vi
      .fn<() => boolean | undefined>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const props = {
      onTranscript,
      onInterimTranscript: vi.fn(),
      onListeningStop,
      speechMethod: "browser-native",
    } as const;
    const { rerender } = render(<VoiceInputButton {...props} />);

    fireEvent.click(
      screen.getByRole("button", { name: "voiceInputStopLabel" }),
    );
    speechState.status = "finalizing";
    speechState.isListening = false;
    rerender(<VoiceInputButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Finalizing..." }));

    observedSpeechOptions.at(-1)?.onResult?.("late final revision");
    expect(onListeningStop).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("keeps a post-stop result when no visible interim was committed", () => {
    speechState.status = "listening";
    speechState.isListening = true;
    const onTranscript = vi.fn();

    render(
      <VoiceInputButton
        onTranscript={onTranscript}
        onInterimTranscript={vi.fn()}
        onListeningStop={() => false}
        speechMethod="browser-native"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "voiceInputStopLabel" }),
    );
    observedSpeechOptions.at(-1)?.onResult?.("batch result");
    expect(onTranscript).toHaveBeenCalledWith("batch result", undefined);
  });

  it("keeps one pending transaction from capture startup into listening", () => {
    speechState.status = "starting";
    const onPendingSpeechChange = vi.fn();
    const props = {
      onTranscript: vi.fn(),
      onInterimTranscript: vi.fn(),
      onPendingSpeechChange,
      speechMethod: "browser-native",
    };

    const { rerender } = render(<VoiceInputButton {...props} />);
    expect(onPendingSpeechChange).toHaveBeenCalledWith("starting");

    speechState.status = "listening";
    speechState.isListening = true;
    rerender(<VoiceInputButton {...props} />);
    expect(onPendingSpeechChange).toHaveBeenLastCalledWith("listening");
    expect(onPendingSpeechChange).not.toHaveBeenCalledWith(
      null,
      expect.anything(),
    );
  });

  it("fails a delivery transaction when capture startup fails", () => {
    speechState.status = "starting";
    const onPendingSpeechChange = vi.fn();
    const props = {
      onTranscript: vi.fn(),
      onInterimTranscript: vi.fn(),
      onPendingSpeechChange,
      speechMethod: "browser-native",
    };

    const { rerender } = render(<VoiceInputButton {...props} />);
    speechState.status = "error";
    rerender(<VoiceInputButton {...props} />);

    expect(onPendingSpeechChange).toHaveBeenLastCalledWith(null, "failed");
  });

  it("fails a pending speech transaction when the mic unmounts", () => {
    speechState.status = "starting";
    const onPendingSpeechChange = vi.fn();

    const { unmount } = render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        onPendingSpeechChange={onPendingSpeechChange}
        speechMethod="browser-native"
      />,
    );
    onPendingSpeechChange.mockClear();
    unmount();

    expect(onPendingSpeechChange).toHaveBeenCalledOnce();
    expect(onPendingSpeechChange).toHaveBeenCalledWith(null, "failed");
  });

  it("suppresses redundant listening text when a live waveform is available", () => {
    speechState.status = "listening";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
        showWaveform
      />,
    );

    expect(document.querySelector("[data-voice-input-status]")).toBeNull();
    const recordingIcon = document.querySelector(
      "[data-voice-input-recording]",
    );
    expect(recordingIcon).toBeTruthy();
    expect(recordingIcon?.hasAttribute("data-is-speech-active")).toBe(false);
  });

  it("keeps the waveform slot across a brief Smart Turn handoff", () => {
    vi.useFakeTimers();
    speechState.status = "listening";
    speechState.isListening = true;
    speechCaptureState.followUpListenMs = 3_000;
    versionState.voiceBackends = ["ya-grok"];
    versionState.voiceBackendCapabilities = {
      "ya-grok": { streaming: true, smartTurn: true },
    };
    const onWaveformActiveChange = vi.fn();
    const props = {
      onTranscript: vi.fn(),
      speechMethod: "ya-grok" as const,
      smartTurn: {
        enabled: true,
        threshold: 0.95,
        timeoutMs: 3000,
        graceMs: 0,
      },
      showWaveform: true,
      inlineWaveform: true,
      onWaveformActiveChange,
    };
    const view = render(<VoiceInputButton {...props} />);
    onWaveformActiveChange.mockClear();

    speechState.status = "finalizing";
    speechState.isListening = false;
    view.rerender(<VoiceInputButton {...props} />);
    act(() => vi.advanceTimersByTime(100));
    speechState.status = "starting";
    view.rerender(<VoiceInputButton {...props} />);
    act(() => vi.advanceTimersByTime(100));
    speechState.status = "listening";
    speechState.isListening = true;
    view.rerender(<VoiceInputButton {...props} />);
    expect(onWaveformActiveChange).not.toHaveBeenCalled();
    expect(document.querySelector(".composer-speech-waveform")).toBeTruthy();

    speechState.status = "idle";
    speechState.isListening = false;
    view.rerender(<VoiceInputButton {...props} />);
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector(".composer-speech-waveform")).toBeNull();
    expect(onWaveformActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("puts an inline waveform inside the microphone touch target", () => {
    speechState.status = "listening";
    speechState.isListening = true;
    const onWaveformActiveChange = vi.fn();

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        onWaveformActiveChange={onWaveformActiveChange}
        speechMethod="ya-parakeet"
        showWaveform
        inlineWaveform
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStopLabel" });
    expect(button.querySelector(".composer-speech-waveform")).toBeTruthy();
    expect(onWaveformActiveChange).toHaveBeenCalledWith(true);
  });

  it("reserves the full inline microphone touch target before capture", () => {
    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
        showWaveform
        inlineWaveform
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStartLabel" });
    expect(button.getAttribute("data-inline-waveform")).toBe("true");
    expect(button.querySelector(".composer-speech-waveform")).toBeNull();
  });

  it("prompts when browser-native capture is ready without sample access", () => {
    speechState.status = "listening";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
        showWaveform
      />,
    );

    expect(
      document.querySelector("[data-voice-input-status]")?.textContent,
    ).toBe("Speak now...");
  });

  it("shows listening while browser-native speech is active", () => {
    speechState.status = "receiving";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Listening...");
    expect(
      document
        .querySelector("[data-voice-input-recording]")
        ?.hasAttribute("data-is-speech-active"),
    ).toBe(true);
  });

  it("describes an automatic recognizer restart as starting", () => {
    speechState.status = "reconnecting";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Starting...");
  });

  it("shows a distinct requested state while capture starts", () => {
    speechState.status = "starting";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStopLabel" });
    expect(button.getAttribute("data-speech-phase")).toBe("starting");
    expect(button.className).toContain("starting");
    expect(button.classList.contains("listening")).toBe(false);
    expect(document.querySelector("[data-voice-input-recording]")).toBeNull();
  });

  it("shows the selected STT backend inside the wider mic chip", () => {
    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
      />,
    );

    const button = screen.getByRole("button", {
      name: "voiceInputStartLabel",
    });
    expect(button.textContent).toContain("Para");
    expect(button.getAttribute("data-speech-method")).toBe("ya-parakeet");
  });
});
