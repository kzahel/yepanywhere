import {
  PEER_AUTHENTICATION,
  PEER_ACCESS_MS,
  PEER_IDLE_MS,
  PEER_REFRESH_MS,
  incomingAuthentication,
  outgoingAuthentication,
  peerRefreshRequest,
  type PeerRefreshReceipt,
} from "./authentication-contracts.js";
import {
  peerConnectionMetadataSchema,
  peerAuditSchema,
  recordPeerAudit,
  rememberPeer,
  type PeerHost,
} from "./connection-contracts.js";
import {
  fleetPeerBindingSchema,
  fleetCredentialsSchema,
  profileKeysSchema,
  type FleetPeerBinding,
} from "../fleet/contracts.js";
import { randomBytes, randomUUID, randomInt } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isValidRelayUsername } from "@yep-anywhere/shared";
import { operations, type Operation } from "../core-api/contracts.js";
import { CoreApiError } from "../core-api/errors.js";
import { generateVerifier } from "../crypto/srp-server.js";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";
import { hashPeerToken } from "./directory.js";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_MS = 30 * 24 * 60 * 60_000;
const boundedId = z.string().min(1).max(4096);
const resourceOperations = operations
  .filter((op) => op.path.includes(":serverId"))
  .map((op) => op.id);
const ops = z.array(z.enum(resourceOperations)).min(1).max(32);
const publicUuid = z.string().uuid();
const expiration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(1).max(2_147_483_647);
const hex = z
  .string()
  .regex(/^[0-9a-f]+$/)
  .min(1)
  .max(2048);
const peerSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const peerUsername = z.string().regex(/^peer-[0-9a-f-]{36}$/);
export const peerRouteSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("direct"), url: z.string().url().max(2048) })
      .strict(),
    z
      .object({
        kind: z.literal("relay"),
        url: z.string().url().max(2048),
        username: z
          .string()
          .min(3)
          .max(64)
          .regex(/^[a-z0-9-]+$/),
      })
      .strict(),
  ])
  .superRefine((route, context) => {
    const url = new URL(route.url);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (route.kind === "direct" && url.pathname !== "/peer/ws") ||
      (route.kind === "relay" && !isValidRelayUsername(route.username))
    )
      context.addIssue({
        code: "custom",
        message:
          "Use a ws/wss peer route without URL credentials, query or fragment; direct paths must be /peer/ws",
      });
  });
export type PeerRoute = z.infer<typeof peerRouteSchema>;
export const incomingPeerRequest = z
  .object({
    sourceServerId: publicUuid,
    authentication: z.literal(PEER_AUTHENTICATION).optional(),
    allProjects: z.literal(true).optional(),
    projects: z.array(boundedId).max(64),
    operations: ops.describe(
      "Explicit resource operations. server/access/capabilities are included; session is required for history, receipts and commands.",
    ),
    expiresAt: expiration,
    acknowledgeExecutionAuthority: z.literal("server-account").optional(),
  })
  .strict();
export const rotatePeerRequest = incomingPeerRequest
  .omit({ sourceServerId: true })
  .strict();
export const invitationSchema = z
  .object({
    version: z.literal(1),
    authentication: z.literal(PEER_AUTHENTICATION).optional(),
    sourceServerId: publicUuid,
    targetServerId: publicUuid,
    credentialId: publicUuid,
    generation,
    username: peerUsername,
    secret: peerSecret,
    expiresAt: expiration,
  })
  .strict()
  .refine(
    (invitation) => invitation.username === `peer-${invitation.credentialId}`,
    "Peer username must name its credential",
  );
export type PeerInvitation = z.infer<typeof invitationSchema>;
export const outgoingPeerRequest = z
  .object({
    invitation: invitationSchema,
    route: peerRouteSchema,
    operations: ops,
    allowAgentSessions: z.boolean().default(false),
    replace: z.boolean().default(false),
  })
  .strict();
export type OutgoingPeerRequest = z.infer<typeof outgoingPeerRequest>;
const incomingSchema = z
  .object({
    id: publicUuid,
    sourceServerId: publicUuid,
    generation,
    username: peerUsername,
    salt: hex,
    verifier: hex,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    authentication: incomingAuthentication.optional(),
    pairingOrigin: z.literal("server-connections").optional(),
    allProjects: z.literal(true).optional(),
    projects: z.array(boundedId).max(64),
    operations: ops,
    expiresAt: expiration,
  })
  .strict();

const outgoingSchema = outgoingPeerRequest
  .omit({ replace: true })
  .extend({
    allProjects: z.literal(true).optional(),
    authentication: outgoingAuthentication.optional(),
    pairingOrigin: z.literal("server-connections").optional(),
  })
  .strict();

export const peerRelayRequest = z
  .object({
    url: z.string().url().max(2048),
    username: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (!peerRouteSchema.safeParse({ ...value, kind: "relay" }).success)
      context.addIssue({ code: "custom", message: "Invalid peer relay route" });
  });
const legacyStateBase = z
  .object({
    version: z.literal(1),
    serverId: publicUuid,
    decoySecret: peerSecret,
    agentAccess: z
      .object({ enabled: z.boolean(), grantId: publicUuid.nullable() })
      .strict(),
    incoming: z.array(incomingSchema).max(64),
    outgoing: z.array(outgoingSchema).max(64),
    relay: z
      .object({
        url: z.string(),
        username: z.string(),
        registrationId: publicUuid,
        enabled: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const legacyStateSchema = legacyStateBase.superRefine((state, context) => {
  if (
    state.agentAccess.enabled !== Boolean(state.agentAccess.grantId) ||
    new Set(state.incoming.map((p) => p.id)).size !== state.incoming.length ||
    new Set(state.incoming.map((p) => p.sourceServerId)).size !==
      state.incoming.length ||
    new Set(state.incoming.map((p) => p.tokenHash)).size !==
      state.incoming.length ||
    new Set(state.outgoing.map((p) => p.invitation.targetServerId)).size !==
      state.outgoing.length ||
    state.incoming.some(
      (p) =>
        p.sourceServerId === state.serverId || p.username !== `peer-${p.id}`,
    ) ||
    state.outgoing.some(
      (p) =>
        p.invitation.sourceServerId !== state.serverId ||
        p.invitation.targetServerId === state.serverId,
    ) ||
    (state.relay &&
      !peerRelayRequest.safeParse({
        url: state.relay.url,
        username: state.relay.username,
      }).success)
  )
    context.addIssue({ code: "custom", message: "Inconsistent peer state" });
});

const storedIncomingSchema = z.discriminatedUnion("origin", [
  incomingSchema.extend({ origin: z.literal("manual") }).strict(),
  incomingSchema
    .extend({ origin: z.literal("fleet"), binding: fleetPeerBindingSchema })
    .strict(),
]);
export type StoredIncomingPeer = z.infer<typeof storedIncomingSchema>;
const storedOutgoingSchema = z.discriminatedUnion("origin", [
  outgoingSchema.extend({ origin: z.literal("manual") }).strict(),
  outgoingSchema
    .extend({
      origin: z.literal("fleet"),
      binding: fleetPeerBindingSchema,
      envelopeId: publicUuid,
      envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type StoredOutgoingPeer = z.infer<typeof storedOutgoingSchema>;
export const fleetOutboxSchema = z
  .object({
    envelopeId: publicUuid,
    credentialId: publicUuid,
    credentialGeneration: generation,
    binding: fleetPeerBindingSchema,
    ciphertext: z
      .string()
      .min(1)
      .max(32 * 1024),
  })
  .strict();
const stateSchema = legacyStateBase
  .extend({
    version: z.literal(3),
    enabled: z.boolean().optional(),
    connections: z.array(peerConnectionMetadataSchema).max(128).optional(),
    audit: z.array(peerAuditSchema).max(512).optional(),
    incoming: z.array(storedIncomingSchema).max(64),
    outgoing: z.array(storedOutgoingSchema).max(128),
    selected: z.record(publicUuid, publicUuid),
    fleet: z
      .object({
        epoch: z.number().int().nonnegative(),
        enrollment: z
          .object({
            issuer: z.string().url().max(2048),
            accountId: publicUuid,
            keys: profileKeysSchema,
            credentials: fleetCredentialsSchema.nullable(),
          })
          .strict()
          .nullable(),
        outbox: z.array(fleetOutboxSchema).max(64),
      })
      .strict(),
  })
  .superRefine((state, context) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    const enrollment = state.fleet.enrollment;
    const validBinding = (binding: FleetPeerBinding) =>
      Boolean(
        enrollment &&
          binding.issuer === enrollment.issuer &&
          binding.accountId === enrollment.accountId,
      );
    if (
      state.agentAccess.enabled !== Boolean(state.agentAccess.grantId) ||
      !unique((state.connections ?? []).map((p) => p.serverId)) ||
      (state.connections ?? []).some(
        (p) => p.identity && p.identity.serverId !== p.serverId,
      ) ||
      !unique(state.incoming.map((p) => p.id)) ||
      !unique(state.incoming.map((p) => `${p.sourceServerId}/${p.origin}`)) ||
      !unique(state.incoming.map((p) => p.tokenHash)) ||
      !unique(state.outgoing.map((p) => p.invitation.credentialId)) ||
      !unique(
        state.outgoing.map((p) => `${p.invitation.targetServerId}/${p.origin}`),
      ) ||
      new Set(state.outgoing.map((p) => p.invitation.targetServerId)).size >
        64 ||
      state.incoming.some(
        (p) =>
          p.sourceServerId === state.serverId ||
          p.username !== `peer-${p.id}` ||
          (p.origin === "fleet" &&
            (!validBinding(p.binding) ||
              p.allProjects === true ||
              !!p.authentication ||
              p.binding.source.profileId !== p.sourceServerId ||
              p.binding.target.profileId !== state.serverId ||
              p.expiresAt > p.binding.policy.expiresAt ||
              p.projects.some(
                (id) => !p.binding.policy.projects.includes(id),
              ) ||
              p.operations.some(
                (op) => !p.binding.policy.operations.includes(op),
              ))),
      ) ||
      state.outgoing.some(
        (p) =>
          p.invitation.sourceServerId !== state.serverId ||
          p.invitation.targetServerId === state.serverId ||
          (p.origin === "fleet" &&
            (!validBinding(p.binding) ||
              p.allProjects === true ||
              !!p.authentication ||
              !!p.invitation.authentication ||
              p.binding.source.profileId !== state.serverId ||
              p.binding.target.profileId !== p.invitation.targetServerId ||
              p.invitation.expiresAt > p.binding.policy.expiresAt)),
      ) ||
      Object.entries(state.selected).some(
        ([target, id]) =>
          !state.outgoing.some(
            (p) =>
              p.invitation.targetServerId === target &&
              p.invitation.credentialId === id,
          ),
      ) ||
      state.fleet.outbox.some(
        (item) =>
          !state.incoming.some(
            (p) =>
              p.origin === "fleet" &&
              p.id === item.credentialId &&
              p.generation === item.credentialGeneration &&
              JSON.stringify(p.binding) === JSON.stringify(item.binding),
          ),
      ) ||
      (state.relay &&
        !peerRelayRequest.safeParse({
          url: state.relay.url,
          username: state.relay.username,
        }).success)
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent peer v2 state",
      });
  });
export type PeerAccessState = z.infer<typeof stateSchema>;
export function outgoingPeerPolicy(peer: StoredOutgoingPeer) {
  const { authentication: _authentication, ...policy } = peer;
  const { authentication: _mode, ...invitation } = policy.invitation;
  return {
    ...policy,
    invitation: {
      ...invitation,
      ...(peer.invitation.authentication ? { expiresAt: 0 } : {}),
    },
  };
}
function peerPolicySnapshot(state: Readonly<PeerAccessState>) {
  const enrollment = state.fleet.enrollment;
  return {
    ...state,
    incoming: state.incoming.map((p) => {
      const { authentication: _authentication, ...policy } = p;
      return {
        ...policy,
        ...(p.authentication || uiPairingOperation(state, p)
          ? { expiresAt: 0 }
          : {}),
      };
    }),
    outgoing: state.outgoing.map((p) => {
      const policy = outgoingPeerPolicy(p);
      if (uiPairingOperation(state, p)) policy.invitation.expiresAt = 0;
      return policy;
    }),
    fleet: enrollment
      ? {
          ...state.fleet,
          enrollment: {
            ...enrollment,
            credentials: enrollment.credentials
              ? { client: enrollment.credentials.client }
              : null,
          },
        }
      : state.fleet,
  };
}

/** Only the exact historical UI default is eligible without fresh owner login. */
export function uiPairingOperation(
  state: Readonly<PeerAccessState>,
  peer: StoredIncomingPeer | StoredOutgoingPeer,
): string | undefined {
  if (peer.origin !== "manual") return;
  const incoming = "sourceServerId" in peer;
  const id = incoming ? peer.id : peer.invitation.credentialId,
    generation = incoming ? peer.generation : peer.invitation.generation;
  if (
    generation !== 1 ||
    !peer.allProjects ||
    resourceOperations.some((op) => !peer.operations.includes(op))
  )
    return;
  const expiry = incoming ? peer.expiresAt : peer.invitation.expiresAt;
  return state.audit?.find(
    (e) =>
      e.action === (incoming ? "incoming-issued" : "outgoing-imported") &&
      e.serverId ===
        (incoming ? peer.sourceServerId : peer.invitation.targetServerId) &&
      e.credentialId === id &&
      e.generation === generation &&
      e.operationId &&
      Math.abs(expiry - Date.parse(e.at) - MAX_CREDENTIAL_MS) < 60_000,
  )?.operationId;
}
export function uiPairing(
  state: Readonly<PeerAccessState>,
  peer: StoredIncomingPeer | StoredOutgoingPeer,
) {
  return (
    peer.origin === "manual" &&
    (peer.pairingOrigin === "server-connections" ||
      !!uiPairingOperation(state, peer))
  );
}

export function peerGrantOperations(operations: readonly Operation[]) {
  const result = [
    ...new Set<Operation>(["server", "access", "capabilities", ...operations]),
  ];
  if (
    result.some((op) =>
      [
        "conversation",
        "followConversation",
        "receipt",
        "followReceipt",
        "relationships",
        "createSession",
        "sendMessage",
      ].includes(op),
    ) &&
    !result.includes("session")
  )
    throw new CoreApiError(
      "invalid_request",
      "This grant requires the session operation for current resource authorization",
      400,
    );
  return result;
}

/** Private durable policy; neither construction nor reads start server work. */
export class PeerAccessStore {
  readonly directory: string;
  readonly path: string;
  private state?: PeerAccessState;
  private failed = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private pendingMutations = 0;
  private activeIssuance = 0;
  private changed?: (state: PeerAccessState, previous: PeerAccessState) => void;
  private fault?: () => void;
  constructor(
    readonly serverId: string,
    dataDir: string,
    private readonly now = Date.now,
  ) {
    publicUuid.parse(serverId);
    this.directory = join(dataDir, "peer-access");
    this.path = join(this.directory, "state.json");
  }
  observe(changed: typeof this.changed, fault: () => void) {
    if (this.changed) throw new Error("Peer policy already has an owner");
    this.changed = changed;
    this.fault = fault;
  }
  async initialize() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await enforceOwnerOnlyPathPermissionsStrict(this.directory, "directory");
      try {
        if ((await stat(this.path)).size > MAX_STATE_BYTES)
          throw new Error("Oversized peer state");
        await enforceOwnerOnlyPathPermissionsStrict(this.path, "file");
        const loaded = JSON.parse(await readFile(this.path, "utf8"));
        const legacy =
          loaded.version === 1 ? legacyStateSchema.parse(loaded) : undefined;
        const saved = stateSchema.parse(
          legacy
            ? {
                ...legacy,
                version: 3,
                incoming: legacy.incoming.map((p) => ({
                  ...p,
                  origin: "manual",
                })),
                outgoing: legacy.outgoing.map((p) => ({
                  ...p,
                  origin: "manual",
                })),
                selected: Object.fromEntries(
                  legacy.outgoing.map((p) => [
                    p.invitation.targetServerId,
                    p.invitation.credentialId,
                  ]),
                ),
                fleet: { epoch: 0, enrollment: null, outbox: [] },
              }
            : loaded.version === 2
              ? { ...loaded, version: 3 }
              : loaded,
        );
        if (saved.serverId !== this.serverId)
          throw new Error("Peer state belongs to another logical server");
        if (legacy || loaded.version === 2)
          await writeFileAtomically(this.path, JSON.stringify(saved), {
            mode: 0o600,
            durable: true,
          });
        this.state = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = {
          version: 3,
          selected: {},
          fleet: { epoch: 0, enrollment: null, outbox: [] },
          serverId: this.serverId,
          decoySecret: randomBytes(32).toString("base64url"),
          agentAccess: { enabled: false, grantId: null },
          incoming: [],
          outgoing: [],
          relay: null,
        };
      }
    } catch {
      this.failed = true;
      this.fault?.();
      throw new CoreApiError(
        "peer_state_unavailable",
        "Private peer state cannot be loaded safely",
        503,
      );
    }
  }
  read() {
    if (!this.state || this.failed || this.closed)
      throw new CoreApiError(
        "peer_state_unavailable",
        "Peer state is unavailable",
        503,
      );
    return this.state as Readonly<PeerAccessState>;
  }
  currentRevision() {
    this.read();
    return this.revision;
  }
  mutate<T>(
    update: (next: PeerAccessState) => T,
    expectedRevision?: number,
  ): Promise<T> {
    return this.publish(update, expectedRevision);
  }
  publishPeerAuthentication<T>(
    update: (next: PeerAccessState) => T,
  ): Promise<T> {
    return this.publish(update, undefined, true);
  }
  publishFleetCredentials<T>(update: (next: PeerAccessState) => T): Promise<T> {
    return this.publish(update, undefined, true);
  }
  /** One reserved slot for the single serialized fleet client's cleanup.
   * Recheck the exact family at execution; never erase newer enrollment.
   */
  discardFleetCredentials(epoch: number, refreshToken: string): Promise<void> {
    const current = this.read();
    if (
      current.fleet.epoch !== epoch ||
      current.fleet.enrollment?.credentials?.refreshToken !== refreshToken
    )
      return Promise.resolve();
    return this.publish(
      (next) => {
        if (
          next.fleet.epoch === epoch &&
          next.fleet.enrollment?.credentials?.refreshToken === refreshToken
        )
          next.fleet.enrollment.credentials = null;
      },
      undefined,
      false,
      true,
    );
  }
  private publish<T>(
    update: (next: PeerAccessState) => T,
    expectedRevision?: number,
    credentialPublication = false,
    fleetDiscard = false,
  ): Promise<T> {
    if (this.pendingMutations >= (fleetDiscard ? 17 : 16))
      return Promise.reject(
        new CoreApiError(
          "command_capacity",
          "Peer policy mutation capacity reached",
          503,
        ),
      );
    this.pendingMutations++;
    const pending = this.tail.then(async () => {
      const previous = this.read();
      if (expectedRevision !== undefined && expectedRevision !== this.revision)
        throw new CoreApiError(
          "peer_record_conflict",
          "Peer state changed during preflight; inspect current records before retrying",
          409,
        );
      const next = structuredClone(previous),
        result = update(next);
      const valid = stateSchema.parse(next),
        content = JSON.stringify(valid);
      if (Buffer.byteLength(content) > MAX_STATE_BYTES)
        throw new CoreApiError(
          "receipt_capacity",
          "Peer state byte capacity reached",
          503,
        );
      try {
        await writeFileAtomically(this.path, content, {
          mode: 0o600,
          durable: true,
        });
        // The owner-only directory gives Windows staging files its private ACL;
        // Unix staging uses 0600. Rename preserves those rights and file owner.
        this.state = valid;
        // Routine refresh rotates private session material, not peer policy.
        // A changed client binding, disconnect, grant or selection still fences.
        if (
          !credentialPublication ||
          JSON.stringify(peerPolicySnapshot(previous)) !==
            JSON.stringify(peerPolicySnapshot(valid))
        )
          this.revision++;
        if (!this.closed) this.changed?.(valid, previous as PeerAccessState);
      } catch {
        // Rename may already have published. Never keep the old live authority
        // after an uncertain persistence/application failure.
        this.failed = true;
        this.fault?.();
        throw new CoreApiError(
          "peer_state_unavailable",
          "Peer policy persistence is uncertain; access is closed until recovery",
          503,
        );
      }
      return result;
    });
    this.tail = pending.catch(() => {});
    return pending.finally(() => {
      this.pendingMutations--;
    });
  }
  private validateGrant(input: z.infer<typeof rotatePeerRequest>) {
    if (
      input.expiresAt <= this.now() ||
      input.expiresAt >
        this.now() + (input.authentication ? PEER_IDLE_MS : MAX_CREDENTIAL_MS)
    )
      throw new CoreApiError(
        "invalid_request",
        "Peer expiry is outside its authentication policy window",
        400,
      );
    const operations = peerGrantOperations(input.operations);
    if (
      operations.some((op) => op === "createSession" || op === "sendMessage") &&
      input.acknowledgeExecutionAuthority !== "server-account"
    )
      throw new CoreApiError(
        "invalid_request",
        "Execution grants require explicit server-account authority acknowledgement",
        400,
      );
    return operations;
  }
  async issue(
    value: unknown,
    rotateId?: string,
    expectedRevision?: number,
    admit?: () => void,
    identity?: PeerHost,
    operationId?: string,
    initiatingServerId?: string,
    pairingOrigin = false,
  ): Promise<PeerInvitation> {
    if (this.activeIssuance >= 4)
      throw new CoreApiError(
        "command_capacity",
        "Peer credential issuance capacity reached",
        503,
      );
    this.activeIssuance++;
    try {
      const revision = expectedRevision ?? this.currentRevision();
      if (revision !== this.currentRevision())
        throw new CoreApiError(
          "peer_record_conflict",
          "Peer state changed during project validation",
          409,
        );
      const input = rotateId
        ? rotatePeerRequest.parse(value)
        : incomingPeerRequest.parse(value);
      const operations = this.validateGrant(input);
      const current = this.read();
      const previous = rotateId
        ? current.incoming.find(
            (p) => p.id === rotateId && p.origin === "manual",
          )
        : undefined;
      if (rotateId && !previous)
        throw new CoreApiError(
          "server_not_found",
          "Incoming peer record not found",
          404,
        );
      const sourceServerId =
        previous?.sourceServerId ??
        incomingPeerRequest.parse(value).sourceServerId;
      if (sourceServerId === this.serverId)
        throw new CoreApiError(
          "invalid_request",
          "A peer must be a different logical server",
          400,
        );
      const id = previous?.id ?? randomUUID(),
        username = `peer-${id}`,
        secret = randomBytes(32).toString("base64url");
      const verifier = await generateVerifier(username, secret);
      const invitation: PeerInvitation = {
        version: 1,
        ...(input.authentication
          ? { authentication: PEER_AUTHENTICATION }
          : {}),
        sourceServerId,
        targetServerId: this.serverId,
        credentialId: id,
        generation: (previous?.generation ?? 0) + 1,
        username,
        secret,
        expiresAt: input.expiresAt,
      };
      return await this.mutate((next) => {
        admit?.();
        const existing = next.incoming.find(
          (p) => p.sourceServerId === sourceServerId && p.origin === "manual",
        );
        if (
          (rotateId &&
            (!existing ||
              existing.id !== rotateId ||
              existing.generation !== previous!.generation)) ||
          (!rotateId && existing)
        )
          throw new CoreApiError(
            "peer_record_conflict",
            "Incoming peer already exists or changed; inspect it before rotation",
            409,
          );
        if (!existing && next.incoming.length >= 64)
          throw new CoreApiError(
            "command_capacity",
            "Incoming peer capacity reached",
            503,
          );
        const record: StoredIncomingPeer = {
          origin: "manual",
          id,
          sourceServerId,
          generation: invitation.generation,
          username,
          ...verifier,
          tokenHash: hashPeerToken(secret),
          ...(input.authentication
            ? {
                authentication: {
                  protocol: PEER_AUTHENTICATION,
                  lastRefreshedAt: this.now(),
                  access: [],
                },
              }
            : {}),
          ...((pairingOrigin && !previous) || previous?.pairingOrigin
            ? { pairingOrigin: "server-connections" as const }
            : {}),
          ...(input.allProjects ? { allProjects: true as const } : {}),
          projects: [...new Set(input.projects)],
          operations,
          expiresAt: input.expiresAt,
        };
        next.incoming = [...next.incoming.filter((p) => p.id !== id), record];
        if (identity) rememberPeer(next, identity);
        recordPeerAudit(
          next,
          "incoming-issued",
          sourceServerId,
          initiatingServerId ?? identity?.serverId,
          { operationId, credentialId: id, generation: invitation.generation },
        );
        return invitation;
      }, revision);
    } finally {
      this.activeIssuance--;
    }
  }
  revokeIncoming(id: string) {
    return this.mutate((next) => {
      const peer = next.incoming.find((p) => p.id === id);
      if (peer) recordPeerAudit(next, "incoming-revoked", peer.sourceServerId);
      next.incoming = next.incoming.filter((p) => p.id !== id);
      next.fleet.outbox = next.fleet.outbox.filter(
        (item) => item.credentialId !== id,
      );
    });
  }
  importOutgoing(
    value: OutgoingPeerRequest,
    revision: number,
    admit?: () => void,
    identity?: PeerHost,
    label?: string,
    operationId?: string,
    verifiedAllProjects = false,
  ) {
    const input = outgoingPeerRequest.parse(value);
    if (
      input.invitation.sourceServerId !== this.serverId ||
      input.invitation.targetServerId === this.serverId ||
      input.invitation.expiresAt <= this.now()
    )
      return Promise.reject(
        new CoreApiError(
          "invalid_request",
          "Invitation is expired or names another source/target profile",
          400,
        ),
      );
    return this.mutate((next) => {
      admit?.();
      const target = input.invitation.targetServerId,
        existing = next.outgoing.find(
          (p) =>
            p.invitation.targetServerId === target && p.origin === "manual",
        );
      if (existing && !input.replace)
        throw new CoreApiError(
          "peer_record_conflict",
          "Outgoing peer already exists; replacement must be explicit",
          409,
        );
      if (
        !existing &&
        (next.outgoing.length >= 128 ||
          (!next.outgoing.some((p) => p.invitation.targetServerId === target) &&
            new Set(next.outgoing.map((p) => p.invitation.targetServerId))
              .size >= 64))
      )
        throw new CoreApiError(
          "command_capacity",
          "Outgoing peer capacity reached",
          503,
        );
      if (identity) {
        const metadata = rememberPeer(next, identity, label);
        metadata.verifiedAt = new Date().toISOString();
        metadata.lastOutcome = "verified";
      }
      recordPeerAudit(next, "outgoing-imported", target, this.serverId, {
        operationId,
        credentialId: input.invitation.credentialId,
        generation: input.invitation.generation,
      });
      const { replace: _replace, ...record } = input;
      record.operations = peerGrantOperations(record.operations);
      next.outgoing = [
        ...next.outgoing.filter(
          (p) =>
            p.invitation.targetServerId !== target || p.origin !== "manual",
        ),
        {
          ...record,
          origin: "manual",
          ...((!existing && operationId && identity) || existing?.pairingOrigin
            ? { pairingOrigin: "server-connections" as const }
            : {}),
          ...(verifiedAllProjects ? { allProjects: true as const } : {}),
        },
      ];
      if (
        !next.selected[target] ||
        next.selected[target] === existing?.invitation.credentialId
      )
        next.selected[target] = record.invitation.credentialId;
    }, revision);
  }
  revokeOutgoing(targetId: string) {
    return this.mutate((next) => {
      recordPeerAudit(next, "outgoing-removed", targetId);
      next.outgoing = next.outgoing.filter(
        (p) => p.invitation.targetServerId !== targetId,
      );
      delete next.selected[targetId];
    });
  }
  refreshAuthentication(
    value: unknown,
    proof: { credentialId: string; generation: number; tokenHash: string },
    admit: () => void,
  ): Promise<PeerRefreshReceipt> {
    const input = peerRefreshRequest.parse(value);
    return this.publishPeerAuthentication((next) => {
      admit();
      const peer = next.incoming.find(
        (p) =>
          p.id === proof.credentialId &&
          p.generation === proof.generation &&
          p.tokenHash === proof.tokenHash &&
          p.origin === "manual",
      );
      if (!peer || peer.expiresAt <= this.now())
        throw new CoreApiError(
          "unauthorized",
          "Server authentication expired or changed; sign in again",
          401,
        );
      if (
        !peer.authentication &&
        (!input.migrationOperationId ||
          uiPairingOperation(next, peer) !== input.migrationOperationId)
      )
        throw new CoreApiError(
          "forbidden",
          "This time-limited grant does not allow automatic refresh",
          403,
        );
      const previous = peer.authentication?.access.find(
        (r) => r.requestId === input.requestId,
      );
      if (previous) {
        if (
          previous.tokenHash !== input.tokenHash ||
          previous.sequence !== input.sequence ||
          previous.migrationOperationId !== input.migrationOperationId
        )
          throw new CoreApiError(
            "request_id_conflict",
            "Refresh request id already names a different credential",
            409,
          );
        return previous;
      }
      if (input.sequence <= (peer.authentication?.access.at(-1)?.sequence ?? 0))
        throw new CoreApiError(
          "request_id_conflict",
          "Stale refresh sequence",
          409,
        );
      const now = this.now();
      const receipt = {
        ...input,
        expiresAt: now + PEER_ACCESS_MS,
        idleExpiresAt: now + PEER_IDLE_MS,
        refreshAt: now + PEER_REFRESH_MS + randomInt(-120_000, 120_001),
      };
      peer.expiresAt = receipt.idleExpiresAt;
      peer.authentication = {
        protocol: PEER_AUTHENTICATION,
        lastRefreshedAt: now,
        access: [...(peer.authentication?.access ?? []).slice(-1), receipt],
      };
      return receipt;
    });
  }
  setAgentAccess(enabled: boolean, admit?: () => void) {
    return this.mutate((next) => {
      admit?.();
      if (next.agentAccess.enabled === enabled) return;
      next.agentAccess = { enabled, grantId: enabled ? randomUUID() : null };
    });
  }
  configureRelay(value: unknown) {
    const input = peerRelayRequest.parse(value);
    return this.mutate((next) => {
      next.relay = {
        ...input,
        registrationId: next.relay?.registrationId ?? randomUUID(),
        enabled: true,
      };
    });
  }
  removeRelay() {
    return this.mutate((next) => {
      if (next.relay) next.relay.enabled = false;
    });
  }
  async close() {
    this.closed = true;
    await this.tail;
  }
}
