import type { Hono } from "hono";
import type { AgentAuthRouter } from "../services/AgentAuthRouter.js";

export function registerHostedRouterRoutes(
  routes: Hono,
  router: AgentAuthRouter,
) {
  routes.post("/agent-auth-router/hosted/connect", async (c) => {
    const body = await c.req.json<{ url?: unknown; name?: unknown }>();
    if (
      typeof body.url !== "string" ||
      body.url.length > 2048 ||
      (body.name !== undefined && typeof body.name !== "string")
    )
      return c.json({ error: "Invalid hosted router URL or name" }, 400);
    return c.json(
      await router.connectHosted(body.url, body.name as string | undefined),
    );
  });
  routes.get("/agent-auth-router/hosted/pairing", async (c) =>
    c.json(await router.pairingStatus()),
  );
  routes.post("/agent-auth-router/hosted/cancel", async (c) =>
    c.json(await router.cancelPairing()),
  );
}
