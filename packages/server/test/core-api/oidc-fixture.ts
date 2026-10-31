import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as jose from "jose";

/** Owned protocol issuer: actual code/PKCE exchange and signed ID tokens. */
export async function oidcFixture(
  options: {
    algorithm?: "RS256" | "ES256";
    authMethod?: "client_secret_basic" | "client_secret_post";
  } = {},
) {
  const algorithm = options.algorithm ?? "RS256",
    authMethod = options.authMethod ?? "client_secret_basic";
  const issuer = "http://127.0.0.1:45680",
    clientId = "owned-fleet-client",
    clientSecret = "owned-test-client-secret",
    subject = "owned-upstream-subject";
  const signing = await jose.generateKeyPair(algorithm, {
    modulusLength: algorithm === "RS256" ? 2048 : undefined,
    extractable: true,
  });
  const publicKey = await jose.exportJWK(signing.publicKey);
  const app = new Hono(),
    codes = new Map<
      string,
      { challenge: string; nonce: string; redirect: string }
    >();
  let exchanges = 0,
    jwksReads = 0,
    fault: "nonce" | "signature" | "issuer" | "subject" | undefined;
  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      jwks_uri: issuer + "/jwks",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [algorithm],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      scopes_supported: ["openid", "profile"],
    }),
  );
  app.get("/jwks", (c) => {
    jwksReads++;
    return c.json({
      keys: [{ ...publicKey, kid: "owned-key", alg: algorithm, use: "sig" }],
    });
  });
  app.get("/authorize", (c) => {
    const q = c.req.query();
    if (
      q.client_id !== clientId ||
      q.response_type !== "code" ||
      q.code_challenge_method !== "S256" ||
      !q.state ||
      !q.nonce ||
      !q.code_challenge ||
      q.redirect_uri !== "http://127.0.0.1:45679/fleet/v0/oidc/callback/owned"
    )
      return c.json({ error: "invalid_request" }, 400);
    const code = randomUUID();
    codes.set(code, {
      challenge: q.code_challenge,
      nonce: q.nonce,
      redirect: q.redirect_uri,
    });
    const callback = new URL(q.redirect_uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", q.state);
    callback.searchParams.set("iss", issuer);
    return c.redirect(callback.href, 303);
  });
  app.post("/token", async (c) => {
    const body = await c.req.parseBody();
    const authorization = c.req.header("Authorization") ?? "";
    const [basicId, basicSecret] = Buffer.from(
      authorization.split(" ")[1] ?? "",
      "base64",
    )
      .toString("utf8")
      .split(":");
    const basic =
      authorization.split(" ")[0]?.toLowerCase() === "basic" &&
      decodeURIComponent(basicId ?? "") === clientId &&
      decodeURIComponent(basicSecret ?? "") === clientSecret;
    if (
      !(authMethod === "client_secret_basic"
        ? basic
        : !authorization &&
          body.client_id === clientId &&
          body.client_secret === clientSecret)
    )
      return c.json({ error: "invalid_client" }, 401);
    const code = typeof body.code === "string" ? body.code : "",
      record = codes.get(code);
    codes.delete(code);
    if (
      body.grant_type !== "authorization_code" ||
      !record ||
      body.redirect_uri !== record.redirect ||
      typeof body.code_verifier !== "string" ||
      createHash("sha256").update(body.code_verifier).digest("base64url") !==
        record.challenge
    )
      return c.json({ error: "invalid_grant" }, 400);
    exchanges++;
    const broken = fault;
    fault = undefined;
    const key =
      broken === "signature"
        ? (
            await jose.generateKeyPair(algorithm, {
              modulusLength: algorithm === "RS256" ? 2048 : undefined,
            })
          ).privateKey
        : signing.privateKey;
    const idToken = await new jose.SignJWT({
      iss: broken === "issuer" ? "https://wrong.invalid" : issuer,
      sub: broken === "subject" ? "another-subject" : subject,
      aud: clientId,
      nonce: broken === "nonce" ? "wrong-nonce" : record.nonce,
      email: "same-email@example.test",
      email_verified: true,
    })
      .setProtectedHeader({ alg: algorithm, kid: "owned-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
    return c.json({
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  });
  const fetcher: typeof fetch = async (input, init) =>
    app.fetch(new Request(input, init));
  const authorize = async (url: string) => {
    const response = await app.fetch(new Request(url));
    if (response.status !== 303)
      throw new Error("Owned OIDC authorization failed");
    return response.headers.get("Location")!;
  };
  return {
    issuer,
    subject,
    app,
    fetcher,
    authorize,
    provider: {
      id: "owned",
      displayName: "Owned OIDC issuer",
      issuer,
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: authMethod,
      idTokenSigningAlgorithm: algorithm,
    },
    failNext: (value: typeof fault) => {
      fault = value;
    },
    exchanges: () => exchanges,
    jwksReads: () => jwksReads,
  };
}
