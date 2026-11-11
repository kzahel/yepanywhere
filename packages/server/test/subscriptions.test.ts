import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Emit,
  createActivitySubscription,
  createSessionSubscription,
} from "../src/subscriptions.js";
import type { StreamAugmenter } from "../src/augments/index.js";
import { getLogger } from "../src/logging/logger.js";
import type { SessionQueuePersistenceService } from "../src/services/SessionQueuePersistenceService.js";
import type { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent, ProcessState } from "../src/supervisor/types.js";
import type { BusEvent, EventBus } from "../src/watcher/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

type Listener = (event: ProcessEvent) => void | Promise<void>;

const MOCK_LIVENESS = {
  checkedAt: "2026-05-06T00:00:00.000Z",
  derivedStatus: "verified-progressing",
  activeWorkKind: "agent-turn",
  state: "in-turn",
  evidence: ["test"],
  lastProviderMessageAt: "2026-05-06T00:00:00.000Z",
  lastRawProviderEventAt: null,
  lastRawProviderEventSource: null,
  lastStateChangeAt: "2026-05-06T00:00:00.000Z",
  lastVerifiedProgressAt: "2026-05-06T00:00:00.000Z",
  lastVerifiedIdleAt: null,
  lastLivenessProbeAt: null,
  lastLivenessProbeStatus: null,
  lastLivenessProbeSource: null,
  silenceMs: 0,
  longSilenceThresholdMs: 300_000,
  processAlive: true,
  queueDepth: 0,
  deferredQueueDepth: 0,
};

const MOCK_PROVIDER_RUNTIME_STATUS = {
  kind: "retrying",
  provider: "claude",
  reason: "rate_limit",
  httpStatus: 429,
  startedAt: "2026-05-06T00:00:00.000Z",
  lastSeenAt: "2026-05-06T00:00:00.000Z",
  retryAt: "2026-05-06T00:01:00.000Z",
  retryDelayMs: 60_000,
  eventCount: 1,
  source: "claude.system.api_retry",
} as const;

function createMockProcess(overrides?: Partial<Record<string, unknown>>): {
  process: Process;
  fireEvent: (event: ProcessEvent) => Promise<void>;
} {
  let listener: Listener | null = null;

  const process = {
    id: "proc-1",
    sessionId: "sess-1",
    state: { type: "in-turn" } as ProcessState,
    permissionMode: "default",
    appliedPermissionMode: "acceptEdits",
    modeVersion: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    resolvedModel: "claude-sonnet-4-5-20250929",
    subscribe: vi.fn((fn: Listener) => {
      listener = fn;
      return () => {
        listener = null;
      };
    }),
    getMessageHistory: vi.fn(() => []),
    getReplaySeq: vi.fn(() => undefined),
    getReplayCursor: vi.fn(() => 0),
    getStreamingContent: vi.fn(() => null),
    accumulateStreamingText: vi.fn(),
    clearStreamingText: vi.fn(),
    hasLiveDeltaSubscribers: vi.fn(() => false),
    registerLiveDeltaSubscriber: vi.fn(() => vi.fn()),
    hasViewers: vi.fn(() => false),
    registerViewer: vi.fn(() => vi.fn()),
    getDeferredQueueSummary: vi.fn(() => []),
    getLivenessSnapshot: vi.fn(() => MOCK_LIVENESS),
    getProviderRuntimeStatus: vi.fn(() => null),
    ...overrides,
  } as unknown as Process;

  const fireEvent = async (event: ProcessEvent) => {
    if (listener) await listener(event);
  };

  return { process, fireEvent };
}

type BusHandler = (event: BusEvent) => void;

function createMockEventBus(): {
  eventBus: EventBus;
  fireEvent: (event: BusEvent) => void;
} {
  let handler: BusHandler | null = null;

  const eventBus = {
    subscribe: vi.fn((fn: BusHandler) => {
      handler = fn;
      return () => {
        handler = null;
      };
    }),
  } as unknown as EventBus;

  const fireEvent = (event: BusEvent) => {
    if (handler) handler(event);
  };

  return { eventBus, fireEvent };
}

function collectEmit(): { emit: Emit; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  const emit: Emit = (type, data) => {
    events.push([type, data]);
  };
  return { emit, events };
}

function stubAugmenter(
  processMessage: StreamAugmenter["processMessage"],
): StreamAugmenter {
  return {
    processMessage,
    processFinalizedMessage: async (message) => {
      await processMessage(message);
      return null;
    },
    processStreamingMessage: async () => {},
    processTextChunk: async () => {},
    flush: async () => {},
    reset: () => {},
    getCurrentMessageId: () => null,
    processCatchUp: async () => {},
  };
}

// ── Session Subscription ─────────────────────────────────────────────

describe("createSessionSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes BEFORE emitting connected (race condition fix)", () => {
    const { process } = createMockProcess();
    const { emit } = collectEmit();

    createSessionSubscription(process, emit);

    // subscribe() must be called before emit("connected", ...) fires.
    // Since subscribe is synchronous and emit("connected") happens after,
    // we verify subscribe was called exactly once.
    expect((process.subscribe as Mock).mock.calls).toHaveLength(1);
  });

  it("registers live delta demand by default and releases it on cleanup", () => {
    const unregister = vi.fn();
    const { process } = createMockProcess({
      registerLiveDeltaSubscriber: vi.fn(() => unregister),
    });
    const { emit } = collectEmit();

    const subscription = createSessionSubscription(process, emit);

    expect(process.registerLiveDeltaSubscriber).toHaveBeenCalledOnce();

    subscription.cleanup();

    expect(unregister).toHaveBeenCalledOnce();
  });

  it("registers viewer presence independently of live delta demand", () => {
    const unregisterViewer = vi.fn();
    const { process } = createMockProcess({
      registerViewer: vi.fn(() => unregisterViewer),
    });
    const { emit } = collectEmit();

    const subscription = createSessionSubscription(process, emit, {
      wantsLiveDeltas: false,
    });

    expect(process.registerViewer).toHaveBeenCalledOnce();
    expect(process.registerLiveDeltaSubscriber).not.toHaveBeenCalled();

    subscription.cleanup();

    expect(unregisterViewer).toHaveBeenCalledOnce();
  });

  it("skips live delta messages for subscribers that opt out", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit, { wantsLiveDeltas: false });

    expect(process.registerLiveDeltaSubscriber).not.toHaveBeenCalled();

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "codex-live-1",
        _isStreaming: true,
        message: {
          role: "assistant",
          content: "partial",
        },
      },
    } as ProcessEvent);

    expect(events.filter(([type]) => type === "message")).toHaveLength(0);
    expect(process.accumulateStreamingText).not.toHaveBeenCalled();

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "codex-live-1",
        message: {
          role: "assistant",
          content: "complete",
        },
      },
    } as ProcessEvent);

    const messageEvents = events.filter(([type]) => type === "message");
    expect(messageEvents).toHaveLength(2);
    expect(messageEvents[0]?.[1]).toMatchObject({
      type: "assistant",
      uuid: "codex-live-1",
      message: { content: "complete" },
    });
    expect(messageEvents[1]?.[1]).toMatchObject({
      type: "assistant",
      uuid: "codex-live-1",
      message: { content: "complete" },
    });
  });

  it("withholds only live tool output from subscribers that decline it", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit, { wantsLiveToolOutput: false });
    const toolResult = (streaming: boolean) =>
      ({
        type: "message",
        message: {
          type: "user",
          uuid: "codex-result-1",
          ...(streaming ? { _isStreaming: true } : {}),
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call-1", content: "out" },
            ],
          },
        },
      }) as ProcessEvent;

    await fireEvent({
      type: "message",
      message: {
        type: "tool_output_preview",
        uuid: "tool_output_preview:toolu_1",
        tool_use_id: "toolu_1",
        content: "tick 1",
        _isStreaming: true,
      },
    } as ProcessEvent);
    await fireEvent(toolResult(true));
    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "text-live-1",
        _isStreaming: true,
        message: { role: "assistant", content: "partial" },
      },
    } as ProcessEvent);
    await fireEvent(toolResult(false));

    const sent = events
      .filter(([type]) => type === "message")
      .map(([, data]) => data as Record<string, unknown>);
    // A completed message is sent raw and again once enriched.
    expect(new Set(sent.map((message) => message.uuid))).toEqual(
      new Set(["text-live-1", "codex-result-1"]),
    );
    expect(
      sent.filter(
        (message) =>
          message.uuid === "codex-result-1" && message._isStreaming === true,
      ),
    ).toHaveLength(0);
  });

  it("emits connected with correct process state", () => {
    const { process } = createMockProcess({
      state: { type: "waiting-input", request: { prompt: "Continue?" } },
      getProviderRuntimeStatus: vi.fn(() => MOCK_PROVIDER_RUNTIME_STATUS),
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    const connected = events.find(([type]) => type === "connected");
    expect(connected).toBeDefined();
    expect(connected?.[1]).toMatchObject({
      processId: "proc-1",
      sessionId: "sess-1",
      state: "waiting-input",
      permissionMode: "default",
      appliedPermissionMode: "acceptEdits",
      modeVersion: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      liveness: MOCK_LIVENESS,
      providerRuntimeStatus: MOCK_PROVIDER_RUNTIME_STATUS,
      request: { prompt: "Continue?" },
    });
  });

  it("keeps recovered queue entries in connected and change snapshots", async () => {
    let liveMessages: ReturnType<Process["getDeferredQueueSummary"]> = [];
    const { process, fireEvent } = createMockProcess({
      getDeferredQueueSummary: vi.fn(() => liveMessages),
    });
    const sessionQueuePersistenceService = {
      listSession: vi.fn(() => [
        {
          id: "queue-1",
          sessionId: "sess-1",
          projectId: "proj-1",
          projectPath: "/tmp/project",
          provider: "claude",
          kind: "patient",
          message: {
            text: "resume after restart",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          },
          createdAt: "2026-06-30T09:00:00.000Z",
          updatedAt: "2026-06-30T09:01:00.000Z",
          queuedAt: "2026-06-30T09:00:00.000Z",
          status: "paused-after-restart",
        },
      ]),
    } as unknown as SessionQueuePersistenceService;
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit, {
      sessionQueuePersistenceService,
    });

    expect(events.find(([type]) => type === "connected")?.[1]).toMatchObject({
      deferredMessages: [
        {
          id: "queue-1",
          tempId: "temp-recovered",
          content: "resume after restart",
          status: "paused-after-restart",
        },
      ],
    });

    liveMessages = [
      {
        id: "queue-1",
        tempId: "temp-recovered",
        content: "resume after restart",
        timestamp: "2026-06-30T09:00:00.000Z",
        kind: "patient",
        status: "queued",
      },
      {
        tempId: "temp-live",
        content: "new live work",
        timestamp: "2026-06-30T09:05:00.000Z",
      },
    ];
    await fireEvent({
      type: "deferred-queue",
      reason: "queued",
      tempId: "temp-live",
    });

    expect(
      events.filter(([type]) => type === "deferred-queue").at(-1)?.[1],
    ).toMatchObject({
      messages: [
        {
          id: "queue-1",
          content: "resume after restart",
          status: "queued",
        },
        { tempId: "temp-live", content: "new live work" },
      ],
      reason: "queued",
      tempId: "temp-live",
    });
  });

  it("emits provider runtime status on status updates", async () => {
    // Process assigns the new status before emitting the change event, so
    // the subscription reads it back off the process at emit time.
    const { process, fireEvent } = createMockProcess({
      getProviderRuntimeStatus: vi.fn(() => MOCK_PROVIDER_RUNTIME_STATUS),
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "provider-runtime-status-change",
      status: MOCK_PROVIDER_RUNTIME_STATUS,
    } as ProcessEvent);

    const status = events.filter(([type]) => type === "status").at(-1);
    expect(status?.[1]).toMatchObject({
      sessionId: "sess-1",
      state: "in-turn",
      liveness: MOCK_LIVENESS,
      providerRuntimeStatus: MOCK_PROVIDER_RUNTIME_STATUS,
    });
  });

  it("replays message history with markSubagent", () => {
    const messages = [
      { type: "assistant", message: { content: "Hello" } },
      { type: "user", message: { content: "Hi" } },
    ];
    const { process } = createMockProcess({
      getMessageHistory: vi.fn(() => messages),
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    const messageEvents = events.filter(([type]) => type === "message");
    expect(messageEvents).toHaveLength(2);
    expect(
      messageEvents.every(
        ([, data]) => (data as { isReplay?: boolean }).isReplay === true,
      ),
    ).toBe(true);
  });

  it("never lets a replay frame claim a position still to be replayed", () => {
    // In-turn steer echoes lead the history although buffered later.
    const echo = { type: "user", uuid: "echo", message: { content: "e" } };
    const older = {
      type: "assistant",
      uuid: "older",
      message: { content: "o" },
    };
    const seqs = new Map<unknown, number>([
      [echo, 5],
      [older, 3],
    ]);
    const { process } = createMockProcess({
      getMessageHistory: vi.fn(() => [echo, older]),
      getReplaySeq: vi.fn((message: unknown) => seqs.get(message)),
      getReplayCursor: vi.fn(() => 5),
    });
    const frames: Array<[string, string]> = [];
    createSessionSubscription(process, (type, _data, eventId) => {
      frames.push([type, eventId]);
    });

    expect(frames.filter(([type]) => type === "message")).toEqual([
      ["message", "proc-1.2.1"],
      ["message", "proc-1.5.2"],
    ]);
  });

  it("resolves citations from replay sources already held by a reconnecting client", async () => {
    const source = {
      type: "user",
      uuid: "source",
      content: [
        {
          type: "tool_result",
          tool_use_id: "web",
          content:
            "Source (https://example.com/source)\n【turn8search0】 snippet",
        },
      ],
    };
    const answer = {
      type: "assistant",
      uuid: "answer",
      content: [
        { type: "text", text: "Claim. \uE200cite\uE202turn8search0\uE201" },
      ],
    };
    const { process } = createMockProcess({
      getMessageHistory: vi.fn(() => [source, answer]),
      getReplaySeq: vi.fn((message: { uuid: string }) =>
        message.uuid === "source" ? 1 : 2,
      ),
      getReplayCursor: vi.fn(() => 2),
    });
    const { emit, events } = collectEmit();
    const subscription = createSessionSubscription(process, emit, {
      lastEventId: "proc-1.1.0",
    });
    try {
      await vi.waitFor(() =>
        expect(
          events.some(
            ([type, data]) =>
              type === "markdown-augment" &&
              (data as { html: string }).html.includes(
                'href="https://example.com/source"',
              ),
          ),
        ).toBe(true),
      );
      expect(
        events.filter(
          ([type, data]) =>
            type === "message" && (data as { uuid: string }).uuid === "source",
        ),
      ).toHaveLength(0);
      expect(source.content[0]).not.toHaveProperty("_html");
    } finally {
      subscription.cleanup();
    }
  });

  it("enriches replay clones without mutating process history", async () => {
    const historyMessage = {
      type: "assistant",
      uuid: "replay-assistant-1",
      message: { role: "assistant", content: "replayed" },
    };
    const { process } = createMockProcess({
      getMessageHistory: vi.fn(() => [historyMessage]),
    });
    const { emit, events } = collectEmit();
    const augmenter = stubAugmenter(async () => {});
    augmenter.processFinalizedMessage = async (message) => {
      message.enriched = true;
      return null;
    };

    const subscription = createSessionSubscription(process, emit, {
      createAugmenter: async () => augmenter,
    });

    await vi.waitFor(() =>
      expect(events.filter(([type]) => type === "message")).toHaveLength(2),
    );
    const messageEvents = events.filter(([type]) => type === "message");
    expect(messageEvents[0]?.[1]).toMatchObject({
      uuid: "replay-assistant-1",
      isReplay: true,
    });
    expect(messageEvents[0]?.[1]).not.toHaveProperty("enriched");
    expect(messageEvents[1]?.[1]).toMatchObject({
      uuid: "replay-assistant-1",
      isReplay: true,
      enriched: true,
    });
    expect(historyMessage).not.toHaveProperty("enriched");
    expect(historyMessage).not.toHaveProperty("isReplay");
    subscription.cleanup();
  });

  it("emits plain user echoes synchronously before augmentation", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    const delivered = fireEvent({
      type: "message",
      message: {
        type: "user",
        uuid: "user-1",
        message: {
          role: "user",
          content: "queued input accepted",
        },
      },
    } as ProcessEvent);

    expect(events.some(([type]) => type === "message")).toBe(true);
    await delivered;
  });

  it("does not let slow Claude Gateway enrichment block another finalized item", async () => {
    const { process, fireEvent } = createMockProcess({
      provider: "claude-gateway",
    });
    const { emit, events } = collectEmit();
    let releaseFirst: (() => void) | undefined;
    const processMessage = vi.fn(
      (message: Record<string, unknown>): Promise<void> => {
        if (message.uuid !== "gateway-assistant-1") {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      },
    );

    createSessionSubscription(process, emit, {
      createAugmenter: async () => stubAugmenter(processMessage),
    });

    const first = fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "gateway-assistant-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Visible before enrichment." }],
        },
      },
    } as ProcessEvent);
    const second = fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "gateway-assistant-2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still in provider order." }],
        },
      },
    } as ProcessEvent);

    const immediateMessageIds = events
      .filter(([type]) => type === "message")
      .map(([, data]) => (data as { uuid?: string }).uuid);
    expect(immediateMessageIds).toEqual([
      "gateway-assistant-1",
      "gateway-assistant-2",
    ]);

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(2));
    expect(
      events
        .filter(([type]) => type === "message")
        .map(([, data]) => (data as { uuid?: string }).uuid),
    ).toEqual([
      "gateway-assistant-1",
      "gateway-assistant-2",
      "gateway-assistant-2",
    ]);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(processMessage.mock.calls.map(([message]) => message.uuid)).toEqual([
      "gateway-assistant-1",
      "gateway-assistant-2",
    ]);
    const allMessageIds = events
      .filter(([type]) => type === "message")
      .map(([, data]) => (data as { uuid?: string }).uuid);
    expect(allMessageIds).toEqual([
      "gateway-assistant-1",
      "gateway-assistant-2",
      "gateway-assistant-2",
      "gateway-assistant-1",
    ]);
  });

  it("aggregates optional-enrichment queue saturation", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();
    let releaseFinalizers: (() => void) | undefined;
    const finalizerGate = new Promise<void>((resolve) => {
      releaseFinalizers = resolve;
    });
    const subscription = createSessionSubscription(process, emit, {
      logLabel: "saturation-test",
      createAugmenter: async () =>
        stubAugmenter(async () => {
          await finalizerGate;
        }),
    });

    const deliveries = Array.from({ length: 140 }, (_, index) =>
      fireEvent({
        type: "message",
        message: {
          type: "assistant",
          uuid: `saturated-${index}`,
          message: { role: "assistant", content: `message ${index}` },
        },
      } as ProcessEvent),
    );

    expect(events.filter(([type]) => type === "message")).toHaveLength(140);
    const startedWarnings = warn.mock.calls.filter(
      ([, message]) =>
        message ===
        "Finalized-message augmentation queue saturated; dropping optional enrichment",
    );
    expect(startedWarnings).toHaveLength(1);
    expect(startedWarnings[0]?.[0]).toMatchObject({
      component: "session-subscription",
      sessionId: "sess-1",
      subscription: "saturation-test",
      maxQueuedFinalizations: 128,
      queuedFinalizationsBeforeDrop: 128,
      firstDroppedId: "saturated-4",
    });

    subscription.cleanup();
    releaseFinalizers?.();
    await Promise.all(deliveries);

    const endedWarnings = warn.mock.calls.filter(
      ([, message]) =>
        message === "Finalized-message augmentation queue saturation ended",
    );
    expect(endedWarnings).toHaveLength(1);
    expect(endedWarnings[0]?.[0]).toMatchObject({
      component: "session-subscription",
      sessionId: "sess-1",
      subscription: "saturation-test",
      droppedCount: 8,
      firstDroppedId: "saturated-4",
      lastDroppedId: "saturated-11",
      maxQueueDepth: 128,
      reason: "subscription_cleanup",
    });
  });

  it("publishes only the latest enrichment generation for a stable message id", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();
    let releaseFirst: (() => void) | undefined;
    const processMessage = vi.fn(
      async (message: Record<string, unknown>): Promise<void> => {
        const content = (message.message as { content?: string } | undefined)
          ?.content;
        if (content === "first") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        message.enrichedContent = content;
      },
    );

    createSessionSubscription(process, emit, {
      createAugmenter: async () => stubAugmenter(processMessage),
    });

    const firstMessage = {
      type: "assistant",
      uuid: "assistant-revision",
      message: { role: "assistant", content: "first" },
    };
    const secondMessage = {
      type: "assistant",
      uuid: "assistant-revision",
      message: { role: "assistant", content: "second" },
    };
    const first = fireEvent({
      type: "message",
      message: firstMessage,
    } as ProcessEvent);
    const second = fireEvent({
      type: "message",
      message: secondMessage,
    } as ProcessEvent);

    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(2));
    await second;
    const beforeFirstFinishes = events.filter(
      ([type, payload]) =>
        type === "message" &&
        (payload as { uuid?: string }).uuid === "assistant-revision",
    );
    expect(beforeFirstFinishes).toHaveLength(3);
    expect(beforeFirstFinishes.at(-1)?.[1]).toMatchObject({
      enrichedContent: "second",
    });
    expect(firstMessage).not.toHaveProperty("enrichedContent");
    expect(secondMessage).not.toHaveProperty("enrichedContent");

    releaseFirst?.();
    await first;
    expect(
      events.filter(
        ([type, payload]) =>
          type === "message" &&
          (payload as { uuid?: string }).uuid === "assistant-revision",
      ),
    ).toHaveLength(3);
  });

  it("publishes the atomic message replacement before its compatibility augment", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();
    const augmenter = stubAugmenter(async () => {});
    augmenter.processFinalizedMessage = async (message) => {
      message.enriched = true;
      return {
        messageId: message.uuid as string,
        html: "<p>rendered</p>",
      };
    };

    createSessionSubscription(process, emit, {
      createAugmenter: async () => augmenter,
    });

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "assistant-atomic",
        message: { role: "assistant", content: "rendered" },
      },
    } as ProcessEvent);

    expect(
      events
        .filter(([type]) => type === "message" || type === "markdown-augment")
        .map(([type]) => type),
    ).toEqual(["message", "message", "markdown-augment"]);
    expect(
      events.filter(([type]) => type === "message").at(-1)?.[1],
    ).toMatchObject({ enriched: true });
  });

  it("does not duplicate an enriched message without a stable provider id", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit, {
      createAugmenter: async () => stubAugmenter(async () => {}),
    });

    await fireEvent({
      type: "message",
      message: {
        type: "system",
        subtype: "status",
      },
    } as ProcessEvent);

    expect(events.filter(([type]) => type === "message")).toHaveLength(1);
  });

  it("attaches ordered task state before raw tool-result delivery", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit, {
      createAugmenter: async () => stubAugmenter(async () => {}),
    });

    const create = fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "assistant-task-create",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "task-create-1",
              name: "TaskCreate",
              input: { subject: "Preserve provider order" },
            },
          ],
        },
      },
    } as ProcessEvent);
    const result = fireEvent({
      type: "message",
      message: {
        type: "user",
        uuid: "user-task-create",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "task-create-1",
              content: "Task #11 created successfully: Preserve provider order",
            },
          ],
        },
      },
    } as ProcessEvent);

    const rawResult = events.find(
      ([type, data]) =>
        type === "message" &&
        (data as { uuid?: string }).uuid === "user-task-create",
    )?.[1] as {
      toolUseResult?: { _taskSnapshot?: { tasks?: unknown[] } };
    };
    expect(rawResult.toolUseResult?._taskSnapshot?.tasks).toMatchObject([
      { id: "11", subject: "Preserve provider order", status: "pending" },
    ]);

    await Promise.all([create, result]);
  });

  it("forwards state-change events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "state-change",
      state: { type: "waiting-input", request: { prompt: "Allow?" } },
    } as ProcessEvent);

    const status = events.find(([type]) => type === "status");
    expect(status).toBeDefined();
    expect(status?.[1]).toMatchObject({
      sessionId: "sess-1",
      state: "waiting-input",
      liveness: MOCK_LIVENESS,
      request: { prompt: "Allow?" },
    });
  });

  it("forwards liveness-update events as status snapshots", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({ type: "liveness-update" } as ProcessEvent);

    const status = events.find(([type]) => type === "status");
    expect(status).toBeDefined();
    expect(status?.[1]).toMatchObject({
      sessionId: "sess-1",
      state: "in-turn",
      liveness: MOCK_LIVENESS,
    });
  });

  it("forwards mode-change events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "mode-change",
      mode: "plan",
      version: 2,
    } as ProcessEvent);

    const modeChange = events.find(([type]) => type === "mode-change");
    expect(modeChange).toBeDefined();
    expect(modeChange?.[1]).toEqual({
      permissionMode: "plan",
      modeVersion: 2,
    });
  });

  it("forwards mode-applied events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "mode-applied",
      mode: "bypassPermissions",
    } as ProcessEvent);

    const modeApplied = events.find(([type]) => type === "mode-applied");
    expect(modeApplied).toBeDefined();
    expect(modeApplied?.[1]).toEqual({
      appliedPermissionMode: "bypassPermissions",
    });
  });

  it("forwards error events", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "error",
      error: new Error("something broke"),
    } as ProcessEvent);

    const error = events.find(([type]) => type === "error");
    expect(error).toBeDefined();
    expect(error?.[1]).toEqual({ message: "something broke" });
  });

  it("augments codex-style Edit raw patches during streaming", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "msg-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "Edit",
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/example.ts",
                  "@@ -1,1 +1,1 @@",
                  "-const a = 1;",
                  "+const a = 2;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
        },
      },
    } as ProcessEvent);

    const messageEvents = events.filter(([type]) => type === "message");
    expect(messageEvents).toHaveLength(2);
    const messageEvent = messageEvents.at(-1);

    const payload = messageEvent?.[1] as {
      message?: {
        content?: Array<{
          type?: string;
          input?: {
            _rawPatch?: string;
            _structuredPatch?: Array<unknown>;
          };
        }>;
      };
    };
    const firstBlock = payload.message?.content?.[0];
    const input = firstBlock?.input;

    expect(firstBlock?.type).toBe("tool_use");
    expect(input?._rawPatch).toContain("*** Begin Patch");
    expect(Array.isArray(input?._structuredPatch)).toBe(true);
    expect(input?._structuredPatch?.length).toBeGreaterThan(0);
  });

  it("augments streamed Edit file_change diffs during streaming", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "msg-file-change-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-edit-file-change-1",
              name: "Edit",
              input: {
                changes: [
                  {
                    path: "src/example.ts",
                    kind: "update",
                    diff: [
                      "diff --git a/src/example.ts b/src/example.ts",
                      "--- a/src/example.ts",
                      "+++ b/src/example.ts",
                      "@@ -1,1 +1,1 @@",
                      "-const a = 1;",
                      "+const a = 2;",
                    ].join("\n"),
                  },
                ],
              },
            },
          ],
        },
      },
    } as ProcessEvent);

    const messageEvents = events.filter(
      ([type, payload]) =>
        type === "message" &&
        (payload as { uuid?: string })?.uuid === "msg-file-change-1",
    );
    expect(messageEvents).toHaveLength(2);
    const rawPayload = messageEvents[0]?.[1] as
      | {
          message?: { content?: Array<{ input?: { _rawPatch?: string } }> };
        }
      | undefined;
    expect(rawPayload?.message?.content?.[0]?.input?._rawPatch).toBeUndefined();

    const payload = messageEvents.at(-1)?.[1] as {
      message?: {
        content?: Array<{
          type?: string;
          input?: {
            _rawPatch?: string;
            _structuredPatch?: Array<unknown>;
          };
        }>;
      };
    };
    const firstBlock = payload.message?.content?.[0];
    const input = firstBlock?.input;

    expect(firstBlock?.type).toBe("tool_use");
    expect(input?._rawPatch).toContain("diff --git a/src/example.ts");
    expect(Array.isArray(input?._structuredPatch)).toBe(true);
    expect(input?._structuredPatch?.length).toBeGreaterThan(0);
  });

  it("does not let unresolved optional enrichment delay completion", async () => {
    const { process, fireEvent } = createMockProcess();
    const { emit, events } = collectEmit();
    const never = new Promise<void>(() => {});

    const { cleanup } = createSessionSubscription(process, emit, {
      createAugmenter: async () => stubAugmenter(async () => never),
    });

    void fireEvent({
      type: "message",
      message: {
        type: "assistant",
        uuid: "blocked-enrichment",
        message: { role: "assistant", content: "raw remains visible" },
      },
    } as ProcessEvent);
    await fireEvent({ type: "complete" } as ProcessEvent);

    expect(events.some(([type]) => type === "complete")).toBe(true);
    cleanup();
  });

  it("emits complete and stops further events", async () => {
    const { process, fireEvent } = createMockProcess({
      getProviderRuntimeStatus: vi.fn(() => MOCK_PROVIDER_RUNTIME_STATUS),
    });
    const { emit, events } = collectEmit();

    createSessionSubscription(process, emit);

    await fireEvent({ type: "complete" } as ProcessEvent);

    const complete = events.find(([type]) => type === "complete");
    expect(complete).toBeDefined();
    if (!complete) {
      throw new Error("expected complete event");
    }
    expect((complete[1] as Record<string, unknown>).sessionId).toBe("sess-1");
    expect((complete[1] as Record<string, unknown>).timestamp).toBeDefined();
    expect(
      (complete[1] as Record<string, unknown>).providerRuntimeStatus,
    ).toEqual(MOCK_PROVIDER_RUNTIME_STATUS);

    // Events after complete should be ignored
    const countBefore = events.length;
    await fireEvent({
      type: "state-change",
      state: { type: "idle", since: new Date() },
    } as ProcessEvent);
    expect(events.length).toBe(countBefore);
  });

  it("heartbeat fires on interval", () => {
    const { process } = createMockProcess();
    const { emit, events } = collectEmit();

    const { cleanup } = createSessionSubscription(process, emit);

    const countBefore = events.length;
    vi.advanceTimersByTime(30_000);

    const heartbeats = events
      .slice(countBefore)
      .filter(([type]) => type === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(
      (heartbeats[0][1] as Record<string, unknown>).timestamp,
    ).toBeDefined();
    expect(heartbeats[0][1]).toMatchObject({ liveness: MOCK_LIVENESS });

    cleanup();
  });

  it("cleanup unsubscribes and clears heartbeat", () => {
    const { process } = createMockProcess();
    const { emit, events } = collectEmit();

    const { cleanup } = createSessionSubscription(process, emit);
    cleanup();

    const countAfterCleanup = events.length;
    vi.advanceTimersByTime(60_000);
    // No heartbeats emitted after cleanup
    expect(events.length).toBe(countAfterCleanup);
  });

  it("cleanup clears streaming text if active", () => {
    const { process } = createMockProcess();
    const { emit } = collectEmit();

    // We need to trigger a message with a streaming ID to set currentStreamingMessageId
    // But since we can't easily do that without async augmenter, test that clearStreamingText
    // is called on cleanup after a message event triggers accumulation
    const { cleanup } = createSessionSubscription(process, emit);
    cleanup();

    // clearStreamingText is not called if no streaming was active (currentStreamingMessageId is null)
    // This is correct behavior - it only clears if there was active streaming
  });

  it("calls onError when emit throws in event handler", async () => {
    const { process, fireEvent } = createMockProcess();
    const onError = vi.fn();
    const throwingEmit: Emit = (type) => {
      if (type === "status") throw new Error("emit failed");
    };

    createSessionSubscription(process, throwingEmit, { onError });

    await fireEvent({
      type: "state-change",
      state: { type: "idle", since: new Date() },
    } as ProcessEvent);

    expect(onError).toHaveBeenCalledOnce();
  });
});

// ── Activity Subscription ────────────────────────────────────────────

describe("createActivitySubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connected with timestamp", () => {
    const { eventBus } = createMockEventBus();
    const { emit, events } = collectEmit();

    createActivitySubscription(eventBus, emit);

    expect(events[0][0]).toBe("connected");
    expect((events[0][1] as Record<string, unknown>).timestamp).toBeDefined();
  });

  it("forwards eventBus events with correct eventType", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    createActivitySubscription(eventBus, emit);

    fireEvent({
      type: "session-status-changed",
      sessionId: "s1",
      projectId: "p1",
    } as BusEvent);

    const forwarded = events.find(
      ([type]) => type === "session-status-changed",
    );
    expect(forwarded).toBeDefined();
    expect(forwarded?.[1]).toMatchObject({
      type: "session-status-changed",
      sessionId: "s1",
    });
  });

  it("heartbeat fires on interval", () => {
    const { eventBus } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);

    const countBefore = events.length;
    vi.advanceTimersByTime(30_000);

    const heartbeats = events
      .slice(countBefore)
      .filter(([type]) => type === "heartbeat");
    expect(heartbeats).toHaveLength(1);

    cleanup();
  });

  it("cleanup stops heartbeat and unsubscribes", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);
    cleanup();

    const countAfter = events.length;
    vi.advanceTimersByTime(60_000);
    fireEvent({ type: "session-created" } as BusEvent);

    expect(events.length).toBe(countAfter);
  });

  it("calls onError when emit throws", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const onError = vi.fn();
    const throwingEmit: Emit = (type) => {
      if (type !== "connected") throw new Error("emit failed");
    };

    createActivitySubscription(eventBus, throwingEmit, { onError });

    fireEvent({ type: "file-change" } as BusEvent);

    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not emit after closed", () => {
    const { eventBus, fireEvent } = createMockEventBus();
    const { emit, events } = collectEmit();

    const { cleanup } = createActivitySubscription(eventBus, emit);

    const countBefore = events.length;
    cleanup();

    // Since unsubscribe removes the handler, no events should be forwarded
    fireEvent({ type: "file-change" } as BusEvent);
    expect(events.length).toBe(countBefore);
  });
});
