import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import type { CliInstallationFamily } from "@yep-anywhere/shared/provider-cli-installations";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { getCliInstallationService } from "../sdk/cli-installation-context.js";

export function createCliInstallationRoutes(settings: ServerSettingsService) {
  const routes = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();
  const service = getCliInstallationService();
  let changes: Promise<unknown> = Promise.resolve();
  const checkedInventory = async (
    family: CliInstallationFamily,
    force: boolean,
  ) => {
    let error: string | undefined;
    try {
      await service!.resolve(family, undefined, force);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      ...(await service!.inventory(family)),
      ...(error ? { error } : {}),
    };
  };
  routes.use("/:family/*", async (c, next) => {
    const principal = c.get(PRINCIPAL_VARIABLE) as Principal | undefined;
    if (principal?.kind !== "superuser")
      return c.json({ error: "Administrator access required" }, 403);
    if (!["codex", "antigravity"].includes(c.req.param("family") ?? ""))
      return c.json({ error: "Unknown installation family" }, 404);
    if (!service)
      return c.json({ error: "Installation settings unavailable" }, 503);
    await next();
  });
  routes.get("/:family", async (c) => {
    const family = c.req.param("family") as CliInstallationFamily;
    return c.json(await service!.inventory(family));
  });
  routes.post("/:family/rescan", async (c) =>
    c.json(
      await service!.rescan(c.req.param("family") as CliInstallationFamily),
    ),
  );
  routes.put("/:family", async (c) => {
    const family = c.req.param("family") as CliInstallationFamily;
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      !(
        body.path === null ||
        (typeof body.path === "string" &&
          body.path.length <= 4096 &&
          !body.path.includes("\0") &&
          isAbsolute(body.path))
      )
    )
      return c.json(
        { error: "path must be null (Auto) or an absolute executable path" },
        400,
      );
    if ((await service!.inventory(family)).managed)
      return c.json(
        { error: "This installation is managed by an environment override" },
        409,
      );
    const change = changes.then(async () => {
      const selections = { ...settings.getSetting("cliInstallations") };
      if (body.path === null) delete selections[family];
      else selections[family] = body.path;
      await settings.updateSettings({ cliInstallations: selections });
    });
    changes = change.catch(() => {});
    await change;
    return c.json(await checkedInventory(family, false));
  });
  routes.post("/:family/test", async (c) => {
    const family = c.req.param("family") as CliInstallationFamily;
    return c.json(await checkedInventory(family, true));
  });
  return routes;
}
