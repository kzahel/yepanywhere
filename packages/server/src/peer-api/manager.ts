import {
  localPeerHost,
  recordPeerAudit,
  type PeerHost,
} from "./connection-contracts.js";
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
  type StoredOutgoingPeer,
} from "./state.js";
import { PeerDirectory } from "./directory.js";
import { PeerApiRouter } from "./router.js";
import { PeerOutboundStore } from "./outbound-store.js";
import { createPeerReceiver, PEER_SRP_CONTEXT } from "./http.js";
import { PeerChannelBudget, PEER_WIRE_BYTES } from "./srp-protocol.js";
import { PeerSrpRuntime } from "./srp-server.js";
import { SrpPeerTransport } from "./srp-client.js";
import { FleetPeerAccess } from "../fleet/peers.js";

/** Composition around the pure API: no provider registry, scanner or HTTP listener. */
export class PeerAccessManager {
  readonly store: PeerAccessStore;
  readonly fleetAccess: FleetPeerAccess;
  private readonly budget = new PeerChannelBudget();
  private readonly directory = new PeerDirectory();
  private readonly relay = new RelayClientService();
  private runtime?: PeerSrpRuntime;
  private receiver?: ReturnType<typeof createPeerReceiver>;
  private router?: PeerApiRouter;
  private outbound?: PeerOutboundStore;
  private receipts?: ApiReceiptStore;
  private projects?: CoreApiSources["projects"];
  private closePromise?: Promise<void>;
  private closed = false;
  private faulted = false;
  private preflights = 0;
  private policyChanges = 0;
  private fleet?: {
    authority: NonNullable<
      Parameters<typeof createPeerReceiver>[2]
    >["fleetAuthority"];
    transport(
      peer: Extract<StoredOutgoingPeer, { origin: "fleet" }>,
    ): NonNullable<ConstructorParameters<typeof SrpPeerTransport>[3]>;
  };
  setFleet(fleet: NonNullable<PeerAccessManager["fleet"]>) {
    this.fleet = fleet;
  }
  protectedTransport(peer: StoredOutgoingPeer) {
    return new SrpPeerTransport(
      peer.invitation,
      peer.route,
      this.budget,
      peer.origin === "fleet" ? this.fleet?.transport(peer) : undefined,
    );
  }

  private onPeerAccessRevoked?: (grantId: string) => Promise<void>;
  private readonly pendingRetirements = new Set<Promise<void>>();
  constructor(
    readonly serverId: string,
    dataDir: string,
    private readonly onError: (error: unknown) => void = () => {},
    fleetOptions: {
      allowInsecureLoopback?: boolean;
      fetch?: typeof fetch;
      runtimeControl?: { envOverride?: boolean };
      identity?: () => PeerHost;
    } = {},
  ) {
    this.connectionOptions = fleetOptions;
    this.store = new PeerAccessStore(serverId, dataDir);
    this.fleetAccess = new FleetPeerAccess(this, fleetOptions);
    this.store.observe(
      (next, previous) => this.apply(next, previous),
      () => this.failClosed(),
    );
  }
  private readonly connectionOptions: {
    runtimeControl?: { envOverride?: boolean };
    identity?: () => PeerHost;
  };
  private runtimeReady?: Promise<void>;
  identity() {
    return this.connectionOptions.identity?.() ?? localPeerHost(this.serverId);
  }
  private enabledIn(state: Readonly<PeerAccessState>) {
    return this.connectionOptions.runtimeControl
      ? (this.connectionOptions.runtimeControl.envOverride ??
          state.enabled ??
          false)
      : true;
  }
  isEnabled() {
    return this.enabledIn(this.store.read());
  }
  environmentOverride() {
    return this.connectionOptions.runtimeControl?.envOverride ?? null;
  }
  async setEnabled(enabled: boolean, admit?: () => void) {
    const override = this.environmentOverride();
    if (override !== null && override !== enabled)
      throw new CoreApiError(
        "forbidden",
        "Server connections are controlled by YEP_PEER_API_ENABLED",
        403,
      );
    admit?.();
    if (enabled) await this.ensureRuntime();
    await this.store.mutate((next) => {
      admit?.();
      next.enabled = enabled;
      if (!enabled) next.agentAccess = { enabled: false, grantId: null };
      recordPeerAudit(next, enabled ? "enabled" : "disabled", null);
    });
    await Promise.allSettled(this.pendingRetirements);
  }
  private ensureRuntime() {
    this.runtimeReady ??= PeerSrpRuntime.create({
      serverId: this.serverId,
      decoySecret: this.store.read().decoySecret,
      budget: this.budget,
      lookup: (username) =>
        this.isEnabled()
          ? this.store
              .read()
              .incoming.find((peer) => peer.username === username)
          : undefined,
      handle: async (request, context) => {
        if (!this.isEnabled() || !this.receiver || this.closed || this.faulted)
          throw new CoreApiError(
            "peer_state_unavailable",
            "Peer API is unavailable",
            503,
          );
        return this.receiver.fetch(request, { [PEER_SRP_CONTEXT]: context });
      },
    }).then((runtime) => {
      if (this.closed || this.faulted) {
        runtime.close();
        return;
      }
      this.runtime = runtime;
    });
    return this.runtimeReady;
  }
  async initialize() {
    await this.store.initialize();
    await this.fleetAccess.initialize();
    const retiredGrantId = !this.isEnabled()
      ? this.store.read().agentAccess.grantId
      : null;
    if (!this.isEnabled() && this.store.read().agentAccess.enabled)
      await this.store.setAgentAccess(false);
    if (this.isEnabled()) await this.ensureRuntime();
    this.apply(this.store.read() as PeerAccessState);
    return { retiredGrantId };
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
    this.receipts = receipts;
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
      fleetAuthority: (grant, token, signal) => {
        if (!this.fleet?.authority)
          throw new CoreApiError(
            "unauthorized",
            "Fleet authority is not configured",
            401,
          );
        return this.fleet.authority(grant, token, signal);
      },
    });
    this.applyOutgoing(this.store.read() as PeerAccessState);
    return this.router;
  }
  connectionActivity(serverId: string) {
    return {
      incoming: this.receipts?.forPeer(serverId) ?? [],
      outgoing: this.outbound?.forPeer(serverId) ?? [],
    };
  }
  async waitForRelay(signal: AbortSignal) {
    const deadline = Date.now() + 5000;
    while (this.relay.getState().status !== "waiting") {
      signal.throwIfAborted();
      if (
        !this.isEnabled() ||
        Date.now() >= deadline ||
        this.relay.getState().status === "rejected"
      )
        throw new CoreApiError(
          "peer_unavailable",
          "The dedicated peer relay registration is not ready; inspect this server before retrying",
          503,
        );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 25);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  agentAccess() {
    if (this.closed || this.faulted || !this.isEnabled())
      return { enabled: false };
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
    return (
      this.isEnabled() &&
      (this.runtime?.handleUpgrade(request, socket, head) ?? false)
    );
  }
  startRoutes() {
    if (!this.isEnabled() || !this.receiver || this.closed || this.faulted)
      return;
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
    if (!this.isEnabled()) {
      for (const peer of [...(previous?.incoming ?? []), ...next.incoming]) {
        this.directory.revoke(peer.id);
        this.runtime?.revoke(peer.id);
      }
      for (const peer of [...(previous?.outgoing ?? []), ...next.outgoing])
        this.router?.revoke(peer.invitation.targetServerId);
      this.relay.stop();
      return;
    }
    if (previous && !this.enabledIn(previous) && this.enabledIn(next))
      previous = undefined;
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
        ...(peer.allProjects ? { allProjects: true as const } : {}),
        projects: peer.projects,
        operations: peer.operations,
        expiresAt: peer.expiresAt,
        ...(peer.origin === "fleet" ? { fleet: peer.binding } : {}),
      });
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
    if (!this.router || !this.isEnabled()) return;
    const selected = (state: PeerAccessState) =>
      state.outgoing.filter(
        (p) =>
          state.selected[p.invitation.targetServerId] ===
          p.invitation.credentialId,
      );
    const before = previous ? selected(previous) : [],
      after = selected(next);
    for (const old of before)
      if (
        !after.some(
          (p) => p.invitation.targetServerId === old.invitation.targetServerId,
        )
      )
        this.router.revoke(old.invitation.targetServerId);
    for (const peer of after) {
      if (before.some((old) => JSON.stringify(old) === JSON.stringify(peer)))
        continue;
      if (peer.origin === "fleet" && !this.fleet) {
        this.router.revoke(peer.invitation.targetServerId);
        continue;
      }
      this.router.put({
        serverId: peer.invitation.targetServerId,
        operations: peer.operations,
        allowAgentSessions: peer.allowAgentSessions,
        expiresAt: peer.invitation.expiresAt,
        transport: this.protectedTransport(peer),
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
      identity: this.identity(),
      enabled: this.isEnabled(),
      environmentOverride: this.environmentOverride(),
      connections: state.connections ?? [],
      audit: state.audit ?? [],
      agentAccess: state.agentAccess,
      incoming: state.incoming.map(
        ({
          id,
          sourceServerId,
          generation,
          projects,
          allProjects,
          operations,
          expiresAt,
          origin,
        }) => ({
          id,
          sourceServerId,
          generation,
          projects,
          allProjects,
          operations,
          expiresAt,
          origin,
        }),
      ),
      outgoing: state.outgoing.map(
        ({
          invitation,
          operations,
          allProjects,
          allowAgentSessions,
          route,
          origin,
        }) => ({
          allProjects: allProjects === true,
          origin,
          selected:
            state.selected[invitation.targetServerId] ===
            invitation.credentialId,
          targetServerId: invitation.targetServerId,
          credentialId: invitation.credentialId,
          generation: invitation.generation,
          expiresAt: invitation.expiresAt,
          operations,
          allowAgentSessions,
          route,
        }),
      ),
      fleet: state.fleet.enrollment
        ? {
            issuer: state.fleet.enrollment.issuer,
            accountId: state.fleet.enrollment.accountId,
            clientId: state.fleet.enrollment.credentials?.client.id ?? null,
            epoch: state.fleet.epoch,
            pendingDeliveries: state.fleet.outbox.length,
          }
        : null,
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
  async validateProjects(projectIds: readonly string[], signal?: AbortSignal) {
    if (!this.projects)
      throw new CoreApiError(
        "catalog_not_ready",
        "Peer project catalog is unavailable",
        503,
      );
    const projects = await this.projects(signal);
    if (
      projectIds.some(
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
  }
  async issue(
    value: unknown,
    rotateId?: string,
    signal?: AbortSignal,
    admit?: () => void,
    identity?: PeerHost,
    operationId?: string,
    initiatingServerId?: string,
  ) {
    const enabledAdmission = () => {
      admit?.();
      if (!this.isEnabled())
        throw new CoreApiError(
          "forbidden",
          "Server connections are disabled",
          403,
        );
    };
    enabledAdmission();
    const input = rotateId
      ? rotatePeerRequest.parse(value)
      : incomingPeerRequest.parse(value);
    const revision = this.store.currentRevision();
    if (input.allProjects) {
      signal?.throwIfAborted();
      return this.store.issue(
        input,
        rotateId,
        revision,
        enabledAdmission,
        identity,
        operationId,
        initiatingServerId,
      );
    }
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
    return this.store.issue(
      input,
      rotateId,
      revision,
      enabledAdmission,
      identity,
      operationId,
      initiatingServerId,
    );
  }
  async importOutgoing(
    value: unknown,
    signal?: AbortSignal,
    admit?: () => void,
    identity?: PeerHost,
    label?: string,
    operationId?: string,
  ) {
    const enabledAdmission = () => {
      admit?.();
      if (!this.isEnabled())
        throw new CoreApiError(
          "forbidden",
          "Server connections are disabled",
          403,
        );
    };
    enabledAdmission();
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
      await this.store.importOutgoing(
        {
          ...input,
          operations: input.operations.filter((op) =>
            access.operations.includes(op),
          ),
        },
        revision,
        enabledAdmission,
        identity,
        label,
        operationId,
        access.scope === "all-projects",
      );
    } finally {
      this.preflights--;
    }
  }
  async setAgentAccess(value: unknown, admit?: () => void) {
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
      if (enabled && !this.isEnabled())
        throw new CoreApiError(
          "forbidden",
          "Server connections are disabled",
          403,
        );
      await this.store.setAgentAccess(enabled, admit);
      await Promise.allSettled(this.pendingRetirements);
    } finally {
      this.policyChanges--;
    }
  }
  async close() {
    await this.fleetAccess.close();
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
