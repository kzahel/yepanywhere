import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { decideLimitedRoute } from "../src/auth/limitedUserPolicy.js";
import type { Supervisor } from "../src/supervisor/Supervisor.js";
import type { ProjectScanner } from "../src/projects/scanner.js";
import { createProcessesRoutes } from "../src/routes/processes.js";
import { createSessionsRoutes } from "../src/routes/sessions.js";
import { createAgentAuthRouterRoutes } from "../src/routes/agent-auth-router.js";
import { AgentAuthRouter } from "../src/services/AgentAuthRouter.js";
import { structuredErrorHandler } from "../src/middleware/error-handler.js";
import {
  codexRouterArguments,
  codexRouterEnvironment,
  claudeRouterEnvironment,
} from "../src/sdk/providers/router-transport.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
  openTestDiscoveryDatabase,
} from "./utils/session-metadata-database.js";
import {
  ROUTER_POLICIES,
  routerFixtureFor,
} from "./utils/agent-auth-router-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  closeTestDiscoveryDatabases();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = routerFixtureFor(cleanups);
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
    it("negotiates speed support, retains allocation identity and validates the pinned account on changes", async () => {
      const f = await fixture(true, true, true);
      await f.connector.connect(f.socketPath);
      await expect(
        f.connector.launch(
          "old-router",
          "codex",
          "fixture-model",
          undefined,
          "pool",
          undefined,
          { serviceTier: "priority" },
        ),
      ).rejects.toThrow("Update AAR");
      expect(f.requests.some((r) => r.path === "/v1/pools/prepare")).toBe(
        false,
      );
      f.serviceTiers();
      expect((await f.connector.selection("codex"))?.serviceTierSelection).toBe(
        true,
      );
      const launch = await f.connector.launch(
        "speed-session",
        "codex",
        "fixture-model",
        undefined,
        "pool",
        undefined,
        { serviceTier: "priority" },
      );
      expect(codexRouterArguments(launch)).toContain(
        "features.api_key_model_discovery=true",
      );
      const routes = createProcessesRoutes({
        supervisor: {
          getProcess: () => ({
            sessionId: "speed-session",
            supportedModels: async () => launch.models,
          }),
        } as unknown as Supervisor,
        scanner: {} as ProjectScanner,
        readerFactory: () => {
          throw new Error("Unused reader");
        },
        sessionMetadataService: f.metadata,
        agentAuthRouter: f.connector,
      });
      expect(
        await (await routes.request("/speed-process/models")).json(),
      ).toMatchObject({ serviceTierSelection: true, models: launch.models });
      await f.connector.validateSessionSettings(
        "speed-session",
        "fixture-model",
        { serviceTier: "priority" },
      );
      await expect(
        f.connector.validateSessionSettings("speed-session", "fixture-model", {
          serviceTier: "ultrafast",
        }),
      ).rejects.toThrow("speed tier");
      await f.connector.launch(
        "speed-session",
        "codex",
        "fixture-model",
        undefined,
        undefined,
        undefined,
        {},
      );
      const requests = f.requests.filter((r) => r.path === "/v1/pools/prepare");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.body.serviceTier).toBe("priority");
      expect(requests[1]?.body).toEqual(requests[0]?.body);
      f.serviceTiers(false);
      expect(
        await (await routes.request("/speed-process/models")).json(),
      ).toMatchObject({ serviceTierSelection: false });
      await expect(
        f.connector.launch(
          "speed-session",
          "codex",
          "fixture-model",
          undefined,
          undefined,
          undefined,
          { serviceTier: "priority" },
        ),
      ).rejects.toThrow("Update AAR");
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
    it("persists before prepare, recovers response loss and resumes the exact token", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      f.loseCommit();
      await expect(
        f.connector.launch(
          "public-session",
          "codex",
          "fixture-model",
          "account",
        ),
      ).rejects.toThrow();
      const ref = f.metadata.getMetadata("public-session")?.routerBinding;
      expect(ref?.accountId).toBe("account");
      const first = await f.connector.launch(
        "public-session",
        "codex",
        "fixture-model",
        "account",
      );
      const freshMetadata = createTestSessionMetadataService(f.root);
      await freshMetadata.initialize();
      const fresh = new AgentAuthRouter(f.root, freshMetadata);
      const resumed = await fresh.launch(
        "public-session",
        "codex",
        "fixture-model",
      );
      expect(resumed).toEqual(first);
      const prepares = f.requests.filter((r) => r.path.endsWith("prepare"));
      expect(new Set(prepares.map((r) => r.body.id)).size).toBe(1);
      expect(prepares[0]?.body.tokenHash).toBe(
        createHash("sha256").update(first!.token).digest("hex"),
      );
      expect(JSON.stringify(f.connector.summary())).not.toContain(first!.token);
      const persistedMetadata = openTestDiscoveryDatabase(f.root)
        .prepare("SELECT extra FROM session_metadata")
        .all<{ extra: string }>()
        .map((row) => row.extra)
        .join("\n");
      expect(persistedMetadata).toContain('"accountId":"account"');
      expect(persistedMetadata).not.toContain(first!.token);
      await expect(
        fresh.launch("public-session", "codex", "fixture-model", "different"),
      ).rejects.toThrow("pin cannot change");
      await fresh.disconnect();
      await expect(
        fresh.launch("public-session", "codex", "fixture-model"),
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
      // The UI learns the socket is custom without receiving its path.
      expect(f.connector.summary()).toMatchObject({ customSocket: true });
      expect(JSON.stringify(f.connector.summary())).not.toContain(f.socketPath);
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
    it("names the pinned account whose AAR login lapsed instead of a generic refusal", async () => {
      const f = await fixture();
      await f.connector.connect(f.socketPath);
      f.name("kyle");
      await f.connector.launch("session", "codex", "fixture-model", "account");
      f.lapseLogin();
      const app = new Hono();
      app.onError(structuredErrorHandler);
      app.post("/resume", async (c) =>
        c.json(await f.connector.launch("session", "codex", undefined)),
      );
      const response = await app.request("/resume", { method: "POST" });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(
        "The pinned router account (kyle) needs to sign in again: its login in AAR expired or was cleared. Sign that account in again in AAR, then retry. This session's pin will not change.",
      );
      expect(f.metadata.getMetadata("session")?.routerBinding?.accountId).toBe(
        "account",
      );
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
    ENABLE_TOOL_SEARCH: "true",
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
    ["POST", "/api/agent-auth-router/sessions/s/switch"],
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
  it("gives a copy its own manual binding for the parent's account", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    const pool = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const parent = await f.connector.launch(
      "parent",
      "codex",
      "fixture-model",
      undefined,
      pool,
      "round-robin",
    );
    f.connector.assertInheritable("parent");
    await f.connector.inheritBinding("parent", "child");
    const parentRef = f.metadata.getMetadata("parent")?.routerBinding;
    const childRef = f.metadata.getMetadata("child")?.routerBinding;
    expect(childRef).toMatchObject({
      accountId: "account",
      poolId: pool,
      policy: "manual",
    });
    expect(childRef?.id).not.toBe(parentRef?.id);
    // No router call until the child first launches.
    const preparesBefore = f.requests.filter(
      (r) => r.path === "/v1/pools/prepare",
    ).length;
    expect(preparesBefore).toBe(1);

    const child = await f.connector.launch("child", "codex", "fixture-model");
    expect(child?.accountId).toBe("account");
    expect(child?.bindingId).toBe(childRef?.id);
    expect(child?.token).not.toBe(parent?.token);
    const childPrepare = f.requests.filter(
      (r) => r.path === "/v1/pools/prepare",
    )[1]?.body;
    expect(childPrepare).toMatchObject({
      id: childRef?.id,
      poolId: pool,
      policy: "manual",
      accountId: "account",
    });
    expect(
      f.requests.filter(
        (r) => r.path === "/v1/bindings/commit" && r.body.id === childRef?.id,
      ),
    ).toHaveLength(1);
    // The parent keeps its own pin and token.
    const resumedParent = await f.connector.launch(
      "parent",
      "codex",
      "fixture-model",
    );
    expect(resumedParent?.token).toBe(parent?.token);
  });
  it("keeps an inherited binding retryable when the router rejects its first launch", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    await f.connector.launch(
      "parent",
      "codex",
      "fixture-model",
      undefined,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "round-robin",
    );
    await f.connector.inheritBinding("parent", "child");
    const childId = f.metadata.getMetadata("child")?.routerBinding?.id;
    f.rejectPoolPrepare(
      "manual account is not eligible; refresh pool overview",
    );
    await expect(
      f.connector.launch("child", "codex", "fixture-model"),
    ).rejects.toThrow("not eligible");
    expect(
      f.requests.some(
        (r) => r.path === "/v1/bindings/cancel" && r.body.id === childId,
      ),
    ).toBe(false);
    f.acceptPoolPrepare();
    const retried = await f.connector.launch("child", "codex", "fixture-model");
    expect(retried?.bindingId).toBe(childId);
  });
  it("fails closed without metadata storage", async () => {
    const f = await fixture(true);
    const bare = new AgentAuthRouter(f.root);
    await expect(bare.inheritBinding("parent", "child")).rejects.toThrow(
      "metadata unavailable",
    );
  });
  it("refuses to copy a pin it cannot keep, leaving the copy unable to launch", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    await f.connector.launch(
      "parent",
      "codex",
      "fixture-model",
      undefined,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "round-robin",
    );
    await f.connector.cancel("parent");
    expect(() => f.connector.assertInheritable("parent")).toThrow(
      "lost its router binding",
    );
    // A copy made anyway is pinned to a binding that does not exist.
    await expect(f.connector.inheritBinding("parent", "child")).rejects.toThrow(
      "lost its router binding",
    );
    expect(f.metadata.getMetadata("child")?.routerBinding).toBeDefined();
    await expect(
      f.connector.launch("child", "codex", "fixture-model"),
    ).rejects.toThrow("cannot use a different account");
  });
  it("keeps account and pool labels for recovery while the pin stays the ids", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    f.name("Work\u0007 Claude", "work-claude");
    const pool = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await f.connector.launch(
      "named",
      "codex",
      "fixture-model",
      undefined,
      pool,
    );
    expect(f.metadata.getMetadata("named")?.routerBinding).toMatchObject({
      accountId: "account",
      accountDisplayName: "Work Claude",
      poolId: pool,
      poolName: "work-claude",
    });
    f.name("Renamed", "ignored-after-first-save");
    await f.connector.launch("named", "codex", "fixture-model");
    expect(f.metadata.getMetadata("named")?.routerBinding).toMatchObject({
      accountId: "account",
      accountDisplayName: "Renamed",
      poolName: "work-claude",
    });
    f.disableAccount();
    await expect(
      f.connector.launch("named", "codex", "fixture-model"),
    ).rejects.toThrow("pinned router account (Renamed) is disabled");
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
    ).rejects.toThrow(
      "Router rejected the operation (no eligible pool account; refresh usage or choose Manual).",
    );
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
  it("keeps unusual router refusal text out of session errors", async () => {
    for (const reason of [
      "token sk-ant-oat01-SECRET",
      "see /Users/someone/.agent-auth-router",
      "<b>markup</b>",
      "x".repeat(161),
    ]) {
      const f = await fixture(true);
      await f.connector.connect(f.socketPath);
      f.rejectPoolPrepare(reason);
      const error = await f.connector
        .launch(
          "rejected",
          "codex",
          "fixture-model",
          undefined,
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "round-robin",
        )
        .catch((e: Error) => e);
      expect((error as Error).message).toMatch(
        /^Router rejected the operation\. /,
      );
    }
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
  "router policy pass-through",
  () => {
    it("offers the router's policies and labels and sends any policy it lists", async () => {
      const f = await fixture(true, true, true, true);
      await f.connector.connect(f.socketPath);
      expect(await f.connector.overview()).toMatchObject({
        supportedPolicies: ["manual", "round-robin", "weekly-pace"],
        policies: ROUTER_POLICIES,
        admissionRefresh: true,
      });
      await f.connector.launch(
        "new",
        "codex",
        "fixture-model",
        undefined,
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "weekly-pace",
      );
      expect(
        f.requests.find((r) => r.path === "/v1/pools/prepare")?.body,
      ).toMatchObject({
        policy: "weekly-pace",
        supportedPolicies: ["manual", "round-robin", "weekly-pace"],
      });
      // The fixture router answers round-robin; its label is kept on the pin.
      expect(f.metadata.getMetadata("new")?.routerBinding).toMatchObject({
        policy: "round-robin",
        policyLabel: "Round robin",
      });
    });
    it("leaves policy decisions to an older router that lists none", async () => {
      const f = await fixture(true);
      await f.connector.connect(f.socketPath);
      expect((await f.connector.overview()).supportedPolicies).toBeUndefined();
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
        supportedPolicies: ["manual", "round-robin"],
      });
    });
  },
);

describe.skipIf(process.platform === "win32")("router CLI model rows", () => {
  // The selection fixture checked in by agent-auth-router's contract test.
  const contract = JSON.parse(
    readFileSync(
      new URL(
        "../../shared/test/fixtures/aar-selection-claude.json",
        import.meta.url,
      ),
      "utf-8",
    ),
  ) as { accounts: Record<string, unknown>[] };

  it("maps advertised Claude rows like the direct list and drops the rest", async () => {
    const f = await fixture(true);
    await f.connector.connect(f.socketPath);
    const claude = contract.accounts[0]!;
    const hostile = {
      ...claude,
      id: "hostile",
      cliModels: [
        { value: "x".repeat(201), displayName: "dropped" },
        { value: "sonnet", displayName: "N".repeat(500), extra: "dropped" },
      ],
    };
    const codex = { ...claude, id: "codex", provider: "codex" };
    f.overviewAccounts([claude, hostile, codex], true);

    const selection = await f.connector.selection("claude");
    const [mapped, bounded, other] = selection!.accounts;
    expect(mapped?.cliModelsAt).toBe(claude.cliModelsAt);
    expect(
      mapped?.cliModels?.map((m) => [m.id, m.resolvedModel ?? null]),
    ).toEqual(
      expect.arrayContaining([
        ["default", "claude-opus-fixture-2"],
        ["sonnet", "claude-sonnet-fixture-2"],
        ["haiku", "claude-haiku-fixture-1"],
        ["opusplan", null],
      ]),
    );
    expect(
      mapped?.cliModels?.find((m) => m.id === "sonnet")?.description,
    ).toBeTruthy();
    // Like the direct list, rows the CLI did not report come from YA's
    // fallback and carry no launch target.
    const sonnet = bounded?.cliModels?.find((m) => m.id === "sonnet");
    expect(sonnet).toMatchObject({ name: "N".repeat(200) });
    expect(sonnet).not.toHaveProperty("extra");
    expect(bounded?.cliModels?.some((m) => m.id.length > 200)).toBe(false);
    expect(bounded?.cliModels?.filter((m) => m.resolvedModel)).toEqual([]);
    expect(other).not.toHaveProperty("cliModels");
    expect(other).not.toHaveProperty("cliModelsAt");
    expect(
      (await f.connector.overview()).accounts[0]?.cliModels?.length,
    ).toBeGreaterThan(0);

    const old = await fixture(true);
    await old.connector.connect(old.socketPath);
    old.overviewAccounts([claude], false);
    const [unadvertised] = (await old.connector.selection("claude"))!.accounts;
    expect(unadvertised).not.toHaveProperty("cliModels");
    expect(unadvertised).not.toHaveProperty("cliModelsAt");
    expect((await old.connector.overview()).accounts[0]).not.toHaveProperty(
      "cliModels",
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "claude.ai connectors in routed sessions",
  () => {
    const pool = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    it("keeps the login only with router support and a claude.ai login, for resumes and copies", async () => {
      const f = await fixture(true);
      f.claudeAccount();
      f.gatewayTokenHeader();
      await f.connector.connect(f.socketPath);
      let login: { email?: string } | null = { email: "me@example.test" };
      const connector = new AgentAuthRouter(
        f.root,
        f.metadata,
        async () => login,
      );
      expect((await connector.selection("claude"))?.claudeAiConnectors).toEqual(
        { login: { email: "me@example.test" } },
      );
      expect(
        (await connector.selection("codex"))?.claudeAiConnectors,
      ).toBeUndefined();

      const routed = await connector.launch(
        "routed",
        "claude",
        "fixture-model",
        undefined,
        pool,
        "round-robin",
        { routerClaudeAiConnectors: true },
      );
      expect(routed?.claudeAiConnectors).toBe(true);
      expect(
        f.metadata.getMetadata("routed")?.routerBinding?.claudeAiConnectors,
      ).toBe(true);
      const env = claudeRouterEnvironment(
        routed!,
        `x-team: blue\nx-aar-gateway-token: stale`,
      );
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        `x-team: blue\nx-aar-gateway-token: ${routed!.token}`,
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");

      // No login: the resumed pin keeps its token-only transport.
      login = null;
      expect((await connector.selection("claude"))?.claudeAiConnectors).toEqual(
        { login: null },
      );
      const withoutLogin = await connector.launch(
        "routed",
        "claude",
        "fixture-model",
      );
      expect(withoutLogin?.token).toBe(routed?.token);
      expect(withoutLogin).not.toHaveProperty("claudeAiConnectors");
      expect(claudeRouterEnvironment(withoutLogin!)).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: routed!.token,
      });
      expect(claudeRouterEnvironment(withoutLogin!)).not.toHaveProperty(
        "ANTHROPIC_CUSTOM_HEADERS",
      );

      // An older router never receives the header.
      login = { email: "me@example.test" };
      f.gatewayTokenHeader(false);
      expect(
        (await connector.selection("claude"))?.claudeAiConnectors,
      ).toBeUndefined();
      expect(
        await connector.launch("routed", "claude", "fixture-model"),
      ).not.toHaveProperty("claudeAiConnectors");

      f.gatewayTokenHeader();
      await connector.inheritBinding("routed", "copy");
      expect(
        f.metadata.getMetadata("copy")?.routerBinding?.claudeAiConnectors,
      ).toBe(true);
      expect(
        (await connector.launch("copy", "claude", "fixture-model"))
          ?.claudeAiConnectors,
      ).toBe(true);

      const plain = await connector.launch(
        "plain",
        "claude",
        "fixture-model",
        undefined,
        pool,
        "round-robin",
      );
      expect(plain).not.toHaveProperty("claudeAiConnectors");
      expect(f.metadata.getMetadata("plain")?.routerBinding).not.toHaveProperty(
        "claudeAiConnectors",
      );
    });
  },
);
