import type { HostAgentProcessesResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  HostAgentProcessService,
  type NativeSessionDescriber,
} from "../services/HostAgentProcessService.js";
import { readNativeProcessSession } from "../services/providerProcessClassifier.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface HostAgentProcessesRoutesDeps {
  /** Immutable deployment ceiling, independent of the editable setting. */
  enabled?: boolean;
  supervisor: Supervisor;
  serverSettingsService: ServerSettingsService;
  service?: HostAgentProcessService;
  /** Titles and links for external processes correlated to a YA session. */
  describeNativeSessions?: NativeSessionDescriber;
}

export function createHostAgentProcessesRoutes(
  deps: HostAgentProcessesRoutesDeps,
) {
  const routes = new Hono();
  const service =
    deps.service ??
    new HostAgentProcessService(
      undefined,
      undefined,
      undefined,
      undefined,
      readNativeProcessSession,
      deps.describeNativeSessions,
    );
  deps.serverSettingsService.onSettingsChanged((settings, previousSettings) => {
    if (
      previousSettings.hostProcessObservabilityEnabled &&
      !settings.hostProcessObservabilityEnabled
    ) {
      service.clear();
    }
  });
  const disabledResponse = (): HostAgentProcessesResponse => ({
    enabled: false,
    supported: service.isSupported(),
    observations: [],
  });

  routes.get("/", async (c) => {
    if (
      deps.enabled === false ||
      !deps.serverSettingsService.getSettings().hostProcessObservabilityEnabled
    ) {
      service.clear();
      return c.json(disabledResponse());
    }

    // Both settlement paths recheck the setting so a toggle that lands while
    // the sample is in flight yields the disabled response regardless of
    // whether that now-obsolete sample resolved or rejected. Without this the
    // rejected-sample race would leak a 503 instead of the off-state contract.
    const respondIfDisabledDuringSample = () => {
      if (
        deps.serverSettingsService.getSettings().hostProcessObservabilityEnabled
      ) {
        return undefined;
      }
      service.clear();
      return c.json(disabledResponse());
    };

    try {
      const response = await service.sample(
        deps.supervisor.getProcessInfoList(),
      );
      return respondIfDisabledDuringSample() ?? c.json(response);
    } catch {
      return (
        respondIfDisabledDuringSample() ??
        c.json({ error: "Host process observation failed" }, 503)
      );
    }
  });

  return routes;
}
