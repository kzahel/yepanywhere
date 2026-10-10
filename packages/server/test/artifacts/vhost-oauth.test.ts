import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VhostOauth } from "../../src/artifacts/VhostOauth.js";
import { VhostAccess } from "../../src/artifacts/VhostAccess.js";
import { ArtifactServer } from "../../src/artifacts/ArtifactServer.js";
import { createLocalResourcePathPolicy } from "../../src/routes/local-resource-policy.js";
import { vhostOauthEnvironment } from "../../src/artifacts/VhostOauthProvider.js";
import {
  redundantVhostEmail,
  vhostEmailMatches,
  vhostOauthPolicy,
} from "@yep-anywhere/shared";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const path of directories.splice(0)) await rm(path, { recursive: true });
});
const row = { name: "memo", port: 5173 };
const issuer = "https://identity.example.net";
const settings = {
  kind: "oidc" as const,
  tenantId: "common",
  issuer,
  clientId: "client",
  callbackUrl: "https://auth.example.net/callback",
  visitorIp: "peer" as const,
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test",
  alg: "RS256",
  use: "sig",
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

async function fixture(kind: "oidc" | "entra" = "oidc") {
  const directory = await mkdtemp(join(tmpdir(), "ya-oauth-"));
  directories.push(directory);
  const state = {
    nonce: "",
    email: "member@rws.com",
    audience: "client",
    verified: true,
    validSignature: true,
    tenant: "e6086457-8967-492c-8087-fbcc958dfdfa",
    upn: "member@rws.com",
    userType: "Member",
    accountId: "person",
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer:
          kind === "entra"
            ? "https://login.microsoftonline.com/{tenantid}/v2.0"
            : issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url === `${issuer}/keys`) return Response.json({ keys: [key] });
    if (url === `${issuer}/token`) {
      expect(String(init?.body)).toContain("code_verifier=");
      const payload = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: kind === "entra" ? `https://login.microsoftonline.com/${state.tenant}/v2.0` : issuer, tid: state.tenant, oid: "person", sub: "person", aud: state.audience, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nonce: state.nonce, email: state.email, email_verified: state.verified })}`;
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(payload),
        privateKey,
      ).toString("base64url");
      return Response.json({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 600,
        id_token: `${payload}.${state.validSignature ? signature : "invalid"}`,
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?"))
      return Response.json({
        id: state.accountId,
        userPrincipalName: state.upn,
        userType: state.userType,
      });
    throw new Error(`Unexpected test fetch ${url}`);
  };
  const access = new VhostAccess(directory);
  await access.ready;
  const revoke = vi.fn();
  const service = new VhostOauth(
    directory,
    () => ({
      port: 4402,
      publicOrigin: "https://files.example.net",
      vhostPublicRoot: "example.net",
      vhosts: [row],
    }),
    (value) => access.token(value),
    revoke,
    fetcher,
  );
  await service.ready;
  await service.configure({
    provider: { ...settings, kind },
    secret: "test-secret",
  });
  await service.setPolicy(row.name, ["*@rws.com"]);
  const request = (path: string, cookie = "", host = "memo.example.net") =>
    new Request(`https://${host}${path}`, { headers: { cookie } });
  async function start() {
    const response = (await service.admit(
      request("/_ya/oauth/start?return=%2Fmemo%3Fsection%3D2"),
      row,
    )) as Response;
    expect(response.status).toBe(303);
    const auth = new URL(response.headers.get("location")!);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("redirect_uri")).toBe(settings.callbackUrl);
    state.nonce = auth.searchParams.get("nonce")!;
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      state: auth.searchParams.get("state")!,
    };
  }
  async function callback(flow: Awaited<ReturnType<typeof start>>) {
    return (await service.callback(
      new Request(`${settings.callbackUrl}?code=code&state=${flow.state}`),
    ))!;
  }
  async function finish() {
    const flow = await start();
    const result = await callback(flow);
    return (await service.admit(
      new Request(result.headers.get("location")!, {
        headers: { cookie: flow.cookie },
      }),
      row,
    )) as Response;
  }
  return {
    service,
    state,
    directory,
    access,
    revoke,
    request,
    start,
    callback,
    finish,
  };
}

it("selects providers independently, binds callbacks and revokes disabled providers", async () => {
  const f = await fixture();
  const second = {
    ...settings,
    clientId: "second-client",
    callbackUrl: "https://second-auth.example.net/callback",
  };
  await f.service.configure(
    { provider: second, secret: "second-secret" },
    "second",
  );
  const page = (await f.service.admit(
    f.request("/memo?section=2"),
    row,
  )) as Response;
  const document = await page.text();
  expect(document).toContain("provider=default");
  expect(document).toContain("provider=second");
  expect(page.headers.get("content-security-policy")).toContain(
    "style-src 'sha256-",
  );
  const begin = (await f.service.admit(
    f.request("/_ya/oauth/start?provider=second&return=%2Fmemo"),
    row,
  )) as Response;
  expect(begin.status).toBe(303);
  const auth = new URL(begin.headers.get("location")!);
  expect(auth.searchParams.get("client_id")).toBe("second-client");
  expect(auth.searchParams.get("redirect_uri")).toBe(second.callbackUrl);
  const state = auth.searchParams.get("state")!;
  f.state.nonce = auth.searchParams.get("nonce")!;
  f.state.audience = "second-client";
  expect(
    (await f.service.callback(
      new Request(`${settings.callbackUrl}?state=${state}&code=code`),
    ))!.status,
  ).toBe(400);
  const callback = (await f.service.callback(
    new Request(`${second.callbackUrl}?state=${state}&code=code`),
  ))!;
  expect(callback.status).toBe(303);
  const finish = (await f.service.admit(
    new Request(callback.headers.get("location")!, {
      headers: { cookie: begin.headers.get("set-cookie")!.split(";")[0]! },
    }),
    row,
  )) as Response;
  expect(finish.status).toBe(303);
  const cookie = finish.headers.getSetCookie()[0]!.split(";")[0]!;
  await f.service.setProviderEnabled("second", false);
  expect(
    ((await f.service.admit(f.request("/", cookie), row)) as Response).status,
  ).toBe(401);
  expect(
    (
      (await f.service.admit(
        f.request("/_ya/oauth/start?provider=second"),
        row,
      )) as Response
    ).status,
  ).toBe(400);
  await f.service.configure({ provider: settings });
  expect(f.service.status().providers).toHaveLength(2);
  const restarted = new VhostOauth(
    f.directory,
    () => ({ port: 4402 }),
    () => "",
    () => {},
  );
  await restarted.ready;
  expect(
    restarted.status().providers?.find((entry) => entry.id === "second")
      ?.enabled,
  ).toBe(false);
  expect(JSON.stringify(restarted.status())).not.toContain("second-secret");
  await f.service.setProviderEnabled("default", false);
  expect(
    ((await f.service.admit(f.request("/"), row)) as Response).status,
  ).toBe(503);
  await f.service.removeProvider("second");
  expect(f.service.status().providers).toHaveLength(1);
});

it("verifies signed OIDC, binds the callback to the initiating browser and logs only the check", async () => {
  const f = await fixture();
  const flow = await f.start();
  const result = await f.callback(flow);
  expect((await f.callback(flow)).status).toBe(400);
  const location = result.headers.get("location")!;
  expect(
    ((await f.service.admit(new Request(location), row)) as Response).status,
  ).toBe(400);
  expect(f.service.logs()).toHaveLength(0);
  const finish = (await f.service.admit(
    new Request(location, { headers: { cookie: flow.cookie } }),
    row,
  )) as Response;
  expect(finish.status).toBe(303);
  expect(finish.headers.get("location")).toBe(
    "https://memo.example.net/memo?section=2",
  );
  const cookie = finish.headers.getSetCookie()[0]!.split(";")[0]!;
  expect(finish.headers.getSetCookie()[0]).toContain(
    "Secure; HttpOnly; SameSite=Lax",
  );
  for (const path of ["/memo", "/asset.js", "/image.png"])
    expect(await f.service.admit(f.request(path, cookie), row)).toHaveProperty(
      "expiresAt",
    );
  expect(f.service.logs()).toHaveLength(1);
  expect(
    await readFile(join(f.directory, "logs/vhost-oauth-access.jsonl"), "utf8"),
  ).not.toContain("/memo");
  expect(f.service.logs()[0]).toMatchObject({
    email: "member@rws.com",
    outcome: "allowed",
    host: "memo.example.net",
  });
  const upstream = f.access.authorize(
    f.request("/asset", `${cookie}; app=ok`),
    row,
    false,
    true,
  )!;
  expect(upstream.request.headers.get("cookie")).toBe("app=ok");
  expect(upstream.cookie).toBeUndefined();
  expect(
    (
      (await f.service.admit(
        new Request(location, { headers: { cookie: flow.cookie } }),
        row,
      )) as Response
    ).status,
  ).toBe(400);
  await f.service.setPolicy(row.name, ["*@other.com"]);
  expect(
    ((await f.service.admit(f.request("/memo", cookie), row)) as Response)
      .status,
  ).toBe(401);
});

it.each(["audience", "nonce", "signature", "unverified", "denied"])(
  "rejects %s and never makes an app session",
  async (reason) => {
    const f = await fixture();
    const flow = await f.start();
    if (reason === "audience") f.state.audience = "wrong-client";
    if (reason === "nonce") f.state.nonce = "wrong-nonce";
    if (reason === "signature") f.state.validSignature = false;
    if (reason === "unverified") f.state.verified = false;
    if (reason === "denied") f.state.email = "outsider@other.com";
    const callback = await f.callback(flow);
    const finish = (await f.service.admit(
      new Request(callback.headers.get("location")!, {
        headers: { cookie: flow.cookie },
      }),
      row,
    )) as Response;
    expect(finish.status).toBe(403);
    expect(finish.headers.has("set-cookie")).toBe(false);
    expect(f.service.logs()[0]?.outcome).toBe(
      reason === "denied" ? "denied" : "error",
    );
  },
);

it("does not accept bearer links instead of OAuth, while localhost keeps legacy access", async () => {
  const f = await fixture();
  expect(
    (
      (await f.service.admit(
        f.request(`/?ya_access=${f.access.token(row)}`),
        row,
      )) as Response
    ).status,
  ).toBe(401);
  expect(
    await f.service.admit(f.request("/", "", "memo.localhost"), row),
  ).toBeUndefined();
  expect(
    (
      (await f.service.admit(
        f.request("/_ya/oauth/start?return=//evil.example"),
        row,
      )) as Response
    ).status,
  ).toBe(400);
  const finish = await f.finish();
  const cookie = finish.headers.getSetCookie()[0]!.split(";")[0]!;
  expect(
    (
      (await f.service.admit(
        new Request("https://memo.example.net/action", {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
        }),
        row,
      )) as Response
    ).status,
  ).toBe(403);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61 * 60_000);
  expect(
    ((await f.service.admit(f.request("/", cookie), row)) as Response).status,
  ).toBe(401);
});

it("validates environment precedence without disclosing or persisting its credential", async () => {
  expect(vhostOauthEnvironment({})).toBeUndefined();
  expect(() =>
    vhostOauthEnvironment({ YEP_VHOST_OAUTH_CLIENT_ID: "client" }),
  ).toThrow("Invalid YEP_VHOST_OAUTH");
  vi.stubEnv("YEP_VHOST_OAUTH_CLIENT_ID", "client");
  vi.stubEnv("YEP_VHOST_OAUTH_CLIENT_SECRET", "environment-secret");
  vi.stubEnv(
    "YEP_VHOST_OAUTH_CALLBACK_URL",
    "https://auth.example.net/callback",
  );
  const oauth = new VhostOauth(
    undefined,
    () => ({ port: 4402 }),
    () => "",
    () => {},
  );
  await oauth.ready;
  expect(oauth.status()).toMatchObject({
    locked: true,
    configured: true,
    enabled: true,
    secretSuffix: "cret",
    provider: { kind: "entra", tenantId: "common" },
  });
  expect(JSON.stringify(oauth.status())).not.toContain("environment-secret");
  await expect(oauth.configure({})).rejects.toThrow("environment variables");
  await oauth.configure(
    { provider: settings, secret: "additional-secret" },
    "additional",
  );
  expect(oauth.status().providers).toMatchObject([
    { id: "default", locked: true },
    { id: "additional", locked: false },
  ]);
  await oauth.setEnabled(false);
  expect(oauth.status()).toMatchObject({
    enabled: false,
    configured: true,
    locked: true,
  });
  await oauth.setEnabled(true);
  expect(oauth.status().enabled).toBe(true);
});

it("disables admission without deleting provider settings or email lists, including across restart", async () => {
  const f = await fixture();
  expect(f.service.status()).toMatchObject({ enabled: true, configured: true });
  expect(f.service.status().secretSuffix).toBeUndefined();
  const finish = await f.finish();
  const cookie = finish.headers.getSetCookie()[0]!.split(";")[0]!;
  const flow = await f.start();
  await f.service.setEnabled(false);
  expect(f.revoke).toHaveBeenCalled();
  expect((await f.callback(flow)).status).toBe(503);
  for (const path of ["/", "/_ya/oauth/start", "/_ya/oauth/finish?ticket=old"])
    expect(
      ((await f.service.admit(f.request(path, cookie), row)) as Response)
        .status,
    ).toBe(503);
  expect(
    await f.service.admit(f.request("/", "", "memo.localhost"), row),
  ).toBeUndefined();
  await f.service.setPolicy("memo", ["person@rws.com"]);
  const restarted = new VhostOauth(
    f.directory,
    () => ({ port: 4402, vhostPublicRoot: "example.net", vhosts: [row] }),
    (value) => f.access.token(value),
    () => {},
  );
  await restarted.ready;
  expect(restarted.status()).toMatchObject({
    enabled: false,
    configured: true,
    provider: settings,
    policies: { memo: ["person@rws.com"] },
  });
  expect(
    ((await restarted.admit(f.request("/", cookie), row)) as Response).status,
  ).toBe(503);
  await f.service.setEnabled(true);
  expect(
    ((await f.service.admit(f.request("/", cookie), row)) as Response).status,
  ).toBe(401);
  await f.start();
});

it("keeps protected hosts blocked and their lists repairable when manual credentials are absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-oauth-unconfigured-"));
  directories.push(directory);
  // Existing state files acquire the default enabled switch without a migration.
  await writeFile(
    join(directory, "vhost-oauth.json"),
    JSON.stringify({ policies: { memo: ["*@rws.com"] } }),
  );
  const oauth = new VhostOauth(
    directory,
    () => ({ port: 4402, vhostPublicRoot: "example.net", vhosts: [row] }),
    () => "",
    () => {},
  );
  await oauth.ready;
  expect(oauth.status()).toMatchObject({ enabled: true, configured: false });
  expect(
    (
      (await oauth.admit(
        new Request("https://memo.example.net/"),
        row,
      )) as Response
    ).status,
  ).toBe(503);
  await oauth.setPolicy("memo", ["person@rws.com"]);
  expect(oauth.status().policies.memo).toEqual(["person@rws.com"]);
  await oauth.configure({ provider: settings, secret: "manual-secret-1234" });
  expect(oauth.status()).toMatchObject({
    configured: true,
    enabled: true,
    secretSuffix: "1234",
  });
  expect(JSON.stringify(oauth.status())).not.toContain("manual-secret");
});

it("uses Entra managed account names rather than mutable email claims", async () => {
  const f = await fixture("entra");
  f.state.email = "unrelated@other.com";
  expect((await f.finish()).status).toBe(303);
  expect(f.service.logs()[0]?.email).toBe("member@rws.com");
  f.state.upn = "outsider@other.com";
  f.state.email = "claimed@rws.com";
  expect((await f.finish()).status).toBe(403);
  f.state.upn = "member@rws.com";
  f.state.userType = "Guest";
  expect((await f.finish()).status).toBe(403);
  f.state.userType = "Member";
  f.state.accountId = "different-person";
  expect((await f.finish()).status).toBe(403);
});

it("allows personal Microsoft accounts only under unrestricted sign-in", async () => {
  const f = await fixture("entra");
  f.state.tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
  expect((await f.finish()).status).toBe(403);
  await f.service.setPolicy(row.name, ["*@*"]);
  expect((await f.finish()).status).toBe(303);
});

it("enforces OAuth before the real file and proxy dispatch, including public and bearer access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-oauth-dispatch-"));
  directories.push(directory);
  const path = join(directory, "memo.html");
  await writeFile(path, "private memo");
  const site = { name: "site", path, public: true };
  const server = new ArtifactServer(
    {
      port: 4402,
      publicOrigin: "https://files.example.net",
      vhostPublicRoot: "example.net",
      vhosts: [row],
      vhostSites: [site],
    },
    createLocalResourcePathPolicy({ allowedPaths: [directory] }),
  );
  try {
    await server.ready;
    await server.vhostOauth.configure({
      provider: settings,
      secret: "test-secret",
    });
    await server.vhostOauth.setPolicy("memo", ["*@*"]);
    await server.vhostOauth.setPolicy("site", ["*@*"]);
    const proxy = vi.fn(async () => new Response("upstream"));
    for (const target of [row, site]) {
      const response = await server.dispatchHost(
        new Request(
          `https://${target.name}.example.net/?ya_access=${server.vhostAccess.token(target)}`,
        ),
        "127.0.0.1",
        proxy,
      );
      expect(response?.status).toBe(401);
      expect(await response?.text()).toContain("Sign in to continue");
    }
    expect(proxy).not.toHaveBeenCalled();
    await server.vhostOauth.setEnabled(false);
    for (const target of [row, site]) {
      const response = await server.dispatchHost(
        new Request(`https://${target.name}.example.net/`),
        "127.0.0.1",
        proxy,
      );
      expect(response?.status).toBe(503);
    }
    expect(proxy).not.toHaveBeenCalled();
    const local = await server.dispatchHost(
      new Request("http://site.localhost/"),
    );
    expect(await local?.text()).toBe("private memo");
    await server.vhostOauth.setEnabled(true);
    expect(
      (await server.dispatchHost(new Request(settings.callbackUrl)))?.status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});

it("matches email globs and highlights only simple containing rows", () => {
  expect(vhostOauthPolicy({}, "constructor")).toBeUndefined();
  expect(vhostOauthPolicy({ constructor: ["*@*"] }, "constructor")).toEqual([
    "*@*",
  ]);
  expect(vhostEmailMatches("Jane@RWS.com", "*@rws.com")).toBe(true);
  expect(vhostEmailMatches("jane@notrws.com", "*@rws.com")).toBe(false);
  expect(redundantVhostEmail(["*@*", "*@rws.com"], 1)).toBe("*@*");
  expect(redundantVhostEmail(["*@rws.com", "jane@rws.com"], 1)).toBe(
    "*@rws.com",
  );
  expect(redundantVhostEmail(["j*@rws.com", "*@rws.com"], 1)).toBeUndefined();
});
