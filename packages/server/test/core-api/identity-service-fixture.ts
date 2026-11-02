import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { SUPERUSER, type Principal } from "../../src/auth/principal.js";
import { createPeerOwnerBinding } from "../../src/peer-api/owner-proof.js";
import { createPeerManagementRoutes } from "../../src/peer-api/routes.js";
import { createIdentityService } from "../../src/identity-service/service.js";
import { IdentityServiceStore } from "../../src/identity-service/store.js";
import { protectedProfile } from "./peer-fixture.js";
export async function identityServiceFixture(
  cleanup: (() => void | Promise<void>)[],
  options: {
    external?: { issuer: string; subject: string };
    oidcProviders?: unknown;
    oidcFetch?: typeof fetch;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ya-fleet-integration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const issuer = "http://127.0.0.1:45679";
  let store = new IdentityServiceStore(directory, issuer, true);
  await store.initialize();
  cleanup.push(() => store.close());
  const accountId = options.external
    ? await store.provisionOidc(
        options.external.issuer,
        options.external.subject,
        "Owned OIDC account",
      )
    : await store.provisionLocal(
        "owner",
        "temporary identity service password",
      );
  const createService = () =>
    createIdentityService(store, {
      oidcProviders: options.oidcProviders,
      oidcFetch: options.oidcFetch,
      remoteAddress: () => "127.0.0.1",
    });
  let service = createService();
  let available = true,
    dropUpload = false,
    dropAck = false;
  let interceptor:
    | ((
        request: Request,
        proceed: () => Promise<Response>,
      ) => Promise<Response>)
    | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (!available) throw new Error("owned issuer outage");
    const request = new Request(input, init),
      response = await (interceptor
        ? interceptor(request, () =>
            Promise.resolve(service.app.fetch(request)),
          )
        : service.app.fetch(request)),
      path = new URL(request.url).pathname;
    if (response.ok && dropUpload && path.endsWith("/envelope")) {
      dropUpload = false;
      throw new Error("owned lost upload response");
    }
    if (response.ok && dropAck && path.endsWith("/ack")) {
      dropAck = false;
      throw new Error("owned lost ack response");
    }
    return response;
  };
  const make = async () => {
    const profile = await protectedProfile(cleanup, {
      allowInsecureLoopback: true,
      fetch: fetcher,
    });
    const auth = new AuthService({ dataDir: profile.directory });
    await auth.initialize();
    cleanup.push(() => auth.waitForPendingWrites());
    const cookie = await auth.createSession("owner");
    const ownerApp = new Hono<{ Variables: { yaPrincipal: Principal } }>();
    ownerApp.use("*", async (c, next) => {
      c.set("yaPrincipal", SUPERUSER);
      await next();
    });
    const ownerBinding = createPeerOwnerBinding({ authService: auth });
    ownerApp.route(
      "/api/peers",
      createPeerManagementRoutes(
        profile.manager,
        async (c) => Boolean(await ownerBinding(c)),
        ownerBinding,
      ),
    );
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      authenticated = true,
      cookieValue = cookie,
    ) =>
      ownerApp.request(`/api/peers${path === "/" ? "" : path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(authenticated
            ? { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const json = async (path: string, method = "GET", body?: unknown) => {
      const response = await call(path, method, body);
      if (!response.ok)
        throw new Error(
          `Owned management ${path}: ${response.status} ${await response.text()}`,
        );
      return response.status === 204 ? null : response.json();
    };
    expect(
      (await call("/identity-service", "PUT", { issuer, accountId }, false))
        .status,
    ).toBe(403);
    await json("/identity-service", "PUT", { issuer, accountId });
    const client = options.external
      ? undefined
      : await json("/identity-service/login", "POST", {
          username: "owner",
          password: "temporary identity service password",
          displayName: "owned YA profile",
        });
    return {
      ...profile,
      call,
      json,
      client,
      otherOwner: async () => {
        const other = await auth.createSession("different owner session");
        return (path: string, method = "GET", body?: unknown) =>
          call(path, method, body, true, other);
      },
      invalidateOwner: () => auth.invalidateSession(cookie),
    };
  };
  return {
    get store() {
      return store;
    },
    accountId,
    issuer,
    get service() {
      return service;
    },
    restartService: async () => {
      await service.close();
      store = new IdentityServiceStore(directory, issuer, true);
      await store.initialize();
      service = createService();
    },
    make,
    directory,
    intercept: (value: typeof interceptor) => {
      interceptor = value;
    },
    offline: () => {
      available = false;
    },
    online: () => {
      available = true;
    },
    loseUpload: () => {
      dropUpload = true;
    },
    loseAck: () => {
      dropAck = true;
    },
  };
}
