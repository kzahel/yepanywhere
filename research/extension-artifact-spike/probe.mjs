// One-off browser boundary experiment. No YA production code is changed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
const require = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const font = readFileSync(
  require.resolve("katex/dist/fonts/KaTeX_Typewriter-Regular.woff2"),
);
const out = resolve("research/extension-artifact-spike/results");
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "ya-ext-artifact-probe-"));
const results = { temp, cases: [] };
const web = createServer((req, res) => {
  if (req.url.includes("cors.json")) {
    res.setHeader("content-type", "application/json");
    if (!req.url.includes("no-cors"))
      res.setHeader("access-control-allow-origin", "*");
    res.end(JSON.stringify({ source: "network", origin: req.headers.origin }));
  } else res.end("<!doctype html><title>Web parent</title>");
});
await new Promise((done) => web.listen(0, "127.0.0.1", done));
const webOrigin = `http://127.0.0.1:${web.address().port}`;
const reportScript = `
window.report = {};
for (const [key, fn] of Object.entries({
 origin: () => self.origin,
 extensionAPI: () => typeof chrome?.runtime?.getManifest,
 parentDOM: () => parent.document.title,
 storage: () => localStorage.length,
 serviceWorker: () => navigator.serviceWorker.controller?.scriptURL ?? 'none'
})) { try { report[key] = fn(); } catch(e) { report[key] = String(e); } }
addEventListener('securitypolicyviolation', e => (report.csp ??= []).push(e.effectiveDirective + ':' + e.blockedURI));
window.addEventListener('load', async () => {
 report.img = document.querySelector('img')?.naturalWidth;
 report.css = getComputedStyle(document.body).backgroundColor;
 report.font = await document.fonts.load('16px ProbeFont').then(x => x.length).catch(String);
 report.classic = window.classic ?? false;
 report.json = await fetch('data.json').then(r => r.json()).catch(String);
 report.packaged = await fetch('/data.json').then(r => r.json()).catch(String);
 report.module = await import('./app.js').then(m => m.value).catch(String);
 report.moduleState = window.moduleState;
 report.done = true;
 parent.postMessage({type:'report', report}, '*');
});`;
const files = {
  "document.html": [
    "text/html",
    "<!doctype html><h1>Worker document</h1><script>window.inlineRan=true</script>",
  ],
  "data.json": ["application/json", '{"ok":true}'],
  "classic.js": ["text/javascript", "window.classic = true;"],
  "lib.js": ["text/javascript", "export const value = 4;"],
  "dyn.js": ["text/javascript", "export const value = 5;"],
  "app.js": [
    "text/javascript",
    'import {value as a} from "./lib.js"; const b = await import("./dyn.js"); export const value = a+b.value; window.moduleState = value;',
  ],
  "style.css": [
    "text/css",
    '@import "more.css"; @font-face { font-family: ProbeFont; src: url("font.woff2"); } body { background: rgb(1, 2, 3); font-family: ProbeFont; }',
  ],
  "more.css": ["text/css", "h1 { color: rgb(4,5,6); }"],
  "image.svg": [
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>',
  ],
  "font.woff2": ["font/woff2", font.toString("base64")],
};
for (const war of ["none", "shell", "all"]) {
  const extension = join(temp, war);
  mkdirSync(extension);
  const manifest = {
    manifest_version: 3,
    name: "YA artifact boundary probe",
    version: "0.0.1",
    permissions: ["storage"],
    host_permissions: [webOrigin + "/*"],
    background: { service_worker: "worker.js" },
    sandbox: { pages: ["sandbox.html"] },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
      sandbox:
        "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' chrome-extension:; style-src 'self' 'unsafe-inline' chrome-extension:; img-src chrome-extension: data: blob:; font-src chrome-extension: data: blob:; connect-src chrome-extension: http:; frame-src 'none'; object-src 'none'; base-uri chrome-extension:;",
    },
    ...(war === "none"
      ? {}
      : {
          web_accessible_resources: [
            {
              resources: war === "all" ? ["*"] : ["sandbox.html"],
              matches: ["<all_urls>"],
            },
          ],
        }),
  };
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(extension, "host.html"),
    '<!doctype html><title>Extension parent</title><script src="host.js"></script>',
  );
  writeFileSync(
    join(extension, "host.js"),
    `window.reports=[]; addEventListener('message', e => reports.push({origin:e.origin, ...e.data}));`,
  );
  writeFileSync(
    join(extension, "sandbox.html"),
    `<!doctype html><title>Sandbox</title><script>
 addEventListener('message', e => { if(e.source !== parent || e.data.type !== 'render') return; document.open(); document.write(e.data.html); document.close(); });
 parent.postMessage({type:'ready'}, '*');</script>`,
  );
  for (const [name, [, body]] of Object.entries(files))
    writeFileSync(join(extension, name), name === "font.woff2" ? font : body);
  writeFileSync(
    join(extension, "worker.js"),
    `
 const files = ${JSON.stringify(files)}; self.events=[];
 addEventListener('fetch', e => {
  events.push({url:e.request.url, mode:e.request.mode, destination:e.request.destination, clientId:e.clientId, resultingClientId:e.resultingClientId});
  const url=new URL(e.request.url);
  if(url.pathname==='/sandbox.html'&&url.search) {e.respondWith(Promise.resolve(new Response(files['document.html'][1],{headers:{'content-type':'text/html'}})));return;}
  if(url.protocol==='http:') {e.respondWith(Promise.resolve(new Response(JSON.stringify({source:'worker'}),{headers:{'content-type':'application/json','access-control-allow-origin':'*'}})));return;}
  if(!url.pathname.startsWith('/v/')) return;
  const name=url.pathname.split('/').pop(); const item=files[name];
  e.respondWith(Promise.resolve(new Response(item ? (name==='font.woff2'?Uint8Array.from(atob(item[1]),c=>c.charCodeAt(0)):item[1]) : 'missing', {status:item?200:404, headers:{'content-type':item?.[0]??'text/plain','access-control-allow-origin':'*'}})));
 });`,
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(
      join(temp, `${war}-profile`),
      {
        channel: "chromium",
        chromiumSandbox: true,
        headless: !process.argv.includes("--headed"),
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const origin = worker.url().replace(/\/worker\.js$/, "");
    results.browser = context.browser()?.version();
    const host = await context.newPage();
    const errors = [];
    host.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await host.goto(origin + "/host.html");
    await host
      .waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        null,
        { timeout: 3000 },
      )
      .catch(() => {});
    await host.reload();
    results.browser = await host.evaluate(() => navigator.userAgent);
    const control = await host.evaluate(async () =>
      fetch("/v/control/data.json")
        .then((r) => r.json())
        .catch(String),
    );
    for (const kind of ["inline", "packaged", "virtual"]) {
      const base = kind === "virtual" ? origin + "/v/viewer/" : origin + "/";
      const html = `<!doctype html><base href="${base}"><link rel="stylesheet" href="style.css"><h1>Artifact probe</h1><img src="image.svg"><script src="classic.js"></script><script>${reportScript}</script>`;
      await host.evaluate(() => {
        document.querySelector("iframe")?.remove();
        reports = [];
        const f = document.createElement("iframe");
        f.src = "sandbox.html";
        document.body.append(f);
      });
      await host.waitForFunction(() => reports.some((r) => r.type === "ready"));
      if (kind === "inline") {
        await host.evaluate(() =>
          document.querySelector("iframe").contentWindow.postMessage(
            {
              type: "render",
              html: `<button onclick="this.textContent='clicked'">Click</button><script>parent.postMessage({type:'report',report:{origin:self.origin,api:typeof chrome.runtime,done:true}},'*')</script>`,
            },
            "*",
          ),
        );
        await host.frameLocator("iframe").getByRole("button").click();
      } else
        await host.evaluate(
          (html) =>
            document
              .querySelector("iframe")
              .contentWindow.postMessage({ type: "render", html }, "*"),
          html,
        );
      await host
        .waitForFunction(() => reports.some((r) => r.report?.done), null, {
          timeout: 15000,
        })
        .catch(() => {});
      const report = await host.evaluate(() => reports);
      const network = await host
        .frames()
        .at(-1)
        .evaluate(
          async (base) => ({
            cors: await fetch(base + "/cors.json")
              .then((r) => r.json())
              .catch(String),
            noCors: await fetch(base + "/no-cors.json")
              .then((r) => r.json())
              .catch(String),
          }),
          webOrigin,
        )
        .catch(String);
      const events = await worker.evaluate(() => events.splice(0));
      results.cases.push({
        war,
        kind,
        control,
        report,
        network,
        events,
        errors: errors.splice(0),
      });
      console.log(JSON.stringify(results.cases.at(-1)));
    }
    for (const mode of process.argv.includes("--navigation")
      ? ["virtual-no-frame-sandbox", "manifest-sandbox-response"]
      : []) {
      const nav = await context.newPage();
      await nav.goto(
        origin +
          (mode === "manifest-sandbox-response"
            ? "/sandbox.html?dynamic=1"
            : "/v/nav/document.html"),
        { timeout: 5000 },
      );
      const state = await nav.evaluate(() => ({
        origin: self.origin,
        extensionAPI: typeof chrome.runtime?.getManifest,
        inlineRan: window.inlineRan ?? false,
      }));
      results.cases.push({
        war,
        kind: mode,
        state,
        events: await worker.evaluate(() => events.splice(0)),
      });
      await nav.close();
    }
    const external = await context.newPage();
    await external.goto(webOrigin);
    await external.evaluate((src) => {
      window.reports = [];
      addEventListener("message", (e) =>
        reports.push({ origin: e.origin, ...e.data }),
      );
      const f = document.createElement("iframe");
      f.src = src;
      document.body.append(f);
    }, origin + "/sandbox.html");
    const embedded = await external
      .waitForFunction(() => reports.some((r) => r.type === "ready"), null, {
        timeout: 3000,
      })
      .then(() => true)
      .catch(() => false);
    let embeddedReport;
    if (embedded) {
      await external.evaluate(
        (html) =>
          document
            .querySelector("iframe")
            .contentWindow.postMessage({ type: "render", html }, "*"),
        `<!doctype html><base href="${origin}/"><link rel="stylesheet" href="style.css"><img src="image.svg"><script src="classic.js"></script><script>${reportScript}</script>`,
      );
      await external
        .waitForFunction(() => reports.some((r) => r.report?.done), null, {
          timeout: 5000,
        })
        .catch(() => {});
      embeddedReport = await external.evaluate(() => reports);
    }
    results.cases.push({ war, kind: "web-embed", embedded, embeddedReport });
  } catch (e) {
    results.cases.push({ war, error: String(e) });
  } finally {
    await context?.close();
  }
}
web.close();
writeFileSync(join(out, "probe.json"), JSON.stringify(results, null, 2));
console.log("Results: " + join(out, "probe.json"));
