import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import {
  SESSION_COOKIE_NAME,
  createAuthRoutes,
} from "../../src/auth/routes.js";
import { configureAuthAudit } from "../../src/security/authAuditLog.js";
import { Hono } from "hono";
import { PRINCIPAL_VARIABLE } from "../../src/auth/principal.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";

describe("Auth routes - audit log", () => {
  let authService: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-audit-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    configureAuthAudit(testDir);
  });

  afterEach(async () => {
    configureAuthAudit(undefined);
    await authService.flushPendingWrites();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("records logins and password changes without any password", async () => {
    const routes = createAuthRoutes({ authService });
    const post = (route: string, body: unknown, cookie?: string) =>
      routes.request(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "audit-test",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });

    await post("/enable", { password: "first-secret-pw" });
    expect((await post("/login", { password: "wrong-secret-pw" })).status).toBe(
      401,
    );
    const login = await post("/login", { password: "first-secret-pw" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    await post(
      "/change-password",
      { currentPassword: "first-secret-pw", newPassword: "second-secret-pw" },
      cookie,
    );

    const content = await fs.readFile(
      path.join(testDir, "logs", "auth-events.jsonl"),
      "utf8",
    );
    for (const secret of ["first-secret-pw", "wrong-secret-pw", "second"]) {
      expect(content).not.toContain(secret);
    }
    const entries = content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      entries.map((entry) => [entry.event, entry.outcome, entry.reason]),
    ).toEqual([
      ["auth-enable", "success", undefined],
      ["login", "failure", "bad-password"],
      ["login", "success", undefined],
      ["password-change", "success", undefined],
    ]);
    expect(entries[1]).toMatchObject({
      account: "owner",
      transport: "direct",
      userAgent: "audit-test",
    });
  });
});

describe("Auth routes - POST /enable", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    await authService.flushPendingWrites();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function postEnable(
    body: { password: string },
    cookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookie) {
      headers.Cookie = cookie;
    }

    return routes.request("/enable", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function postLogin(password: string): Promise<Response> {
    return routes.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
  }

  it("allows unauthenticated first-time setup", async () => {
    const res = await postEnable({ password: "initial-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(authService.hasAccount()).toBe(true);
    await expect(authService.verifyPassword("initial-password")).resolves.toBe(
      true,
    );
  });

  it("rejects enable when auth is already enabled", async () => {
    await authService.enableAuth("current-password");

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Authentication is already enabled. Use change-password.",
    });
  });

  it("allows fresh setup after disabling auth without requiring prior password", async () => {
    await authService.enableAuth("current-password");
    const loginRes = await postLogin("current-password");
    const cookie = loginRes.headers.get("set-cookie");
    expect(loginRes.status).toBe(200);
    expect(cookie).toBeTruthy();

    const disableRes = await routes.request("/disable", {
      method: "POST",
      headers: {
        Cookie: cookie ?? "",
      },
    });
    expect(disableRes.status).toBe(200);
    expect(authService.isEnabled()).toBe(false);
    expect(authService.hasAccount()).toBe(false);

    const res = await postEnable({ password: "next-password" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    await expect(authService.verifyPassword("next-password")).resolves.toBe(
      true,
    );
    await expect(authService.verifyPassword("current-password")).resolves.toBe(
      false,
    );
  });
});

describe("Auth routes - owner relay name on the local login", () => {
  let authService: AuthService;
  let limitedUsers: LimitedUsersService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-relay-name-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("owner-password");
    limitedUsers = new LimitedUsersService({ dataDir: testDir });
    await limitedUsers.initialize();
  });

  afterEach(async () => {
    await authService.flushPendingWrites();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function login(
    routes: ReturnType<typeof createAuthRoutes>,
    username: string,
    password: string,
  ): Promise<Response> {
    return await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  it("signs in the owner when the autofilled username is the relay name", async () => {
    const routes = createAuthRoutes({
      authService,
      limitedUsers,
      isLimitedUsersEnabled: () => true,
      getOwnerRelayUsername: () => "myserver",
    });
    const res = await login(routes, "MyServer", "owner-password");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    const sessionId = cookie.match(
      new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`),
    )?.[1];
    // An owner session carries no limited-user name.
    expect(sessionId).toBeTruthy();
    expect(authService.getSessionUsername(sessionId)).toBeNull();
    expect((await login(routes, "myserver", "wrong")).status).toBe(401);
  });

  it("leaves the name to a limited user who holds it", async () => {
    await limitedUsers.create({ username: "myserver", password: "limited-pw" });
    const routes = createAuthRoutes({
      authService,
      limitedUsers,
      isLimitedUsersEnabled: () => true,
      getOwnerRelayUsername: () => "myserver",
    });
    expect((await login(routes, "myserver", "owner-password")).status).toBe(
      401,
    );
    expect((await login(routes, "myserver", "limited-pw")).status).toBe(200);
  });

  it("still refuses other names while limited users are off", async () => {
    const routes = createAuthRoutes({
      authService,
      limitedUsers,
      isLimitedUsersEnabled: () => false,
      getOwnerRelayUsername: () => "myserver",
    });
    expect((await login(routes, "someone", "owner-password")).status).toBe(401);
    expect((await login(routes, "myserver", "owner-password")).status).toBe(
      200,
    );
  });
});

describe("Auth routes - cookie secure flag", () => {
  let authService: AuthService;
  let testDir: string;
  let routes: ReturnType<typeof createAuthRoutes>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-routes-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("password123");
    routes = createAuthRoutes({ authService });
  });

  afterEach(async () => {
    await authService.flushPendingWrites();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("does not set Secure on HTTP login cookies", async () => {
    const res = await routes.request("http://192.168.1.139/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).not.toContain("Secure");
  });

  it("sets Secure on HTTPS login cookies", async () => {
    const res = await routes.request("https://example.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "password123" }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure");
  });
});

describe("Auth routes - Remote Access owner", () => {
  let authService: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-remote-owner-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("first-secret-pw");
  });

  afterEach(async () => {
    await authService.flushPendingWrites();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /** The auth routes behind the principal the limited-users middleware sets. */
  function routesActingAs(kind: "superuser" | "limited") {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE as never, { kind } as never);
      await next();
    });
    app.route("/", createAuthRoutes({ authService }));
    return app;
  }

  const srpLogin = {
    [AUTHENTICATED_SRP_TRANSPORT]: {
      kind: "srp",
      username: "owner-relay",
      sessionId: "session-1",
      transportNonce: "nonce",
      authenticationMethod: "srp-full",
      transport: "relay",
      connectionId: "connection-1",
      closeConnection: () => {},
      closeAfterResponse: () => {},
      deferAfterResponse: () => {},
    },
  };

  const post = (app: Hono, route: string, body: unknown, env?: object) =>
    app.request(
      route,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );

  it("lets the owner's SRP login change and remove the local password", async () => {
    const owner = routesActingAs("superuser");
    expect(
      (
        await post(
          owner,
          "/change-password",
          { newPassword: "second-secret-pw" },
          srpLogin,
        )
      ).status,
    ).toBe(200);
    expect(await authService.verifyPassword("second-secret-pw")).toBe(true);
    expect(
      (await post(owner, "/localhost-access", { open: true }, srpLogin)).status,
    ).toBe(200);
    expect((await post(owner, "/disable", {}, srpLogin)).status).toBe(200);
    expect(authService.isEnabled()).toBe(false);
  });

  it("refuses requests with neither an owner cookie nor an owner SRP login", async () => {
    const change = { newPassword: "second-secret-pw" };
    expect(
      (await post(routesActingAs("superuser"), "/change-password", change))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          routesActingAs("limited"),
          "/change-password",
          change,
          srpLogin,
        )
      ).status,
    ).toBe(401);
    expect(await authService.verifyPassword("first-secret-pw")).toBe(true);
  });
});
