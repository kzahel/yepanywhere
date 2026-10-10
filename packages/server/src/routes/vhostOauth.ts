import { Hono } from "hono";
import type { ArtifactServer } from "../artifacts/ArtifactServer.js";
import { createVhostOauthProviderRoutes } from "./vhostOauthProviders.js";

export function createVhostOauthRoutes(server: ArtifactServer) {
  const routes = new Hono();
  routes.route("/", createVhostOauthProviderRoutes(server));
  routes.get("/artifacts/vhosts/oauth", async (c) => {
    await server.ready;
    return c.json(server.vhostOauth.status());
  });
  routes.put("/artifacts/vhosts/oauth", async (c) => {
    try {
      await server.vhostOauth.configure(await c.req.json());
      return c.json(server.vhostOauth.status());
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to save OAuth settings",
        },
        400,
      );
    }
  });
  routes.put("/artifacts/vhosts/:name/oauth", async (c) => {
    try {
      const body = await c.req.json<{ emails?: unknown }>();
      await server.vhostOauth.setPolicy(c.req.param("name"), body.emails);
      return c.json(server.vhostOauth.status());
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to save OAuth access",
        },
        400,
      );
    }
  });
  routes.put("/artifacts/vhosts/oauth/enabled", async (c) => {
    try {
      const body = await c.req.json<{ enabled?: unknown }>();
      await server.vhostOauth.setEnabled(body.enabled);
      return c.json(server.vhostOauth.status());
    } catch {
      return c.json(
        { error: "Unable to change hosted sign-in availability" },
        400,
      );
    }
  });
  routes.get("/artifacts/vhosts/oauth/log", async (c) => {
    await server.ready;
    const entries = server.vhostOauth.logs(c.req.query("host"));
    if (c.req.query("download") === "1")
      return new Response(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition":
              'attachment; filename="vhost-oauth-access.jsonl"',
            "Cache-Control": "no-store",
          },
        },
      );
    return c.json({ entries });
  });
  return routes;
}
