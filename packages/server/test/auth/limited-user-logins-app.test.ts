import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppResult } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "../../src/middleware/internal-auth.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { createApp } from "../setup/create-app.js";

/**
 * A limited user's logins end with the logout, password, and account that
 * opened them. topics/limited-users.md § v1 user record and § Login,
 * switching, and logout.
 */
describe("limited-user logins through the users routes", () => {
  let testDir: string;
  let instance: AppResult;
  let authService: AuthService;
  let limitedUsers: LimitedUsersService;
  let remoteSessions: RemoteSessionService;
  let serverSettingsService: ServerSettingsService;
  let superuserCookie: string;

  const relaySession = (username: string) =>
    remoteSessions.createSession(username, new Uint8Array(32));
  const cookieSession = (username: string) =>
    authService.createSession("test", username);

  /** A request tunneled through an established SRP connection. */
  const relayRequest = (
    path: string,
    username: string,
    sessionId: string,
    init: RequestInit = {},
  ) =>
    instance.app.request(
      path,
      {
        ...init,
        headers: { "X-Yep-Anywhere": "true", ...init.headers },
      },
      {
        [WS_INTERNAL_AUTHENTICATED]: true,
        [AUTHENTICATED_SRP_TRANSPORT]: { kind: "srp", username, sessionId },
      },
    );

  const superuserRequest = (path: string, init: RequestInit = {}) =>
    instance.app.request(path, {
      ...init,
      headers: {
        Cookie: superuserCookie,
        "X-Yep-Anywhere": "true",
        "Content-Type": "application/json",
      },
    });

  beforeEach(async () => {
    testDir = join(tmpdir(), `limited-user-logins-${randomUUID()}`);
    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    authService = new AuthService({ dataDir, cookieSecret: "logins-secret" });
    await authService.initialize();
    await authService.enableAuth("superuser-password");
    superuserCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("test")}`;

    limitedUsers = new LimitedUsersService({ dataDir });
    await limitedUsers.initialize();
    for (const username of ["bob", "carol"]) {
      await limitedUsers.create({ username, password: "correct-horse" });
    }
    remoteSessions = new RemoteSessionService({ dataDir });
    await remoteSessions.initialize();

    serverSettingsService = new ServerSettingsService({ dataDir });
    await serverSettingsService.initialize();
    await serverSettingsService.updateSettings({ limitedUsersEnabled: true });

    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      projectsDir: join(testDir, "claude"),
      authService,
      authDisabled: false,
      limitedUsersService: limitedUsers,
      serverSettingsService,
      remoteSessionService: remoteSessions,
    });
  });

  afterEach(async () => {
    remoteSessions.shutdown();
    await instance.disposeSessionReaders();
    await rm(testDir, { recursive: true, force: true });
  });

  it("tells a signed-out login page whether a named login can succeed", async () => {
    const status = async () => {
      const response = await instance.app.request("/api/auth/status", {
        headers: { "X-Yep-Anywhere": "true" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        authenticated: boolean;
        limitedUsersEnabled?: boolean;
      };
      expect(body.authenticated).toBe(false);
      return body.limitedUsersEnabled;
    };

    expect(await status()).toBe(true);
    await serverSettingsService.updateSettings({ limitedUsersEnabled: false });
    expect(await status()).toBe(false);
  });

  it("ends a relay logout's session and its saved resume credential, and nothing else", async () => {
    const loggingOut = await relaySession("bob");
    const otherDevice = await relaySession("bob");
    const cookie = await cookieSession("bob");

    const response = await relayRequest(
      "/api/users/logout",
      "bob",
      loggingOut,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      redirect: "relay-login",
    });

    expect(remoteSessions.getSession(loggingOut)).toBeNull();
    expect(remoteSessions.getSession(otherDevice)).not.toBeNull();
    expect(authService.getSessionUsername(cookie)).toBe("bob");
  });

  it("ends every login a password change replaces, and no one else's", async () => {
    const bobRelay = await relaySession("bob");
    const bobCookie = await cookieSession("bob");
    const carolRelay = await relaySession("carol");
    const carolCookie = await cookieSession("carol");

    // Editing grants alone replaces no credential.
    const grantsOnly = await superuserRequest("/api/users/bob", {
      method: "PATCH",
      body: JSON.stringify({ joinStaleOffsetMinutes: 5 }),
    });
    expect(grantsOnly.status).toBe(200);
    expect(remoteSessions.getSession(bobRelay)).not.toBeNull();
    expect(authService.getSessionUsername(bobCookie)).toBe("bob");

    const passwordChange = await superuserRequest("/api/users/bob", {
      method: "PATCH",
      body: JSON.stringify({ password: "another-horse-battery" }),
    });
    expect(passwordChange.status).toBe(200);

    expect(remoteSessions.getSession(bobRelay)).toBeNull();
    expect(authService.getSessionUsername(bobCookie)).toBeNull();
    const oldCookie = await instance.app.request("/api/users/me", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${bobCookie}`,
        "X-Yep-Anywhere": "true",
      },
    });
    expect(oldCookie.status).toBe(401);

    expect(remoteSessions.getSession(carolRelay)).not.toBeNull();
    expect(authService.getSessionUsername(carolCookie)).toBe("carol");
  });

  it("ends a deleted user's logins, and starts a new user of that name with none", async () => {
    const deletedRelay = await relaySession("bob");
    const deletedCookie = await cookieSession("bob");
    const removed = await superuserRequest("/api/users/bob", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(remoteSessions.getSession(deletedRelay)).toBeNull();
    expect(authService.getSessionUsername(deletedCookie)).toBeNull();

    // Logins a deletion left behind, as one made before deletion ended them.
    const leftRelay = await relaySession("carol");
    const leftCookie = await cookieSession("carol");
    await limitedUsers.remove("carol");
    const created = await superuserRequest("/api/users", {
      method: "POST",
      body: JSON.stringify({ username: "carol", password: "a-new-carol" }),
    });
    expect(created.status).toBe(201);
    expect(remoteSessions.getSession(leftRelay)).toBeNull();
    expect(authService.getSessionUsername(leftCookie)).toBeNull();
  });
});
