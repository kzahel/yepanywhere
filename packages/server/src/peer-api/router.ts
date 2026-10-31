import { type CoreApi, CoreApiError } from "../core-api/service.js";
import { pageQuery, type Operation } from "../core-api/contracts.js";
import type { ApiPrincipal } from "../core-api/peer-policy.js";
import {
  createSessionRequest,
  sendMessageRequest,
  receiptSchema,
  type ApiOutbound,
} from "../core-api/command-contracts.js";
import type { PeerOutboundStore } from "./outbound-store.js";
import type { PeerInput, PeerTransport } from "./transport.js";

export interface OutgoingPeer {
  serverId: string;
  operations: readonly Operation[];
  transport: PeerTransport;
  allowAgentSessions?: boolean;
  expiresAt?: number;
}
/** One hop only. Native workflow policy and provider ownership stay at each target. */
export class PeerApiRouter {
  private readonly peers = new Map<string, OutgoingPeer>();
  private readonly active = new Map<OutgoingPeer, Set<AbortController>>();
  private activeCount = 0;
  private closed = false;
  private readonly agentControllers = new Set<AbortController>();
  get serverId() {
    return this.local.serverId;
  }
  constructor(
    private readonly local: CoreApi,
    private readonly outbound: PeerOutboundStore,
    peers: readonly OutgoingPeer[] = [],
    private readonly canonicalSessionId: (id: string) => string = (id) => id,
    private readonly agentAccess: () => {
      enabled: boolean;
      grantId?: string;
    } = () => ({ enabled: false }),
  ) {
    for (const peer of peers) this.put(peer);
  }
  put(peer: OutgoingPeer) {
    if (this.closed)
      throw new CoreApiError("peer_unavailable", "Peer owner is closed", 503);
    if (
      peer.serverId === this.local.serverId ||
      peer.transport.serverId !== peer.serverId
    )
      throw new CoreApiError(
        "peer_identity_mismatch",
        "Peer transport identity does not match",
        502,
      );
    if (!this.peers.has(peer.serverId) && this.peers.size >= 64)
      throw new CoreApiError("command_capacity", "Peer capacity reached", 503);
    this.revoke(peer.serverId);
    this.peers.set(peer.serverId, {
      ...peer,
      operations: [...peer.operations],
    });
  }
  revoke(serverId: string) {
    const peer = this.peers.get(serverId);
    if (peer)
      for (const controller of this.active.get(peer) ?? []) controller.abort();
    this.peers.delete(serverId);
  }
  close() {
    this.closed = true;
    for (const id of this.peers.keys()) this.revoke(id);
  }
  revokeAgentAccess() {
    for (const controller of this.agentControllers) controller.abort();
  }
  private canRoute(caller: ApiPrincipal, input: PeerInput) {
    if (this.closed || caller.kind !== "superuser") return false;
    if (!input.launch) return input.ownerAuthenticated === true;
    const policy = this.agentAccess();
    return (
      policy.enabled &&
      Boolean(
        input.launch.management &&
          input.launch.peerAccess &&
          input.launch.id &&
          input.launch.peerGrantId === policy.grantId,
      )
    );
  }
  async read(
    operation: Operation,
    caller: ApiPrincipal,
    input: PeerInput = {},
  ): Promise<unknown> {
    const remote =
      input.serverId !== undefined && input.serverId !== this.local.serverId;
    if (!remote) {
      const result = await this.local.read(operation, caller, input);
      if (operation === "servers" && this.canRoute(caller, input)) {
        const query = pageQuery.parse(input.query ?? {});
        const items = [
          { id: this.local.serverId, local: true },
          ...[...this.peers.values()]
            .filter(
              (p) =>
                p.operations.length &&
                (p.expiresAt === undefined || p.expiresAt > Date.now()) &&
                (!input.launch || p.allowAgentSessions),
            )
            .map((p) => ({ id: p.serverId, local: false })),
        ];
        const offset = Number(query.cursor ?? 0),
          limit = Number(query.limit ?? 50);
        return {
          items: items.slice(offset, offset + limit),
          nextCursor:
            offset + limit < items.length ? String(offset + limit) : null,
        };
      }
      if (operation === "capabilities" && this.canRoute(caller, input))
        return { ...(result as object), peerRouting: true };
      if (operation === "relationships" && this.canRoute(caller, input)) {
        const query = pageQuery.parse(input.query ?? {});
        return {
          ...(result as object),
          outbound: this.outbound.list(
            this.canonicalSessionId(input.sessionId!),
            Number(query.cursor ?? 0),
            Number(query.limit ?? 50),
          ),
        };
      }
      return result;
    }
    // A peer is never an access server for another peer, even if configured locally.
    if (caller.kind === "peer")
      throw new CoreApiError(
        "server_not_found",
        "Server is not configured here",
        404,
      );
    if (this.closed)
      throw new CoreApiError("peer_unavailable", "Peer owner is closed", 503);
    if (!this.canRoute(caller, input))
      throw new CoreApiError(
        "forbidden",
        "Peer routing is not granted to this caller or launch",
        403,
      );
    const peer = this.peers.get(input.serverId!);
    if (!peer)
      throw new CoreApiError(
        "server_not_found",
        "Server is not configured here",
        404,
      );
    if (input.launch && !peer.allowAgentSessions)
      throw new CoreApiError(
        "forbidden",
        "This peer does not grant agent-session access",
        403,
      );
    if (peer.expiresAt !== undefined && peer.expiresAt <= Date.now())
      throw new CoreApiError(
        "unauthorized",
        "Outgoing peer credential expired",
        401,
      );
    if (!peer.operations.includes(operation))
      throw new CoreApiError(
        "forbidden",
        "Outgoing peer operation is not granted",
        403,
      );
    if (this.activeCount >= 128)
      throw new CoreApiError(
        "command_capacity",
        "Peer request capacity reached",
        503,
      );
    input.signal?.throwIfAborted();
    const controller = new AbortController();
    let active = this.active.get(peer);
    if (!active) {
      active = new Set();
      this.active.set(peer, active);
    }
    active.add(controller);
    if (input.launch) this.agentControllers.add(controller);
    this.activeCount++;
    try {
      let attestation = {
        sessionId: input.launch?.id
          ? this.canonicalSessionId(input.launch.id)
          : null,
        launchId: input.launch?.launchId ?? null,
      };
      let record: ApiOutbound | undefined;
      if (operation === "createSession" || operation === "sendMessage") {
        const parsed = (
          operation === "createSession"
            ? createSessionRequest
            : sendMessageRequest
        ).safeParse(input.body);
        if (!parsed.success)
          throw new CoreApiError(
            "invalid_request",
            "Invalid peer command request",
            400,
          );
        input = { ...input, body: parsed.data };
        const resource =
          operation === "createSession"
            ? createSessionRequest.parse(parsed.data).projectId
            : input.sessionId!;
        record = this.outbound.reserve(
          {
            sourceServerId: this.local.serverId,
            sourceSessionId: attestation.sessionId,
            attestedSessionId: attestation.sessionId,
            sourceLaunchId: attestation.launchId,
            destinationServerId: peer.serverId,
            operation,
            resource,
            requestId: parsed.data.requestId,
          },
          parsed.data,
        );
        attestation = {
          sessionId: record.attestedSessionId,
          launchId: record.sourceLaunchId,
        };
      }
      const result = await peer.transport.request(
        operation,
        {
          ...input,
          launch: undefined,
          signal: AbortSignal.any([
            controller.signal,
            ...(input.signal ? [input.signal] : []),
          ]),
        },
        attestation,
      );
      if (this.closed)
        throw new CoreApiError(
          "peer_unavailable",
          "Peer owner closed before its result was recorded",
          503,
        );
      if (
        controller.signal.aborted ||
        input.signal?.aborted ||
        this.peers.get(peer.serverId) !== peer ||
        !this.canRoute(caller, input) ||
        (peer.expiresAt !== undefined && peer.expiresAt <= Date.now())
      )
        throw new CoreApiError(
          "forbidden",
          "Outgoing peer access was revoked",
          403,
        );
      if (record) {
        const receipt = receiptSchema.parse(result);
        if (
          receipt.destinationServerId !== peer.serverId ||
          receipt.creator.serverId !== this.local.serverId ||
          receipt.creator.principal.kind !== "peer" ||
          receipt.creator.sessionId !== attestation.sessionId ||
          receipt.requestId !== record.requestId ||
          receipt.kind !== operation ||
          (operation === "createSession"
            ? receipt.projectId !== record.resource
            : receipt.requestedSessionId !== record.resource)
        )
          throw new CoreApiError(
            "peer_identity_mismatch",
            "Peer command attribution does not match",
            502,
          );
        this.outbound.confirm(record, receipt);
      }
      if (operation === "receipt")
        this.outbound.observe(peer.serverId, receiptSchema.parse(result));
      if (operation === "followReceipt" || operation === "relationships") {
        const response = result as { receipt?: unknown; creation?: unknown };
        const receipt =
          operation === "followReceipt" ? response.receipt : response.creation;
        if (receipt)
          this.outbound.observe(peer.serverId, receiptSchema.parse(receipt));
      }
      return operation === "server"
        ? { ...(result as object), local: false }
        : result;
    } finally {
      active.delete(controller);
      this.agentControllers.delete(controller);
      this.activeCount--;
      if (!active.size) this.active.delete(peer);
    }
  }
}
