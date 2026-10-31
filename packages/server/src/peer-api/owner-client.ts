import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  SRPClientSession,
  SRPParameters,
  SRPRoutines,
  bigIntToArrayBuffer,
  type SRPClientSessionStep2,
} from "tssrp6a";
import { BinaryFormat, isRelayClientError } from "@yep-anywhere/shared";
import { z } from "zod";
import {
  deriveSecretboxKey,
  deriveTransportKey,
  decrypt,
  encryptToBinaryEnvelope,
  decryptBinaryEnvelopeRaw,
} from "../crypto/nacl-wrapper.js";
import { CoreApiError } from "../core-api/errors.js";
import {
  PeerChannelBudget,
  awaitPeerWork,
  wireBytes,
  PEER_WIRE_BYTES,
  PEER_REPLY_BYTES,
} from "./srp-protocol.js";

export const ownerRouteSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("direct"), url: z.string().min(1).max(2048) })
    .strict(),
  z
    .object({
      kind: z.literal("relay"),
      url: z.string().url().max(2048),
      username: z
        .string()
        .min(3)
        .max(64)
        .regex(/^[a-z0-9-]+$/),
    })
    .strict(),
]);
export type OwnerRoute = z.infer<typeof ownerRouteSchema>;
export function normalizeOwnerRoute(value: unknown): OwnerRoute {
  const route = ownerRouteSchema.parse(value);
  const raw = route.url.includes("://") ? route.url : `ws://${route.url}`;
  const url = new URL(raw);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CoreApiError(
      "invalid_request",
      "Use a direct or relay WebSocket address without credentials, query or fragment",
      400,
    );
  if (route.kind === "direct") {
    if (!["/", "/api/ws"].includes(url.pathname))
      throw new CoreApiError(
        "invalid_request",
        "Direct owner login uses /api/ws",
        400,
      );
    url.pathname = "/api/ws";
  }
  return { ...route, url: url.href };
}
const challengeSchema = z.object({
  type: z.literal("srp_challenge"),
  salt: z.string().regex(/^[a-f0-9]{1,2048}$/i),
  B: z.string().regex(/^[a-f0-9]{1,1024}$/i),
});
const verifySchema = z.object({
  type: z.literal("srp_verify"),
  M2: z.string().regex(/^[a-f0-9]{1,1024}$/i),
  sessionId: z.uuid(),
  transportNonce: z.string().regex(/^[A-Za-z0-9+/]{32}$/),
  serverInfoProof: z.string().max(4096),
});
const proofSchema = z
  .object({ nonce: z.string().max(128), ciphertext: z.string().max(4096) })
  .strict();
const authenticatedInfoSchema = z.object({
  type: z.literal("srp_verify_server_info"),
  sessionId: z.uuid(),
  transportNonce: z.string(),
  resumeProtocolVersion: z.literal(3),
});
const replySchema = z.object({
  seq: z.number().int().nonnegative(),
  msg: z.object({
    type: z.literal("response"),
    id: z.string(),
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  }),
});
const cryptoBudget = new PeerChannelBudget();
const routines = new SRPRoutines(new SRPParameters());

/** A bounded ordinary owner login, never a reconnect driver or saved credential. */
export class PeerOwnerClient {
  private socket?: WebSocket;
  private key?: Uint8Array;
  private sessionId?: string;
  private outboundSequence = 0;
  private inboundSequence = -1;
  private closed = false;
  private phase: "relay" | "challenge" | "verify" | "ready" = "challenge";
  private step2?: SRPClientSessionStep2;
  private processing = false;
  private authenticated?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private pending?: {
    id: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    finish: () => void;
  };
  private lifetime = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private readonly route: OwnerRoute;
  constructor(
    route: OwnerRoute,
    private readonly assertOwner: () => void,
  ) {
    this.route = normalizeOwnerRoute(route);
    this.timer = setTimeout(() => this.fail(this.unavailable()), 45_000);
    this.timer.unref?.();
  }
  private unavailable() {
    return new CoreApiError(
      "peer_unavailable",
      "Owner connection ended; inspect any dispatched setup before retrying",
      503,
    );
  }
  private fail(error: Error) {
    this.authenticated?.reject(error);
    this.authenticated = undefined;
    this.pending?.reject(error);
    this.pending?.finish();
    this.pending = undefined;
    this.lifetime.abort(error);
    this.socket?.terminate();
  }
  async connect(username: string, password: string, signal: AbortSignal) {
    this.assertOwner();
    signal.throwIfAborted();
    if (this.closed || this.socket) throw this.unavailable();
    const work = cryptoBudget.crypto(() =>
      new SRPClientSession(routines).step1(username, password),
    );
    const step1 = await awaitPeerWork(work, signal);
    this.assertOwner();
    signal.throwIfAborted();
    this.phase = this.route.kind === "relay" ? "relay" : "challenge";
    const socket = new WebSocket(this.route.url, {
      maxPayload: PEER_WIRE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.socket = socket;
    const promise = new Promise<void>((resolve, reject) => {
      this.authenticated = { resolve, reject };
    });
    const abort = () => this.fail(this.unavailable());
    signal.addEventListener("abort", abort, { once: true });
    const handshakeTimer = setTimeout(abort, 10_000);
    handshakeTimer.unref?.();
    const hello = () => {
      this.assertOwner();
      signal.throwIfAborted();
      socket.send(JSON.stringify({ type: "srp_hello", identity: username }));
    };
    socket.on("open", () => {
      try {
        this.assertOwner();
        signal.throwIfAborted();
        if (this.route.kind === "relay")
          socket.send(
            JSON.stringify({
              type: "client_connect",
              username: this.route.username,
            }),
          );
        else hello();
      } catch {
        this.fail(this.unavailable());
      }
    });
    socket.on("error", () => this.fail(this.unavailable()));
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      this.fail(this.unavailable());
    });
    socket.on("close", () => this.fail(this.unavailable()));
    socket.on("message", (data, binary) => {
      if (this.closed || this.lifetime.signal.aborted) return;
      if (this.processing) {
        this.fail(this.unavailable());
        return;
      }
      this.processing = true;
      void (async () => {
        const bytes = wireBytes(data);
        if (this.phase === "ready") {
          if (!binary || !this.key) throw this.unavailable();
          const decoded = decryptBinaryEnvelopeRaw(bytes, this.key);
          if (
            !decoded ||
            decoded.format !== BinaryFormat.JSON ||
            decoded.payload.byteLength > PEER_REPLY_BYTES
          )
            throw this.unavailable();
          const frame = replySchema.parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(decoded.payload),
            ),
          );
          if (
            (this.inboundSequence < 0 && frame.seq !== 0) ||
            frame.seq <= this.inboundSequence ||
            !this.pending ||
            frame.msg.id !== this.pending.id
          )
            throw this.unavailable();
          this.inboundSequence = frame.seq;
          const pending = this.pending;
          this.pending = undefined;
          pending.finish();
          if (frame.msg.status < 200 || frame.msg.status >= 300) {
            const body = frame.msg.body;
            const known = z
              .object({ code: z.string(), error: z.string().max(512) })
              .safeParse(body);
            const restored = known.success
              ? CoreApiError.restore({
                  code: known.data.code,
                  message: known.data.error,
                  status: frame.msg.status,
                })
              : undefined;
            pending.reject(
              restored ??
                new CoreApiError(
                  "peer_unavailable",
                  `Remote owner API rejected setup (${frame.msg.status})`,
                  503,
                ),
            );
          } else pending.resolve(frame.msg.body);
          return;
        }
        if (binary || bytes.byteLength > 8192) throw this.unavailable();
        const message: unknown = JSON.parse(bytes.toString("utf8"));
        if (isRelayClientError(message)) throw this.unavailable();
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "srp_error"
        )
          throw new CoreApiError("unauthorized", "Owner SRP login failed", 401);
        if (this.phase === "relay") {
          z.object({ type: z.literal("client_connected") }).parse(message);
          this.phase = "challenge";
          hello();
          return;
        }
        if (this.phase === "challenge") {
          const challenge = challengeSchema.parse(message);
          this.step2 = await cryptoBudget.crypto(() =>
            step1.step2(
              BigInt(`0x${challenge.salt}`),
              BigInt(`0x${challenge.B}`),
            ),
          );
          this.assertOwner();
          signal.throwIfAborted();
          this.lifetime.signal.throwIfAborted();
          this.phase = "verify";
          socket.send(
            JSON.stringify({
              type: "srp_proof",
              A: this.step2.A.toString(16),
              M1: this.step2.M1.toString(16),
            }),
          );
          return;
        }
        const verified = verifySchema.parse(message);
        await cryptoBudget.crypto(() =>
          this.step2!.step3(BigInt(`0x${verified.M2}`)),
        );
        this.assertOwner();
        signal.throwIfAborted();
        this.lifetime.signal.throwIfAborted();
        const base = deriveSecretboxKey(
          new Uint8Array(bigIntToArrayBuffer(this.step2!.S)),
        );
        const envelope = proofSchema.parse(
          JSON.parse(verified.serverInfoProof),
        );
        const plaintext = decrypt(envelope.nonce, envelope.ciphertext, base);
        if (!plaintext) throw this.unavailable();
        const info = authenticatedInfoSchema.parse(JSON.parse(plaintext));
        if (
          info.sessionId !== verified.sessionId ||
          info.transportNonce !== verified.transportNonce
        )
          throw this.unavailable();
        this.key = deriveTransportKey(base, verified.transportNonce);
        this.sessionId = verified.sessionId;
        this.phase = "ready";
        this.step2 = undefined;
        const ready = this.authenticated;
        this.authenticated = undefined;
        ready?.resolve();
      })()
        .catch((error) =>
          this.fail(error instanceof CoreApiError ? error : this.unavailable()),
        )
        .finally(() => {
          this.processing = false;
        });
    });
    try {
      await awaitPeerWork(promise, signal);
    } finally {
      clearTimeout(handshakeTimer);
      signal.removeEventListener("abort", abort);
    }
  }
  request(
    path: string,
    method = "GET",
    body?: unknown,
    caller?: AbortSignal,
    cleanup = false,
  ): Promise<unknown> {
    const ownCleanup =
      method === "DELETE" && path === "/api/peers/connections/owner-session";
    if (cleanup && !ownCleanup) return Promise.reject(this.unavailable());
    if (
      !(
        path.startsWith("/api/peers/") ||
        path === "/api/version" ||
        ownCleanup
      ) ||
      path.includes("..") ||
      path.includes("#") ||
      path.length > 4096
    )
      return Promise.reject(
        new CoreApiError(
          "invalid_request",
          "Unsupported owner setup operation",
          400,
        ),
      );
    if (
      this.closed ||
      this.phase !== "ready" ||
      !this.key ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.pending
    )
      return Promise.reject(this.unavailable());
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(caller ? [caller] : []),
      AbortSignal.timeout(10_000),
    ]);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        this.pending = undefined;
        finish();
        reject(this.unavailable());
        this.socket?.terminate();
      };
      const finish = () => signal.removeEventListener("abort", abort);
      this.pending = { id, resolve, reject, finish };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!cleanup) this.assertOwner();
        signal.throwIfAborted();
        const payload = JSON.stringify({
          seq: this.outboundSequence++,
          msg: {
            type: "request",
            id,
            method,
            path,
            headers: {
              "Content-Type": "application/json",
              "X-Yep-Anywhere": "true",
            },
            ...(body === undefined ? {} : { body }),
          },
        });
        if (Buffer.byteLength(payload) > PEER_REPLY_BYTES)
          throw new CoreApiError(
            "invalid_request",
            "Owner setup request is too large",
            400,
          );
        this.socket!.send(encryptToBinaryEnvelope(payload, this.key!));
      } catch (error) {
        this.pending = undefined;
        finish();
        reject(error);
      }
    });
  }
  async close() {
    if (this.closed) return "unconfirmed" as const;
    let cleaned = false;
    if (this.sessionId && !this.pending && !this.lifetime.signal.aborted) {
      try {
        await this.request(
          "/api/peers/connections/owner-session",
          "DELETE",
          undefined,
          AbortSignal.timeout(2000),
          true,
        );
        cleaned = true;
      } catch {}
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.fail(this.unavailable());
    this.socket?.removeAllListeners();
    this.socket?.on("error", () => {});
    this.key = undefined;
    this.sessionId = undefined;
    this.step2 = undefined;
    return cleaned ? ("confirmed" as const) : ("unconfirmed" as const);
  }
}
