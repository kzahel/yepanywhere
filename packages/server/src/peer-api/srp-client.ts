import { PEER_ENVELOPE_VERSION } from "../core-api/http-contracts.js";
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
import { isRelayClientError } from "@yep-anywhere/shared";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import {
  deriveSecretboxKey,
  deriveTransportKey,
  decrypt,
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
  PEER_HANDSHAKE_BYTES,
  PEER_CHANNEL_MS,
  PEER_PROTOCOL,
  PEER_REFRESH_PROTOCOL,
  peerChallenge,
  peerVerify,
  peerServerInfo,
  peerWireRequest,
  wireBytes,
  awaitPeerWork,
  type PeerChannelBudget,
} from "./srp-protocol.js";

import {
  PeerClientChannel,
  PeerChannelNotSubmitted,
  type PeerConnection,
} from "./srp-client-channel.js";

const routines = new SRPRoutines(new SRPParameters());
const proofEnvelope = z
  .object({ nonce: z.string().max(128), ciphertext: z.string().max(4096) })
  .strict();

/** Demand-driven authenticated channels; never replay a submitted request. */
export class SrpPeerTransport implements PeerTransport {
  readonly serverId: string;
  private fingerprint?: string;
  private legacyFingerprint?: string;
  private reuseFingerprint?: string;
  private readonly channels = new Set<PeerClientChannel>();
  private readonly liveChannels = new Set<PeerClientChannel>();
  private closed = false;
  close() {
    this.closed = true;
    for (const channel of this.liveChannels) channel.close();
    this.liveChannels.clear();
    this.channels.clear();
  }
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
    private readonly identityService?: {
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
    if (this.closed)
      throw new CoreApiError(
        "peer_unavailable",
        "Peer transport is closed",
        503,
      );
    const admission = this.budget.acquireRequest();
    const identityServiceExpiry = new AbortController();
    let identityServiceDeadline: ReturnType<typeof setTimeout> | undefined;
    const signal = AbortSignal.any([
      identityServiceExpiry.signal,
      admission.controller.signal,
      AbortSignal.timeout(PEER_CHANNEL_MS),
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      signal.throwIfAborted();
      this.identityService?.assertActive();
      const identityServiceToken = this.identityService
        ? await awaitPeerWork(this.identityService.token(signal), signal)
        : undefined;
      const assertIdentityServiceActive = () => {
        this.identityService?.assertActive();
        if (
          identityServiceToken &&
          identityServiceToken.expiresAt <= Date.now()
        )
          throw new CoreApiError(
            "unauthorized",
            "Identity Service authority expired before submission or observation",
            401,
          );
      };
      if (identityServiceToken) {
        if (
          identityServiceToken.expiresAt <= Date.now() ||
          identityServiceToken.token.length > 32 * 1024
        )
          throw new CoreApiError(
            "unauthorized",
            "Identity Service authority has expired",
            401,
          );
        identityServiceDeadline = setTimeout(
          () => identityServiceExpiry.abort(),
          identityServiceToken.expiresAt - Date.now(),
        );
        identityServiceDeadline.unref?.();
      }
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
      if (identityServiceToken)
        Object.assign(request.headers, {
          "X-YA-Fleet-Grant": identityServiceToken.token,
        });
      if (!peerWireRequest.safeParse(request).success)
        throw new CoreApiError(
          "invalid_request",
          "Peer request is outside its supported wire limits",
          400,
        );
      const fingerprint = JSON.stringify([
        invitation.credentialId,
        invitation.generation,
        invitation.secret,
        protocol,
      ]);
      signal.throwIfAborted();
      if (this.closed)
        throw new CoreApiError(
          "peer_unavailable",
          "Peer transport is closed",
          503,
        );
      if (!privateRequest && this.fingerprint !== fingerprint) {
        for (const old of this.channels) old.close();
        this.channels.clear();
        this.fingerprint = fingerprint;
      }
      for (const old of this.liveChannels)
        if (old.closed) this.liveChannels.delete(old);
      for (const old of this.channels)
        if (old.closed) this.channels.delete(old);
      let channel = privateRequest
        ? undefined
        : [...this.channels].find((candidate) => candidate.available);
      if (!channel) {
        if (!privateRequest && this.channels.size >= 4)
          throw new CoreApiError(
            "command_capacity",
            "Peer channel pool capacity reached",
            503,
          );
        channel = new PeerClientChannel(
          this.budget,
          (setupSignal) => this.connect(invitation, protocol, setupSignal),
          !privateRequest && this.legacyFingerprint !== fingerprint,
          this.serverId,
          this.reuseFingerprint === fingerprint,
        );
        this.liveChannels.add(channel);
        if (!privateRequest) this.channels.add(channel);
      }
      const wire = peerWireRequest.parse(request);
      const reply = await channel
        .request(wire, signal, assertIdentityServiceActive)
        .catch((error: unknown) => {
          if (!(error instanceof PeerChannelNotSubmitted)) {
            // A target may have rolled back. Re-probe on the next call, without
            // retrying this possibly submitted operation or weakening auth.
            if (!channel.hasReply && this.reuseFingerprint === fingerprint)
              this.reuseFingerprint = undefined;
            throw error;
          }
          signal.throwIfAborted();
          if (this.closed)
            throw new CoreApiError(
              "peer_unavailable",
              "Peer transport is closed",
              503,
            );
          if (channel.reuseSupported === false)
            this.legacyFingerprint = fingerprint;
          // Only demonstrably unsent work can use a different connection.
          const single = new PeerClientChannel(
            this.budget,
            (setupSignal) => this.connect(invitation, protocol, setupSignal),
            false,
            this.serverId,
          );
          this.liveChannels.add(single);
          return single
            .request(wire, signal, assertIdentityServiceActive)
            .finally(() => {
              single.close();
              this.liveChannels.delete(single);
            });
        });
      if (!privateRequest) {
        if (channel.reuseSupported === false)
          this.legacyFingerprint = fingerprint;
        if (channel.reuseSupported === true)
          this.reuseFingerprint = fingerprint;
      }
      assertIdentityServiceActive();
      return privateRequest?.path === PEER_REFRESH_PATH && reply.status === 200
        ? peerRefreshReceipt.parse(
            typeof reply.body === "string"
              ? JSON.parse(reply.body)
              : reply.body,
          )
        : validatePeerReply(
            operation,
            this.serverId,
            reply.status,
            new Headers(reply.headers),
            reply.body,
            Boolean(input.http),
          );
    } catch (error) {
      if (error instanceof CoreApiError) throw error;
      throw new CoreApiError(
        "peer_unavailable",
        "Peer request did not establish an outcome; retry only with the same key",
        503,
      );
    } finally {
      if (identityServiceDeadline) clearTimeout(identityServiceDeadline);
      admission.release();
    }
  }

  private async connect(
    invitation: PeerInvitation,
    protocol: typeof PEER_PROTOCOL | typeof PEER_REFRESH_PROTOCOL,
    signal: AbortSignal,
  ): Promise<PeerConnection> {
    let releaseHandshake = () => {};
    try {
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
      return await new Promise<PeerConnection>((resolve, reject) => {
        const ws = new WebSocket(this.route.url, {
          maxPayload: PEER_WIRE_BYTES,
          perMessageDeflate: false,
        });
        let phase: "relay" | "challenge" | "verify" =
          this.route.kind === "relay" ? "relay" : "challenge";
        let step2: SRPClientSessionStep2 | undefined,
          key: Uint8Array | undefined;
        let settled = false,
          processing = false;
        const finish = (error?: CoreApiError, result?: PeerConnection) => {
          if (settled) return;
          settled = true;
          releaseHandshake();
          signal.removeEventListener("abort", abort);
          ws.removeAllListeners();
          ws.on("error", () => {});
          if (error) {
            ws.terminate();
            reject(error);
          } else resolve(result!);
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
            const infoValue = JSON.parse(decoded);
            if (infoValue.envelopeVersion !== PEER_ENVELOPE_VERSION)
              throw new CoreApiError(
                "peer_incompatible",
                `Peer envelope ${infoValue.envelopeVersion ?? "unknown"}; this build requires ${PEER_ENVELOPE_VERSION}`,
                501,
              );
            const info = peerServerInfo.parse(infoValue);
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
              (this.identityService
                ? info.fleet !== 1
                : info.fleet !== undefined) ||
              info.transportNonce !== verified.transportNonce
            )
              throw new CoreApiError(
                "peer_identity_mismatch",
                "Authenticated peer identity does not match the invitation",
                502,
              );
            key = deriveTransportKey(base, info.transportNonce);
            finish(undefined, {
              ws,
              key,
              expiresAt: info.expiresAt,
            });
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
    } finally {
      releaseHandshake();
    }
  }
}
