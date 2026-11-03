// Spike: can a service worker on a separate content origin serve a scripted
// HTML artifact whose bytes come only from the embedding YA page?
//
// The "YA page" origin holds the artifact files (standing in for reads over
// the encrypted relay). The content origin serves only a bootstrap page and
// a service worker; every artifact path 404s on its network. An artifact that
// renders therefore proves its bytes went parent -> broker frame -> worker.
//
// Run: node research/relay-artifact-frame-spike/spike.mjs [--headed]
// Needs Google Chrome installed (Playwright channel "chrome").
// Optional env: SPIKE_MODE (3pc-allowed | 3pc-blocked | playwright-context),
// SPIKE_KIND (same-site | cross-site), SPIKE_STOP (all | idle; default stops
// this case's worker by version), SPIKE_OAC=1 (send Origin-Agent-Cluster: ?1
// on the bootstrap). Results print as JSON.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const fontPath = require.resolve(
  "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2",
);

const PARENT_HOST = "latest.yepanywhere.com";
const CONTENT_HOSTS = {
  "same-site": "g1.usercontent.yepanywhere.com",
  "cross-site": "g1.yepusercontent.com",
};
const BIG_BYTES = 32 * 1024 * 1024;

// --- artifact fixture, readable only through the parent page --------------

const FILES = {
  "report/index.html": `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css"></head><body>
<h1 id="title">Spike report</h1>
<img id="relimg" src="../assets/mark.svg" width="32" height="32">
<img id="srcsetimg" srcset="../assets/mark.svg 1x" width="32" height="32">
<div id="bg">background from CSS url()</div>
<a id="next" href="page2.html">page 2</a>
<script src="classic.js"></script>
<script type="module" src="app.js"></script>
</body></html>`,
  "report/style.css": `@import "more.css";
@font-face { font-family: SpikeFont; src: url("font.woff2") format("woff2"); }
body { background: rgb(245, 241, 231); font: 16px SpikeFont, serif; }
#bg { background-image: url("../assets/bg.svg"); height: 40px; }`,
  "report/more.css": `h1 { color: rgb(1, 2, 3); }`,
  "report/classic.js": `window.__classic = "classic ran";`,
  "report/lib.js": `export const lib = "static import ran";`,
  "report/dyn.js": `export const dyn = "dynamic import ran";`,
  "report/app.js": `import { lib } from "./lib.js";
const { dyn } = await import("./dyn.js");
const data = await (await fetch("data.json")).json();
window.__spike = { lib, dyn, data, classic: window.__classic };`,
  "report/data.json": `{"notes": 3}`,
  "report/page2.html": `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css"></head><body><h1>Page 2</h1>
<script type="module">window.__page2 = (await (await fetch("data.json")).json()).notes;</script>
</body></html>`,
  "report/font.woff2": readFileSync(fontPath),
  "assets/mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="teal"/></svg>`,
  "assets/bg.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="orange"/></svg>`,
};
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  bin: "application/octet-stream",
};

// --- pages -----------------------------------------------------------------

const PARENT_HTML = `<!doctype html><meta charset="utf-8"><title>YA stand-in</title>
<style>iframe{width:900px;height:600px;border:1px solid #888}</style>
<iframe id="artifact" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const params = new URLSearchParams(location.search);
const contentOrigin = params.get("content");
const nonce = crypto.randomUUID();
const frame = document.getElementById("artifact");
const channel = new MessageChannel();
window.__served = [];
// Requests from the broker frame. Only paths in this grant are answered.
channel.port1.onmessage = async (event) => {
  const { type, path } = event.data ?? {};
  const port = event.ports[0];
  if (type !== "fetch" || !port) return;
  window.__served.push(path);
  const res = await fetch("/relay/" + path);
  if (!res.ok) {
    port.postMessage({ type: "error", status: res.status, message: "not in grant" });
    return;
  }
  port.postMessage({
    type: "head",
    status: 200,
    headers: { "content-type": res.headers.get("content-type") },
  });
  const reader = res.body.getReader();
  port.onmessage = async (e) => {
    if (e.data?.type === "cancel") return void reader.cancel();
    if (e.data?.type !== "pull") return;
    const { done, value } = await reader.read();
    if (done) return void port.postMessage({ type: "end" });
    const bytes = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
      ? value.buffer : value.slice().buffer;
    port.postMessage({ type: "chunk", bytes }, [bytes]);
  };
};
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === "broker-ready") {
    frame.contentWindow.postMessage(
      { type: "connect", entry: "report/index.html" }, contentOrigin, [channel.port2]);
  }
  if (event.data?.type === "broker-report") window.__broker = event.data;
});
frame.src = contentOrigin + "/__ya/bootstrap.html?b=" + nonce;
</script>`;

const BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<script>
const nonce = new URLSearchParams(location.search).get("b");
let hostPort = null;
navigator.serviceWorker.addEventListener("message", (event) => {
  if (event.data?.type === "fetch" && hostPort) {
    hostPort.postMessage(event.data, [event.ports[0]]);
  }
});
navigator.serviceWorker.startMessages();
window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.type !== "connect" || hostPort) return;
  hostPort = event.ports[0];
  const report = { type: "broker-report", storageAccess: await document.hasStorageAccess() };
  try {
    document.cookie = "spike=1; SameSite=None; Secure; Path=/";
    report.cookieWritable = document.cookie.includes("spike=1");
  } catch (err) { report.cookieWritable = String(err); }
  try {
    // ready only resolves for a page inside the scope, which this is not.
    const reg = await navigator.serviceWorker.register("/__ya/sw.js", { scope: "/v/" });
    const worker = reg.installing || reg.waiting || reg.active;
    if (worker.state !== "activated") {
      await new Promise((resolve) => worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      }));
    }
    report.registered = true;
  } catch (err) {
    report.registered = false;
    report.error = String(err);
  }
  parent.postMessage(report, "*");
  if (!report.registered) return;
  const inner = document.createElement("iframe");
  inner.src = "/v/" + nonce + "/" + event.data.entry;
  document.body.append(inner);
});
parent.postMessage({ type: "broker-ready" }, "*");
</script>`;

const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  const match = url.pathname.match(/^\\/v\\/([^/]+)\\/(.*)$/);
  if (!match) return;
  event.respondWith(relay(match[1], decodeURIComponent(match[2])));
});
async function relay(nonce, path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const broker = windows.find((c) => {
    const u = new URL(c.url);
    return u.pathname === "/__ya/bootstrap.html" && u.searchParams.get("b") === nonce;
  });
  if (!broker) return new Response("No viewer holds this artifact", { status: 503 });
  const { port1, port2 } = new MessageChannel();
  broker.postMessage({ type: "fetch", path }, [port2]);
  const head = await new Promise((resolve) => { port1.onmessage = (e) => resolve(e.data); });
  if (head.type !== "head") return new Response(head.message, { status: head.status || 502 });
  const body = new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        port1.onmessage = (e) => {
          if (e.data.type === "chunk") controller.enqueue(new Uint8Array(e.data.bytes));
          else if (e.data.type === "end") { controller.close(); port1.close(); }
          else controller.error(new Error(e.data.message));
          resolve();
        };
        port1.postMessage({ type: "pull" });
      });
    },
    cancel() { port1.postMessage({ type: "cancel" }); port1.close(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: head.status, headers: { ...head.headers, "x-spike-sw": "1" } });
}`;

// --- servers ---------------------------------------------------------------

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

const contentLog = [];
const parentServer = await listen((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/parent.html") {
    res.writeHead(200, { "content-type": TYPES.html });
    return res.end(PARENT_HTML);
  }
  if (url.pathname.startsWith("/relay/")) {
    const path = decodeURIComponent(url.pathname.slice("/relay/".length));
    const type = TYPES[path.split(".").pop()];
    if (path === "report/big.bin") {
      res.writeHead(200, { "content-type": TYPES.bin });
      const chunk = Buffer.alloc(256 * 1024, 7);
      for (let sent = 0; sent < BIG_BYTES; sent += chunk.length)
        res.write(chunk);
      return res.end();
    }
    if (!(path in FILES)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": type });
    return res.end(FILES[path]);
  }
  res.writeHead(404);
  res.end();
});
const contentServer = await listen((req, res) => {
  const url = new URL(req.url, "http://x");
  contentLog.push({
    host: req.headers.host,
    path: url.pathname,
    secFetchSite: req.headers["sec-fetch-site"],
    secFetchDest: req.headers["sec-fetch-dest"],
  });
  if (url.pathname === "/__ya/bootstrap.html") {
    res.writeHead(200, {
      "content-type": TYPES.html,
      ...(process.env.SPIKE_OAC ? { "origin-agent-cluster": "?1" } : {}),
    });
    return res.end(BOOTSTRAP_HTML);
  }
  if (url.pathname === "/__ya/sw.js") {
    res.writeHead(200, {
      "content-type": TYPES.js,
      "service-worker-allowed": "/v/",
    });
    return res.end(SERVICE_WORKER);
  }
  // Artifact paths must never be answered by the network.
  res.writeHead(404);
  res.end("not on the network");
});
const parentPort = parentServer.address().port;
const contentPort = contentServer.address().port;
const parentOrigin = `http://${PARENT_HOST}:${parentPort}`;
const contentOrigins = Object.fromEntries(
  Object.entries(CONTENT_HOSTS).map(([k, h]) => [
    k,
    `http://${h}:${contentPort}`,
  ]),
);

const chromeArgs = [
  `--host-resolver-rules=MAP ${PARENT_HOST} 127.0.0.1, ${Object.values(
    CONTENT_HOSTS,
  )
    .map((h) => `MAP ${h} 127.0.0.1`)
    .join(", ")}`,
  `--unsafely-treat-insecure-origin-as-secure=${[parentOrigin, ...Object.values(contentOrigins)].join(",")}`,
];

// --- browser runs ----------------------------------------------------------

function profileWithPrefs(prefs) {
  const dir = mkdtempSync(join(tmpdir(), "ya-sw-spike-"));
  mkdirSync(join(dir, "Default"));
  writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify(prefs));
  return dir;
}

const MODES = {
  "3pc-allowed": {
    profile: { cookie_controls_mode: 0, block_third_party_cookies: false },
  },
  "3pc-blocked": {
    profile: { cookie_controls_mode: 1, block_third_party_cookies: true },
    tracking_protection: { block_all_3pc_toggle_enabled: true },
  },
};

async function waitFor(fn, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runCase(context, contentKind) {
  contentLog.length = 0;
  const page = await context.newPage();
  const consoleErrors = [];
  page.on(
    "console",
    (m) => m.type() === "error" && consoleErrors.push(m.text()),
  );
  const result = { contentKind };
  await page.goto(
    `${parentOrigin}/parent.html?content=${encodeURIComponent(contentOrigins[contentKind])}`,
  );
  result.broker = await waitFor(() => page.evaluate(() => window.__broker));
  const innerFrame = () => page.frames().find((f) => f.url().includes("/v/"));
  const spike = await waitFor(async () =>
    innerFrame()?.evaluate(() => window.__spike),
  );
  result.bootstrapSecFetchSite = contentLog.find(
    (l) => l.path === "/__ya/bootstrap.html",
  )?.secFetchSite;
  if (!spike) {
    result.artifact = "did not run";
    result.consoleErrors = consoleErrors.slice(0, 5);
    await page.close();
    return result;
  }
  const frame = innerFrame();
  result.modules = spike;
  result.page = await frame.evaluate(async () => {
    await document.fonts.ready;
    const imgs = [...document.images].map(
      (i) => i.complete && i.naturalWidth > 0,
    );
    const resources = performance
      .getEntriesByType("resource")
      .map(
        (e) => `${e.name.split("/").slice(-2).join("/")}:${e.responseStatus}`,
      );
    let storage;
    try {
      localStorage.setItem("k", "v");
      storage = localStorage.getItem("k") === "v";
    } catch (err) {
      storage = String(err);
    }
    return {
      controlled: navigator.serviceWorker.controller !== null,
      originAgentCluster: window.originAgentCluster,
      imagesLoaded: imgs,
      h1ColorFromImport: getComputedStyle(document.querySelector("h1")).color,
      fontLoaded: document.fonts.check("16px SpikeFont"),
      resources,
      localStorage: storage,
    };
  });
  if (context.browser()) {
    const bcdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await bcdp.send("Target.getTargets");
    const host = new URL(contentOrigins[contentKind]).host;
    result.contentFramesOutOfProcess = targetInfos
      .filter((t) => t.type === "iframe" && t.url.includes(host))
      .map((t) => new URL(t.url).pathname.split("/").slice(0, 3).join("/"));
    await bcdp.detach();
  }
  result.networkArtifactRequests = contentLog.filter((l) =>
    l.path.startsWith("/v/"),
  ).length;

  // Throughput of a streamed body through parent -> broker -> worker.
  result.bigFetch = await frame.evaluate(async () => {
    const t0 = performance.now();
    const res = await fetch("big.bin");
    const reader = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
    }
    const s = (performance.now() - t0) / 1000;
    return {
      bytes: n,
      seconds: +s.toFixed(2),
      MiBps: +(n / 1048576 / s).toFixed(1),
    };
  });

  // Navigate inside the artifact, then reload the inner frame.
  await frame.evaluate(() => document.getElementById("next").click());
  result.page2 = await waitFor(() =>
    innerFrame()?.evaluate(
      () =>
        window.__page2 && {
          notes: window.__page2,
          controlled: navigator.serviceWorker.controller !== null,
        },
    ),
  );
  await innerFrame().evaluate(() => location.reload());
  result.page2Reload = await waitFor(() =>
    innerFrame()?.evaluate(
      () =>
        window.__page2 && {
          notes: window.__page2,
          controlled: navigator.serviceWorker.controller !== null,
        },
    ),
  );

  // Kill the worker; the next request must restart it and still find the broker.
  const cdp = await context.newCDPSession(page);
  const versions = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e) =>
    versions.push(...e.versions),
  );
  result.workerErrors = [];
  cdp.on("ServiceWorker.workerErrorReported", (e) =>
    result.workerErrors.push(e.errorMessage),
  );
  await cdp.send("ServiceWorker.enable").catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const host = new URL(contentOrigins[contentKind]).host;
  const mine = versions.filter(
    (v) => v.scriptURL.includes(host) && v.runningStatus === "running",
  );
  const stopped =
    process.env.SPIKE_STOP === "idle"
      ? await new Promise((r) => setTimeout(() => r("idle 40s"), 40_000))
      : process.env.SPIKE_STOP === "all"
        ? await cdp.send("ServiceWorker.stopAllWorkers").then(
            () => "all",
            (err) => String(err),
          )
        : await Promise.all(
            mine.map((v) =>
              cdp.send("ServiceWorker.stopWorker", { versionId: v.versionId }),
            ),
          ).then(
            () => `stopWorker x${mine.length}`,
            (err) => String(err),
          );
  result.workerStatesAfterStop = () =>
    versions
      .filter((v) => v.scriptURL.includes(host))
      .map((v) => `${v.versionId}:${v.runningStatus}/${v.status}`);
  const probe = () =>
    innerFrame()
      .evaluate(async () => {
        const res = await fetch("data.json?again=" + Math.random());
        return {
          controlled: navigator.serviceWorker.controller !== null,
          status: res.status,
          viaWorker: res.headers.get("x-spike-sw") === "1",
        };
      })
      .catch((err) => String(err));
  result.afterWorkerStop = { stopped, probes: [] };
  for (const delay of [0, 200, 1000, 3000]) {
    await new Promise((r) => setTimeout(r, delay));
    result.afterWorkerStop.probes.push({ delay, ...(await probe()) });
  }
  result.workerStatesAfterStop = result.workerStatesAfterStop();
  result.consoleErrors = consoleErrors.slice(0, 5);
  await page.close();
  return result;
}

const headless = !process.argv.includes("--headed");
const results = {};
for (const [mode, prefs] of Object.entries(MODES)) {
  if (process.env.SPIKE_MODE && process.env.SPIKE_MODE !== mode) continue;
  const context = await chromium.launchPersistentContext(
    profileWithPrefs(prefs),
    {
      channel: "chrome",
      chromiumSandbox: true,
      headless,
      args: chromeArgs,
    },
  );
  results[`persistent/${mode}`] = {
    chrome: context.browser()?.version() ?? "(persistent)",
    cases: [],
  };
  for (const kind of Object.keys(CONTENT_HOSTS)) {
    if (process.env.SPIKE_KIND && process.env.SPIKE_KIND !== kind) continue;
    results[`persistent/${mode}`].cases.push(await runCase(context, kind));
  }
  await context.close();
}
if (
  !process.env.SPIKE_MODE ||
  process.env.SPIKE_MODE === "playwright-context"
) {
  // Playwright's default (off-the-record) browser context.
  const browser = await chromium.launch({
    channel: "chrome",
    chromiumSandbox: true,
    headless,
    args: chromeArgs,
  });
  const context = await browser.newContext();
  results["playwright-context"] = { chrome: browser.version(), cases: [] };
  for (const kind of Object.keys(CONTENT_HOSTS)) {
    results["playwright-context"].cases.push(await runCase(context, kind));
  }
  await browser.close();
}
parentServer.close();
contentServer.close();
console.log(JSON.stringify(results, null, 2));
