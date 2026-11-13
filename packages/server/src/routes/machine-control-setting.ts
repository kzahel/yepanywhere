import { Hono } from "hono";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";

export type MachineControlSettings = Pick<
  ServerSettingsService,
  "getSetting" | "updateSettings"
>;

/** The operator's default for eligible launches; absent settings mean off. */
export function machineControlEnabled(host: {
  serverSettingsService?: Pick<ServerSettingsService, "getSetting">;
}) {
  return (
    host.serverSettingsService?.getSetting("machineControlEnabled") === true
  );
}

/** Writes the default-advertisement setting. It grants no Machine Control access. */
export function createMachineControlSettingRoutes(
  settings?: MachineControlSettings,
) {
  const routes = new Hono();
  routes.put("/machine-control", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const enabled =
      body && typeof body === "object"
        ? (body as { enabled?: unknown }).enabled
        : undefined;
    if (typeof enabled !== "boolean")
      return c.json({ error: "enabled must be a boolean" }, 400);
    if (!settings)
      return c.json({ error: "Server settings are unavailable" }, 503);
    await settings.updateSettings({ machineControlEnabled: enabled });
    return c.json({
      enabled: machineControlEnabled({ serverSettingsService: settings }),
    });
  });
  return routes;
}
