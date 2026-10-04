import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { decideLimitedRoute } from "../src/auth/limitedUserPolicy.js";
import { createSessionsRoutes } from "../src/routes/sessions.js";
import { createAgentAuthRouterRoutes } from "../src/routes/agent-auth-router.js";
import { SessionMetadataService } from "../src/metadata/SessionMetadataService.js";
import { AgentAuthRouter } from "../src/services/AgentAuthRouter.js";
import { structuredErrorHandler } from "../src/middleware/error-handler.js";
import {
  codexRouterArguments,
  codexRouterEnvironment,
  claudeRouterEnvironment,
} from "../src/sdk/providers/router-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  pools = false,
  ownerManaged = false,
  mostRemaining = false,
) {
  const root = await mkdtemp(join(tmpdir(), "yar-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "control.sock");
  const requests: {
    path: string;
    body: Record<string, unknown>;
    authorization?: string;
  }[] = [];
  let routerId = "fixture-router",
    revoked = false,
    failCommit = false,
    failCancel = false,
    rejectPrepare = false,
    enabled = true;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({
      path: req.url!,
      body,
      authorization: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/info")
      return res.end(
        JSON.stringify({
          protocol: 1,
          routerId,
          inferenceOrigin: "http://127.0.0.1:8417",
          capabilities: [
            "manual-bindings",
            ...(pools ? ["pools-v1"] : []),
            ...(mostRemaining
              ? ["most-remaining-v1", "admission-refresh-v1"]
              : []),
            ...(ownerManaged ? ["router-owned-pools-v1"] : []),
          ],
        }),
      );
    if (revoked) {
      res.statusCode = 401;
      return res.end("{}");
    }
    if (req.url === "/v1/pools/prepare" && rejectPrepare) {
      res.statusCode = 409;
      return res.end("{}");
    }
    if (req.url === "/v1/pools/prepare")
      return res.end(
        JSON.stringify({
          accountId: "account",
          poolId: body.poolId,
          policy: "round-robin",
          reason: "Round robin among eligible accounts",
          observedAt: "2026-10-03T08:00:00Z",
        }),
      );
    if (
      req.url === "/v1/overview" ||
      req.url === "/v1/overview/refresh" ||
      req.url === "/v1/selection"
    )
      return res.end(
        JSON.stringify({
          accounts: [],
          pools: [],
          observedAt: "2026-10-03T08:00:00Z",
          quotaFreshSeconds: 120,
        }),
      );
    if (req.url === "/v1/disconnect") revoked = true;
    if (req.url === "/v1/bindings/commit" && failCommit) {
      failCommit = false;
      req.socket.destroy();
      return;
    }
    if (req.url === "/v1/bindings/cancel" && failCancel) {
      res.statusCode = 503;
      return res.end(
        JSON.stringify({ error: "upstream-secret-must-not-escape" }),
      );
    }
    return res.end(
      JSON.stringify({
        models: [
          {
            id: "fixture-model",
            name: "Fixture",
            supportsEffort: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "ultra", description: "Maximum" },
            ],
          },
        ],
        accounts: [
          { id: "account", provider: "codex", enabled, renewal: "manual" },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const metadata = new SessionMetadataService({ dataDir: root });
  await metadata.initialize();
  const connector = new AgentAuthRouter(root, metadata);
  return {
    root,
    socketPath,
    requests,
    metadata,
    connector,
    identity: () => {
      routerId = "replacement";
    },
    rejectPoolPrepare: () => {
      rejectPrepare = true;
    },
    loseCommit: () => {
      failCommit = true;
    },
    cancellationAvailable: (available: boolean) => {
      failCancel = !available;
    },
    disableAccount: () => {
      enabled = false;
    },
    revoke: () => {
      revoked = true;
    },
  };
}
describe.skipIf(process.platform === "win32")(
  "router connection and allocation",
  () => {
    it("serves every advertised control route through its API mount", async () => {
      const f = await fixture();
      const app = new Hono().route(
        "/api",
        createAgentAuthRouterRoutes(f.connector),
      );
      const summary = await app.request("/api/agent-auth-router");
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({ state: "disconnected" });
      const connected = await app.request("/api/agent-auth-router/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socketPath: f.socketPath }),
      });
      expect(connected.status).toBe(200);
      for (const path of [
        "/accounts",
        "/accounts/account/catalog",
        "/accounts/account/quotas",
      ]) {
        expect(
          (await app.request(`/api/agent-auth-router${path}`)).status,
        ).toBe(200);
      }
      expect((await app.request("/api/accounts")).status).toBe(404);
      const disconnected = await app.request(
        "/api/agent-auth-router/disconnect",
        {
          method: "POST",
        },
      );
      expect(disconnected.status).toBe(200);
      expect(await disconnected.json()).toMatchObject({
        state: "disconnected",
      });
    });
    it("discovers selection through the owner route and coalesces concurrent reads", async () => {
      const f = await fixture();
      expect(await f.connector.selection("codex")).toBeNull();
      await f.connector.connect(f.socketPath);
      await Promise.all([
        f.connector.selection("codex"),
        f.connector.selection("codex"),
      ]);
      expect(f.requests.filter((r) => r.path === "/v1/selection")).toHaveLength(
        1,
      );
      expect(f.requests.find((r) => r.path === "/v1/selection")?.body).toEqual({
        provider: "codex",
      });
      const app = new Hono().route(
        "/api",
        createAgentAuthRouterRoutes(f.connector),
      );
      expect(
        (
          await app.request("/api/agent-auth-router/selection", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "codex" }),
          })
        ).status,
      ).toBe(200);
      await expect(f.connector.selection("arbitrary")).rejects.toThrow();
    });
    it("persists requested thinking, returns the pinned model metadata and refuses unsupported changes", async () => {
      const f = await fixture(true, true, true);
      await f.connector.connect(f.socketPath);
      const launch = await f.connector.launch(
        "effort-session",
        "codex",
        "fixture-model",
        undefined,
        "pool",
        undefined,
        { effort: "max" },
      );
      expect(
        f.requests.find((r) => r.path === "/v1/pools/prepare")?.body.thinking,
      ).toBe("on:max");
      expect(
        launch.models?.[0]?.supportedReasoningEfforts?.[1]?.reasoningEffort,
      ).toBe("ultra");
      await expect(
        f.connector.validateSessionSettings("effort-session", "fixture-model", {
          effort: "low",
        }),
      ).rejects.toThrow();
      const resumed = await f.connector.launch(
        "effort-session",
        "codex",
        "fixture-model",
        undefined,
        undefined,
        undefined,
        { effort: "high" },
      );
      expect(resumed.token).toBe(launch.token);
      expect(
        f.requests
          .filter((r) => r.path === "/v1/pools/prepare")
          .every((r) => r.body.thinking === "on:max"),
      ).toBe(true);
    });
    it("persists before prepare, recovers response loss, remaps identity and resumes the exact token", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      f.loseCommit();
      await expect(
        f.connector.launch("provisional", "codex", "fixture-model", "account"),
      ).rejects.toThrow();
      const ref = f.metadata.getMetadata("provisional")?.routerBinding;
      expect(ref?.accountId).toBe("account");
      const first = await f.connector.launch(
        "provisional",
        "codex",
        "fixture-model",
        "account",
      );
      await f.metadata.remapSessionId("provisional", "canonical");
      const freshMetadata = new SessionMetadataService({ dataDir: f.root });
      await freshMetadata.initialize();
      const fresh = new AgentAuthRouter(f.root, freshMetadata);
      const resumed = await fresh.launch("canonical", "codex", "fixture-model");
      expect(resumed).toEqual(first);
      const prepares = f.requests.filter((r) => r.path.endsWith("prepare"));
      expect(new Set(prepares.map((r) => r.body.id)).size).toBe(1);
      expect(prepares[0]?.body.tokenHash).toBe(
        createHash("sha256").update(first!.token).digest("hex"),
      );
      expect(JSON.stringify(f.connector.summary())).not.toContain(first!.token);
      expect(
        await readFile(join(f.root, "session-metadata.json"), "utf8"),
      ).not.toContain(first!.token);
      await expect(
        fresh.launch("canonical", "codex", "fixture-model", "different"),
      ).rejects.toThrow("pin cannot change");
      await fresh.disconnect();
      await expect(
        fresh.launch("canonical", "codex", "fixture-model"),
      ).rejects.toThrow("Connect");
    });
    it("durably retries failed launch cancellation before further allocation", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      await f.connector.launch("failed", "codex", "fixture-model", "account");
      await chmod(f.socketPath, 0o666);
      await expect(f.connector.cancel("failed")).rejects.toThrow();
      await chmod(f.socketPath, 0o600);
      const fresh = new AgentAuthRouter(f.root, f.metadata);
      await fresh.launch("next", "codex", "fixture-model", "account");
      expect(f.requests.some((r) => r.path === "/v1/bindings/cancel")).toBe(
        true,
      );
      await expect(
        fresh.launch("failed", "codex", "fixture-model"),
      ).rejects.toThrow("cancelled");
    });
    it("keeps failed revocation pending across restart and refuses launches until acknowledgement", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      await f.connector.launch("session", "codex", "fixture-model", "account");
      await chmod(f.socketPath, 0o666);
      await expect(f.connector.disconnect()).rejects.toThrow();
      const fresh = new AgentAuthRouter(f.root, f.metadata);
      expect(fresh.summary().state).toBe("revocation-pending");
      await expect(
        fresh.launch("session", "codex", "fixture-model"),
      ).rejects.toThrow("disconnect is pending");
      await expect(fresh.connect(f.socketPath)).rejects.toThrow("pending");
      await chmod(f.socketPath, 0o600);
      await fresh.disconnect();
      expect(fresh.summary().state).toBe("disconnected");
    });
    it("refuses insecure endpoints and different routers before sending a credential", async () => {
      const f = await fixture();
      await chmod(f.socketPath, 0o666);
      await expect(f.connector.connect(f.socketPath)).rejects.toThrow(
        "private",
      );
      await chmod(f.socketPath, 0o600);
      await f.connector.connect(f.socketPath);
      f.identity();
      const count = f.requests.length;
      await expect(f.connector.accounts()).rejects.toThrow("identity");
      expect(f.requests.slice(count).every((r) => !r.authorization)).toBe(true);
    });
    it("observes health without mutating state, exposing credentials, or retrying cancellation", async () => {
      const f = await fixture();
      expect(await f.connector.recovery()).toMatchObject({
        state: "disconnected",
        reachable: null,
        accounts: [],
        pendingCancellations: 0,
      });
      expect(f.requests).toHaveLength(0);
      await f.connector.connect(f.socketPath);
      const launch = await f.connector.launch(
        "failed",
        "codex",
        "fixture-model",
        "account",
      );
      f.cancellationAvailable(false);
      await expect(f.connector.cancel("failed")).rejects.toThrow("rejected");
      const before = f.requests.length;
      const recovery = await f.connector.recovery();
      expect(recovery).toMatchObject({
        state: "connected",
        reachable: true,
        pendingCancellations: 1,
        accounts: [{ id: "account", enabled: true }],
      });
      expect(f.requests.slice(before).map((r) => r.path)).toEqual([
        "/v1/info",
        "/v1/accounts",
      ]);
      expect(JSON.stringify(recovery)).not.toContain(launch!.token);
      expect(JSON.stringify(recovery)).not.toContain(f.socketPath);
      const fresh = new AgentAuthRouter(f.root, f.metadata);
      f.cancellationAvailable(true);
      f.disableAccount();
      await fresh.retryCancellations();
      expect(await fresh.recovery()).toMatchObject({
        pendingCancellations: 0,
        accounts: [{ enabled: false }],
      });
      expect(
        f.requests.filter((r) => r.path === "/v1/bindings/prepare"),
      ).toHaveLength(1);
      await fresh.retryCancellations();
      expect(
        f.requests.filter((r) => r.path === "/v1/bindings/cancel"),
      ).toHaveLength(2);
    });
    it("reports revoked, unsafe and replaced routers without losing saved pairing", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      // Retry with a blank UI path must preserve this custom socket and grant.
      await f.connector.connect();
      const pairs = f.requests.filter((r) => r.path === "/v1/pair");
      expect(pairs[1]?.body).toEqual(pairs[0]?.body);
      await chmod(f.socketPath, 0o666);
      expect(await f.connector.recovery()).toMatchObject({
        state: "connected",
        issue: { code: "unsafe-socket" },
      });
      await chmod(f.socketPath, 0o600);
      f.revoke();
      expect(await f.connector.recovery()).toMatchObject({
        state: "connected",
        reachable: true,
        issue: { code: "revoked" },
      });
      f.identity();
      const count = f.requests.length;
      expect(await f.connector.recovery()).toMatchObject({
        issue: { code: "identity-mismatch" },
      });
      expect(f.requests.slice(count).every((r) => !r.authorization)).toBe(true);
    });
    it("keeps pending cleanup on retry failure and reports a safe actionable error", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      await f.connector.launch("failed", "codex", "fixture-model", "account");
      f.cancellationAvailable(false);
      await expect(f.connector.cancel("failed")).rejects.toThrow();
      const app = new Hono().route(
        "/api",
        createAgentAuthRouterRoutes(f.connector),
      );
      const failed = await app.request(
        "/api/agent-auth-router/retry-cancellations",
        { method: "POST" },
      );
      expect(failed.status).toBe(409);
      expect(await failed.text()).not.toContain("upstream-secret");
      const observed = await app.request("/api/agent-auth-router/recovery");
      expect(await observed.json()).toMatchObject({ pendingCancellations: 1 });
      f.cancellationAvailable(true);
      expect(
        (
          await app.request("/api/agent-auth-router/retry-cancellations", {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      await f.connector.disconnect();
      expect(await f.connector.recovery()).toMatchObject({
        state: "disconnected",
        pendingCancellations: 0,
      });
    });
    it("returns recoverable session errors and refuses disabled account launches before allocation", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      f.disableAccount();
      const app = new Hono();
      app.onError(structuredErrorHandler);
      app.post("/launch", async (c) =>
        c.json(
          await f.connector.launch(
            "session",
            "codex",
            "fixture-model",
            "account",
          ),
        ),
      );
      const response = await app.request("/launch", { method: "POST" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("Re-enable the same account"),
      });
      expect(f.requests.some((r) => r.path.includes("bindings"))).toBe(false);
      const missing = new AgentAuthRouter(f.root);
      await rm(f.socketPath);
      const result = await missing.recovery();
      expect(result).toMatchObject({
        state: "connected",
        reachable: false,
        issue: { code: "unavailable" },
      });
      expect(result.issue?.message).not.toContain(f.root);
    });
  },
);
it("native transport overrides carry no token in Codex arguments or ambient mutations", () => {
  const route = {
    bindingId: "fixture",
    accountId: "account",
    baseUrl: "http://127.0.0.1:8417/codex",
    token: "synthetic-secret",
  };
  const env = {
    OPENAI_API_KEY: "wrong",
    CODEX_ACCESS_TOKEN: "wrong",
    CODEX_HOME: "/fixture",
  };
  expect(codexRouterEnvironment(env, route)).toEqual({
    CODEX_HOME: "/fixture",
    AAR_SESSION_TOKEN: "synthetic-secret",
  });
  expect(env.OPENAI_API_KEY).toBe("wrong");
  expect(codexRouterArguments(route).join(" ")).not.toContain(route.token);
  expect(codexRouterArguments(route)).toContain(
    "model_providers.aar.supports_websockets=false",
  );
  expect(claudeRouterEnvironment(route)).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: route.token,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  });
});

it("router administration and metadata are denied to limited users", () => {
  for (const [method, path] of [
    ["GET", "/api/agent-auth-router"],
    ["POST", "/api/agent-auth-router/connect"],
    ["POST", "/api/agent-auth-router/disconnect"],
    ["GET", "/api/agent-auth-router/recovery"],
    ["POST", "/api/agent-auth-router/retry-cancellations"],
    ["POST", "/api/agent-auth-router/overview"],
    ["POST", "/api/agent-auth-router/overview/refresh"],
    ["POST", "/api/agent-auth-router/pools/save"],
    ["POST", "/api/agent-auth-router/pools/remove"],
    ["GET", "/api/agent-auth-router/accounts/a/catalog"],
    ["GET", "/api/agent-auth-router/accounts/a/quotas"],
  ]) {
    expect(decideLimitedRoute({ method: method!, path: path! })).toEqual({
      kind: "deny",
    });
  }
});

it("refuses account-selection fields on continuation instead of ignoring them", async () => {
  const routes = createSessionsRoutes({
    supervisor: { getProcessForSession: () => ({}) },
    scanner: { getOrCreateProject: async () => ({}) },
  } as unknown as Parameters<typeof createSessionsRoutes>[0]);
  for (const path of [
    "/sessions/session/messages",
    "/projects/L3RtcC9wcm9qZWN0/sessions/session/resume",
  ]) {
    const response = await routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "continue",
        routerAccountId: "different",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("retain their pin"),
    });
  }
});

describe.skipIf(process.platform === "win32")("pool launch recovery", () => {
  it("persists the selection request and chosen pin before commit, then resumes the same allocation", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    f.loseCommit();
    await expect(
      f.connector.launch(
        "pooled",
        "codex",
        "fixture-model",
        undefined,
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "round-robin",
      ),
    ).rejects.toThrow();
    const ref = f.metadata.getMetadata("pooled")?.routerBinding;
    expect(ref).toMatchObject({
      accountId: "account",
      policy: "round-robin",
      reason: "Round robin among eligible accounts",
    });
    const restarted = new AgentAuthRouter(f.root, f.metadata);
    const resumed = await restarted.launch("pooled", "codex", "fixture-model");
    expect(resumed?.accountId).toBe("account");
    const requests = f.requests.filter((r) => r.path === "/v1/pools/prepare");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(requests[1]?.body);
    expect(requests[0]?.body).not.toHaveProperty("accountId");
    expect(JSON.stringify(ref)).not.toContain(resumed?.token);
    await restarted.cancel("pooled");
    await expect(
      restarted.launch("pooled", "codex", "fixture-model"),
    ).rejects.toThrow("cancelled");
  });
  it("cancels a rejected fresh pool allocation and retries cleanup durably", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    f.rejectPoolPrepare();
    f.cancellationAvailable(false);
    await expect(
      f.connector.launch(
        "rejected",
        "codex",
        "fixture-model",
        undefined,
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "round-robin",
      ),
    ).rejects.toThrow();
    const restarted = new AgentAuthRouter(f.root, f.metadata);
    await expect(
      restarted.launch("rejected", "codex", "fixture-model"),
    ).rejects.toThrow();
    f.cancellationAvailable(true);
    await restarted.cancel("rejected");
    await expect(
      restarted.launch("rejected", "codex", "fixture-model"),
    ).rejects.toThrow("cancelled");
    expect(
      f.requests.filter((r) => r.path === "/v1/pools/prepare"),
    ).toHaveLength(1);
  });
  it("gates old AAR before new operations and serves the owner-only pool API", async () => {
    const old = await fixture();
    await old.connector.connect(old.socketPath);
    await expect(old.connector.overview()).rejects.toThrow("Update AAR");
    expect(old.requests.some((r) => r.path === "/v1/overview")).toBe(false);
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    const app = new Hono().route(
      "/api",
      createAgentAuthRouterRoutes(f.connector),
    );
    for (const path of [
      "overview",
      "overview/refresh",
      "pools/save",
      "pools/remove",
    ]) {
      const response = await app.request(`/api/agent-auth-router/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
    }
  });
});

describe.skipIf(process.platform === "win32")("router pool ownership", () => {
  it("projects explicit management authority and rejects writes before forwarding", async () => {
    const f = await fixture(true, true);
    await f.connector.connect(f.socketPath);
    expect((await f.connector.overview()).canManagePools).toBe(false);
    await expect(
      f.connector.removePool({ id: "pool", revision: 1 }),
    ).rejects.toThrow("Manage accounts");
    expect(f.requests.some((r) => r.path === "/v1/pools/remove")).toBe(false);
    const old = await fixture(true);
    await old.connector.connect(old.socketPath);
    expect((await old.connector.overview()).canManagePools).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "Most remaining negotiation",
  () => {
    it("refuses older AAR before allocating and keeps legacy policy discovery", async () => {
      const f = await fixture(true);
      await f.connector.connect(f.socketPath);
      expect((await f.connector.overview()).supportedPolicies).toEqual([
        "manual",
        "round-robin",
      ]);
      await expect(
        f.connector.launch(
          "new",
          "codex",
          "fixture-model",
          undefined,
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "most-remaining",
        ),
      ).rejects.toThrow("Update AAR");
      expect(f.requests.some((r) => r.path === "/v1/pools/prepare")).toBe(
        false,
      );
      await expect(
        f.connector.overview({ policy: "most-remaining" }),
      ).rejects.toThrow("Update AAR");
    });
    it("advertises admission refresh and explicitly negotiates new pool selection", async () => {
      const f = await fixture(true, true, true);
      await f.connector.connect(f.socketPath);
      expect(await f.connector.overview()).toMatchObject({
        supportedPolicies: ["manual", "round-robin", "most-remaining"],
        admissionRefresh: true,
      });
      await f.connector.launch(
        "new",
        "codex",
        "fixture-model",
        undefined,
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "most-remaining",
      );
      expect(
        f.requests.find((r) => r.path === "/v1/pools/prepare")?.body,
      ).toMatchObject({
        policy: "most-remaining",
        supportedPolicies: ["manual", "round-robin", "most-remaining"],
      });
    });
  },
);
