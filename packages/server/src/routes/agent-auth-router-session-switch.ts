import type { Hono } from "hono";
import { hasHostedProviderRuntime } from "../sdk/providers/provider-runtime-host.js";
import type { AgentAuthRouter } from "../services/AgentAuthRouter.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export type SessionSwitchSupervisor = () => Pick<
  Supervisor,
  "getProcessForSession" | "abortSessionWithVerification"
>;

const POOL = /^[a-f0-9-]{36}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Move an existing session to a pool account or to Direct
 * (docs/tactical/185-switch-session-router-account.md). Lives under the
 * router namespace, which limited users are already denied.
 */
export function registerAgentAuthRouterSessionSwitchRoute(
  routes: Hono,
  router: AgentAuthRouter,
  getSupervisor: SessionSwitchSupervisor,
) {
  routes.post("/agent-auth-router/sessions/:sessionId/switch", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{
      routerPoolId?: unknown;
      routerAccountId?: unknown;
      direct?: unknown;
    }>();
    const direct = body.direct === true;
    const target =
      !direct &&
      typeof body.routerPoolId === "string" &&
      POOL.test(body.routerPoolId) &&
      typeof body.routerAccountId === "string" &&
      ACCOUNT.test(body.routerAccountId)
        ? { poolId: body.routerPoolId, accountId: body.routerAccountId }
        : null;
    if (
      !target &&
      (!direct ||
        body.routerPoolId !== undefined ||
        body.routerAccountId !== undefined)
    )
      return c.json({ error: "Choose a pool account or Direct" }, 400);
    const saved = router.metadata;
    const metadata = saved?.getMetadata(sessionId);
    if (!saved || !metadata) return c.json({ error: "Session not found" }, 404);
    const supervisor = getSupervisor();
    const process = supervisor.getProcessForSession(sessionId);
    const provider =
      metadata.routerBinding?.provider ??
      metadata.provider ??
      process?.provider;
    if (provider !== "claude" && provider !== "codex")
      return c.json(
        { error: "Only Claude and Codex sessions can use router accounts" },
        409,
      );
    // A retained runtime not yet reattached would keep the old pin's token.
    if (!process && hasHostedProviderRuntime(sessionId))
      return c.json(
        {
          error:
            "This session's provider is still reconnecting. Try again in a moment.",
        },
        409,
      );
    if (metadata.executor || metadata.sandboxLevel === "project-write")
      return c.json(
        { error: "Router sessions require a local unsandboxed owner launch" },
        409,
      );
    if (!target && !metadata.routerBinding)
      return c.json({ routerBinding: null });
    const settings = metadata.effectiveLaunchSettings;
    const requested = settings?.requestedModel ?? metadata.requestedModel;
    const result = await router.switchBinding(
      sessionId,
      target,
      {
        provider,
        models: [
          process?.resolvedModel,
          requested === "default" ? undefined : (requested ?? undefined),
        ],
        thinking: settings?.thinking ?? undefined,
        effort: settings?.effort ?? undefined,
        serviceTier: settings?.serviceTier ?? undefined,
      },
      () => supervisor.abortSessionWithVerification(sessionId),
    );
    // The router refuses aliases such as "opus", so the resume names the
    // concrete model the new pin was checked against.
    if (result.model && result.model !== requested)
      await saved.setRequestedModel(sessionId, result.model);
    return c.json({ routerBinding: result.routerBinding });
  });
}
