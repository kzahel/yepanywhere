import {
  PEER_AUTHENTICATION,
  PEER_IDENTITY_PATH,
  PEER_REFRESH_PATH,
  peerRefreshReceipt,
  type PeerRefreshReceipt,
} from "./authentication-contracts.js";
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
import { CoreApiError } from "../core-api/errors.js";
import {
  deriveSecretboxKey,
  deriveTransportKey,
  decrypt,
  encryptToBinaryEnvelope,
  decryptBinaryEnvelopeRaw,
} from "../crypto/nacl-wrapper.js";
import {
  invitationSchema,
  peerRouteSchema,
  type PeerInvitation,
  type PeerRoute,
} from "./state.js";
import {
  peerOperationRequest,
  validatePeerReply,
  type PeerTransport,
  type PeerInput,
} from "./transport.js";
import type { Operation } from "../core-api/contracts.js";
import type { PeerAttestation } from "./directory.js";
import {
  PEER_WIRE_BYTES,
  PEER_REPLY_BYTES,
  PEER_HANDSHAKE_BYTES,
  PEER_CHANNEL_MS,
  PEER_PROTOCOL,
  PEER_REFRESH_PROTOCOL,
  peerChallenge,
  peerVerify,
  peerServerInfo,
  peerWireReply,
  peerWireRequest,
  wireBytes,
  awaitPeerWork,
  type PeerChannelBudget,
} from "./srp-protocol.js";

const routines = new SRPRoutines(new SRPParameters());
const proofEnvelope = z
  .object({ nonce: z.string().max(128), ciphertext: z.string().max(4096) })
  .strict();

/** A fresh mutually authenticated channel per request; no reconnect or resend. */
export class SrpPeerTransport implements PeerTransport {
  readonly serverId: string;
  private readonly invitation: PeerInvitation;
  private readonly route: PeerRoute;
  // Shared profile admission bounds queued handshakes to 32. A legacy relay
  // offers one waiting socket per target; serialize pairing, not HTTP work.
  private handshakeBusy = false;
  private readonly handshakes = new Set<() => void>();
  private enterHandshake(signal: AbortSignal): Promise<() => void> {
    if (this.route.kind !== "relay") return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      let waiting = true;
      const abort = () => {
        if (!waiting) return;
        waiting = false;
        this.handshakes.delete(enter);
        signal.removeEventListener("abort", abort);
        reject(
          new CoreApiError(
            "peer_unavailable",
            "Peer pairing was cancelled before submission",
            503,
          ),
        );
      };
      const enter = () => {
        if (!waiting) return;
        waiting = false;
        this.handshakes.delete(enter);
        signal.removeEventListener("abort", abort);
        this.handshakeBusy = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.handshakeBusy = false;
          this.handshakes.values().next().value?.();
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (this.handshakeBusy) this.handshakes.add(enter);
      else enter();
    });
  }
  constructor(
    invitation: PeerInvitation,
    route: PeerRoute,
    private readonly budget: PeerChannelBudget,
    private readonly fleet?: {
      token(signal: AbortSignal): Promise<{ token: string; expiresAt: number }>;
      assertActive(): void;
    },
    private readonly authentication?: {
      invitation(): PeerInvitation;
      token(signal?: AbortSignal): Promise<string>;
    },
  ) {
    this.invitation = invitationSchema.parse(invitation);
    this.route = peerRouteSchema.parse(route);
    this.serverId = this.invitation.targetServerId;
  }
  request(
    operation: Operation,
    input: PeerInput,
    attestation: PeerAttestation,
  ): Promise<unknown> {
    return this.exchange(operation, input, attestation);
  }
  identity(signal?: AbortSignal): Promise<unknown> {
    return this.exchange(
      "access",
      { serverId: this.serverId, signal },
      { sessionId: null, launchId: null },
      { path: PEER_IDENTITY_PATH },
    );
  }
  refresh(body: unknown, signal: AbortSignal): Promise<PeerRefreshReceipt> {
    return this.exchange(
      "access",
      { serverId: this.serverId, signal },
      { sessionId: null, launchId: null },
      { path: PEER_REFRESH_PATH, body },
    ) as Promise<PeerRefreshReceipt>;
  }
  private async exchange(
    operation: Operation,
    input: PeerInput,
    attestation: PeerAttestation,
    privateRequest?: { path: string; body?: unknown },
  ): Promise<unknown> {
    const bearer = privateRequest
      ? undefined
      : await this.authentication?.token(input.signal);
    const invitation = this.authentication?.invitation() ?? this.invitation;
    const protocol =
      privateRequest || invitation.authentication
        ? PEER_REFRESH_PROTOCOL
        : PEER_PROTOCOL;
    if (input.serverId !== this.serverId)
      throw new CoreApiError(
        "peer_identity_mismatch",
        "Peer request target does not match its connection",
        502,
      );
    if (protocol === PEER_PROTOCOL && invitation.expiresAt <= Date.now())
      throw new CoreApiError("unauthorized", "Peer invitation expired", 401);
    const admission = this.budget.acquire();
    const fleetExpiry = new AbortController();
    let fleetDeadline: ReturnType<typeof setTimeout> | undefined;
    const signal = AbortSignal.any([
      fleetExpiry.signal,
      admission.controller.signal,
      AbortSignal.timeout(PEER_CHANNEL_MS),
      ...(input.signal ? [input.signal] : []),
    ]);
    let releaseHandshake = () => {};
    try {
      signal.throwIfAborted();
      this.fleet?.assertActive();
      const fleetToken = this.fleet
        ? await awaitPeerWork(this.fleet.token(signal), signal)
        : undefined;
      const assertFleetActive = () => {
        this.fleet?.assertActive();
        if (fleetToken && fleetToken.expiresAt <= Date.now())
          throw new CoreApiError(
            "unauthorized",
            "Fleet authority expired before submission or observation",
            401,
          );
      };
      if (fleetToken) {
        if (
          fleetToken.expiresAt <= Date.now() ||
          fleetToken.token.length > 32 * 1024
        )
          throw new CoreApiError(
            "unauthorized",
            "Fleet authority has expired",
            401,
          );
        fleetDeadline = setTimeout(
          () => fleetExpiry.abort(),
          fleetToken.expiresAt - Date.now(),
        );
        fleetDeadline.unref?.();
      }
      const step1 = await awaitPeerWork(
        this.budget.crypto(() =>
          new SRPClientSession(routines).step1(
            invitation.username,
            invitation.secret,
          ),
        ),
        signal,
      );
      releaseHandshake = await this.enterHandshake(signal);
      signal.throwIfAborted();
      const request = {
        type: "request" as const,
        id: randomUUID(),
        ...peerOperationRequest(
          operation,
          input,
          attestation,
          bearer ?? invitation.secret,
        ),
      };
      if (privateRequest)
        Object.assign(request, {
          method: privateRequest.body === undefined ? "GET" : "POST",
          path: privateRequest.path,
          body: privateRequest.body,
        });
      if (fleetToken)
        Object.assign(request.headers, {
          "X-YA-Fleet-Grant": fleetToken.token,
        });
      if (!peerWireRequest.safeParse(request).success)
        throw new CoreApiError(
          "invalid_request",
          "Peer request is outside its supported wire limits",
          400,
        );
      return await new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(this.route.url, {
          maxPayload: PEER_WIRE_BYTES,
          perMessageDeflate: false,
        });
        let phase: "relay" | "challenge" | "verify" | "reply" =
          this.route.kind === "relay" ? "relay" : "challenge";
        let step2: SRPClientSessionStep2 | undefined,
          key: Uint8Array | undefined;
        let settled = false,
          processing = false;
        const finish = (error?: CoreApiError, result?: unknown) => {
          if (settled) return;
          settled = true;
          releaseHandshake();
          signal.removeEventListener("abort", abort);
          // The one reply is already in memory; no graceful-close linger can
          // retain unlimited source sockets against a noncooperative peer.
          ws.terminate();
          if (error) reject(error);
          else resolve(result);
        };
        const abort = () =>
          finish(
            new CoreApiError(
              "peer_unavailable",
              "Peer request was cancelled; a submitted mutation may have been accepted",
              503,
            ),
          );
        const hello = () =>
          ws.send(
            JSON.stringify({
              type: "srp_hello",
              identity: invitation.username,
              peerProtocol: protocol,
            }),
          );
        ws.on("open", () => {
          if (settled) return;
          if (this.route.kind === "relay")
            ws.send(
              JSON.stringify({
                type: "client_connect",
                username: this.route.username,
              }),
            );
          else hello();
        });
        ws.on("error", () =>
          finish(
            new CoreApiError(
              "peer_unavailable",
              "Peer connection is unavailable; retry mutations only with their identical key",
              503,
            ),
          ),
        );
        ws.on("unexpected-response", (_request, response) => {
          response.destroy();
          finish(
            new CoreApiError(
              "peer_unsupported",
              "Endpoint does not support peer SRP",
              501,
            ),
          );
        });
        ws.on("close", (code) =>
          finish(
            code === 4001
              ? new CoreApiError(
                  "unauthorized",
                  "Peer authentication failed",
                  401,
                )
              : new CoreApiError(
                  "peer_unavailable",
                  "Peer closed before its reply; mutation outcome may be uncertain",
                  503,
                ),
          ),
        );
        ws.on("message", (data, isBinary) => {
          if (settled) return;
          if (processing) {
            finish(
              new CoreApiError(
                "peer_unsupported",
                "Unexpected concurrent peer frame",
                501,
              ),
            );
            return;
          }
          processing = true;
          void (async () => {
            const bytes = wireBytes(data);
            if (phase === "reply") {
              if (!isBinary || !key)
                throw new CoreApiError(
                  "peer_unsupported",
                  "Encrypted peer reply required",
                  501,
                );
              const decoded = decryptBinaryEnvelopeRaw(bytes, key);
              if (!decoded || decoded.format !== BinaryFormat.JSON)
                throw new CoreApiError(
                  "peer_identity_mismatch",
                  "Invalid protected peer reply",
                  502,
                );
              const sequenced = z
                .object({ seq: z.literal(0), msg: peerWireReply })
                .strict()
                .parse(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      decoded.payload,
                    ),
                  ),
                );
              if (sequenced.msg.id !== request.id)
                throw new CoreApiError(
                  "peer_identity_mismatch",
                  "Peer reply correlation does not match",
                  502,
                );
              if (
                Buffer.byteLength(JSON.stringify(sequenced.msg.body)) >
                PEER_REPLY_BYTES
              )
                throw new CoreApiError(
                  "peer_response_too_large",
                  "Peer reply exceeds 256 KiB; narrow limit or maxMessages",
                  502,
                );
              assertFleetActive();
              const result =
                privateRequest?.path === PEER_REFRESH_PATH &&
                sequenced.msg.status === 200
                  ? peerRefreshReceipt.parse(sequenced.msg.body)
                  : validatePeerReply(
                      operation,
                      this.serverId,
                      sequenced.msg.status,
                      new Headers(sequenced.msg.headers),
                      sequenced.msg.body,
                    );
              finish(undefined, result);
              return;
            }
            if (isBinary || bytes.length > PEER_HANDSHAKE_BYTES)
              throw new CoreApiError(
                "peer_unsupported",
                "Invalid peer handshake frame",
                501,
              );
            const value: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            );
            if (
              value &&
              typeof value === "object" &&
              "type" in value &&
              value.type === "srp_error"
            )
              throw new CoreApiError(
                "unauthorized",
                "Peer authentication failed",
                401,
              );
            if (phase === "relay") {
              if (isRelayClientError(value))
                throw new CoreApiError(
                  "peer_unavailable",
                  "Peer relay route is offline or unknown",
                  503,
                );
              const message = z
                .object({ type: z.literal("client_connected") })
                .passthrough()
                .parse(value);
              if (message.type !== "client_connected")
                throw new Error("Relay did not pair");
              phase = "challenge";
              hello();
              return;
            }
            if (phase === "challenge") {
              const challenge = peerChallenge.parse(value);
              step2 = await this.budget.crypto(() =>
                step1.step2(
                  BigInt(`0x${challenge.salt}`),
                  BigInt(`0x${challenge.B}`),
                ),
              );
              if (settled) return;
              phase = "verify";
              ws.send(
                JSON.stringify({
                  type: "srp_proof",
                  A: step2.A.toString(16),
                  M1: step2.M1.toString(16),
                }),
              );
              return;
            }
            const verified = peerVerify.parse(value);
            await this.budget.crypto(() =>
              step2!.step3(BigInt(`0x${verified.M2}`)),
            );
            if (settled) return;
            const base = deriveSecretboxKey(
              new Uint8Array(bigIntToArrayBuffer(step2!.S)),
            );
            const envelope = proofEnvelope.parse(
              JSON.parse(verified.serverInfoProof),
            );
            const decoded = decrypt(envelope.nonce, envelope.ciphertext, base);
            if (!decoded)
              throw new CoreApiError(
                "peer_identity_mismatch",
                "Peer server metadata proof failed",
                502,
              );
            const info = peerServerInfo.parse(JSON.parse(decoded));
            if (
              info.serverId !== this.serverId ||
              info.credentialId !== invitation.credentialId ||
              info.generation !== invitation.generation ||
              info.protocol !== protocol ||
              (protocol === PEER_REFRESH_PROTOCOL &&
                info.sourceServerId !== invitation.sourceServerId) ||
              (protocol === PEER_PROTOCOL &&
                info.expiresAt !== invitation.expiresAt) ||
              (invitation.authentication &&
                info.authentication !== PEER_AUTHENTICATION) ||
              info.expiresAt <= Date.now() ||
              (this.fleet ? info.fleet !== 1 : info.fleet !== undefined) ||
              info.transportNonce !== verified.transportNonce
            )
              throw new CoreApiError(
                "peer_identity_mismatch",
                "Authenticated peer identity does not match the invitation",
                502,
              );
            key = deriveTransportKey(base, info.transportNonce);
            assertFleetActive();
            releaseHandshake();
            const frame = encryptToBinaryEnvelope(
              JSON.stringify({ seq: 0, msg: request }),
              key,
            );
            if (frame.byteLength > PEER_WIRE_BYTES)
              throw new CoreApiError(
                "invalid_request",
                "Peer request exceeds its 384 KiB wire limit",
                400,
              );
            phase = "reply";
            ws.send(frame);
          })()
            .catch((error: unknown) =>
              finish(
                error instanceof CoreApiError
                  ? error
                  : new CoreApiError(
                      "peer_identity_mismatch",
                      "Peer protocol verification failed",
                      502,
                    ),
              ),
            )
            .finally(() => {
              processing = false;
            });
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    } catch (error) {
      if (error instanceof CoreApiError) throw error;
      throw new CoreApiError(
        "peer_unavailable",
        "Peer request did not establish an outcome; retry only with the same key",
        503,
      );
    } finally {
      if (fleetDeadline) clearTimeout(fleetDeadline);
      releaseHandshake();
      admission.release();
    }
  }
}
