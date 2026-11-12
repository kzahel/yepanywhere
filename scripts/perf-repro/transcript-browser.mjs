import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  readFileSync,
  realpathSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve, extname, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { assessHostEligibility } from "../perf-suite/host-profile.mjs";
import { fingerprintTree } from "./active-session-build.mjs";
import {
  startHostEvidence,
  measuredHostSample,
  hostWindow,
} from "./active-session-metrics.mjs";
import { verifyTranscriptProbe } from "./transcript-browser-integrity.mjs";
import { installTranscriptProbe } from "./transcript-browser-probe.mjs";
import { summarizeTranscriptProbe } from "./transcript-browser-metrics.mjs";

const require = createRequire(
  new URL("../../packages/client/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectId = "L3N5bnRoZXRpYy9mcm9udGVuZA";

export async function serveFixture(directory, port) {
  const root = resolve(directory);
  const html = resolve(root, "e2e/transcript-performance/index.html");
  if (!existsSync(html)) throw new Error(`Missing built fixture: ${html}`);
  const failures = [];
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://fixture").pathname,
      );
    } catch {
      failures.push("malformed URL");
      res.writeHead(400).end();
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (
      pathname.startsWith("/api/") ||
      (file !== root && !file.startsWith(root + sep))
    ) {
      failures.push(pathname);
      res.writeHead(404).end();
      return;
    }
    const asset = extname(file) ? file : html;
    try {
      const content = readFileSync(asset);
      const mime =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[extname(asset)] ?? "application/octet-stream";
      res
        .writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" })
        .end(content);
    } catch {
      failures.push(pathname);
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, failures, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(options) {
  const identity = fingerprintTree(options["client-dist"]);
  const harness = Object.fromEntries(
    [
      "transcript-browser.mjs",
      "transcript-browser-integrity.mjs",
      "transcript-browser-probe.mjs",
      "transcript-browser-metrics.mjs",
      "active-session-build.mjs",
      "active-session-metrics.mjs",
      "../perf-suite/host-profile.mjs",
      "../perf-suite/ratchet-evaluation.mjs",
      "../perf-suite/core.mjs",
      "../perf-suite/config.json",
    ].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest("hex"),
    ]),
  );
  if (
    !options.serve &&
    existsSync(options.out) &&
    readdirSync(options.out).length
  )
    throw new Error(`Output must be empty: ${options.out}`);
  mkdirSync(options.out, { recursive: true });
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3400)
    throw new Error("Use an owned test port other than 3400");
  const served = await serveFixture(identity.root, port);
  let browser;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    process.exitCode = 130;
    void browser?.close();
  };
  if (!options.serve) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    if (options.serve) {
      console.log(served.url);
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      return;
    }
    if (interrupted) throw new Error("Benchmark interrupted");
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const integrity = await verifyTranscriptProbe(browser);
    const host = await startHostEvidence(false);
    writeFileSync(
      resolve(options.out, "manifest.json"),
      JSON.stringify(
        {
          schema: 1,
          identity,
          harness,
          options,
          integrity,
          browser: await browser.version(),
          host,
        },
        null,
        2,
      ) + "\n",
    );
    const cases = [];
    const turns = options.turns.split(",").map(Number);
    const views = options.views.split(",");
    const widths = options.widths.split(",").map(Number);
    const retention = options.retention;
    if (
      !["fixed", "rolling", "growing"].includes(retention) ||
      (retention !== "fixed" &&
        (views.some((view) => view !== "page") ||
          turns.some((turn) => turn < 20)))
    )
      throw new Error(
        "Rolling retention requires the real session page and at least 20 backing turns",
      );
    const count = Number(options.appends),
      intervalMs = Number(options.interval);
    if (
      turns.some((n) => !Number.isInteger(n) || n < 1 || n > 10000) ||
      views.some((v) => !["page", "transcript"].includes(v)) ||
      widths.some((n) => !Number.isInteger(n) || n < 320 || n > 3000) ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > 1000 ||
      !Number.isFinite(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 10000 ||
      !Number.isInteger(Number(options.repeats)) ||
      Number(options.repeats) < 1
    )
      throw new Error("Invalid benchmark configuration");
    // Alternate sizes/views by repetition to reduce order bias.
    const configurations = widths.flatMap((width) =>
      turns.flatMap((turn) => views.map((view) => ({ width, turn, view }))),
    );
    for (let repeat = 0; repeat < Number(options.repeats); repeat++) {
      for (const config of repeat % 2
        ? [...configurations].reverse()
        : configurations) {
        if (interrupted) throw new Error("Benchmark interrupted");
        const context = await browser.newContext({
          viewport: {
            width: config.width,
            height: config.width < 600 ? 812 : 800,
          },
          serviceWorkers: "block",
        });
        // Rendering benchmark excludes PWA installation/cache lifecycle. Removing the
        // browser capability avoids a synthetic Playwright SW-block warning.
        await context.addInitScript(() => {
          Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
          if ("serviceWorker" in navigator)
            throw new Error("Could not disable fixture service workers");
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (message) => {
          if (["error", "warning"].includes(message.type()))
            errors.push(`${message.type()}: ${message.text()}`);
        });
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin === served.url)
            return route.continue();
          errors.push(`Unexpected external request: ${route.request().url()}`);
          return route.abort();
        });
        const route =
          config.view === "page"
            ? `/projects/${projectId}/sessions/frontend-performance`
            : "/";
        await page.goto(
          `${served.url}${route}?view=${config.view}&turns=${config.turn}&retention=${retention}`,
          { waitUntil: "networkidle" },
        );
        await page.waitForSelector("[data-composer-input]", { timeout: 20000 });
        await page.waitForFunction(
          () =>
            window.__transcriptFixture &&
            document.querySelector(
              '[data-message-list-progressive-hydrating="true"]',
            ) === null,
        );
        await pause(1000);
        const initialSnapshot = await page.evaluate(() =>
          window.__transcriptFixture.snapshot(),
        );
        if (
          initialSnapshot.loadedMessages !==
          (retention === "fixed" ? config.turn * 4 : 82)
        )
          throw new Error(
            `Requested ${config.turn * 4} messages, retained ${initialSnapshot.loadedMessages} before measurement`,
          );
        await page.locator("[data-composer-input]").focus();
        await page.evaluate(installTranscriptProbe);
        const calibration = await page.evaluate(() =>
          window.__transcriptProbe.calibrate(),
        );
        await page.evaluate((n) => window.__transcriptProbe.prepare(n), count);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        const metrics = async () =>
          Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
              m.name,
              m.value,
            ]),
          );
        const startHost = await measuredHostSample(host.capacity);
        const before = await metrics();
        const start = Date.now();
        await page.evaluate((args) => window.__transcriptProbe.start(args), {
          count,
          intervalMs,
          stallMs: options["negative-control"] ? 150 : 0,
        });
        const textLength = Math.floor(
          ((count - 1) * intervalMs) / (retention === "fixed" ? 80 : 65),
        );
        const phrase = "typing stays responsive during transcript updates ";
        const text =
          options.typing || options["negative-control"]
            ? phrase
                .repeat(Math.ceil(textLength / phrase.length))
                .slice(0, textLength)
            : "";
        await page.keyboard.type(text, { delay: 60 });
        await pause(
          Math.max(0, start + (count - 1) * intervalMs + 1000 - Date.now()),
        );
        // Let the final native key's acknowledgement frame run even if the
        // controller finishes typing after the nominal append window.
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        const raw = await page.evaluate(() =>
          window.__transcriptProbe.finish(),
        );
        const after = await metrics();
        const windowHost = await hostWindow(host, startHost);
        await page.evaluate(() => window.__transcriptProbe.dispose());
        writeFileSync(
          resolve(
            options.out,
            `raw-${config.view}-${config.turn}-${config.width}-${repeat}.json`,
          ),
          JSON.stringify(
            {
              config,
              repeat,
              raw,
              calibration,
              errors,
              before,
              after,
              host: windowHost,
              identity,
              harness,
            },
            null,
            2,
          ) + "\n",
        );
        const summary = summarizeTranscriptProbe(raw, calibration, count, text);
        if (
          retention === "fixed" &&
          raw.snapshot.loadedMessages !== (config.turn + count) * 4
        )
          errors.push(
            `Unexpected retained message count: ${raw.snapshot.loadedMessages}`,
          );
        if (retention !== "fixed") {
          const initial = initialSnapshot;
          const final = raw.snapshot;
          const trace = raw.markers.map((marker) => marker.retained);
          if (trace.some((sample) => !sample))
            errors.push("Missing retention observations");
          const expectedGrowing =
            82 +
            count * 3 +
            Math.ceil(count / 5) +
            [10, 30].filter((index) => index < count).length;
          if (final.lastMessageId !== `reply-${config.turn + count - 1}`)
            errors.push("Latest update missing from retained window");
          if (
            retention === "growing" &&
            (final.trimRevision !== 0 ||
              final.loadedMessages !== expectedGrowing)
          )
            errors.push("Unexpected trim in growing control");
          if (
            retention === "rolling" &&
            count >= 80 &&
            intervalMs === 1000 &&
            (final.trimRevision < 2 ||
              final.compactions > 2 ||
              !trace.some(
                (sample) =>
                  sample?.trimRevision >= 2 &&
                  sample.firstMessageId === "compact-live-10",
              ))
          )
            errors.push("Required two compaction-window unloads not observed");
          if (
            retention === "rolling" &&
            count === 85 &&
            intervalMs === 1000 &&
            (final.loadedMessages !== expectedGrowing - 114 ||
              final.firstMessageId !== "compact-live-10")
          )
            errors.push("Unexpected canonical rolling retained window");
          const secondTrim = raw.markers.find(
            (marker) => marker.retained?.trimRevision >= 2,
          );
          if (
            retention === "rolling" &&
            options.typing &&
            count >= 80 &&
            intervalMs === 1000 &&
            (!secondTrim || raw.keys.at(-1)?.at < secondTrim.domAt)
          )
            errors.push("Typing did not overlap the age-guarded unload");
          summary.retention = { initial, final, trace };
        }
        const eligibility = assessHostEligibility(
          host.capacity,
          windowHost.summary,
          host.policy,
        );
        summary.valid &&= errors.length === 0 && served.failures.length === 0;
        const qualified = host.eligibility.pass && eligibility.pass;
        const result = {
          config,
          repeat,
          summary,
          qualified,
          eligibility,
          taskMsPerAppend:
            ((after.TaskDuration - before.TaskDuration) * 1000) / count,
          errors,
          host: windowHost,
          calibration,
          raw,
        };
        cases.push(result);
        console.log(
          JSON.stringify({
            config,
            repeat,
            ...summary,
            taskMsPerAppend: result.taskMsPerAppend,
            errors,
          }),
        );
        await context.close();
      }
    }
    if (fingerprintTree(identity.root).sha256 !== identity.sha256)
      throw new Error("Fixture changed during measurement");
    const output = {
      schema: 1,
      integrity,
      at: new Date().toISOString(),
      identity,
      harness,
      options,
      browser: await browser.version(),
      host,
      serverFailures: served.failures,
      cases,
    };
    mkdirSync(options.out, { recursive: true });
    writeFileSync(
      resolve(options.out, "results.json"),
      JSON.stringify(output, null, 2) + "\n",
    );
    const negative = options["negative-control"];
    if (
      cases.some((c) => !c.summary.valid || !c.qualified) ||
      (!negative && cases.some((c) => c.summary.responsiveInput === false)) ||
      (negative &&
        cases.some(
          (c) =>
            c.summary.responsiveInput ||
            c.summary.longTasks === 0 ||
            c.summary.gapsOverTwoFrames === 0,
        ))
    )
      process.exitCode = 1;
  } catch (error) {
    writeFileSync(
      resolve(options.out, "failure.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          error: String(error.stack ?? error),
          identity,
          harness,
          serverFailures: served.failures,
        },
        null,
        2,
      ) + "\n",
    );
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await browser?.close();
    await new Promise((resolve) => served.server.close(resolve));
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const { values } = parseArgs({
    options: {
      "client-dist": { type: "string" },
      out: { type: "string", default: "/tmp/transcript-browser" },
      port: { type: "string", default: "3420" },
      turns: { type: "string", default: "20,200,1000" },
      views: { type: "string", default: "transcript,page" },
      widths: { type: "string", default: "1280" },
      appends: { type: "string", default: "12" },
      interval: { type: "string", default: "1000" },
      repeats: { type: "string", default: "3" },
      retention: { type: "string", default: "fixed" },
      typing: { type: "boolean" },
      serve: { type: "boolean" },
      "negative-control": { type: "boolean" },
    },
  });
  if (!values["client-dist"])
    throw new Error("Required: --client-dist <externally built fixture dist>");
  await run(values);
}
