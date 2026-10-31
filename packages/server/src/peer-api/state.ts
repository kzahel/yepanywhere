import { randomBytes, randomUUID } from "node:crypto";
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

const MAX_STATE_BYTES = 2 * 1024 * 1024;
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
    projects: z.array(boundedId).max(64),
    operations: ops,
    expiresAt: expiration,
  })
  .strict();
export type StoredIncomingPeer = z.infer<typeof incomingSchema>;
const outgoingSchema = outgoingPeerRequest.omit({ replace: true }).strict();
export type StoredOutgoingPeer = z.infer<typeof outgoingSchema>;
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
const stateSchema = z
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
  .strict()
  .superRefine((state, context) => {
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
export type PeerAccessState = z.infer<typeof stateSchema>;

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
        const saved = stateSchema.parse(
          JSON.parse(await readFile(this.path, "utf8")),
        );
        if (saved.serverId !== this.serverId)
          throw new Error("Peer state belongs to another logical server");
        this.state = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = {
          version: 1,
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
  private mutate<T>(
    update: (next: PeerAccessState) => T,
    expectedRevision?: number,
  ): Promise<T> {
    if (this.pendingMutations >= 16)
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
      input.expiresAt > this.now() + MAX_CREDENTIAL_MS
    )
      throw new CoreApiError(
        "invalid_request",
        "Peer credential expiry must be in the next 30 days",
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
        ? current.incoming.find((p) => p.id === rotateId)
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
        sourceServerId,
        targetServerId: this.serverId,
        credentialId: id,
        generation: (previous?.generation ?? 0) + 1,
        username,
        secret,
        expiresAt: input.expiresAt,
      };
      return await this.mutate((next) => {
        const existing = next.incoming.find(
          (p) => p.sourceServerId === sourceServerId,
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
          id,
          sourceServerId,
          generation: invitation.generation,
          username,
          ...verifier,
          tokenHash: hashPeerToken(secret),
          projects: [...new Set(input.projects)],
          operations,
          expiresAt: input.expiresAt,
        };
        next.incoming = [...next.incoming.filter((p) => p.id !== id), record];
        return invitation;
      }, revision);
    } finally {
      this.activeIssuance--;
    }
  }
  revokeIncoming(id: string) {
    return this.mutate((next) => {
      next.incoming = next.incoming.filter((p) => p.id !== id);
    });
  }
  importOutgoing(value: OutgoingPeerRequest, revision: number) {
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
      const target = input.invitation.targetServerId,
        existing = next.outgoing.find(
          (p) => p.invitation.targetServerId === target,
        );
      if (existing && !input.replace)
        throw new CoreApiError(
          "peer_record_conflict",
          "Outgoing peer already exists; replacement must be explicit",
          409,
        );
      if (!existing && next.outgoing.length >= 64)
        throw new CoreApiError(
          "command_capacity",
          "Outgoing peer capacity reached",
          503,
        );
      const { replace: _replace, ...record } = input;
      record.operations = peerGrantOperations(record.operations);
      next.outgoing = [
        ...next.outgoing.filter((p) => p.invitation.targetServerId !== target),
        record,
      ];
    }, revision);
  }
  revokeOutgoing(targetId: string) {
    return this.mutate((next) => {
      next.outgoing = next.outgoing.filter(
        (p) => p.invitation.targetServerId !== targetId,
      );
    });
  }
  setAgentAccess(enabled: boolean) {
    return this.mutate((next) => {
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
