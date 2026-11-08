/**
 * Authentication API routes
 */

import * as crypto from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  type DesktopBootstrapService,
} from "../desktop/DesktopBootstrapService.js";
import type { AuthService } from "./AuthService.js";
import type { LimitedUsersService } from "./LimitedUsersService.js";
import { PRINCIPAL_VARIABLE, type Principal } from "./principal.js";
import { getAuthenticatedSrpTransport } from "../middleware/authenticated-transport.js";
import { recordAuthEvent } from "../security/authAuditLog.js";

export const SESSION_COOKIE_NAME = "yep-anywhere-session";

export interface AuthRoutesDeps {
  authService: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Overrides settings. */
  authDisabled?: boolean;
  /** Desktop auth token (for protecting localhost-access endpoint). */
  desktopAuthToken?: string;
  /** Reload-safe desktop session authentication for bootstrap-v1 shells. */
  desktopBootstrapService?: DesktopBootstrapService;
  /** Limited-user records, for named logins (topics/limited-users.md). */
  limitedUsers?: LimitedUsersService;
  /** Whether limited users are enabled in server settings. */
  isLimitedUsersEnabled?: () => boolean;
  /** The owner's Remote Access (relay) username, when one is registered. */
  getOwnerRelayUsername?: () => string | null;
}

interface SetupBody {
  password: string;
}

interface LoginBody {
  password: string;
  /** Limited user to log in as; blank or absent means the superuser. */
  username?: string;
}

interface ChangePasswordBody {
  newPassword: string;
}

/** Whether a cookie set on this request should carry `Secure`. */
export function shouldUseSecureCookie(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  // Honor reverse-proxy protocol hints when present.
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    const protocol = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (protocol === "https") {
      return true;
    }
    if (protocol === "http") {
      return false;
    }
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A Remote Access (SRP) login acting as the superuser. It holds the same
 * operator authority as a superuser cookie session (topics/security.md
 * § Authority Model), so the owner can manage the local password remotely.
 * Limited users never reach these routes (auth/limitedUserPolicy.ts).
 */
function isRemoteOwner(c: Context): boolean {
  if (!getAuthenticatedSrpTransport(c.env)) return false;
  const principal = (
    c as Context<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal | undefined>;
    }>
  ).get(PRINCIPAL_VARIABLE);
  return principal === undefined || principal.kind === "superuser";
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const app = new Hono();

  const {
    authService,
    authDisabled = false,
    desktopAuthToken,
    desktopBootstrapService,
    limitedUsers,
    isLimitedUsersEnabled,
    getOwnerRelayUsername,
  } = deps;

  /** An owner cookie session or a Remote Access owner login. */
  const isOwnerRequest = async (c: Context): Promise<boolean> => {
    if (isRemoteOwner(c)) return true;
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    return !!sessionId && (await authService.validateSession(sessionId));
  };

  /**
   * GET /api/auth/status
   * Check authentication status
   *
   * Returns:
   * - enabled: whether auth is enabled (from settings)
   * - authenticated: whether user has valid session
   * - setupRequired: whether initial setup is needed (enabled but no account)
   * - disabledByEnv: whether auth is disabled by --auth-disable flag
   * - authFilePath: path to auth.json (for recovery instructions)
   * - limitedUsersEnabled: whether a named (limited-user) login can succeed,
   *   so the login page offers a Username field only then
   */
  app.get("/status", async (c) => {
    const isEnabled = authService.isEnabled();
    const base = {
      hasDesktopToken: !!desktopAuthToken || !!desktopBootstrapService,
      localhostOpen: authService.isLocalhostOpen(),
      authFilePath: authService.getFilePath(),
      limitedUsersEnabled:
        limitedUsers !== undefined && isLimitedUsersEnabled?.() === true,
    };

    // If auth is disabled by env var, it overrides settings
    if (authDisabled) {
      return c.json({
        ...base,
        enabled: isEnabled,
        authenticated: true, // Bypass auth
        setupRequired: false,
        disabledByEnv: true,
      });
    }

    const desktopSession = getCookie(c, DESKTOP_SESSION_COOKIE_NAME);
    if (desktopBootstrapService?.validateSession(desktopSession)) {
      return c.json({
        ...base,
        enabled: isEnabled,
        authenticated: true,
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    // If auth is not enabled in settings, no auth required
    if (!isEnabled) {
      const desktopFloorEnabled =
        (!!desktopAuthToken || !!desktopBootstrapService) &&
        !authService.isLocalhostOpen();
      return c.json({
        ...base,
        enabled: false,
        authenticated: !desktopFloorEnabled,
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    // Auth is enabled - check session
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const hasAccount = authService.hasAccount();

    if (!hasAccount) {
      // This shouldn't happen normally since enableAuth creates account,
      // but handle edge case
      return c.json({
        ...base,
        enabled: true,
        authenticated: false,
        setupRequired: true,
        disabledByEnv: false,
      });
    }

    if (!sessionId) {
      return c.json({
        ...base,
        enabled: true,
        authenticated: false,
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    const valid = await authService.validateSession(sessionId);
    return c.json({
      ...base,
      enabled: true,
      authenticated: valid,
      setupRequired: false,
      disabledByEnv: false,
    });
  });

  /**
   * POST /api/auth/enable
   * Enable auth with a password.
   * - Allowed only when auth is currently disabled.
   * - Treated as "add protection now" instead of account-ownership recovery.
   *
   * Security model note:
   * This server defaults to localhost with auth off. In that baseline model,
   * enabling auth is opportunistic hardening. If auth is enabled unexpectedly,
   * the operator can still recover with --auth-disable or --setup-auth.
   */
  app.post("/enable", async (c) => {
    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    if (authService.isEnabled()) {
      await recordAuthEvent(c, {
        event: "auth-enable",
        outcome: "failure",
        account: "owner",
        reason: "already-enabled",
      });
      return c.json(
        { error: "Authentication is already enabled. Use change-password." },
        409,
      );
    }

    const success = await authService.enableAuth(body.password);
    await recordAuthEvent(c, {
      event: "auth-enable",
      outcome: success ? "success" : "failure",
      account: "owner",
      ...(success ? {} : { reason: "save-failed" }),
    });
    if (!success) {
      return c.json({ error: "Failed to enable auth" }, 500);
    }

    // Don't auto-login - require user to log in with their new password
    return c.json({ success: true });
  });

  /**
   * POST /api/auth/disable
   * Disable auth (requires authenticated session).
   * Also clears the stored account so future enable is a fresh setup.
   */
  app.post("/disable", async (c) => {
    // Require an owner session (cookie or Remote Access) to disable
    if (!(await isOwnerRequest(c))) {
      await recordAuthEvent(c, {
        event: "auth-disable",
        outcome: "failure",
        account: "owner",
        reason: "not-authenticated",
      });
      return c.json({ error: "Not authenticated" }, 401);
    }

    await authService.disableAuth();
    await recordAuthEvent(c, {
      event: "auth-disable",
      outcome: "success",
      account: "owner",
    });

    // Clear the session cookie
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/setup
   * Create the initial account (only works when no account exists)
   * @deprecated Use /api/auth/enable instead
   */
  app.post("/setup", async (c) => {
    if (authService.hasAccount()) {
      await recordAuthEvent(c, {
        event: "auth-setup",
        outcome: "failure",
        account: "owner",
        reason: "account-exists",
      });
      return c.json({ error: "Account already exists" }, 400);
    }

    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    // Use enableAuth to also set the enabled flag
    const success = await authService.enableAuth(body.password);
    await recordAuthEvent(c, {
      event: "auth-setup",
      outcome: success ? "success" : "failure",
      account: "owner",
      ...(success ? {} : { reason: "save-failed" }),
    });
    if (!success) {
      return c.json({ error: "Failed to create account" }, 500);
    }

    // Auto-login after setup
    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent);

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(c),
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/login
   * Login with password
   */
  app.post("/login", async (c) => {
    // A named login is a limited user (topics/limited-users.md); it needs no
    // superuser account to exist and never grants superuser access.
    const rawBody = await c.req
      .json<LoginBody>()
      .catch(() => null as LoginBody | null);
    const typedUsername = rawBody?.username?.trim();
    // Browsers autofill the owner's saved relay credential here. The relay
    // already treats that name as the owner, so the owner login does too,
    // unless a limited user holds the name.
    const ownerRelayUsername = getOwnerRelayUsername?.();
    const requestedUsername =
      typedUsername &&
      ownerRelayUsername &&
      typedUsername.toLowerCase() === ownerRelayUsername.toLowerCase() &&
      !limitedUsers?.get(typedUsername.toLowerCase())
        ? undefined
        : typedUsername;
    if (requestedUsername) {
      if (!limitedUsers || !isLimitedUsersEnabled?.()) {
        await recordAuthEvent(c, {
          event: "login",
          outcome: "failure",
          account: requestedUsername,
          reason: "limited-users-off",
        });
        return c.json({ error: "Invalid username or password" }, 401);
      }
      if (
        !rawBody?.password ||
        typeof rawBody.password !== "string" ||
        !(await limitedUsers.verifyPassword(
          requestedUsername,
          rawBody.password,
        ))
      ) {
        // The attempted name is recorded as typed: repeated failures against
        // one name, or against names that do not exist, are what an audit of
        // guessing looks for. The response still does not say which.
        await recordAuthEvent(c, {
          event: "login",
          outcome: "failure",
          account: requestedUsername,
          reason: limitedUsers.get(requestedUsername.toLowerCase())
            ? "bad-password"
            : "unknown-user",
        });
        return c.json({ error: "Invalid username or password" }, 401);
      }
      await limitedUsers.recordLogin(requestedUsername);
      await recordAuthEvent(c, {
        event: "login",
        outcome: "success",
        account: requestedUsername,
      });
      const sessionId = await authService.createSession(
        c.req.header("User-Agent"),
        requestedUsername,
      );
      setCookie(c, SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: shouldUseSecureCookie(c),
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
      return c.json({ success: true, username: requestedUsername });
    }

    if (!authService.hasAccount()) {
      await recordAuthEvent(c, {
        event: "login",
        outcome: "failure",
        account: "owner",
        reason: "no-account",
      });
      c.header("X-Setup-Required", "true");
      return c.json(
        { error: "No account configured", setupRequired: true },
        401,
      );
    }

    const body = rawBody;

    if (!body?.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    const valid = await authService.verifyPassword(body.password);
    if (!valid) {
      await recordAuthEvent(c, {
        event: "login",
        outcome: "failure",
        account: "owner",
        reason: "bad-password",
      });
      return c.json({ error: "Invalid password" }, 401);
    }

    await recordAuthEvent(c, {
      event: "login",
      outcome: "success",
      account: "owner",
    });
    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent);

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(c),
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/logout
   * Logout (invalidate session)
   */
  app.post("/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);

    if (sessionId) {
      // An unknown login names nobody; do not guess "owner" for it.
      const known = await authService.validateSession(sessionId);
      const account = known
        ? (authService.getSessionUsername(sessionId) ?? "owner")
        : undefined;
      await authService.invalidateSession(sessionId);
      await recordAuthEvent(c, {
        event: "logout",
        outcome: "success",
        ...(account ? { account } : { reason: "login-already-ended" }),
      });
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/change-password
   * Change password (requires authenticated session)
   */
  app.post("/change-password", async (c) => {
    // Require an owner session (cookie or Remote Access)
    if (!(await isOwnerRequest(c))) {
      await recordAuthEvent(c, {
        event: "password-change",
        outcome: "failure",
        account: "owner",
        reason: "not-authenticated",
      });
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<ChangePasswordBody>();

    if (!body.newPassword || typeof body.newPassword !== "string") {
      return c.json({ error: "New password is required" }, 400);
    }

    if (body.newPassword.length < 6) {
      return c.json(
        { error: "New password must be at least 6 characters" },
        400,
      );
    }

    const success = await authService.changePassword(body.newPassword);
    await recordAuthEvent(c, {
      event: "password-change",
      outcome: success ? "success" : "failure",
      account: "owner",
      ...(success ? {} : { reason: "save-failed" }),
    });
    if (!success) {
      return c.json({ error: "Failed to change password" }, 500);
    }

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/localhost-access
   * Toggle unauthenticated localhost access (bypasses desktop token floor).
   * Requires valid desktop token or authenticated session.
   */
  app.post("/localhost-access", async (c) => {
    // Verify caller has desktop token or valid session
    let authorized = false;

    if (desktopAuthToken) {
      const headerToken = c.req.header("x-desktop-token");
      if (
        headerToken &&
        headerToken.length === desktopAuthToken.length &&
        crypto.timingSafeEqual(
          Buffer.from(headerToken),
          Buffer.from(desktopAuthToken),
        )
      ) {
        authorized = true;
      }
    }

    if (!authorized && (await isOwnerRequest(c))) {
      authorized = true;
    }

    if (!authorized) {
      await recordAuthEvent(c, {
        event: "localhost-access",
        outcome: "failure",
        reason: "not-authenticated",
      });
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<{ open: boolean }>();
    if (typeof body.open !== "boolean") {
      return c.json({ error: "open must be a boolean" }, 400);
    }
    await authService.setLocalhostOpen(body.open);
    await recordAuthEvent(c, {
      event: "localhost-access",
      outcome: "success",
      details: { open: body.open },
    });
    return c.json({ success: true, localhostOpen: body.open });
  });

  return app;
}
