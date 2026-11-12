import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
  type ModelInfo,
  EMPTY_LIMITED_USER_GRANTS,
} from "@yep-anywhere/shared";
import { PRINCIPAL_VARIABLE, SUPERUSER } from "../../src/auth/principal.js";
import type { ApiPrincipal } from "../../src/core-api/peer-policy.js";
import { CoreApi } from "../../src/core-api/service.js";
import { productionApiSources } from "../../src/core-api/production-sources.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { inspectApiSession } from "../../src/core-api/session-inspection.js";
import type { Process } from "../../src/supervisor/Process.js";
import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";

const model: ModelInfo = {
  id: "release-model",
  name: "Release",
  supportedEffortLevels: ["high"],
  serviceTiers: [{ id: "priority", name: "Fast" }],
};
const overview = {
  observedAt: "2026-11-12T00:00:00Z",
  quotaFreshSeconds: 60,
  serviceTierSelection: true,
  policies: [{ id: "weekly-pace", label: "Weekly pace" }],
  pools: [
    {
      id: "pool",
      name: "Release pool",
      provider: "codex",
      policy: "weekly-pace",
      revision: 1,
      accountIds: ["account"],
      bindings: [],
      credential: "never expose",
    },
  ],
  accounts: [
    {
      id: "account",
      provider: "codex",
      displayName: "Release account",
      enabled: true,
      renewal: "auto",
      freshness: "fresh",
      catalogAt: null,
      models: [model],
      attemptedAt: null,
      error: null,
      quota: null,
      windows: [],
      token: "never expose",
    },
  ],
  socketPath: "/private/router.sock",
} as unknown as AgentAuthRouterOverview;

it("discovers scoped choices on demand, strips private fields and denies ungranted discovery before touching AAR", async () => {
  const discover = vi.fn(async () => overview);
  const direct = vi.fn(async () => [model]);
  const sources = productionApiSources({
    scanner: {
      readRetainedProjects: async () => ({
        projects: [],
        complete: true,
        refreshing: false,
      }),
    },
    sessions: {
      read: async () => ({
        rows: [],
        catalog: {
          catalogEpoch: "fixture",
          catalogGeneration: 1,
          complete: true,
          refreshing: false,
        },
      }),
    },
    providers: () => [
      {
        name: "codex",
        displayName: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
        getAvailableModels: direct,
      },
    ],
    agentAuthRouter: { selection: discover },
    hiddenProjects: async () => new Set(),
  });
  let caller: ApiPrincipal = SUPERUSER;
  const api = new CoreApi("A", sources);
  const app = new Hono<{ Variables: { yaPrincipal: ApiPrincipal } }>();
  app.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, caller);
    await next();
  });
  app.route("/v0", createV0Routes(api));
  await app.request("/v0/servers/self/providers");
  expect(discover).not.toHaveBeenCalled();
  expect(direct).not.toHaveBeenCalled();
  const response = await app.request(
    "/v0/servers/self/selection?provider=codex",
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    available: true,
    pools: [{ id: "pool" }],
    accounts: [{ models: [model] }],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /never expose|socketPath|bindings|renewal/,
  );
  expect(direct).not.toHaveBeenCalled();
  const directResult = await (
    await app.request("/v0/servers/A/selection?provider=codex&routing=direct")
  ).json();
  expect(directResult).toMatchObject({ routing: "direct", models: [model] });
  for (const query of ["", "?provider=other", "?provider=codex&refresh=true"])
    expect((await app.request(`/v0/servers/A/selection${query}`)).status).toBe(
      400,
    );
  expect(
    (await app.request("/v0/servers/unknown/selection?provider=codex")).status,
  ).toBe(404);
  discover.mockRejectedValueOnce(new Error("private router details"));
  const failure = await app.request("/v0/servers/A/selection?provider=codex");
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("private router details");
  expect(direct).toHaveBeenCalledTimes(1);
  caller = {
    kind: "limited",
    username: "reader",
    grants: EMPTY_LIMITED_USER_GRANTS,
    switched: false,
    locked: true,
    via: "direct",
  };
  expect(
    (await app.request("/v0/servers/self/selection?provider=codex")).status,
  ).toBe(403);
  const access = await (await app.request("/v0/servers/self/access")).json();
  expect(access.operations).not.toContain("selection");
  caller = {
    kind: "peer",
    serverId: "B",
    credentialId: "credential",
    projects: [],
    operations: [],
    sourceSessionId: null,
    sourceLaunchId: null,
    signal: new AbortController().signal,
    assertActive() {},
  };
  expect(
    (await app.request("/v0/servers/self/selection?provider=codex")).status,
  ).toBe(403);
  expect(discover).toHaveBeenCalledTimes(2);
  caller.operations = ["selection"];
  expect(
    (await app.request("/v0/servers/self/selection?provider=codex")).status,
  ).toBe(200);
});

it("distinguishes live applied controls, durable selections, unknown history and safe routing labels", () => {
  const settings = {
    schemaVersion: 1 as const,
    revision: 4,
    requestedModel: "alias",
    thinking: null,
    effort: "high" as const,
    permissionMode: "plan" as const,
    serviceTier: "priority",
  };
  const saved = {
    effectiveLaunchSettings: settings,
    routerBinding: {
      id: "private-pin",
      routerId: "router",
      accountId: "account",
      provider: "codex" as const,
      poolId: "pool",
      poolName: "Release pool",
    },
  };
  const metadata = { getMetadata: () => saved };
  expect(inspectApiSession("s", metadata, undefined)).toMatchObject({
    settings: {
      source: "saved",
      requestedModel: "alias",
      model: null,
      effort: "high",
      permissionMode: "plan",
      serviceTier: "priority",
      revision: 4,
    },
    routing: { mode: "aar", poolId: "pool", accountId: "account" },
  });
  expect(
    inspectApiSession("s", metadata, undefined).routing,
  ).not.toHaveProperty("id");
  const live = {
    isTerminated: false,
    requestedModel: "new-alias",
    resolvedModel: "concrete-model",
    thinking: { type: "adaptive" },
    appliedEffort: "low",
    effort: "max",
    permissionMode: "default",
    serviceTier: undefined,
  } as Process;
  const supervisor = { getProcessForSession: () => live };
  expect(inspectApiSession("s", metadata, supervisor).settings).toMatchObject({
    source: "live",
    requestedModel: "new-alias",
    model: "concrete-model",
    effort: "low",
    serviceTier: null,
  });
  expect(inspectApiSession("s", undefined, undefined)).toMatchObject({
    settings: { source: "unavailable", model: null, permissionMode: null },
    routing: { mode: "unknown" },
  });
  // A terminated owner's stale launch controls must not override durable state.
  expect(
    inspectApiSession("s", metadata, {
      getProcessForSession: () => ({ ...live, isTerminated: true }) as Process,
    }).settings.source,
  ).toBe("saved");
});
