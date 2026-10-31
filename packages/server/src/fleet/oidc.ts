import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import * as oidc from "openid-client";
import { z } from "zod";
import {
  clientIntroductionSchema,
  type ClientIntroduction,
  type FleetControlClaims,
} from "./contracts.js";
import {
  controlPayload,
  fleetThumbprint,
  signFleetJwt,
  fleetDigest,
} from "./crypto.js";
import { FleetError } from "./errors.js";
import { FleetLimiter, fleetJson, fleetWait } from "./limits.js";
import type { FleetAuth } from "./auth.js";

export const fleetOidcProvidersSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        displayName: z.string().min(1).max(128),
        issuer: z.string().url().max(2048),
        clientId: z.string().min(1).max(256),
        clientSecret: z.string().min(1).max(4096),
        tokenEndpointAuthMethod: z
          .enum(["client_secret_basic", "client_secret_post"])
          .default("client_secret_basic"),
        idTokenSigningAlgorithm: z.enum(["RS256", "ES256"]).default("RS256"),
      })
      .strict(),
  )
  .max(4)
  .refine(
    (providers) =>
      new Set(providers.map((p) => p.id)).size === providers.length,
    "Duplicate provider identity",
  );
export type FleetOidcProvider = z.infer<
  typeof fleetOidcProvidersSchema
>[number];
export const fleetOidcStartSchema = z
  .object({
    providerId: z.string().max(64),
    accountId: z.uuid(),
    introduction: clientIntroductionSchema,
    ownerBinding: z.string().regex(/^[0-9a-f]{64}$/),
    enrollmentEpoch: z.number().int().nonnegative(),
  })
  .strict();
interface Flow {
  id: string;
  provider: FleetOidcProvider;
  accountId: string;
  authGeneration: number;
  enrollmentGeneration: number;
  introduction: ClientIntroduction;
  signingJkt: string;
  ownerBinding: string;
  enrollmentEpoch: number;
  expiresAt: number;
  state: string;
  nonce: string;
  verifier: string;
  callbackUsed: boolean;
  redeemed: boolean;
  status: "pending" | "ready" | "failed";
  familyDeadline?: number;
  confirmationHash?: string;
  incorrectConfirmations: number;
}

/** Auth-code/PKCE is upstream; this adapter only selects provisioned accounts. */
export class FleetOidc {
  private readonly providers: FleetOidcProvider[];
  /** Fixed configured-provider key space, at most four entries. */
  private readonly configurations = new Map<
    string,
    Promise<oidc.Configuration>
  >();
  /** At most 64 five-minute flows; pruned on admission or consumed once. */
  private readonly flows = new Map<string, Flow>();
  private readonly starts = new FleetLimiter(64, 8, 8, 4);
  constructor(
    readonly auth: FleetAuth,
    values: unknown = [],
    private readonly options: {
      fetch?: typeof fetch;
      remoteAddress?: (context: Context) => string | undefined;
    } = {},
  ) {
    this.providers = fleetOidcProvidersSchema.parse(values);
    for (const provider of this.providers) {
      const url = new URL(provider.issuer);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            auth.store.allowInsecureLoopback &&
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          ))
      )
        throw new FleetError(
          "invalid_configuration",
          "OIDC requires an exact configured HTTPS issuer",
        );
    }
  }
  list() {
    return this.providers.map(({ id, displayName, issuer }) => ({
      id,
      displayName,
      issuer,
    }));
  }
  private callbackUrl(provider: FleetOidcProvider) {
    return `${this.auth.store.issuer}/fleet/v0/oidc/callback/${provider.id}`;
  }
  private configuration(provider: FleetOidcProvider) {
    let pending = this.configurations.get(provider.id);
    if (!pending) {
      pending = oidc.discovery(
        new URL(provider.issuer),
        provider.clientId,
        {
          client_secret: provider.clientSecret,
          token_endpoint_auth_method: provider.tokenEndpointAuthMethod,
          id_token_signed_response_alg: provider.idTokenSigningAlgorithm,
        },
        provider.tokenEndpointAuthMethod === "client_secret_basic"
          ? oidc.ClientSecretBasic(provider.clientSecret)
          : oidc.ClientSecretPost(provider.clientSecret),
        {
          timeout: 5,
          execute: this.auth.store.allowInsecureLoopback
            ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
            : [oidc.enableNonRepudiationChecks],
          [oidc.customFetch]: async (url, init) => {
            const signal = AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(5000),
            ]);
            const response = await fleetWait(
              (this.options.fetch ?? fetch)(url, {
                ...init,
                body:
                  init.body instanceof Uint8Array
                    ? new Uint8Array(init.body)
                    : init.body,
                redirect: "error",
                signal,
              }),
              signal,
            );
            const reader = response.body?.getReader(),
              chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              if (reader)
                for (;;) {
                  const { value, done } = await fleetWait(
                    reader.read(),
                    signal,
                  );
                  if (done) break;
                  bytes += value.byteLength;
                  if (bytes > 64 * 1024)
                    throw new FleetError(
                      "issuer_unavailable",
                      "OIDC reply exceeds its byte limit",
                      503,
                    );
                  chunks.push(value);
                }
              return new Response(
                response.status === 204 ? null : Buffer.concat(chunks),
                { status: response.status, headers: response.headers },
              );
            } finally {
              void reader?.cancel().catch(() => {});
              reader?.releaseLock();
            }
          },
        },
      );
      this.configurations.set(provider.id, pending);
      void pending.catch(() => {
        if (this.configurations.get(provider.id) === pending)
          this.configurations.delete(provider.id);
      });
    }
    return pending;
  }
  private active(flow: Flow) {
    const account = this.auth.store
      .read()
      .accounts.find(
        (a) =>
          a.id === flow.accountId &&
          a.kind === "oidc" &&
          a.issuer === flow.provider.issuer &&
          a.authGeneration === flow.authGeneration &&
          a.enrollmentGeneration === flow.enrollmentGeneration,
      );
    if (
      this.flows.get(flow.id) !== flow ||
      !account ||
      flow.redeemed ||
      flow.expiresAt <= this.auth.now()
    )
      throw new FleetError(
        "unauthorized",
        "OIDC enrollment is no longer current",
        401,
      );
    return account;
  }
  assert = (claims: FleetControlClaims) => {
    const flow = this.flows.get(claims.bindingId);
    if (
      !flow ||
      claims.purpose !== "oidc" ||
      claims.sub !== flow.id ||
      claims.client_id !== flow.id ||
      claims.profileId !== flow.introduction.profileId ||
      claims.cnf.jkt !== flow.signingJkt ||
      claims.exp * 1000 > flow.expiresAt ||
      claims.exp * 1000 <= this.auth.now() ||
      claims.iat * 1000 > this.auth.now() + 5000 ||
      claims.authGeneration !== undefined
    )
      throw new FleetError(
        "unauthorized",
        "OIDC redemption proof has the wrong flow/profile/key binding",
        401,
      );
    this.active(flow);
  };
  async start(c: Context, signal: AbortSignal) {
    this.starts.admit(this.options.remoteAddress?.(c) ?? "unknown");
    const input = fleetOidcStartSchema.parse(
      await fleetJson(c.req.raw, signal),
    );
    const provider = this.providers.find((p) => p.id === input.providerId);
    const account = this.auth.store
      .read()
      .accounts.find(
        (a) =>
          a.id === input.accountId &&
          a.kind === "oidc" &&
          a.issuer === provider?.issuer,
      );
    if (!provider || !account)
      throw new FleetError(
        "invalid_request",
        "This provider/account is not configured",
      );
    for (const [id, flow] of this.flows)
      if (flow.expiresAt <= this.auth.now() || flow.redeemed)
        this.flows.delete(id);
    if (this.flows.size >= 64)
      throw new FleetError(
        "capacity",
        "OIDC pending flow capacity reached",
        503,
      );
    const flow: Flow = {
      id: randomUUID(),
      provider,
      accountId: account.id,
      authGeneration: account.authGeneration,
      enrollmentGeneration: account.enrollmentGeneration,
      introduction: input.introduction,
      signingJkt: await fleetThumbprint(input.introduction.signingKey),
      ownerBinding: input.ownerBinding,
      enrollmentEpoch: input.enrollmentEpoch,
      expiresAt: this.auth.now() + 300_000,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
      callbackUsed: false,
      redeemed: false,
      status: "pending",
      incorrectConfirmations: 0,
    };
    if (this.flows.size >= 64)
      throw new FleetError(
        "capacity",
        "OIDC pending flow capacity reached",
        503,
      );
    this.flows.set(flow.id, flow);
    try {
      const config = await this.configuration(provider);
      const authorizationUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: this.callbackUrl(provider),
        scope: "openid profile",
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: "S256",
        response_mode: "query",
      }).href;
      const token = await this.auth.crypto.run(() =>
        signFleetJwt(
          this.auth.store.read().signingKey,
          controlPayload(
            {
              iss: this.auth.store.issuer,
              sub: flow.id,
              client_id: flow.id,
              bindingId: flow.id,
              profileId: flow.introduction.profileId,
              cnf: { jkt: flow.signingJkt },
              purpose: "oidc",
              exp: Math.floor(flow.expiresAt / 1000),
            },
            this.auth.now(),
          ),
          "at+jwt",
        ),
      );
      signal.throwIfAborted();
      this.active(flow);
      return {
        flowId: flow.id,
        authorizationUrl,
        token,
        expiresAt: flow.expiresAt,
      };
    } catch (error) {
      this.flows.delete(flow.id);
      throw error;
    }
  }
  async callback(providerId: string, url: URL) {
    if (
      (url.searchParams.get("state")?.length ?? 0) > 256 ||
      url.href.length > 8192
    )
      throw new FleetError("invalid_request", "Invalid OIDC callback");
    const flow = [...this.flows.values()].find(
      (f) =>
        f.provider.id === providerId &&
        f.state === url.searchParams.get("state"),
    );
    if (!flow || flow.callbackUsed)
      throw new FleetError(
        "unauthorized",
        "OIDC callback is absent or already consumed",
        401,
      );
    this.active(flow);
    flow.callbackUsed = true;
    try {
      const tokens = await this.auth.crypto.run(async () =>
        oidc.authorizationCodeGrant(
          await this.configuration(flow.provider),
          url,
          {
            expectedState: flow.state,
            expectedNonce: flow.nonce,
            pkceCodeVerifier: flow.verifier,
            idTokenExpected: true,
          },
        ),
      );
      const claims = tokens.claims(),
        account = this.active(flow);
      if (
        !claims ||
        account.kind !== "oidc" ||
        claims.iss !== account.issuer ||
        claims.sub !== account.subject
      )
        throw new FleetError(
          "unauthorized",
          "OIDC identity is not the configured provisioned account",
          401,
        );
      flow.status = "ready";
      flow.familyDeadline = this.auth.now() + 3_600_000;
      const confirmationCode = randomBytes(24).toString("base64url");
      flow.confirmationHash = fleetDigest(confirmationCode);
      return {
        confirmationCode,
        displayName: flow.introduction.displayName,
        profileId: flow.introduction.profileId,
        signingFingerprint: flow.signingJkt,
      };
    } catch (error) {
      flow.status = "failed";
      if (error instanceof FleetError && error.status === 503) throw error;
      throw new FleetError(
        "unauthorized",
        "OIDC login did not establish the configured account",
        401,
      );
    }
  }
  status(claims: FleetControlClaims) {
    this.assert(claims);
    return {
      flowId: claims.bindingId,
      status: this.flows.get(claims.bindingId)!.status,
    };
  }
  async redeem(claims: FleetControlClaims, value: unknown) {
    this.assert(claims);
    const input = z
        .object({
          ownerBinding: z.string(),
          enrollmentEpoch: z.number().int(),
          confirmationCode: z.string().max(128).optional(),
        })
        .strict()
        .parse(value),
      flow = this.flows.get(claims.bindingId)!;
    if (
      input.ownerBinding !== flow.ownerBinding ||
      input.enrollmentEpoch !== flow.enrollmentEpoch ||
      flow.status === "failed"
    )
      throw new FleetError(
        "unauthorized",
        "OIDC flow is not ready for its initiating owner/profile",
        401,
      );
    const account = this.active(flow);
    if (flow.status !== "ready" || !flow.confirmationHash)
      throw new FleetError(
        "not_ready",
        "Complete upstream login before confirming enrollment",
        409,
      );
    const valid =
      typeof input.confirmationCode === "string" &&
      /^[A-Za-z0-9_-]{32}$/.test(input.confirmationCode) &&
      timingSafeEqual(
        Buffer.from(fleetDigest(input.confirmationCode), "hex"),
        Buffer.from(flow.confirmationHash, "hex"),
      );
    if (!valid) {
      flow.incorrectConfirmations++;
      if (flow.incorrectConfirmations >= 5) flow.redeemed = true;
      throw new FleetError(
        "invalid_confirmation",
        "The browser confirmation code is missing or incorrect",
        403,
      );
    }
    flow.redeemed = true;
    flow.confirmationHash = undefined;
    return this.auth.pending(
      account,
      flow.introduction,
      3_600_000,
      undefined,
      flow.familyDeadline,
    );
  }
}
