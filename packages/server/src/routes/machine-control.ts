import { RETIRED_COMPUTER_CONTROL_ERROR } from "../machine-control/legacy-retirement.js";
import { type Env, Hono } from "hono";
import {
  MachineControlUnavailable,
  findInstalledMachineControl,
} from "../machine-control/installation.js";
import type { MachineControlDependencies } from "../sdk/providers/machine-control.js";
import {
  type MachineControlSettings,
  createMachineControlSettingRoutes,
  machineControlEnabled,
} from "./machine-control-setting.js";

export { machineControlEnabled };

export function supportsInstalledMachineControl(platform = process.platform) {
  return ["darwin", "win32", "linux"].includes(platform);
}

/** Mounts the routes on a supported host and reports whether it did. */
export function mountMachineControl<E extends Env>(
  app: Hono<E>,
  host: { serverSettingsService?: MachineControlSettings },
) {
  if (!supportsInstalledMachineControl()) return false;
  const settings = host.serverSettingsService;
  app.route("/api", createMachineControlRoutes({ settings }));
  app.route("/api", createMachineControlSettingRoutes(settings));
  return true;
}

/** Read-only installation readiness. Never starts a resident or obtains access. */
export function createMachineControlRoutes(
  dependencies: MachineControlDependencies & {
    settings?: MachineControlSettings;
  } = {},
) {
  const routes = new Hono();
  const enabled = () =>
    machineControlEnabled({ serverSettingsService: dependencies.settings });
  // Old clients get an explicit refusal, never a replacement opt-in.
  routes.all("/computer-control", (c) =>
    c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 410),
  );
  routes.all("/computer-control/*", (c) =>
    c.json({ error: RETIRED_COMPUTER_CONTROL_ERROR }, 410),
  );
  routes.get("/machine-control", async (c) => {
    const platform = dependencies.platform ?? process.platform;
    if (!supportsInstalledMachineControl(platform as NodeJS.Platform))
      return c.json({ available: false, reason: "unsupported-host" });
    try {
      const installation = await findInstalledMachineControl(
        platform,
        dependencies.environment ?? process.env,
        dependencies.verify,
        dependencies.exists,
      );
      return c.json({
        available: true,
        version: installation.version,
        enabled: enabled(),
      });
    } catch (error) {
      // Optional absence and verification failures disclose no private paths.
      return c.json({
        available: false,
        reason: "installation-unavailable",
        found: error instanceof MachineControlUnavailable && error.found,
        enabled: enabled(),
      });
    }
  });
  return routes;
}
