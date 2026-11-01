import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PeerConnectionsResponse,
  PeerConnectionSetupResponse,
} from "@yep-anywhere/shared";
import { CoreApiError } from "../core-api/errors.js";
import { operations } from "../core-api/contracts.js";
import type { PeerAccessManager } from "./manager.js";
import {
  peerHostSchema,
  recordPeerAudit,
  rememberPeer,
} from "./connection-contracts.js";
import {
  PeerOwnerClient,
  ownerRouteSchema,
  normalizeOwnerRoute,
} from "./owner-client.js";
import { invitationSchema, peerRouteSchema } from "./state.js";

const controlOperations = operations
  .filter((op) => op.path.includes(":serverId"))
  .map((op) => op.id);
const setupSchema = z
  .object({
    route: ownerRouteSchema,
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(4096),
    label: z.string().trim().min(1).max(128).optional(),
    bidirectional: z.boolean().default(false),
    returnRoute: peerRouteSchema.optional(),
    expectedServerId: z.uuid().optional(),
    replace: z.boolean().default(false),
    direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  })
  .strict();
export const controlRequestSchema = z
  .object({
    identity: peerHostSchema,
    expectedPolicyRevision: z.number().int().nonnegative(),
    initiatingServerId: z.uuid().optional(),
    operationId: z.uuid(),
    expectedCredential: z
      .object({ id: z.uuid(), generation: z.number().int().positive() })
      .strict()
      .nullable(),
    relayUrl: z.string().url().max(2048).optional(),
  })
  .strict();
const bootstrapSchema = z.object({
  version: z.literal(1),
  policyRevision: z.number().int().nonnegative(),
  selectedOrigin: z.enum(["manual", "fleet"]).nullable(),
  identity: peerHostSchema,
  enabled: z.boolean(),
  environmentOverride: z.boolean().nullable(),
  relay: z
    .object({ url: z.string(), username: z.string(), enabled: z.boolean() })
    .nullable(),
  incoming: z
    .object({ id: z.uuid(), generation: z.number().int().positive() })
    .nullable(),
});
const grantSchema = z.object({
  policyRevision: z.number().int().nonnegative(),
  invitation: invitationSchema,
  identity: peerHostSchema,
  relay: bootstrapSchema.shape.relay,
});
function routeForPeer(
  ownerRoute: z.infer<typeof ownerRouteSchema>,
  relay: z.infer<typeof bootstrapSchema.shape.relay>,
) {
  if (ownerRoute.kind === "relay") {
    if (!relay?.enabled)
      throw new CoreApiError(
        "peer_unavailable",
        "The target peer relay is unavailable",
        503,
      );
    return peerRouteSchema.parse({
      kind: "relay",
      url: relay.url,
      username: relay.username,
    });
  }
  const url = new URL(normalizeOwnerRoute(ownerRoute).url);
  url.pathname = "/peer/ws";
  return peerRouteSchema.parse({ kind: "direct", url: url.href });
}
/** Never adopt a newer policy after waiting on network, crypto, or disk. */
class PolicyFence {
  revision: number;
  constructor(
    private manager: PeerAccessManager,
    private owner: () => void,
  ) {
    this.revision = manager.store.currentRevision();
  }
  check = () => {
    this.owner();
    if (this.manager.store.currentRevision() !== this.revision)
      throw new CoreApiError(
        "peer_record_conflict",
        "Connection policy changed during setup; inspect both servers before retrying",
        409,
      );
  };
  async write<T>(action: (guard: () => void) => Promise<T>): Promise<T> {
    this.check();
    const result = await action(this.check);
    this.revision++;
    this.check();
    return result;
  }
}
/** Owner setup orchestration. Only dedicated peer credentials survive this call. */
export class PeerConnections {
  private active = 0;
  constructor(readonly manager: PeerAccessManager) {}
  overview(offset = 0, limit = 20): PeerConnectionsResponse {
    const s = this.manager.store.read(),
      now = Date.now();
    const ids = [
      ...new Set([
        ...(s.connections ?? []).map((p) => p.serverId),
        ...s.incoming.map((p) => p.sourceServerId),
        ...s.outgoing.map((p) => p.invitation.targetServerId),
      ]),
    ].sort();
    return {
      identity: this.manager.identity(),
      enabled: this.manager.isEnabled(),
      environmentOverride: this.manager.environmentOverride(),
      agentAccess: this.manager.agentAccess(),
      peers: ids.slice(offset, offset + limit).map((id) => ({
        serverId: id,
        ...s.connections?.find((p) => p.serverId === id),
        incoming: s.incoming
          .filter((p) => p.sourceServerId === id)
          .map((p) => ({
            credentialId: p.id,
            generation: p.generation,
            expiresAt: p.expiresAt,
            active: this.manager.isEnabled() && p.expiresAt > now,
            origin: p.origin,
            allProjects: p.allProjects === true,
          })),
        outgoing: s.outgoing
          .filter((p) => p.invitation.targetServerId === id)
          .map((p) => ({
            credentialId: p.invitation.credentialId,
            generation: p.invitation.generation,
            expiresAt: p.invitation.expiresAt,
            active:
              this.manager.isEnabled() &&
              p.invitation.expiresAt > now &&
              s.selected[id] === p.invitation.credentialId,
            selected: s.selected[id] === p.invitation.credentialId,
            origin: p.origin,
            allProjects: p.allProjects === true,
            route: p.route,
          })),
      })),
      audit: (s.audit ?? []).slice(-20).reverse(),
      nextCursor: offset + limit < ids.length ? String(offset + limit) : null,
      total: ids.length,
      relay: s.relay
        ? {
            url: s.relay.url,
            username: s.relay.username,
            enabled: s.relay.enabled,
          }
        : null,
    };
  }
  bootstrap(source: string) {
    const state = this.manager.store.read(),
      incoming = state.incoming.find(
        (p) => p.sourceServerId === source && p.origin === "manual",
      );
    return {
      version: 1,
      policyRevision: this.manager.store.currentRevision(),
      selectedOrigin:
        state.outgoing.find(
          (p) =>
            p.invitation.targetServerId === source &&
            state.selected[source] === p.invitation.credentialId,
        )?.origin ?? null,
      identity: this.manager.identity(),
      enabled: this.manager.isEnabled(),
      environmentOverride: this.manager.environmentOverride(),
      relay: state.relay
        ? {
            url: state.relay.url,
            username: state.relay.username,
            enabled: state.relay.enabled,
          }
        : null,
      incoming: incoming
        ? { id: incoming.id, generation: incoming.generation }
        : null,
    };
  }
  async grant(value: unknown, guard: () => void, signal: AbortSignal) {
    const input = controlRequestSchema.parse(value);
    guard();
    if (input.identity.serverId === this.manager.serverId)
      throw new CoreApiError(
        "invalid_request",
        "Cannot connect a server to itself",
        400,
      );
    const fence = new PolicyFence(this.manager, () => {
      signal.throwIfAborted();
      guard();
    });
    const revision = fence.revision;
    if (revision !== input.expectedPolicyRevision)
      throw new CoreApiError(
        "peer_record_conflict",
        "The target policy changed since inspection; inspect both servers before retrying",
        409,
      );
    const current = this.manager.store
      .read()
      .incoming.find(
        (p) =>
          p.sourceServerId === input.identity.serverId && p.origin === "manual",
      );
    if (
      (current ? `${current.id}/${current.generation}` : null) !==
      (input.expectedCredential
        ? `${input.expectedCredential.id}/${input.expectedCredential.generation}`
        : null)
    )
      throw new CoreApiError(
        "peer_record_conflict",
        "The incoming direction changed; inspect it before replacing",
        409,
      );
    // Durable intent precedes changes to runtime, relay, or credentials.
    await fence.write((check) =>
      this.manager.store.mutate((next) => {
        check();
        rememberPeer(next, input.identity);
        recordPeerAudit(
          next,
          "pair-started",
          input.identity.serverId,
          input.initiatingServerId ?? input.identity.serverId,
          { operationId: input.operationId },
        );
      }, revision),
    );
    if (!this.manager.isEnabled())
      await fence.write((check) => this.manager.setEnabled(true, check));
    if (input.relayUrl && !this.manager.store.read().relay) {
      const route = peerRouteSchema.parse({
        kind: "relay",
        url: input.relayUrl,
        username: `peer-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      });
      await fence.write((check) =>
        this.manager.store.mutate((next) => {
          check();
          if (next.relay)
            throw new CoreApiError(
              "peer_record_conflict",
              "Peer relay changed during setup",
              409,
            );
          next.relay = {
            url: route.url,
            username: route.kind === "relay" ? route.username : "",
            registrationId: randomUUID(),
            enabled: true,
          };
        }),
      );
    }
    if (input.relayUrl) {
      if (!this.manager.store.read().relay?.enabled)
        throw new CoreApiError(
          "peer_unavailable",
          "The existing peer relay is disabled; enable or explicitly reconfigure it before pairing",
          503,
        );
      await this.manager.waitForRelay(signal);
      fence.check();
    }
    const invitation = await fence.write((check) =>
      this.manager.issue(
        {
          ...(!current ? { sourceServerId: input.identity.serverId } : {}),
          ...((current ? current.allProjects : true)
            ? { allProjects: true }
            : {}),
          projects: current?.projects ?? [],
          operations: current?.operations ?? controlOperations,
          expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
          acknowledgeExecutionAuthority: "server-account",
        },
        current?.id,
        signal,
        check,
        input.identity,
        input.operationId,
        input.initiatingServerId ?? input.identity.serverId,
      ),
    );
    fence.check();
    return {
      policyRevision: fence.revision,
      invitation,
      identity: this.manager.identity(),
      relay: this.bootstrap(input.identity.serverId).relay,
    };
  }
  async connect(
    value: unknown,
    guard: () => void,
    caller: AbortSignal,
  ): Promise<PeerConnectionSetupResponse> {
    const input = setupSchema.parse(value);
    if (this.manager.environmentOverride() === false)
      throw new CoreApiError(
        "forbidden",
        "Server connections are disabled by this server’s environment",
        403,
      );
    const reverseOnly = input.direction === "incoming";
    input.bidirectional =
      reverseOnly || input.direction === "both" || input.bidirectional;
    if (this.active >= 4)
      throw new CoreApiError(
        "command_capacity",
        "Four connections are already being set up",
        503,
      );
    const normalizedRoute = normalizeOwnerRoute(input.route);
    this.active++;
    const signal = AbortSignal.any([caller, AbortSignal.timeout(45_000)]),
      operationId = randomUUID();
    const assertOwner = () => {
      signal.throwIfAborted();
      guard();
    };
    const fence = new PolicyFence(this.manager, assertOwner);
    const client = new PeerOwnerClient(normalizedRoute, fence.check);
    let target: string | undefined,
      dispatched = false,
      outgoing = false,
      incoming = false,
      issue: string | undefined;
    let cleanup: "confirmed" | "unconfirmed" = "unconfirmed";
    try {
      await client.connect(input.username, input.password, signal);
      fence.check();
      const remote = bootstrapSchema.parse(
        await client.request(
          `/api/peers/connections/bootstrap?sourceServerId=${this.manager.serverId}`,
          "GET",
          undefined,
          signal,
        ),
      );
      target = remote.identity.serverId;
      let remoteRevision = remote.policyRevision;
      if (remote.environmentOverride === false)
        throw new CoreApiError(
          "forbidden",
          "Server connections are disabled by the other server’s environment",
          403,
        );
      if (
        target === this.manager.serverId ||
        (input.expectedServerId && target !== input.expectedServerId)
      )
        throw new CoreApiError(
          "peer_identity_mismatch",
          "The authenticated server identity does not match the selected server",
          502,
        );
      const existing = this.manager.store
        .read()
        .outgoing.find(
          (p) =>
            p.invitation.targetServerId === target && p.origin === "manual",
        );
      if (!reverseOnly && (existing || remote.incoming) && !input.replace)
        throw new CoreApiError(
          "peer_record_conflict",
          "This direction already exists; use Renew after inspecting the server",
          409,
        );
      if (input.bidirectional && remote.selectedOrigin === "fleet")
        throw new CoreApiError(
          "peer_record_conflict",
          "The other server has a fleet credential selected for this server; inspect that selection before adding reverse access",
          409,
        );
      const selected = this.manager.store.read().selected[target];
      if (
        !reverseOnly &&
        selected &&
        selected !== existing?.invitation.credentialId
      )
        throw new CoreApiError(
          "peer_record_conflict",
          "A fleet credential is selected for this server; explicitly select or remove it before configuring trusted control",
          409,
        );
      if (
        input.bidirectional &&
        input.route.kind !== "relay" &&
        !input.returnRoute &&
        !this.manager.store.read().relay?.enabled
      )
        throw new CoreApiError(
          "invalid_request",
          "A two-way connection needs a reachable return address or an enabled peer relay on this server",
          400,
        );
      await fence.write((check) =>
        this.manager.store.mutate((next) => {
          check();
          const metadata = rememberPeer(next, remote.identity, input.label);
          metadata.setupRoute = normalizedRoute;
          metadata.setupUsername = input.username;
          recordPeerAudit(
            next,
            "pair-started",
            target!,
            this.manager.serverId,
            {
              operationId,
            },
          );
        }),
      );
      if (!this.manager.isEnabled())
        await fence.write((check) => this.manager.setEnabled(true, check));
      dispatched = true;
      if (!reverseOnly) {
        const issued = grantSchema.parse(
          await client.request(
            "/api/peers/connections/grant",
            "POST",
            {
              identity: this.manager.identity(),
              expectedPolicyRevision: remoteRevision,
              operationId,
              expectedCredential: remote.incoming,
              ...(input.route.kind === "relay"
                ? { relayUrl: normalizeOwnerRoute(input.route).url }
                : {}),
            },
            signal,
          ),
        );
        remoteRevision = issued.policyRevision;
        if (
          issued.identity.serverId !== target ||
          issued.invitation.targetServerId !== target
        )
          throw new CoreApiError(
            "peer_identity_mismatch",
            "Issued credential names a different server",
            502,
          );
        await fence.write((check) =>
          this.manager.importOutgoing(
            {
              invitation: issued.invitation,
              route: routeForPeer(input.route, issued.relay),
              operations: existing?.operations ?? controlOperations,
              allowAgentSessions: existing?.allowAgentSessions ?? true,
              replace: input.replace,
            },
            signal,
            check,
            remote.identity,
            input.label,
            operationId,
          ),
        );
        outgoing = true;
      }
      if (input.bidirectional) {
        if (reverseOnly && !remote.enabled) {
          const prepared = z
            .object({ policyRevision: z.number().int().nonnegative() })
            .parse(
              await client.request(
                "/api/peers/connections/prepare",
                "POST",
                { expectedPolicyRevision: remoteRevision },
                signal,
              ),
            );
          remoteRevision = prepared.policyRevision;
        }
        const state = this.manager.store.read(),
          prior = state.incoming.find(
            (p) => p.sourceServerId === target && p.origin === "manual",
          );
        if (prior && !input.replace)
          throw new CoreApiError(
            "peer_record_conflict",
            "The reverse direction already exists; inspect before renewal",
            409,
          );
        fence.check();
        const reverse = await this.grant(
          {
            identity: remote.identity,
            initiatingServerId: this.manager.serverId,
            expectedPolicyRevision: fence.revision,
            operationId,
            expectedCredential: prior
              ? { id: prior.id, generation: prior.generation }
              : null,
            ...(input.route.kind === "relay"
              ? { relayUrl: normalizeOwnerRoute(input.route).url }
              : {}),
          },
          assertOwner,
          signal,
        );
        fence.revision = reverse.policyRevision;
        fence.check();
        const returnRoute =
          input.returnRoute ??
          peerRouteSchema.parse({
            kind: "relay",
            url: reverse.relay!.url,
            username: reverse.relay!.username,
          });
        await client.request(
          "/api/peers/connections/import",
          "POST",
          {
            invitation: reverse.invitation,
            expectedPolicyRevision: remoteRevision,
            route: returnRoute,
            operations: controlOperations,
            allowAgentSessions: true,
            replace: input.replace,
            identity: this.manager.identity(),
            operationId,
          },
          signal,
        );
        incoming = true;
      }
    } catch (error) {
      if (!dispatched) throw error;
      issue =
        error instanceof CoreApiError
          ? error.message
          : "Setup could not confirm every direction; inspect both servers before retrying";
    } finally {
      cleanup = await client.close();
      this.active--;
    }
    const outcome = (reverseOnly ? incoming : outgoing)
      ? input.bidirectional && !incoming
        ? "partial"
        : "connected"
      : "uncertain";
    if (target)
      await this.manager.store
        .mutate((next) => {
          // Nonsecret observation of already-dispatched owner work cannot grant authority.
          const m = next.connections?.find((p) => p.serverId === target);
          if (m) m.lastOutcome = outcome === "connected" ? "verified" : outcome;
          recordPeerAudit(
            next,
            outcome === "connected"
              ? "pair-completed"
              : outcome === "partial"
                ? "pair-partial"
                : "pair-uncertain",
            target!,
            this.manager.serverId,
            { operationId },
          );
        })
        .catch(() => {});
    return {
      serverId: target!,
      outcome,
      outgoing: reverseOnly ? "unchanged" : outgoing ? "confirmed" : "unknown",
      incoming: input.bidirectional
        ? incoming
          ? "confirmed"
          : "unknown"
        : "not-requested",
      ownerSessionCleanup: cleanup,
      operationId,
      ...(issue ? { issue } : {}),
    };
  }
  async remove(
    serverId: string,
    direction: "incoming" | "outgoing",
    id: string,
    generation: number,
    guard: () => void,
  ) {
    await this.manager.store.mutate((next) => {
      guard();
      if (direction === "incoming") {
        const peer = next.incoming.find(
          (p) =>
            p.sourceServerId === serverId &&
            p.id === id &&
            p.generation === generation &&
            p.origin === "manual",
        );
        if (!peer)
          throw new CoreApiError(
            "peer_record_conflict",
            "The incoming credential changed",
            409,
          );
        next.incoming = next.incoming.filter((p) => p !== peer);
        recordPeerAudit(
          next,
          "incoming-revoked",
          serverId,
          this.manager.serverId,
          { credentialId: id, generation },
        );
      } else {
        const peer = next.outgoing.find(
          (p) =>
            p.invitation.targetServerId === serverId &&
            p.invitation.credentialId === id &&
            p.invitation.generation === generation &&
            p.origin === "manual",
        );
        if (!peer)
          throw new CoreApiError(
            "peer_record_conflict",
            "The outgoing credential changed",
            409,
          );
        next.outgoing = next.outgoing.filter((p) => p !== peer);
        if (next.selected[serverId] === id) delete next.selected[serverId];
        recordPeerAudit(
          next,
          "outgoing-removed",
          serverId,
          this.manager.serverId,
          { credentialId: id, generation },
        );
      }
    });
  }
  async test(serverId: string, guard: () => void, signal: AbortSignal) {
    const state = this.manager.store.read(),
      revision = this.manager.store.currentRevision();
    const peer = state.outgoing.find(
      (p) =>
        p.invitation.targetServerId === serverId &&
        state.selected[serverId] === p.invitation.credentialId,
    );
    if (!this.manager.isEnabled() || !peer)
      throw new CoreApiError(
        "server_not_found",
        "No enabled outgoing connection",
        404,
      );
    guard();
    if (
      ["update-required", "unavailable"].includes(
        this.manager.authentication.status(peer) ?? "",
      )
    )
      await this.manager.authentication.retry(peer, guard, signal);
    await this.manager
      .protectedTransport(peer)
      .request(
        "access",
        { serverId, signal },
        { sessionId: null, launchId: null },
      );
    await this.manager.store.mutate((next) => {
      guard();
      const metadata = next.connections?.find((p) => p.serverId === serverId);
      if (metadata) {
        metadata.verifiedAt = new Date().toISOString();
        metadata.lastOutcome = "verified";
      }
      recordPeerAudit(next, "verified", serverId, this.manager.serverId, {
        credentialId: peer.invitation.credentialId,
        generation: peer.invitation.generation,
      });
    }, revision);
  }
}
