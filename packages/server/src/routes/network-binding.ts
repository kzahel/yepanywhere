import { Hono } from "hono";
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
  /** Callback to update localhost port (handles server restart) */
  onLocalhostPortChange: (
    port: number,
  ) => Promise<{ success: boolean; error?: string; redirectUrl?: string }>;
  /** Callback to update network socket binding */
  onNetworkBindingChange: (
    config: { host: string; port: number } | null,
  ) => Promise<{ success: boolean; error?: string }>;
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

export function createNetworkBindingRoutes(
  options: NetworkBindingRoutesOptions,
) {
  const {
    networkBindingService,
    eventBus,
    onLocalhostPortChange,
    onNetworkBindingChange,
  } = options;

  const app = new Hono();

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
    try {
      const body = await c.req.json<UpdateBindingRequest>();
      let redirectUrl: string | undefined;

      // Handle localhost port change
      if (body.localhostPort !== undefined) {
        if (networkBindingService.isLocalhostPortOverridden()) {
          return c.json(
            {
              success: false,
              error:
                "Localhost port is configured via command line and cannot be changed",
            } satisfies UpdateBindingResponse,
            400,
          );
        }

        // Try to bind to new port (test-first pattern)
        const result = await onLocalhostPortChange(body.localhostPort);
        if (!result.success) {
          return c.json(
            {
              success: false,
              error: result.error ?? "Failed to bind to new port",
            } satisfies UpdateBindingResponse,
            400,
          );
        }

        // Save the new port setting
        await networkBindingService.setLocalhostPort(body.localhostPort);
        redirectUrl = result.redirectUrl;
      }

      // Handle network socket change
      if (body.network !== undefined) {
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

        // Calculate effective port
        const networkPort =
          body.network.port ?? networkBindingService.getLocalhostPort();
        const networkHost = body.network.host ?? null;

        if (body.network.enabled && networkHost) {
          // Try to bind network socket
          const result = await onNetworkBindingChange({
            host: networkHost,
            port: networkPort,
          });
          if (!result.success) {
            return c.json(
              {
                success: false,
                error: result.error ?? "Failed to bind network socket",
              } satisfies UpdateBindingResponse,
              400,
            );
          }
        } else {
          // Disable network socket
          await onNetworkBindingChange(null);
        }

        // Save the network config
        await networkBindingService.setNetworkConfig({
          enabled: body.network.enabled,
          host: networkHost,
          port: body.network.port ?? null,
        });
      }

      // Emit event for connected clients
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

      return c.json({
        success: true,
        redirectUrl,
      } satisfies UpdateBindingResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json(
        { success: false, error: message } satisfies UpdateBindingResponse,
        400,
      );
    }
  });

  // DELETE /api/network-binding - Disable network socket
  app.delete("/", async (c) => {
    try {
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

      await onNetworkBindingChange(null);
      await networkBindingService.setNetworkConfig({ enabled: false });

      // Emit event
      const state = networkBindingService.getBindingState();
      eventBus.emit({
        type: "network-binding-changed",
        localhostPort: state.localhost.port,
        network: null,
        timestamp: new Date().toISOString(),
      });

      return c.json({ success: true } satisfies UpdateBindingResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.json(
        { success: false, error: message } satisfies UpdateBindingResponse,
        400,
      );
    }
  });

  return app;
}
