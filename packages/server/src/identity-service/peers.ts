import { randomBytes, randomUUID } from "node:crypto";
import * as jose from "jose";
import { z } from "zod";
import { CoreApiError } from "../core-api/errors.js";
import { generateVerifier } from "../crypto/srp-server.js";
import type {
  IncomingPeerGrant,
  PeerRequestAuthority,
} from "../peer-api/directory.js";
import { hashPeerToken } from "../peer-api/directory.js";
import type { PeerAccessManager } from "../peer-api/manager.js";
import {
  invitationSchema,
  peerGrantOperations,
  peerRouteSchema,
  type StoredIncomingPeer,
  type StoredOutgoingPeer,
} from "../peer-api/state.js";
import { accessSchema } from "../core-api/contracts.js";
import {
  IdentityServiceClient,
  type IdentityServiceOidcPending,
} from "./client.js";
import {
  enrolledClientSchema,
  identityServicePeerBindingSchema,
  accessPolicySchema,
  mailboxItemSchema,
  relationshipSchema,
  type IdentityServicePeerBinding,
} from "./contracts.js";
import {
  identityServiceDigest,
  identityServiceThumbprint,
  identityServiceOrigin,
  generateIdentityServiceProfileKeys,
  importIdentityServiceKey,
  publicIdentityServiceKey,
  signIdentityServiceJwt,
  verifyIdentityServiceKeyMaterial,
} from "./crypto.js";
import { IdentityServiceError } from "./errors.js";
import { IdentityIssuerVerifier } from "./issuer.js";
import { IdentityServiceWorkBudget, identityServiceWait } from "./limits.js";
import { narrowerPolicy } from "./contracts.js";

const signedInvitation = z
  .object({
    iss: z.string(),
    aud: z.string(),
    sub: z.uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.uuid(),
    version: z.literal(1),
    binding: identityServicePeerBindingSchema,
    invitation: invitationSchema,
    route: peerRouteSchema,
  })
  .strict();
const acceptance = z
  .object({
    relationshipId: z.uuid(),
    policy: accessPolicySchema,
    route: peerRouteSchema,
    acknowledgeExecutionAuthority: z.literal("server-account").optional(),
  })
  .strict();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (error: unknown): never => {
  if (error instanceof CoreApiError) throw error;
  throw new CoreApiError(
    error instanceof IdentityServiceError && error.status === 401
      ? "unauthorized"
      : "peer_unavailable",
    "Fleet authority is unavailable or no longer current",
    error instanceof IdentityServiceError && error.status === 401 ? 401 : 503,
  );
};

/** Owner-only enrollment orchestration. Agent workflows remain the existing v0. */
export class DelegatedPeerAccess {
  private http?: IdentityServiceClient;
  private issuer?: IdentityIssuerVerifier;
  private retiring = false;
  private readonly crypto = new IdentityServiceWorkBudget(8);
  private readonly preflight = new IdentityServiceWorkBudget(4);
  private readonly tokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private readonly oidcFlows = new Map<
    string,
    {
      pending: IdentityServiceOidcPending;
      ownerBinding: string;
      epoch: number;
      completing: boolean;
    }
  >();
  private oidcStarts = 0;
  constructor(
    readonly manager: PeerAccessManager,
    private readonly options: {
      allowInsecureLoopback?: boolean;
      fetch?: typeof fetch;
    } = {},
  ) {
    manager.setIdentityService({
      authority: (grant, token, signal) => this.authority(grant, token, signal),
      transport: (peer) => this.transport(peer),
    });
  }
  private state() {
    if (this.retiring)
      throw new IdentityServiceError(
        "unauthorized",
        "Fleet access is being retired",
        401,
      );
    const state = this.manager.store.read(),
      enrollment = state.fleet.enrollment;
    if (!enrollment)
      throw new IdentityServiceError(
        "login_required",
        "Configure fleet enrollment first",
        401,
      );
    return { state, enrollment, epoch: state.fleet.epoch };
  }
  private assert(epoch: number) {
    if (this.state().epoch !== epoch)
      throw new IdentityServiceError(
        "unauthorized",
        "Fleet enrollment changed",
        401,
      );
  }
  async initialize() {
    const enrollment = this.manager.store.read().fleet.enrollment;
    if (!enrollment) return;
    await this.crypto.run(async () => {
      await verifyIdentityServiceKeyMaterial(enrollment.keys.signing);
      const encrypted = await new jose.CompactEncrypt(
        new TextEncoder().encode("key check"),
      )
        .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM" })
        .encrypt(
          await importIdentityServiceKey(
            publicIdentityServiceKey(enrollment.keys.encryption),
            "ECDH-ES",
          ),
        );
      await jose.compactDecrypt(
        encrypted,
        await importIdentityServiceKey(enrollment.keys.encryption, "ECDH-ES"),
        {
          keyManagementAlgorithms: ["ECDH-ES"],
          contentEncryptionAlgorithms: ["A256GCM"],
        },
      );
    });
    this.connect();
  }
  private connect() {
    const { enrollment, epoch } = this.state();
    this.issuer = new IdentityIssuerVerifier(enrollment.issuer, this.options);
    this.http = new IdentityServiceClient(
      enrollment.issuer,
      this.manager.serverId,
      enrollment.keys,
      {
        ...this.options,
        publish: (credentials, assertOwner) =>
          this.manager.store.publishIdentityServiceCredentials((next) => {
            assertOwner?.();
            this.assert(epoch);
            if (
              !next.fleet.enrollment ||
              credentials.client.accountId !==
                next.fleet.enrollment.accountId ||
              credentials.client.profileId !== this.manager.serverId ||
              !same(
                credentials.client.signingKey,
                publicIdentityServiceKey(next.fleet.enrollment.keys.signing),
              ) ||
              !same(
                credentials.client.encryptionKey,
                publicIdentityServiceKey(next.fleet.enrollment.keys.encryption),
              )
            )
              throw new IdentityServiceError(
                "unauthorized",
                "Enrollment response changed the configured account/profile keys",
                401,
              );
            const previous = next.fleet.enrollment.credentials?.client;
            if (previous && previous.id !== credentials.client.id)
              throw new IdentityServiceError(
                "conflict",
                "Enrolled client identity changed; disconnect and explicitly enroll again",
                409,
              );
            next.fleet.enrollment.credentials = credentials;
          }),
        discard: (credentials) =>
          this.manager.store.discardIdentityServiceCredentials(
            epoch,
            credentials.refreshToken,
          ),
        remove: () =>
          this.manager.store.mutate((next) => {
            if (next.fleet.epoch === epoch && next.fleet.enrollment)
              next.fleet.enrollment.credentials = null;
          }),
      },
    );
    if (enrollment.credentials) this.http.restore(enrollment.credentials);
  }
  async configure(value: unknown) {
    const input = z
      .object({ issuer: z.string().max(2048), accountId: z.uuid() })
      .strict()
      .parse(value);
    const issuer = identityServiceOrigin(
        input.issuer,
        this.options.allowInsecureLoopback,
      ),
      current = this.manager.store.read();
    if (current.fleet.enrollment) {
      if (
        current.fleet.enrollment.issuer === issuer &&
        current.fleet.enrollment.accountId === input.accountId
      )
        return;
      throw new IdentityServiceError(
        "conflict",
        "Disconnect existing enrollment before changing issuer/account",
        409,
      );
    }
    const revision = this.manager.store.currentRevision();
    const keys = await this.crypto.run(generateIdentityServiceProfileKeys);
    await this.manager.store.mutate((next) => {
      next.fleet.epoch++;
      next.fleet.enrollment = {
        issuer,
        accountId: input.accountId,
        keys,
        credentials: null,
      };
    }, revision);
    this.connect();
  }
  async login(value: unknown, signal?: AbortSignal) {
    const input = z
      .object({
        username: z.string().max(128),
        password: z.string().max(256),
        displayName: z.string().min(1).max(128),
      })
      .strict()
      .parse(value);
    const { epoch } = this.state();
    const client = await this.http!.basicLogin(
      input.username,
      input.password,
      input.displayName,
      signal,
    );
    this.assert(epoch);
    return client;
  }
  oidcProviders(signal?: AbortSignal) {
    this.state();
    return this.http!.oidcProviders(signal);
  }
  async startOidc(value: unknown, owner: string, signal?: AbortSignal) {
    const input = z
      .object({
        providerId: z.string().min(1).max(64),
        displayName: z.string().min(1).max(128),
      })
      .strict()
      .parse(value);
    const { enrollment, epoch } = this.state(),
      ownerBinding = identityServiceDigest(`${this.manager.serverId}:${owner}`);
    for (const [id, flow] of this.oidcFlows)
      if (flow.pending.expiresAt <= Date.now()) this.oidcFlows.delete(id);
    if (this.oidcFlows.size + this.oidcStarts >= 8)
      throw new IdentityServiceError(
        "capacity",
        "Local OIDC enrollment capacity reached",
        503,
      );
    this.oidcStarts++;
    try {
      const pending = await this.http!.startOidc(
        {
          ...input,
          accountId: enrollment.accountId,
          ownerBinding,
          enrollmentEpoch: epoch,
        },
        signal,
      );
      this.assert(epoch);
      signal?.throwIfAborted();
      this.oidcFlows.set(pending.flowId, {
        pending,
        ownerBinding,
        epoch,
        completing: false,
      });
      return {
        flowId: pending.flowId,
        authorizationUrl: pending.authorizationUrl,
        expiresAt: pending.expiresAt,
        profileId: this.manager.serverId,
        signingFingerprint: await identityServiceThumbprint(
          publicIdentityServiceKey(enrollment.keys.signing),
        ),
      };
    } finally {
      this.oidcStarts--;
    }
  }
  private oidcFlow(id: string, owner: string) {
    const flow = this.oidcFlows.get(z.uuid().parse(id));
    if (
      !flow ||
      flow.ownerBinding !==
        identityServiceDigest(`${this.manager.serverId}:${owner}`) ||
      flow.pending.expiresAt <= Date.now()
    )
      throw new IdentityServiceError(
        "unauthorized",
        "OIDC enrollment belongs to another or expired owner session",
        401,
      );
    this.assert(flow.epoch);
    return flow;
  }
  async oidcStatus(id: string, owner: string, signal?: AbortSignal) {
    const flow = this.oidcFlow(id, owner),
      result = await this.http!.oidcStatus(flow.pending, signal);
    this.oidcFlow(id, owner);
    return result;
  }
  async completeOidc(
    id: string,
    owner: string,
    value: unknown,
    assertOwner: () => void,
    signal?: AbortSignal,
  ) {
    const input = z
      .object({ confirmationCode: z.string().max(128).optional() })
      .strict()
      .parse(value);
    const flow = this.oidcFlow(id, owner);
    if (flow.completing)
      throw new IdentityServiceError(
        "conflict",
        "OIDC enrollment is already completing",
        409,
      );
    flow.completing = true;
    try {
      const client = await this.http!.completeOidc(
        flow.pending,
        flow.ownerBinding,
        flow.epoch,
        input.confirmationCode,
        assertOwner,
        signal,
      );
      this.oidcFlows.delete(id);
      return client;
    } catch (error) {
      if (
        error instanceof IdentityServiceError &&
        ["invalid_confirmation", "not_ready"].includes(error.code)
      )
        flow.completing = false;
      else this.oidcFlows.delete(id);
      throw error;
    }
  }

  request(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
    this.state();
    return this.http!.request(path, method, body, signal);
  }
  async introduce(id: string, signal?: AbortSignal) {
    const { enrollment, epoch } = this.state();
    const result = z
      .object({
        client: enrolledClientSchema,
        attestation: z.string().max(32768),
      })
      .strict()
      .parse(
        await this.request(
          `/clients/${z.uuid().parse(id)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    const client = await this.issuer!.verifyIntroduction(
      result.attestation,
      enrollment.accountId,
      id,
      signal,
    );
    this.assert(epoch);
    if (!same(client, result.client))
      throw new IdentityServiceError(
        "unauthorized",
        "Directory metadata does not match its signed introduction",
        401,
      );
    return client;
  }
  async propose(value: unknown, signal?: AbortSignal) {
    const input = z
      .object({ targetClientId: z.uuid(), policy: accessPolicySchema })
      .strict()
      .parse(value);
    input.policy.operations = peerGrantOperations(input.policy.operations);
    return this.request("/relationships", "POST", input, signal);
  }
  async accept(value: unknown, caller?: AbortSignal) {
    const input = acceptance.parse(value),
      signal = AbortSignal.any([
        ...(caller ? [caller] : []),
        AbortSignal.timeout(10_000),
      ]);
    return identityServiceWait(
      this.preflight.run(async () => {
        const { enrollment, epoch } = this.state(),
          revision = this.manager.store.currentRevision();
        const own = enrollment.credentials?.client;
        if (!own)
          throw new IdentityServiceError(
            "login_required",
            "Enroll this profile first",
            401,
          );
        const r = relationshipSchema.parse(
          await this.request(
            `/relationships/${input.relationshipId}`,
            "GET",
            undefined,
            signal,
          ),
        );
        if (
          r.accountId !== enrollment.accountId ||
          r.targetClientId !== own.id ||
          r.revoked
        )
          throw new IdentityServiceError(
            "unauthorized",
            "Proposal does not target this enrolled client",
            401,
          );
        const policy = {
          ...input.policy,
          operations: peerGrantOperations(input.policy.operations),
        };
        if (
          !narrowerPolicy(policy, r.policy) ||
          policy.expiresAt <= Date.now() ||
          policy.expiresAt > Date.now() + 30 * 86_400_000
        )
          throw new IdentityServiceError(
            "invalid_request",
            "Acceptance must fit the proposal and next 30 days",
          );
        if (
          policy.operations.some(
            (op) => op === "createSession" || op === "sendMessage",
          ) &&
          input.acknowledgeExecutionAuthority !== "server-account"
        )
          throw new IdentityServiceError(
            "invalid_request",
            "Acknowledge server-account execution authority",
          );
        await this.manager.validateProjects(policy.projects, signal);
        const source = await this.introduce(r.sourceClientId, signal),
          target = await this.introduce(own.id, signal);
        if (!same(target, own) || source.profileId === this.manager.serverId)
          throw new IdentityServiceError(
            "unauthorized",
            "Proposal profile bindings changed",
            401,
          );
        const existing = this.manager.store
          .read()
          .incoming.find(
            (p) =>
              p.origin === "fleet" && p.sourceServerId === source.profileId,
          );
        if (existing) {
          if (
            existing.origin !== "fleet" ||
            existing.binding.relationshipId !== r.id ||
            !same(existing.binding.policy, policy)
          )
            throw new IdentityServiceError(
              "conflict",
              "Revoke the previous fleet credential before reissuing it",
              409,
            );
          return this.deliver(existing.id, signal);
        }
        const binding: IdentityServicePeerBinding = {
          issuer: enrollment.issuer,
          accountId: enrollment.accountId,
          source,
          target,
          relationshipId: r.id,
          relationshipGeneration: r.generation,
          policy,
        };
        if (
          this.manager.store.read().incoming.length >= 64 ||
          this.manager.store.read().fleet.outbox.length >= 64
        )
          throw new IdentityServiceError(
            "capacity",
            "Incoming fleet credential/outbox capacity reached",
            503,
          );
        const id = randomUUID(),
          envelopeId = randomUUID(),
          username = `peer-${id}`,
          secret = randomBytes(32).toString("base64url");
        const verifier = await this.crypto.run(() =>
          generateVerifier(username, secret),
        );
        const invitation = invitationSchema.parse({
          version: 1,
          sourceServerId: source.profileId,
          targetServerId: this.manager.serverId,
          credentialId: id,
          generation: 1,
          username,
          secret,
          expiresAt: policy.expiresAt,
        });
        const ciphertext = await this.crypto.run(async () => {
          const signed = await signIdentityServiceJwt(
            enrollment.keys.signing,
            {
              iss: enrollment.issuer,
              aud: `urn:yep-anywhere:client:${source.id}`,
              sub: target.id,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(policy.expiresAt / 1000),
              jti: envelopeId,
              version: 1,
              binding,
              invitation,
              route: input.route,
            },
            "ya-peer-invitation+jwt",
          );
          return new jose.CompactEncrypt(new TextEncoder().encode(signed))
            .setProtectedHeader({
              alg: "ECDH-ES",
              enc: "A256GCM",
              typ: "ya-peer-envelope+jwe",
              kid: source.encryptionJkt,
            })
            .encrypt(
              await importIdentityServiceKey(source.encryptionKey, "ECDH-ES"),
            );
        });
        signal.throwIfAborted();
        this.assert(epoch);
        if (Buffer.byteLength(ciphertext) > 32 * 1024)
          throw new IdentityServiceError(
            "invalid_request",
            "Encoded invitation exceeds 32 KiB; narrow its policy",
          );
        const record: StoredIncomingPeer = {
          origin: "fleet",
          binding,
          id,
          sourceServerId: source.profileId,
          generation: 1,
          username,
          ...verifier,
          tokenHash: hashPeerToken(secret),
          projects: policy.projects,
          operations: policy.operations,
          expiresAt: policy.expiresAt,
        };
        await this.manager.store.mutate((next) => {
          this.assert(epoch);
          signal.throwIfAborted();
          if (next.incoming.length >= 64 || next.fleet.outbox.length >= 64)
            throw new IdentityServiceError(
              "capacity",
              "Incoming fleet credential/outbox capacity reached",
              503,
            );
          next.incoming.push(record);
          next.fleet.outbox.push({
            envelopeId,
            credentialId: id,
            credentialGeneration: 1,
            binding,
            ciphertext,
          });
        }, revision);
        return this.deliver(id, signal);
      }),
      signal,
    );
  }
  async deliver(credentialId: string, signal?: AbortSignal) {
    const { state, epoch } = this.state(),
      item = state.fleet.outbox.find(
        (outbox) => outbox.credentialId === credentialId,
      );
    if (!item) return { credentialId, delivery: "already-imported" };
    await this.request(
      `/relationships/${item.binding.relationshipId}/envelope`,
      "PUT",
      {
        envelopeId: item.envelopeId,
        credentialId: item.credentialId,
        credentialGeneration: item.credentialGeneration,
        policy: item.binding.policy,
        ciphertext: item.ciphertext,
      },
      signal,
    );
    this.assert(epoch);
    if (
      !this.manager.store
        .read()
        .incoming.some(
          (p) =>
            p.id === item.credentialId &&
            p.generation === item.credentialGeneration,
        )
    )
      throw new IdentityServiceError(
        "conflict",
        "Credential was revoked during delivery",
        409,
      );
    return { credentialId, envelopeId: item.envelopeId, delivery: "published" };
  }
  async adopt(value: unknown, caller?: AbortSignal) {
    const input = z
      .object({
        envelopeId: z.uuid(),
        allowAgentSessions: z.boolean().default(false),
      })
      .strict()
      .parse(value);
    const signal = AbortSignal.any([
      ...(caller ? [caller] : []),
      AbortSignal.timeout(10_000),
    ]);
    return identityServiceWait(
      this.preflight.run(async () => {
        const { enrollment, epoch } = this.state(),
          revision = this.manager.store.currentRevision(),
          own = enrollment.credentials?.client;
        if (!own)
          throw new IdentityServiceError(
            "login_required",
            "Enroll this profile first",
            401,
          );
        const imported = this.manager.store
          .read()
          .outgoing.find(
            (p) => p.origin === "fleet" && p.envelopeId === input.envelopeId,
          );
        if (imported && imported.origin === "fleet") {
          const current = relationshipSchema.parse(
            await this.request(
              `/relationships/${imported.binding.relationshipId}`,
              "GET",
              undefined,
              signal,
            ),
          );
          if (
            current.accepted?.envelopeId !== imported.envelopeId ||
            current.accepted.digest !== imported.envelopeDigest ||
            current.accepted.credentialId !==
              imported.invitation.credentialId ||
            current.accepted.credentialGeneration !==
              imported.invitation.generation
          )
            throw new IdentityServiceError(
              "conflict",
              "Imported envelope no longer matches its current issuer manifest",
              409,
            );
          return this.acknowledge(
            input.envelopeId,
            imported.invitation.credentialId,
            signal,
          );
        }
        const item = mailboxItemSchema.parse(
          await this.request(
            `/mailbox/${input.envelopeId}`,
            "GET",
            undefined,
            signal,
          ),
        );
        if (Buffer.byteLength(item.ciphertext) > 32 * 1024)
          throw new IdentityServiceError(
            "unauthorized",
            "Encoded invitation exceeds its byte limit",
            401,
          );
        const r = relationshipSchema.parse(
          await this.request(
            `/relationships/${item.relationshipId}`,
            "GET",
            undefined,
            signal,
          ),
        );
        if (
          item.sourceClientId !== own.id ||
          r.sourceClientId !== own.id ||
          r.accountId !== enrollment.accountId ||
          !r.accepted ||
          r.accepted.envelopeId !== item.id ||
          r.accepted.digest !== identityServiceDigest(item.ciphertext)
        )
          throw new IdentityServiceError(
            "unauthorized",
            "Envelope does not match the active accepted proposal",
            401,
          );
        const target = await this.introduce(item.targetClientId, signal);
        const payload = await this.crypto
          .run(async () => {
            const decrypted = await jose.compactDecrypt(
              item.ciphertext,
              await importIdentityServiceKey(
                enrollment.keys.encryption,
                "ECDH-ES",
              ),
              {
                keyManagementAlgorithms: ["ECDH-ES"],
                contentEncryptionAlgorithms: ["A256GCM"],
              },
            );
            if (
              decrypted.protectedHeader.typ !== "ya-peer-envelope+jwe" ||
              decrypted.protectedHeader.kid !== own.encryptionJkt
            )
              throw new IdentityServiceError(
                "unauthorized",
                "Envelope encryption key binding is invalid",
                401,
              );
            const verified = await jose.jwtVerify(
              new TextDecoder("utf8", { fatal: true }).decode(
                decrypted.plaintext,
              ),
              await importIdentityServiceKey(target.signingKey),
              {
                algorithms: ["ES256"],
                typ: "ya-peer-invitation+jwt",
                issuer: enrollment.issuer,
                audience: `urn:yep-anywhere:client:${own.id}`,
              },
            );
            return signedInvitation.parse(verified.payload);
          })
          .catch((error) => {
            if (error instanceof IdentityServiceError) throw error;
            throw new IdentityServiceError(
              "unauthorized",
              "Invitation decryption or target signature validation failed",
              401,
            );
          });
        const { binding, invitation, route } = payload;
        if (
          payload.jti !== item.id ||
          payload.sub !== target.id ||
          !same(binding.source, own) ||
          !same(binding.target, target) ||
          binding.accountId !== enrollment.accountId ||
          binding.issuer !== enrollment.issuer ||
          binding.relationshipId !== r.id ||
          binding.relationshipGeneration !== r.generation ||
          !same(binding.policy, r.accepted.policy) ||
          invitation.credentialId !== r.accepted.credentialId ||
          invitation.generation !== r.accepted.credentialGeneration ||
          invitation.sourceServerId !== this.manager.serverId ||
          invitation.targetServerId !== target.profileId ||
          invitation.expiresAt !== binding.policy.expiresAt ||
          payload.exp * 1000 > invitation.expiresAt ||
          payload.exp * 1000 <= Date.now() ||
          payload.iat * 1000 > Date.now() + 5000
        )
          throw new IdentityServiceError(
            "unauthorized",
            "Signed invitation does not match pinned clients, credentials and policy",
            401,
          );
        const record: Extract<StoredOutgoingPeer, { origin: "fleet" }> = {
          origin: "fleet",
          binding,
          invitation,
          route,
          envelopeId: item.id,
          envelopeDigest: identityServiceDigest(item.ciphertext),
          operations: binding.policy.operations,
          allowAgentSessions: input.allowAgentSessions,
        };
        const access = accessSchema.parse(
          await this.manager
            .protectedTransport(record)
            .request(
              "access",
              { serverId: target.profileId, signal },
              { sessionId: null, launchId: null },
            ),
        );
        if (
          access.principal.kind !== "peer" ||
          access.principal.serverId !== this.manager.serverId
        )
          throw new IdentityServiceError(
            "unauthorized",
            "Protected peer preflight did not identify this source",
            401,
          );
        this.assert(epoch);
        signal.throwIfAborted();
        await this.manager.store.mutate((next) => {
          this.assert(epoch);
          signal.throwIfAborted();
          if (
            next.outgoing.some(
              (p) =>
                p.origin === "fleet" &&
                p.invitation.targetServerId === target.profileId,
            )
          )
            throw new IdentityServiceError(
              "conflict",
              "Revoke previous outgoing fleet access before importing a different envelope",
              409,
            );
          if (
            next.outgoing.length >= 128 ||
            (!next.outgoing.some(
              (p) => p.invitation.targetServerId === target.profileId,
            ) &&
              new Set(next.outgoing.map((p) => p.invitation.targetServerId))
                .size >= 64)
          )
            throw new IdentityServiceError(
              "capacity",
              "Outgoing fleet credential/topology capacity reached",
              503,
            );
          next.outgoing.push(record);
        }, revision);
        return this.acknowledge(item.id, invitation.credentialId, signal);
      }),
      signal,
    );
  }
  private async acknowledge(
    envelopeId: string,
    credentialId: string,
    signal?: AbortSignal,
  ) {
    let acknowledged = false;
    try {
      await this.request(
        `/mailbox/${envelopeId}/ack`,
        "POST",
        undefined,
        signal,
      );
      acknowledged = true;
    } catch {
      /* Durable import survives a lost acknowledgement. */
    }
    this.state();
    if (
      !this.manager.store
        .read()
        .outgoing.some(
          (p) =>
            p.origin === "fleet" &&
            p.envelopeId === envelopeId &&
            p.invitation.credentialId === credentialId,
        )
    )
      throw new IdentityServiceError(
        "conflict",
        "Imported credential was removed during acknowledgement",
        409,
      );
    return { credentialId, imported: true, acknowledged };
  }

  transport(peer: Extract<StoredOutgoingPeer, { origin: "fleet" }>) {
    const epoch = this.state().epoch;
    return {
      assertActive: () => {
        try {
          this.assert(epoch);
        } catch (error) {
          unavailable(error);
        }
      },
      token: async (signal: AbortSignal) => {
        try {
          this.assert(epoch);
          const liveRelationships = new Set(
            this.manager.store
              .read()
              .outgoing.filter((p) => p.origin === "fleet")
              .map((p) =>
                p.origin === "fleet" ? p.binding.relationshipId : "",
              ),
          );
          for (const id of this.tokenCache.keys())
            if (
              id !== peer.binding.relationshipId &&
              !liveRelationships.has(id)
            )
              this.tokenCache.delete(id);
          const cached = this.tokenCache.get(peer.binding.relationshipId);
          if (cached && cached.expiresAt > Date.now() + 15_000) return cached;
          const result = z
            .object({ token: z.string().max(32768), expiresAt: z.number() })
            .strict()
            .parse(
              await this.request(
                `/relationships/${peer.binding.relationshipId}/token`,
                "POST",
                undefined,
                signal,
              ),
            );
          const claims = await this.issuer!.verifyPeer(
            result.token,
            peer.invitation.targetServerId,
            signal,
          );
          if (
            claims.ya.credentialId !== peer.invitation.credentialId ||
            claims.ya.credentialGeneration !== peer.invitation.generation ||
            claims.ya.relationshipId !== peer.binding.relationshipId ||
            claims.ya.sourceClientId !== peer.binding.source.id ||
            claims.ya.targetClientId !== peer.binding.target.id ||
            result.expiresAt !== claims.exp * 1000
          )
            throw new IdentityServiceError(
              "unauthorized",
              "Issuer token changed peer credential bindings",
              401,
            );
          this.assert(epoch);
          if (
            this.tokenCache.size >= 64 &&
            !this.tokenCache.has(peer.binding.relationshipId)
          )
            throw new IdentityServiceError(
              "capacity",
              "Fleet peer token capacity reached",
              503,
            );
          this.tokenCache.set(peer.binding.relationshipId, result);
          return result;
        } catch (error) {
          return unavailable(error);
        }
      },
    };
  }
  async authority(
    grant: IncomingPeerGrant,
    token: string,
    signal: AbortSignal,
  ): Promise<PeerRequestAuthority> {
    try {
      const { enrollment, epoch } = this.state(),
        binding = grant.identityBinding;
      if (
        !binding ||
        binding.issuer !== enrollment.issuer ||
        binding.accountId !== enrollment.accountId
      )
        throw new IdentityServiceError(
          "unauthorized",
          "Issuer/account is not trusted for this peer",
          401,
        );
      const claims = await this.issuer!.verifyPeer(
          token,
          this.manager.serverId,
          signal,
        ),
        ya = claims.ya;
      if (
        claims.sub !== binding.source.id ||
        ya.accountId !== binding.accountId ||
        ya.sourceClientId !== binding.source.id ||
        ya.targetClientId !== binding.target.id ||
        ya.sourceProfileId !== binding.source.profileId ||
        ya.targetProfileId !== this.manager.serverId ||
        ya.sourceSigningJkt !== binding.source.signingJkt ||
        ya.sourceEncryptionJkt !== binding.source.encryptionJkt ||
        ya.relationshipId !== binding.relationshipId ||
        ya.relationshipGeneration !== binding.relationshipGeneration ||
        ya.credentialId !== grant.id ||
        ya.credentialGeneration !== grant.generation ||
        !narrowerPolicy(ya.policy, binding.policy) ||
        claims.exp * 1000 >
          Math.min(
            grant.expiresAt,
            binding.policy.expiresAt,
            ya.policy.expiresAt,
          )
      )
        throw new IdentityServiceError(
          "unauthorized",
          "Fleet token does not match the target's current acceptance",
          401,
        );
      this.assert(epoch);
      return {
        grant,
        projects: ya.policy.projects,
        operations: ya.policy.operations,
        expiresAt: claims.exp * 1000,
        assertActive: () => {
          try {
            this.assert(epoch);
            if (claims.exp * 1000 <= Date.now())
              throw new IdentityServiceError(
                "unauthorized",
                "Fleet authority expired",
                401,
              );
          } catch (error) {
            unavailable(error);
          }
        },
      };
    } catch (error) {
      return unavailable(error);
    }
  }
  select(targetId: string, credentialId: string) {
    z.uuid().parse(targetId);
    z.uuid().parse(credentialId);
    return this.manager.store.mutate((next) => {
      if (
        !next.outgoing.some(
          (p) =>
            p.invitation.targetServerId === targetId &&
            p.invitation.credentialId === credentialId,
        )
      )
        throw new IdentityServiceError(
          "not_found",
          "Outgoing credential not found",
          404,
        );
      next.selected[targetId] = credentialId;
    });
  }
  removeOutgoing(targetId: string, credentialId: string) {
    z.uuid().parse(targetId);
    z.uuid().parse(credentialId);
    return this.manager.store.mutate((next) => {
      next.outgoing = next.outgoing.filter(
        (p) =>
          p.invitation.targetServerId !== targetId ||
          p.invitation.credentialId !== credentialId,
      );
      if (next.selected[targetId] === credentialId)
        delete next.selected[targetId];
    });
  }
  async revokeRelationship(id: string, signal?: AbortSignal) {
    z.uuid().parse(id);
    this.tokenCache.delete(id);
    await this.manager.store.mutate((next) => {
      next.incoming = next.incoming.filter(
        (p) => p.origin !== "fleet" || p.binding.relationshipId !== id,
      );
      next.outgoing = next.outgoing.filter(
        (p) => p.origin !== "fleet" || p.binding.relationshipId !== id,
      );
      next.fleet.outbox = next.fleet.outbox.filter(
        (item) => item.binding.relationshipId !== id,
      );
      for (const [target, selected] of Object.entries(next.selected))
        if (
          !next.outgoing.some(
            (p) =>
              p.invitation.targetServerId === target &&
              p.invitation.credentialId === selected,
          )
        )
          delete next.selected[target];
    });
    try {
      await this.request(`/relationships/${id}`, "DELETE", undefined, signal);
      return { localRemoved: true, remoteRevocation: "confirmed" };
    } catch {
      return { localRemoved: true, remoteRevocation: "unconfirmed" };
    }
  }
  async disconnect() {
    this.oidcFlows.clear();
    const before = this.manager.store.read().fleet.enrollment,
      oldHttp = this.http;
    let remote: IdentityServiceClient | undefined;
    if (before?.credentials) {
      remote = new IdentityServiceClient(
        before.issuer,
        this.manager.serverId,
        before.keys,
        this.options,
      );
      remote.restore(before.credentials);
    }
    this.retiring = true;
    this.issuer?.distrust();
    this.tokenCache.clear();
    const drained = oldHttp?.disconnect();
    await this.manager.store.mutate((next) => {
      next.fleet = {
        epoch: next.fleet.epoch + 1,
        enrollment: null,
        outbox: [],
      };
      next.incoming = next.incoming.filter((p) => p.origin === "manual");
      next.outgoing = next.outgoing.filter((p) => p.origin === "manual");
      for (const [target, id] of Object.entries(next.selected))
        if (
          !next.outgoing.some(
            (p) =>
              p.invitation.targetServerId === target &&
              p.invitation.credentialId === id,
          )
        )
          delete next.selected[target];
    });
    await drained;
    this.http = undefined;
    this.issuer = undefined;
    this.retiring = false;
    try {
      if (remote && before?.credentials)
        await remote.request(
          `/clients/${before.credentials.client.id}`,
          "DELETE",
        );
      return {
        localRemoved: true,
        remoteRevocation: remote ? "confirmed" : "not-enrolled",
      };
    } catch {
      return { localRemoved: true, remoteRevocation: "unconfirmed" };
    }
  }
  async close() {
    this.oidcFlows.clear();
    this.retiring = true;
    this.issuer?.distrust();
    this.tokenCache.clear();
    await this.http?.close(); /* Preserve durable enrollment on ordinary shutdown. */
  }
}
