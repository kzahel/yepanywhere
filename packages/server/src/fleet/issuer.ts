import * as jose from "jose";
import { z } from "zod";
import {
  enrolledClientSchema,
  publicKeySchema,
  type EnrolledClient,
  type PublicKey,
} from "./contracts.js";
import { fleetOrigin, importFleetKey, verifyFleetPeerJwt } from "./crypto.js";
import { FleetError } from "./errors.js";
import { FleetWorkBudget, fleetWait } from "./limits.js";

const signingKey = publicKeySchema
  .extend({
    kid: z.string().min(1).max(128),
    alg: z.literal("ES256"),
    use: z.literal("sig").optional(),
  })
  .strict();
const keySet = z.object({ keys: z.array(signingKey).min(1).max(4) }).strict();
const introduction = z
  .object({
    iss: z.string(),
    aud: z.literal("urn:yep-anywhere:client-introduction"),
    sub: z.uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.uuid(),
    client: enrolledClientSchema,
  })
  .strict();

/** Configured issuer only. No token-supplied URL or background renewal. */
export class FleetIssuer {
  readonly issuer: string;
  private keys?: { loadedAt: number; values: z.infer<typeof keySet>["keys"] };
  private fetching?: Promise<void>;
  private fetchController?: AbortController;
  private lastUnknownFetch = Number.NEGATIVE_INFINITY;
  private epoch = 0;
  private retired = false;
  private readonly crypto = new FleetWorkBudget(8);
  constructor(
    issuer: string,
    private readonly options: {
      allowInsecureLoopback?: boolean;
      fetch?: typeof fetch;
      now?: () => number;
    } = {},
  ) {
    this.issuer = fleetOrigin(issuer, options.allowInsecureLoopback);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async fetchKeys() {
    try {
      const epoch = this.epoch,
        controller = new AbortController();
      this.fetchController = controller;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(5000),
      ]);
      const response = await fleetWait(
        (this.options.fetch ?? fetch)(`${this.issuer}/fleet/v0/jwks`, {
          signal,
          redirect: "error",
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new FleetError(
          "issuer_unavailable",
          "Configured issuer JWKS is unavailable",
          503,
        );
      }
      const reader = response.body?.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (!reader) throw new Error("Missing JWKS body");
        for (;;) {
          const { done, value } = await fleetWait(reader.read(), signal);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 64 * 1024) throw new Error("Oversized JWKS");
          chunks.push(value);
        }
        const parsed = keySet.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        if (
          new Set(parsed.keys.map((key) => key.kid)).size !== parsed.keys.length
        )
          throw new Error("Duplicate signing key identity");
        if (epoch !== this.epoch || signal.aborted)
          throw new FleetError("unauthorized", "Issuer trust was retired", 401);
        this.keys = { loadedAt: this.now(), values: parsed.keys };
      } finally {
        void reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw new FleetError(
        "issuer_unavailable",
        "Configured issuer JWKS could not be fetched or validated",
        503,
      );
    }
  }
  private async key(token: string, signal?: AbortSignal): Promise<PublicKey> {
    if (this.retired)
      throw new FleetError("unauthorized", "Issuer trust was retired", 401);
    if (Buffer.byteLength(token) > 32 * 1024)
      throw new FleetError("unauthorized", "Oversized fleet JWT", 401);
    const header = jose.decodeProtectedHeader(token);
    if (
      header.alg !== "ES256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 128
    )
      throw new FleetError(
        "unauthorized",
        "Unsupported issuer signing key",
        401,
      );
    const fresh = this.keys && this.keys.loadedAt + 600_000 > this.now();
    const known = this.keys?.values.find((key) => key.kid === header.kid);
    if (!fresh || !known) {
      if (!this.fetching) {
        if (!known && this.now() - this.lastUnknownFetch < 60_000)
          throw new FleetError(
            "unauthorized",
            "Unknown issuer signing key",
            401,
          );
        if (!known) this.lastUnknownFetch = this.now();
        const pending = this.fetchKeys();
        this.fetching = pending;
        void pending
          .finally(() => {
            if (this.fetching === pending) this.fetching = undefined;
          })
          .catch(() => {});
      }
      await fleetWait(this.fetching, signal);
    }
    const key = this.keys?.values.find((value) => value.kid === header.kid);
    if (!key || !this.keys || this.keys.loadedAt + 600_000 <= this.now())
      throw new FleetError(
        "unauthorized",
        "Issuer signing key is unavailable",
        401,
      );
    return publicKeySchema.parse({
      kty: key.kty,
      crv: key.crv,
      x: key.x,
      y: key.y,
    });
  }
  async verifyPeer(
    token: string,
    targetProfileId: string,
    signal?: AbortSignal,
  ) {
    try {
      const epoch = this.epoch,
        key = await this.key(token, signal);
      const claims = await fleetWait(
        this.crypto.run(() =>
          verifyFleetPeerJwt(
            token,
            key,
            this.issuer,
            targetProfileId,
            this.now(),
          ),
        ),
        signal,
      );
      if (epoch !== this.epoch || claims.exp * 1000 <= this.now())
        throw new FleetError(
          "unauthorized",
          "Fleet peer authority expired or was retired",
          401,
        );
      return claims;
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw new FleetError(
        "unauthorized",
        "Invalid issuer signature, lifetime or identity bindings",
        401,
      );
    }
  }
  async verifyIntroduction(
    token: string,
    accountId: string,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<EnrolledClient> {
    try {
      const epoch = this.epoch,
        key = await this.key(token, signal);
      const claims = introduction.parse(
        await fleetWait(
          this.crypto.run(async () => {
            const { payload } = await jose.jwtVerify(
              token,
              await importFleetKey(key),
              {
                issuer: this.issuer,
                audience: "urn:yep-anywhere:client-introduction",
                algorithms: ["ES256"],
                typ: "ya-client-introduction+jwt",
                currentDate: new Date(this.now()),
                clockTolerance: 5,
              },
            );
            return payload;
          }),
          signal,
        ),
      );
      if (
        epoch !== this.epoch ||
        claims.client.accountId !== accountId ||
        claims.sub !== clientId ||
        claims.client.id !== clientId ||
        claims.client.revoked ||
        claims.exp * 1000 <= this.now() ||
        claims.iat * 1000 > this.now() + 5000 ||
        claims.exp - claims.iat > 290
      )
        throw new FleetError(
          "unauthorized",
          "Client introduction does not match accepted issuer/account bindings",
          401,
        );
      return claims.client;
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw new FleetError(
        "unauthorized",
        "Invalid issuer signature, lifetime or identity bindings",
        401,
      );
    }
  }
  distrust() {
    this.retired = true;
    this.epoch++;
    this.keys = undefined;
    this.fetchController?.abort();
    this.lastUnknownFetch = Number.NEGATIVE_INFINITY;
  }
}
