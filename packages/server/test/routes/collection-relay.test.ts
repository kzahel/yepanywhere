import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  BinaryFormat,
  TransportChunkReassembler,
  decodeResponseChunkPayload,
  type YepMessage,
} from "@yep-anywhere/shared";
import { decryptBinaryEnvelopeRaw } from "../../src/crypto/index.js";
import { CollectionUpdates } from "../../src/services/CollectionUpdates.js";
import { createCollectionUpdateStream } from "../../src/routes/collection-updates.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  cleanupConnectionState,
  createConnectionState,
  createSendFn,
  handleRequest,
  handleResponseStreamAck,
  handleResponseStreamCancel,
} from "../../src/routes/ws-relay-handlers.js";
import { RelayProtocol } from "../../../client/src/lib/connection/RelayProtocol.js";
import type { YaSourceRuntime } from "../../../client/src/lib/sourceRuntime.js";
import {
  retainCollectionUpdates,
  pauseCollectionUpdates,
} from "../../../client/src/lib/collectionUpdates.js";

// Use production client/server handlers and encrypted response frames,
// with an in-process wire and a pre-authenticated connection. No live profiles.
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  encrypted = true,
  pendingHeaders?: Promise<void>,
  endpoint = "/activity/collections",
) {
  vi.stubGlobal("window", new EventTarget());
  const bus = new EventBus();
  const owner = new CollectionUpdates(bus);
  const app = new Hono();
  if (pendingHeaders)
    app.use("/api/activity/collections", async (_c, next) => {
      await next();
      await pendingHeaders;
    });
  const handler = createCollectionUpdateStream(owner, async () =>
    Response.json({
      sessions: [{ id: "fixture", title: "Fixture" }],
      catalog: {
        catalogEpoch: "fixture",
        catalogGeneration: 1,
        complete: true,
        refreshing: false,
      },
    }),
  );
  app.get("/api/activity/collections", handler);
  const state = createConnectionState();
  const sessionKey = new Uint8Array(32).fill(7);
  Object.assign(state, {
    authState: "authenticated",
    sessionKey: encrypted ? sessionKey : null,
    connectionPolicy: encrypted ? "srp_required" : "local_unrestricted",
    username: "fixture",
    sessionId: "fixture-session",
    transportNonce: "fixture-nonce",
    authenticationMethod: "srp-resume",
    supportedFormats: new Set([
      BinaryFormat.JSON,
      BinaryFormat.TRANSPORT_CHUNK,
    ]),
  });
  let requests = 0;
  let frames = 0;
  const pending: Promise<void>[] = [];
  const reassembler = new TransportChunkReassembler();
  const ws = {
    isOpen: () => !state.cleanupStarted,
    close: () => cleanupConnectionState(state),
    send(frame: string | ArrayBuffer | Uint8Array) {
      frames++;
      if (typeof frame === "string") {
        protocol.routeMessage(JSON.parse(frame) as YepMessage);
        return;
      }
      const envelope = reassembler.acceptFrame(frame);
      if (!envelope) return;
      const decrypted = decryptBinaryEnvelopeRaw(envelope, sessionKey);
      if (!decrypted) throw new Error("Cannot decrypt response");
      if (decrypted.format === BinaryFormat.RESPONSE_CHUNK) {
        const chunk = decodeResponseChunkPayload(decrypted.payload);
        protocol.handleResponseChunk(chunk.requestId, chunk.data);
      } else {
        const { msg } = JSON.parse(
          new TextDecoder().decode(decrypted.payload),
        ) as {
          msg: YepMessage;
        };
        protocol.routeMessage(msg);
      }
    },
  };
  const send = createSendFn(ws, state);
  const protocol = new RelayProtocol({
    supportsStreamedResponses: encrypted,
    ensureConnected: async () => {},
    isConnected: () => !state.cleanupStarted,
    sendUploadChunk: () => {},
    sendMessage(message) {
      if (message.type === "request") {
        requests++;
        pending.push(
          handleRequest(message, send, ws, app, "http://fixture", state),
        );
      } else if (message.type === "response_stream_cancel") {
        handleResponseStreamCancel(state, message.id);
      } else if (message.type === "response_stream_ack") {
        handleResponseStreamAck(state, message.id, message.bytes);
      }
    },
  });
  const runtime = {
    sourceKey: `collection-relay-${encrypted}`,
    transport: {
      kind: "secure",
      capabilities: { streamedResponses: encrypted, sameOriginUrls: false },
      status: {
        getSnapshot: () => ({ kind: "secure", state: "ready", channels: [] }),
        subscribe: () => () => {},
      },
      fetchStream: (path: string, init?: RequestInit) =>
        protocol.fetchStream(
          path.replace("/activity/collections", endpoint),
          init,
        ),
      fetchResponse: (path: string, init?: RequestInit) =>
        protocol.fetchResponse(
          path.replace("/activity/collections", endpoint),
          init,
        ),
    },
  } as unknown as YaSourceRuntime;
  const releases: Array<() => void> = [];
  cleanups.push(async () => {
    for (const release of releases) release();
    await delay(0);
    protocol.close();
    cleanupConnectionState(state);
    owner.close();
    await Promise.all(pending);
  });
  const retain = (key: string, fallback = () => {}) => {
    let published = 0;
    releases.push(
      retainCollectionUpdates(runtime, key, {
        path: `/sessions?limit=${Number(key) + 1}`,
        rows: Number(key) + 1,
        publish: async () => {
          published++;
        },
        fallback,
      }),
    );
    return () => published;
  };
  return {
    owner,
    state,
    runtime,
    retain,
    protocol,
    metrics: () => ({
      requests,
      frames,
      ...owner.getStats(),
      responseStreams: state.responseStreams.size,
    }),
  };
}

it("delivers collection replacements and releases every view on tunnel disconnect", async () => {
  const f = fixture();
  const published = f.retain("0");
  await vi.waitFor(() => expect(published()).toBe(1), { interval: 5 });
  expect(f.metrics().responseStreams).toBe(1);
  cleanupConnectionState(f.state);
  await vi.waitFor(() => expect(f.owner.getStats().views).toBe(0), {
    interval: 5,
  });
});

it("aborts collection acquisition when the connection closes before response admission", async () => {
  let admit!: () => void;
  const f = fixture(
    true,
    new Promise<void>((r) => {
      admit = r;
    }),
  );
  f.retain("0");
  try {
    await vi.waitFor(() => expect(f.owner.getStats().views).toBe(1), {
      interval: 5,
    });
    expect(f.metrics().responseStreams).toBe(0);
    cleanupConnectionState(f.state);
    await vi.waitFor(() => expect(f.owner.getStats().views).toBe(0), {
      interval: 5,
    });
  } finally {
    admit();
  }
  await delay(10);
  expect(f.metrics().responseStreams).toBe(0);
  expect(f.owner.getStats().views).toBe(0);
});

it.each([
  "/activity/collections",
  "/activity/%63ollections",
  "/%61ctivity/collections",
])(
  "refuses legacy plain-WebSocket request %s without starting a producer",
  async (path) => {
    const f = fixture(false, undefined, path);
    let fallbacks = 0;
    const published = f.retain("0", () => {
      fallbacks++;
    });
    await vi.waitFor(() => expect(fallbacks).toBe(1), { interval: 5 });
    expect(published()).toBe(0);
    expect(f.owner.getStats().views).toBe(0);
    expect(f.metrics().responseStreams).toBe(0);
  },
);

it("streams encoded collection paths through the same cancellation owner", async () => {
  const f = fixture(true, undefined, "/activity/%63ollections");
  const published = f.retain("0");
  await vi.waitFor(() => expect(published()).toBe(1), { interval: 5 });
  expect(f.metrics().responseStreams).toBe(1);
  cleanupConnectionState(f.state);
  await vi.waitFor(() => expect(f.owner.getStats().views).toBe(0), {
    interval: 5,
  });
});

it("preserves source backoff through fallback REST pause/resume and recovers when capacity returns", async () => {
  const errors = vi.spyOn(console, "error");
  const f = fixture();
  const reservations = Array.from({ length: 64 }, (_, n) =>
    f.owner.retain(
      "other-viewer",
      `/sessions?limit=${n + 1}`,
      async () => ({ sessions: [] }),
      { send: () => {}, fail: () => {} },
    ),
  );
  let fallbacks = 0;
  let published = () => 0;
  for (let n = 0; n < 6; n++) {
    const key = String(n);
    const count = f.retain(key, () => {
      fallbacks++;
      // Same lifecycle as session/Projects/queue REST fallback. Only the
      // canonical REST latency is simulated; stream acquisition is real.
      const resume = pauseCollectionUpdates(f.runtime, key);
      void delay(10).then(() => resume());
    });
    if (n === 0) published = count;
  }
  try {
    await vi.waitFor(() => expect(fallbacks).toBeGreaterThan(0), {
      interval: 5,
    });
    const start = f.metrics().requests;
    await delay(500);
    expect(f.metrics().requests - start).toBeLessThanOrEqual(3);
    expect(f.owner.getStats().views).toBe(64);
    expect(errors).not.toHaveBeenCalled();
    for (const release of reservations) release();
    await vi.waitFor(() => expect(published()).toBe(1), {
      interval: 5,
      timeout: 2_000,
    });
    expect(f.owner.getStats().views).toBe(6);
    expect(f.state.cleanupStarted).toBe(false);
  } finally {
    for (const release of reservations) release();
  }
});

it.each(["/activity/collections", "/activity/%63ollections"])(
  "keeps valid quiet collection %s open beyond the file-response idle deadline",
  async (path) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture(true, undefined, path);
      const published = f.retain("0");
      await vi.advanceTimersByTimeAsync(1);
      expect(published()).toBe(1);
      await vi.advanceTimersByTimeAsync(360_500);
      expect(f.metrics().requests).toBe(1);
      expect(published()).toBe(1);
      expect(f.owner.getStats().views).toBe(1);
      cleanupConnectionState(f.state);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.owner.getStats().views).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
