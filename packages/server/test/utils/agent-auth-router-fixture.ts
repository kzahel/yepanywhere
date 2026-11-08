import { chmod, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAuthRouter } from "../../src/services/AgentAuthRouter.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { createTestSessionMetadataService } from "./session-metadata-database.js";

/**
 * A fake AAR control socket plus a connector over it. Pass `metadata` to
 * share a session metadata service with a Supervisor under test.
 */
export const ROUTER_POLICIES = [
  { id: "manual", label: "Manual" },
  { id: "round-robin", label: "Round robin" },
  { id: "weekly-pace", label: "Weekly pace" },
];
export async function agentAuthRouterFixture(
  cleanups: (() => Promise<void>)[],
  pools = false,
  ownerManaged = false,
  mostRemaining = false,
  /** A router that lists and labels its own policies (AAR 2026-10-11). */
  policyList = false,
  sharedMetadata?: SessionMetadataService,
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
    rejectPrepare: string | false = false,
    enabled = true,
    accountName: string | undefined,
    poolName: string | undefined,
    overviewAccounts: unknown[] = [],
    cliModels = false,
    serviceTiers = false,
    loginLapsed = false,
    accountProvider = "codex",
    gatewayTokenHeader = false;
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
            ...(serviceTiers ? ["service-tiers-v1"] : []),
            ...(pools ? ["pools-v1"] : []),
            ...(mostRemaining
              ? ["most-remaining-v1", "admission-refresh-v1"]
              : []),
            ...(ownerManaged ? ["router-owned-pools-v1"] : []),
            ...(cliModels ? ["catalog-cli-models-v1"] : []),
            ...(gatewayTokenHeader ? ["gateway-token-header-v1"] : []),
          ],
          ...(policyList
            ? {
                supportedPolicies: ROUTER_POLICIES.map((p) => p.id),
                policies: ROUTER_POLICIES,
              }
            : {}),
        }),
      );
    if (revoked) {
      res.statusCode = 401;
      return res.end("{}");
    }
    if (req.url === "/v1/catalog" && loginLapsed) {
      res.statusCode = 409;
      return res.end(
        JSON.stringify({
          error:
            "Account login expired or was cleared; sign in to this account again in AAR",
          code: "login_required",
          accountId: "account",
          loginExpiresAt: "2026-11-03T04:11:58.985Z",
        }),
      );
    }
    if (req.url === "/v1/pools/prepare" && rejectPrepare !== false) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: rejectPrepare }));
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
          accounts: overviewAccounts,
          pools: poolName
            ? [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: poolName }]
            : [],
          observedAt: "2026-10-03T08:00:00Z",
          quotaFreshSeconds: 120,
          ...(policyList
            ? {
                supportedPolicies: ROUTER_POLICIES.map((p) => p.id),
                policies: ROUTER_POLICIES,
              }
            : {}),
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
            ...(serviceTiers
              ? {
                  serviceTiers: [
                    { id: "priority", name: "Fast", description: "" },
                  ],
                }
              : {}),
            supportsEffort: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "ultra", description: "Maximum" },
            ],
          },
        ],
        accounts: [
          {
            id: "account",
            provider: accountProvider,
            enabled,
            renewal: "manual",
            ...(accountName ? { displayName: accountName } : {}),
          },
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
  const metadata = sharedMetadata ?? createTestSessionMetadataService(root);
  if (!sharedMetadata) await metadata.initialize();
  const connector = new AgentAuthRouter(root, metadata);
  return {
    root,
    socketPath,
    requests,
    metadata,
    connector,
    serviceTiers: (supported = true) => {
      serviceTiers = supported;
    },
    identity: () => {
      routerId = "replacement";
    },
    rejectPoolPrepare: (
      reason = "no eligible pool account; refresh usage or choose Manual",
    ) => {
      rejectPrepare = reason;
    },
    acceptPoolPrepare: () => {
      rejectPrepare = false;
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
    lapseLogin: () => {
      loginLapsed = true;
    },
    claudeAccount: () => {
      accountProvider = "claude";
    },
    gatewayTokenHeader: (supported = true) => {
      gatewayTokenHeader = supported;
    },
    name: (account: string, pool?: string) => {
      accountName = account;
      poolName = pool;
    },
    revoke: () => {
      revoked = true;
    },
    overviewAccounts: (accounts: unknown[], advertised: boolean) => {
      overviewAccounts = accounts;
      cliModels = advertised;
    },
  };
}

/** `agentAuthRouterFixture` bound to a test file's cleanup list. */
export function routerFixtureFor(cleanups: (() => Promise<void>)[]) {
  return (
    ...args: Parameters<typeof agentAuthRouterFixture> extends [
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never
  ) => agentAuthRouterFixture(cleanups, ...args);
}
