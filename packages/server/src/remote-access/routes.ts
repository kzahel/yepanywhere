/**
 * Remote access API routes.
 */

import { type Context, Hono } from "hono";
import {
  type RemoteAccessChange,
  refuseUnconfirmedImpact,
  remoteAccessChangeImpact,
} from "../network/connection-impact.js";
import { recordAuthEvent } from "../security/authAuditLog.js";
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

  /** Refuse a change that would cut off its own Remote Access caller. */
  const refuseSelfDisconnect = (c: Context, change: RemoteAccessChange) =>
    refuseUnconfirmedImpact(c, remoteAccessChangeImpact(c, change));

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
      const refusal = refuseSelfDisconnect(c, {
        endsLoginsOf: existingUsername,
      });
      if (refusal) return refusal;

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

      await recordAuthEvent(c, {
        event: "remote-access-configure",
        outcome: "success",
        account: newUsername ?? undefined,
      });
      return c.json({ success: true, username: newUsername });
    } catch (error) {
      await recordAuthEvent(c, {
        event: "remote-access-configure",
        outcome: "failure",
        reason: "rejected",
      });
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
      await recordAuthEvent(c, {
        event: "remote-access-enable",
        outcome: "success",
      });
      return c.json({ success: true });
    } catch (error) {
      await recordAuthEvent(c, {
        event: "remote-access-enable",
        outcome: "failure",
        reason: "rejected",
      });
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
      const refusal = refuseSelfDisconnect(c, { refusesLogins: true });
      if (refusal) return refusal;
      await remoteAccessService.disable();
      await recordAuthEvent(c, {
        event: "remote-access-disable",
        outcome: "success",
      });
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
      const refusal = refuseSelfDisconnect(c, {
        endsLoginsOf: existingUsername,
        refusesLogins: true,
      });
      if (refusal) return refusal;

      await remoteAccessService.clearCredentials();
      await recordAuthEvent(c, {
        event: "remote-access-clear",
        outcome: "success",
        account: existingUsername ?? undefined,
      });

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

      // Get existing username before changing (to invalidate sessions on username change)
      const existingUsername = remoteAccessService.getUsername();
      const existingRelay = remoteAccessService.getRelayConfig();
      const refusal = refuseSelfDisconnect(c, {
        endsLoginsOf:
          existingUsername && existingUsername !== body.username
            ? existingUsername
            : null,
        dropsRelay:
          existingRelay?.url !== body.url ||
          existingRelay?.username !== body.username,
      });
      if (refusal) return refusal;

      await remoteAccessService.setRelayConfig({
        url: body.url,
        username: body.username,
      });
      await recordAuthEvent(c, {
        event: "remote-access-relay",
        outcome: "success",
        account: body.username,
        details: { change: "set", url: body.url.slice(0, 200) },
      });

      // Invalidate sessions if username changed (sessions are tied to username identity)
      if (
        remoteSessionService &&
        existingUsername &&
        existingUsername !== body.username
      ) {
        const count =
          await remoteSessionService.invalidateUserSessions(existingUsername);
        if (count > 0) {
          console.log(
            `[RemoteAccess] Relay username changed, invalidated ${count} sessions for ${existingUsername}`,
          );
        }
      }

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
      // Get username before clearing to invalidate their sessions
      const existingUsername = remoteAccessService.getUsername();
      const refusal = refuseSelfDisconnect(c, {
        endsLoginsOf: existingUsername,
        dropsRelay: true,
      });
      if (refusal) return refusal;

      await remoteAccessService.clearRelayConfig();
      await recordAuthEvent(c, {
        event: "remote-access-relay",
        outcome: "success",
        account: existingUsername ?? undefined,
        details: { change: "clear" },
      });

      // Invalidate all sessions for the user (relay identity is being removed)
      if (remoteSessionService && existingUsername) {
        const count =
          await remoteSessionService.invalidateUserSessions(existingUsername);
        if (count > 0) {
          console.log(
            `[RemoteAccess] Relay config cleared, invalidated ${count} sessions for ${existingUsername}`,
          );
        }
      }

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

  /**
   * GET /api/remote-access/sessions
   * List all active remote sessions.
   */
  app.get("/sessions", (c) => {
    if (!remoteSessionService) {
      return c.json({ sessions: [] });
    }
    const sessions = remoteSessionService.listSessions();
    return c.json({ sessions });
  });

  /**
   * DELETE /api/remote-access/sessions/:sessionId
   * Revoke a specific session.
   */
  app.delete("/sessions/:sessionId", async (c) => {
    if (!remoteSessionService) {
      return c.json({ error: "Session service not available" }, 500);
    }
    const sessionId = c.req.param("sessionId");
    const refusal = refuseSelfDisconnect(c, { endsLogin: sessionId });
    if (refusal) return refusal;
    await remoteSessionService.deleteSession(sessionId);
    return c.json({ success: true });
  });

  /**
   * DELETE /api/remote-access/sessions
   * Revoke all sessions.
   */
  app.delete("/sessions", async (c) => {
    if (!remoteSessionService) {
      return c.json({ error: "Session service not available" }, 500);
    }
    const username = remoteAccessService.getUsername();
    if (username) {
      const refusal = refuseSelfDisconnect(c, { endsLoginsOf: username });
      if (refusal) return refusal;
      const count = await remoteSessionService.invalidateUserSessions(username);
      return c.json({ success: true, revokedCount: count });
    }
    return c.json({ success: true, revokedCount: 0 });
  });

  return app;
}
