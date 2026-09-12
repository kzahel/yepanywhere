import {
  CAPABILITY_ID_ENCODING_VERSION,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  SERVER_CAPABILITIES,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dynamic import so vi.resetModules() gives us fresh module state (clears cache)
async function importVersion() {
  const mod = await import("../src/routes/version.js");
  return mod;
}

// Both speech vocabulary capabilities are advertised only once SQLite is
// ready, because learned vocabulary lives in that store. Every other
// capability answers the same way with or without a SQLite status reader.
const SQLITE_GATED_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  SERVER_CAPABILITIES.speechVocabulary.name,
  SERVER_CAPABILITIES.speechVocabularySessionTerms.name,
]);

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

  it("advertises subagent depth on an untagged source build in every encoding", async () => {
    mockFetch(() => new Response(JSON.stringify({ version: "0.8.1" })));
    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getCurrentVersionInfo: async () => ({
        version: "5756cfd",
        installSource: "source",
      }),
      getSessionSandboxAvailability: async () => ({
        state: "unsupported-platform",
        platform: "test",
      }),
    });
    for (const query of [
      "/",
      "/?clientVersion=0.8.1",
      "/?capabilities=compact-v1",
    ]) {
      const version = await (await routes.request(query)).json();
      expect(version.current).toBe("5756cfd");
      expect(
        serverHasCapability(version, SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY),
      ).toBe(true);
    }
  });

  it.each(["disabled", "unsupported", "ready", "error"] as const)(
    "reports retained SQLite %s status and gates vocabulary in every encoding",
    async (state) => {
      mockFetch(() => new Response(JSON.stringify({ version: "0.8.1" })));
      const { createVersionRoutes } = await importVersion();
      const getSqliteStatus = vi.fn(() => ({ state }));
      const options = {
        getCurrentVersionInfo: async () => ({
          version: "0.8.1",
          installSource: "source" as const,
        }),
        getSessionSandboxAvailability: async () => ({
          state: "unsupported-platform" as const,
          platform: "test",
        }),
      };
      const legacy = createVersionRoutes(options);
      const routes = createVersionRoutes({ ...options, getSqliteStatus });
      for (const query of [
        "/",
        "/?clientVersion=0.8.1",
        "/?capabilities=compact-v1",
      ]) {
        const before = await (await legacy.request(query)).json();
        const after = await (await routes.request(query)).json();
        expect(before.sqlite).toBeUndefined();
        expect(before.serverRuntime).toEqual({
          kind: process.versions.bun ? "bun" : "node",
          version: process.versions.bun ?? process.versions.node,
        });
        for (const { name } of Object.values(SERVER_CAPABILITIES)) {
          expect(serverHasCapability(after, name), name).toBe(
            SQLITE_GATED_CAPABILITY_NAMES.has(name)
              ? state === "ready"
              : serverHasCapability(before, name),
          );
        }
        // Compare other metadata after checking capabilities semantically;
        // their wire representation differs between the negotiated encodings.
        for (const field of [
          "capabilities",
          "capabilityBits",
          "optionalCapabilityBits",
        ]) {
          delete before[field];
          delete after[field];
        }
        expect(after).toEqual({ ...before, sqlite: { state } });
      }
      // Each response reads retained readiness for capabilities and status.
      expect(getSqliteStatus).toHaveBeenCalledTimes(6);
    },
  );

  it("parses version from update server 200 response", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            version: "99.0.0",
            notes: "New release",
            pub_date: "2026-01-01T00:00:00Z",
          }),
        ),
    );

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({ installId: "test-id" });
    const res = await routes.request("/");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latest).toBe("99.0.0");
    expect(json.current).toBeDefined();
    expect(["npm-global", "source", "release-package", "unknown"]).toContain(
      json.installSource,
    );
  });

  it("normalizes only YA semver git describe versions", async () => {
    const { normalizeGitDescribeVersion } = await importVersion();

    expect(normalizeGitDescribeVersion("v0.5.1-38-ge2ac56ed\n")).toBe(
      "0.5.1-38-ge2ac56ed",
    );
    expect(normalizeGitDescribeVersion("e2ac56ed\n")).toBe("e2ac56ed");
    expect(normalizeGitDescribeVersion("site-v1.6.1-38-ge2ac56ed\n")).toBe(
      "site-v1.6.1-38-ge2ac56ed",
    );
  });

  it("treats 204 as up-to-date", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.updateAvailable).toBe(false);
    expect(json.latest).toBeDefined();
  });

  it("returns null latest on server error", async () => {
    mockFetch(() => new Response("Internal Server Error", { status: 500 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latest).toBeNull();
    expect(json.updateAvailable).toBe(false);
  });

  it("returns null latest on network error", async () => {
    mockFetch(() => {
      throw new Error("Network error");
    });

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/");
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

  it("includes capabilities and compatibility metadata", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { REMOTE_COMPATIBILITY_LEVEL, createVersionRoutes } =
      await importVersion();
    const routes = createVersionRoutes();
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.resumeProtocolVersion).toBeTypeOf("number");
    expect(json.remoteCompatibilityLevel).toBe(REMOTE_COMPATIBILITY_LEVEL);
    expect(Array.isArray(json.capabilities)).toBe(true);
    expect(json.capabilities).toContain(CLAUDE_ADDITIONAL_MODELS_CAPABILITY);
    expect(json.capabilities).toContain(
      CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
    );
    expect(json.capabilities).toContain(SESSION_SANDBOXING_STATUS_CAPABILITY);
  });

  it("advertises session sandboxing only for an available host backend", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const availableRoutes = createVersionRoutes({
      getSessionSandboxAvailability: async () => ({
        state: "available",
        platform: "linux",
        backend: "bubblewrap",
        version: "0.4.0",
      }),
    });
    const available = await (await availableRoutes.request("/")).json();
    expect(available.sessionSandboxing).toEqual({
      state: "available",
      platform: "linux",
      backend: "bubblewrap",
      version: "0.4.0",
    });
    expect(available.capabilities).toContain(SESSION_SANDBOXING_CAPABILITY);

    const unsupportedRoutes = createVersionRoutes({
      getSessionSandboxAvailability: async () => ({
        state: "unsupported-platform",
        platform: "darwin",
      }),
    });
    const unsupported = await (await unsupportedRoutes.request("/")).json();
    expect(unsupported.sessionSandboxing).toEqual({
      state: "unsupported-platform",
      platform: "darwin",
    });
    expect(unsupported.capabilities).not.toContain(
      SESSION_SANDBOXING_CAPABILITY,
    );
  });

  it("advertises validated server-routed voice backends", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getEnabledVoiceBackends: () => ["ya-dummy"],
      getVoiceBackendCapabilities: () => ({ "ya-dummy": {} }),
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.capabilities).toContain(VOICE_INPUT_CAPABILITY);
    expect(json.voiceBackends).toEqual(["ya-dummy"]);
    expect(json.voiceBackendCapabilities).toEqual({ "ya-dummy": {} });
  });

  it("negotiates version-implied and optional-bit capabilities", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getSessionSandboxAvailability: async () => ({
        state: "unsupported-platform",
        platform: "darwin",
      }),
    });
    const response = await routes.request("/?capabilities=compact-v1");
    const version = await response.json();

    expect(version.capabilities).toBeUndefined();
    expect(version.optionalCapabilityBits).toEqual([
      [0, 1],
      [2, 64],
    ]);
    expect(serverHasCapability(version, PROJECT_QUEUE_CAPABILITY)).toBe(true);
    expect(
      serverHasCapability(
        version,
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(true);
    expect(serverHasCapability(version, VOICE_INPUT_CAPABILITY)).toBe(true);
    expect(serverHasCapability(version, DEVICE_BRIDGE_CAPABILITY)).toBe(false);
  });

  it("selects ID capabilities from the client semantic version", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getCurrentVersionInfo: async () => ({
        version: "0.7.1",
        installSource: "source",
      }),
      getSessionSandboxAvailability: async () => ({
        state: "unsupported-platform",
        platform: "darwin",
      }),
    });
    const response = await routes.request("/", {
      headers: { "X-Yep-Client-Version": "0.7.1" },
    });
    const version = await response.json();

    expect(version.capabilities).toBeUndefined();
    expect(version.capabilityEncoding).toBe(CAPABILITY_ID_ENCODING_VERSION);
    expect(Array.isArray(version.capabilityBits)).toBe(true);
    expect(serverHasCapability(version, PROJECT_QUEUE_CAPABILITY)).toBe(true);
    expect(serverHasCapability(version, VOICE_INPUT_CAPABILITY)).toBe(true);
    expect(serverHasCapability(version, DEVICE_BRIDGE_CAPABILITY)).toBe(false);
  });

  it("sends negative IDs for withdrawn version-implied contracts", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      deniedCapabilities: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
      getCurrentVersionInfo: async () => ({
        version: "0.7.1",
        installSource: "source",
      }),
      getSessionSandboxAvailability: async () => ({
        state: "unsupported-platform",
        platform: "darwin",
      }),
    });
    const encodedResponse = await routes.request("/", {
      headers: { "X-Yep-Client-Version": "0.7.1" },
    });
    const encodedVersion = await encodedResponse.json();

    expect(encodedVersion.deniedCapabilityBits).toBeDefined();
    expect(
      serverHasCapability(encodedVersion, PROJECT_SESSION_DEFAULTS_CAPABILITY),
    ).toBe(false);

    const legacyResponse = await routes.request("/", {
      headers: { "X-Yep-Client-Version": "0.7.0" },
    });
    const legacyVersion = await legacyResponse.json();
    expect(legacyVersion.deniedCapabilityBits).toBeUndefined();
    expect(legacyVersion.capabilities).not.toContain(
      PROJECT_SESSION_DEFAULTS_CAPABILITY,
    );
  });

  it("keeps legacy names for a pre-ID client version", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes();
    const response = await routes.request("/", {
      headers: { "X-Yep-Client-Version": "0.7.0" },
    });
    const version = await response.json();

    expect(version.capabilityEncoding).toBeUndefined();
    expect(version.capabilityBits).toBeUndefined();
    expect(version.capabilities).toContain(PROJECT_QUEUE_CAPABILITY);
  });

  it("reports configured speech backends while validation is pending", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getEnabledVoiceBackends: () => [],
      getVoiceBackendStatuses: () => [
        {
          id: "ya-nemo",
          label: "Local NeMo Parakeet",
          enabled: false,
          validationStatus: "pending",
          capabilities: {},
        },
      ],
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.voiceBackends).toEqual([]);
    expect(json.voiceBackendStatuses).toEqual([
      expect.objectContaining({
        id: "ya-nemo",
        enabled: false,
        validationStatus: "pending",
      }),
    ]);
  });

  it("advertises streaming voice backend capabilities", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getEnabledVoiceBackends: () => ["ya-grok"],
      getVoiceBackendCapabilities: () => ({
        "ya-grok": { streaming: true, smartTurn: true },
      }),
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.voiceBackendCapabilities).toEqual({
      "ya-grok": { streaming: true, smartTurn: true },
    });
  });

  it("includes server-learned client defaults", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      getClientDefaults: () => ({
        speech: {
          voiceInputEnabled: true,
          speechMethod: "ya-grok",
        },
        sessionToolbarPresence: {
          microphone: "pin",
          slashMenu: "hidden",
        },
      }),
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.clientDefaults).toEqual({
      speech: {
        voiceInputEnabled: true,
        speechMethod: "ya-grok",
      },
      sessionToolbarPresence: {
        microphone: "pin",
        slashMenu: "hidden",
      },
    });
  });

  it("does not advertise voice backends when voice input is disabled", async () => {
    mockFetch(() => new Response(null, { status: 204 }));

    const { createVersionRoutes } = await importVersion();
    const routes = createVersionRoutes({
      voiceInputEnabled: false,
      getEnabledVoiceBackends: () => ["ya-dummy"],
    });
    const res = await routes.request("/");
    const json = await res.json();

    expect(json.capabilities).not.toContain(VOICE_INPUT_CAPABILITY);
    expect(json.voiceBackends).toEqual([]);
    expect(json.voiceBackendCapabilities).toEqual({});
  });

  it("advertises Project Queue support as a server capability", async () => {
    const { getServerCapabilities } = await importVersion();

    expect(getServerCapabilities()).toContain(PROJECT_QUEUE_CAPABILITY);
    expect(getServerCapabilities()).toContain(
      PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(
      PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
    );
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
    expect(json.capabilities).toContain(DEVICE_BRIDGE_DOWNLOAD_CAPABILITY);
    expect(json.capabilities).toContain(DEVICE_BRIDGE_UPDATE_CAPABILITY);
    expect(json.capabilities).not.toContain(DEVICE_BRIDGE_CAPABILITY);
  });

  it("preserves legacy sync bridge state for compatibility helpers", async () => {
    const { getServerCapabilities } = await importVersion();
    const capabilities = getServerCapabilities({
      getDeviceBridgeState: () => "downloadable",
      isDeviceBridgeEnabled: () => true,
    });

    expect(capabilities).toContain(DEVICE_BRIDGE_DOWNLOAD_CAPABILITY);
    expect(capabilities).not.toContain(DEVICE_BRIDGE_UPDATE_CAPABILITY);
  });
});

describe("process-generation version facts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("probes the install once no matter how many requests arrive", async () => {
    const { createVersionRoutes, getCurrentVersionInfoComputations } =
      await importVersion();
    const app = createVersionRoutes();

    for (let request = 0; request < 20; request += 1) {
      const response = await app.request("/");
      expect(response.status).toBe(200);
    }

    expect(getCurrentVersionInfoComputations()).toBe(1);
  });

  it("shares one probe across concurrent first requests", async () => {
    const { createVersionRoutes, getCurrentVersionInfoComputations } =
      await importVersion();
    const app = createVersionRoutes();

    await Promise.all(Array.from({ length: 10 }, () => app.request("/")));

    expect(getCurrentVersionInfoComputations()).toBe(1);
  });

  it("keeps the version snapshot across an explicit fresh request", async () => {
    const { createVersionRoutes, getCurrentVersionInfoComputations } =
      await importVersion();
    const app = createVersionRoutes();

    const first = await (await app.request("/")).json();
    const fresh = await (await app.request("/?fresh=1")).json();

    // fresh=1 promises a fresh check of dynamic sandbox/device facts only.
    expect(fresh.version).toBe(first.version);
    expect(getCurrentVersionInfoComputations()).toBe(1);
  });
});
