import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BinaryFormat } from "@yep-anywhere/shared";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import {
  decryptBinaryEnvelopeRaw,
  encryptToBinaryEnvelope,
} from "../crypto/nacl-wrapper.js";
import {
  PEER_CHANNEL_MS,
  PEER_HANDSHAKE_MS,
  PEER_IDLE_MS,
  PEER_LIFETIME_MS,
  PEER_CONCURRENT_REQUESTS,
  PEER_REUSE,
  PEER_REPLY_BYTES,
  PEER_WIRE_BYTES,
  type peerWireRequest,
  peerWireReply,
  wireBytes,
  awaitPeerWork,
  type PeerChannelBudget,
} from "./srp-protocol.js";

export interface PeerConnection {
  ws: WebSocket;
  key: Uint8Array;
  reusable?: boolean;
  expiresAt: number;
}
/** Internal admission outcome: this request has never been sent on the wire. */
export class PeerChannelNotSubmitted extends Error {}
type Reply = z.infer<typeof peerWireReply>;
type Pending = {
  resolve(reply: Reply): void;
  reject(error: unknown): void;
  cleanup(): void;
  cancelled: boolean;
};
const unavailable = () =>
  new CoreApiError(
    "peer_unavailable",
    "Peer channel closed; a submitted mutation may have been accepted; retry only with its identical key",
    503,
  );

/** One bounded socket, shared setup and independent request cancellation. No resend. */
export class PeerClientChannel {
  closed = false;
  reuseSupported?: boolean;
  hasReply = false;
  private retiring = false;
  private readonly createdAt = Date.now();
  get available() {
    return (
      !this.closed && !this.retiring && this.occupied < PEER_CONCURRENT_REQUESTS
    );
  }
  private retire() {
    this.retiring = true;
    if (!this.pending.size && !this.waiters) this.close();
  }
  private readonly admission: ReturnType<PeerChannelBudget["acquire"]>;
  private readonly ready: Promise<PeerConnection>;
  private connection?: PeerConnection;
  private readonly pending = new Map<string, Pending>();
  private waiters = 0;
  private outbound = 0;
  private inbound = 0;
  private used = false;
  private probing = false;
  private probeId?: string;
  private get occupied() {
    return (
      this.pending.size -
      (this.probeId && this.pending.has(this.probeId) ? 1 : 0) +
      this.waiters
    );
  }
  private negotiated!: () => void;
  private readonly negotiation = new Promise<void>((resolve) => {
    this.negotiated = resolve;
  });
  private idle?: ReturnType<typeof setTimeout>;
  private lifetime?: ReturnType<typeof setTimeout>;
  private readonly setup: ReturnType<typeof setTimeout>;
  constructor(
    private readonly budget: PeerChannelBudget,
    open: (signal: AbortSignal) => Promise<PeerConnection>,
    private readonly reuse: boolean,
    private readonly serverId: string,
    confirmed = false,
  ) {
    this.admission = budget.acquire();
    this.admission.controller.signal.addEventListener("abort", this.aborted, {
      once: true,
    });
    this.setup = setTimeout(() => this.close(), PEER_HANDSHAKE_MS);
    this.setup.unref();
    this.ready = open(this.admission.controller.signal)
      .then((connection) => {
        if (this.closed) {
          connection.ws.terminate();
          throw unavailable();
        }
        clearTimeout(this.setup);
        connection.reusable = this.reuse
          ? confirmed
            ? true
            : undefined
          : false;
        this.reuseSupported = connection.reusable;
        this.connection = connection;
        connection.ws.on("close", (code) =>
          this.close(
            code === 4001
              ? new CoreApiError(
                  "unauthorized",
                  "Peer authentication failed",
                  401,
                )
              : unavailable(),
          ),
        );
        connection.ws.on("error", () => this.close());
        connection.ws.on("message", (data, binary) => {
          try {
            if (!binary) throw new Error("Encrypted peer reply required");
            const decoded = decryptBinaryEnvelopeRaw(
              wireBytes(data),
              connection.key,
            );
            if (!decoded || decoded.format !== BinaryFormat.JSON)
              throw new Error("Invalid protected reply");
            const value = z
              .object({
                seq: z.number().int().nonnegative().safe(),
                msg: peerWireReply,
              })
              .strict()
              .parse(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    decoded.payload,
                  ),
                ),
              );
            if (value.seq !== this.inbound++)
              throw new Error("Invalid reply sequence");
            const pending = this.pending.get(value.msg.id);
            if (!pending) throw new Error("Unknown reply correlation");
            if (
              Buffer.byteLength(JSON.stringify(value.msg.body)) >
              PEER_REPLY_BYTES
            )
              throw new Error("Oversized reply");
            this.hasReply = true;
            if (connection.reusable === undefined) {
              connection.reusable =
                value.msg.headers["X-YA-Peer-Channel"] === PEER_REUSE;
              this.reuseSupported = connection.reusable;
              this.negotiated();
            }
            this.pending.delete(value.msg.id);
            pending.cleanup();
            pending.resolve(value.msg);
            if (!connection.reusable) this.close();
            else this.retain();
          } catch {
            this.close(
              new CoreApiError(
                "peer_identity_mismatch",
                "Peer reply verification failed",
                502,
              ),
            );
          }
        });
        this.lifetime = setTimeout(
          () => this.retire(),
          Math.max(
            0,
            Math.min(
              this.reuse
                ? PEER_LIFETIME_MS -
                    PEER_CHANNEL_MS -
                    (Date.now() - this.createdAt)
                : PEER_CHANNEL_MS,
              connection.expiresAt - Date.now() - PEER_CHANNEL_MS,
            ),
          ),
        );
        this.lifetime.unref();
        return connection;
      })
      .catch((error: unknown) => {
        this.close(error);
        throw error;
      });
    void this.ready.catch(() => {});
  }
  private readonly aborted = () => this.close();
  private busy() {
    clearTimeout(this.idle);
    this.budget.busy(this.admission.controller);
  }
  private retain() {
    if (this.closed || this.pending.size || this.waiters) return;
    if (this.retiring) {
      this.close();
      return;
    }
    if (!this.connection?.reusable) {
      this.close();
      return;
    }
    this.busy();
    this.idle = setTimeout(() => this.close(), PEER_IDLE_MS - 5_000);
    this.idle.unref();
    this.budget.retain(this.admission.controller, () => this.close());
  }
  private send(message: unknown) {
    const connection = this.connection;
    if (
      this.closed ||
      !connection ||
      connection.ws.readyState !== WebSocket.OPEN
    )
      throw unavailable();
    const frame = encryptToBinaryEnvelope(
      JSON.stringify({ seq: this.outbound, msg: message }),
      connection.key,
    );
    if (
      frame.byteLength > PEER_WIRE_BYTES ||
      connection.ws.bufferedAmount + frame.byteLength > PEER_WIRE_BYTES
    )
      throw new CoreApiError(
        "command_capacity",
        "Peer output capacity reached",
        503,
      );
    connection.ws.send(frame);
    this.outbound++;
  }
  private probe(request: z.infer<typeof peerWireRequest>) {
    this.probing = true;
    const id = randomUUID();
    this.probeId = id;
    const deadline = setTimeout(() => this.close(), PEER_CHANNEL_MS);
    deadline.unref();
    // Safe discovery is always granted. Negotiate before sending an operation
    // that might wait, so a cold long poll never holds quick callers behind it.
    this.pending.set(id, {
      resolve: () => {},
      reject: () => {},
      cancelled: false,
      cleanup: () => clearTimeout(deadline),
    });
    try {
      this.send({
        type: "request",
        id,
        method: "GET",
        path: `/v0/servers/${encodeURIComponent(this.serverId)}/capabilities`,
        headers: { ...request.headers },
      });
    } catch (error) {
      this.close(error);
    }
  }
  async request(
    request: z.infer<typeof peerWireRequest>,
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<Reply> {
    if (this.closed || this.retiring) throw new PeerChannelNotSubmitted();
    if (this.occupied >= PEER_CONCURRENT_REQUESTS)
      throw new CoreApiError(
        "command_capacity",
        "Peer channel request capacity reached",
        503,
      );
    this.busy();
    this.waiters++;
    try {
      const connection = await awaitPeerWork(this.ready, signal);
      signal.throwIfAborted();
      assertActive();
      if (connection.reusable === undefined) {
        if (!this.probing) this.probe(request);
        await awaitPeerWork(this.negotiation, signal);
        if (connection.reusable === false) throw new PeerChannelNotSubmitted();
      } else if (this.used && connection.reusable === false)
        throw new PeerChannelNotSubmitted();
      signal.throwIfAborted();
      assertActive();
      if (this.closed || this.retiring) throw new PeerChannelNotSubmitted();
      this.used = true;
      if (connection.reusable)
        request.headers["X-YA-Peer-Channel"] = PEER_REUSE;
      // Returning the promise without awaiting lets the setup waiter release immediately.
      return new Promise<Reply>((resolve, reject) => {
        let deadline = setTimeout(() => this.close(), PEER_CHANNEL_MS);
        deadline.unref();
        const pending: Pending = {
          resolve,
          reject,
          cancelled: false,
          cleanup: () => {
            clearTimeout(deadline);
            signal.removeEventListener("abort", abort);
          },
        };
        const abort = () => {
          if (pending.cancelled) return;
          pending.cancelled = true;
          signal.removeEventListener("abort", abort);
          reject(unavailable());
          // A request deadline must leave a full round trip for its cancel acknowledgement.
          clearTimeout(deadline);
          deadline = setTimeout(() => this.close(), PEER_CHANNEL_MS);
          deadline.unref();
          if (connection.reusable === false) this.close();
          else if (connection.reusable === true) {
            try {
              this.send({ type: "cancel", id: request.id });
            } catch {
              this.close();
            }
          }
          // Keep a bounded slot until the response/cancel acknowledgement arrives.
        };
        this.pending.set(request.id, pending);
        signal.addEventListener("abort", abort, { once: true });
        try {
          this.send(request);
        } catch (error) {
          if (
            error instanceof CoreApiError &&
            error.code === "command_capacity"
          ) {
            this.pending.delete(request.id);
            pending.cleanup();
            pending.reject(error);
          } else this.close();
        }
        if (signal.aborted && this.pending.has(request.id)) abort();
      });
    } finally {
      this.waiters--;
      this.retain();
    }
  }
  close(error: unknown = unavailable()) {
    if (this.closed) return;
    this.closed = true;
    this.negotiated();
    clearTimeout(this.setup);
    clearTimeout(this.idle);
    clearTimeout(this.lifetime);
    this.admission.controller.signal.removeEventListener("abort", this.aborted);
    this.admission.controller.abort();
    this.admission.release();
    this.connection?.ws.terminate();
    this.connection = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
