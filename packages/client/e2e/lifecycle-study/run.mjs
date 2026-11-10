/** Opt-in diagnostic study, not a passing CI test. See README.md. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { arch, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { chromium, _android } from "@playwright/test";
import { preview } from "vite";
import { createRelayServer } from "../../../relay/src/server.ts";
import { startFixture } from "../../../mobile-core/scripts/fixture.mjs";
import {
  writeCapturePreview,
  emitCapturePreview,
} from "../../scripts/artifact-capture.ts";
import { createNetworkGate } from "./network-gate.mjs";
import { installObserver } from "./observe.mjs";
import { assessPageRecovery } from "./acceptance.mjs";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [name, ...value] = arg.replace(/^--/, "").split("=");
    return [name, value.join("=")];
  }),
);
const client = options.client ?? "browser";
const webBuild = resolve(
  options["web-build"] ?? join(repo, "packages/client/dist-remote"),
);
const route = options.route ?? "direct";
const surface = options.surface ?? "session";
const fault = options.fault ?? "disconnect";
const verify = options.verify === "true";
// Passive recovery measured 49–65 s. Three minutes is ~3x the observed
// maximum; verification exits after five healthy seconds (one stream retry cap).
const observationMs = Number(
  options["observe-ms"] ?? (verify ? 180_000 : 90_000),
);
const outageMs = Number(options["outage-ms"] ?? 16_000);
const activity = options.activity ?? "none";
const chromeMode = options.chrome ?? "automated";
const cycles = Number(options.cycles ?? 1);
const sleepMs = Number(options["sleep-ms"] ?? 8000);
const steadyMs = Number(options["steady-ms"] ?? 5000);
const attachment = options.attachment === "true";
const restartAfterTap = options["restart-after-tap"] === "true";
const onDevice = client === "android" || client === "android-chrome";
const notification =
  fault === "notification-offline" || fault === "notification";
const processDeath =
  fault === "process-death" || fault === "process-death-offline";
if (
  (options.verify !== undefined &&
    !["true", "false"].includes(options.verify)) ||
  !["browser", "android", "android-chrome"].includes(client) ||
  !["direct", "mux"].includes(route) ||
  !["session", "inbox"].includes(surface) ||
  ![
    "control",
    "disconnect",
    "in-flight",
    "outage",
    "wake-outage",
    "silent",
    "sleep",
    "doze",
    "cycles",
    "process-death",
    "process-death-offline",
    "notification",
    "notification-offline",
    "upload-interruption",
  ].includes(fault) ||
  !(observationMs >= 1000 && observationMs <= 180_000) ||
  !["automated", "stock"].includes(chromeMode) ||
  !(Number.isInteger(cycles) && cycles >= 1 && cycles <= 20) ||
  !(steadyMs >= 5000 && steadyMs <= 60_000) ||
  !(sleepMs >= 1000 && sleepMs <= 300_000) ||
  (notification && client !== "android") ||
  (attachment && surface !== "session") ||
  (fault === "upload-interruption" &&
    (surface !== "session" || verify || attachment)) ||
  (restartAfterTap && fault !== "notification-offline") ||
  (options["restart-after-tap"] !== undefined &&
    !["true", "false"].includes(options["restart-after-tap"])) ||
  (options.attachment !== undefined &&
    !["true", "false"].includes(options.attachment)) ||
  (fault === "doze" && !onDevice) ||
  !(outageMs >= 1000 && outageMs <= 120_000) ||
  !["none", "typing"].includes(activity) ||
  (activity === "typing" && surface !== "session")
)
  throw new Error("Invalid study options; see README.md");
const serial = process.env.ANDROID_SERIAL;
if (onDevice && !/^emulator-\d+$/.test(serial ?? ""))
  throw new Error(
    "This study only operates an explicitly selected emulator: set ANDROID_SERIAL",
  );
const adb = process.env.ANDROID_HOME
  ? join(process.env.ANDROID_HOME, "platform-tools/adb")
  : "adb";
const device = (...args) =>
  exec(adb, ["-s", serial, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${client}-${route}-${surface}-${fault}`;
const out = resolve(
  options.out ?? join(repo, "tasks/source-lifecycle-study", runId),
);
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const timeline = [];
const screenshots = [];
const started = Date.now();
const record = (event) => {
  timeline.push({ at: Date.now(), ...event });
  if (
    ["stage", "fault-start", "network-restored", "process-absent"].includes(
      event.type,
    )
  )
    console.log(JSON.stringify(event));
  if (timeline.length > 20_000) timeline.shift();
};
const host = () => ({
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0].model,
  cores: cpus().length,
  totalMemory: totalmem(),
  freeMemory: freemem(),
  availableMemory: process.availableMemory?.(),
  load: loadavg(),
});
const result = {
  runId,
  client,
  route,
  surface,
  fault,
  observationMs,
  outageMs,
  activity,
  chromeMode,
  cycles,
  sleepMs,
  steadyMs,
  attachment,
  restartAfterTap,
  started,
  hostStart: host(),
  grade: "page invariants; timings are not benchmark acceptance",
  verify,
  revision: (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repo })
  ).stdout.trim(),
};
result.dirtyFiles = (
  await exec("git", ["status", "--short"], { cwd: repo })
).stdout.trim();
result.bundleHash = createHash("sha256")
  .update(await readFile(join(webBuild, "remote.html")))
  .digest("hex");
const harnessHash = createHash("sha256");
for (const file of [
  "run.mjs",
  "observe.mjs",
  "network-gate.mjs",
  "acceptance.mjs",
])
  harnessHash.update(await readFile(new URL(file, import.meta.url)));
result.harnessHash = harnessHash.digest("hex");
let relay, fixture, gate, staticServer, browser, page, cdp, instrument;
let instrumentDone;
let emulator;
let chromeContext;
let notificationPermission;
let preparedMetadata;
const previousObservers = { rows: [], keys: [] };
let androidDevices = [];
const reverses = [];
const forwards = [];
let instrumentLog = "";
const deviceDir =
  "/sdcard/Android/data/com.yepanywhere.mobile/files/lifecycle-study";
async function until(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  do {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Study setup/operation did not complete within ${ms}ms`, {
    cause: last,
  });
}
const probe = async (path, method = "POST") => {
  const response = await fetch(
    `http://127.0.0.1:${fixture.port}/__probe/${path}`,
    { method },
  );
  if (!response.ok) throw new Error(`Probe ${path}: ${response.status}`);
  return response.json();
};
async function launchChrome() {
  if (chromeMode !== "stock") return emulator.launchBrowser();
  // Chrome's normal background policy; Playwright launchBrowser adds switches
  // that disable background timer throttling and renderer backgrounding.
  await device("shell", "am", "force-stop", "com.android.chrome");
  const socket = "ya_lifecycle_devtools_remote";
  await device(
    "shell",
    `echo '_ --disable-fre --no-default-browser-check --remote-debugging-socket-name=${socket}' > /data/local/tmp/chrome-command-line`,
  );
  try {
    await device(
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "about:blank",
      "com.android.chrome",
    );
    const port = (
      await device("forward", "tcp:0", `localabstract:${socket}`)
    ).stdout.trim();
    forwards.push(port);
    await until(
      async () =>
        (
          await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok,
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return browser.contexts()[0];
  } finally {
    await device("shell", "rm", "-f", "/data/local/tmp/chrome-command-line");
  }
}
async function cleanup(label, action) {
  try {
    await action();
  } catch (error) {
    record({ type: "cleanup-error", label, error: String(error) });
    result.completed = false;
    result.error ??= `Cleanup failed: ${label}: ${error}`;
    process.exitCode = 1;
  }
}
async function observePage() {
  page.setDefaultTimeout(30_000);
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      record({
        type: `console-${message.type()}`,
        text: message.text().slice(0, 1600),
      });
  });
  page.on("pageerror", (error) =>
    record({ type: "page-error", text: error.message }),
  );
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      record({
        type: "document-navigation",
        path: new URL(frame.url()).pathname,
      });
  });
  await page.addInitScript(installObserver);
  await page.evaluate(installObserver);
}
async function capture(name) {
  if (!page || page.isClosed()) return;
  const dimensions = (bytes) => {
    if (bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a")
      throw new Error("Expected a PNG screenshot");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  const path = join(out, `${name}.png`);
  const bytes = await page.screenshot({ path, timeout: 10_000 });
  screenshots.push({ name, path, ...dimensions(bytes) });
  if (onDevice) {
    const full = await exec(
      adb,
      ["-s", serial, "exec-out", "screencap", "-p"],
      {
        encoding: "buffer",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const devicePath = join(out, `${name}-device.png`);
    await writeFile(devicePath, full.stdout);
    screenshots.push({
      name: `${name}-device`,
      path: devicePath,
      ...dimensions(full.stdout),
    });
  }
}
async function snapshot(label) {
  const state = await page.evaluate(
    ({ needle, title }) => ({
      ...window.__lifecycleStudy?.sample(),
      body: document.body.innerText.slice(0, 5000),
      needle: needle ? document.body.innerText.includes(needle) : false,
      needleCount: needle
        ? document.body.innerText.split(needle).length - 1
        : 0,
      titleUpdated: document.body.innerText.includes(title),
    }),
    {
      needle: result.expectedMessage,
      title: result.expectedTitle ?? "Updated study",
    },
  );
  record({ type: "checkpoint", label, ...state });
  return state;
}
async function navigate(path) {
  await page.evaluate((path) => {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}
async function updateWhileDisconnected(force = false) {
  if (result.expectedMessage && !force) return;
  result.expectedMessage = (await probe("append")).message;
  result.updateNumber = (result.updateNumber ?? 0) + 1;
  result.expectedTitle = `Updated study${force ? ` ${result.updateNumber}` : ""}`;
  const response = await fetch(
    `http://127.0.0.1:${fixture.port}/api/sessions/android-preview-session/metadata`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Yep-Anywhere": "true" },
      body: JSON.stringify({ title: result.expectedTitle, starred: true }),
    },
  );
  if (!response.ok)
    throw new Error(`Study metadata update: ${response.status}`);
  record({ type: "server-updated", message: result.expectedMessage });
}
try {
  process.env.YEP_PROVIDER_HOST_ENABLED = "false";
  const username = `study-${randomUUID().slice(0, 8)}`;
  if (client !== "android") {
    staticServer = await preview({
      configFile: false,
      root: join(repo, "packages/client"),
      build: { outDir: webBuild },
      preview: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "study-remote-entry",
          configurePreviewServer(server) {
            server.middlewares.use((req, _res, next) => {
              if (!req.url?.split("?")[0].includes("."))
                req.url = "/remote.html";
              next();
            });
          },
        },
      ],
    });
  }
  if (route === "mux")
    relay = await createRelayServer({
      port: 0,
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      allowedOrigins: staticServer
        ? new URL(staticServer.resolvedUrls.local[0]).origin
        : undefined,
      disableTelemetry: true,
    });
  fixture = await startFixture({
    username,
    relayURL: relay ? `ws://127.0.0.1:${relay.port}/ws` : undefined,
  });
  if (attachment) {
    const response = await fetch(
      `http://127.0.0.1:${fixture.port}/api/attachments/staging/drafts/study-preflight/validate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ refs: [] }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Fixture attachment validation unavailable: ${response.status}`,
      );
  }
  gate = await createNetworkGate(relay?.port ?? fixture.port, record);
  const endpoint = `ws://127.0.0.1:${gate.port}/${relay ? "ws" : "api/ws"}`;
  if (onDevice) {
    const [build, webView] = await Promise.all([
      device("shell", "getprop", "ro.build.fingerprint"),
      device("shell", "dumpsys", "webviewupdate"),
    ]);
    result.androidBuild = build.stdout.trim();
    result.webViewPackage = webView.stdout.match(
      /Current WebView package \(name, version\): (.*)/,
    )?.[1];
    androidDevices = await _android.devices({ omitDriverInstall: true });
    emulator = androidDevices.find((device) => device.serial() === serial);
    if (!emulator)
      throw new Error("Selected emulator absent from Playwright discovery");
    emulator.setDefaultTimeout(30_000);
  }
  if (client !== "android") {
    let context;
    if (client === "android-chrome") {
      for (const port of [
        gate.port,
        new URL(staticServer.resolvedUrls.local[0]).port,
      ]) {
        await device("reverse", `tcp:${port}`, `tcp:${port}`);
        reverses.push(port);
      }
      chromeContext = await launchChrome();
      context = chromeContext;
      result.browserVersion = (
        await device("shell", "dumpsys", "package", "com.android.chrome")
      ).stdout.match(/versionName=(.*)/)?.[1];
    } else {
      browser = await chromium.launch({ chromiumSandbox: true });
      result.browserVersion = browser.version();
      context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        recordVideo: { dir: out },
      });
    }
    page = await context.newPage();
    await page.goto(staticServer.resolvedUrls.local[0]);
    await page
      .getByTestId(relay ? "relay-mode-button" : "direct-mode-button")
      .click();
    await page
      .getByTestId(relay ? "relay-username-input" : "username-input")
      .fill(username);
    await page
      .getByTestId(relay ? "srp-password-input" : "password-input")
      .fill("native-fixture-password");
    if (relay)
      await page.getByText("Show Advanced Options", { exact: true }).click();
    await page
      .getByTestId(relay ? "custom-relay-url-input" : "ws-url-input")
      .fill(endpoint);
    await page.getByTestId("login-button").click();
    await page
      .getByText("preview-project", { exact: true })
      .first()
      .waitFor({ timeout: 30_000 });
  } else {
    result.apkHashes = {};
    for (const apk of [
      "bundled/debug/app-bundled-debug.apk",
      "androidTest/bundled/debug/app-bundled-debug-androidTest.apk",
    ]) {
      const path = join(repo, "packages/android/app/build/outputs/apk", apk);
      result.apkHashes[apk] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      await device("install", "-r", path);
    }
    for (const port of [fixture.port, gate.port]) {
      await device("reverse", `tcp:${port}`, `tcp:${port}`);
      reverses.push(port);
    }
    if (notification) {
      notificationPermission = /POST_NOTIFICATIONS: granted=true/.test(
        (await device("shell", "dumpsys", "package", "com.yepanywhere.mobile"))
          .stdout,
      );
      await device(
        "shell",
        "pm",
        "grant",
        "com.yepanywhere.mobile",
        "android.permission.POST_NOTIFICATIONS",
      );
    }
    await device("shell", "rm", "-rf", deviceDir);
    await device("shell", "logcat", "-c");
    const args = {
      class:
        "com.yepanywhere.mobile.web.YaNativeReconnectInstrumentedTest#hostDrivenLifecycleStudy",
      yaLifecycleStudy: "true",
      ...(processDeath || notification ? { yaLifecycleDetached: "true" } : {}),
      ...(notification ? { yaLifecyclePush: "true" } : {}),
      yaProbeWsUrl: relay ? fixture.endpoint : endpoint,
      yaProbeUsername: username,
      yaProbePassword: "native-fixture-password",
      ...(relay ? { yaProbeRelayWsUrl: endpoint } : {}),
    };
    instrument = spawn(
      adb,
      [
        "-s",
        serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        ...Object.entries(args).flatMap(([k, v]) => ["-e", k, v]),
        "com.yepanywhere.mobile.test/androidx.test.runner.AndroidJUnitRunner",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    instrument.stdout.on("data", (data) => {
      instrumentLog += data;
    });
    instrument.stderr.on("data", (data) => {
      instrumentLog += data;
    });
    instrumentDone = new Promise((done) => instrument.once("close", done));
    await until(async () => {
      if (instrument.exitCode !== null)
        throw new Error(`Instrumentation exited: ${instrumentLog}`);
      return (
        await device("shell", "cat", `${deviceDir}/ready.json`)
      ).stdout.includes("sessionPath");
    }, 60_000);
    if (processDeath || notification) {
      preparedMetadata = JSON.parse(
        (await device("shell", "cat", `${deviceDir}/ready.json`)).stdout,
      );
      record({ type: "stage", name: "wait-preparation" });
      await instrumentDone;
      record({ type: "stage", name: "launch-prepared" });
      if (!/OK \(1 test\)/.test(instrumentLog)) throw new Error(instrumentLog);
      await device(
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        "com.yepanywhere.mobile/.MainActivity",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
      );
    }
    record({ type: "stage", name: "attach-webview" });
    page = await (
      await emulator.webView({
        pkg: "com.yepanywhere.mobile",
        pid: Number(
          (
            await device("shell", "pidof", "com.yepanywhere.mobile")
          ).stdout.trim(),
        ),
      })
    ).page();
    record({ type: "stage", name: "attached" });
    result.webView = (await device("shell", "dumpsys", "webviewupdate")).stdout;
  }
  record({ type: "stage", name: "observe-page" });
  await observePage();
  cdp = await page.context().newCDPSession(page);
  const projects = await (
    await fetch(`http://127.0.0.1:${fixture.port}/api/projects`)
  ).json();
  const projectId = projects.projects[0].id;
  const current = new URL(page.url()).pathname;
  const prefix = current.includes("/projects")
    ? current.slice(0, current.indexOf("/projects"))
    : "";
  const sessionPath = `${prefix}/projects/${projectId}/sessions/android-preview-session`;
  const target = surface === "session" ? sessionPath : `${prefix}/inbox`;
  result.expectedPath = target;
  result.expectedDraft =
    "Draft survives outage" +
    (activity === "typing" ? " while recovering" : "");
  await navigate(target);
  await page
    .locator(
      surface === "session"
        ? "textarea[data-composer-input]"
        : "[data-inbox-toolbar]",
    )
    .waitFor();
  if (surface === "session")
    await page
      .locator("textarea[data-composer-input]")
      .pressSequentially("Draft survives outage", { delay: 40 });
  if (attachment) {
    result.expectedAttachment = "lifecycle-draft.txt";
    await page.locator('input[type="file"]').setInputFiles({
      name: result.expectedAttachment,
      mimeType: "text/plain",
      buffer: Buffer.from("Keep this staged attachment across reconnects.\n"),
    });
    await page
      .getByRole("button", {
        name: `Remove ${result.expectedAttachment}`,
        exact: true,
      })
      .waitFor();
    await until(
      async () =>
        !(await page.locator(".attachment-list").innerText()).includes("%"),
    );
  }
  await pause(1500);
  result.initialResources = await (
    await fetch(`http://127.0.0.1:${fixture.port}/api/activity/status`)
  ).json();
  await snapshot("before");
  await capture("before");
  result.faultAt = Date.now();
  record({ type: "fault-start", fault });
  if (notification) {
    Object.assign(
      previousObservers,
      await page.evaluate(() => ({
        rows: window.__lifecycleStudy.rows,
        keys: window.__lifecycleStudy.keys,
      })),
    );
    await navigate(`${prefix}/inbox`);
    await page.locator("[data-inbox-toolbar]").waitFor();
    await device("shell", "input", "keyevent", "KEYCODE_HOME");
    await pause(1500);
    await device("shell", "am", "kill", "com.yepanywhere.mobile");
    await until(
      async () =>
        !(
          await device("shell", "pidof", "com.yepanywhere.mobile").catch(
            () => ({ stdout: "" }),
          )
        ).stdout.trim(),
    );
    record({ type: "process-absent", package: "com.yepanywhere.mobile" });
    await device("shell", "input", "keyevent", "KEYCODE_SLEEP");
    await updateWhileDisconnected();
    const sent = await probe("push");
    if (sent.sent !== 1)
      throw new Error(
        `Push fixture submission failed: ${JSON.stringify(sent)}`,
      );
    await until(
      async () =>
        (await device("shell", "cmd", "notification", "list")).stdout.includes(
          `${preparedMetadata.subscriptionId}:android-preview-session`,
        ),
      40_000,
    );
    record({
      type: "push-delivered",
      note: "Real FCM after verified absent app process, screen asleep",
    });
    if (fault === "notification-offline") gate.setMode("refuse");
    await device("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    await device("shell", "wm", "dismiss-keyguard");
    await device("shell", "cmd", "statusbar", "expand-notifications");
    const bounds = await until(async () => {
      await device(
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/ya-study-notifications.xml",
      );
      const xml = (
        await device("shell", "cat", "/sdcard/ya-study-notifications.xml")
      ).stdout;
      await writeFile(join(out, "notification.xml"), xml);
      const node = xml.match(
        /<node[^>]*text="An agent has finished working\."[^>]*>/,
      )?.[0];
      return node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    });
    await device(
      "shell",
      "input",
      "tap",
      String(Math.round((Number(bounds[1]) + Number(bounds[3])) / 2)),
      String(Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)),
    );
    record({ type: "notification-tap" });
    page = await (
      await emulator.webView({
        pkg: "com.yepanywhere.mobile",
        pid: Number(
          (
            await device("shell", "pidof", "com.yepanywhere.mobile")
          ).stdout.trim(),
        ),
      })
    ).page();
    await observePage();
    await pause(outageMs);
    result.notificationEntry = await snapshot("notification-entry");
    await capture("notification-entry");
    if (restartAfterTap) {
      const observed = await page.evaluate(() => ({
        rows: window.__lifecycleStudy.rows,
        keys: window.__lifecycleStudy.keys,
      }));
      previousObservers.rows.push(...observed.rows);
      previousObservers.keys.push(...observed.keys);
      const pkg = "com.yepanywhere.mobile";
      result.pendingTapPidBefore = (
        await device("shell", "pidof", pkg)
      ).stdout.trim();
      await device("shell", "input", "keyevent", "KEYCODE_HOME");
      await pause(1500);
      await device("shell", "am", "kill", pkg);
      await until(
        async () =>
          !(
            await device("shell", "pidof", pkg).catch(() => ({ stdout: "" }))
          ).stdout.trim(),
      );
      record({
        type: "process-absent",
        package: pkg,
        pendingNotification: true,
      });
      await device(
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        `${pkg}/.MainActivity`,
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
      );
      result.pendingTapPidAfter = (
        await device("shell", "pidof", pkg)
      ).stdout.trim();
      page = await (
        await emulator.webView({ pkg, pid: Number(result.pendingTapPidAfter) })
      ).page();
      await observePage();
    }
  } else if (processDeath) {
    Object.assign(
      previousObservers,
      await page.evaluate(() => ({
        rows: window.__lifecycleStudy.rows,
        keys: window.__lifecycleStudy.keys,
      })),
    );
    const url = page.url();
    if (fault === "process-death-offline") gate.setMode("refuse");
    if (onDevice) {
      const pkg =
        client === "android" ? "com.yepanywhere.mobile" : "com.android.chrome";
      result.pidBefore = (await device("shell", "pidof", pkg)).stdout.trim();
      await device("shell", "input", "keyevent", "KEYCODE_HOME");
      await pause(1500);
      await device("shell", "am", "kill", pkg);
      await until(
        async () =>
          !(
            await device("shell", "pidof", pkg).catch(() => ({ stdout: "" }))
          ).stdout.trim(),
      );
      record({ type: "process-absent", package: pkg });
      await updateWhileDisconnected();
      if (client === "android") {
        await device(
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          `${pkg}/.MainActivity`,
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
        );
        page = await (
          await emulator.webView({
            pkg,
            pid: Number((await device("shell", "pidof", pkg)).stdout.trim()),
          })
        ).page();
      } else {
        chromeContext = await launchChrome();
        page = chromeContext
          .pages()
          .find((candidate) => candidate.url() === url);
        result.chromeRestoredTab = Boolean(page);
        if (!page) {
          page = await chromeContext.newPage();
          await page.goto(url);
          record({
            type: "browser-reopen-saved-url",
            note: "No restored tab; navigation uses retained Chrome site storage",
          });
        }
      }
      result.pidAfter = (await device("shell", "pidof", pkg)).stdout.trim();
    } else {
      await page.close();
      await updateWhileDisconnected();
      page = await browser.contexts()[0].newPage();
      await page.goto(url);
    }
    await page.waitForLoadState("domcontentloaded");
    await observePage();
    await pause(3000);
    result.coldEntry = await snapshot("cold-entry");
    await capture("cold-entry");
    if (fault === "process-death-offline") await pause(outageMs);
  } else if (["sleep", "doze", "cycles"].includes(fault)) {
    result.cycleResults = [];
    for (let cycle = 1; cycle <= cycles; cycle++) {
      if (onDevice) await device("shell", "input", "keyevent", "KEYCODE_SLEEP");
      else await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      if (fault === "doze") {
        await device("shell", "dumpsys", "battery", "unplug");
        result.dozeState = (
          await device("shell", "dumpsys", "deviceidle", "force-idle")
        ).stdout;
        if (!result.dozeState.includes("Now forced in to deep idle mode"))
          throw new Error(`Doze not entered: ${result.dozeState}`);
      }
      gate.setMode("refuse");
      await updateWhileDisconnected(true);
      await pause(sleepMs);
      const asleepResources = await (
        await fetch(`http://127.0.0.1:${fixture.port}/api/activity/status`)
      ).json();
      gate.setMode("pass");
      if (fault === "doze") {
        await device("shell", "dumpsys", "deviceidle", "unforce");
        await device("shell", "dumpsys", "battery", "reset");
      }
      if (onDevice) {
        await device("shell", "input", "keyevent", "KEYCODE_WAKEUP");
        await device("shell", "wm", "dismiss-keyguard");
      } else await cdp.send("Page.setWebLifecycleState", { state: "active" });
      const wokeAt = Date.now();
      let state;
      await until(async () => {
        state = await snapshot(`cycle-${cycle}`);
        return (
          !state.connection &&
          !state.errors &&
          !state.login &&
          state.titleUpdated &&
          (surface !== "session" || state.needle)
        );
      }, observationMs);
      const resourceResponse = await fetch(
        `http://127.0.0.1:${fixture.port}/api/activity/status`,
      );
      const resources = await resourceResponse.json();
      if (surface === "session" && state.draft !== result.expectedDraft)
        throw new Error(`Cycle ${cycle} lost the unsent draft`);
      if (surface === "session" && state.needleCount !== 1)
        throw new Error(`Cycle ${cycle} duplicated the catch-up message`);
      if (resources.subscribers > result.initialResources.subscribers)
        throw new Error(
          `Cycle ${cycle} grew server subscribers: ${JSON.stringify(resources)}`,
        );
      result.cycleResults.push({
        cycle,
        recoveryMs: Date.now() - wokeAt,
        state,
        resources,
        asleepResources,
        gate: gate.snapshot(),
      });
      console.log(JSON.stringify({ type: "cycle-complete", cycle, resources }));
      await pause(1000);
    }
  } else if (fault === "wake-outage") {
    if (onDevice) await device("shell", "input", "keyevent", "KEYCODE_SLEEP");
    else await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    gate.setMode("refuse");
    await updateWhileDisconnected();
    await pause(8000);
    if (onDevice) {
      await device("shell", "input", "keyevent", "KEYCODE_WAKEUP");
      await device("shell", "wm", "dismiss-keyguard");
    } else await cdp.send("Page.setWebLifecycleState", { state: "active" });
    record({ type: "wake" });
    await pause(8000);
  } else if (fault === "outage") {
    gate.setMode("refuse");
    await updateWhileDisconnected();
    await pause(outageMs);
  } else if (fault === "silent") {
    gate.setMode("silent");
    await updateWhileDisconnected();
    await pause(outageMs);
  } else if (fault === "in-flight") {
    await navigate(`${prefix}/projects`);
    await pause(1000);
    await probe("api-delay?ms=5000");
    await navigate(target);
    await until(async () => {
      const pending = await probe("status", "GET");
      return (
        (attachment
          ? pending.delayedValidationRequests
          : pending.delayedRequests) > 0
      );
    });
    gate.disconnect();
    await probe("api-delay?ms=0");
    await pause(1000);
  } else if (fault === "upload-interruption") {
    // Diagnostic-only: an explicit upload failure is expected, so the ordinary
    // no-error page acceptance is deliberately not weakened for this experiment.
    const file = {
      name: "lifecycle-interrupted.bin",
      mimeType: "application/octet-stream",
      buffer: randomBytes(4 * 1024 * 1024),
    };
    const before = gate.snapshot();
    gate.refuseAfterClientBytes(256 * 1024);
    await page.locator('input[type="file"]').setInputFiles(file);
    await until(() => gate.snapshot().cuts > before.cuts);
    await until(async () =>
      (await page.locator("body").innerText()).includes(
        `Failed to upload ${file.name}`,
      ),
    );
    result.uploadFailure = await snapshot("upload-failed");
    if (
      result.uploadFailure.draft !== result.expectedDraft ||
      result.uploadFailure.attachmentNames.includes(file.name)
    )
      throw new Error(
        "Interrupted upload changed the draft or appeared complete",
      );
    await capture("upload-failed");
    result.uploadCut = gate.snapshot();
    await updateWhileDisconnected();
    gate.setMode("pass");
    await until(async () => {
      const state = await snapshot("upload-recovery");
      return !state.connection && state.titleUpdated && state.needle;
    }, 180_000);
    result.uploadBeforeReselection = await snapshot(
      "upload-before-reselection",
    );
    if (result.uploadBeforeReselection.attachmentNames.includes(file.name))
      throw new Error("Interrupted upload was replayed without user selection");
    // A user reselects the original file; neither transport may replay a write.
    record({ type: "upload-explicit-reselection" });
    await page.locator('input[type="file"]').setInputFiles(file);
    await page
      .getByRole("button", { name: `Remove ${file.name}`, exact: true })
      .waitFor();
    await until(
      async () =>
        !(await page.locator(".attachment-list").innerText()).includes("%"),
    );
    result.expectedAttachment = file.name;
    result.uploadReselection = await snapshot("upload-reselected");
    result.uploadReselection.chipCount = await page
      .getByRole("button", { name: `Remove ${file.name}`, exact: true })
      .count();
    if (
      result.uploadReselection.chipCount !== 1 ||
      result.uploadReselection.draft !== result.expectedDraft
    )
      throw new Error(
        "Upload reselection duplicated its chip or changed the draft",
      );
    await capture("upload-reselected");
  } else if (fault === "disconnect") gate.disconnect();
  await updateWhileDisconnected();
  await snapshot("interrupted");
  await capture("interrupted");
  gate.setMode("pass");
  result.restoredAt = Date.now();
  record({ type: "network-restored" });
  if (activity === "typing") {
    record({
      type: "recovery-signal",
      signal: "sequential typing through browser input",
    });
    await page
      .locator("textarea[data-composer-input]")
      .pressSequentially(" while recovering", { delay: 40 });
  }
  // Deliberately no click, focus, navigation or synthetic online signal here.
  // This measures autonomous recovery separately from activity-driven recovery.
  const deadline = Date.now() + observationMs;
  let captured = false;
  let healthySince;
  while (Date.now() < deadline) {
    const state = await snapshot("observe");
    if (
      !state.connection &&
      !state.login &&
      !state.errors &&
      state.titleUpdated &&
      (surface !== "session" || state.needle)
    ) {
      result.firstHealthyAt ??= Date.now();
      healthySince ??= Date.now();
      if (verify && Date.now() - healthySince >= steadyMs) break;
    } else healthySince = undefined;
    if (!captured && Date.now() - result.restoredAt >= 30_000) {
      await capture("after-30s");
      captured = true;
    }
    await pause(1000);
  }
  result.final = await snapshot("final");
  await capture("final");
  // Separate explicit-demand experiment only after the passive window closes.
  if (
    result.final.connection ||
    (surface === "session" && !result.final.needle)
  ) {
    record({ type: "recovery-signal", signal: "real keyboard activity" });
    await page.keyboard.press("Shift");
    await pause(8000);
    result.afterActivity = await snapshot("after-activity");
    await capture("after-activity");
  }
  result.gate = gate.snapshot();
  record({
    type: "sidebar-inspection",
    note: "Explicit interaction after passive recovery measurements",
  });
  const sidebarButton = page.getByRole("button", {
    name: "Open sidebar",
    exact: true,
  });
  if (await sidebarButton.count()) await sidebarButton.click();
  await pause(1000);
  result.sidebar = await snapshot("sidebar-open");
  await capture("sidebar");
  result.observer = await page.evaluate(() => ({
    rows: window.__lifecycleStudy.rows,
    keys: window.__lifecycleStudy.keys,
  }));
  result.observer.rows.unshift(...previousObservers.rows);
  result.observer.keys.unshift(...previousObservers.keys);

  result.completed = true;
} catch (error) {
  result.completed = false;
  result.error = String(error.stack ?? error);
  await capture("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  gate?.setMode("pass");
  if (onDevice) {
    await device("shell", "dumpsys", "deviceidle", "unforce").catch(() => {});
    await device("shell", "dumpsys", "battery", "reset").catch(() => {});
    await device("shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(
      () => {},
    );
    await device("shell", "wm", "dismiss-keyguard").catch(() => {});
  }
  if (client === "android" && instrument)
    await cleanup("Android instrumentation", async () => {
      await device("shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(
        () => {},
      );
      await device("shell", "wm", "dismiss-keyguard").catch(() => {});
      await device("shell", "touch", `${deviceDir}/stop`).catch(() => {});
      const stopDeadline = new AbortController();
      try {
        await Promise.race([
          instrumentDone,
          pause(15_000, undefined, { signal: stopDeadline.signal }),
        ]);
      } finally {
        // A completed instrument run must not leave every matrix child alive
        // for the remainder of its cleanup deadline.
        stopDeadline.abort();
      }
      if (instrument.exitCode === null) {
        instrument.kill();
        await device(
          "shell",
          "am",
          "force-stop",
          "com.yepanywhere.mobile",
        ).catch(() => {});
      }
      await writeFile(join(out, "instrumentation.log"), instrumentLog);
      result.instrumentationPassed = /OK \(1 test\)/.test(instrumentLog);
      if (processDeath || notification) {
        const cleanupLog = (
          await device(
            "shell",
            "am",
            "instrument",
            "-w",
            "-r",
            "-e",
            "class",
            "com.yepanywhere.mobile.web.YaNativeReconnectInstrumentedTest#cleanupHostDrivenLifecycleStudy",
            "-e",
            "yaLifecycleStudy",
            "true",
            "com.yepanywhere.mobile.test/androidx.test.runner.AndroidJUnitRunner",
          )
        ).stdout;
        await writeFile(join(out, "cleanup-instrumentation.log"), cleanupLog);
        result.instrumentationPassed &&= /OK \(1 test\)/.test(cleanupLog);
      }
      if (!result.instrumentationPassed) {
        result.completed = false;
        result.error ??=
          "Android instrumentation did not finish successfully; see instrumentation.log";
        process.exitCode = 1;
      }
      await device(
        "pull",
        `${deviceDir}/phases.json`,
        join(out, "native-phases.json"),
      ).catch(() => {});
      const nativeErrors = (
        await device("logcat", "-d", "-s", "YaSyntheticResponse:W").catch(
          () => ({
            stdout: "unavailable",
          }),
        )
      ).stdout;
      await writeFile(join(out, "native-errors.log"), nativeErrors);
      result.nativeDiagnosticsAvailable = nativeErrors !== "unavailable";
      result.nativeSyntheticErrors = nativeErrors
        .split("\n")
        .filter((line) => line.includes("Synthetic 503"));
    });
  if (notificationPermission === false)
    await cleanup("notification permission", () =>
      device(
        "shell",
        "pm",
        "revoke",
        "com.yepanywhere.mobile",
        "android.permission.POST_NOTIFICATIONS",
      ),
    );
  await chromeContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const device of androidDevices) await device.close().catch(() => {});
  for (const port of forwards)
    await device("forward", "--remove", `tcp:${port}`).catch(() => {});
  for (const port of reverses)
    await device("reverse", "--remove", `tcp:${port}`).catch(() => {});
  await cleanup("network gate", async () => gate?.close());
  await cleanup("fixture", async () => fixture?.stop());
  await cleanup("relay", async () => relay?.close());
  if (staticServer) {
    staticServer.httpServer.closeAllConnections();
    await cleanup(
      "static server",
      () =>
        new Promise((done, fail) =>
          staticServer.httpServer.close((error) =>
            error ? fail(error) : done(),
          ),
        ),
    );
  }
  result.pageErrors = timeline.filter((event) => event.type === "page-error");
  result.acceptance = assessPageRecovery(result);
  if (verify && !result.acceptance.passed) process.exitCode = 1;
  result.hostEnd = host();
  result.finished = Date.now();
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(
    join(out, "timeline.json"),
    JSON.stringify(timeline, null, 2),
  );
  if (screenshots.length)
    emitCapturePreview(
      await writeCapturePreview({
        input: `Source lifecycle study: ${runId}`,
        out: join(out, "preview"),
        screenshots,
      }),
    );
  console.log(
    JSON.stringify(
      {
        out,
        acceptance: result.acceptance,
        completed: result.completed,
        error: result.error,
        recoveryMs: result.firstHealthyAt
          ? result.firstHealthyAt - result.restoredAt
          : null,
        final: result.final,
      },
      null,
      2,
    ),
  );
}
