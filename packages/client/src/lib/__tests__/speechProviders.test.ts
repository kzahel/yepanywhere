import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserNativeProvider } from "../speechProviders/BrowserNativeProvider";
import { DirectXaiStreamingSpeechProvider } from "../speechProviders/DirectXaiStreamingSpeechProvider";
import { DirectXaiSpeechProvider } from "../speechProviders/DirectXaiSpeechProvider";
import {
  YaServerProvider,
  decideSmartTurn,
  prewarmYaServerSpeechBackend,
} from "../speechProviders/YaServerProvider";
import type {
  SpeechProvider,
  SpeechProviderStatus,
} from "../speechProviders/SpeechProvider";
import { decideBatchSpeechCommand } from "../speechProviders/speechCommands";
import {
  SHARED_SPEECH_MIC_LEASE_STORAGE_KEY,
  acquireSharedSpeechMicActiveLease,
  getSpeechMicStream,
  releaseSharedSpeechMicStream,
} from "../speechProviders/sharedMicCapture";
import { UI_KEYS } from "../storageKeys";
import {
  DEFAULT_SPEECH_METHOD,
  YA_GROK_BATCH_SPEECH_METHOD,
  YA_GROK_STREAMING_SPEECH_METHOD,
  XAI_DIRECT_BATCH_SPEECH_METHOD,
  XAI_DIRECT_STREAMING_SPEECH_METHOD,
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getOrderedServerSpeechBackends,
  getPreferredSpeechMethod,
  getSpeechMethods,
  resolveSpeechMethod,
} from "../speechProviders/methods";
import { setBrowserXaiSttApiKey } from "../speechProviders/xaiCredentials";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForProviderStatus(
  provider: Pick<SpeechProvider, "getState">,
  status: SpeechProviderStatus,
): Promise<void> {
  await vi.waitFor(() => expect(provider.getState().status).toBe(status));
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  releaseSharedSpeechMicStream();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("speech provider method selection", () => {
  it("uses advertised server backends directly and orders preferred cloud STT first", () => {
    expect(
      getOrderedServerSpeechBackends([
        "ya-deepgram",
        "ya-whisper",
        "ya-parakeet",
        "ya-nemo",
        "ya-grok",
        "ya-grok",
      ]),
    ).toEqual([
      "ya-grok",
      "ya-deepgram",
      "ya-whisper",
      "ya-parakeet",
      "ya-nemo",
    ]);
  });

  it("does not require client-side backend hardcodes to build selector options", () => {
    expect(
      getSpeechMethods(["ya-custom-stt"]).map((method) => method.id),
    ).toEqual(["ya-custom-stt", DEFAULT_SPEECH_METHOD]);
  });

  it("exposes direct Grok streaming when the browser has an xAI key", () => {
    expect(
      getSpeechMethods(["ya-custom-stt"], undefined, {
        directXaiAvailable: true,
      }).map((method) => method.id),
    ).toEqual([
      XAI_DIRECT_STREAMING_SPEECH_METHOD,
      "ya-custom-stt",
      DEFAULT_SPEECH_METHOD,
    ]);
  });

  it("uses explicit labels for known STT backends", () => {
    expect(
      getSpeechMethods(["ya-deepgram", "ya-parakeet", "ya-nemo", "ya-grok"])
        .filter((method) => method.serverRouted)
        .map((method) => method.label),
    ).toEqual([
      "Grok STT through YA",
      "Deepgram STT",
      "Parakeet STT",
      "NeMo Parakeet STT",
    ]);
  });

  it("exposes Grok streaming methods without batch choices", () => {
    expect(
      getSpeechMethods(["ya-grok"]).map((method) => [method.id, method.label]),
    ).toEqual([
      [XAI_DIRECT_STREAMING_SPEECH_METHOD, "Grok STT direct"],
      [YA_GROK_STREAMING_SPEECH_METHOD, "Grok STT through YA"],
      [DEFAULT_SPEECH_METHOD, expect.stringContaining("Browser")],
    ]);
    expect(
      getSpeechMethodCapabilities(YA_GROK_BATCH_SPEECH_METHOD, {
        "ya-grok": { streaming: true, smartTurn: true },
      }),
    ).toEqual({});
    expect(
      canSpeechMethodStream({
        methodId: YA_GROK_BATCH_SPEECH_METHOD,
        serverCapabilities: { "ya-grok": { streaming: true } },
      }),
    ).toBe(false);
  });

  it("maps a stored direct xAI batch choice to streaming", () => {
    expect(
      getSpeechMethods(["ya-grok"]).find(
        (method) => method.id === XAI_DIRECT_BATCH_SPEECH_METHOD,
      ),
    ).toBeUndefined();
    expect(
      resolveSpeechMethod(XAI_DIRECT_BATCH_SPEECH_METHOD, ["ya-grok"], true),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });

  it("maps a stored YA-routed Grok batch choice to streaming", () => {
    expect(
      getSpeechMethods(["ya-grok"]).find(
        (method) => method.id === YA_GROK_BATCH_SPEECH_METHOD,
      ),
    ).toBeUndefined();
    expect(
      resolveSpeechMethod(YA_GROK_BATCH_SPEECH_METHOD, ["ya-grok"], true),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });

  it("keeps the direct xAI streaming method as the primary direct choice", () => {
    expect(
      getSpeechMethods(["ya-grok"]).find(
        (method) => method.id === XAI_DIRECT_STREAMING_SPEECH_METHOD,
      ),
    ).toMatchObject({
      label: "Grok STT direct",
      serverRouted: false,
      clientSupported: true,
    });
    expect(
      resolveSpeechMethod(
        XAI_DIRECT_STREAMING_SPEECH_METHOD,
        ["ya-grok"],
        true,
      ),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });

  it("gives direct xAI streaming local Smart Turn capability", () => {
    expect(
      getSpeechMethodCapabilities(XAI_DIRECT_STREAMING_SPEECH_METHOD, {}),
    ).toEqual({
      streaming: true,
      smartTurn: true,
    });
    expect(
      canSpeechMethodStream({
        methodId: XAI_DIRECT_STREAMING_SPEECH_METHOD,
        relayTransport: true,
        serverCapabilities: {},
      }),
    ).toBe(true);
  });

  it("prefers direct Grok streaming when Grok STT is enabled", () => {
    expect(getPreferredSpeechMethod(["ya-deepgram", "ya-grok"])).toBe(
      XAI_DIRECT_STREAMING_SPEECH_METHOD,
    );
    expect(
      resolveSpeechMethod(
        DEFAULT_SPEECH_METHOD,
        ["ya-deepgram", "ya-grok"],
        false,
      ),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });

  it("prefers direct Grok streaming when this browser has an xAI key", () => {
    expect(getPreferredSpeechMethod([], { directXaiAvailable: true })).toBe(
      XAI_DIRECT_STREAMING_SPEECH_METHOD,
    );
    expect(
      resolveSpeechMethod(DEFAULT_SPEECH_METHOD, [], false, {
        directXaiAvailable: true,
      }),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });

  it("keeps explicit choices only while they are still available", () => {
    expect(
      resolveSpeechMethod("ya-deepgram", ["ya-grok", "ya-deepgram"], true),
    ).toBe("ya-deepgram");
    expect(
      resolveSpeechMethod(YA_GROK_BATCH_SPEECH_METHOD, ["ya-grok"], true),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
    expect(resolveSpeechMethod(DEFAULT_SPEECH_METHOD, ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
    expect(resolveSpeechMethod("ya-deepgram", ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
    expect(
      resolveSpeechMethod(XAI_DIRECT_STREAMING_SPEECH_METHOD, [], true),
    ).toBe(DEFAULT_SPEECH_METHOD);
    expect(
      resolveSpeechMethod(XAI_DIRECT_STREAMING_SPEECH_METHOD, [], true, {
        directXaiAvailable: true,
      }),
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);
  });
});

describe("speech command parsing", () => {
  it("treats batch send and cancel as whole-batch commands", () => {
    expect(decideBatchSpeechCommand("replace this send")).toEqual({
      command: "send",
      transcript: "replace this",
      recognizedCommand: true,
    });
    expect(decideBatchSpeechCommand("Cancel.")).toEqual({
      command: "cancel",
      transcript: "",
      recognizedCommand: true,
    });
  });

  it("does not treat wait as a batch command", () => {
    expect(decideBatchSpeechCommand("please wait")).toEqual({
      command: "wait",
      transcript: "please wait",
      recognizedCommand: false,
    });
  });
});

describe("streaming smart-turn decision", () => {
  // Pause (s) before the final word, computed from word timestamps.
  const wordsEndingWith = (
    word: string,
    pauseBeforeFinal: number,
  ): { word: string; start: number; end: number }[] => [
    { word: "prior", start: 1, end: 2 },
    { word, start: 2 + pauseBeforeFinal, end: 2 + pauseBeforeFinal + 0.3 },
  ];

  it("holds the send on a trailing wait without a pause, keeping the word", () => {
    // The bug: a fluent end-of-turn "wait" was downgraded to an auto-send.
    // wait holds and is left in the draft (not stripped, unlike send).
    expect(
      decideSmartTurn(
        "Testing streaming with Grok speech-to-text. Wait",
        wordsEndingWith("Wait", 0.1),
      ),
    ).toEqual({
      command: "wait",
      recognizedCommand: true,
      transcript: "Testing streaming with Grok speech-to-text. Wait",
    });
  });

  it("recognizes a trailing wait without word timestamps", () => {
    expect(decideSmartTurn("hold on wait", undefined)).toEqual({
      command: "wait",
      recognizedCommand: true,
      transcript: "hold on wait",
    });
  });

  it("holds a sentence that legitimately ends in wait, leaving it for one-click send", () => {
    // Gap-less wait means dictation ending in "wait" also holds; keeping the
    // word makes that a no-loss one-click manual send.
    expect(
      decideSmartTurn("tell them I can't wait", wordsEndingWith("wait", 0.1)),
    ).toEqual({
      command: "wait",
      recognizedCommand: true,
      transcript: "tell them I can't wait",
    });
  });

  it("still requires a pause before send so dictated send is not a command", () => {
    expect(
      decideSmartTurn("ship it send", wordsEndingWith("send", 0.1)),
    ).toEqual({
      command: "send",
      recognizedCommand: false,
      transcript: "ship it send",
    });
    expect(
      decideSmartTurn("ship it send", wordsEndingWith("send", 1.0)),
    ).toEqual({
      command: "send",
      recognizedCommand: true,
      transcript: "ship it",
    });
  });

  it("auto-sends plain dictation with no trailing command", () => {
    expect(
      decideSmartTurn("just some words", wordsEndingWith("words", 0.1)),
    ).toEqual({
      command: "send",
      recognizedCommand: false,
      transcript: "just some words",
    });
  });
});

describe("server speech prewarm", () => {
  it("posts the selected model to the YA speech prewarm endpoint", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await prewarmYaServerSpeechBackend("ya-nemo", "nvidia/parakeet-rnnt-1.1b");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/speech/prewarm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          backendId: "ya-nemo",
          model: "nvidia/parakeet-rnnt-1.1b",
        }),
      }),
    );
  });

  it("warms the backend model on pointer-near prewarm when keeping the mic warm", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // prewarm() only needs MediaRecorder to be defined; it never constructs one.
    vi.stubGlobal("MediaRecorder", class FakeMediaRecorder {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
    });

    const provider = new YaServerProvider("ya-nemo", "", {
      keepMicWarm: true,
      parakeetModel: "nvidia/parakeet-rnnt-1.1b",
    });
    provider.prewarm();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/speech/prewarm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          backendId: "ya-nemo",
          model: "nvidia/parakeet-rnnt-1.1b",
        }),
      }),
    );

    // A repeated pointer-near must not re-load an already-warmed model.
    fetchMock.mockClear();
    provider.prewarm();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    provider.dispose();
  });

  it("does not warm the backend model when keep-mic-warm is off", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // prewarm() only needs MediaRecorder to be defined; it never constructs one.
    vi.stubGlobal("MediaRecorder", class FakeMediaRecorder {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });

    const provider = new YaServerProvider("ya-nemo", "", {
      parakeetModel: "nvidia/parakeet-rnnt-1.1b",
    });
    provider.prewarm();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    provider.dispose();
  });
});

describe("browser-native speech provider", () => {
  class FakeSpeechRecognition {
    static instance: FakeSpeechRecognition | null = null;

    continuous = false;
    interimResults = false;
    lang = "";
    maxAlternatives = 1;
    onstart: ((event: Event) => void) | null = null;
    onend: ((event: Event) => void) | null = null;
    onaudiostart: ((event: Event) => void) | null = null;
    onaudioend: ((event: Event) => void) | null = null;
    onsoundstart: ((event: Event) => void) | null = null;
    onsoundend: ((event: Event) => void) | null = null;
    onspeechstart: ((event: Event) => void) | null = null;
    onspeechend: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onresult: ((event: Event) => void) | null = null;

    constructor() {
      FakeSpeechRecognition.instance = this;
    }

    start() {
      this.onstart?.(new Event("start"));
    }

    stop() {
      this.onend?.(new Event("end"));
    }

    abort() {
      this.onend?.(new Event("end"));
    }
  }

  function installFakeSpeechRecognition(): typeof FakeSpeechRecognition {
    FakeSpeechRecognition.instance = null;
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    return FakeSpeechRecognition;
  }

  it("does not expose prewarm, avoiding browser-owned recording indicators", () => {
    const provider = new BrowserNativeProvider();

    expect("prewarm" in provider).toBe(false);
  });

  it("keeps browser-native amber until Chrome reports audio capture", () => {
    const Recognition = installFakeSpeechRecognition();
    const provider = new BrowserNativeProvider();
    const states: Array<{ status: string; isListening: boolean }> = [];
    provider.subscribe((state) => states.push(state));

    provider.start();

    expect(provider.getState()).toMatchObject({
      status: "starting",
      isListening: false,
    });

    Recognition.instance?.onaudiostart?.(new Event("audiostart"));

    expect(provider.getState()).toMatchObject({
      status: "listening",
      isListening: true,
    });
    expect(states.some((state) => state.status === "listening")).toBe(true);

    provider.dispose();
  });

  it("treats browser-native results as capture evidence if audio-start is skipped", () => {
    const Recognition = installFakeSpeechRecognition();
    const onInterimResult = vi.fn();
    const provider = new BrowserNativeProvider({ onInterimResult });

    provider.start();
    expect(provider.getState().isListening).toBe(false);

    Recognition.instance?.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: false,
          0: { transcript: "hello" },
        },
      },
    } as unknown as Event);

    expect(provider.getState()).toMatchObject({
      status: "receiving",
      isListening: true,
      interimTranscript: "hello",
    });
    expect(onInterimResult).toHaveBeenCalledWith("hello");

    provider.dispose();
  });

  it("does not restart after a browser-native network error", () => {
    const Recognition = installFakeSpeechRecognition();
    const start = vi.spyOn(Recognition.prototype, "start");
    const provider = new BrowserNativeProvider();

    provider.start();
    Recognition.instance?.onerror?.({ error: "network" } as unknown as Event);
    Recognition.instance?.onend?.(new Event("end"));

    expect(start).toHaveBeenCalledTimes(1);
    expect(provider.getState()).toMatchObject({
      status: "error",
      isListening: false,
      error: "Network error - check connection",
    });

    provider.dispose();
  });
});

describe("YA server speech provider", () => {
  it("reports support for the capture path selected by streaming capability", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("AudioContext", class FakeAudioContext {});
    vi.stubGlobal("WebSocket", class FakeWebSocket {});
    vi.stubGlobal("MediaRecorder", undefined);

    expect(new YaServerProvider("ya-dummy", "").isSupported).toBe(false);
    expect(
      new YaServerProvider("ya-grok", "", { serverStreaming: true })
        .isSupported,
    ).toBe(true);
  });

  it("cancels a pending start before microphone permission resolves", async () => {
    const media = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => media.promise);
    const stopTrack = vi.fn();
    const recorderStart = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        state: RecordingState = "inactive";
        onstop: (() => void) | null = null;

        start() {
          recorderStart();
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );

    const onEnd = vi.fn();
    const onError = vi.fn();
    const onResult = vi.fn();
    const provider = new YaServerProvider("ya-dummy", "", {
      onEnd,
      onError,
      onResult,
    });

    provider.start();
    expect(provider.getState().status).toBe("starting");

    provider.stop();
    expect(provider.getState().status).toBe("idle");
    expect(onEnd).toHaveBeenCalledTimes(1);

    media.resolve(fakeStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recorderStart).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(provider.getState().status).toBe("idle");
  });

  it("passes the selected microphone device to batch capture", async () => {
    const fakeStream = {
      getTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        state: RecordingState = "inactive";
        onstop: (() => void) | null = null;

        start() {
          this.state = "recording";
        }

        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );

    const provider = new YaServerProvider("ya-dummy", "", {
      micDeviceId: "usb-mic",
    });
    provider.start();
    await Promise.resolve();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: "usb-mic" },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16_000 },
        sampleSize: { ideal: 16 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });

    provider.dispose();
  });

  it.each([
    "ya-parakeet",
    "ya-nemo",
  ] as const)("passes the selected Parakeet model to %s batch transcription", async (backendId) => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    class FakeBlob {
      readonly size: number;
      readonly type: string;

      constructor(parts: Array<{ size?: number } | string> = [], options = {}) {
        this.size = parts.reduce(
          (total, part) =>
            total + (typeof part === "string" ? part.length : (part.size ?? 1)),
          0,
        );
        this.type = (options as { type?: string }).type ?? "";
      }

      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([1]).buffer;
      }
    }

    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("btoa", () => "YXVkaW8=");

    const provider = new YaServerProvider(backendId, "", {
      parakeetModel: "nvidia/parakeet-ctc-1.1b",
    });

    provider.start();
    await vi.waitFor(() =>
      expect(provider.getState().status).toBe("listening"),
    );
    provider.stop();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      backendId,
      model: "nvidia/parakeet-ctc-1.1b",
    });

    provider.dispose();
  });

  it("keeps a stopped batch recording tied to its speech target while starting another", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const firstFetch = deferred<Response>();
    const secondFetch = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockImplementationOnce(() => secondFetch.promise);
    let currentSpeechTargetId = "target-1";

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static readonly instances: FakeMediaRecorder[] = [];

      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(
        readonly stream: MediaStream,
        readonly options: MediaRecorderOptions,
      ) {
        FakeMediaRecorder.instances.push(this);
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    class FakeBlob {
      readonly size: number;
      readonly type: string;

      constructor(parts: Array<{ size?: number } | string> = [], options = {}) {
        this.size = parts.reduce(
          (total, part) =>
            total + (typeof part === "string" ? part.length : (part.size ?? 1)),
          0,
        );
        this.type = (options as { type?: string }).type ?? "";
      }

      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([1]).buffer;
      }
    }

    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("btoa", () => "YXVkaW8=");

    const onResult = vi.fn();
    const onTranscriptionSettled = vi.fn();
    const provider = new YaServerProvider("ya-whisper", "", {
      getTranscriptionContext: () => ({
        speechTargetId: currentSpeechTargetId,
      }),
      onResult,
      onTranscriptionSettled,
    });

    provider.start();
    await waitForProviderStatus(provider, "listening");

    provider.stop();
    await Promise.resolve();
    expect(provider.getState()).toMatchObject({
      status: "processing",
      error: null,
    });

    currentSpeechTargetId = "target-2";
    provider.start();
    await waitForProviderStatus(provider, "listening");
    expect(FakeMediaRecorder.instances).toHaveLength(2);

    firstFetch.resolve(
      new Response(
        JSON.stringify({ text: "first transcript", transcriptionId: "tx-1" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("first transcript", {
        speechTargetId: "target-1",
        transcriptionId: "tx-1",
      }),
    );
    expect(onTranscriptionSettled).toHaveBeenCalledWith({
      speechTargetId: "target-1",
      status: "completed",
    });
    expect(provider.getState().status).toBe("listening");

    provider.stop();
    await Promise.resolve();
    currentSpeechTargetId = "target-3";
    provider.start();
    await waitForProviderStatus(provider, "listening");

    secondFetch.reject(new Error("model load failed"));
    await vi.waitFor(() =>
      expect(onTranscriptionSettled).toHaveBeenCalledWith({
        speechTargetId: "target-2",
        status: "error",
      }),
    );
    expect(provider.getState().status).toBe("listening");

    provider.dispose();
  });

  it("discards a batch transcription that finishes after cancel()", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const pendingFetch = deferred<Response>();
    const fetchMock = vi.fn(() => pendingFetch.promise);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    class FakeBlob {
      readonly size: number;
      readonly type: string;
      constructor(parts: Array<{ size?: number } | string> = [], options = {}) {
        this.size = parts.reduce(
          (total, part) =>
            total + (typeof part === "string" ? part.length : (part.size ?? 1)),
          0,
        );
        this.type = (options as { type?: string }).type ?? "";
      }
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([1]).buffer;
      }
    }

    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("btoa", () => "YXVkaW8=");

    const onResult = vi.fn();
    const onEnd = vi.fn();
    const onTranscriptionSettled = vi.fn();
    const provider = new YaServerProvider("ya-whisper", "", {
      getTranscriptionContext: () => ({ speechTargetId: "target-cancelled" }),
      onResult,
      onEnd,
      onTranscriptionSettled,
    });

    provider.start();
    await waitForProviderStatus(provider, "listening");

    provider.stop();
    await Promise.resolve();
    expect(provider.getState().status).toBe("processing");

    provider.cancel();
    expect(provider.getState().status).toBe("idle");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onTranscriptionSettled).toHaveBeenCalledWith({
      speechTargetId: "target-cancelled",
      status: "cancelled",
    });

    // The backend request still resolves, but the result must be a no-op.
    pendingFetch.resolve(
      new Response(JSON.stringify({ text: "late transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onResult).not.toHaveBeenCalled();
    expect(provider.getState().status).toBe("idle");

    provider.dispose();
  });

  it("suppresses the error of a batch transcription that fails after cancel()", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const pendingFetch = deferred<Response>();
    const fetchMock = vi.fn(() => pendingFetch.promise);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }

    class FakeBlob {
      readonly size: number;
      readonly type: string;
      constructor(parts: Array<{ size?: number } | string> = [], options = {}) {
        this.size = parts.reduce(
          (total, part) =>
            total + (typeof part === "string" ? part.length : (part.size ?? 1)),
          0,
        );
        this.type = (options as { type?: string }).type ?? "";
      }
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array([1]).buffer;
      }
    }

    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("btoa", () => "YXVkaW8=");

    const onResult = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();
    const provider = new YaServerProvider("ya-whisper", "", {
      onResult,
      onError,
      onEnd,
    });

    provider.start();
    await waitForProviderStatus(provider, "listening");
    provider.stop();
    expect(provider.getState().status).toBe("processing");

    provider.cancel();
    expect(provider.getState().status).toBe("idle");

    // The backend request fails after cancel: it is the slow/stuck case cancel
    // exists for, so the error must stay inert — no onError, still idle.
    pendingFetch.reject(new Error("backend timed out"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(provider.getState().status).toBe("idle");

    provider.dispose();
  });

  it("commits provider-owned streaming final segments", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const onResult = vi.fn();
    const onInterimResult = vi.fn();
    const onEnd = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};

      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);

      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }

      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }

      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onInterimResult,
      onEnd,
    });
    provider.start();

    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "interim", text: "hel", isFinal: false });
    expect(onInterimResult).toHaveBeenLastCalledWith("hel");
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({
      type: "interim",
      text: "",
      isFinal: true,
      start: 0,
      duration: 0.5,
      words: [],
    });
    expect(onInterimResult).toHaveBeenLastCalledWith("hel");
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({
      type: "interim",
      text: "hello",
      isFinal: true,
      start: 0,
      duration: 1,
      words: [{ word: "hello", start: 0, duration: 1 }],
    });
    expect(onInterimResult).toHaveBeenLastCalledWith("");
    expect(onResult).toHaveBeenLastCalledWith("hello", undefined);

    ws.receive({
      type: "interim",
      text: "Testing.",
      isFinal: true,
      start: 1,
      duration: 1,
    });
    expect(onResult).toHaveBeenLastCalledWith("Testing.", undefined);

    ws.receive({
      type: "interim",
      text: "Testing.",
      isFinal: true,
      start: 2,
      duration: 1,
    });
    expect(onResult).toHaveBeenLastCalledWith("Testing.", undefined);
    expect(onResult).toHaveBeenCalledTimes(3);

    ws.receive({ type: "interim", text: "world", isFinal: false });
    expect(onInterimResult).toHaveBeenLastCalledWith("world");

    ws.receive({
      type: "interim",
      text: "hello Testing. Testing. world",
      isFinal: true,
      speechFinal: true,
      start: 0,
      duration: 4,
      words: [
        { word: "hello", start: 0, duration: 0.5 },
        { word: "Testing.", start: 1, duration: 0.5 },
        { word: "Testing.", start: 2, duration: 0.5 },
        { word: "world", start: 3, duration: 0.5 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith("world", undefined);

    ws.receive({
      type: "interim",
      text: "Blocks",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 1.84,
      words: [{ word: "Blocks", start: 4.81, duration: 0.59 }],
    });
    expect(onResult).toHaveBeenLastCalledWith("Blocks", undefined);

    ws.receive({
      type: "interim",
      text: ", blocks",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 4.08,
      words: [
        { word: ",", start: 5.84, duration: 0.2 },
        { word: "blocks", start: 6.2, duration: 0.48 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith(", blocks", undefined);

    ws.receive({
      type: "interim",
      text: ", empty, five",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 5.3,
      words: [
        { word: ",", start: 6.84, duration: 0.2 },
        { word: "empty,", start: 7.2, duration: 0.4 },
        { word: "five", start: 7.68, duration: 0.32 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith(", empty, five", undefined);

    ws.receive({
      type: "interim",
      text: "o blocks.",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 6.16,
      words: [
        { word: "o", start: 8.14, duration: 0.2 },
        { word: "blocks.", start: 8.5, duration: 0.5 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith("o blocks.", undefined);

    ws.receive({
      type: "interim",
      text: "Empty, final.",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 8.54,
      words: [
        { word: "Empty,", start: 9.79, duration: 0.4 },
        { word: "final.", start: 10.28, duration: 0.5 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith("Empty, final.", undefined);

    ws.receive({
      type: "interim",
      text: "Blocks.",
      isFinal: true,
      speechFinal: false,
      start: 4,
      duration: 9.36,
      words: [{ word: "Blocks.", start: 11.3, duration: 0.43 }],
    });
    expect(onResult).toHaveBeenLastCalledWith("Blocks.", undefined);

    const previousSegment =
      "Blocks, blocks, empty, five o blocks. Empty, final. Blocks.";
    ws.receive({
      type: "interim",
      text: "Blocks, blocks, empty final blocks, empty final blocks.",
      isFinal: true,
      speechFinal: true,
      start: 4,
      duration: 12.02,
      words: [
        { word: "Blocks,", start: 4.82, duration: 0.5 },
        { word: "blocks,", start: 5.84, duration: 0.48 },
        { word: "empty", start: 6.84, duration: 0.4 },
        { word: "final", start: 7.68, duration: 0.4 },
        { word: "blocks,", start: 8.5, duration: 0.5 },
        { word: "empty", start: 9.79, duration: 0.4 },
        { word: "final", start: 10.28, duration: 0.5 },
        { word: "blocks.", start: 11.3, duration: 0.43 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith(
      "Blocks, blocks, empty final blocks, empty final blocks.",
      { replacePreviousTranscriptChars: previousSegment.length },
    );

    ws.receive({
      type: "interim",
      text: "Alpha",
      isFinal: true,
      speechFinal: false,
      start: 20,
      duration: 1,
      words: [{ word: "Alpha", start: 20.1, duration: 0.4 }],
    });
    expect(onResult).toHaveBeenLastCalledWith("Alpha", undefined);

    ws.receive({
      type: "interim",
      text: "Beta",
      isFinal: true,
      speechFinal: false,
      start: 21,
      duration: 1,
      words: [{ word: "Beta", start: 21.1, duration: 0.4 }],
    });
    expect(onResult).toHaveBeenLastCalledWith("Beta", undefined);

    ws.receive({
      type: "interim",
      text: "Alfa beta gamma.",
      isFinal: true,
      speechFinal: true,
      start: 20,
      duration: 2.6,
      words: [
        { word: "Alfa", start: 20.1, duration: 0.4 },
        { word: "beta", start: 21.1, duration: 0.4 },
        { word: "gamma.", start: 22.1, duration: 0.4 },
      ],
    });
    expect(onResult).toHaveBeenLastCalledWith("Alfa beta gamma.", {
      replacePreviousTranscriptChars: "Alpha Beta".length,
    });

    ws.receive({
      type: "final",
      text: "hello world",
      transcriptionId: "transcription-1",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-1",
    });
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("honors Smart Turn cancel without stopping streaming", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    const onResult = vi.fn();
    const onInterimResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      smartTurn: { enabled: true, threshold: 0.9, timeoutMs: 3000 },
      onResult,
      onInterimResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({
      type: "interim",
      text: "testing speech to text",
      isFinal: false,
    });
    expect(onInterimResult).toHaveBeenLastCalledWith("testing speech to text");

    ws.receive({
      type: "interim",
      text: "Cancel.",
      isFinal: true,
      speechFinal: true,
      start: 0,
      duration: 1,
    });

    expect(onResult).toHaveBeenLastCalledWith("", {
      smartTurnCommand: "cancel",
    });
    expect(onInterimResult).toHaveBeenLastCalledWith("");
    expect(
      ws.send.mock.calls
        .map(([payload]) =>
          typeof payload === "string" ? JSON.parse(payload) : payload,
        )
        .some((message) => message?.type === "stop"),
    ).toBe(false);
    expect(provider.getState().isListening).toBe(true);

    ws.receive({
      type: "interim",
      text: "next phrase",
      isFinal: true,
      speechFinal: false,
      start: 1,
      duration: 1,
    });
    expect(onResult).toHaveBeenLastCalledWith("next phrase", undefined);

    provider.dispose();
  });

  it("waits for stop finalization and ignores stop-flush partials", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onInterimResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onInterimResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({
      type: "interim",
      text: "does not delete the content",
      isFinal: false,
    });
    provider.stop();
    expect(provider.getState()).toMatchObject({
      status: "finalizing",
      isListening: false,
      error: null,
    });
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({
      type: "interim",
      text: "There's",
      isFinal: true,
      speechFinal: true,
    });
    expect(onResult).not.toHaveBeenCalled();

    ws.receive({
      type: "final",
      text: "does not delete the content",
      transcriptionId: "transcription-2",
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith("does not delete the content", {
      transcriptionId: "transcription-2",
    });

    provider.dispose();
  });

  it("applies Smart Turn commands to provider-owned final segments", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            // Simulate the audio clock delivering a frame so the provider
            // sees capture go live and transitions to "listening".
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      smartTurn: { enabled: true, threshold: 0.7, timeoutMs: 3000 },
      onResult,
    });
    provider.start();

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "start",
      backendId: "ya-grok",
      smartTurn: {
        enabled: true,
        threshold: 0.7,
        timeoutMs: 3000,
      },
    });

    ws.receive({
      type: "interim",
      text: "Are extra spaces appearing for final chunks? I wonder now",
      isFinal: true,
      speechFinal: false,
      start: 0,
      duration: 4,
    });
    expect(onResult).toHaveBeenLastCalledWith(
      "Are extra spaces appearing for final chunks? I wonder now",
      undefined,
    );

    ws.receive({
      type: "interim",
      text: "Are extra spaces appearing for final chunks? I wonder now. Second sentence wait",
      isFinal: true,
      speechFinal: true,
      start: 0,
      duration: 5.5,
      words: [
        { word: "Are", start: 0, duration: 0.2 },
        { word: "extra", start: 0.3, duration: 0.2 },
        { word: "spaces", start: 0.6, duration: 0.2 },
        { word: "appearing", start: 0.9, duration: 0.2 },
        { word: "for", start: 1.2, duration: 0.2 },
        { word: "final", start: 1.5, duration: 0.2 },
        { word: "chunks?", start: 1.8, duration: 0.2 },
        { word: "I", start: 2.1, duration: 0.2 },
        { word: "wonder", start: 2.4, duration: 0.2 },
        { word: "now.", start: 2.7, duration: 0.2 },
        { word: "Second", start: 4.1, duration: 0.2 },
        { word: "sentence", start: 4.4, duration: 0.2 },
        { word: "wait", start: 5.2, duration: 0.2 },
      ],
    });

    // `wait` is kept in the committed text (not stripped like `send`); the
    // hold/no-submit is carried by the smartTurnCommand on the final below.
    expect(onResult).toHaveBeenLastCalledWith(
      "Are extra spaces appearing for final chunks? I wonder now. Second sentence wait",
      {
        replacePreviousTranscriptChars:
          "Are extra spaces appearing for final chunks? I wonder now".length,
      },
    );
    expect(JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string)).toEqual({
      type: "stop",
    });

    ws.receive({
      type: "final",
      text: "Are extra spaces appearing for final chunks? I wonder now. Second sentence wait",
      transcriptionId: "transcription-smart-turn",
    });
    expect(onResult).toHaveBeenLastCalledWith("", {
      transcriptionId: "transcription-smart-turn",
      smartTurnCommand: "wait",
    });

    provider.dispose();
  });

  it("cancel during streaming discards the in-progress tail, keeps committed finals", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onEnd = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    let lastState: { status: string; isListening: boolean } | undefined;
    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onEnd,
    });
    provider.subscribe((state) => {
      lastState = state;
    });
    provider.start();
    await Promise.resolve();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;

    // A finalized block commits to the draft.
    ws.receive({
      type: "interim",
      text: "Hello world",
      isFinal: true,
      speechFinal: false,
      start: 0,
      duration: 1,
    });
    expect(onResult).toHaveBeenLastCalledWith("Hello world", undefined);

    // An in-progress, non-final tail is only previewed.
    ws.receive({
      type: "interim",
      text: "Hello world and then some",
      isFinal: false,
      start: 1,
      duration: 1,
    });

    onResult.mockClear();
    provider.cancel();
    expect(lastState?.status).toBe("idle");
    expect(lastState?.isListening).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);

    // A final racing in after cancel must be inert: the tail is dropped and the
    // turn is not submitted. The committed "Hello world" already reached the
    // draft and is untouched.
    ws.receive({
      type: "final",
      text: "Hello world and then some",
      transcriptionId: "late",
    });
    expect(onResult).not.toHaveBeenCalled();

    provider.dispose();
  });

  it("never shows listening and errors when no audio frame ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const fakeStream = {
        getTracks: () => [{ stop: vi.fn() }],
      } as unknown as MediaStream;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn(async () => fakeStream) },
      });
      const onError = vi.fn();
      const onEnd = vi.fn();
      const onResult = vi.fn();

      class FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 3;
        static readonly instances: FakeWebSocket[] = [];
        binaryType: BinaryType = "blob";
        readyState = FakeWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        send = vi.fn();
        constructor(readonly url: string) {
          FakeWebSocket.instances.push(this);
        }
        open() {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }
        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }
      }

      // A context that resumes but whose processor never fires a callback:
      // capture is dead even though state reports "running".
      class FakeAudioContext {
        readonly state = "suspended";
        readonly sampleRate = 48_000;
        readonly destination = {};
        resume = vi.fn(async () => undefined);
        close = vi.fn(async () => undefined);
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        createScriptProcessor() {
          return {
            connect: vi.fn(),
            disconnect: vi.fn(),
            onaudioprocess: null,
          };
        }
        createGain() {
          return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        }
      }

      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.stubGlobal("AudioContext", FakeAudioContext);

      let lastState: { status: string; isListening: boolean } | undefined;
      const provider = new YaServerProvider("ya-grok", "", {
        serverStreaming: true,
        onResult,
        onError,
        onEnd,
      });
      provider.subscribe((state) => {
        lastState = state;
      });
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      FakeWebSocket.instances[0]?.open();
      await vi.advanceTimersByTimeAsync(0);

      // The pipeline is wired but no frame has arrived: still not listening.
      expect(lastState?.isListening).toBe(false);
      expect(lastState?.status).not.toBe("listening");
      expect(onError).not.toHaveBeenCalled();

      // The audio-flow watchdog must surface a visible error.
      await vi.advanceTimersByTimeAsync(3500);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onResult).not.toHaveBeenCalled();
      expect(lastState?.status).toBe("error");

      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams 16 kHz PCM16 in 100ms chunks and flushes partial stop audio", async () => {
    const fakeTrack = {
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({
        sampleRate: 16_000,
        sampleSize: 16,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    let processorNode:
      | {
          onaudioprocess:
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void);
        }
      | undefined;
    const audioContextOptions: AudioContextOptions[] = [];
    const scriptProcessorArgs: Array<[number, number, number]> = [];
    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 16_000;
      readonly destination = {};
      constructor(options?: AudioContextOptions) {
        if (options) audioContextOptions.push(options);
      }
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor(
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
      ) {
        scriptProcessorArgs.push([bufferSize, inputChannels, outputChannels]);
        processorNode = {
          onaudioprocess: null,
        };
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          get onaudioprocess() {
            return processorNode?.onaudioprocess ?? null;
          },
          set onaudioprocess(callback:
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),) {
            if (processorNode) processorNode.onaudioprocess = callback;
          },
        };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      micDeviceId: "usb-mic",
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(audioContextOptions[0]).toMatchObject({
      latencyHint: "interactive",
      sampleRate: 16_000,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: "usb-mic" },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16_000 },
        sampleSize: { ideal: 16 },
      }),
    });
    expect(scriptProcessorArgs).toEqual([[1024, 1, 1]]);

    const callback = processorNode?.onaudioprocess;
    expect(callback).toBeTypeOf("function");
    const input = new Float32Array(1024).fill(0.25);
    const fireFrame = () =>
      callback?.({ inputBuffer: { getChannelData: () => input } });

    fireFrame();
    expect(
      ws.send.mock.calls.filter(([payload]) => payload instanceof Int16Array),
    ).toHaveLength(0);

    fireFrame();
    const binaryCalls = ws.send.mock.calls.filter(
      ([payload]) => payload instanceof Int16Array,
    );
    expect(binaryCalls).toHaveLength(1);
    const firstBinaryPayload = binaryCalls[0]?.[0];
    expect(firstBinaryPayload).toBeInstanceOf(Int16Array);
    const firstFrame = firstBinaryPayload as Int16Array;
    expect(firstFrame.length).toBe(1600);
    expect(firstFrame.byteLength).toBe(3200);

    provider.stop();
    expect(provider.getState()).toMatchObject({
      status: "finalizing",
      isListening: false,
      error: null,
    });
    const afterStopBinaryCalls = ws.send.mock.calls.filter(
      ([payload]) => payload instanceof Int16Array,
    );
    expect(afterStopBinaryCalls).toHaveLength(2);
    const stopFlushPayload = afterStopBinaryCalls[1]?.[0];
    expect(stopFlushPayload).toBeInstanceOf(Int16Array);
    expect((stopFlushPayload as Int16Array).length).toBe(448);

    provider.dispose();
  });

  it("keeps a warm streaming mic open across dictations and backend switches", async () => {
    let stopped = false;
    const stopTrack = vi.fn(() => {
      stopped = true;
    });
    const fakeTrack = {
      get readyState() {
        return stopped ? "ended" : "live";
      },
      stop: stopTrack,
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      keepMicWarm: true,
    });
    const waitForListening = async () => {
      for (
        let i = 0;
        i < 10 && provider.getState().status !== "listening";
        i += 1
      ) {
        await Promise.resolve();
      }
    };

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await waitForListening();
    expect(provider.getState().status).toBe("listening");

    provider.stop();
    expect(provider.getState().status).toBe("finalizing");
    expect(stopTrack).not.toHaveBeenCalled();
    FakeWebSocket.instances[0]?.receive({ type: "final", text: "" });
    expect(provider.getState().status).toBe("idle");

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[1]?.open();
    await waitForListening();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(provider.getState().status).toBe("listening");

    provider.dispose();
    expect(stopTrack).not.toHaveBeenCalled();

    const replacement = new YaServerProvider("ya-deepgram", "", {
      serverStreaming: true,
      keepMicWarm: true,
    });
    replacement.start();
    await Promise.resolve();
    FakeWebSocket.instances[2]?.open();
    for (
      let i = 0;
      i < 10 && replacement.getState().status !== "listening";
      i += 1
    ) {
      await Promise.resolve();
    }
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(replacement.getState().status).toBe("listening");

    replacement.dispose();
    expect(stopTrack).not.toHaveBeenCalled();
    releaseSharedSpeechMicStream();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("releases an idle warm mic while hidden and reacquires when visible", async () => {
    localStorage.setItem(UI_KEYS.speechKeepMicWarm, "true");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    let firstStopped = false;
    let secondStopped = false;
    const firstTrack = {
      get readyState() {
        return firstStopped ? "ended" : "live";
      },
      stop: vi.fn(() => {
        firstStopped = true;
      }),
    } as unknown as MediaStreamTrack;
    const secondTrack = {
      get readyState() {
        return secondStopped ? "ended" : "live";
      },
      stop: vi.fn(() => {
        secondStopped = true;
      }),
    } as unknown as MediaStreamTrack;
    const firstStream = {
      getTracks: () => [firstTrack],
    } as unknown as MediaStream;
    const secondStream = {
      getTracks: () => [secondTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    await expect(getSpeechMicStream({ keepWarm: true })).resolves.toBe(
      firstStream,
    );
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(secondTrack.stop).not.toHaveBeenCalled();

    releaseSharedSpeechMicStream();
    expect(secondTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("retries visible warm mic reacquire after the previous tab lease releases", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(UI_KEYS.speechKeepMicWarm, "true");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });

      let firstStopped = false;
      let secondStopped = false;
      const firstTrack = {
        get readyState() {
          return firstStopped ? "ended" : "live";
        },
        stop: vi.fn(() => {
          firstStopped = true;
        }),
      } as unknown as MediaStreamTrack;
      const secondTrack = {
        get readyState() {
          return secondStopped ? "ended" : "live";
        },
        stop: vi.fn(() => {
          secondStopped = true;
        }),
      } as unknown as MediaStreamTrack;
      const firstStream = {
        getTracks: () => [firstTrack],
      } as unknown as MediaStream;
      const secondStream = {
        getTracks: () => [secondTrack],
      } as unknown as MediaStream;
      const getUserMedia = vi
        .fn<() => Promise<MediaStream>>()
        .mockResolvedValueOnce(firstStream)
        .mockResolvedValueOnce(secondStream);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
      });

      await expect(getSpeechMicStream({ keepWarm: true })).resolves.toBe(
        firstStream,
      );

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(firstTrack.stop).toHaveBeenCalledTimes(1);

      localStorage.setItem(
        SHARED_SPEECH_MIC_LEASE_STORAGE_KEY,
        JSON.stringify({
          ownerId: "previous-visible-tab",
          expiresAt: Date.now() + 10_000,
        }),
      );
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(199);
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      localStorage.removeItem(SHARED_SPEECH_MIC_LEASE_STORAGE_KEY);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(secondTrack.stop).not.toHaveBeenCalled();

      releaseSharedSpeechMicStream();
      expect(secondTrack.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release active shared mic capture when the page is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    let stopped = false;
    const stopTrack = vi.fn(() => {
      stopped = true;
    });
    const fakeTrack = {
      get readyState() {
        return stopped ? "ended" : "live";
      },
      stop: stopTrack,
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeTrack],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    const releaseActive = acquireSharedSpeechMicActiveLease();
    await expect(getSpeechMicStream({ keepWarm: true })).resolves.toBe(
      fakeStream,
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stopTrack).not.toHaveBeenCalled();

    releaseActive();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("does not open an idle warm mic when another visible tab has the lease", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    localStorage.setItem(
      SHARED_SPEECH_MIC_LEASE_STORAGE_KEY,
      JSON.stringify({
        ownerId: "other-tab",
        expiresAt: Date.now() + 10_000,
      }),
    );
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    await expect(getSpeechMicStream({ keepWarm: true })).rejects.toThrow(
      "Another visible YA tab owns the idle warm microphone",
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps a pending pointer-near warm mic pre-open across provider disposal", async () => {
    const media = deferred<MediaStream>();
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => media.promise);
    const query = vi.fn(async () => ({ state: "granted" }));

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query },
    });
    vi.stubGlobal("WebSocket", class FakeWebSocket {});
    vi.stubGlobal("AudioContext", class FakeAudioContext {});

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      keepMicWarm: true,
      micDeviceId: "usb-mic",
    });
    provider.prewarm();
    provider.prewarm();
    await Promise.resolve();
    await Promise.resolve();
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: "usb-mic" },
      }),
    });

    provider.dispose();
    media.resolve(fakeStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrack).not.toHaveBeenCalled();
    releaseSharedSpeechMicStream();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops the streaming mic on stop when warm mic is disabled", async () => {
    const stopTrack = vi.fn();
    const fakeStream = {
      getTracks: () => [{ readyState: "live", stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
    });

    provider.start();
    await Promise.resolve();
    FakeWebSocket.instances[0]?.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.getState().status).toBe("listening");

    provider.stop();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("salvages the preview when the stream errors mid-session", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() =>
              node.onaudioprocess?.({
                inputBuffer: { getChannelData: () => new Float32Array(4096) },
              }),
            );
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | null
            | ((event: {
                inputBuffer: { getChannelData: () => Float32Array };
              }) => void),
        };
        return node;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onError,
      onEnd,
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "interim", text: "hello world", isFinal: false });
    // Upstream gives up while the user paused: the words must not be lost.
    ws.receive({ type: "error", message: "xAI STT streaming timed out" });

    expect(onResult).toHaveBeenLastCalledWith("hello world", undefined);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("surfaces a mid-session error when there is nothing to salvage", async () => {
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const onResult = vi.fn();
    const onError = vi.fn();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      binaryType: BinaryType = "blob";
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      send = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
      receive(message: unknown) {
        this.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
    }

    class FakeAudioContext {
      readonly state = "running";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const provider = new YaServerProvider("ya-grok", "", {
      serverStreaming: true,
      onResult,
      onError,
    });
    provider.start();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await Promise.resolve();
    await Promise.resolve();

    ws.receive({ type: "error", message: "xAI STT streaming timed out" });

    expect(onError).toHaveBeenCalledWith("xAI STT streaming timed out");
    expect(onResult).not.toHaveBeenCalled();

    provider.dispose();
  });
});

describe("direct xAI speech provider", () => {
  it("streams PCM directly to xAI with browser WebSocket subprotocol auth", async () => {
    setBrowserXaiSttApiKey("browser-xai-key");
    const fakeTrackStop = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: fakeTrackStop, readyState: "live" }],
      getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16000 }) }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];

      readyState = FakeWebSocket.OPEN;
      bufferedAmount = 0;
      binaryType = "";
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];

      constructor(
        readonly url: string,
        readonly protocols?: string | string[],
      ) {
        FakeWebSocket.instances.push(this);
      }

      send(data: string | ArrayBuffer | ArrayBufferView) {
        this.sent.push(data);
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
      }

      receive(message: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }

    class FakeAudioContext {
      state: AudioContextState = "running";
      sampleRate = 16_000;
      destination = {};

      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }

      createScriptProcessor() {
        const node = {
          connect: vi.fn(() => {
            queueMicrotask(() => {
              node.onaudioprocess?.({
                inputBuffer: {
                  getChannelData: () => new Float32Array(1600).fill(0.25),
                },
              } as unknown as AudioProcessingEvent);
            });
          }),
          disconnect: vi.fn(),
          onaudioprocess: null as
            | ((event: AudioProcessingEvent) => void)
            | null,
        };
        return node;
      }

      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }

      close() {
        return Promise.resolve();
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const onResult = vi.fn();
    const onEnd = vi.fn();
    const provider = new DirectXaiStreamingSpeechProvider({
      smartTurn: { enabled: true, threshold: 0.5, timeoutMs: 1000 },
      onResult,
      onEnd,
    });

    provider.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("wss://api.x.ai/v1/stt?");
    expect(ws.url).toContain("sample_rate=16000");
    expect(ws.url).toContain("smart_turn=0.5");
    expect(ws.protocols).toEqual(["xai-client-secret.browser-xai-key"]);

    ws.receive({ type: "transcript.created" });
    await Promise.resolve();

    expect(provider.getState().status).toBe("listening");
    expect(ws.sent.some((data) => typeof data !== "string")).toBe(true);

    ws.receive({
      type: "transcript.partial",
      text: "Okay.",
      is_final: true,
      speech_final: true,
    });
    expect(onResult).toHaveBeenCalledWith("Okay.", undefined);
    ws.receive({
      type: "transcript.partial",
      text: "Does it work",
      is_final: true,
      speech_final: false,
      start: 1,
      duration: 1,
      words: [
        { word: "Does", start: 1, duration: 0.2 },
        { word: "it", start: 1.2, duration: 0.2 },
        { word: "work", start: 1.4, duration: 0.2 },
      ],
    });
    ws.receive({
      type: "transcript.partial",
      text: "at all?",
      is_final: true,
      speech_final: true,
      start: 2,
      duration: 1,
      words: [
        { word: "at", start: 2, duration: 0.2 },
        { word: "all?", start: 2.2, duration: 0.2 },
      ],
    });

    expect(ws.sent).toContain(JSON.stringify({ type: "audio.done" }));
    ws.receive({
      type: "transcript.done",
      text: "",
    });
    await Promise.resolve();

    expect(onResult).toHaveBeenCalledWith("Does it work", undefined);
    expect(onResult).toHaveBeenCalledWith("at all?", {
      smartTurnCommand: "send",
      // No spoken command word, so this endpoint send is automatic — the
      // composer may hold it when the user has typed mid-dictation.
      smartTurnAutoSend: true,
    });
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("posts recorded batch audio directly to xAI with the browser key", async () => {
    setBrowserXaiSttApiKey("browser-xai-key");
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn(), readyState: "live" }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => fakeStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(
        readonly stream: MediaStream,
        readonly options: MediaRecorderOptions,
      ) {}

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: "direct transcript" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onResult = vi.fn();
    const onEnd = vi.fn();
    const onTranscriptionSettled = vi.fn();
    const provider = new DirectXaiSpeechProvider({
      micDeviceId: "usb-mic",
      getTranscriptionContext: () => ({ speechTargetId: "direct-target" }),
      onResult,
      onEnd,
      onTranscriptionSettled,
    });

    provider.start();
    await waitForProviderStatus(provider, "listening");

    provider.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: "usb-mic" },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16_000 },
        sampleSize: { ideal: 16 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.x.ai/v1/stt",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer browser-xai-key" },
      }),
    );
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("format")).toBe("true");
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("direct transcript", {
        speechTargetId: "direct-target",
      }),
    );
    expect(onTranscriptionSettled).toHaveBeenCalledWith({
      speechTargetId: "direct-target",
      status: "completed",
    });
    expect(onEnd).toHaveBeenCalledTimes(1);

    provider.dispose();
  });
});
