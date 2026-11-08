import { type Context, Hono } from "hono";
import {
  listenerChangeImpact,
  plannedPortForCaller,
  refuseUnconfirmedImpact,
} from "../network/connection-impact.js";
import {
  getRequestConnectionPath,
  type RequestConnectionPath,
} from "../network/connection-path.js";
import type {
  ListenerPlan,
  NetworkListenerControl,
} from "../network/listeners.js";
import type {
  NetworkBindingService,
  NetworkInterface,
} from "../services/NetworkBindingService.js";
import type { EventBus } from "../watcher/EventBus.js";

export interface NetworkBindingRoutesOptions {
  /** The NetworkBindingService instance */
  networkBindingService: NetworkBindingService;
  /** EventBus for emitting binding change events */
  eventBus: EventBus;
  /** The live listening sockets; absent until the server has bound them. */
  listeners: () => NetworkListenerControl | undefined;
}

export interface NetworkBindingResponse {
  localhost: { port: number; overriddenByCli: boolean };
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    overriddenByCli: boolean;
  };
  interfaces: NetworkInterface[];
}

export interface UpdateBindingRequest {
  localhostPort?: number;
  network?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
}

export interface UpdateBindingResponse {
  success: boolean;
  error?: string;
  redirectUrl?: string;
}

function isValidPort(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
  );
}

/**
 * Where a browser that loaded the page from the socket being moved finds the
 * server afterward: the same host on the port that now serves its address.
 * Only offered when the browser's URL names that socket's port directly, not
 * through a proxy that maps a different port, and never for tunneled calls.
 */
function redirectForCaller(
  c: Context,
  path: RequestConnectionPath,
  next: ListenerPlan,
): string | undefined {
  if (path.kind !== "listener" || !(c.env as { incoming?: unknown })?.incoming)
    return undefined;
  const port = plannedPortForCaller(path, next);
  if (port === null || port === path.localPort) return undefined;
  try {
    const url = new URL(c.req.url);
    const urlPort =
      url.port === ""
        ? url.protocol === "https:"
          ? 443
          : 80
        : Number(url.port);
    if (urlPort !== path.localPort) return undefined;
    url.port = String(port);
    return url.origin;
  } catch {
    return undefined;
  }
}

export function createNetworkBindingRoutes(
  options: NetworkBindingRoutesOptions,
) {
  const { networkBindingService, eventBus } = options;

  const app = new Hono();

  // A change reads the live listeners, judges its impact, applies and saves
  // as one step, so concurrent changes never plan against stale state.
  let changeTail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(change: () => Promise<T>): Promise<T> => {
    const run = changeTail.then(change);
    changeTail = run.catch(() => undefined);
    return run;
  };

  const emitChanged = () => {
    const state = networkBindingService.getBindingState();
    eventBus.emit({
      type: "network-binding-changed",
      localhostPort: state.localhost.port,
      network: state.network.enabled
        ? {
            enabled: true,
            host: state.network.host,
            port: state.network.port,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  };

  const notReady = (c: Context) =>
    c.json(
      {
        success: false,
        error: "The server has not finished binding its listeners",
      } satisfies UpdateBindingResponse,
      503,
    );

  // GET /api/network-binding - Get current binding state and available interfaces
  app.get("/", (c) => {
    const state = networkBindingService.getBindingState();
    return c.json(state satisfies NetworkBindingResponse);
  });

  // GET /api/network-binding/interfaces - Get available network interfaces
  app.get("/interfaces", (c) => {
    const interfaces = networkBindingService.getInterfaces();
    return c.json({ interfaces });
  });

  // PUT /api/network-binding - Update binding configuration
  app.put("/", async (c) => {
    const listeners = options.listeners();
    if (!listeners) return notReady(c);
    const body = await c.req
      .json<UpdateBindingRequest>()
      .catch(() => null as UpdateBindingRequest | null);
    if (!body || typeof body !== "object") {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }
    if (
      body.localhostPort !== undefined &&
      networkBindingService.isLocalhostPortOverridden()
    ) {
      return c.json(
        {
          success: false,
          error:
            "Localhost port is configured via command line and cannot be changed",
        } satisfies UpdateBindingResponse,
        400,
      );
    }
    if (
      body.network !== undefined &&
      networkBindingService.isNetworkOverridden()
    ) {
      return c.json(
        {
          success: false,
          error:
            "Network binding is configured via command line and cannot be changed",
        } satisfies UpdateBindingResponse,
        400,
      );
    }
    if (
      (body.localhostPort !== undefined && !isValidPort(body.localhostPort)) ||
      (body.network?.port !== undefined && !isValidPort(body.network.port))
    ) {
      return c.json(
        {
          success: false,
          error: "Ports must be whole numbers from 1 to 65535",
        } satisfies UpdateBindingResponse,
        400,
      );
    }

    return serialized(() => applyUpdate(c, listeners, body));
  });

  const applyUpdate = async (
    c: Context,
    listeners: NetworkListenerControl,
    body: UpdateBindingRequest,
  ) => {
    const current = listeners.current();
    const localhostPort = body.localhostPort ?? current.localhostPort;
    const networkHost = body.network?.host ?? null;
    // A socket whose port follows the loopback port (no saved port, or the
    // --host socket) moves with it, as it would after a restart.
    const networkFollowsLoopback =
      current.network !== null &&
      current.network.port === current.localhostPort &&
      (networkBindingService.isNetworkOverridden() ||
        networkBindingService.getNetworkConfig().port == null);
    const next: ListenerPlan = {
      localhostPort,
      network:
        body.network === undefined
          ? current.network && networkFollowsLoopback
            ? { host: current.network.host, port: localhostPort }
            : current.network
          : body.network.enabled && networkHost
            ? { host: networkHost, port: body.network.port ?? localhostPort }
            : null,
    };

    const path = getRequestConnectionPath(c);
    const refusal = refuseUnconfirmedImpact(
      c,
      listenerChangeImpact(path, listeners.activeAddresses(), next),
    );
    if (refusal) return refusal;

    const result = await listeners.apply(next);
    if (!result.success) {
      return c.json(
        { success: false, error: result.error } satisfies UpdateBindingResponse,
        400,
      );
    }

    // Persist only what bound, so a failed change never survives a restart.
    if (body.localhostPort !== undefined) {
      await networkBindingService.setLocalhostPort(body.localhostPort);
    }
    if (body.network !== undefined) {
      await networkBindingService.setNetworkConfig({
        enabled: body.network.enabled,
        host: networkHost,
        port: body.network.port ?? null,
      });
    }
    emitChanged();

    return c.json({
      success: true,
      redirectUrl: redirectForCaller(c, path, next),
    } satisfies UpdateBindingResponse);
  };

  // DELETE /api/network-binding - Disable network socket
  app.delete("/", async (c) => {
    const listeners = options.listeners();
    if (!listeners) return notReady(c);
    if (networkBindingService.isNetworkOverridden()) {
      return c.json(
        {
          success: false,
          error:
            "Network binding is configured via command line and cannot be changed",
        } satisfies UpdateBindingResponse,
        400,
      );
    }

    return serialized(() => disableNetwork(c, listeners));
  });

  const disableNetwork = async (
    c: Context,
    listeners: NetworkListenerControl,
  ) => {
    const next: ListenerPlan = { ...listeners.current(), network: null };
    const refusal = refuseUnconfirmedImpact(
      c,
      listenerChangeImpact(
        getRequestConnectionPath(c),
        listeners.activeAddresses(),
        next,
      ),
    );
    if (refusal) return refusal;

    const result = await listeners.apply(next);
    if (!result.success) {
      return c.json(
        { success: false, error: result.error } satisfies UpdateBindingResponse,
        400,
      );
    }
    await networkBindingService.setNetworkConfig({ enabled: false });
    emitChanged();

    return c.json({ success: true } satisfies UpdateBindingResponse);
  };

  return app;
}
