import { Hono } from "hono";
import { z } from "zod";
import type { ComputerControlService } from "../computer-control/service.js";

const preview = z
  .object({
    packageDirectory: z.string().min(1).max(2048),
    trustedPublisher: z.string().trim().min(1).max(256),
  })
  .strict();
const configuration = z
  .object({
    enabled: z.boolean(),
    idleMs: z.number().int().min(5000).max(240_000),
    grantMs: z.number().int().min(10_000).max(3_600_000),
  })
  .strict();

/** Operator routes inherit the authenticated YA API boundary; no agent endpoint. */
export function createComputerControlRoutes(service: ComputerControlService) {
  const routes = new Hono();
  routes.get("/computer-control", (c) => c.json(service.status()));
  routes.put("/computer-control/settings", async (c) => {
    const parsed = configuration.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: "Invalid computer-control settings" }, 400);
    return c.json(
      await service.configure({ ...service.config(), ...parsed.data }),
    );
  });
  routes.post("/computer-control/install", async (c) => {
    const parsed = preview.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json(
        {
          error:
            "Select a local preview and its independently trusted publisher",
        },
        400,
      );
    return c.json(await service.install(parsed.data));
  });
  routes.post("/computer-control/stop", async (c) => {
    await service.configure({ ...service.config(), enabled: false });
    return c.json(service.status());
  });
  routes.delete("/computer-control/installation", async (c) => {
    await service.uninstall();
    return c.json(service.status());
  });
  routes.delete("/computer-control/sessions/:sessionId", async (c) => {
    await service.revoke(c.req.param("sessionId"));
    return c.json(service.status());
  });
  return routes;
}
