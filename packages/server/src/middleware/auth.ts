/**
 * Authentication middleware for API routes.
 *
 * Validates session cookies and returns 401 for unauthenticated requests.
 * Skips auth for /api/auth/* paths (login, setup, etc).
 *
 * Auth is only enforced when:
 * 1. authService.isEnabled() returns true (enabled in settings)
 * 2. authDisabled is false (not bypassed via --auth-disable flag)
 *
 * Desktop token (DESKTOP_AUTH_TOKEN set):
 * Acts as a minimum auth floor. The token is always accepted as valid auth.
 * If the user has also set up password auth, cookie sessions still work too.
 * Relay-internal (SRP) requests are always allowed. The token prevents
 * unauthenticated access when no other auth is configured.
 */

import * as crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  type AgentServerTokens,
  bearerToken,
} from "../auth/AgentServerTokens.js";
import type { AuthService } from "../auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../auth/routes.js";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  type DesktopBootstrapService,
} from "../desktop/DesktopBootstrapService.js";
import { WS_INTERNAL_AUTHENTICATED } from "./internal-auth.js";

export interface AuthMiddlewareOptions {
  authService: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Bypasses all auth. */
  authDisabled?: boolean;
  /** Desktop auth token from Tauri app. Acts as minimum auth floor when no other auth is configured. */
  desktopAuthToken?: string;
  /** Reload-safe desktop session authentication for bootstrap-v1 shells. */
  desktopBootstrapService?: DesktopBootstrapService;
  /** Launch-scoped bearer tokens held by unsandboxed superuser sessions. */
  agentServerTokens?: AgentServerTokens;
}

/**
 * Constant-time comparison of two strings.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check if the request carries a valid desktop auth token
 * (via X-Desktop-Token header or desktop_token query param).
 */
export function hasValidDesktopToken(
  c: Parameters<MiddlewareHandler>[0],
  desktopAuthToken: string,
): boolean {
  // Check header (used by fetchJSON API calls)
  const headerToken = c.req.header("x-desktop-token");
  if (headerToken && timingSafeEqual(headerToken, desktopAuthToken)) {
    return true;
  }
  // Check query param (used by WebSocket upgrade, which can't set headers)
  const url = new URL(c.req.url);
  const queryToken = url.searchParams.get("desktop_token");
  if (queryToken && timingSafeEqual(queryToken, desktopAuthToken)) {
    return true;
  }
  return false;
}

/**
 * Create auth middleware that validates session cookies.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler {
  const {
    authService,
    authDisabled = false,
    desktopAuthToken,
    desktopBootstrapService,
    agentServerTokens,
  } = options;

  return async (c, next) => {
    const path = c.req.path;

    // Skip auth for health check (always open for readiness probes)
    if (path === "/health") {
      await next();
      return;
    }

    const desktopSession = getCookie(c, DESKTOP_SESSION_COOKIE_NAME);
    if (desktopBootstrapService?.validateSession(desktopSession)) {
      c.set("authenticated", true);
      c.set("authenticatedViaSession", true);
      await next();
      return;
    }

    // Desktop token: always accepted when present and valid.
    if (desktopAuthToken && hasValidDesktopToken(c, desktopAuthToken)) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // An agent session's launch token. It carries no cookie, so the limited
    // users middleware resolves it to the superuser who started the session.
    const agentToken = bearerToken(c.req.header("authorization"));
    if (agentToken && agentServerTokens?.accepts(agentToken)) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // If auth is disabled by env var, always pass through
    if (authDisabled) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // Skip local password auth for requests from the SRP tunnel.
    // The relay handler sets this Symbol when routing requests through app.fetch().
    // Using a Symbol ensures this cannot be forged by external HTTP requests.
    if (c.env?.[WS_INTERNAL_AUTHENTICATED]) {
      c.set("authenticated", true);
      await next();
      return;
    }

    // If auth is not enabled in settings, either desktop credential acts as
    // a floor (unless localhostOpen is explicitly enabled).
    if (!authService.isEnabled()) {
      if (
        (desktopAuthToken || desktopBootstrapService) &&
        !authService.isLocalhostOpen()
      ) {
        // A desktop credential exists but this request did not carry it.
        // Allow auth status so the UI can detect state.
        if (path === "/api/auth/status") {
          await next();
          return;
        }
        return c.json({ error: "Authentication required" }, 401);
      }
      c.set("authenticated", true);
      await next();
      return;
    }

    // Skip auth for /api/auth/* paths
    if (path.startsWith("/api/auth/") || path === "/api/auth") {
      await next();
      return;
    }

    // Check if account exists (shouldn't happen if enabled via enableAuth)
    if (!authService.hasAccount()) {
      c.header("X-Setup-Required", "true");
      return c.json(
        {
          error: "Authentication required",
          setupRequired: true,
        },
        401,
      );
    }

    // Validate session cookie
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const valid = await authService.validateSession(sessionId);
    if (!valid) {
      return c.json({ error: "Session expired" }, 401);
    }

    // Mark request as authenticated (for downstream handlers if needed)
    c.set("authenticated", true);
    c.set("authenticatedViaSession", true);

    await next();
  };
}
