/**
 * Remote access API routes.
 */

import { Hono } from "hono";
import type { RelayClientService } from "../services/RelayClientService.js";
import type { RemoteAccessService } from "./RemoteAccessService.js";
import type { RemoteSessionService } from "./RemoteSessionService.js";

export interface RemoteAccessRoutesOptions {
  remoteAccessService: RemoteAccessService;
  /** Optional session service for invalidating sessions on password change */
  remoteSessionService?: RemoteSessionService;
  /** Optional relay client service for status reporting */
  relayClientService?: RelayClientService;
  /** Callback to update relay connection when config changes */
  onRelayConfigChanged?: () => Promise<void>;
}

export function createRemoteAccessRoutes(
  options: RemoteAccessRoutesOptions,
): Hono {
  const {
    remoteAccessService,
    remoteSessionService,
    relayClientService,
    onRelayConfigChanged,
  } = options;
  const app = new Hono();

  /**
   * GET /api/remote-access/config
   * Get current remote access configuration.
   */
  app.get("/config", async (c) => {
    const config = remoteAccessService.getConfig();
    return c.json(config);
  });

  /**
   * POST /api/remote-access/configure
   * Configure remote access with password.
   * Relay must be configured first (relay username is used as SRP identity).
   * Body: { password: string }
   */
  app.post("/configure", async (c) => {
    try {
      const body = await c.req.json<{ password: string }>();

      if (!body.password) {
        return c.json({ error: "Password is required" }, 400);
      }

      // Get existing username before changing (to invalidate their sessions)
      const existingUsername = remoteAccessService.getUsername();

      await remoteAccessService.configure(body.password);

      // Get the username (relay username) that was used
      const newUsername = remoteAccessService.getUsername();

      // Invalidate all sessions for the username (password changed)
      if (remoteSessionService && existingUsername) {
        const count =
          await remoteSessionService.invalidateUserSessions(existingUsername);
        if (count > 0) {
          console.log(
            `[RemoteAccess] Invalidated ${count} sessions for ${existingUsername}`,
          );
        }
      }

      return c.json({ success: true, username: newUsername });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to configure";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * POST /api/remote-access/enable
   * Enable remote access (must be configured first).
   */
  app.post("/enable", async (c) => {
    try {
      await remoteAccessService.enable();
      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to enable";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * POST /api/remote-access/disable
   * Disable remote access (keeps credentials).
   */
  app.post("/disable", async (c) => {
    try {
      await remoteAccessService.disable();
      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to disable";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * POST /api/remote-access/clear
   * Clear all credentials and disable remote access.
   */
  app.post("/clear", async (c) => {
    try {
      // Get username before clearing to invalidate their sessions
      const existingUsername = remoteAccessService.getUsername();

      await remoteAccessService.clearCredentials();

      // Invalidate all sessions for the user
      if (remoteSessionService && existingUsername) {
        const count =
          await remoteSessionService.invalidateUserSessions(existingUsername);
        if (count > 0) {
          console.log(
            `[RemoteAccess] Invalidated ${count} sessions for ${existingUsername}`,
          );
        }
      }

      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clear";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * GET /api/remote-access/relay
   * Get relay configuration.
   */
  app.get("/relay", async (c) => {
    const relay = remoteAccessService.getRelayConfig();
    return c.json({ relay });
  });

  /**
   * PUT /api/remote-access/relay
   * Set relay URL and username.
   * Body: { url: string, username: string }
   */
  app.put("/relay", async (c) => {
    try {
      const body = await c.req.json<{ url: string; username: string }>();

      if (!body.url || !body.username) {
        return c.json({ error: "URL and username are required" }, 400);
      }

      await remoteAccessService.setRelayConfig({
        url: body.url,
        username: body.username,
      });

      // Notify server to reconnect with new config
      await onRelayConfigChanged?.();

      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to set relay config";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * DELETE /api/remote-access/relay
   * Clear relay configuration.
   */
  app.delete("/relay", async (c) => {
    try {
      await remoteAccessService.clearRelayConfig();

      // Notify server to disconnect
      await onRelayConfigChanged?.();

      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clear relay config";
      return c.json({ error: message }, 400);
    }
  });

  /**
   * GET /api/remote-access/relay/status
   * Get relay client connection status.
   */
  app.get("/relay/status", (c) => {
    if (!relayClientService) {
      return c.json({
        status: "disconnected" as const,
        error: null,
        reconnectAttempts: 0,
      });
    }
    const state = relayClientService.getState();
    return c.json({
      status: state.status,
      error: state.error ?? null,
      reconnectAttempts: state.reconnectAttempts,
    });
  });

  return app;
}
