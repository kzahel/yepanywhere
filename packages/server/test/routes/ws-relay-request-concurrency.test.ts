import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { getAuthenticatedSrpTransport } from "../../src/middleware/authenticated-transport.js";
import type { HttpBindings } from "@hono/node-server";
import {
  PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  type RelayResponse,
  type YepMessage,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import type { RelayHandlerDeps } from "../../src/routes/ws-relay-handlers.js";
import {
  LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES,
  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
  __relayResponseSerializationTest,
  cleanupConnectionState,
  createConnectionState,
  createSendFn,
  handleMessage,
  handleRequest,
  relayResponseSerializationDiagnostics,
} from "../../src/routes/ws-relay-handlers.js";

beforeEach(() => {
  __relayResponseSerializationTest.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Tunneled HTTP requests must not head-of-line block one another: the
 * per-connection message queue serializes decrypt/auth/route, but a slow
 * request (e.g. /api/sessions during an index revalidation) has to leave the
 * queue before its response is ready, exactly as it would over plain HTTP.
 */
describe("WS relay request concurrency", () => {
  it("records a direct client's versioned capability notification", async () => {
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    const deps = {
      app: new Hono<{ Bindings: HttpBindings }>(),
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    await handleMessage(
      { send: vi.fn(), close: vi.fn() },
      new Map(),
      new Map(),
      state,
      vi.fn(),
      JSON.stringify({
        type: "client_capabilities",
        version: "0.7.1",
        capabilityBits: [[0, 2]],
        formats: [1, 5],
      }),
      deps,
      {},
    );

    expect(state.clientVersion).toBe("0.7.1");
    expect(state.clientCapabilityBits).toEqual([[0, 2]]);
    expect(state.supportedFormats).toEqual(new Set([1, 5]));
  });

  it("forwards the connection client version to tunneled routes", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/api/client-version", (c) =>
      c.json({ version: c.req.header("X-Yep-Client-Version") }),
    );
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    state.clientVersion = "0.7.1";
    const ws = { send: vi.fn(), close: vi.fn() };

    await handleRequest(
      {
        type: "request",
        id: "client-version-request",
        method: "GET",
        path: "/api/client-version",
      },
      createSendFn(ws, state),
      ws,
      app,
      "http://localhost",
      state,
    );

    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "response",
      id: "client-version-request",
      status: 200,
      body: { version: "0.7.1" },
    });
  });

  it("preserves validated JSON bytes and Server-Timing", async () => {
    const rawBody = '{ "nested": [1, 2], "unicode": "雪" }\n';
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get(
      "/api/profiled",
      () =>
        new Response(rawBody, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Server-Timing": "route;dur=12.3, augment;dur=4.2",
          },
        }),
    );
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    const ws = { send: vi.fn(), close: vi.fn() };

    await handleRequest(
      {
        type: "request",
        id: "profiled-request",
        method: "GET",
        path: "/api/profiled",
      },
      createSendFn(ws, state),
      ws,
      app,
      "http://localhost",
      state,
    );

    expect(ws.send).toHaveBeenCalledTimes(1);
    const frame = ws.send.mock.calls[0]?.[0];
    expect(typeof frame).toBe("string");
    expect(frame).toContain(`,"body":${rawBody}}`);
    expect(JSON.parse(frame as string)).toEqual({
      type: "response",
      id: "profiled-request",
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "server-timing": "route;dur=12.3, augment;dur=4.2",
      },
      body: { nested: [1, 2], unicode: "雪" },
    });
    expect(relayResponseSerializationDiagnostics()).toEqual({
      eligibleJsonResponses: 1,
      rawFastPathHits: 1,
      rawBodyBytes: new TextEncoder().encode(rawBody).byteLength,
      fallbackResponses: 0,
      invalidJsonFallbacks: 0,
      unsupportedSenderFallbacks: 0,
      rawSendFailures: 0,
    });
  });

  it.each([
    { name: "malformed JSON", body: '{"incomplete":' },
    { name: "empty JSON", body: "" },
    { name: "invalid UTF-8 JSON", body: new Uint8Array([0xc3, 0x28]) },
  ] as const)(
    "keeps $name compatibility on the parsed fallback",
    async ({ body }) => {
      const app = new Hono<{ Bindings: HttpBindings }>();
      app.get(
        "/api/invalid-json",
        () =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
      );
      const state = createConnectionState();
      state.connectionPolicy = "local_unrestricted";
      state.authState = "authenticated";
      const ws = { send: vi.fn(), close: vi.fn() };

      await handleRequest(
        {
          type: "request",
          id: "invalid-request",
          method: "GET",
          path: "/api/invalid-json",
        },
        createSendFn(ws, state),
        ws,
        app,
        "http://localhost",
        state,
      );

      expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toMatchObject({
        type: "response",
        id: "invalid-request",
        status: 200,
        body: null,
      });
      expect(relayResponseSerializationDiagnostics()).toMatchObject({
        eligibleJsonResponses: 1,
        rawFastPathHits: 0,
        fallbackResponses: 1,
        invalidJsonFallbacks: 1,
      });
    },
  );

  it("answers a fast request while an earlier slow request is in flight", async () => {
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/api/slow", async (c) => {
      await slowGate;
      return c.json({ which: "slow" });
    });
    app.get("/api/fast", (c) => c.json({ which: "fast" }));

    const sent: YepMessage[] = [];
    const responses = (): RelayResponse[] =>
      sent.filter((m): m is RelayResponse => m.type === "response");
    let notifyResponse: (() => void) | undefined;
    const send = (message: YepMessage) => {
      sent.push(message);
      notifyResponse?.();
    };

    // Local trusted connection: plaintext application messages route without
    // an SRP transport, as in ws-relay.ts onOpen for local mode.
    const connState = createConnectionState();
    connState.connectionPolicy = "local_unrestricted";
    connState.authState = "authenticated";

    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    const ws = { send: () => {}, close: () => {} };
    const dispatch = (id: string, path: string) =>
      handleMessage(
        ws,
        new Map(),
        new Map(),
        connState,
        send,
        JSON.stringify({ type: "request", id, method: "GET", path }),
        deps,
        {},
      );

    // Mirrors the connection's serialized message queue: each handleMessage
    // is awaited before the next starts.
    await dispatch("req-slow", "/api/slow");
    await dispatch("req-fast", "/api/fast");

    // The fast response must arrive while the slow request is still gated.
    await new Promise<void>((resolve) => {
      if (responses().length > 0) return resolve();
      notifyResponse = resolve;
    });
    expect(responses().map((r) => r.id)).toEqual(["req-fast"]);

    releaseSlow?.();
    await new Promise<void>((resolve) => {
      if (responses().length === 2) return resolve();
      notifyResponse = () => {
        if (responses().length === 2) resolve();
      };
    });
    expect(responses().map((r) => r.id)).toEqual(["req-fast", "req-slow"]);
    expect(responses()[1]).toMatchObject({
      status: 200,
      body: { which: "slow" },
    });
  });

  it("forwards Location so relay clients can follow API redirects", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/api/original", (c) => c.redirect("/api/redirected", 307));

    const sent: YepMessage[] = [];
    const connState = createConnectionState();
    connState.connectionPolicy = "local_unrestricted";
    connState.authState = "authenticated";
    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    await handleMessage(
      { send: () => {}, close: () => {} },
      new Map(),
      new Map(),
      connState,
      (message) => sent.push(message),
      JSON.stringify({
        type: "request",
        id: "req-redirect",
        method: "GET",
        path: "/api/original",
      }),
      deps,
      {},
    );

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toMatchObject({
      type: "response",
      status: 307,
      headers: { location: "/api/redirected" },
    });
  });

  it("closes a preauth public-share socket instead of pipelining requests", async () => {
    let routeCalls = 0;
    let resolveFirstRoute!: () => void;
    const firstRouteStarted = new Promise<void>((resolve) => {
      resolveFirstRoute = resolve;
    });
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/public-api/shares/:secret/metadata", async (c) => {
      routeCalls += 1;
      resolveFirstRoute();
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return c.json({ unreachable: true });
    });
    const state = createConnectionState();
    const sent: YepMessage[] = [];
    const close = vi.fn();
    const ws = { send: () => {}, close };

    const first = handleRequest(
      {
        type: "request",
        id: "request-1",
        method: "GET",
        path: "/public-api/shares/bearer-one/metadata",
      },
      (message) => sent.push(message),
      ws,
      app,
      "http://localhost",
      state,
    );
    await firstRouteStarted;
    await handleRequest(
      {
        type: "request",
        id: "request-2",
        method: "GET",
        path: "/public-api/shares/bearer-two/metadata",
      },
      (message) => sent.push(message),
      ws,
      app,
      "http://localhost",
      state,
    );
    await first;

    expect(routeCalls).toBe(1);
    expect(close).toHaveBeenCalledWith(
      1008,
      "Public-share requests must be sequential",
    );
    expect(sent).toHaveLength(0);
  });

  it("cancels a preauth response body exactly once on connection cleanup", async () => {
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let cancelCalls = 0;
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get(
      "/public-api/shares/:secret/metadata",
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                resolveReadStarted();
              },
              cancel() {
                cancelCalls += 1;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const state = createConnectionState();
    const sent: YepMessage[] = [];

    const request = handleRequest(
      {
        type: "request",
        id: "request-1",
        method: "GET",
        path: "/public-api/shares/bearer/metadata",
      },
      (message) => sent.push(message),
      { send: () => {}, close: () => {} },
      app,
      "http://localhost",
      state,
    );
    await readStarted;
    cleanupConnectionState(state);
    cleanupConnectionState(state);
    await request;

    expect(cancelCalls).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("keeps a delayed public response in its plaintext admission frame", async () => {
    let releaseRoute!: () => void;
    let routeStarted!: () => void;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const started = new Promise<void>((resolve) => {
      routeStarted = resolve;
    });
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/public-api/shares/:secret/metadata", async (c) => {
      routeStarted();
      await routeGate;
      return c.json({ capabilities: [] });
    });
    const state = createConnectionState();
    const ws = { send: vi.fn(), close: vi.fn() };
    const send = createSendFn(ws, state);

    const request = handleRequest(
      {
        type: "request",
        id: "public-before-auth-mutation",
        method: "GET",
        path: "/public-api/shares/bearer/metadata",
      },
      send,
      ws,
      app,
      "http://localhost",
      state,
    );
    await started;

    state.authState = "authenticated";
    state.sessionKey = new Uint8Array(32).fill(7);
    state.requiresEncryptedMessages = true;
    releaseRoute();
    await request;

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(typeof ws.send.mock.calls[0]?.[0]).toBe("string");
    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "response",
      id: "public-before-auth-mutation",
      status: 200,
    });
    expect(state.nextOutboundSeq).toBe(0);
  });

  it("rejects SRP control after selecting public-read-only mode", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/public-api/shares/:secret/metadata", (c) =>
      c.json({ capabilities: [] }),
    );
    const state = createConnectionState();
    const close = vi.fn();
    const ws = { send: vi.fn(), close };
    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    await handleMessage(
      ws,
      new Map(),
      new Map(),
      state,
      () => undefined,
      JSON.stringify({
        type: "request",
        id: "public-first",
        method: "GET",
        path: "/public-api/shares/bearer/metadata",
      }),
      deps,
      {},
    );
    expect(state.connectionMode).toBe("public_read_only");

    await handleMessage(
      ws,
      new Map(),
      new Map(),
      state,
      () => undefined,
      JSON.stringify({ type: "srp_hello" }),
      deps,
      {},
    );

    expect(state.connectionMode).toBe("public_read_only");
    expect(close).toHaveBeenCalledWith(
      1008,
      "Connection mode already selected",
    );
  });

  it("keeps failed SRP mode from accepting later public plaintext", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    let routeCalls = 0;
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/public-api/shares/:secret/metadata", (c) => {
      routeCalls += 1;
      return c.json({ capabilities: [] });
    });
    const state = createConnectionState();
    const close = vi.fn();
    const ws = { send: vi.fn(), close };
    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    await handleMessage(
      ws,
      new Map(),
      new Map(),
      state,
      () => undefined,
      JSON.stringify({ type: "srp_hello" }),
      deps,
      {},
    );
    expect(state.connectionMode).toBe("srp");
    close.mockClear();

    await handleMessage(
      ws,
      new Map(),
      new Map(),
      state,
      () => undefined,
      JSON.stringify({
        type: "request",
        id: "public-after-srp",
        method: "GET",
        path: "/public-api/shares/bearer/metadata",
      }),
      deps,
      {},
    );

    expect(state.connectionMode).toBe("srp");
    expect(routeCalls).toBe(0);
    expect(close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext message but auth required",
    );
  });
});

describe("WS relay legacy public-share response bound", () => {
  function boundedTextResponse(
    body: string,
    onProduced?: (bytes: number) => void,
  ): Response {
    const encoded = new TextEncoder().encode(body);
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= encoded.byteLength) {
            controller.close();
            return;
          }
          const length = Math.min(
            encoded.byteLength - offset,
            LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
          );
          controller.enqueue(encoded.subarray(offset, offset + length));
          offset += length;
          onProduced?.(offset);
        },
      }),
      {
        headers: {
          "Content-Type": "application/x-yep-public-share+json",
          "X-Share-Test": "preserved",
        },
      },
    );
  }

  function authenticatedState() {
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    return state;
  }

  async function relayGet(
    app: Hono<{ Bindings: HttpBindings }>,
    path: string,
    state = createConnectionState(),
  ) {
    const sent: YepMessage[] = [];
    await handleRequest(
      { type: "request", id: "request-1", method: "GET", path },
      (message) => sent.push(message),
      { send: () => {}, close: () => {} },
      app,
      "http://localhost",
      state,
    );
    return sent[0] as RelayResponse;
  }

  it("parses quote-heavy legacy public-share JSON before relay framing", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    const quoteHeavyContent = '"'.repeat(3 * 1024 * 1024);
    const rawShare = {
      share: {
        mode: "frozen",
        title: "Quote-heavy share",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:01:00.000Z",
        source: {
          projectId: "L3JlcG8",
          sessionId: "session-1",
          projectName: "repo",
          provider: "claude",
        },
      },
      session: {
        id: "session-1",
        projectId: "L3JlcG8",
        projectName: "repo",
        title: "Quote-heavy share",
        fullTitle: "Quote-heavy share",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:01:00.000Z",
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "claude",
        messages: [
          {
            type: "user",
            isSidechain: false,
            userType: "external",
            cwd: "/repo",
            sessionId: "session-1",
            version: "2.1.0",
            uuid: "00000000-0000-4000-8000-000000000001",
            parentUuid: null,
            message: { role: "user", content: quoteHeavyContent },
            timestamp: "2026-08-06T00:00:00.000Z",
          },
        ],
      },
    };
    const rawBody = JSON.stringify(rawShare);
    const encoder = new TextEncoder();
    expect(encoder.encode(rawBody).byteLength).toBeLessThanOrEqual(
      LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES,
    );
    app.get("/public-api/shares/:secret", () => boundedTextResponse(rawBody));

    const response = await relayGet(
      app,
      "/public-api/shares/bearer-secret?wire=raw-json",
    );

    expect(response).toMatchObject({
      status: 200,
      headers: { "x-share-test": "preserved" },
    });
    expect(response.body).toEqual(rawShare);
    expect(encoder.encode(JSON.stringify(response)).byteLength).toBeLessThan(
      PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
    );
    expect(
      encoder.encode(JSON.stringify({ ...response, body: rawBody })).byteLength,
    ).toBeGreaterThan(PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES);
  });

  it("cancels oversized legacy share bodies and returns update guidance", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    const completeBytes = LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES * 3;
    let producedBytes = 0;
    let cancelled = false;
    app.get("/public-api/shares/:secret", () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (producedBytes >= completeBytes) {
              controller.close();
              return;
            }
            const size = Math.min(
              LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
              completeBytes - producedBytes,
            );
            producedBytes += size;
            controller.enqueue(new Uint8Array(size));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        headers: { "Content-Type": "application/x-yep-public-share+json" },
      });
    });
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);

    const response = await relayGet(
      app,
      "/public-api/shares/never-log-this-bearer?wire=raw-json",
    );

    expect(response).toMatchObject({
      status: 413,
      body: {
        retryable: false,
        updateRequired: true,
      },
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
    expect(cancelled).toBe(true);
    expect(producedBytes).toBe(
      LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES +
        LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[WS Relay] Public share response capped: method=GET, kind=legacy-session, status=200, bytes=",
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "never-log-this-bearer",
    );
  });

  it("rejects a controlled producer chunk above 64 KiB", async () => {
    const errorLog = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);
    const app = new Hono<{ Bindings: HttpBindings }>();
    let cancelled = false;
    app.get(
      "/public-api/shares/:secret",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(
                new Uint8Array(
                  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES + 1,
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": "application/x-yep-public-share+json",
            },
          },
        ),
    );

    const response = await relayGet(
      app,
      "/public-api/shares/large-single-chunk?wire=raw-json",
    );

    expect(response.status).toBe(500);
    expect(cancelled).toBe(true);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      "[WS Relay] Public share request failed: method=GET",
    );
  });

  it("rejects an unbounded producer chunk as an internal failure", async () => {
    const errorLog = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);
    const app = new Hono<{ Bindings: HttpBindings }>();
    let cancelled = false;
    app.get(
      "/public-api/shares/:secret",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(
                new Uint8Array(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 2),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": "application/x-yep-public-share+json",
            },
          },
        ),
    );

    const response = await relayGet(
      app,
      "/public-api/shares/unbounded-source-chunk?wire=raw-json",
    );

    expect(response.status).toBe(500);
    expect(cancelled).toBe(true);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      "[WS Relay] Public share request failed: method=GET",
    );
  });

  it("returns 413 for an oversized generic preauth public resource", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const app = new Hono<{ Bindings: HttpBindings }>();
    let cancelled = false;
    app.get(
      "/public-api/shares/:secret/files/raw",
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(
                  new Uint8Array(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 2),
                );
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "Content-Type": "application/octet-stream" } },
        ),
    );

    const response = await relayGet(
      app,
      "/public-api/shares/bearer/files/raw?path=huge.bin",
      createConnectionState(),
    );

    expect(response).toMatchObject({
      status: 413,
      body: { retryable: false },
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
    expect(response.body).not.toHaveProperty("updateRequired");
    expect(cancelled).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      `[WS Relay] Public share response capped: method=GET, kind=public-resource, status=200, bytes=${LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 2}`,
    );
  });

  it("rejects a declared oversized preauth body before pulling it", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const app = new Hono<{ Bindings: HttpBindings }>();
    let pullCalls = 0;
    let cancelled = false;
    app.get(
      "/public-api/shares/:secret/files",
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                pullCalls += 1;
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: {
              "Content-Length": String(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 1),
              "Content-Type": "application/json",
            },
          },
        ),
    );

    const response = await relayGet(
      app,
      "/public-api/shares/bearer/files?path=huge.json",
      createConnectionState(),
    );

    expect(response.status).toBe(413);
    expect(pullCalls).toBe(0);
    expect(cancelled).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      `[WS Relay] Public share response capped: method=GET, kind=public-resource, status=200, bytes=${LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 1}`,
    );
  });

  it("does not apply the limit to an authenticated public-share request", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    const body = "x".repeat(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 1);
    app.get("/public-api/shares/:secret", () => new Response(body));

    const response = await relayGet(
      app,
      "/public-api/shares/bearer-secret?wire=raw-json",
      authenticatedState(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
  });

  it("does not apply the public-share limit to unrelated relay traffic", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    const body = "y".repeat(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES + 1);
    app.get("/api/large", () => new Response(body));

    const response = await relayGet(app, "/api/large", authenticatedState());

    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
  });
});

it("keeps owner authority bound to the current live stored SRP session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-owner-srp-")),
    sessions = new RemoteSessionService({ dataDir: directory });
  const state = createConnectionState();
  try {
    await sessions.initialize();
    state.authState = "authenticated";
    state.sessionKey = new Uint8Array(32).fill(42);
    state.username = "owner";
    state.transportNonce = "owned-nonce";
    state.authenticationMethod = "srp-full";
    state.sessionId = await sessions.createSession("owner", state.sessionKey);
    let live: (() => boolean) | undefined;
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/proof", (c) => {
      live = getAuthenticatedSrpTransport(c.env)?.isActive;
      return c.json({ ok: true });
    });
    const ws = { send: vi.fn(), close: vi.fn(), isOpen: () => true };
    const request = () =>
      handleRequest(
        { type: "request", id: "owner-proof", method: "GET", path: "/proof" },
        vi.fn(),
        ws,
        app,
        "http://localhost",
        state,
        sessions,
      );
    await request();
    expect(live?.()).toBe(true);
    await sessions.deleteSession(state.sessionId);
    expect(live?.()).toBe(false);
    state.sessionId = await sessions.createSession("owner", state.sessionKey);
    expect(live?.()).toBe(false); // A replacement does not revive the captured request.
    await request();
    expect(live?.()).toBe(true);
    sessions.getSession(state.sessionId)!.lastUsed = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(live?.()).toBe(false);
    state.sessionId = await sessions.createSession("owner", state.sessionKey);
    await request();
    expect(live?.()).toBe(true);
    cleanupConnectionState(state);
    expect(live?.()).toBe(false);
  } finally {
    sessions.shutdown();
    cleanupConnectionState(state);
    await sessions.waitForPendingWrites();
    await rm(directory, { recursive: true, force: true });
  }
});
