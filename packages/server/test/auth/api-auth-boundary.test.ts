import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppOptions, AppResult } from "../../src/app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { createApp } from "../setup/create-app.js";

/**
 * The /api security boundary: every `/api` route runs behind the host check,
 * the custom-header check, and (when enabled) authentication, whatever order
 * its router was mounted in. Hono runs only the middleware registered before
 * a route, so a router mounted ahead of that middleware answers without it.
 * Each case walks `app.routes`, so a newly mounted router is covered without
 * being listed here.
 */

/** Paths the auth middleware deliberately leaves open (login, setup, status). */
function isAuthExempt(routePath: string): boolean {
  return routePath === "/api/auth" || routePath.startsWith("/api/auth/");
}

/** Replace route parameters and wildcards with a concrete segment. */
function concretePath(routePath: string): string {
  return routePath
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "x")
    .replace(/\*/g, "x");
}

interface Endpoint {
  method: string;
  url: string;
}

/**
 * One request per distinct routed `/api` endpoint. A route registered for
 * every method is sent as `fallbackMethod`.
 */
function apiEndpoints(
  instance: AppResult,
  fallbackMethod: string,
  include: (routePath: string) => boolean = () => true,
): Map<string, Endpoint> {
  const endpoints = new Map<string, Endpoint>();
  for (const route of instance.app.routes) {
    if (
      !(
        route.path.startsWith("/api/") ||
        route.path === "/v0" ||
        route.path.startsWith("/v0/")
      ) ||
      !include(route.path)
    )
      continue;
    const method = route.method === "ALL" ? fallbackMethod : route.method;
    const url = concretePath(route.path);
    endpoints.set(`${method} ${url}`, { method, url });
  }
  return endpoints;
}

/** Endpoints whose response status differs from `expected`. */
async function answeredOtherwise(
  instance: AppResult,
  endpoints: Map<string, Endpoint>,
  expected: number,
  headers: Record<string, string>,
): Promise<string[]> {
  const open: string[] = [];
  for (const [label, { method, url }] of endpoints) {
    const response = await instance.app.request(url, { method, headers });
    if (response.status !== expected) {
      open.push(`${label} -> ${response.status}`);
    }
  }
  return open;
}

describe("API security boundary", () => {
  let dataDir: string;
  let instance: AppResult;

  async function build(options: Partial<AppOptions> = {}) {
    const serverSettingsService = new ServerSettingsService({ dataDir });
    await serverSettingsService.initialize();
    instance = createApp({
      provider: new ScriptedClaudeProvider(),
      dataDir,
      serverSettingsService,
      ...options,
    });
    return instance;
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-api-auth-"));
  });

  afterEach(async () => {
    await instance.disposeSessionReaders();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("refuses every unauthenticated /api route when auth is on", async () => {
    const authService = new AuthService({
      dataDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("boundary-test-password");
    await build({ authService });

    const endpoints = apiEndpoints(
      instance,
      "GET",
      (routePath) => !isAuthExempt(routePath),
    );
    expect(endpoints.size).toBeGreaterThan(100);
    expect(endpoints.has("GET /api/computer-control")).toBe(true);
    // Pass the custom-header check so authentication is what answers.
    const open = await answeredOtherwise(instance, endpoints, 401, {
      "X-Yep-Anywhere": "true",
    });
    expect(open, `open routes:\n${open.join("\n")}`).toEqual([]);
  });

  it("refuses a cross-site write without the custom header, even with auth off", async () => {
    await build();
    // A page on another site can POST text/plain without a CORS preflight,
    // but cannot add the X-Yep-Anywhere header; reads are exempt by design.
    const writes = new Map(
      [...apiEndpoints(instance, "POST")].filter(
        ([, { method }]) => !["GET", "HEAD", "OPTIONS"].includes(method),
      ),
    );
    expect(writes.has("POST /api/computer-control")).toBe(true);
    const open = await answeredOtherwise(instance, writes, 403, {
      "Content-Type": "text/plain",
    });
    expect(open, `open routes:\n${open.join("\n")}`).toEqual([]);
  });

  it("refuses every /api route addressed to a foreign host", async () => {
    await build();
    // DNS rebinding: a hostile name resolving to this server.
    const endpoints = apiEndpoints(instance, "GET");
    expect(endpoints.has("GET /api/computer-control")).toBe(true);
    const open = await answeredOtherwise(instance, endpoints, 403, {
      Host: "rebinding.example",
      "X-Yep-Anywhere": "true",
    });
    expect(open, `open routes:\n${open.join("\n")}`).toEqual([]);
  });
});
