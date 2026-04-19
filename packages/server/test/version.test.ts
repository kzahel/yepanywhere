import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dynamic import so vi.resetModules() gives us fresh module state (clears cache)
async function importVersion() {
  const mod = await import("../src/routes/version.js");
  return mod;
}

describe("GET /version", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(
    handler: (
      url: string | URL | Request,
      init?: RequestInit,
    ) => Response | Promise<Response>,
  ) {
    global.fetch = vi.fn(handler) as unknown as typeof fetch;
  }

  it("returns null latest immediately on first non-fresh request and refreshes in background", async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({ installId: "test-id" });
    const res = await routes.request("/");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latest).toBeNull();
    expect(json.updateAvailable).toBe(false);
    expect(json.current).toBeDefined();

    resolveFetch?.(
      new Response(
        JSON.stringify({
          version: "99.0.0",
          notes: "New release",
          pub_date: "2026-01-01T00:00:00Z",
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmedRes = await routes.request("/");
    const warmedJson = await warmedRes.json();
    expect(warmedJson.latest).toBe("99.0.0");
  });

  it("treats 204 as up-to-date on fresh requests", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/?fresh=1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.updateAvailable).toBe(false);
    expect(json.latest).toBeDefined();
  });

  it("returns null latest on server error for fresh requests", async () => {
    mockFetch(() => new Response("Internal Server Error", { status: 500 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/?fresh=1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latest).toBeNull();
    expect(json.updateAvailable).toBe(false);
  });

  it("returns null latest on network error for fresh requests", async () => {
    mockFetch(() => {
      throw new Error("Network error");
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/?fresh=1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latest).toBeNull();
    expect(json.updateAvailable).toBe(false);
  });

  it("sends installId as X-CFU-ID header", async () => {
    let capturedHeaders: Headers | undefined;
    mockFetch((_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({ installId: "my-install-id" });
    await routes.request("/");

    expect(capturedHeaders?.get("X-CFU-ID")).toBe("my-install-id");
  });

  it("omits X-CFU-ID header when installId is not provided", async () => {
    let capturedHeaders: Headers | undefined;
    mockFetch((_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    await routes.request("/");

    expect(capturedHeaders?.get("X-CFU-ID")).toBeNull();
  });

  it("sends current version in URL path", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = String(url);
      return new Response(null, { status: 204 });
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    await routes.request("/");

    expect(capturedUrl).toMatch(
      /https:\/\/updates\.yepanywhere\.com\/version\/.+/,
    );
  });

  it("caches result for 24 hours", async () => {
    const realDateNow = Date.now;
    let now = realDateNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify({ version: "1.0.0" }));
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();

    await routes.request("/");
    expect(fetchCount).toBe(1);

    // Second request within cache TTL
    await routes.request("/");
    expect(fetchCount).toBe(1);

    // Advance past 24 hour TTL
    now += 24 * 60 * 60 * 1000 + 1;

    await routes.request("/");
    expect(fetchCount).toBe(2);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("bypasses cache when fresh=1 is requested", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify({ version: "1.0.0" }));
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();

    await routes.request("/");
    expect(fetchCount).toBe(1);

    await routes.request("/");
    expect(fetchCount).toBe(1);

    await routes.request("/?fresh=1");
    expect(fetchCount).toBe(2);
  });

  it("includes capabilities and resumeProtocolVersion", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.resumeProtocolVersion).toBeTypeOf("number");
    expect(Array.isArray(json.capabilities)).toBe(true);
  });

  it("reports update-available for stale bridge binaries", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      isDeviceBridgeEnabled: () => true,
      getDeviceBridgeStatus: async () => ({
        state: "update-available",
        installedVersion: "0.1.0",
        latestVersion: "0.2.0",
      }),
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.deviceBridgeState).toBe("update-available");
    expect(json.deviceBridgeVersion).toBe("0.1.0");
    expect(json.latestDeviceBridgeVersion).toBe("0.2.0");
    expect(json.capabilities).toContain("deviceBridge-download");
    expect(json.capabilities).toContain("deviceBridge-update");
    expect(json.capabilities).not.toContain("deviceBridge");
  });

  it("preserves legacy sync bridge state for compatibility helpers", async () => {
    const { getServerCapabilities } = await importVersion();
    const capabilities = getServerCapabilities({
      getDeviceBridgeState: () => "downloadable",
      isDeviceBridgeEnabled: () => true,
    });

    expect(capabilities).toContain("deviceBridge-download");
    expect(capabilities).not.toContain("deviceBridge-update");
  });
});
