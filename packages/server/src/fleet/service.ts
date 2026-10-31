import { renderFleetConfirmation } from "./confirmation.js";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { FleetOidc } from "./oidc.js";
import { z } from "zod";
import { FleetAuth, FleetNonceChallenge } from "./auth.js";
import {
  fleetPage,
  narrowerPolicy,
  fleetPolicySchema,
  uuid,
  type FleetControlClaims,
  type FleetRelationship,
} from "./contracts.js";
import { fleetDigest, fleetPeerAudience, signFleetJwt } from "./crypto.js";
import { FleetError } from "./errors.js";
import { fleetJson, fleetWait } from "./limits.js";
import { type FleetStore, retireFleetClient } from "./store.js";

const proposalSchema = z
  .object({ targetClientId: uuid, policy: fleetPolicySchema })
  .strict();
const publicationSchema = z
  .object({
    envelopeId: uuid,
    credentialId: uuid,
    credentialGeneration: z.number().int().positive(),
    policy: fleetPolicySchema,
    ciphertext: z
      .string()
      .min(1)
      .max(32 * 1024),
  })
  .strict();
export function fleetRelationship(
  store: FleetStore,
  auth: FleetAuth,
  claims: FleetControlClaims,
  id: string,
  side: "source" | "target" | "either",
) {
  const { client } = auth.assert(claims, "control");
  const relationship = store
    .read()
    .relationships.find(
      (r) =>
        r.id === id &&
        r.accountId === claims.sub &&
        !r.revoked &&
        r.policy.expiresAt > auth.now(),
    );
  if (
    !client ||
    !relationship ||
    !store
      .read()
      .clients.some(
        (c) => c.id === relationship.sourceClientId && !c.revoked,
      ) ||
    !store
      .read()
      .clients.some(
        (c) => c.id === relationship.targetClientId && !c.revoked,
      ) ||
    (side !== "target" &&
      relationship.sourceClientId !== client.id &&
      side !== "either") ||
    (side !== "source" &&
      relationship.targetClientId !== client.id &&
      side !== "either") ||
    (side === "either" &&
      ![relationship.sourceClientId, relationship.targetClientId].includes(
        client.id,
      ))
  )
    throw new FleetError(
      "not_found",
      "Directional proposal is not accessible",
      404,
    );
  return relationship;
}

/** No main app, scanners, provider registry, background jobs or implicit listen. */
export function createFleetService(
  store: FleetStore,
  options: {
    now?: () => number;
    oidcProviders?: unknown;
    oidcFetch?: typeof fetch;
    remoteAddress?: (context: Context) => string | undefined;
  } = {},
) {
  const auth = new FleetAuth(store, options.now);
  const oidc = new FleetOidc(auth, options.oidcProviders, {
    fetch: options.oidcFetch,
    remoteAddress: options.remoteAddress,
  });
  const app = new Hono<{
    Variables: {
      fleetClaims: FleetControlClaims;
      fleetToken: string;
      fleetSignal: AbortSignal;
    };
  }>();
  app.use("*", async (c, next) => {
    const expected = new URL(store.issuer);
    const actual = new URL(c.req.url);
    if (actual.origin !== expected.origin)
      return c.json(
        {
          error: "invalid_origin",
          message: "Request origin does not match configured fleet issuer",
        },
        400,
      );
    if (
      (c.req.header("Authorization")?.length ?? 0) > 32773 ||
      (c.req.header("DPoP")?.length ?? 0) > 32768
    )
      return c.json(
        {
          error: "invalid_request",
          message: "Fleet authorization header exceeds its byte bound",
        },
        400,
      );
    const signal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(10_000),
    ]);
    c.set("fleetSignal", signal);
    await fleetWait(next(), signal);
    if (c.res.status !== 204) {
      const reply = await fleetWait(c.res.arrayBuffer(), signal);
      if (reply.byteLength > 256 * 1024)
        throw new FleetError(
          "reply_too_large",
          "Fleet reply exceeds 256 KiB; request a smaller page",
          503,
        );
      c.res = new Response(reply, {
        status: c.res.status,
        headers: c.res.headers,
      });
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.onError((error, c) => {
    if (error instanceof FleetNonceChallenge) {
      c.header("DPoP-Nonce", error.nonce);
      c.header("WWW-Authenticate", 'DPoP error="use_dpop_nonce"');
    }
    if (error instanceof FleetError) {
      if (error.status === 429) c.header("Retry-After", "10");
      return c.json(
        { error: error.code, message: error.message },
        error.status,
      );
    }
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: "invalid_request",
          message: "Request does not match the fleet API schema",
        },
        400,
      );
    return c.json(
      { error: "fleet_unavailable", message: "Fleet operation failed" },
      503,
    );
  });
  app.get("/fleet/v0", (c) =>
    c.json({
      version: "v0-unstable",
      issuer: store.issuer,
      authentication: "DPoP",
      resources: [
        "login",
        "oidc",
        "enroll",
        "refresh",
        "clients",
        "relationships",
        "mailbox",
      ],
      peerAuthority: "Account membership alone grants no peer access",
    }),
  );
  app.get("/fleet/v0/jwks", async (c) =>
    c.json(await auth.crypto.run(() => auth.jwks())),
  );
  app.post("/fleet/v0/login", async (c) => {
    const input = z
      .object({
        username: z.string().max(128),
        password: z.string().max(256),
        introduction: z.unknown(),
      })
      .strict()
      .parse(await fleetJson(c.req.raw, c.get("fleetSignal")));
    const result = await fleetWait(
      auth.login(input.username, input.password, input.introduction),
      c.get("fleetSignal"),
    );
    return c.json(result);
  });
  app.get("/fleet/v0/oidc/providers", (c) => c.json({ items: oidc.list() }));
  app.post("/fleet/v0/oidc/start", async (c) =>
    c.json(await oidc.start(c, c.get("fleetSignal"))),
  );
  app.get("/fleet/v0/oidc/callback/:providerId", async (c) => {
    const confirmation = await oidc.callback(
      c.req.param("providerId"),
      new URL(c.req.url),
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    return c.html(await renderFleetConfirmation(confirmation));
  });
  app.use("/fleet/v0/*", async (c, next) => {
    const purpose =
      c.req.path === "/fleet/v0/enroll"
        ? "enroll"
        : c.req.path === "/fleet/v0/refresh"
          ? "refresh"
          : c.req.path.startsWith("/fleet/v0/oidc/flows/")
            ? "oidc"
            : "control";
    const { claims, token, nextNonce } = await fleetWait(
      auth.authorize(
        c.req.raw,
        purpose,
        purpose === "oidc" ? oidc.assert : undefined,
      ),
      c.get("fleetSignal"),
    );
    c.header("DPoP-Nonce", nextNonce);
    c.set("fleetClaims", claims);
    c.set("fleetToken", token);
    await next();
  });
  app.get("/fleet/v0/oidc/flows/:id", (c) => {
    if (c.get("fleetClaims").bindingId !== c.req.param("id"))
      throw new FleetError("unauthorized", "Wrong OIDC flow", 401);
    return c.json(oidc.status(c.get("fleetClaims")));
  });
  app.post("/fleet/v0/oidc/flows/:id/redeem", async (c) => {
    if (c.get("fleetClaims").bindingId !== c.req.param("id"))
      throw new FleetError("unauthorized", "Wrong OIDC flow", 401);
    return c.json(
      await oidc.redeem(
        c.get("fleetClaims"),
        await fleetJson(c.req.raw, c.get("fleetSignal")),
      ),
    );
  });
  app.post("/fleet/v0/enroll", async (c) =>
    c.json(await auth.enroll(c.get("fleetClaims"), c.get("fleetSignal"))),
  );
  app.post("/fleet/v0/refresh", async (c) =>
    c.json(
      await auth.refresh(
        c.get("fleetClaims"),
        c.get("fleetToken"),
        c.get("fleetSignal"),
      ),
    ),
  );
  app.get("/fleet/v0/me", (c) => {
    const { account, client, session } = auth.assert(
      c.get("fleetClaims"),
      "control",
    );
    return c.json({
      account: { id: account.id, displayName: account.displayName },
      client,
      familyExpiresAt: session?.expiresAt,
    });
  });
  app.get("/fleet/v0/clients", (c) => {
    const claims = c.get("fleetClaims");
    auth.assert(claims, "control");
    return c.json(
      fleetPage(
        store
          .read()
          .clients.filter(
            (client) => client.accountId === claims.sub && !client.revoked,
          ),
        c.req.query(),
      ),
    );
  });
  app.get("/fleet/v0/clients/:id", async (c) => {
    const claims = c.get("fleetClaims");
    auth.assert(claims, "control");
    const client = store
      .read()
      .clients.find(
        (entry) =>
          entry.id === c.req.param("id") &&
          entry.accountId === claims.sub &&
          !entry.revoked,
      );
    if (!client) throw new FleetError("not_found", "Client not found", 404);
    const now = Math.floor(auth.now() / 1000);
    const attestation = await auth.crypto.run(() =>
      signFleetJwt(
        store.read().signingKey,
        {
          iss: store.issuer,
          aud: "urn:yep-anywhere:client-introduction",
          sub: client.id,
          iat: now,
          exp: now + 290,
          jti: randomUUID(),
          client,
        },
        "ya-client-introduction+jwt",
      ),
    );
    auth.assert(claims, "control");
    if (
      !store
        .read()
        .clients.some(
          (current) =>
            current.id === client.id &&
            current.generation === client.generation &&
            !current.revoked,
        )
    )
      throw new FleetError(
        "not_found",
        "Client introduction was revoked during signing",
        404,
      );
    return c.json({ client, attestation });
  });
  app.delete("/fleet/v0/clients/:id", async (c) => {
    const claims = c.get("fleetClaims");
    await store.mutate((state) => {
      auth.assert(claims, "control");
      const client = state.clients.find(
        (entry) =>
          entry.id === c.req.param("id") && entry.accountId === claims.sub,
      );
      if (!client) throw new FleetError("not_found", "Client not found", 404);
      retireFleetClient(state, client.id);
    }, c.get("fleetSignal"));
    return c.body(null, 204);
  });
  app.get("/fleet/v0/relationships", (c) => {
    const claims = c.get("fleetClaims");
    auth.assert(claims, "control");
    return c.json(
      fleetPage(
        store
          .read()
          .relationships.filter(
            (r) =>
              r.accountId === claims.sub &&
              [r.sourceClientId, r.targetClientId].includes(claims.client_id),
          ),
        c.req.query(),
      ),
    );
  });
  app.post("/fleet/v0/relationships", async (c) => {
    const claims = c.get("fleetClaims"),
      input = proposalSchema.parse(
        await fleetJson(c.req.raw, c.get("fleetSignal")),
      );
    const relationship = await store.mutate((state) => {
      auth.assert(claims, "control");
      state.relationships = state.relationships.filter(
        (r) => !r.revoked && r.policy.expiresAt > auth.now(),
      );
      const retained = new Set(state.relationships.map((r) => r.id));
      state.mailbox = state.mailbox.filter(
        (m) => retained.has(m.relationshipId) && m.expiresAt > auth.now(),
      );
      if (
        input.targetClientId === claims.client_id ||
        !state.clients.some(
          (client) =>
            client.id === input.targetClientId &&
            client.accountId === claims.sub &&
            !client.revoked,
        ) ||
        input.policy.expiresAt <= auth.now() ||
        input.policy.expiresAt > auth.now() + 30 * 86_400_000
      )
        throw new FleetError(
          "invalid_request",
          "Proposal requires another active account client and expiry within 30 days",
        );
      if (
        state.relationships.some(
          (r) =>
            !r.revoked &&
            r.sourceClientId === claims.client_id &&
            r.targetClientId === input.targetClientId,
        )
      )
        throw new FleetError(
          "conflict",
          "A current directional proposal already exists",
          409,
        );
      const record: FleetRelationship = {
        id: randomUUID(),
        accountId: claims.sub,
        sourceClientId: claims.client_id,
        targetClientId: input.targetClientId,
        generation: 1,
        policy: input.policy,
        revoked: false,
        accepted: null,
      };
      state.relationships.push(record);
      return record;
    }, c.get("fleetSignal"));
    return c.json(relationship, 201);
  });
  app.get("/fleet/v0/relationships/:id", (c) =>
    c.json(
      fleetRelationship(
        store,
        auth,
        c.get("fleetClaims"),
        c.req.param("id"),
        "either",
      ),
    ),
  );
  app.delete("/fleet/v0/relationships/:id", async (c) => {
    const claims = c.get("fleetClaims");
    await store.mutate((state) => {
      const r = fleetRelationship(
        store,
        auth,
        claims,
        c.req.param("id"),
        "either",
      );
      state.relationships.find((item) => item.id === r.id)!.revoked = true;
      state.mailbox = state.mailbox.filter((m) => m.relationshipId !== r.id);
    }, c.get("fleetSignal"));
    return c.body(null, 204);
  });
  app.put("/fleet/v0/relationships/:id/envelope", async (c) => {
    const claims = c.get("fleetClaims"),
      input = publicationSchema.parse(
        await fleetJson(c.req.raw, c.get("fleetSignal")),
      );
    await store.mutate((state) => {
      const r = fleetRelationship(
          store,
          auth,
          claims,
          c.req.param("id"),
          "target",
        ),
        next = state.relationships.find((item) => item.id === r.id)!;
      if (
        !narrowerPolicy(input.policy, r.policy) ||
        input.policy.expiresAt <= auth.now() ||
        Buffer.byteLength(input.ciphertext) > 32 * 1024 ||
        input.ciphertext.split(".").length !== 5
      )
        throw new FleetError(
          "invalid_request",
          "Envelope must fit the accepted proposal and encoded byte bound",
        );
      const digest = fleetDigest(input.ciphertext);
      if (r.accepted) {
        if (
          r.accepted.envelopeId === input.envelopeId &&
          r.accepted.credentialId === input.credentialId &&
          r.accepted.credentialGeneration === input.credentialGeneration &&
          r.accepted.digest === digest &&
          JSON.stringify(r.accepted.policy) === JSON.stringify(input.policy)
        )
          return;
        throw new FleetError(
          "conflict",
          "An envelope is already published; reissue through a new relationship",
          409,
        );
      }
      if (
        state.relationships.some(
          (other) => other.accepted?.envelopeId === input.envelopeId,
        )
      )
        throw new FleetError(
          "conflict",
          "Envelope identity is already in use",
          409,
        );
      next.accepted = {
        envelopeId: input.envelopeId,
        credentialId: input.credentialId,
        credentialGeneration: input.credentialGeneration,
        policy: input.policy,
        digest,
        acknowledged: false,
      };
      state.mailbox = state.mailbox.filter((m) => m.expiresAt > auth.now());
      state.mailbox.push({
        id: input.envelopeId,
        relationshipId: r.id,
        generation: r.generation,
        sourceClientId: r.sourceClientId,
        targetClientId: r.targetClientId,
        expiresAt: input.policy.expiresAt,
        ciphertext: input.ciphertext,
      });
    }, c.get("fleetSignal"));
    return c.body(null, 204);
  });
  app.get("/fleet/v0/mailbox", (c) => {
    const claims = c.get("fleetClaims");
    auth.assert(claims, "control");
    return c.json(
      fleetPage(
        store
          .read()
          .mailbox.filter(
            (m) =>
              m.sourceClientId === claims.client_id && m.expiresAt > auth.now(),
          )
          .map(({ ciphertext: _, ...metadata }) => metadata),
        c.req.query(),
      ),
    );
  });
  app.get("/fleet/v0/mailbox/:id", (c) => {
    const claims = c.get("fleetClaims");
    auth.assert(claims, "control");
    const item = store
      .read()
      .mailbox.find(
        (m) =>
          m.id === c.req.param("id") &&
          m.sourceClientId === claims.client_id &&
          m.expiresAt > auth.now(),
      );
    if (!item) throw new FleetError("not_found", "Envelope not found", 404);
    fleetRelationship(store, auth, claims, item.relationshipId, "source");
    return c.json(item);
  });
  app.post("/fleet/v0/mailbox/:id/ack", async (c) => {
    const claims = c.get("fleetClaims");
    await store.mutate((state) => {
      auth.assert(claims, "control");
      const r = state.relationships.find(
        (entry) =>
          entry.sourceClientId === claims.client_id &&
          entry.accepted?.envelopeId === c.req.param("id"),
      );
      if (!r?.accepted)
        throw new FleetError("not_found", "Envelope not found", 404);
      fleetRelationship(store, auth, claims, r.id, "source");
      r.accepted.acknowledged = true;
      state.mailbox = state.mailbox.filter((m) => m.id !== c.req.param("id"));
    }, c.get("fleetSignal"));
    return c.body(null, 204);
  });
  app.post("/fleet/v0/relationships/:id/token", async (c) => {
    const claims = c.get("fleetClaims"),
      r = fleetRelationship(store, auth, claims, c.req.param("id"), "source"),
      accepted = r.accepted;
    const { client: source, session } = auth.assert(claims, "control");
    const target = store
      .read()
      .clients.find(
        (client) => client.id === r.targetClientId && !client.revoked,
      );
    if (!accepted || !source || !target || !session)
      throw new FleetError(
        "not_accepted",
        "The target has not published a peer credential",
        409,
      );
    const issued = Math.floor(auth.now() / 1000),
      expiresAt = Math.floor(
        Math.min(
          auth.now() + 290_000,
          session.expiresAt,
          r.policy.expiresAt,
          accepted.policy.expiresAt,
        ) / 1000,
      );
    const token = await auth.crypto.run(() =>
      signFleetJwt(
        store.read().signingKey,
        {
          iss: store.issuer,
          aud: fleetPeerAudience(target.profileId),
          sub: source.id,
          iat: issued,
          exp: expiresAt,
          jti: randomUUID(),
          ya: {
            version: 1,
            accountId: r.accountId,
            sourceClientId: source.id,
            targetClientId: target.id,
            sourceProfileId: source.profileId,
            targetProfileId: target.profileId,
            sourceSigningJkt: source.signingJkt,
            sourceEncryptionJkt: source.encryptionJkt,
            relationshipId: r.id,
            relationshipGeneration: r.generation,
            credentialId: accepted.credentialId,
            credentialGeneration: accepted.credentialGeneration,
            policy: accepted.policy,
          },
        },
        "ya-peer-grant+jwt",
      ),
    );
    fleetRelationship(store, auth, claims, r.id, "source");
    return c.json({ token, expiresAt: expiresAt * 1000 });
  });
  return { app, auth, close: () => store.close() };
}
