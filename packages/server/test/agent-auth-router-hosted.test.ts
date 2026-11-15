import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAuthRouter } from "../src/services/AgentAuthRouter.js";
import {
  hostedRouterOrigin,
  routerRequest,
} from "../src/services/agent-auth-router-control.js";
import { createAgentAuthRouterRoutes } from "../src/routes/agent-auth-router.js";
import { decideLimitedRoute } from "../src/auth/limitedUserPolicy.js";
import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "./utils/session-metadata-database.js";

const hasOpenSsl =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const test = it.skipIf(!hasOpenSsl);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  closeTestDiscoveryDatabases();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(trust = true) {
  const root = await mkdtemp(join(tmpdir(), "ya-hosted-router-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const previousCA = https.globalAgent.options.ca;
  if (trust) https.globalAgent.options.ca = readFileSync(cert);
  cleanups.push(async () => {
    https.globalAgent.options.ca = previousCA;
  });
  const requests: {
    path: string;
    authorization?: string;
    body: Record<string, unknown>;
  }[] = [];
  const state = {
    provider: "codex",
    approved: false,
    dropped: false,
    revoked: false,
    losePair: false,
    loseCommit: false,
    offline: false,
    inferenceOrigin: "",
    routerId: "hosted-router",
    capabilities: ["manual-bindings", "remote-pairing-v1"],
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  let origin = "";
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const path = req.url!;
      requests.push({ path, authorization: req.headers.authorization, body });
      const reply = (status: number, value: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (state.offline) {
        req.socket.destroy();
        return;
      }
      if (path === "/control/v1/info")
        return reply(200, {
          protocol: 1,
          routerId: state.routerId,
          capabilities: state.capabilities,
          inferenceOrigin: state.inferenceOrigin || origin,
        });
      if (path === "/control/v1/pair") {
        if (state.losePair) {
          state.losePair = false;
          req.socket.destroy();
          return;
        }
        return reply(
          200,
          state.approved
            ? { state: "active" }
            : {
                state: "pending",
                userCode: "ABCD-EFGH",
                verificationUri: `${origin}/#pair`,
                expiresAt: state.expiresAt,
                interval: 5,
              },
        );
      }
      if (state.dropped || state.revoked)
        return reply(401, { error: "private-secret-must-not-escape" });
      if (!state.approved) return reply(403, { code: "pairing_pending" });
      if (path === "/control/v1/pair/status")
        return reply(200, { state: "active", routerId: state.routerId });
      if (path === "/control/v1/disconnect") {
        state.revoked = true;
        return reply(200, {});
      }
      if (path === "/control/v1/bindings/commit" && state.loseCommit) {
        state.loseCommit = false;
        req.socket.destroy();
        return;
      }
      return reply(200, {
        accounts: [
          {
            id: "account",
            provider: state.provider,
            enabled: true,
            renewal: "manual",
          },
        ],
        models: [{ id: "model", name: "Model" }],
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  origin = `https://localhost:${(server.address() as { port: number }).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const metadata = createTestSessionMetadataService(root);
  await metadata.initialize();
  const service = () => {
    const router = new AgentAuthRouter(root, metadata);
    cleanups.push(async () => router.close());
    return router;
  };
  return {
    root,
    state,
    origin,
    requests,
    metadata,
    service,
    router: service(),
  };
}

test("requires verified HTTPS, a bare origin and matching inference identity", async () => {
  for (const input of [
    "http://localhost",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?key=secret",
    "https://example.com/#pair",
    "garbage",
  ])
    expect(() => hostedRouterOrigin(input)).toThrow();
  const f = await fixture(false);
  await expect(f.router.connectHosted(f.origin)).rejects.toMatchObject({
    code: "certificate-invalid",
  });
  expect(f.requests).toHaveLength(0);
  https.globalAgent.options.ca = readFileSync(join(f.root, "cert.pem"));
  f.state.inferenceOrigin = "https://other.example.com";
  await expect(f.router.connectHosted(f.origin)).rejects.toMatchObject({
    code: "protocol-mismatch",
  });
  f.state.inferenceOrigin = f.origin;
  f.state.capabilities = ["manual-bindings"];
  await expect(f.router.connectHosted(f.origin)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(f.requests.every((r) => !r.authorization)).toBe(true);
});

test("recovers lost pairing replies and restarts with private credentials, then retains the native pin", async () => {
  const f = await fixture();
  f.state.losePair = true;
  await expect(
    f.router.connectHosted(f.origin, "YA fixture"),
  ).rejects.toMatchObject({ code: "unavailable" });
  f.router.close();
  const restarted = f.service();
  await restarted.pairingStatus();
  const pairs = f.requests.filter((r) => r.path.endsWith("/pair"));
  expect(pairs).toHaveLength(2);
  expect(pairs[0]!.body).toEqual(pairs[1]!.body);
  const pending = restarted.summary();
  expect(pending).toMatchObject({
    state: "pairing",
    connectionKind: "hosted",
    pairing: { userCode: "ABCD-EFGH" },
  });
  expect(JSON.stringify(pending)).not.toMatch(/aar_ctl_|tokenHash|socketPath/);
  const privateFile = join(f.root, "agent-auth-router/private.json");
  if (process.platform !== "win32")
    expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
  const credential = JSON.parse(readFileSync(privateFile, "utf8")).connection
    .token;
  expect(pairs[0]!.body.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  f.state.approved = true;
  f.state.inferenceOrigin = `${f.origin}/`;
  await restarted.pairingStatus();
  f.state.loseCommit = true;
  await expect(
    restarted.launch("session", "codex", "model", "account"),
  ).rejects.toMatchObject({ code: "unavailable" });
  const launch = await restarted.launch("session", "codex", "model", "account");
  expect(launch?.baseUrl).toBe(`${f.origin}/codex`);
  restarted.close();
  const resumed = f.service();
  const again = await resumed.launch("session", "codex", "model");
  expect(again?.bindingId).toBe(launch?.bindingId);
  expect(again?.token).toBe(launch?.token);
  expect(
    f.requests
      .filter((r) => !r.path.endsWith("/pair") && !r.path.endsWith("/info"))
      .every((r) => r.authorization === `Bearer ${credential}`),
  ).toBe(true);
  await expect(resumed.connect("/some/socket")).rejects.toThrow(/Disconnect/);
  f.state.provider = "claude";
  const claude = await resumed.launch(
    "claude-session",
    "claude",
    "model",
    "account",
  );
  expect(claude?.baseUrl).toBe(`${f.origin}/claude`);
  expect(claude?.token).not.toBe(launch?.token);
  f.state.routerId = "replacement";
  await expect(resumed.accounts()).rejects.toMatchObject({
    code: "identity-mismatch",
  });
  f.state.routerId = "hosted-router";
  f.state.revoked = true;
  expect(await resumed.recovery()).toMatchObject({
    state: "connected",
    issue: { code: "revoked" },
  });
  expect(f.metadata.getMetadata("session")?.routerBinding?.id).toBe(
    launch?.bindingId,
  );
});

test("cancels approval races and keeps unreachable revocation pending until acknowledgement", async () => {
  const f = await fixture();
  await f.router.connectHosted(f.origin);
  await f.router.cancelPairing();
  expect(f.router.summary().state).toBe("revocation-pending");
  await expect(f.router.connectHosted(f.origin)).rejects.toThrow(/Disconnect/);
  f.state.approved = true;
  f.state.offline = true;
  await expect(f.router.disconnect()).rejects.toMatchObject({
    code: "unavailable",
  });
  f.router.close();
  const router = f.service();
  await expect(
    router.launch("blocked", "codex", "model", "account"),
  ).rejects.toThrow(/pending/);
  f.state.offline = false;
  await router.pairingStatus();
  expect(f.state.revoked).toBe(true);
  expect(router.summary().state).toBe("disconnected");
});

test("expires dropped requests and exposes only owner-safe pairing responses", async () => {
  const f = await fixture();
  const routes = new Hono().route(
    "/api",
    createAgentAuthRouterRoutes(f.router),
  );
  const response = await routes.request(
    "/api/agent-auth-router/hosted/connect",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: f.origin }),
    },
  );
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain("aar_ctl_");
  f.state.dropped = true;
  await f.router.pairingStatus();
  expect(f.router.summary()).toMatchObject({
    state: "disconnected",
    pairingExpired: true,
  });
  for (const [method, path] of [
    ["POST", "/hosted/connect"],
    ["GET", "/hosted/pairing"],
    ["POST", "/hosted/cancel"],
  ])
    expect(
      decideLimitedRoute({
        method: method!,
        path: `/api/agent-auth-router${path}`,
      }),
    ).toMatchObject({ kind: "deny" });
  await expect(
    routerRequest({ origin: "http://localhost" }, "/v1/info"),
  ).rejects.toMatchObject({ code: "invalid-url" });
});

test("the server resumes bounded polling after restart and stops after approval", async () => {
  const f = await fixture();
  await f.router.connectHosted(f.origin);
  await f.router.close();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const router = f.service();
  f.state.approved = true;
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => expect(router.summary().state).toBe("connected"));
  const reads = f.requests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.requests).toHaveLength(reads);
  await router.close();
});

test("expiry stops polling without forgetting an unacknowledged credential", async () => {
  const f = await fixture();
  await f.router.connectHosted(f.origin);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.parse(f.state.expiresAt) + 1);
  await f.router.pairingStatus();
  expect(f.router.summary()).toMatchObject({
    state: "pairing",
    pairingExpired: true,
  });
  const reads = f.requests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.requests).toHaveLength(reads);
  f.state.dropped = true;
  await f.router.pairingStatus();
  expect(f.router.summary().state).toBe("disconnected");
  await f.router.close();
});
