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
  PEER_PROTOCOL,
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
  private phase: "hello" | "proof" | "request" | "reply" | "closed" = "hello";
  private processing = false;
  private disposed = false;
  private srp?: SrpServerSession;
  private peer?: StoredIncomingPeer;
  private key?: Uint8Array;
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
    if (this.disposed) return;
    if (this.processing || this.phase === "reply") {
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
        this.phase = "reply";
        await this.request(peerWireRequest.parse(message));
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
      // Deliberately generic: do not log credentials or disclose identity existence.
      if (
        !this.disposed &&
        this.ws.readyState === WebSocket.OPEN &&
        this.phase !== "reply"
      ) {
        this.ws.send(
          JSON.stringify({
            type: "srp_error",
            code: "invalid_proof",
            message: "Peer authentication failed",
          }),
        );
        this.phase = "reply";
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
    if (candidate && candidate.expiresAt > Date.now()) {
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
      protocol: PEER_PROTOCOL,
      serverId: this.options.serverId,
      credentialId: peer.id,
      generation: peer.generation,
      ...(peer.origin === "fleet" ? { fleet: 1 as const } : {}),
      expiresAt: peer.expiresAt,
      transportNonce,
    };
    this.key = deriveTransportKey(base, transportNonce);
    clearTimeout(this.handshake);
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
  private async request(message: ReturnType<typeof peerWireRequest.parse>) {
    const peer = this.current();
    const target = new URL(message.path, "http://peer.internal");
    if (
      target.origin !== "http://peer.internal" ||
      `${target.pathname}${target.search}` !== message.path ||
      !/^\/v0(?:\/|$)/.test(target.pathname) ||
      message.path.includes("\\") ||
      message.path.includes("#")
    )
      throw new Error("Invalid peer request target");
    const body =
      message.body === undefined ? undefined : JSON.stringify(message.body);
    if (body && Buffer.byteLength(body) > PEER_BODY_BYTES)
      throw new Error("Oversized peer body");
    const request = new Request(target, {
      method: message.method,
      headers: message.headers,
      body,
      signal: this.admission.controller.signal,
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
      });
      const bytes = await readPeerReply(
        response.body,
        this.admission.controller.signal,
      );
      reply = {
        status: response.status,
        headers: { "X-YA-Server-ID": this.options.serverId },
        body: JSON.parse(bytes.toString("utf8")),
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
    this.current();
    const frame = encryptToBinaryEnvelope(
      JSON.stringify({
        seq: 0,
        msg: { type: "response", id: message.id, ...reply },
      }),
      this.key!,
    );
    if (
      frame.byteLength > PEER_WIRE_BYTES ||
      this.ws.bufferedAmount + frame.byteLength > PEER_WIRE_BYTES
    )
      throw new Error("Peer output capacity reached");
    this.ws.send(frame);
    this.ws.close(1000, "Peer request complete");
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
    this.admission.controller.signal.removeEventListener("abort", this.abort);
    this.admission.controller.abort();
    this.admission.release();
    this.onDisposed();
    this.key = undefined;
    this.srp = undefined;
  }
}
