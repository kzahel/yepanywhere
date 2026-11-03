import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir, networkInterfaces } from "node:os";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { InstallService } from "../../packages/server/src/services/InstallService.ts";
import {
  writeCapturePreview,
  emitCapturePreview,
} from "../../packages/client/scripts/artifact-capture.ts";
const require = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const repo = resolve(import.meta.dirname, "../..");
const out = resolve(import.meta.dirname, `results/run-${Date.now()}`);
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "ya-ext-artifact-live-"));
const children = [];
let context;
const extraContexts = [];
const evidence = {
  temp,
  out,
  checks: [],
  network: [],
  errors: [],
  timings: {},
};
function log(text) {
  console.error(`[artifact spike] ${text}`);
}
async function until(label, fn, ms = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
function start(label, pkg, env) {
  const p = spawn(
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
  children.push(p);
  for (const stream of [p.stdout, p.stderr])
    stream.on("data", (b) => appendFileSync(join(out, `${label}.log`), b));
  return p;
}
// Generate an ordinary PNG asset without an image generation service.
function png() {
  const w = 640,
    h = 220,
    raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const offset = y * (w * 4 + 1) + 1 + x * 4;
      const line = Math.abs(y - (145 - 58 * Math.sin(x / 70) - x / 12)) < 4;
      const grid = x % 80 === 0 || y % 55 === 0;
      raw.set(
        line
          ? [30, 138, 111, 255]
          : grid
            ? [218, 228, 230, 255]
            : [243, 248, 247, 255],
        offset,
      );
    }
  function chunk(name, bytes) {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let c = 0xffffffff;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
try {
  const home = join(temp, "home"),
    data = join(temp, "ya"),
    claude = join(temp, "claude/projects"),
    runtime = join(temp, "run");
  const project = join(repo, "research/extension-artifact-spike/demo");
  for (const p of [
    home,
    data,
    claude,
    runtime,
    project,
    join(project, "assets"),
  ])
    mkdirSync(p, { recursive: true });
  writeFileSync(join(project, "assets/chart.png"), png());
  writeFileSync(
    join(project, "assets/font.woff2"),
    readFileSync(
      require.resolve("katex/dist/fonts/KaTeX_Typewriter-Regular.woff2"),
    ),
  );
  writeFileSync(
    join(project, "style.css"),
    `@font-face{font-family:ArtifactFont;src:url('./assets/font.woff2')}*{box-sizing:border-box}body{margin:0;padding:24px;background:#f8faf9;color:#16302a;font:15px system-ui}main{max-width:740px;margin:auto}h1{font-size:26px;margin:10px 0}p{line-height:1.5}img{width:100%;height:auto;border-radius:10px;border:1px solid #dbe4e1}.tag{color:#316c59;text-transform:uppercase;font:12px ArtifactFont,monospace}button{padding:10px 14px;border:0;border-radius:8px;background:#176b51;color:white;font:inherit;margin-right:8px;margin-top:8px}input{font:inherit;padding:10px;width:100%;border:1px solid #b9ccc5;border-radius:8px}.card{padding:16px;border:1px solid #dbe4e1;border-radius:12px;background:white;margin:16px 0}.meta{font:12px ArtifactFont,monospace;color:#49675c}a{color:#176b51}@media(max-width:440px){body{padding:14px}h1{font-size:23px}}`,
  );
  writeFileSync(
    join(project, "classic.js"),
    `window.classicLoaded=true;document.querySelector('#counter').onclick=()=>{const n=Number(document.querySelector('#count').textContent)+1;document.querySelector('#count').textContent=n;window.openai.setWidgetState({count:n})};document.querySelector('#followup').onclick=()=>window.openai.sendFollowUpMessage({prompt:'Explain the peak in this chart.'});setInterval(()=>document.querySelector('#pulse').textContent=String(Date.now()),100);`,
  );
  writeFileSync(join(project, "lib.js"), `export const label='static import';`);
  writeFileSync(
    join(project, "dyn.js"),
    `export const label='dynamic import';`,
  );
  writeFileSync(
    join(project, "app.js"),
    `import {label} from './lib.js';const dynamic=await import('./dyn.js');const data=await(await fetch('./data.json')).json();window.moduleResult={label,dynamic:dynamic.label,data};document.querySelector('#modules').textContent=label+' + '+dynamic.label+' + JSON: '+data.notes+' notes';`,
  );
  writeFileSync(join(project, "data.json"), ' {"notes":3}');
  writeFileSync(
    join(project, "page2.html"),
    `<!doctype html><link rel="stylesheet" href="style.css"><main><p class="tag">Linked local document</p><h1>Page two</h1><img alt="Chart again" src="assets/chart.png"><p>This image was read through the same connection.</p><a href="index.html">Back to report</a></main>`,
  );
  writeFileSync(
    join(project, "fragment.html"),
    `<h1>Self-contained interactive fragment</h1><button onclick="this.textContent='Fragment clicked'">Try fragment</button><script>window.fragmentRan=true</script>`,
  );
  writeFileSync(
    join(project, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local artifact report</title><link rel="stylesheet" href="style.css"><main><p class="tag">Extension sandbox · encrypted relay</p><h1>A local report, with local assets</h1><p>The HTML, PNG, stylesheet, font, scripts and JSON live together on the Yep server. This viewer needs no public artifact tunnel.</p><img id="chart" alt="Locally referenced PNG chart" src="./assets/chart.png"><img id="absolute-chart" hidden src="${join(project, "assets/chart.png")}"><div class="card" style="background-image:url(./assets/chart.png);background-size:1px 1px"><label for="note">Try typing while this artifact updates</label><p><input id="note" placeholder="A note about this chart"></p><button id="counter">Explore · <span id="count">0</span></button><button id="followup">Ask about the peak</button><p class="meta" id="modules">Loading modules…</p><p class="meta">Live tick: <span id="pulse"></span></p></div><a id="next" href="page2.html">Open linked document →</a></main><script src="classic.js"></script><script type="module" src="app.js"></script>`,
  );
  const install = new InstallService({ dataDir: data });
  await install.initialize();
  await install.recordSuccessfulProviders(["claude"]);
  writeFileSync(
    join(data, "server-settings.json"),
    JSON.stringify({ version: 1, settings: { codexUpdatePolicy: "off" } }),
  );
  const sd = join(claude, hostname(), project.replaceAll("/", "-"));
  mkdirSync(sd, { recursive: true });
  const transcript = join(sd, "artifact-demo.jsonl");
  const rows = [];
  function message(i, role, text) {
    return {
      type: role,
      uuid: `demo-${i}`,
      sessionId: "artifact-demo",
      cwd: project,
      timestamp: new Date(Date.now() - 60000 + i * 10).toISOString(),
      message: {
        role,
        content: role === "assistant" ? [{ type: "text", text }] : text,
      },
    };
  }
  rows.push(
    message(
      0,
      "user",
      "Demo: inspect a local HTML artifact with neighboring assets",
    ),
  );
  for (let i = 1; i <= 120; i++)
    rows.push(
      message(
        i,
        i % 2 ? "assistant" : "user",
        `Artifact review context ${i}: local files stay behind the authenticated Yep connection.`,
      ),
    );
  rows.push(
    message(
      121,
      "assistant",
      `The demo report is ready: [Open local artifact](${join(project, "index.html")})\n\nSelf-contained control: [Open fragment](${join(project, "fragment.html")})`,
    ),
  );
  writeFileSync(
    transcript,
    rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const relayPortFile = join(temp, "relay.port");
  start("relay", "relay", {
    RELAY_PORT: "0",
    RELAY_PORT_FILE: relayPortFile,
    RELAY_DATA_DIR: join(temp, "relay"),
    RELAY_LOG_TO_FILE: "false",
    RELAY_LOG_LEVEL: "warn",
  });
  const rp = await until(
    "relay port",
    () =>
      existsSync(relayPortFile) && readFileSync(relayPortFile, "utf8").trim(),
  );
  const relayUrl = `ws://127.0.0.1:${rp}/ws`;
  const env = {
    HOME: home,
    USERPROFILE: home,
    YEP_DATA_DIR: data,
    CLAUDE_SESSIONS_DIR: claude,
    CODEX_SESSIONS_DIR: join(temp, "codex"),
    GEMINI_SESSIONS_DIR: join(temp, "gemini"),
    YEP_PROVIDER_HOST_RUNTIME_DIR: runtime,
    YEP_PROVIDER_HOST_ENABLED: "false",
    ...(process.argv.includes("--trust-extension")
      ? { ALLOWED_HOSTS: "dgeameddpnggdeenoekpiaacfghdodch" }
      : {}),
    VITE_DISABLE_ONBOARDING: "true",
    VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
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
      "artifact-spike",
      "--password",
      "artifact-spike-test-only",
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
  const sp = await until(
    "server port",
    () => existsSync(portFile) && readFileSync(portFile, "utf8").trim(),
    60000,
  );
  const api = async (path) =>
    fetch(`http://127.0.0.1:${sp}/api${path}`, {
      headers: { "X-Yep-Anywhere": "true" },
    });
  await until(
    "relay registration",
    async () =>
      ["waiting", "connected"].includes(
        (await (await api("/remote-access/relay/status")).json()).status,
      ),
    60000,
  );
  const projectId = Buffer.from(project).toString("base64url");
  await until(
    "session discovery",
    async () => (await api(`/projects/${projectId}/sessions/artifact-demo`)).ok,
    60000,
  );
  log(`isolated YA ${sp}, relay ${rp}; fixture ${project}`);
  const extension = join(repo, "packages/browser-extension/dist");
  context = await chromium.launchPersistentContext(join(temp, "chromium"), {
    channel: "chromium",
    chromiumSandbox: true,
    headless: !process.argv.includes("--headed"),
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1000, height: 600 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const origin = worker.url().replace(/\/background.js$/, "");
  const app = await context.newPage();
  app.on("pageerror", (e) => evidence.errors.push(e.message));
  app.on("console", (m) => {
    if (m.type() === "error") {
      if (m.text().includes("connect-src")) {
        evidence.expectedCSP ??= [];
        evidence.expectedCSP.push(m.text());
      } else evidence.errors.push(m.text());
    }
  });
  app.on("request", (r) => {
    if (r.url().startsWith("http")) evidence.network.push(r.url());
  });
  await app.goto(origin + "/index.html");
  await app.reload();
  await app.goto(
    `${origin}/login/relay#u=artifact-spike&p=artifact-spike-test-only&r=${encodeURIComponent(relayUrl)}`,
  );
  await app.waitForURL("**/-/relay/artifact-spike/**", { timeout: 60000 });
  const base = origin + "/-/relay/artifact-spike";
  await app.goto(`${base}/projects/${projectId}/sessions/artifact-demo`);
  // The app's composer accessible name can change; this is the existing stable class.
  const input = app
    .locator("textarea.message-input, textarea[placeholder]")
    .first();
  await expect(
    app.getByRole("link", { name: "Open local artifact", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await app
    .getByRole("link", { name: "Open local artifact", exact: true })
    .click();
  await expect(
    app.getByRole("button", { name: "Run extension preview", exact: true }),
  ).toBeVisible();
  await app
    .getByRole("button", { name: "Run extension preview", exact: true })
    .click();
  const frame = app.frameLocator('iframe[title$="extension sandbox"]');
  await expect(
    frame.getByRole("heading", { name: "A local report, with local assets" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(frame.locator("#modules")).toHaveText(
    "static import + dynamic import + JSON: 3 notes",
  );
  const child = app
    .frames()
    .find((f) => f.url().includes("artifact-sandbox.html"));
  const state = await child.evaluate(async () => {
    await document.fonts.ready;
    const deny = (fn) => {
      try {
        return fn();
      } catch (e) {
        return String(e);
      }
    };
    return {
      origin: self.origin,
      api: typeof chrome.runtime,
      storage: deny(() => localStorage.length),
      parent: deny(() => parent.document.title),
      image: document.querySelector("#chart").naturalWidth,
      absoluteImage: document.querySelector("#absolute-chart").naturalWidth,
      cssBackground: getComputedStyle(document.querySelector(".card"))
        .backgroundImage,
      font: document.fonts.check("12px ArtifactFont"),
      classic: window.classicLoaded,
      modules: window.moduleResult,
      nativeXHR: await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "http://127.0.0.1:9/api/version");
        xhr.onload = () => resolve("loaded");
        xhr.onerror = () => resolve("blocked");
        xhr.send();
      }),
      fetchDenied: await fetch("/api/version")
        .then(() => false)
        .catch(String),
    };
  });
  expect(state.origin).toBe("null");
  expect(state.nativeXHR).toBe("blocked");
  expect(state.api).toBe("undefined");
  expect(state.image).toBe(640);
  expect(state.absoluteImage).toBe(640);
  expect(state.cssBackground).toContain("blob:null/");
  expect(state.classic).toBe(true);
  expect(state.font).toBe(true);
  expect(state.fetchDenied).toContain("Outside");
  evidence.checks.push({ name: "real-relay-html-assets-and-isolation", state });
  await frame.getByRole("button", { name: "Explore" }).click();
  await expect(frame.locator("#count")).toHaveText("1");
  expect(await child.evaluate(() => window.openai.widgetState)).toEqual({
    count: 1,
  });
  // Real sequential keyboard input in the live artifact, with a 100 ms acknowledgement ceiling.
  const artifactInput = frame.getByPlaceholder("A note about this chart");
  await artifactInput.click();
  const phrase = "Local files through encrypted relay";
  let expected = "";
  const latencies = [];
  for (const char of phrase) {
    const t = Date.now();
    await app.keyboard.type(char);
    expected += char;
    await expect(artifactInput).toHaveValue(expected, { timeout: 100 });
    latencies.push(Date.now() - t);
  }
  evidence.timings.artifactTyping = {
    characters: phrase.length,
    maxMs: Math.max(...latencies),
    dropped: 0,
  };
  await frame.getByRole("button", { name: "Ask about the peak" }).click();
  await expect(
    app.getByText(
      "Suggested follow-up (not sent): Explain the peak in this chart.",
    ),
  ).toBeVisible();
  // Preserve the actual YA composer when the modal is open; read it even if covered.
  const draft = await input.inputValue().catch(() => null);
  evidence.checks.push({ name: "bounded-followup", composerDraft: draft });
  const screenshots = [];
  await app.locator(".file-viewer-fullscreen-toggle").click();
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await app.setViewportSize(viewport);
    await expect(frame.locator("#chart")).toBeVisible();
    await child.evaluate(() => scrollTo(0, 0));
    const path = join(out, `extension-viewer-${viewport.width}.png`);
    await app.screenshot({ path });
    screenshots.push({
      name: `extension-viewer-${viewport.width}`,
      ...viewport,
      path,
    });
  }
  await app.setViewportSize({ width: 1000, height: 600 });
  await frame.getByRole("link", { name: "Open linked document" }).click();
  await expect(frame.getByRole("heading", { name: "Page two" })).toBeVisible();
  await frame.getByRole("link", { name: "Back to report" }).click();
  await expect(frame.locator("#modules")).toContainText("JSON: 3 notes");
  evidence.checks.push({ name: "linked-document-navigation", passed: true });
  expect(
    await app
      .frames()
      .find((f) => f.url().includes("artifact-sandbox.html"))
      .evaluate(() => window.openai.widgetState),
  ).toEqual({ count: 1 });
  // A second independent viewer can use the same relay login without sharing widget state.
  const second = await context.newPage();
  await second.goto(`${base}/projects/${projectId}/file?path=fragment.html`);
  await second
    .getByRole("button", { name: "Run extension preview", exact: true })
    .click();
  const fragment = second.frameLocator('iframe[title$="extension sandbox"]');
  await fragment.getByRole("button", { name: "Try fragment" }).click();
  await expect(
    fragment.getByRole("button", { name: "Fragment clicked" }),
  ).toBeVisible();
  evidence.checks.push({
    name: "concurrent-self-contained-fragment",
    passed: true,
  });
  await second.close();
  const rawUrl = `http://127.0.0.1:${sp}/api/projects/${projectId}/files/raw?path=${encodeURIComponent(join(project, "assets/chart.png"))}`;
  const localhost = await fetch(rawUrl, {
    headers: { "X-Yep-Anywhere": "true" },
  });
  expect(localhost.ok).toBe(true);
  const lan = process.argv.includes("--trust-extension")
    ? Object.values(networkInterfaces())
        .flat()
        .find((i) => i?.family === "IPv4" && !i.internal)?.address
    : undefined;
  if (lan) {
    const binding = await fetch(`http://127.0.0.1:${sp}/api/network-binding`, {
      method: "PUT",
      headers: { "X-Yep-Anywhere": "true", "Content-Type": "application/json" },
      body: JSON.stringify({
        network: { enabled: true, host: lan, port: Number(sp) },
      }),
    });
    evidence.checks.push({
      name: "temporary-lan-binding",
      status: binding.status,
    });
  }
  evidence.checks.push({
    name: "localhost-raw-bytes",
    status: localhost.status,
  });
  if (lan) {
    try {
      const res = await fetch(rawUrl.replace("127.0.0.1", lan), {
        headers: { "X-Yep-Anywhere": "true" },
        signal: AbortSignal.timeout(3000),
      });
      evidence.checks.push({ name: "lan-raw-bytes", status: res.status });
    } catch (e) {
      evidence.checks.push({ name: "lan-raw-bytes", error: String(e) });
    }
  }

  // The artifact's host port and source connection survive explicit extension worker termination.
  const cdp = await context.newCDPSession(app);
  const versions = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (event) =>
    versions.push(...event.versions),
  );
  await cdp.send("ServiceWorker.enable");
  const version = await until("worker version", () =>
    versions.find(
      (v) =>
        v.scriptURL === origin + "/background.js" &&
        v.runningStatus === "running",
    ),
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  const liveChild = app
    .frames()
    .find((f) => f.url().includes("artifact-sandbox.html"));
  expect(
    await liveChild.evaluate(() => fetch("./data.json").then((r) => r.json())),
  ).toEqual({ notes: 3 });
  const wake = await context.newPage();
  await wake.goto(origin + "/spike-worker-wake");
  await wake.close();
  evidence.checks.push({
    name: "explicit-worker-stop-and-next-navigation",
    passed: true,
  });
  await cdp.detach();
  // Authenticate from fresh extension profiles using the direct encrypted transport.
  for (const [name, address] of [
    ["localhost", "127.0.0.1"],
    ...(lan ? [["lan", lan]] : []),
  ]) {
    const direct = await chromium.launchPersistentContext(
      join(temp, "chromium-" + name),
      {
        channel: "chromium",
        chromiumSandbox: true,
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    extraContexts.push(direct);
    await (direct.serviceWorkers()[0] ?? direct.waitForEvent("serviceworker"));
    const page = await direct.newPage();
    await page.goto(origin + "/index.html");
    await page.reload();
    await page.goto(origin + "/login/direct");
    await page.getByTestId("ws-url-input").fill(`ws://${address}:${sp}/api/ws`);
    await page.getByTestId("username-input").fill("artifact-spike");
    await page.getByTestId("password-input").fill("artifact-spike-test-only");
    await page.getByTestId("login-button").click();
    const connected = await page
      .waitForURL("**/projects", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!connected) {
      evidence.checks.push({
        name: name + "-direct-encrypted-viewer",
        passed: false,
        url: page.url(),
        body: (await page.locator("body").innerText()).slice(-2000),
      });
      await direct.close();
      continue;
    }
    const directBase = origin;
    await page.goto(`${directBase}/projects/${projectId}/file?path=index.html`);
    await page
      .getByRole("button", { name: "Run extension preview", exact: true })
      .click();
    const directFrame = page.frameLocator('iframe[title$="extension sandbox"]');
    await expect(directFrame.locator("#modules")).toContainText(
      "JSON: 3 notes",
    );
    expect(
      await directFrame.locator("#chart").evaluate((img) => img.naturalWidth),
    ).toBe(640);
    evidence.checks.push({
      name: name + "-direct-encrypted-viewer",
      passed: true,
    });
    await direct.close();
  }

  // Close the viewer, then navigate afresh: no worker-resident artifact grants are used.
  await app
    .getByRole("button", { name: "Stop extension preview", exact: true })
    .click();
  await expect(app.locator('iframe[title$="extension sandbox"]')).toHaveCount(
    0,
  );
  evidence.checks.push({ name: "teardown-unmounts-sandbox", passed: true });
  // Reopen and park the live artifact so the real session composer remains usable.
  await app
    .getByRole("button", { name: "Run extension preview", exact: true })
    .click();
  await expect(frame.locator("#modules")).toContainText("JSON: 3 notes");
  await app.locator(".file-viewer-fullscreen-toggle").click();
  await app
    .getByRole("button", { name: "Minimize file viewer", exact: true })
    .click();
  await input.fill("");
  await input.click();
  await app.evaluate(() => {
    window.__spikeMutations = 0;
    window.__spikeObserver = new MutationObserver(
      (r) => (window.__spikeMutations += r.length),
    );
    window.__spikeObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  let update = 300;
  const ticker = setInterval(
    () =>
      appendFileSync(
        transcript,
        JSON.stringify(
          message(
            update++,
            "assistant",
            `Concurrent artifact review update ${update}`,
          ),
        ) + "\n",
      ),
    70,
  );
  const composerPhrase = "Review this local artifact with me.";
  let composerExpected = "";
  const composerLatencies = [];
  try {
    for (const char of composerPhrase) {
      const t = Date.now();
      await app.keyboard.type(char);
      composerExpected += char;
      await expect(input).toHaveValue(composerExpected, { timeout: 100 });
      composerLatencies.push(Date.now() - t);
      await app.waitForTimeout(20);
    }
  } finally {
    clearInterval(ticker);
  }
  const mutations = await app.evaluate(() => {
    window.__spikeObserver.disconnect();
    return window.__spikeMutations;
  });
  evidence.timings.composerTyping = {
    characters: composerPhrase.length,
    maxMs: Math.max(...composerLatencies),
    dropped: 0,
    domMutations: mutations,
    transcriptUpdates: update - 300,
  };

  evidence.noBrowserArtifactHTTP =
    evidence.network.filter(
      (url) => url.includes(`/api/projects/`) || url.includes("usercontent"),
    ).length === 0;
  emitCapturePreview(
    await writeCapturePreview({
      input:
        "Extension artifact viewer: real encrypted-relay HTML, PNG, CSS, font, modules and JSON",
      out: join(out, "capture"),
      screenshots,
      warnings: [
        "Research-only viewer. Server-enforced artifact-root grants, complete web semantics and production integration remain unimplemented.",
      ],
    }),
  );
  log(
    "PASS: real relay viewer, assets, isolation, navigation, typing, two viewers and teardown",
  );
  if (process.argv.includes("--keep-open")) {
    log(`Browser left open for inspection until interrupted. Profile ${temp}`);
    await new Promise(() => {});
  }
} catch (e) {
  evidence.failure = String(e);
  log(e.stack ?? String(e));
  process.exitCode = 1;
  if (context) {
    const app = context.pages().find((p) => p.url().includes("/projects/"));
    if (app) {
      evidence.body = (await app.locator("body").innerText()).slice(-10000);
      evidence.frames = await Promise.all(
        app.frames().map(async (f) => ({
          url: f.url(),
          body: await f.locator("body").innerText().catch(String),
        })),
      );
    }
  }
} finally {
  writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  for (const extra of extraContexts) await extra.close();
  await context?.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  log(`Evidence: ${join(out, "evidence.json")}`);
}
