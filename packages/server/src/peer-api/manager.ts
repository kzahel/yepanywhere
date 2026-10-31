import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SqliteDatabase } from "../storage/sqlite.js";
import type { ApiReceiptStore } from "../core-api/receipt-store.js";
import type { CoreApi, CoreApiSources } from "../core-api/service.js";
import { CoreApiError } from "../core-api/errors.js";
import { accessSchema } from "../core-api/contracts.js";
import { RelayClientService } from "../services/RelayClientService.js";
import {
  PeerAccessStore,
  incomingPeerRequest,
  rotatePeerRequest,
  outgoingPeerRequest,
  type PeerAccessState,
} from "./state.js";
import { PeerDirectory } from "./directory.js";
import { PeerApiRouter } from "./router.js";
import { PeerOutboundStore } from "./outbound-store.js";
import { createPeerReceiver, PEER_SRP_CONTEXT } from "./http.js";
import { PeerChannelBudget, PEER_WIRE_BYTES } from "./srp-protocol.js";
import { PeerSrpRuntime } from "./srp-server.js";
import { SrpPeerTransport } from "./srp-client.js";

/** Composition around the pure API: no provider registry, scanner or HTTP listener. */
export class PeerAccessManager {
  readonly store: PeerAccessStore;
  private readonly budget = new PeerChannelBudget();
  private readonly directory = new PeerDirectory();
  private readonly relay = new RelayClientService();
  private runtime?: PeerSrpRuntime;
  private receiver?: ReturnType<typeof createPeerReceiver>;
  private router?: PeerApiRouter;
  private outbound?: PeerOutboundStore;
  private projects?: CoreApiSources["projects"];
  private closePromise?: Promise<void>;
  private closed = false;
  private faulted = false;
  private preflights = 0;
  private policyChanges = 0;
  private onPeerAccessRevoked?: (grantId: string) => Promise<void>;
  private readonly pendingRetirements = new Set<Promise<void>>();
  constructor(
    readonly serverId: string,
    dataDir: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.store = new PeerAccessStore(serverId, dataDir);
    this.store.observe(
      (next, previous) => this.apply(next, previous),
      () => this.failClosed(),
    );
  }
  async initialize() {
    await this.store.initialize();
    this.runtime = await PeerSrpRuntime.create({
      serverId: this.serverId,
      decoySecret: this.store.read().decoySecret,
      budget: this.budget,
      lookup: (username) =>
        this.store.read().incoming.find((peer) => peer.username === username),
      handle: async (request, context) => {
        if (!this.receiver || this.closed || this.faulted)
          throw new CoreApiError(
            "peer_state_unavailable",
            "Peer API is unavailable",
            503,
          );
        return this.receiver.fetch(request, { [PEER_SRP_CONTEXT]: context });
      },
    });
    this.apply(this.store.read() as PeerAccessState);
  }
  bind(
    core: CoreApi,
    database: SqliteDatabase,
    receipts: ApiReceiptStore,
    projects: CoreApiSources["projects"],
  ) {
    if (this.router || this.closed || this.faulted)
      throw new CoreApiError(
        "peer_state_unavailable",
        "Peer API cannot be attached",
        503,
      );
    this.projects = projects;
    this.outbound = new PeerOutboundStore(database);
    this.router = new PeerApiRouter(
      core,
      this.outbound,
      [],
      (id) => receipts.resolveId(id),
      () => this.agentAccess(),
    );
    this.receiver = createPeerReceiver(core, this.directory, {
      requireSrp: true,
    });
    this.applyOutgoing(this.store.read() as PeerAccessState);
    return this.router;
  }
  agentAccess() {
    if (this.closed || this.faulted) return { enabled: false };
    const policy = this.store.read().agentAccess;
    return { enabled: policy.enabled, grantId: policy.grantId ?? undefined };
  }
  setRetirementHandler(handler: (grantId: string) => Promise<void>) {
    this.onPeerAccessRevoked = handler;
  }
  remap(oldId: string, newId: string) {
    this.outbound?.remap(oldId, newId);
  }
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    return this.runtime?.handleUpgrade(request, socket, head) ?? false;
  }
  startRoutes() {
    if (!this.receiver || this.closed || this.faulted) return;
    const config = this.store.read().relay;
    if (!config?.enabled) return;
    this.relay.start({
      relayUrl: config.url,
      username: config.username,
      installId: config.registrationId,
      maxInboundMessageBytes: PEER_WIRE_BYTES,
      strictPeerHandoff: true,
      onRelayConnection: (ws, first, binary) =>
        this.runtime?.accept(ws, first, binary) ?? false,
    });
  }
  private apply(next: PeerAccessState, previous?: PeerAccessState) {
    if (this.closed || this.faulted) return;
    for (const old of previous?.incoming ?? []) {
      const current = next.incoming.find((p) => p.id === old.id);
      if (!current || current.generation !== old.generation) {
        this.directory.revoke(old.id);
        this.runtime?.revoke(old.id);
      }
    }
    for (const peer of next.incoming) {
      if (
        previous?.incoming.some(
          (p) => p.id === peer.id && p.generation === peer.generation,
        )
      )
        continue;
      this.directory.put({
        id: peer.id,
        serverId: peer.sourceServerId,
        generation: peer.generation,
        tokenHash: peer.tokenHash,
        projects: peer.projects,
        operations: peer.operations,
        expiresAt: peer.expiresAt,
      });
    }
    if (previous && previous.agentAccess.grantId !== next.agentAccess.grantId) {
      this.router?.revokeAgentAccess();
      if (previous.agentAccess.grantId && this.onPeerAccessRevoked) {
        // The durable generation already denies old requests. Physical retirement
        // also removes old private tokens, without holding the policy writer.
        const pending = this.onPeerAccessRevoked(previous.agentAccess.grantId)
          .catch(this.onError)
          .finally(() => this.pendingRetirements.delete(pending));
        this.pendingRetirements.add(pending);
      }
    }
    this.applyOutgoing(next, previous);
    if (
      JSON.stringify(next.relay) !== JSON.stringify(previous?.relay ?? null)
    ) {
      this.relay.stop();
      this.runtime?.closeRoute("relay");
      this.startRoutes();
    }
  }
  private applyOutgoing(next: PeerAccessState, previous?: PeerAccessState) {
    if (!this.router) return;
    for (const old of previous?.outgoing ?? [])
      if (
        !next.outgoing.some(
          (p) => p.invitation.targetServerId === old.invitation.targetServerId,
        )
      )
        this.router.revoke(old.invitation.targetServerId);
    for (const peer of next.outgoing) {
      if (
        previous?.outgoing.some(
          (old) => JSON.stringify(old) === JSON.stringify(peer),
        )
      )
        continue;
      this.router.put({
        serverId: peer.invitation.targetServerId,
        operations: peer.operations,
        allowAgentSessions: peer.allowAgentSessions,
        expiresAt: peer.invitation.expiresAt,
        transport: new SrpPeerTransport(
          peer.invitation,
          peer.route,
          this.budget,
        ),
      });
    }
  }
  private failClosed() {
    this.faulted = true;
    this.router?.close();
    this.directory.close();
    this.runtime?.close();
    this.relay.stop();
    this.budget.close();
  }
  publicState() {
    const state = this.store.read();
    return {
      serverId: this.serverId,
      agentAccess: state.agentAccess,
      incoming: state.incoming.map(
        ({
          id,
          sourceServerId,
          generation,
          projects,
          operations,
          expiresAt,
        }) => ({
          id,
          sourceServerId,
          generation,
          projects,
          operations,
          expiresAt,
        }),
      ),
      outgoing: state.outgoing.map(
        ({ invitation, operations, allowAgentSessions, route }) => ({
          targetServerId: invitation.targetServerId,
          credentialId: invitation.credentialId,
          generation: invitation.generation,
          expiresAt: invitation.expiresAt,
          operations,
          allowAgentSessions,
          route,
        }),
      ),
      relay: state.relay
        ? {
            url: state.relay.url,
            username: state.relay.username,
            enabled: state.relay.enabled,
            ...this.relay.getState(),
          }
        : null,
    };
  }
  async issue(value: unknown, rotateId?: string, signal?: AbortSignal) {
    const input = rotateId
      ? rotatePeerRequest.parse(value)
      : incomingPeerRequest.parse(value);
    const revision = this.store.currentRevision();
    if (!this.projects)
      throw new CoreApiError(
        "catalog_not_ready",
        "Peer project catalog is unavailable",
        503,
      );
    const projects = await this.projects(signal);
    if (
      input.projects.some(
        (id) => !projects.items.some((project) => project.id === id),
      )
    )
      throw new CoreApiError(
        projects.catalog?.complete === false
          ? "catalog_not_ready"
          : "project_not_found",
        "Peer project is not available in this profile's catalog",
        projects.catalog?.complete === false ? 503 : 404,
      );
    signal?.throwIfAborted();
    return this.store.issue(input, rotateId, revision);
  }
  async importOutgoing(value: unknown, signal?: AbortSignal) {
    const input = outgoingPeerRequest.parse(value),
      invitation = input.invitation;
    if (
      invitation.sourceServerId !== this.serverId ||
      invitation.targetServerId === this.serverId
    )
      throw new CoreApiError(
        "invalid_request",
        "Invitation belongs to another source/target profile",
        400,
      );
    if (this.preflights >= 4)
      throw new CoreApiError(
        "command_capacity",
        "Peer preflight capacity reached",
        503,
      );
    const revision = this.store.currentRevision();
    this.preflights++;
    try {
      const transport = new SrpPeerTransport(
        invitation,
        input.route,
        this.budget,
      );
      const result = await transport.request(
        "access",
        { serverId: invitation.targetServerId, signal },
        { sessionId: null, launchId: null },
      );
      const access = accessSchema.parse(result);
      if (
        access.principal.kind !== "peer" ||
        access.principal.serverId !== this.serverId
      )
        throw new CoreApiError(
          "peer_identity_mismatch",
          "Peer access does not identify this source profile",
          502,
        );
      signal?.throwIfAborted();
      await this.store.importOutgoing(input, revision);
    } finally {
      this.preflights--;
    }
  }
  async setAgentAccess(value: unknown) {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(value);
    if (this.policyChanges >= 4)
      throw new CoreApiError(
        "command_capacity",
        "Peer policy change capacity reached",
        503,
      );
    this.policyChanges++;
    try {
      await this.store.setAgentAccess(enabled);
      await Promise.allSettled(this.pendingRetirements);
    } finally {
      this.policyChanges--;
    }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.router?.close();
    this.runtime?.close();
    this.directory.close();
    this.relay.stop();
    this.budget.close();
    this.closePromise = (async () => {
      await this.store.close();
      await Promise.allSettled(this.pendingRetirements);
      this.outbound?.close();
    })();
    return this.closePromise;
  }
}
