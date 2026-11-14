import {
  PEER_ENVELOPE_VERSION,
  RECEIPT_HEADER,
} from "../core-api/http-contracts.js";
import {
  PEER_IDENTITY_PATH,
  PEER_REFRESH_PATH,
} from "./authentication-contracts.js";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { BinaryFormat } from "@yep-anywhere/shared";
import { CoreApiError } from "../core-api/errors.js";
import {
  SrpServerSession,
  generateVerifier,
  deriveDecoySalt,
} from "../crypto/srp-server.js";
import {
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
  decryptBinaryEnvelopeRaw,
  encryptToBinaryEnvelope,
} from "../crypto/nacl-wrapper.js";
import { unwrapSequencedClientMessage } from "../routes/ws-transport-message-auth.js";
import type { StoredIncomingPeer } from "./state.js";
import type { PeerSrpContext } from "./http.js";
import {
  PEER_WIRE_BYTES,
  PEER_BODY_BYTES,
  PEER_HANDSHAKE_BYTES,
  PEER_HANDSHAKE_MS,
  PEER_CHANNEL_MS,
  PEER_IDLE_MS,
  PEER_LIFETIME_MS,
  PEER_CONCURRENT_REQUESTS,
  PEER_REUSE,
  peerCancel,
  awaitPeerWork,
  PEER_PROTOCOL,
  PEER_REFRESH_PROTOCOL,
  peerHello,
  peerProof,
  peerWireRequest,
  readPeerReply,
  wireBytes,
  type PeerChannelBudget,
} from "./srp-protocol.js";

interface PeerSrpServerOptions {
  serverId: string;
  decoySecret: string;
  budget: PeerChannelBudget;
  lookup(username: string): StoredIncomingPeer | undefined;
  handle(request: Request, context: PeerSrpContext): Promise<Response>;
}

/** Sessionless use of the existing SRP/NaCl protocol. No browser login or resume. */
export class PeerSrpRuntime {
  private readonly channels = new Set<PeerChannel>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: PEER_WIRE_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  private closed = false;
  private constructor(
    private readonly options: PeerSrpServerOptions,
    private readonly decoyVerifier: string,
  ) {}
  static async create(options: PeerSrpServerOptions) {
    const decoy = await generateVerifier("peer-decoy", options.decoySecret);
    return new PeerSrpRuntime(options, decoy.verifier);
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (request.url !== "/peer/ws") return false;
    if (
      this.closed ||
      request.headers.origin !== undefined ||
      !this.options.budget.available()
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.accept(ws, undefined, false, "direct");
    });
    return true;
  }
  /** False requests registration backoff, rather than a tight rejected-claim loop. */
  accept(
    ws: WebSocket,
    first?: Buffer,
    isBinary = false,
    route: "direct" | "relay" = "relay",
  ) {
    // Refused handoffs have no channel owner to install an error listener.
    ws.on("error", () => {});
    if (this.closed) {
      ws.terminate();
      return false;
    }
    let admission: ReturnType<PeerChannelBudget["acquire"]>;
    try {
      admission = this.options.budget.acquire();
    } catch {
      ws.terminate();
      return false;
    }
    const channel = new PeerChannel(
      ws,
      route,
      this.options,
      this.decoyVerifier,
      admission,
      () => this.channels.delete(channel),
    );
    this.channels.add(channel);
    ws.on("message", (data, binary) => {
      void channel.receive(data, binary);
    });
    ws.on("close", () => channel.dispose());
    ws.on("error", () => channel.terminate());
    if (first) void channel.receive(first, isBinary);
    return true;
  }
  revoke(credentialId: string) {
    for (const channel of this.channels)
      if (channel.credentialId === credentialId) channel.terminate();
  }
  closeRoute(route: "direct" | "relay") {
    for (const channel of this.channels)
      if (channel.route === route) channel.terminate();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels) channel.terminate();
    this.wss.close();
  }
}

class PeerChannel {
  private phase: "hello" | "proof" | "request" | "closed" = "hello";
  private processing = false;
  private disposed = false;
  private srp?: SrpServerSession;
  private peer?: StoredIncomingPeer;
  private key?: Uint8Array;
  private reusable: boolean | undefined;
  private outbound = 0;
  private output = Promise.resolve();
  private readonly requests = new Map<
    string,
    {
      controller: AbortController;
      deadline: ReturnType<typeof setTimeout>;
    }
  >();
  private idle?: ReturnType<typeof setTimeout>;
  private lifetime?: ReturnType<typeof setTimeout>;
  private protocol: "peer-v0" | "peer-v1" = PEER_PROTOCOL;
  private readonly sequence = { lastInboundSeq: null as number | null };
  private readonly handshake: ReturnType<typeof setTimeout>;
  private readonly whole: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  get credentialId() {
    return this.peer?.id;
  }
  constructor(
    private readonly ws: WebSocket,
    readonly route: "direct" | "relay",
    private readonly options: PeerSrpServerOptions,
    private readonly decoyVerifier: string,
    private readonly admission: ReturnType<PeerChannelBudget["acquire"]>,
    private readonly onDisposed: () => void,
  ) {
    this.handshake = setTimeout(() => this.terminate(), PEER_HANDSHAKE_MS);
    this.handshake.unref();
    this.whole = setTimeout(() => this.terminate(), PEER_CHANNEL_MS);
    this.whole.unref();
    admission.controller.signal.addEventListener("abort", this.abort, {
      once: true,
    });
  }
  private readonly abort = () => this.terminate();
  private current() {
    if (this.disposed || !this.peer)
      throw new CoreApiError(
        "unauthorized",
        "Peer authentication is not active",
        401,
      );
    const current = this.options.lookup(this.peer.username);
    if (
      !current ||
      current.id !== this.peer.id ||
      current.generation !== this.peer.generation ||
      current.tokenHash !== this.peer.tokenHash ||
      current.expiresAt <= Date.now()
    )
      throw new CoreApiError(
        "unauthorized",
        "Peer credential changed or expired",
        401,
      );
    return current;
  }
  async receive(data: RawData, isBinary: boolean) {
    if (this.disposed || this.phase === "closed") return;
    if (this.processing) {
      this.terminate();
      return;
    }
    this.processing = true;
    try {
      const bytes = wireBytes(data);
      if (bytes.length > PEER_WIRE_BYTES)
        throw new Error("Oversized peer frame");
      if (this.phase === "request") {
        if (!isBinary || !this.key)
          throw new Error("Encrypted binary request required");
        const decoded = decryptBinaryEnvelopeRaw(bytes, this.key);
        if (!decoded || decoded.format !== BinaryFormat.JSON)
          throw new Error("Only encrypted JSON is accepted");
        const sequenced = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(decoded.payload),
        );
        const message = unwrapSequencedClientMessage(
          { send: () => {}, close: () => this.terminate() },
          this.sequence,
          sequenced,
        );
        if (!message) return;
        if (this.reusable && peerCancel.safeParse(message).success) {
          this.requests.get(peerCancel.parse(message).id)?.controller.abort();
          return;
        }
        const request = peerWireRequest.parse(message);
        const reusable = request.headers["X-YA-Peer-Channel"] === PEER_REUSE;
        if (this.reusable === undefined) {
          // Offer reuse in the first protected reply without extending the strict
          // legacy handshake. Old sources terminate after that reply themselves.
          this.reusable = true;
          clearTimeout(this.whole);
          this.lifetime = setTimeout(() => this.terminate(), PEER_LIFETIME_MS);
          this.lifetime.unref();
        } else if (!reusable) throw new Error("Peer channel mode changed");
        if (this.requests.has(request.id))
          throw new Error("Duplicate peer request id");
        if (this.requests.size >= PEER_CONCURRENT_REQUESTS) {
          this.respond(request.id, {
            status: 503,
            headers: {},
            body: {
              error: {
                code: "command_capacity",
                message: "Peer channel handler capacity reached",
              },
            },
          });
          return;
        }
        this.dispatch(request);
        return;
      }
      if (isBinary || bytes.length > PEER_HANDSHAKE_BYTES)
        throw new Error("Invalid handshake frame");
      const message: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (this.phase === "hello") await this.hello(peerHello.parse(message));
      else if (this.phase === "proof")
        await this.proof(peerProof.parse(message));
      else throw new Error("Unexpected peer frame");
    } catch {
      if (this.key) {
        this.terminate();
        return;
      }
      // Deliberately generic: do not log credentials or disclose identity existence.
      if (!this.disposed && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "srp_error",
            code: "invalid_proof",
            message: "Peer authentication failed",
          }),
        );
        this.phase = "closed";
        this.ws.close(4001, "Peer authentication failed");
        return;
      }
      this.terminate();
    } finally {
      this.processing = false;
    }
  }
  private async hello(message: ReturnType<typeof peerHello.parse>) {
    if (!this.options.budget.hello.admitIdentity(message.identity))
      throw new Error("Peer handshake rate exceeded");
    const started = performance.now(),
      candidate = this.options.lookup(message.identity);
    this.protocol = message.peerProtocol;
    if (
      candidate &&
      candidate.expiresAt > Date.now() &&
      (!candidate.authentication || this.protocol === PEER_REFRESH_PROTOCOL)
    ) {
      this.peer = candidate;
      const remaining = candidate.expiresAt - Date.now();
      if (remaining < PEER_CHANNEL_MS) {
        this.expiry = setTimeout(
          () => this.terminate(),
          Math.max(0, remaining),
        );
        this.expiry.unref();
      }
    }
    const salt =
      this.peer?.salt ??
      deriveDecoySalt(this.options.decoySecret, message.identity);
    this.srp = new SrpServerSession();
    const challenge = await this.options.budget.crypto(() =>
      this.srp!.generateChallenge(
        message.identity,
        salt,
        this.peer?.verifier ?? this.decoyVerifier,
      ),
    );
    const padding = 250 - (performance.now() - started);
    if (padding > 0)
      await delay(padding, undefined, {
        signal: this.admission.controller.signal,
      });
    if (this.disposed) return;
    if (this.peer) this.current();
    this.phase = "proof";
    this.ws.send(
      JSON.stringify({ type: "srp_challenge", salt, B: challenge.B }),
    );
  }
  private async proof(message: ReturnType<typeof peerProof.parse>) {
    const verified = await this.options.budget.crypto(() =>
      this.srp!.verifyProof(message.A, message.M1),
    );
    const peer = this.current(); // Also fences unknown identities and rotation during async proof.
    if (!verified) throw new Error("Invalid peer proof");
    const base = deriveSecretboxKey(this.srp!.getSessionKey()!);
    const transportNonce = randomBytes(24).toString("base64");
    const info = {
      type: "srp_verify_server_info",
      protocol: this.protocol,
      ...(this.protocol === PEER_REFRESH_PROTOCOL
        ? { sourceServerId: peer.sourceServerId }
        : {}),
      ...(peer.authentication
        ? { authentication: peer.authentication.protocol }
        : {}),
      serverId: this.options.serverId,
      envelopeVersion: PEER_ENVELOPE_VERSION,
      credentialId: peer.id,
      generation: peer.generation,
      ...(peer.origin === "fleet" ? { fleet: 1 as const } : {}),
      expiresAt: peer.expiresAt,
      transportNonce,
    };
    this.key = deriveTransportKey(base, transportNonce);
    clearTimeout(this.handshake);
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => this.terminate(),
      Math.max(0, Math.min(PEER_LIFETIME_MS, peer.expiresAt - Date.now())),
    );
    this.expiry.unref();
    this.phase = "request";
    this.ws.send(
      JSON.stringify({
        type: "srp_verify",
        M2: verified.M2,
        transportNonce,
        serverInfoProof: JSON.stringify(encrypt(JSON.stringify(info), base)),
      }),
    );
  }
  private dispatch(message: ReturnType<typeof peerWireRequest.parse>) {
    clearTimeout(this.idle);
    this.options.budget.busy(this.admission.controller);
    let admission: ReturnType<PeerChannelBudget["acquireWork"]>;
    try {
      admission = this.options.budget.acquireWork();
    } catch (error) {
      const failure = error as CoreApiError;
      this.respond(message.id, {
        status: failure.status,
        headers: {},
        body: { error: { code: failure.code, message: failure.message } },
      });
      this.retain();
      return;
    }
    const controller = admission.controller;
    const deadline = setTimeout(() => controller.abort(), PEER_CHANNEL_MS);
    deadline.unref();
    this.requests.set(message.id, { controller, deadline });
    const signal = AbortSignal.any([
      controller.signal,
      this.admission.controller.signal,
    ]);
    const work = this.request(message, signal);
    const response = (async () => {
      let reply: Awaited<typeof work>;
      try {
        reply = await awaitPeerWork(work, signal);
      } catch (error) {
        const failure =
          error instanceof CoreApiError
            ? error
            : new CoreApiError(
                "peer_unavailable",
                "Peer request was cancelled; submitted work may have been accepted",
                503,
              );
        reply = {
          status: failure.status,
          headers: { "X-YA-Server-ID": this.options.serverId },
          body: { error: { code: failure.code, message: failure.message } },
        };
      }
      // Keep at most eight response writers, each within its handler reservation.
      // Waiting for send completion drains large replies without buffering a second one.
      const sending = this.output.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.disposed) {
              reject(new Error("Peer closed"));
              return;
            }
            this.respond(message.id, reply, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
      this.output = sending.catch(() => {});
      const writeDeadline = setTimeout(() => this.terminate(), PEER_CHANNEL_MS);
      writeDeadline.unref();
      try {
        await awaitPeerWork(sending, this.admission.controller.signal);
      } finally {
        clearTimeout(writeDeadline);
      }
    })();
    void response.catch(() => this.terminate());
    void Promise.allSettled([work, response]).then(() => {
      clearTimeout(deadline);
      admission.release();
      this.requests.delete(message.id);
      this.retain();
    });
  }

  private retain() {
    if (this.disposed || !this.reusable || this.requests.size) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.terminate(), PEER_IDLE_MS);
    this.idle.unref();
    this.options.budget.retain(this.admission.controller, () =>
      this.terminate(),
    );
  }
  private async request(
    message: ReturnType<typeof peerWireRequest.parse>,
    signal: AbortSignal,
  ) {
    const peer = this.current();
    const target = new URL(message.path, "http://peer.internal");
    if (
      target.origin !== "http://peer.internal" ||
      `${target.pathname}${target.search}` !== message.path ||
      (!/^\/v0(?:\/|$)/.test(target.pathname) &&
        !(
          this.protocol === PEER_REFRESH_PROTOCOL &&
          [PEER_IDENTITY_PATH, PEER_REFRESH_PATH].includes(target.pathname)
        )) ||
      message.path.includes("\\") ||
      message.path.includes("#")
    )
      throw new CoreApiError(
        "invalid_request",
        "Invalid peer request target",
        400,
      );
    const body =
      message.body === undefined
        ? undefined
        : typeof message.body === "string"
          ? message.body
          : JSON.stringify(message.body);
    if (body && Buffer.byteLength(body) > PEER_BODY_BYTES)
      throw new CoreApiError("invalid_request", "Oversized peer body", 400);
    const request = new Request(target, {
      method: message.method,
      headers: message.headers,
      body,
      signal,
    });
    let reply: {
      status: number;
      headers: Record<string, string>;
      body: unknown;
    };
    try {
      const response = await this.options.handle(request, {
        credentialId: peer.id,
        generation: peer.generation,
        protocol: this.protocol,
      });
      const bytes = await readPeerReply(response.body, signal);
      reply = {
        status: response.status,
        headers: {
          "X-YA-Server-ID": this.options.serverId,
          ...(response.headers.has("Content-Type")
            ? { "Content-Type": response.headers.get("Content-Type")! }
            : {}),
          ...(response.headers.has(RECEIPT_HEADER)
            ? { [RECEIPT_HEADER]: response.headers.get(RECEIPT_HEADER)! }
            : {}),
        },
        body: bytes.toString("utf8"),
      };
    } catch (error) {
      const failure =
        error instanceof CoreApiError
          ? error
          : new CoreApiError(
              "peer_unavailable",
              "Peer operation could not produce a reply",
              503,
            );
      reply = {
        status: failure.status,
        headers: { "X-YA-Server-ID": this.options.serverId },
        body: { error: { code: failure.code, message: failure.message } },
      };
    }
    return reply;
  }
  private respond(
    id: string,
    reply: { status: number; headers: Record<string, string>; body: unknown },
    sent?: (error?: Error) => void,
  ) {
    this.current();
    const encode = (value: typeof reply) =>
      encryptToBinaryEnvelope(
        JSON.stringify({
          seq: this.outbound,
          msg: {
            type: "response",
            id,
            ...value,
            headers: {
              ...value.headers,
              "X-YA-Server-ID": this.options.serverId,
              "X-YA-Peer-Channel": PEER_REUSE,
            },
          },
        }),
        this.key!,
      );
    let frame = encode(reply);
    const oversized = frame.byteLength > PEER_WIRE_BYTES - 4096;
    if (
      oversized ||
      this.ws.bufferedAmount + frame.byteLength > PEER_WIRE_BYTES - 4096
    ) {
      frame = encode({
        status: oversized ? 502 : 503,
        headers: { "X-YA-Server-ID": this.options.serverId },
        body: {
          error: {
            code: oversized ? "peer_response_too_large" : "peer_unavailable",
            message: oversized
              ? "Peer reply exceeds wire capacity; narrow limit or maxMessages"
              : "Peer output capacity reached; submitted work may have been accepted",
          },
        },
      });
    }
    if (this.ws.bufferedAmount + frame.byteLength > PEER_WIRE_BYTES)
      throw new Error("Peer output capacity reached");
    this.ws.send(frame, sent);
    this.outbound++;
  }
  terminate() {
    if (this.disposed) return;
    this.dispose();
    this.ws.terminate();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = "closed";
    clearTimeout(this.handshake);
    clearTimeout(this.whole);
    clearTimeout(this.expiry);
    clearTimeout(this.idle);
    clearTimeout(this.lifetime);
    for (const { controller, deadline } of this.requests.values()) {
      clearTimeout(deadline);
      controller.abort();
    }
    this.requests.clear();
    this.admission.controller.signal.removeEventListener("abort", this.abort);
    this.admission.controller.abort();
    this.admission.release();
    this.onDisposed();
    this.key = undefined;
    this.srp = undefined;
  }
}
