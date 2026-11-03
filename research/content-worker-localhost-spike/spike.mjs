import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir, hostname } from "node:os";
import { resolve, join, dirname } from "node:path";
import { files } from "./fixture.mjs";
import { InstallService } from "../../packages/server/src/services/InstallService.ts";
import {
  writeCapturePreview,
  emitCapturePreview,
} from "../../packages/client/scripts/artifact-capture.ts";
const require = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
);
const { chromium, webkit, expect } = require("@playwright/test");
const esbuild = createRequire(new URL("../../package.json", import.meta.url))(
  "esbuild",
);
const repo = resolve(import.meta.dirname, "../..");
const out = join(repo, ".artifacts/content-worker-spike", String(Date.now()));
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "ya-content-worker-"));
const results = { temp, cases: [] };
const processes = [];
const contexts = [];
const servers = [];
const log = (message) => console.error(`[content worker] ${message}`);
async function until(label, probe, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
    } catch {}
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
function start(label, pkg, env) {
  const process_ = spawn(
    process.execPath,
    [
      "--import",
      require.resolve("tsx/esm"),
      "--conditions",
      "source",
      "src/index.ts",
    ],
    {
      cwd: join(repo, "packages", pkg),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  processes.push(process_);
  for (const stream of [process_.stdout, process_.stderr])
    stream.on("data", (bytes) =>
      appendFileSync(join(out, `${label}.log`), bytes),
    );
}
async function setupYA(allowedOrigin) {
  const home = join(temp, "home"),
    data = join(temp, "ya"),
    claude = join(temp, "claude/projects"),
    project = join(temp, "project");
  for (const path of [home, data, claude, project])
    mkdirSync(path, { recursive: true });
  for (const [path, [, bytes]] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), bytes);
  }
  const install = new InstallService({ dataDir: data });
  await install.initialize();
  await install.recordSuccessfulProviders(["claude"]);
  const session = join(claude, hostname(), project.replaceAll("/", "-"));
  mkdirSync(session, { recursive: true });
  writeFileSync(
    join(session, "content-worker-demo.jsonl"),
    JSON.stringify({
      type: "user",
      uuid: "demo-user",
      sessionId: "content-worker-demo",
      cwd: project,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Service-worker artifact fixture" },
    }) + "\n",
  );
  const relayFile = join(temp, "relay.port");
  start("relay", "relay", {
    RELAY_PORT: "0",
    RELAY_PORT_FILE: relayFile,
    RELAY_DATA_DIR: join(temp, "relay"),
    RELAY_LOG_TO_FILE: "false",
    RELAY_LOG_LEVEL: "warn",
    RELAY_ALLOWED_ORIGINS: allowedOrigin,
  });
  const relayPort = await until(
    "relay port",
    () => existsSync(relayFile) && readFileSync(relayFile, "utf8").trim(),
  );
  const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
  const env = {
    HOME: home,
    USERPROFILE: home,
    YEP_DATA_DIR: data,
    CLAUDE_SESSIONS_DIR: claude,
    CODEX_SESSIONS_DIR: join(temp, "codex"),
    GEMINI_SESSIONS_DIR: join(temp, "gemini"),
    YEP_PROVIDER_HOST_ENABLED: "false",
    YEP_PROVIDER_HOST_RUNTIME_DIR: join(temp, "run"),
    ENABLED_PROVIDERS: "claude",
  };
  execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx/esm"),
      "--conditions",
      "source",
      "src/cli.ts",
      "--setup-remote-access",
      "--username",
      "content-worker-spike",
      "--password",
      "test-only-content-worker",
      "--relay",
      relayUrl,
    ],
    {
      cwd: join(repo, "packages/server"),
      env: { ...process.env, ...env },
      stdio: "pipe",
    },
  );
  const portFile = join(temp, "server.port");
  start("server", "server", {
    ...env,
    PORT: "0",
    PORT_FILE: portFile,
    MAINTENANCE_PORT: "-1",
    AUTH_DISABLED: "true",
    HTTPS_SELF_SIGNED: "",
    NODE_ENV: "production",
    SERVE_FRONTEND: "false",
    LOG_LEVEL: "warn",
  });
  const port = await until(
    "YA port",
    () => existsSync(portFile) && readFileSync(portFile, "utf8").trim(),
    60000,
  );
  await until(
    "relay registration",
    async () =>
      ["waiting", "connected"].includes(
        (
          await (
            await fetch(
              `http://127.0.0.1:${port}/api/remote-access/relay/status`,
              { headers: { "X-Yep-Anywhere": "true" } },
            )
          ).json()
        ).status,
      ),
    30000,
  );
  return {
    project,
    projectId: Buffer.from(project).toString("base64url"),
    relayUrl,
    username: "content-worker-spike",
    password: "test-only-content-worker",
  };
}

let bundle;
let parentOrigin;
const contentLog = [];
try {
  const built = await esbuild.build({
    entryPoints: [join(import.meta.dirname, "parent.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    conditions: ["source"],
    alias: {
      crypto: join(repo, "packages/client/src/lib/connection/browserCrypto.ts"),
    },
    define: {
      "import.meta.env": "{}",
      __APP_VERSION__: JSON.stringify("content-worker-spike"),
      __EXTENSION_DEV_BUILD_ID__: '""',
      __EXTENSION_DEV_WORKER_HASH__: '""',
    },
  });
  bundle = built.outputFiles[0].text;
  const contentServer = await listen((req, res) => {
    const url = new URL(req.url, "http://unused");
    contentLog.push({
      host: req.headers.host,
      path: url.pathname,
      site: req.headers["sec-fetch-site"],
      cookie: !!req.headers.cookie,
    });
    const headers = {
      "cache-control": "no-store",
      "origin-agent-cluster": "?1",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    if (url.pathname === "/__ya/bootstrap.html") {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/html",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors ${parentOrigin}; object-src 'none'`,
      });
      return res.end(
        `<!doctype html><meta charset="utf-8"><meta name="ya-parent-origin" content="${parentOrigin}"><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><script src="/__ya/bootstrap.js"></script>`,
      );
    }
    if (
      url.pathname === "/__ya/bootstrap.js" ||
      url.pathname === "/__ya/worker.js"
    ) {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/javascript",
        "service-worker-allowed": "/v/",
      });
      return res.end(
        readFileSync(
          join(
            import.meta.dirname,
            url.pathname.endsWith("worker.js") ? "worker.js" : "bootstrap.js",
          ),
        ),
      );
    }
    res.writeHead(404, { ...headers, "content-type": "text/plain" });
    res.end("No artifact bytes on this server");
  });
  let config;
  const appServer = await listen((req, res) => {
    const url = new URL(req.url, "http://unused");
    if (url.pathname === "/parent.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(bundle);
    }
    if (url.pathname.startsWith("/fixture/")) {
      const file = files[decodeURIComponent(url.pathname.slice(9))];
      res.writeHead(file ? 200 : 404, {
        "content-type": file?.[0] ?? "text/plain",
        "cache-control": "no-store",
      });
      return res.end(file?.[1] ?? "not in grant");
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "ya-test-cookie=parent-only; SameSite=Strict; Path=/",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws:; frame-src http:; object-src 'none'; base-uri 'none'",
    });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yep artifact worker research</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f0;color:#16372d;font:14px system-ui}header{padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:17px;margin:0}#stats{font-size:12px}#viewers>iframe{display:block;width:100%;height:calc(100vh - 156px);min-height:320px;border:0;border-top:1px solid #d8e3dd}footer{padding:10px 16px}textarea{width:100%;height:55px;font:inherit;padding:8px}button{padding:8px}#status{font-size:12px}</style><header><h1>Yep · content worker spike</h1><span id="status">Connecting</span><span id="stats"></span><button id="stop">Close viewers</button></header><div id="viewers"></div><footer><label for="composer">Host composer</label><textarea id="composer" placeholder="The trusted host stays outside the artifact"></textarea></footer><script id="config" type="application/json">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script><script src="/parent.js"></script>`,
    );
  });
  const ap = appServer.address().port,
    cp = contentServer.address().port;
  const scenarios = [
    {
      name: "localhost-subdomain",
      parent: "localhost",
      content: "usercontent.localhost",
      blocked: false,
    },
    {
      name: "localhost-subdomain-blocked",
      parent: "localhost",
      content: "usercontent.localhost",
      blocked: true,
    },
    {
      name: "nested-same-site",
      parent: "app.yep.localhost",
      content: "g1.usercontent.yep.localhost",
      blocked: false,
    },
    {
      name: "nested-same-site-blocked",
      parent: "app.yep.localhost",
      content: "g1.usercontent.yep.localhost",
      blocked: true,
    },
  ];
  if (process.argv.includes("--relay")) {
    const ya = await setupYA(`http://app.yep.localhost:${ap}`);
    // Relay origin policy compares complete origins, including dynamic port.
    scenarios.push({
      name: "real-encrypted-relay",
      parent: "app.yep.localhost",
      content: "relay.usercontent.yep.localhost",
      blocked: true,
      ya,
    });
  }
  if (process.argv.includes("--webkit"))
    scenarios.push({
      name: "webkit-nested-same-site",
      parent: "app.yep.localhost",
      content: "wk.usercontent.yep.localhost",
      blocked: false,
      engine: "webkit",
    });
  for (const scenario of scenarios) {
    parentOrigin = `http://${scenario.parent}:${ap}`;
    config = {
      files: Object.keys(files),
      contentOrigin: `http://${scenario.content}:${cp}`,
      ...scenario.ya,
    };
    if (process.argv.includes("--only-webkit") && scenario.engine !== "webkit")
      continue;
    const profile = join(temp, scenario.name);
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(
      join(profile, "Default/Preferences"),
      JSON.stringify({
        profile: {
          cookie_controls_mode: scenario.blocked ? 1 : 0,
          block_third_party_cookies: scenario.blocked,
        },
        tracking_protection: { block_all_3pc_toggle_enabled: scenario.blocked },
      }),
    );
    const context = await (scenario.engine === "webkit"
      ? webkit
      : chromium
    ).launchPersistentContext(profile, {
      ...(scenario.engine === "webkit"
        ? {}
        : { channel: "chromium", chromiumSandbox: true }),
      headless: !process.argv.includes("--headed"),
      viewport: { width: 1000, height: 600 },
    });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    contentLog.length = 0;
    const result = {
      name: scenario.name,
      thirdPartyCookiesBlocked: scenario.blocked,
      parentOrigin,
      contentOrigin: config.contentOrigin,
    };
    results.cases.push(result);
    try {
      await page.goto(parentOrigin);
      result.userAgent = await page.evaluate(() => navigator.userAgent);
      await until("worker outcome", () =>
        page.evaluate(() =>
          window.evidence?.some((e) =>
            ["registered", "failed", "parent-error"].includes(e.type),
          ),
        ),
      );
      result.host = await page.evaluate(() => ({
        secure: isSecureContext,
        authenticated: window.authenticated,
        events: window.evidence,
      }));
      result.bootstrapSite = contentLog.find(
        (r) => r.path === "/__ya/bootstrap.html",
      )?.site;
      const frame = () => page.frames().find((f) => f.url().includes("/v/"));
      if (!result.host.events.some((e) => e.type === "registered")) {
        result.outcome = "registration-refused";
        log(`${scenario.name}: registration refused`);
        continue;
      }
      await until("artifact modules", () =>
        frame()?.evaluate(() => window.result),
      );
      result.artifact = await frame().evaluate(async () => {
        await document.fonts.ready;
        let parentDOM;
        try {
          parentDOM = top.document.title;
        } catch (e) {
          parentDOM = String(e);
        }
        return {
          secure: isSecureContext,
          origin: location.origin,
          controlled: !!navigator.serviceWorker.controller,
          image: document.querySelector("#chart").naturalWidth,
          srcset: document.querySelector("#chart").currentSrc,
          font: document.fonts.check("12px ArtifactFont"),
          cssImport: getComputedStyle(document.querySelector(".tag"))
            .letterSpacing,
          cssBackground: getComputedStyle(document.querySelector(".card"))
            .backgroundImage,
          classic: window.classicLoaded,
          modules: window.result,
          parentDOM,
          secret: localStorage.getItem("ya-test-secret"),
        };
      });
      expect(result.artifact.image).toBe(640);
      expect(result.artifact.controlled).toBe(true);
      expect(result.artifact.font).toBe(true);
      expect(result.artifact.cssImport).toBe("0.5px");
      expect(result.artifact.cssBackground).toContain("assets/dot.svg");
      expect(result.artifact.secret).toBe(null);
      result.nativeFetch = await frame().evaluate(async () => {
        const r = await fetch("data.json");
        return {
          status: r.status,
          worker: r.headers.get("x-ya-spike-worker"),
          body: await r.json(),
        };
      });
      expect(result.nativeFetch.worker).toBe("1");
      await frame().getByRole("button", { name: "Explore" }).click();
      await expect(frame().locator("#count")).toHaveText("1");
      const typing = async (target, text) => {
        await target.click();
        let value = "";
        const timings = [];
        for (const char of text) {
          const t = Date.now();
          await page.keyboard.type(char);
          value += char;
          await expect(target).toHaveValue(value, { timeout: 100 });
          timings.push(Date.now() - t);
        }
        return {
          characters: text.length,
          maxMs: Math.max(...timings),
          dropped: 0,
        };
      };
      result.artifactTyping = await typing(
        frame().getByPlaceholder("Type a note"),
        "Relative files without rewriting",
      );
      result.hostTyping = await typing(
        page.getByPlaceholder("The trusted host stays outside the artifact"),
        "The host stays responsive",
      );
      if (scenario.ya) {
        const screenshots = [];
        for (const viewport of [
          { width: 1000, height: 600 },
          { width: 375, height: 812 },
        ]) {
          await page.setViewportSize(viewport);
          await frame().evaluate(() => scrollTo(0, 0));
          const path = join(out, `relay-${viewport.width}.png`);
          await page.screenshot({ path });
          screenshots.push({
            name: `relay-${viewport.width}`,
            ...viewport,
            path,
          });
        }
        emitCapturePreview(
          await writeCapturePreview({
            input:
              "Service worker serves unchanged local HTML and assets over the real encrypted Yep relay",
            out: join(out, "capture"),
            screenshots,
            warnings: [
              "Research host shell, not production YA viewer integration. Screenshots are local-only and must not be committed.",
            ],
          }),
        );
      }
      await frame().getByRole("link", { name: "Open linked document" }).click();
      await until("linked page", () =>
        frame()?.evaluate(() => window.page2 === 3),
      );
      await frame().evaluate(() => location.reload());
      await until("linked page reload", () =>
        frame()?.evaluate(() => window.page2 === 3),
      );
      result.navigationAndReload = true;
      if (scenario.engine !== "webkit") {
        const cdp = await context.newCDPSession(page);
        const versions = [];
        cdp.on("ServiceWorker.workerVersionUpdated", (e) =>
          versions.push(...e.versions),
        );
        await cdp.send("ServiceWorker.enable");
        const version = await until("worker version", () =>
          versions.find(
            (v) =>
              v.scriptURL.startsWith(config.contentOrigin) &&
              v.runningStatus === "running",
          ),
        );
        await cdp.send("ServiceWorker.stopWorker", {
          versionId: version.versionId,
        });
        result.afterWorkerStop = await frame().evaluate(async () => {
          const r = await fetch("data.json?restart=1");
          return {
            status: r.status,
            worker: r.headers.get("x-ya-spike-worker"),
            data: await r.json(),
          };
        });
        expect(result.afterWorkerStop.worker).toBe("1");
        await cdp.detach();
      }
      result.denied = await frame().evaluate(async () => {
        const status = async (url) => {
          try {
            return (await fetch(url)).status;
          } catch (e) {
            return String(e);
          }
        };
        return {
          outside: await status("../not-granted.json"),
          wrongViewer: await status("/v/wrong/report/data.json"),
          api: await status("/api/version"),
        };
      });
      expect([403, "TypeError: Load failed"]).toContain(result.denied.outside);
      expect([503, "TypeError: Load failed"]).toContain(
        result.denied.wrongViewer,
      );
      expect([404, "TypeError: Load failed"]).toContain(result.denied.api);
      const artifactNetwork = contentLog.filter((r) =>
        r.path.startsWith("/v/"),
      );
      expect(artifactNetwork).toHaveLength(0);
      result.networkArtifactRequests = artifactNetwork.length;
      result.cancellation = await frame().evaluate(async () => {
        const response = await fetch("slow.bin");
        const reader = response.body.getReader();
        const first = await reader.read();
        await reader.cancel();
        return { firstChunkBytes: first.value?.byteLength ?? 0 };
      });
      expect(result.cancellation.firstChunkBytes).toBeGreaterThan(0);
      const other = new URL(config.contentOrigin);
      other.hostname = "second." + other.hostname;
      await frame().evaluate(() =>
        localStorage.setItem("viewer-state", "first"),
      );
      await page.evaluate((origin) => window.openViewer(origin), other.origin);
      const second = await until("second viewer", async () => {
        const f = page
          .frames()
          .find((f) => f.url().startsWith(other.origin + "/v/"));
        return f && (await f.evaluate(() => !!window.result)) ? f : undefined;
      });
      expect(
        await second.evaluate(() => localStorage.getItem("viewer-state")),
      ).toBe(null);
      result.concurrentOrigins = [
        await frame().evaluate(() => location.origin),
        await second.evaluate(() => location.origin),
      ];
      const artifactURL = frame().url();
      await page.evaluate((url) => {
        const f = document.createElement("iframe");
        f.id = "orphan";
        f.sandbox = "allow-scripts allow-same-origin";
        f.src = url;
        document.body.append(f);
      }, artifactURL);
      await until("orphan controlled document", () =>
        page
          .frames()
          .find((f) => f.url() === artifactURL && f !== frame())
          ?.evaluate(() => window.page2 === 3),
      );
      const orphan = page
        .frames()
        .find((f) => f.url() === artifactURL && f !== frame());
      await page.evaluate(() => window.closeViewers());
      result.afterClose = await orphan.evaluate(async () => ({
        status: await fetch("data.json")
          .then((r) => r.status)
          .catch(String),
        registrations: (await navigator.serviceWorker.getRegistrations())
          .length,
      }));
      expect([503, "TypeError: Load failed"]).toContain(
        result.afterClose.status,
      );
      expect(result.afterClose.registrations).toBe(0);
      await page.locator("#orphan").evaluate((e) => e.remove());
      await expect(page.locator("#viewers>iframe")).toHaveCount(0);
      result.closed = true;
      const networkFallback = await fetch(
        artifactURL.replace(scenario.content, "127.0.0.1"),
      );
      result.networkFallback = networkFallback.status;
      expect(result.networkFallback).toBe(404);
      result.expectedDenialErrors = errors.filter(
        (e) =>
          e.includes("not-granted.json") ||
          e.includes("/v/wrong/") ||
          e.includes("/report/data.json due to access control"),
      );
      result.outcome = "passed";
      log(`${scenario.name}: passed`);
    } catch (error) {
      result.outcome = "failed";
      process.exitCode = 1;
      result.error = String(error);
      result.body = await page.locator("body").innerText().catch(String);
      log(`${scenario.name}: ${error}`);
    } finally {
      result.finalHostEvents = await page
        .evaluate(() => window.evidence)
        .catch(() => []);
      result.errors = errors;
      result.contentNetwork = contentLog.slice();
      await page.evaluate(() => window.shutdown?.()).catch(() => {});
      await context.close();
    }
  }
} catch (error) {
  results.failure = String(error);
  log(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  for (const context of contexts) await context.close().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const child of processes) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  log(`Results: ${join(out, "results.json")}`);
}
