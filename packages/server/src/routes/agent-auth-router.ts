import { registerAgentAuthRouterPoolRoutes } from "./agent-auth-router-pools.js";
import { Hono } from "hono";
import {
  type AgentAuthRouter,
  RouterUnavailable,
} from "../services/AgentAuthRouter.js";
import { registerAgentAuthRouterRecoveryRoutes } from "./agent-auth-router-recovery.js";
/** Existing /api authorization denies this administration namespace to limited users. */
export function createAgentAuthRouterRoutes(router: AgentAuthRouter) {
  const routes = new Hono();
  routes.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof RouterUnavailable
            ? error.message
            : "Local router operation failed",
      },
      409,
    ),
  );
  routes.get("/agent-auth-router", (c) => c.json(router.summary()));
  routes.post("/agent-auth-router/selection", async (c) =>
    c.json(await router.selection((await c.req.json()).provider)),
  );
  registerAgentAuthRouterRecoveryRoutes(routes, router);
  registerAgentAuthRouterPoolRoutes(routes, router);
  routes.post("/agent-auth-router/connect", async (c) => {
    const body = await c.req.json<{ socketPath?: unknown }>();
    if (
      body.socketPath !== undefined &&
      (typeof body.socketPath !== "string" || body.socketPath.length > 1024)
    )
      return c.json({ error: "Invalid socket path" }, 400);
    return c.json(await router.connect(body.socketPath as string | undefined));
  });
  routes.post("/agent-auth-router/disconnect", async (c) =>
    c.json(await router.disconnect()),
  );
  routes.get("/agent-auth-router/accounts", async (c) =>
    c.json(await router.accounts()),
  );
  routes.get("/agent-auth-router/accounts/:id/catalog", async (c) =>
    c.json(await router.catalog(c.req.param("id"))),
  );
  routes.get("/agent-auth-router/accounts/:id/quotas", async (c) =>
    c.json(await router.quotas(c.req.param("id"))),
  );
  return routes;
}
