import type { RawData } from "ws";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";

export const PEER_WIRE_BYTES = 384 * 1024;
export const PEER_BODY_BYTES = 256 * 1024;
export const PEER_REPLY_BYTES = 256 * 1024;
export const PEER_HANDSHAKE_BYTES = 8 * 1024;
export const PEER_HANDSHAKE_MS = 10_000;
export const PEER_CHANNEL_MS = 12_000;
export const PEER_PROTOCOL = "peer-v0";
export const PEER_REFRESH_PROTOCOL = "peer-v1";
const hex = z
  .string()
  .regex(/^[0-9a-f]+$/i)
  .min(1)
  .max(1024);
export const peerHello = z
  .object({
    type: z.literal("srp_hello"),
    identity: z.string().regex(/^peer-[0-9a-f-]{36}$/),
    peerProtocol: z.enum([PEER_PROTOCOL, PEER_REFRESH_PROTOCOL]),
  })
  .strict();
export const peerChallenge = z
  .object({ type: z.literal("srp_challenge"), salt: hex, B: hex })
  .strict();
export const peerProof = z
  .object({ type: z.literal("srp_proof"), A: hex, M1: hex })
  .strict();
export const peerVerify = z
  .object({
    type: z.literal("srp_verify"),
    M2: hex,
    transportNonce: z.string().max(128),
    serverInfoProof: z.string().max(4096),
  })
  .strict();
export const peerServerInfo = z
  .object({
    type: z.literal("srp_verify_server_info"),
    protocol: z.enum([PEER_PROTOCOL, PEER_REFRESH_PROTOCOL]),
    authentication: z.literal("refresh-v1").optional(),
    serverId: z.string().uuid(),
    sourceServerId: z.uuid().optional(),
    credentialId: z.string().uuid(),
    generation: z.number().int().positive(),
    fleet: z.literal(1).optional(),
    expiresAt: z.number().int().positive(),
    transportNonce: z.string().regex(/^[A-Za-z0-9+/]{32}$/),
  })
  .strict();
export const peerWireRequest = z
  .object({
    type: z.literal("request"),
    id: z.string().uuid(),
    method: z.enum(["GET", "POST"]),
    path: z
      .string()
      .min(1)
      .max(16 * 1024),
    headers: z
      .object({
        Authorization: z.string().max(256),
        "Content-Type": z.literal("application/json"),
        "X-YA-Peer-Context": z.string().max(2048),
        "X-YA-Fleet-Grant": z
          .string()
          .max(32 * 1024)
          .optional(),
      })
      .strict(),
    body: z.unknown().optional(),
  })
  .strict()
  .refine(
    (request) => request.method !== "GET" || request.body === undefined,
    "GET bodies are not accepted",
  );
export const peerWireReply = z
  .object({
    type: z.literal("response"),
    id: z.string().uuid(),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  })
  .strict();
export function wireBytes(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;
}

/** Native crypto is not cancellable; callers still observe their deadline. */
export async function awaitPeerWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new CoreApiError(
          "peer_unavailable",
          "Peer setup was cancelled before submission",
          503,
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Cancel a blocked reader without awaiting a potentially malicious cancel hook. */
export async function readPeerReply(
  stream: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) {
  const reader = stream?.getReader();
  if (!reader) return Buffer.alloc(0);
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        new CoreApiError(
          "controller_unavailable",
          "Peer reply was cancelled",
          503,
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > PEER_REPLY_BYTES)
        throw new CoreApiError(
          "peer_response_too_large",
          "Peer reply exceeds 256 KiB; narrow limit or maxMessages where possible",
          502,
        );
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Demand-driven bounded rate state; no sweeper or per-identity timers. */
export class PeerHelloBudget {
  private global = { tokens: 32, updatedAt: performance.now() };
  private identities = new Map<string, { tokens: number; updatedAt: number }>();
  private take(
    bucket: { tokens: number; updatedAt: number },
    perMinute: number,
  ) {
    const now = performance.now();
    bucket.tokens = Math.min(
      32,
      bucket.tokens +
        (Math.max(0, now - bucket.updatedAt) * perMinute) / 60_000,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  admitConnection() {
    return this.take(this.global, 256);
  }
  admitIdentity(identity: string) {
    let bucket = this.identities.get(identity);
    if (bucket) this.identities.delete(identity);
    else {
      if (this.identities.size >= 1024)
        this.identities.delete(this.identities.keys().next().value!);
      bucket = { tokens: 32, updatedAt: performance.now() };
    }
    this.identities.set(identity, bucket);
    return this.take(bucket, 120);
  }
}

/** Shared by one profile's incoming and outgoing channels, including pre-auth. */
export class PeerChannelBudget {
  private readonly entries = new Set<AbortController>();
  readonly hello = new PeerHelloBudget();
  private closed = false;
  private cryptography = 0;
  /** At most 32 native crypto jobs, including work on already closed channels. */
  async crypto<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.cryptography >= 32)
      throw new CoreApiError(
        "command_capacity",
        "Peer cryptography capacity reached",
        503,
      );
    this.cryptography++;
    try {
      return await work();
    } finally {
      this.cryptography--;
    }
  }
  available() {
    return !this.closed && this.entries.size < 32;
  }
  acquire() {
    if (!this.available() || !this.hello.admitConnection())
      throw new CoreApiError(
        "command_capacity",
        "Peer channel admission capacity reached",
        503,
      );
    const controller = new AbortController();
    this.entries.add(controller);
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        this.entries.delete(controller);
      },
    };
  }
  close() {
    this.closed = true;
    for (const entry of this.entries) entry.abort();
  }
}
