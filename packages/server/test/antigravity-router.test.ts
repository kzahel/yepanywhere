import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentAuthRouterRoutes } from "../src/routes/agent-auth-router.js";
import { AntigravityProvider } from "../src/sdk/providers/antigravity.js";
import { prepareAntigravityRoutedProfile } from "../src/sdk/providers/antigravity-routed-profile.js";
import { startRouterLoopbackProxy } from "../src/sdk/providers/router-loopback-proxy.js";
import {
  antigravityAllSessionsDirs,
  setAntigravityRoutedHomeDir,
} from "../src/sdk/providers/antigravity-runtime.js";
import { RouterUnavailable } from "../src/services/AgentAuthRouter.js";
import { AntigravitySessionReader } from "../src/sessions/antigravity-reader.js";
import { antigravitySessionWatcherSpec } from "../src/sessions/antigravity-summaries.js";
import { nativeCatalogAdapters } from "../src/sessions/catalog-adapters/native-catalog-registry.js";
import { EventBus } from "../src/watcher/EventBus.js";
import { ProviderSessionWatcherRegistry } from "../src/watcher/ProviderSessionWatcherRegistry.js";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { routerFixtureFor } from "./utils/agent-auth-router-fixture.js";
import { writeAntigravitySummaries } from "./utils/antigravity-store.js";

const cleanups: (() => Promise<void>)[] = [];
const fixture = routerFixtureFor(cleanups);

afterEach(async () => {
  setAntigravityRoutedHomeDir(undefined);
  delete process.env.ANTIGRAVITY_ACP_PATH;
  delete process.env.CLOUD_CODE_URL;
  delete process.env.GEMINI_HOME;
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("routed Antigravity profile and loopback proxy", () => {
  it("prepares a private profile marker, reuses it across concurrent sessions, and refuses real OAuth or insecure files", async () => {
    const root = await makeTempDir("ya-agy-profile-");
    const home = join(root, "antigravity-home");

    const first = prepareAntigravityRoutedProfile(home);
    const second = prepareAntigravityRoutedProfile(home);
    expect(first.marker).toMatch(/^aar_local_[A-Za-z0-9_-]{32,}$/);
    expect(second.marker).toBe(first.marker);

    if (process.platform !== "win32") {
      expect((await lstat(home)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(home, "antigravity-cli"))).mode & 0o777).toBe(
        0o700,
      );
      expect(
        (await lstat(join(home, "antigravity-cli", "antigravity-oauth-token")))
          .mode & 0o777,
      ).toBe(0o600);
    }

    const tokenJson = JSON.parse(
      await readFile(
        join(home, "antigravity-cli", "antigravity-oauth-token"),
        "utf8",
      ),
    ) as { auth_method?: string; token?: Record<string, unknown> };
    expect(tokenJson.auth_method).toBe("consumer");
    expect(tokenJson.token?.access_token).toBe(first.marker);
    expect(tokenJson.token?.refresh_token).toBeUndefined();

    // Refuse a directory containing a real Google OAuth credential.
    const realOauthHome = join(root, "real-oauth");
    await mkdir(join(realOauthHome, "antigravity-cli"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(realOauthHome, 0o700);
    await chmod(join(realOauthHome, "antigravity-cli"), 0o700);
    await writeFile(
      join(realOauthHome, "antigravity-cli", "antigravity-oauth-token"),
      JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "ya29.real-google-token",
          refresh_token: "1//real-refresh",
        },
      }),
      { mode: 0o600 },
    );
    expect(() => prepareAntigravityRoutedProfile(realOauthHome)).toThrow(
      /real Google OAuth/i,
    );

    // Refuse overly permissive mode on POSIX.
    if (process.platform !== "win32") {
      const looseHome = join(root, "loose");
      await mkdir(looseHome, { mode: 0o755 });
      await chmod(looseHome, 0o755);
      expect(() => prepareAntigravityRoutedProfile(looseHome)).toThrow(
        /permissive/i,
      );

      // Refuse symlinked profile root.
      const linkHome = join(root, "link-home");
      await symlink(home, linkHome);
      expect(() => prepareAntigravityRoutedProfile(linkHome)).toThrow(
        /regular directory/i,
      );
    }
  });

  it("requires its own Host and local token, keeps requests on the binding's route, swaps the credential, streams, and tears down", async () => {
    const received: Array<{
      url: string;
      method: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];

    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      received.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      if (req.url?.includes("streamGenerateContent")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "set-cookie": "secret=must-strip",
          "x-custom-ok": "1",
        });
        res.write('data: {"chunk":1}\n\n');
        setTimeout(() => {
          if (!res.writableEnded) {
            res.write('data: {"chunk":2}\n\n');
            res.end();
          }
        }, 30);
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "should-not-leak=1",
      });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolveListen) =>
      upstream.listen(0, "127.0.0.1", resolveListen),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolveClose) => {
          upstream.closeAllConnections();
          upstream.close(() => resolveClose());
        }),
    );
    const addr = upstream.address();
    if (!addr || typeof addr === "string") throw new Error("No upstream port");

    const gatewayToken = "aar_session_secret_token_never_leaks";
    const marker = "aar_local_0123456789abcdef0123456789abcdef0123";
    const bridge = await startRouterLoopbackProxy({
      baseUrl: `http://127.0.0.1:${addr.port}/antigravity`,
      token: gatewayToken,
      localToken: marker,
    });
    cleanups.push(() => bridge.close());

    await expect(
      startRouterLoopbackProxy({
        baseUrl: `http://127.0.0.1:${addr.port}/antigravity`,
        token: gatewayToken,
        localToken: gatewayToken,
      }),
    ).rejects.toThrow(/refuses the binding token/);
    // With no route, a target such as `/.//elsewhere.test/` would name
    // another host, and the token would follow it there.
    await expect(
      startRouterLoopbackProxy({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        token: gatewayToken,
        localToken: marker,
      }),
    ).rejects.toThrow(/requires a route below the origin/);

    // Sends the request line as written; fetch would resolve dot segments.
    const bridgeUrl = new URL(bridge.endpoint);
    const raw = (
      path: string,
      headers: http.OutgoingHttpHeaders,
      method = "POST",
    ) =>
      new Promise<number>((resolveStatus, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: Number(bridgeUrl.port),
            method,
            path,
            headers,
          },
          (res) => {
            res.resume();
            resolveStatus(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(
          method === "POST" || headers["transfer-encoding"] ? "{}" : undefined,
        );
      });
    const local = { authorization: `Bearer ${marker}` };

    // No local token, the binding token itself, or another Host: refused here.
    expect(await raw("/v1internal:loadCodeAssist", {})).toBe(401);
    expect(
      await raw("/v1internal:loadCodeAssist", {
        authorization: `Bearer ${gatewayToken}`,
      }),
    ).toBe(401);
    expect(
      await raw("/v1internal:loadCodeAssist", {
        ...local,
        host: "evil.example:1234",
      }),
    ).toBe(403);
    // Encoded traversal and a second origin are not request targets.
    expect(await raw("/v1internal:x%2f..%2f..%2fclaude", local)).toBe(400);
    expect(await raw("//evil.example/v1/messages", local)).toBe(400);
    // Node sends a GET without body framing, so a forwarded body would reach
    // the router as a second request that passed none of these checks.
    expect(
      await raw(
        "/v1internal:loadCodeAssist",
        { ...local, "transfer-encoding": "chunked" },
        "GET",
      ),
    ).toBe(400);
    expect(received).toHaveLength(0);

    // Any other path and method is the router's to judge, and stays below
    // the route even where its dot segments or a second `//` point elsewhere.
    expect(await raw("/a/../../../claude/v1/messages", local, "GET")).toBe(200);
    expect(await raw("/.//elsewhere.test/v1/messages", local)).toBe(200);
    expect(received.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/antigravity/claude/v1/messages"],
      ["POST", "/antigravity//elsewhere.test/v1/messages"],
    ]);
    received.length = 0;

    // The binding token replaces the local one; nothing the program sends
    // can name another credential or a forwarding chain to the router.
    const okRes = await fetch(
      `${bridge.endpoint}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${marker}`,
          "content-type": "application/json",
          "user-agent": "antigravity/hub/2.24.0",
          "x-goog-api-client": "fixture-client",
          cookie: "drop=me",
          "x-aar-gateway-token": "drop-me",
          "x-api-key": "drop-me",
          "x-forwarded-for": "203.0.113.9",
        },
        body: '{"hello":"world"}',
      },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("set-cookie")).toBeNull();
    expect(okRes.headers.get("x-custom-ok")).toBe("1");
    const sseText = await okRes.text();
    expect(sseText).toContain('{"chunk":1}');
    expect(sseText).toContain('{"chunk":2}');

    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe(
      "/antigravity/v1internal:streamGenerateContent?alt=sse",
    );
    expect(received[0]?.headers.authorization).toBe(`Bearer ${gatewayToken}`);
    expect(received[0]?.headers).toMatchObject({
      "user-agent": "antigravity/hub/2.24.0",
      "x-goog-api-client": "fixture-client",
    });
    for (const dropped of [
      "cookie",
      "x-aar-gateway-token",
      "x-api-key",
      "x-forwarded-for",
    ])
      expect(received[0]?.headers[dropped]).toBeUndefined();
    expect(received[0]?.body).toBe('{"hello":"world"}');

    // Close tears down listener cleanly
    await bridge.close();
    await expect(
      fetch(`${bridge.endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: { authorization: `Bearer ${marker}` },
        body: "{}",
      }),
    ).rejects.toThrow();
  });
});

describe("AgentAuthRouter Antigravity control and capability gating", () => {
  it("falls back to null discovery and refuses launch when AAR lacks antigravity-control-v1", async () => {
    const f = await fixture(true, true, true, true);
    f.antigravityAccount(false);
    await f.connector.connect(f.socketPath);

    expect(await f.connector.selection("antigravity")).toBeNull();
    await expect(
      f.connector.launch(
        "sess-old-aar",
        "antigravity",
        "fixture-model",
        undefined,
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      ),
    ).rejects.toThrow(/Update AAR to route Antigravity/i);
  });

  it("allocates Antigravity pool bindings with profileDir, keeps token out of metadata, fails closed on revocation, and refuses switch", async () => {
    const f = await fixture(true, true, true, true);
    f.antigravityAccount(true);
    f.name("Personal AGY", "AGY Pool");
    // A route YA could not have assembled from the provider name.
    f.describeTransport({
      kind: "http-gateway-v1",
      basePath: "/antigravity/described",
      authMethods: ["bearer"],
    });
    await f.connector.connect(f.socketPath);

    const sel = await f.connector.selection("antigravity");
    expect(sel).not.toBeNull();
    expect(
      f.requests.some(
        (r) => r.path === "/v1/selection" && r.body.provider === "antigravity",
      ),
    ).toBe(true);

    const launch = await f.connector.launch(
      "sess-agy-1",
      "antigravity",
      "fixture-model",
      undefined,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(launch).toBeDefined();
    expect(launch?.baseUrl).toBe("http://127.0.0.1:8417/antigravity/described");
    expect(launch?.profileDir).toBe(
      join(f.root, "agent-auth-router", "antigravity-home"),
    );
    expect(launch?.token).toMatch(/^aar_/);

    const stored = f.metadata.getMetadata("sess-agy-1");
    expect(stored?.routerBinding?.provider).toBe("antigravity");
    expect(stored?.routerBinding?.accountId).toBe("account");
    expect(JSON.stringify(stored)).not.toContain(launch!.token);

    // Mid-session switch stays refused for Antigravity in v1.
    const routes = createAgentAuthRouterRoutes(f.connector, () => ({
      getProcessForSession: () => undefined,
      abortSessionWithVerification: async () => true,
    }));
    const switchRes = await routes.request(
      "/agent-auth-router/sessions/sess-agy-1/switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direct: true }),
      },
    );
    expect(switchRes.status).toBe(409);

    // Revocation fails closed with no direct fallback.
    f.revoke();
    await expect(
      f.connector.launch("sess-agy-1", "antigravity", "fixture-model"),
    ).rejects.toBeInstanceOf(RouterUnavailable);
  });
});

describe("Antigravity dual-store native history and routed provider launch", () => {
  it("lists and reads both direct and routed Antigravity stores concurrently without conflict", async () => {
    if (process.platform === "win32") return;
    const root = await makeTempDir("ya-agy-dual-");
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const directHome = join(root, "direct-home");
    const routedHome = join(root, "routed-home");
    const directStore = join(directHome, "antigravity-cli");
    const routedStore = join(routedHome, "antigravity-cli");
    const directId = randomUUID();
    const routedId = randomUUID();

    await writeAntigravitySummaries(directStore, [
      { id: directId, cwd: projectDir, title: "Direct session", stepCount: 1 },
    ]);
    await writeAntigravitySummaries(routedStore, [
      { id: routedId, cwd: projectDir, title: "Routed session", stepCount: 1 },
    ]);
    await writeFile(join(directStore, "conversations", `${directId}.db`), "");
    await writeFile(join(routedStore, "conversations", `${routedId}.db`), "");

    process.env.CLOUD_CODE_URL = "http://127.0.0.1:9999";
    process.env.GEMINI_HOME = directHome;
    setAntigravityRoutedHomeDir(routedHome);

    expect(antigravityAllSessionsDirs()).toEqual([
      join(directStore, "conversations"),
      join(routedStore, "conversations"),
    ]);

    const adapters = nativeCatalogAdapters(["antigravity"]);
    expect(adapters).toHaveLength(2);
    const rows = (
      await Promise.all(
        adapters.map((adapter) =>
          adapter.scan({
            catalogEpoch: "test",
            targetGeneration: 1,
            mode: { kind: "complete" },
            signal: new AbortController().signal,
          }),
        ),
      )
    ).flatMap((result) => [...result.rows]);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(
      [directId, routedId].sort(),
    );
    expect(new Set(rows.map((r) => r.nativeStorageScope)).size).toBe(2);

    const reader = AntigravitySessionReader.create({
      projectPath: projectDir,
      catalogRows: async () => rows,
    });
    const projectId = toUrlProjectId(projectDir);
    const listed = await reader.listSessions(projectId);
    expect(listed.map((s) => s.title).sort()).toEqual([
      "Direct session",
      "Routed session",
    ]);
    expect(
      (await reader.getNativeSessionRef(directId as never))?.storageScope,
    ).toBe(await realpath(join(directStore, "conversations")));
    expect(
      (await reader.getNativeSessionRef(routedId as never))?.storageScope,
    ).toBe(await realpath(join(routedStore, "conversations")));
    await reader.close?.();
  });

  it("launches agy acp against a per-session bridge without leaking the AAR token and closes the bridge on exit", async () => {
    if (process.platform === "win32") return;
    const root = await makeTempDir("ya-agy-launch-");
    const projectDir = join(root, "project");
    const routedHome = join(root, "routed-home");
    const captureFile = join(root, "captured-launch.json");
    const fakeAgy = join(root, "fake-agy.mjs");
    await mkdir(projectDir, { recursive: true });

    const upstreamCalls: Array<{ url: string; authorization?: string }> = [];
    const fakeAar = http.createServer((req, res) => {
      upstreamCalls.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolveListen) =>
      fakeAar.listen(0, "127.0.0.1", resolveListen),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolveClose) => {
          fakeAar.closeAllConnections();
          fakeAar.close(() => resolveClose());
        }),
    );
    const aarAddr = fakeAar.address();
    if (!aarAddr || typeof aarAddr === "string")
      throw new Error("No fake AAR port");

    const sessionUuid = randomUUID();
    await writeFile(
      fakeAgy,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const epIdx = args.indexOf("--cloud_code_endpoint");
const dirIdx = args.indexOf("--gemini-dir");
const endpoint = epIdx >= 0 ? args[epIdx + 1] : null;
const geminiDir = dirIdx >= 0 ? args[dirIdx + 1] : null;
const tokenFile = geminiDir ? JSON.parse(readFileSync(join(geminiDir, "antigravity-cli", "antigravity-oauth-token"), "utf8")) : null;

if (endpoint) writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  pid: process.pid,
  args,
  endpoint,
  geminiDir,
  tokenFile,
  env: {
    GEMINI_HOME: process.env.GEMINI_HOME ?? null,
    CLOUD_CODE_URL: process.env.CLOUD_CODE_URL ?? null,
    SSH_CONNECTION: process.env.SSH_CONNECTION ?? null,
    RAW_ENV: JSON.stringify(process.env),
  },
}));

if (process.env.FAKE_AGY_EXITS_AT_STARTUP && endpoint) process.exit(1);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { agentInfo: { version: "1.5.15" }, agentCapabilities: {} },
    }) + "\\n");
    return;
  }
  if (msg.method === "session/new") {
    if (endpoint && tokenFile?.token?.access_token) {
      await fetch(endpoint + "/v1internal:loadCodeAssist", {
        method: "POST",
        headers: {
          authorization: "Bearer " + tokenFile.token.access_token,
          "content-type": "application/json",
        },
        body: "{}",
      });
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: ${JSON.stringify(sessionUuid)},
        models: {
          currentModelId: "gemini-3.8-flash",
          availableModels: [{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
        },
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "gemini-3.8-flash",
            options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
          },
        ],
      },
    }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );

    process.env.ANTIGRAVITY_ACP_PATH = fakeAgy;
    process.env.CLOUD_CODE_URL = "http://127.0.0.1:1"; // Ambient env must be stripped for routed sessions

    const aarToken = "aar_unique_session_token_987654321";
    const provider = new AntigravityProvider();
    const session = await provider.startSession({
      cwd: projectDir,
      model: "gemini-3.8-flash",
      routerLaunch: {
        bindingId: "binding-1",
        accountId: "personal-antigravity",
        baseUrl: `http://127.0.0.1:${aarAddr.port}/antigravity`,
        token: aarToken,
        profileDir: routedHome,
        models: [
          {
            id: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
          },
        ],
      },
    });

    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: sessionUuid,
    });

    const captured = JSON.parse(await readFile(captureFile, "utf8")) as {
      pid: number;
      args: string[];
      endpoint: string;
      geminiDir: string;
      tokenFile: { auth_method: string; token: { access_token: string } };
      env: {
        GEMINI_HOME: string | null;
        CLOUD_CODE_URL: string | null;
        SSH_CONNECTION: string | null;
        RAW_ENV: string;
      };
    };

    expect(captured.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(captured.geminiDir).toBe(await realpath(routedHome));
    expect(captured.env.GEMINI_HOME).toBe(await realpath(routedHome));
    expect(captured.env.CLOUD_CODE_URL).toBeNull();
    expect(captured.env.SSH_CONNECTION).toBeTruthy();
    expect(captured.tokenFile.auth_method).toBe("consumer");
    expect(captured.tokenFile.token.access_token).toMatch(/^aar_local_/);
    // The real AAR token must NEVER appear in argv, env, or OAuth cache.
    expect(JSON.stringify(captured.args)).not.toContain(aarToken);
    expect(captured.env.RAW_ENV).not.toContain(aarToken);
    expect(JSON.stringify(captured.tokenFile)).not.toContain(aarToken);

    // Fake AAR received the real gateway token on the forwarded RPC.
    expect(upstreamCalls).toEqual([
      {
        url: "/antigravity/v1internal:loadCodeAssist",
        authorization: `Bearer ${aarToken}`,
      },
    ]);

    // Supported models come from the router launch catalog.
    expect(await session.supportedModels?.()).toEqual([
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ]);

    // agy exits on its own while the consumer reads nothing further: the
    // port is released without waiting for the session to be torn down.
    process.kill(captured.pid);
    const refusesConnections = () =>
      fetch(`${captured.endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${captured.tokenFile.token.access_token}`,
        },
        body: "{}",
      }).then(
        () => false,
        () => true,
      );
    await expect.poll(refusesConnections, { timeout: 5_000 }).toBe(true);

    await session.abort();
    await session.iterator.return?.();

    // agy dies before answering `initialize`. The consumer is handed the
    // error and reads no further; the port is already released.
    await rm(captureFile);
    process.env.FAKE_AGY_EXITS_AT_STARTUP = "1";
    cleanups.push(async () => {
      delete process.env.FAKE_AGY_EXITS_AT_STARTUP;
    });
    const failed = await provider
      .startSession({
        cwd: projectDir,
        model: "gemini-3.8-flash",
        routerLaunch: {
          bindingId: "binding-2",
          accountId: "personal-antigravity",
          baseUrl: `http://127.0.0.1:${aarAddr.port}/antigravity`,
          token: aarToken,
          profileDir: routedHome,
          models: [],
        },
      })
      .then(
        (started) => started.iterator.next(),
        (error: unknown) => error,
      );
    const died = JSON.parse(await readFile(captureFile, "utf8")) as {
      endpoint: string;
    };
    expect(died.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(died.endpoint).not.toBe(captured.endpoint);
    expect(
      await fetch(`${died.endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${captured.tokenFile.token.access_token}`,
        },
        body: "{}",
      }).then(
        () => "open",
        () => "refused",
      ),
      JSON.stringify(failed),
    ).toBe("refused");
  });

  it("activates the routed Antigravity store watcher lazily once the routed directory is created", async () => {
    const root = await makeTempDir("ya-agy-watch-");
    const directDir = join(root, "direct", "antigravity-cli", "conversations");
    const dataDir = join(root, "ya-data");
    const routedDir = join(
      dataDir,
      "agent-auth-router",
      "antigravity-home",
      "antigravity-cli",
      "conversations",
    );
    await mkdir(directDir, { recursive: true });

    const watchedDirs: string[] = [];
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [antigravitySessionWatcherSpec(directDir, dataDir)],
      createWatcher: (opts) => {
        watchedDirs.push(opts.watchDir);
        return { start() {}, stop() {}, getObservationEpoch: () => 1 };
      },
    });
    cleanups.push(async () => registry.stop());

    // Initial activation starts only the direct store (routed does not exist yet).
    registry.activateFamily("antigravity");
    expect(watchedDirs).toEqual([await realpath(directDir)]);

    // Once the first routed session creates the routed store, re-requesting
    // activation adds the routed watcher without restarting YA.
    await mkdir(routedDir, { recursive: true });
    registry.activateFamily("antigravity");
    expect(watchedDirs).toEqual([await realpath(directDir), routedDir]);
  });

  it("forwards requests to an IPv6 loopback [::1] AAR upstream", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ url: req.url, auth: req.headers.authorization }),
      );
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        upstream.once("error", rejectListen);
        upstream.listen(0, "::1", () => {
          upstream.removeListener("error", rejectListen);
          resolveListen();
        });
      });
    } catch {
      return; // Skip if host lacks IPv6 loopback.
    }
    cleanups.push(
      () =>
        new Promise<void>((resolveClose) => {
          upstream.closeAllConnections();
          upstream.close(() => resolveClose());
        }),
    );
    const addr = upstream.address();
    if (!addr || typeof addr === "string") return;
    const marker = "aar_local_0123456789abcdef0123456789abcdef0123";
    const bridge = await startRouterLoopbackProxy({
      baseUrl: `http://[::1]:${addr.port}/antigravity`,
      token: "aar_ipv6_token",
      localToken: marker,
    });
    cleanups.push(() => bridge.close());

    const res = await fetch(`${bridge.endpoint}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: { authorization: `Bearer ${marker}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "/antigravity/v1internal:loadCodeAssist",
      auth: "Bearer aar_ipv6_token",
    });
  });
});
