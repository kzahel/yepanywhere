import { Hono } from "hono";
import type { ArtifactServer } from "../artifacts/ArtifactServer.js";

export function createVhostOauthProviderRoutes(server: ArtifactServer) {
  const routes = new Hono();
  routes.onError((error, c) => c.json({ error: error.message }, 400));
  routes.put("/artifacts/vhosts/oauth/providers/:id", async (c) => {
    await server.vhostOauth.configure(await c.req.json(), c.req.param("id"));
    return c.json(server.vhostOauth.status());
  });
  routes.put("/artifacts/vhosts/oauth/providers/:id/enabled", async (c) => {
    const body = await c.req.json<{ enabled?: unknown }>();
    await server.vhostOauth.setProviderEnabled(c.req.param("id"), body.enabled);
    return c.json(server.vhostOauth.status());
  });
  routes.delete("/artifacts/vhosts/oauth/providers/:id", async (c) => {
    await server.vhostOauth.removeProvider(c.req.param("id"));
    return c.json(server.vhostOauth.status());
  });
  return routes;
}
