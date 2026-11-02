import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import * as jose from "jose";
import * as oauth from "oauth4webapi";
import {
  clientIntroductionSchema,
  controlClaimsSchema,
  type ClientIntroduction,
  type EnrolledClient,
  type IdentityAccount,
  type IdentityServiceControlClaims,
  type IdentityServicePurpose,
  type IdentityServiceSession,
} from "./contracts.js";
import {
  controlPayload,
  identityServiceControlAudience,
  identityServiceDigest,
  identityServiceThumbprint,
  publicIdentityServiceKey,
  signIdentityServiceJwt,
} from "./crypto.js";
import { IdentityServiceError } from "./errors.js";
import { IdentityServiceLimiter, IdentityServiceWorkBudget } from "./limits.js";
import {
  type IdentityServiceStore,
  identityServiceUsername,
  pruneRetiredIdentityServiceClients,
} from "./store.js";

interface PendingLogin {
  id: string;
  accountId: string;
  authGeneration: number;
  enrollmentGeneration: number;
  introduction: ClientIntroduction;
  signingJkt: string;
  encryptionJkt: string;
  expiresAt: number;
  familyMs: number;
  familyDeadline?: number;
  clientIdAtLogin: string | null;
}
export interface IdentityServiceCredentials {
  client: EnrolledClient;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  familyExpiresAt: number;
}
export class IdentityServiceNonceChallenge extends IdentityServiceError {
  constructor(readonly nonce: string) {
    super("use_dpop_nonce", "A fresh DPoP nonce is required", 401);
  }
}
const DAY = 86_400_000;
// Unknown names still perform a maintained bcrypt comparison.
const DUMMY_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/** Passwords establish pending authority; only a key proof publishes membership. */
export class IdentityServiceAuth {
  readonly crypto = new IdentityServiceWorkBudget(8);
  private readonly bcrypt = new IdentityServiceWorkBudget(4);
  private readonly logins = new Map<string, PendingLogin>();
  private readonly nonces = new Map<
    string,
    { key: string; token: string; expiresAt: number }
  >();
  private readonly loginRate = new IdentityServiceLimiter(64, 8, 6, 3);
  private readonly nonceRate = new IdentityServiceLimiter(256, 32, 60, 8);
  constructor(
    readonly store: IdentityServiceStore,
    readonly now = Date.now,
  ) {}
  async jwks() {
    const state = this.store.read();
    const keys = [
      publicIdentityServiceKey(state.signingKey),
      ...state.previousSigningKeys,
    ];
    return {
      keys: await Promise.all(
        keys.map(async (key) => ({
          ...key,
          alg: "ES256",
          use: "sig",
          kid: await identityServiceThumbprint(key),
        })),
      ),
    };
  }
  async login(usernameValue: string, password: string, value: unknown) {
    const username = identityServiceUsername(usernameValue);
    this.loginRate.admit(username);
    if (Buffer.byteLength(password) > 72 || [...password].length < 12)
      throw new IdentityServiceError(
        "unauthorized",
        "Invalid local account credentials",
        401,
      );
    const introduction = clientIntroductionSchema.parse(value);
    const account = this.store
      .read()
      .accounts.find((a) => a.kind === "local" && a.username === username);
    const ok = await this.bcrypt.run(() =>
      bcrypt.compare(
        password,
        account?.kind === "local" ? account.passwordHash : DUMMY_HASH,
      ),
    );
    if (
      !ok ||
      !account ||
      !this.store
        .read()
        .accounts.some(
          (a) =>
            a.id === account.id && a.authGeneration === account.authGeneration,
        )
    )
      throw new IdentityServiceError(
        "unauthorized",
        "Invalid local account credentials",
        401,
      );
    return this.pending(
      account,
      introduction,
      30 * DAY,
      this.store
        .read()
        .clients.find(
          (c) =>
            c.accountId === account.id &&
            c.profileId === introduction.profileId &&
            !c.revoked,
        )?.id ?? null,
    );
  }
  async pending(
    account: IdentityAccount,
    introduction: ClientIntroduction,
    familyMs: number,
    clientIdAtLogin = this.store
      .read()
      .clients.find(
        (c) =>
          c.accountId === account.id &&
          c.profileId === introduction.profileId &&
          !c.revoked,
      )?.id ?? null,
    familyDeadline?: number,
  ) {
    return this.crypto.run(() =>
      this.preparePending(
        account,
        introduction,
        familyMs,
        clientIdAtLogin,
        familyDeadline,
      ),
    );
  }
  private async preparePending(
    account: IdentityAccount,
    introduction: ClientIntroduction,
    familyMs: number,
    clientIdAtLogin: string | null,
    familyDeadline?: number,
  ) {
    for (const [id, item] of this.logins)
      if (item.expiresAt <= this.now()) this.logins.delete(id);
    if (this.logins.size >= 128)
      throw new IdentityServiceError(
        "capacity",
        "Pending enrollment capacity reached",
        503,
      );
    const item: PendingLogin = {
      clientIdAtLogin,
      familyDeadline,
      id: randomUUID(),
      accountId: account.id,
      authGeneration: account.authGeneration,
      enrollmentGeneration: account.enrollmentGeneration,
      introduction,
      signingJkt: await identityServiceThumbprint(introduction.signingKey),
      encryptionJkt: await identityServiceThumbprint(
        introduction.encryptionKey,
      ),
      expiresAt: this.now() + 90_000,
      familyMs,
    };
    // Validate both curve points before introducing a persistent binding.
    await Promise.all([
      jose.importJWK(introduction.signingKey, "ES256"),
      jose.importJWK(introduction.encryptionKey, "ECDH-ES"),
    ]);
    if (item.signingJkt === item.encryptionJkt)
      throw new IdentityServiceError(
        "invalid_key",
        "Use separate signing and encryption keys",
      );
    if (this.logins.size >= 128)
      throw new IdentityServiceError(
        "capacity",
        "Pending enrollment capacity reached",
        503,
      );
    this.logins.set(item.id, item);
    try {
      const token = await signIdentityServiceJwt(
        this.store.read().signingKey,
        controlPayload(
          {
            iss: this.store.issuer,
            sub: item.accountId,
            client_id: item.id,
            purpose: "enroll",
            profileId: introduction.profileId,
            bindingId: item.id,
            authGeneration: item.authGeneration,
            cnf: { jkt: item.signingJkt },
            exp: Math.floor(item.expiresAt / 1000),
          },
          this.now(),
        ),
        "at+jwt",
      );
      return { token, expiresAt: item.expiresAt };
    } catch (error) {
      this.logins.delete(item.id);
      throw error;
    }
  }
  assert(
    claims: IdentityServiceControlClaims,
    purpose: IdentityServicePurpose,
    token?: string,
  ) {
    if (
      claims.purpose !== purpose ||
      claims.iss !== this.store.issuer ||
      claims.aud !== identityServiceControlAudience(this.store.issuer) ||
      claims.exp * 1000 <= this.now() ||
      claims.iat * 1000 > this.now() + 5000
    )
      throw new IdentityServiceError(
        "unauthorized",
        "Fleet token purpose or lifetime is invalid",
        401,
      );
    const state = this.store.read();
    const account = state.accounts.find(
      (a) => a.id === claims.sub && a.authGeneration === claims.authGeneration,
    );
    if (purpose === "enroll") {
      const pending = this.logins.get(claims.bindingId);
      if (
        !account ||
        !pending ||
        pending.id !== claims.client_id ||
        pending.accountId !== account.id ||
        pending.authGeneration !== account.authGeneration ||
        pending.enrollmentGeneration !== account.enrollmentGeneration ||
        pending.introduction.profileId !== claims.profileId ||
        pending.signingJkt !== claims.cnf.jkt ||
        (state.clients.find(
          (c) =>
            c.accountId === account.id &&
            c.profileId === claims.profileId &&
            !c.revoked,
        )?.id ?? null) !== pending.clientIdAtLogin ||
        pending.expiresAt <= this.now()
      )
        throw new IdentityServiceError(
          "unauthorized",
          "Enrollment is no longer current",
          401,
        );
      return { account, pending };
    }
    const session = state.sessions.find(
      (s) =>
        s.id === claims.bindingId &&
        s.accountId === claims.sub &&
        s.clientId === claims.client_id &&
        s.authGeneration === claims.authGeneration &&
        s.expiresAt > this.now(),
    );
    const client = state.clients.find(
      (c) =>
        c.id === claims.client_id &&
        c.accountId === claims.sub &&
        c.profileId === claims.profileId &&
        c.signingJkt === claims.cnf.jkt &&
        !c.revoked,
    );
    if (
      !account ||
      !session ||
      !client ||
      (purpose === "refresh" &&
        (!token || identityServiceDigest(token) !== session.refreshHash))
    )
      throw new IdentityServiceError(
        "unauthorized",
        "Fleet session is no longer current",
        401,
      );
    return { account, session, client };
  }
  async authorize(
    request: Request,
    purpose: IdentityServicePurpose,
    pendingAuthority?: (claims: IdentityServiceControlClaims) => void,
  ) {
    this.store.read();
    let claims: IdentityServiceControlClaims;
    try {
      claims = controlClaimsSchema.parse(
        await this.crypto.run(() =>
          oauth.validateJwtAccessToken(
            {
              issuer: this.store.issuer,
              jwks_uri: `${this.store.issuer}/fleet/v0/jwks`,
            },
            request,
            identityServiceControlAudience(this.store.issuer),
            {
              requireDPoP: true,
              signingAlgorithms: ["ES256"],
              [oauth.clockTolerance]: 5,
              [oauth.clockSkew]: (this.now() - Date.now()) / 1000,
              [oauth.allowInsecureRequests]: this.store.allowInsecureLoopback,
              [oauth.customFetch]: async () => Response.json(await this.jwks()),
            },
          ),
        ),
      );
    } catch (error) {
      this.store.read();
      if (error instanceof IdentityServiceError) throw error;
      throw new IdentityServiceError(
        "unauthorized",
        "Invalid fleet token or key proof",
        401,
      );
    }
    const token = request.headers.get("authorization")?.slice(5);
    if (purpose === "oidc" && pendingAuthority) pendingAuthority(claims);
    else this.assert(claims, purpose, token);
    // Library verified this exact proof's signature, token hash, method and URI.
    const proof = jose.decodeJwt(request.headers.get("dpop") ?? "");
    if (
      typeof proof.iat !== "number" ||
      proof.iat * 1000 < this.now() - 60_000 ||
      proof.iat * 1000 > this.now() + 5000
    )
      throw new IdentityServiceError(
        "unauthorized",
        "DPoP proof is stale",
        401,
      );
    for (const [id, nonce] of this.nonces)
      if (nonce.expiresAt <= this.now()) this.nonces.delete(id);
    const nonce =
      typeof proof.nonce === "string"
        ? this.nonces.get(proof.nonce)
        : undefined;
    const identity = identityServiceDigest(token ?? "");
    if (!nonce || nonce.key !== claims.cnf.jkt || nonce.token !== identity) {
      this.nonceRate.admit(claims.cnf.jkt);
      if (
        this.nonces.size >= 256 ||
        [...this.nonces.values()].filter((n) => n.token === identity).length >=
          8
      )
        throw new IdentityServiceError(
          "capacity",
          "DPoP nonce capacity reached",
          503,
        );
      const value = randomBytes(32).toString("base64url");
      this.nonces.set(value, {
        key: claims.cnf.jkt,
        token: identity,
        expiresAt: this.now() + 60_000,
      });
      throw new IdentityServiceNonceChallenge(value);
    }
    this.nonces.delete(proof.nonce as string);
    // Supply the next single-use nonce on an authenticated reply. A serial
    // client need not provoke a challenge (or spend its challenge rate budget)
    // for every resource it reads.
    const nextNonce = randomBytes(32).toString("base64url");
    this.nonces.set(nextNonce, {
      key: claims.cnf.jkt,
      token: identity,
      expiresAt: this.now() + 60_000,
    });
    return { claims, token: token ?? "", nextNonce };
  }
  private async credentials(
    client: EnrolledClient,
    account: IdentityAccount,
    session: IdentityServiceSession,
  ) {
    const payload = {
      iss: this.store.issuer,
      sub: account.id,
      client_id: client.id,
      profileId: client.profileId,
      bindingId: session.id,
      authGeneration: account.authGeneration,
      cnf: { jkt: client.signingJkt },
    };
    const expiresAt = Math.min(this.now() + 300_000, session.expiresAt);
    const [accessToken, refreshToken] = await this.crypto.run(() =>
      Promise.all([
        signIdentityServiceJwt(
          this.store.read().signingKey,
          controlPayload(
            {
              ...payload,
              purpose: "control",
              exp: Math.floor(expiresAt / 1000),
            },
            this.now(),
          ),
          "at+jwt",
        ),
        signIdentityServiceJwt(
          this.store.read().signingKey,
          controlPayload(
            {
              ...payload,
              purpose: "refresh",
              exp: Math.floor(session.expiresAt / 1000),
            },
            this.now(),
          ),
          "at+jwt",
        ),
      ]),
    );
    return {
      client,
      accessToken,
      refreshToken,
      expiresAt,
      familyExpiresAt: session.expiresAt,
    };
  }
  async enroll(
    claims: IdentityServiceControlClaims,
    signal: AbortSignal,
  ): Promise<IdentityServiceCredentials> {
    const { account, pending } = this.assert(claims, "enroll");
    if (!pending)
      throw new IdentityServiceError("unauthorized", "Missing enrollment", 401);
    const existing = this.store
      .read()
      .clients.find(
        (c) =>
          c.accountId === account.id &&
          c.profileId === pending.introduction.profileId &&
          !c.revoked,
      );
    if (
      existing &&
      (existing.revoked ||
        existing.signingJkt !== pending.signingJkt ||
        existing.encryptionJkt !== pending.encryptionJkt)
    )
      throw new IdentityServiceError(
        "conflict",
        "Profile is already pinned to another or revoked client; explicitly recover it",
        409,
      );
    const client: EnrolledClient = existing ?? {
      ...pending.introduction,
      id: randomUUID(),
      accountId: account.id,
      generation: 1,
      createdAt: this.now(),
      revoked: false,
      signingJkt: pending.signingJkt,
      encryptionJkt: pending.encryptionJkt,
    };
    const session: IdentityServiceSession = {
      id: randomUUID(),
      accountId: account.id,
      clientId: client.id,
      authGeneration: account.authGeneration,
      createdAt: this.now(),
      expiresAt: Math.min(
        this.now() + pending.familyMs,
        pending.familyDeadline ?? Infinity,
      ),
      refreshHash: "0".repeat(64),
    };
    const credentials = await this.credentials(client, account, session);
    session.refreshHash = identityServiceDigest(credentials.refreshToken);
    await this.store.mutate((state) => {
      this.assert(claims, "enroll");
      pruneRetiredIdentityServiceClients(state);
      if (!existing && state.clients.length >= 256)
        throw new IdentityServiceError(
          "capacity",
          "Active fleet client capacity reached",
          503,
        );
      if (
        !existing &&
        state.clients.some(
          (c) =>
            c.accountId === account.id &&
            c.profileId === client.profileId &&
            !c.revoked,
        )
      )
        throw new IdentityServiceError(
          "conflict",
          "Concurrent enrollment changed this profile",
          409,
        );
      this.logins.delete(pending.id);
      if (!existing) state.clients.push(client);
      state.sessions = [
        ...state.sessions.filter(
          (s) => s.clientId !== client.id && s.expiresAt > this.now(),
        ),
        session,
      ];
    }, signal);
    return credentials;
  }
  async refresh(
    claims: IdentityServiceControlClaims,
    token: string,
    signal: AbortSignal,
  ) {
    const { account, session, client } = this.assert(claims, "refresh", token);
    if (!session || !client)
      throw new IdentityServiceError("unauthorized", "Missing session", 401);
    const credentials = await this.credentials(client, account, session);
    await this.store.mutate((state) => {
      this.assert(claims, "refresh", token);
      const current = state.sessions.find((s) => s.id === session.id)!;
      current.refreshHash = identityServiceDigest(credentials.refreshToken);
    }, signal);
    return credentials;
  }
}
