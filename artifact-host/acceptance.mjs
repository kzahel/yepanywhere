import {
  createLargeMediaFixture,
  qualifyLargeMedia,
} from "./media-fixture.mjs";
import { createRelayServer } from "../packages/relay/src/server.ts";
import { createNetworkGate } from "../packages/client/e2e/lifecycle-study/network-gate.mjs";
import { qualifyNativeFaults } from "./native-faults.mjs";
import {
  observePressureRelay,
  qualifyNativePressure,
} from "./native-pressure.mjs";
import { beginTypingMetrics, finishTypingMetrics } from "./typing-metrics.mjs";
// Actual YA UI + real encrypted relay + deployed HTTPS content host.
// Run: pnpm exec tsx --conditions source artifact-host/acceptance.mjs --public-relay
import { spawn, execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  truncateSync,
  appendFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { hostname, tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { InstallService } from "../packages/server/src/services/InstallService.ts";
import { files } from "../research/content-worker-localhost-spike/fixture.mjs";
import {
  writeCapturePreview,
  emitCapturePreview,
} from "../packages/client/scripts/artifact-capture.ts";
const require = createRequire(
  new URL("../packages/client/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const physical =
  process.argv.includes("--physical-chrome") ||
  process.argv.includes("--physical-native");
const native =
  process.argv.includes("--native") ||
  process.argv.includes("--native-fallback") ||
  process.argv.includes("--physical-native");
const android = process.argv.includes("--android") || native || physical;
const nativeManaged = native && process.argv.includes("--native-managed");
const largeMedia = process.argv.includes("--large-media");
const nativeResume = process.argv.includes("--native-resume");
const nativeDocumentReload = process.argv.includes("--native-document-reload");
const nativeTabCycle = process.argv.includes("--native-tab-cycle");
const nativeProcessRestart = process.argv.includes("--native-process-restart");
if (nativeProcessRestart && !nativeManaged)
  throw new Error("Process restart qualification requires the managed pane");
if (nativeTabCycle && !nativeManaged)
  throw new Error("Native tab qualification requires the managed pane");
if (nativeDocumentReload && !nativeManaged)
  throw new Error(
    "Document reload qualification requires the managed native pane",
  );
if (nativeResume && !nativeManaged)
  throw new Error("Native resume requires the managed native pane");
const localFaults = process.argv.includes("--local-faults");
const traceNativeSetup = process.argv.includes("--trace-native-setup");
if (traceNativeSetup && !localFaults)
  throw new Error("Native setup tracing requires the owned fault relay");
const slowLinkProbe = process.argv.includes("--slow-link-probe");
if (slowLinkProbe && !localFaults)
  throw new Error("Slow-link qualification requires the owned fault relay");
const faultsOnly = process.argv.includes("--faults-only");
if (faultsOnly && !localFaults)
  throw new Error("--faults-only requires the owned local fault relay");
if (
  localFaults &&
  (!nativeManaged || !largeMedia || process.argv.includes("--public-relay"))
)
  throw new Error(
    "Local faults require native managed large-media mode and an owned local relay",
  );
let localRelay, networkGate;
let pressureRelayTraffic;
const reversePorts = [];
const faultTimeline = [];
const recordFault = (event) => {
  faultTimeline.push({ at: Date.now(), ...event });
};

if (largeMedia && !nativeManaged)
  throw new Error(
    "Large-media qualification currently requires the updated native shell",
  );
const phoneAdapter =
  process.env.YA_ANDROID_DEVICE_ADAPTER ??
  resolve(
    import.meta.dirname,
    "../../machine-control/platforms/android/bin/android-device",
  );
if (physical) {
  const doctor = JSON.parse(
    execFileSync(phoneAdapter, ["doctor", "--json"], { encoding: "utf8" }),
  );
  if (!doctor.ready)
    throw new Error("Physical Android handheld doctor is not ready");
}
const serial = physical
  ? execFileSync(phoneAdapter, ["serial"], { encoding: "utf8" }).trim()
  : process.env.ANDROID_SERIAL;
if (
  android &&
  (!serial ||
    (physical
      ? serial.startsWith("emulator-")
      : !serial.startsWith("emulator-")))
)
  throw new Error(
    "Select a physical handheld through Machine Control, or an explicit ANDROID_SERIAL emulator",
  );
const appPackage = "com.yepanywhere.mobile.artifacttest";
const appActivity = `${appPackage}/com.yepanywhere.mobile.MainActivity`;
const forwards = [];
let installedPhonePackage = false;
const hierarchyFile = `/sdcard/ya-artifact-${randomUUID()}.xml`;
let androidBrowser;
let nativeDevtoolsEndpoint;
let androidPreferences;
const chromePreferences =
  "/data/data/com.android.chrome/app_chrome/Default/Preferences";
const adb = (...args) => {
  try {
    return execFileSync("adb", ["-s", serial, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
  } catch (error) {
    // Device selectors are private inventory, including in failed commands.
    throw new Error(String(error).replaceAll(serial, "<selected-device>"));
  }
};
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".artifacts/managed-artifact", String(Date.now()));
const temp = mkdtempSync(join(tmpdir(), "ya-managed-artifact-"));
const dist = join(root, ".artifacts/managed-artifact-client");
mkdirSync(output, { recursive: true });
const children = [];
let context;
let page;
const screenshots = [];
const evidence = {
  browser: "",
  publicContentTLS: !native,
  parent: "https://latest.yepanywhere.com",
  temporaryParentBuild: true,
  nativeManaged,
  qualificationScope: slowLinkProbe
    ? "eight retained native readers over a slow downlink; full transfer/media/fault matrix omitted"
    : faultsOnly
      ? "native faults and typing; full media matrix omitted"
      : "complete selected matrix",
  thirdPartyCookiesBlocked: native ? null : !android,
  serverBuild: process.env.YA_ARTIFACT_TEST_SERVER_ROOT
    ? "baseline checkout"
    : "feature checkout",
  platform: physical
    ? native
      ? "android-phone-bundled-app"
      : "android-phone-chrome"
    : native
      ? "android-emulator-bundled-app"
      : android
        ? "android-emulator-chrome"
        : "desktop-chromium",
  checks: [],
  errors: [],
  temp,
};
const log = (text) => console.error(`[managed artifact] ${text}`);
function observePage(target) {
  target.on("pageerror", (error) => evidence.errors.push(error.message));
  target.on("console", (message) => {
    if (message.type() === "error") {
      if (
        largeMedia &&
        message.text() ===
          "Failed to load resource: the server responded with a status of 416 ()" &&
        /\/media\/movie\.mp4\?invalid-range=1$/.test(message.location().url)
      ) {
        // This single intentional refusal is asserted byte-for-byte in the
        // range probe. Every other failed resource remains an error.
        evidence.expectedRangeRefusals =
          (evidence.expectedRangeRefusals ?? 0) + 1;
        return;
      }
      if (
        nativeManaged &&
        largeMedia &&
        (evidence.browser.startsWith("124.") ||
          evidence.browser.startsWith("154.")) &&
        message.text() ===
          "Permissions policy violation: accelerometer is not allowed in this document."
      ) {
        // Chrome's native rotate-to-fullscreen delegate registers an
        // orientation listener when video controls attach. Keep sensors denied;
        // preserve this exact upstream diagnostic separately from app errors.
        // chromium/src@124.0.6367.219: media_controls_rotate_to_fullscreen_delegate.cc:64
        // The identical refusal is measured on phone WebView 154.0.8037.106.
        evidence.expectedBrowserPolicyRefusals ??= [];
        evidence.expectedBrowserPolicyRefusals.push(message.text());
        return;
      }
      evidence.errors.push(message.text());
      log(message.text().slice(0, 500));
    }
  });
}
async function recordNativeSetup(stage) {
  if (!traceNativeSetup) return;
  const response = await localRelay.app.request("/status");
  const { mux } = await response.json();
  evidence.nativeSetup ??= [];
  evidence.nativeSetup.push({ stage, mux, traffic: pressureRelayTraffic() });
}
async function until(label, fn, limit = 45000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function start(label, pkg, env) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      require.resolve("tsx/esm"),
      "--conditions",
      "source",
      "src/index.ts",
    ],
    {
      cwd: join(
        process.env.YA_ARTIFACT_TEST_SERVER_ROOT ?? root,
        "packages",
        pkg,
      ),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) =>
      appendFileSync(join(output, `${label}.log`), data),
    );
  return child;
}
try {
  if (!process.argv.includes("--skip-build")) {
    log("Building the actual hosted client");
    execFileSync(
      process.execPath,
      [
        join(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
        "build",
        "--config",
        "vite.config.remote.ts",
        "--base",
        "/",
        "--outDir",
        dist,
      ],
      {
        cwd: join(root, "packages/client"),
        env: {
          ...process.env,
          VITE_DISABLE_ONBOARDING: "true",
          VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      },
    );
  }
  const home = join(temp, "home");
  const data = join(temp, "ya");
  const claude = join(temp, "claude/projects");
  const project = join(temp, "bundle");
  for (const directory of [home, data, claude, project])
    mkdirSync(directory, { recursive: true });
  for (const [name, [, value]] of Object.entries(files)) {
    const nameInBundle = name.replace(/^report\//, "");
    const target = join(project, nameInBundle);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof value === "string"
        ? value.replaceAll("../assets/", "assets/")
        : value,
    );
  }
  writeFileSync(
    join(project, "fragment.html"),
    '<h1>Interactive fragment</h1><button id="widget" onclick="const n=(openai.widgetState?.count??0)+1;openai.setWidgetState({count:n});this.textContent=String(n)">Remember count</button><button id="followup" onclick="openai.sendFollowUpMessage({prompt:\'Explain this chart\'})">Ask about this chart</button><script>window.fragmentTheme=openai.theme</script>',
  );
  writeFileSync(join(project, "precise.json"), '{ "n": 9007199254740993 }\n');
  writeFileSync(join(project, "invalid.json"), "{");
  writeFileSync(join(project, "empty.css"), "");
  writeFileSync(join(project, "empty.js"), "");
  writeFileSync(join(project, "binary.wasm"), Buffer.from([255, 0, 128, 42]));
  writeFileSync(join(project, "range.bin"), "");
  truncateSync(join(project, "range.bin"), 64 * 1024 * 1024);
  const mediaExpected = largeMedia
    ? await createLargeMediaFixture(project)
    : undefined;
  if (mediaExpected) evidence.mediaFixture = mediaExpected;
  const install = new InstallService({ dataDir: data });
  await install.initialize();
  await install.recordSuccessfulProviders(["claude"]);
  writeFileSync(
    join(data, "server-settings.json"),
    JSON.stringify({ version: 1, settings: { codexUpdatePolicy: "off" } }),
  );
  const sessionDir = join(claude, hostname(), project.replaceAll("/", "-"));
  mkdirSync(sessionDir, { recursive: true });
  const transcript = join(sessionDir, "artifact-demo.jsonl");
  const row = (i, role, text) => ({
    type: role,
    uuid: `demo-${i}`,
    sessionId: "artifact-demo",
    cwd: project,
    timestamp: new Date(Date.now() - 60000 + i * 10).toISOString(),
    message: {
      role,
      content: role === "assistant" ? [{ type: "text", text }] : text,
    },
  });
  const rows = [row(0, "user", "Inspect a generated local artifact")];
  for (let i = 1; i <= 120; i++)
    rows.push(
      row(
        i,
        i % 2 ? "assistant" : "user",
        `Report review context ${i}: HTML and assets stay on the YA server.`,
      ),
    );
  rows.push(
    row(
      121,
      "assistant",
      `[Open local artifact](${join(project, "index.html")})\n\n[Open fragment](${join(project, "fragment.html")})`,
    ),
  );
  writeFileSync(
    transcript,
    rows.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  if (!localFaults && !process.argv.includes("--public-relay"))
    throw new Error(
      "Pass --public-relay to authorize a disposable identity on the public TLS relay",
    );
  let relayUrl = "wss://relay.yepanywhere.com/ws";
  let serverRelayUrl = relayUrl;
  if (localFaults) {
    localRelay = await createRelayServer({
      port: 0,
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      disableTelemetry: true,
    });
    networkGate = await createNetworkGate(localRelay.port, recordFault);
    if (slowLinkProbe || traceNativeSetup)
      pressureRelayTraffic = observePressureRelay(localRelay);
    const devicePort = adb(
      "reverse",
      "tcp:0",
      `tcp:${networkGate.port}`,
    ).trim();
    if (!/^\d+$/.test(devicePort))
      throw new Error("ADB did not allocate an owned reverse port");
    reversePorts.push(devicePort);
    relayUrl = `ws://127.0.0.1:${devicePort}/ws`;
    serverRelayUrl = `ws://127.0.0.1:${localRelay.port}/ws`;
    evidence.faultTimeline = faultTimeline;
  }
  evidence.publicRelay = !localFaults;
  const username = `artifact-${randomUUID().slice(0, 8)}`;
  const password = randomUUID() + randomUUID();
  const env = {
    HOME: home,
    USERPROFILE: home,
    YEP_DATA_DIR: data,
    CLAUDE_SESSIONS_DIR: claude,
    CODEX_SESSIONS_DIR: join(temp, "codex"),
    GEMINI_SESSIONS_DIR: join(temp, "gemini"),
    YEP_PROVIDER_HOST_RUNTIME_DIR: join(temp, "runtime"),
    YEP_PROVIDER_HOST_ENABLED: "false",
    YEP_ARTIFACT_PORT: "0",
    YEP_ARTIFACT_LOCAL_ORIGIN: "",
    YEP_ARTIFACT_PUBLIC_ORIGIN: "",
    VITE_DISABLE_ONBOARDING: "true",
    VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
  };
  // Keep the owned relay's event loop live during CLI registration.
  try {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx/esm"),
        "--conditions",
        "source",
        "src/cli.ts",
        "--setup-remote-access",
        "--username",
        username,
        "--password",
        password,
        "--relay",
        serverRelayUrl,
      ],
      {
        cwd: join(root, "packages/server"),
        env: { ...process.env, ...env },
        timeout: 45000,
      },
    );
  } catch (error) {
    // execFile's error message includes argv, including the fixture password.
    writeFileSync(
      join(output, "setup.log"),
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
    throw new Error(
      "Fixture remote-access setup failed; see private setup.log",
    );
  }
  const serverFile = join(temp, "server.port");
  start("server", "server", {
    ...env,
    PORT: "0",
    PORT_FILE: serverFile,
    MAINTENANCE_PORT: "-1",
    AUTH_DISABLED: "true",
    HTTPS_SELF_SIGNED: "",
    NODE_ENV: "production",
    SERVE_FRONTEND: "false",
    LOG_LEVEL: "warn",
  });
  const serverPort = await until(
    "server port",
    () => existsSync(serverFile) && readFileSync(serverFile, "utf8").trim(),
  );
  const api = (path, init = {}) =>
    fetch(`http://127.0.0.1:${serverPort}/api${path}`, {
      ...init,
      headers: { "X-Yep-Anywhere": "true", ...init.headers },
    });
  await until("relay registration", async () =>
    ["waiting", "connected"].includes(
      (await (await api("/remote-access/relay/status")).json()).status,
    ),
  );
  const projectId = Buffer.from(project).toString("base64url");
  await until(
    "session discovery",
    async () => (await api(`/projects/${projectId}/sessions/artifact-demo`)).ok,
  );
  const version = await (await api("/version")).json();
  evidence.server = {
    artifactListener: version.artifactViewer?.available,
    capabilities: version.capabilityExtensions ?? version.capabilities,
  };
  const profile = join(temp, "chromium");
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default/Preferences"),
    JSON.stringify({
      profile: { cookie_controls_mode: 1, block_third_party_cookies: true },
      tracking_protection: { block_all_3pc_toggle_enabled: true },
    }),
  );
  if (android) {
    evidence.androidRelease = adb(
      "shell",
      "getprop",
      "ro.build.version.release",
    ).trim();
    evidence.androidApi = adb(
      "shell",
      "getprop",
      "ro.build.version.sdk",
    ).trim();
    evidence.webView = adb("shell", "dumpsys", "webviewupdate").match(
      /Current WebView package \(name, version\): (.*)/,
    )?.[1];
    if (native) {
      const apk = process.env.YA_ARTIFACT_TEST_APK;
      if (!apk)
        throw new Error(
          "Native acceptance requires an isolated YA_ARTIFACT_TEST_APK",
        );
      {
        const sdk =
          process.env.ANDROID_HOME ??
          dirname(
            dirname(
              execFileSync("which", ["adb"], { encoding: "utf8" }).trim(),
            ),
          );
        const version = readdirSync(join(sdk, "build-tools"))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1);
        const manifest = execFileSync(
          join(sdk, "build-tools", version, "aapt"),
          ["dump", "badging", apk],
          { encoding: "utf8" },
        );
        if (!manifest.startsWith(`package: name='${appPackage}'`))
          throw new Error(
            "Refusing to install a physical-phone APK without the isolated test application ID",
          );
      }
      if (
        adb("shell", "pm", "list", "packages", "--user", "current", appPackage)
          .split(/\r?\n/)
          .includes(`package:${appPackage}`)
      )
        throw new Error(
          "Refusing to replace an existing isolated phone test package",
        );
      evidence.apkSHA256 = createHash("sha256")
        .update(readFileSync(apk))
        .digest("hex");
      adb("install", apk);
      installedPhonePackage = true;
      const link = `https://yepanywhere.com/open?${new URLSearchParams({ u: username, p: password, r: relayUrl })}`;
      execFileSync("adb", ["-s", serial, "shell"], {
        input: `am start -W -n ${appActivity} -a android.intent.action.VIEW -d '${link}'\n`,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 30000,
      });
      const button = await until("native Connect button", () => {
        adb("shell", "uiautomator", "dump", hierarchyFile);
        return adb("shell", "cat", hierarchyFile).match(
          /text="Connect"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
        );
      });
      await recordNativeSetup("before-pairing");
      adb(
        "shell",
        "input",
        "tap",
        String(Math.floor((Number(button[1]) + Number(button[3])) / 2)),
        String(Math.floor((Number(button[2]) + Number(button[4])) / 2)),
      );
      await until("native registration persisted on real server", async () => {
        const result = await (await api("/security/clients")).json();
        return result.clients?.some(
          (client) => client.reportedLabel === username,
        );
      });
      evidence.nativeRegistrationPersisted = true;
      if (process.argv.includes("--resume-after-pair")) {
        evidence.setupWorkaround =
          "force-stop and cold launcher resume after successful registration; fresh pairing UI remained busy in separate unmodified runs";
        adb("shell", "am", "force-stop", appPackage);
        adb(
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          appActivity,
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
        );
      } else {
        const openButton = await until(
          "native pairing complete and open action enabled",
          () => {
            const pid = adb("shell", "pidof", appPackage).trim();
            if (
              adb("shell", "cat", "/proc/net/unix").includes(
                `@webview_devtools_remote_${pid}`,
              )
            )
              return { alreadyOpen: true };
            adb("shell", "uiautomator", "dump", hierarchyFile);
            const xml = adb("shell", "cat", hierarchyFile);
            const stack = [];
            for (const [tag] of xml.matchAll(/<\/?node\b[^>]*>/g)) {
              if (tag.startsWith("</")) {
                stack.pop();
                continue;
              }
              const enabled =
                !tag.includes('enabled="false"') && stack.every(Boolean);
              if (enabled && /text="(?:Not now|Open full app)"/.test(tag))
                return tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
              if (!tag.endsWith("/>")) stack.push(enabled);
            }
          },
        );
        if (Array.isArray(openButton))
          adb(
            "shell",
            "input",
            "tap",
            String(
              Math.floor((Number(openButton[1]) + Number(openButton[3])) / 2),
            ),
            String(
              Math.floor((Number(openButton[2]) + Number(openButton[4])) / 2),
            ),
          );
        evidence.nativePairingFlow = "fresh UI";
      }
      const pid = await until("native process", () =>
        adb("shell", "pidof", appPackage).trim(),
      );
      const port = adb(
        "forward",
        "tcp:0",
        `localabstract:webview_devtools_remote_${pid}`,
      ).trim();
      forwards.push(port);
      await until(
        "native WebView DevTools",
        async () =>
          (
            await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok,
      );
      nativeDevtoolsEndpoint = `http://127.0.0.1:${port}`;
      androidBrowser = await chromium.connectOverCDP(nativeDevtoolsEndpoint, {
        noDefaults: true,
      });
      context = androidBrowser.contexts()[0];
      evidence.browser = androidBrowser.version();
      evidence.parentBuildDelivery = "bundled debug APK";
      evidence.parent = "https://appassets.androidplatform.net";
    } else if (physical) {
      // A private browser context isolates all YA state from the phone's tabs.
      const port = adb(
        "forward",
        "tcp:0",
        "localabstract:chrome_devtools_remote",
      ).trim();
      forwards.push(port);
      androidBrowser = await chromium.connectOverCDP(
        `http://127.0.0.1:${port}`,
        { noDefaults: true },
      );
      context = await androidBrowser.newContext({ viewport: null });
      evidence.browser = androidBrowser.version();
      evidence.isolatedBrowserContext = true;
    } else {
      adb("shell", "am", "force-stop", "com.android.chrome");
      androidPreferences = adb("shell", "su", "0", "cat", chromePreferences);
      const preferences = JSON.parse(androidPreferences);
      preferences.profile = {
        ...preferences.profile,
        cookie_controls_mode: 1,
        block_third_party_cookies: true,
      };
      execFileSync(
        "adb",
        ["-s", serial, "shell", "su", "0", "tee", chromePreferences],
        {
          input: JSON.stringify(preferences),
          stdio: ["pipe", "ignore", "pipe"],
          timeout: 30000,
        },
      );
      adb(
        "shell",
        "echo '_ --disable-fre --no-default-browser-check --remote-debugging-socket-name=ya_artifact_devtools_remote' > /data/local/tmp/chrome-command-line",
      );
      adb(
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
      const port = adb(
        "forward",
        "tcp:0",
        "localabstract:ya_artifact_devtools_remote",
      ).trim();
      forwards.push(port);
      await until(
        "Android Chrome DevTools",
        async () =>
          (
            await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok,
      );
      androidBrowser = await chromium.connectOverCDP(
        `http://127.0.0.1:${port}`,
      );
      context = androidBrowser.contexts()[0];
      evidence.browser = androidBrowser.version();
      adb("shell", "rm", "-f", "/data/local/tmp/chrome-command-line");
    }
  } else {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      chromiumSandbox: true,
      headless: !process.argv.includes("--headed"),
      viewport: { width: 1000, height: 600 },
    });
  }
  evidence.browser ||= context.browser()?.version() ?? "persistent Chromium";
  if (!native)
    await context.route("https://latest.yepanywhere.com/**", async (route) => {
      const url = new URL(route.request().url());
      let file = join(dist, decodeURIComponent(url.pathname));
      if (!file.startsWith(dist) || !existsSync(file) || url.pathname === "/")
        file = join(dist, "remote.html");
      const mime = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : file.endsWith(".json")
                ? "application/json"
                : "application/octet-stream";
      await route.fulfill({
        status: 200,
        contentType: mime,
        body: readFileSync(file),
        headers: { "Origin-Agent-Cluster": "?1", "Cache-Control": "no-store" },
      });
    });
  page = native ? context.pages()[0] : await context.newPage();
  if (android && !native) {
    await context.route(
      "https://third-party-cookie-probe.invalid/**",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: {
            "Set-Cookie": "ya_probe=network; Secure; SameSite=None; Path=/",
          },
          body: '<script>document.cookie="ya_js_probe=script; Secure; SameSite=None; Path=/";if(parent!==window)parent.postMessage({probe:"third-party-cookies",cookie:document.cookie},"https://latest.yepanywhere.com")</script>',
        }),
    );
    await page.goto("https://third-party-cookie-probe.invalid/check");
    expect(await page.evaluate(() => document.cookie)).toContain(
      "ya_probe=network",
    );
    expect(await page.evaluate(() => document.cookie)).toContain(
      "ya_js_probe=script",
    );
    evidence.firstPartyCookieProbe =
      "same network and script cookies accepted at top level";
    await page.goto("https://latest.yepanywhere.com");
    const cookie = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Cookie probe timed out")),
            15000,
          );
          addEventListener("message", (event) => {
            if (
              event.origin === "https://third-party-cookie-probe.invalid" &&
              event.data?.probe === "third-party-cookies"
            ) {
              clearTimeout(timer);
              resolve(event.data.cookie);
            }
          });
          const frame = document.createElement("iframe");
          frame.src = "https://third-party-cookie-probe.invalid/check";
          document.body.append(frame);
        }),
    );
    if (!physical) expect(cookie).toBe("");
    evidence.thirdPartyCookiesBlocked = cookie === "";
    evidence.thirdPartyCookieProbe =
      cookie === ""
        ? "network and script cookies refused in cross-site iframe"
        : "network and script cookies accessible in cross-site iframe";
  }
  observePage(page);
  const origin = evidence.parent;
  const base = native ? origin : `${origin}/-/relay/${username}`;
  log("Opening actual YA over the disposable encrypted relay");
  if (!native) {
    await page.goto(
      `${origin}/login/relay#u=${username}&p=${password}&r=${encodeURIComponent(relayUrl)}`,
    );
    await page.waitForURL("**/-/relay/**", { timeout: 60000 });
  } else {
    await expect(page.getByText("bundle", { exact: true }).first()).toBeVisible(
      { timeout: 45000 },
    );
    await recordNativeSetup("paired-home-ready");
  }
  await page.goto(`${base}/projects/${projectId}/sessions/artifact-demo`);
  const openArtifactLink = page.getByRole("link", {
    name: "Open local artifact",
    exact: true,
  });
  await expect(openArtifactLink).toBeVisible({ timeout: 45000 });
  await recordNativeSetup("after-explicit-document-navigation");
  await openArtifactLink.click();
  if (native && !nativeManaged) {
    const frameElement = page.locator("iframe[srcdoc]");
    await expect(frameElement).toHaveAttribute("sandbox", "allow-same-origin");
    const fallback = await until("native scriptless frame navigation", () =>
      page.frames().find((f) => f.url() === "about:srcdoc"),
    );
    await expect(
      fallback.getByRole("heading", { name: "HTML and its assets, unchanged" }),
    ).toBeVisible();
    await fallback.locator("#counter").click();
    await expect(fallback.locator("#count")).toHaveText("0");
    expect(
      await fallback.evaluate(() => window.classicLoaded ?? null),
    ).toBeNull();
    expect(
      page
        .frames()
        .some((f) => /artifact-[a-f0-9]{32}\.yepanywhere/.test(f.url())),
    ).toBe(false);
    evidence.checks.push({
      name: "native-scriptless-fallback",
      parentOrigin: new URL(page.url()).origin,
      sandbox: await frameElement.getAttribute("sandbox"),
      scriptsExecuted: false,
      managedFrame: false,
      imageWidth: await fallback
        .locator("#chart")
        .evaluate((img) => img.naturalWidth),
    });
    const path = join(output, "native-fallback.png");
    if (native)
      writeFileSync(
        path,
        execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"]),
      );
    else await page.screenshot({ path });
    screenshots.push({
      name: "native-app-fallback",
      ...(await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }))),
      path,
    });
    await page.locator('.file-viewer-action[aria-label="Back"]').click();
    await expect(page.locator("iframe[srcdoc]")).toHaveCount(0);
    evidence.checks.push({ name: "native-fallback-teardown", passed: true });
    const expectedRefusal = (message) =>
      /(?:Refused to load|Loading) (?:the stylesheet|the image).*violates (?:the following )?Content Security Policy/s.test(
        message,
      ) ||
      /Blocked script execution in 'about:srcdoc'.*sandboxed/s.test(message);
    evidence.expectedPolicyRefusals =
      evidence.errors.filter(expectedRefusal).length;
    expect(
      evidence.errors.filter((message) => !expectedRefusal(message)),
    ).toEqual([]);
  } else {
    const artifact = () =>
      page
        .frames()
        .find((frame) => /\/v\/[a-f0-9]{32}\/index.html/.test(frame.url()));
    await until("managed artifact document", artifact);
    const child = artifact();
    await expect(child.locator("#modules")).toContainText("JSON: 3 notes", {
      timeout: 30000,
    });
    await recordNativeSetup("first-artifact-ready");
    const resourceResults = await child.evaluate(async () => ({
      image: document.querySelector("#chart").naturalWidth,
      classic: window.classicLoaded,
      nativeTransport: typeof window.yaNativeTransport,
      nativeHost: typeof window.yaNative,
      modules: window.result,
      font: await document.fonts
        .load("12px ArtifactFont")
        .then((v) => v.length),
      css: getComputedStyle(document.querySelector(".tag")).letterSpacing,
      background: getComputedStyle(document.querySelector(".card"))
        .backgroundImage,
      worker: (await fetch("data.json")).headers.get("x-yep-artifact-worker"),
      parent: (() => {
        try {
          return parent.parent.document.title;
        } catch {
          return "denied";
        }
      })(),
    }));
    expect(resourceResults.image).toBe(640);
    expect(resourceResults.classic).toBe(true);
    expect(resourceResults.nativeTransport).toBe("undefined");
    expect(resourceResults.nativeHost).toBe("undefined");
    expect(resourceResults.worker).toBe("1");
    expect(resourceResults.parent).toBe("denied");
    expect(resourceResults.font).toBe(1);
    if (nativeManaged) {
      evidence.mainFrameNativeTransport = await page.evaluate(
        () => typeof window.yaNativeTransport?.postMessage,
      );
      expect(evidence.mainFrameNativeTransport).toBe("function");
      const originalUrl = child.url();
      const previousErrors = evidence.errors.length;
      await child.evaluate(() => {
        location.href = "https://appassets.androidplatform.net/";
      });
      await page.waitForTimeout(100);
      expect(child.url()).not.toContain("appassets.androidplatform.net");
      const refusals = evidence.errors.splice(previousErrors);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(
        /^(?:Framing|Refused to frame) 'https:\/\/appassets.androidplatform.net\/'.*violates.*frame-src 'self'/s,
      );
      evidence.expectedPrivilegedNavigationRefusals = refusals.length;
      // CSP denies the target and commits an error document; restore this
      // same admitted frame before continuing the functional measurements.
      await child.goto(originalUrl);
      await expect(child.locator("#modules")).toContainText("JSON: 3 notes");
      evidence.subframePrivilegedNavigationBlocked = true;
    }
    evidence.checks.push({ name: "native-resources", ...resourceResults });
    const exactResources = await child.evaluate(async () => {
      const dense = await Promise.all(
        Array.from({ length: 24 }, async (_, i) => {
          const response = await fetch(`precise.json?parallel=${i}`);
          return { status: response.status, text: await response.text() };
        }),
      );
      const binary = Array.from(
        new Uint8Array(await (await fetch("binary.wasm")).arrayBuffer()),
      );
      const invalid = await (await fetch("invalid.json")).text();
      const empty = await Promise.all(
        ["empty.css", "empty.js"].map(async (path) => {
          const response = await fetch(path);
          return {
            status: response.status,
            size: (await response.arrayBuffer()).byteLength,
          };
        }),
      );
      const ranges = [];
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`range.bin?part=${i}`, {
          headers: { Range: "bytes=0-3" },
        });
        ranges.push({
          status: response.status,
          range: response.headers.get("content-range"),
          accepts: response.headers.get("accept-ranges"),
          size: (await response.arrayBuffer()).byteLength,
        });
      }
      return { dense, binary, invalid, empty, ranges };
    });
    expect(exactResources.dense).toEqual(
      Array.from({ length: 24 }, () => ({
        status: 200,
        text: '{ "n": 9007199254740993 }\n',
      })),
    );
    expect(exactResources.binary).toEqual([255, 0, 128, 42]);
    expect(exactResources.invalid).toBe("{");
    expect(exactResources.empty).toEqual([
      { status: 200, size: 0 },
      { status: 200, size: 0 },
    ]);
    expect(exactResources.ranges).toEqual(
      Array.from({ length: 6 }, () => ({
        status: 206,
        range: "bytes 0-3/67108864",
        accepts: "bytes",
        size: 4,
      })),
    );
    evidence.checks.push({
      name: "dense-byte-exact-and-ranges",
      ...exactResources,
    });
    await child.locator("#counter").click();
    await expect(child.locator("#count")).toHaveText("1");
    for (const viewport of android
      ? [
          await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })),
        ]
      : [
          { width: 1000, height: 600 },
          { width: 375, height: 812 },
        ]) {
      if (!android) await page.setViewportSize(viewport);
      await child.evaluate(() => scrollTo(0, 0));
      const path = join(output, `viewer-${viewport.width}.png`);
      if (native)
        writeFileSync(
          path,
          execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"]),
        );
      else await page.screenshot({ path });
      screenshots.push({
        name: `managed-viewer-${viewport.width}`,
        ...viewport,
        path,
      });
    }
    if (!android) await page.setViewportSize({ width: 1000, height: 600 });
    await child.locator("#next").click();
    const linked = await until("linked document", () =>
      page.frames().find((f) => /\/v\/.+\/page2.html/.test(f.url())),
    );
    await expect(
      linked.getByRole("heading", { name: "Linked page", exact: true }),
    ).toBeVisible();
    await linked.getByRole("link", { name: "Back to report" }).click();
    await until("return to document", artifact);
    await expect(artifact().locator("#modules")).toContainText("JSON: 3 notes");
    const reloading = artifact().waitForNavigation({ waitUntil: "load" });
    await artifact().evaluate(() => location.reload());
    await reloading;
    await expect(artifact().locator("#modules")).toContainText(
      "JSON: 3 notes",
      {
        timeout: 30000,
      },
    );
    await until(
      "reload",
      async () =>
        await artifact()
          ?.evaluate(() => window.result?.data?.notes === 3)
          .catch(() => false),
    );
    evidence.checks.push({ name: "navigation-and-reload", passed: true });
    let cdp;
    let versions = [];
    const registrations = new Map();
    const bindWorkerEvents = async () => {
      cdp = await context.newCDPSession(page);
      versions = [];
      registrations.clear();
      cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
        for (const registration of event.registrations)
          registrations.set(registration.registrationId, registration);
        evidence.workerRegistrations = [...registrations.values()];
      });
      cdp.on("ServiceWorker.workerVersionUpdated", (event) => {
        versions = event.versions;
      });
      await cdp.send("ServiceWorker.enable");
    };
    await bindWorkerEvents();
    const versionToStop = await until("worker target", () =>
      versions.find(
        (v) =>
          v.scriptURL.startsWith(new URL(artifact().url()).origin) &&
          v.runningStatus === "running",
      ),
    );
    await cdp.send("ServiceWorker.stopWorker", {
      versionId: versionToStop.versionId,
    });
    const restarted = await artifact().evaluate(async () => {
      const r = await fetch("data.json?restart=1");
      return {
        status: r.status,
        worker: r.headers.get("x-yep-artifact-worker"),
        data: await r.json(),
      };
    });
    expect(restarted.worker).toBe("1");
    evidence.checks.push({ name: "worker-restart", ...restarted });
    const note = artifact().locator("#note");
    const phrase = "A local image with live updates.";
    let typed = "";
    const latencies = [];
    await note.click();
    await beginTypingMetrics(note);
    for (const character of phrase) {
      const start = Date.now();
      await page.keyboard.type(character);
      typed += character;
      await expect(note).toHaveValue(typed, { timeout: 100 });
      latencies.push(Date.now() - start);
    }
    const artifactTyping = await finishTypingMetrics(note, phrase, latencies);
    evidence.checks.push({
      name: "artifact-input-paint-clocks",
      ...artifactTyping,
    });
    // Android CDP command RTT includes control-plane delay after paint. The
    // trusted event/input/paint recorder above owns its 100 ms UI gate.
    if (!android) expect(Math.max(...latencies)).toBeLessThanOrEqual(100);
    evidence.checks.push({
      name: "artifact-sequential-typing",
      characters: phrase.length,
      maxMs: Math.max(...latencies),
    });
    const cancelled = await artifact().evaluate(async () => {
      const response = await fetch("slow.bin");
      const reader = response.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      return {
        status: response.status,
        firstBytes: first.value.byteLength,
        nextStatus: (await fetch("data.json?afterCancel=1")).status,
      };
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.firstBytes).toBeLessThan(4 * 1024 * 1024);
    expect(cancelled.nextStatus).toBe(200);
    evidence.checks.push({
      name: "stream-cancel",
      ...cancelled,
    });

    await artifact().locator("#modules").click();
    await page.keyboard.press("Control+f");
    const findBox = page.getByRole("searchbox", { name: "Find in this view" });
    await expect(findBox).toBeFocused();
    await page.keyboard.type("notes");
    await expect(
      page.getByRole("search").getByText("1/1", { exact: true }),
    ).toBeVisible();
    expect(
      await artifact().evaluate(() => CSS.highlights.get("yep-find")?.size),
    ).toBe(1);
    await page.keyboard.press("Escape");
    evidence.checks.push({ name: "managed-frame-find", passed: true });

    const composer = page
      .locator("textarea.message-input, textarea[placeholder]")
      .first();
    await page.locator('.file-viewer-action[aria-label="Back"]').click();
    await page
      .getByRole("link", { name: "Open fragment", exact: true })
      .click();
    const fragment = () =>
      page
        .frames()
        .find((f) => /\/v\/[a-f0-9]{32}\/fragment.html/.test(f.url()));
    await until("fragment", fragment);
    await fragment().locator("#widget").click();
    await expect(fragment().locator("#widget")).toHaveText("1");
    const fragmentReloading = fragment().waitForNavigation({
      waitUntil: "load",
    });
    await fragment().evaluate(() => location.reload());
    await fragmentReloading;
    await until(
      "widget state after inner reload",
      async () =>
        (await fragment()
          ?.evaluate(() => window.openai?.widgetState?.count)
          .catch(() => null)) === 1,
    );
    await fragment().locator("#widget").click();
    await expect(fragment().locator("#widget")).toHaveText("2");
    await fragment().locator("#followup").click();
    await expect(composer).toHaveValue(/Explain this chart/);
    expect(
      readFileSync(transcript, "utf8").includes("Explain this chart"),
    ).toBe(false);
    evidence.checks.push({
      name: "fragment-state-theme-followup",
      count: await fragment().evaluate(() => openai.widgetState.count),
      theme: await fragment().evaluate(() => window.fragmentTheme),
      submitted: false,
    });
    await page.locator('.file-viewer-action[aria-label="Back"]').click();
    await page
      .getByRole("link", { name: "Open local artifact", exact: true })
      .click();
    await until("reopened report", artifact);
    await expect(artifact().locator("#modules")).toContainText("JSON: 3 notes");
    if (slowLinkProbe) {
      log(
        "Checking eight retained native bodies over a 128 KiB/s TCP downlink",
      );
      const result = await qualifyNativePressure({
        artifact,
        gate: networkGate,
        relayTraffic: pressureRelayTraffic,
        relayStatus: async () => {
          const response = await localRelay.app.request("/status");
          return (await response.json()).mux;
        },
        sampleMemory: async () => {
          const { stdout } = await execFileAsync(
            "adb",
            [
              "-s",
              serial,
              "shell",
              "dumpsys",
              "meminfo",
              "com.yepanywhere.mobile.artifacttest",
            ],
            { encoding: "utf8" },
          );
          const match = stdout.match(/TOTAL PSS:\s*(\d+)/);
          if (!match) throw new Error("Main application PSS was unavailable");
          return { mainProcessPssKiB: Number(match[1]) };
        },
      });
      const pressureEvidence = { name: "native-slow-link-pressure", ...result };
      evidence.checks.push(pressureEvidence);
      await until("fresh artifact read after pressure cancellation", () =>
        artifact().evaluate(async () => {
          try {
            const response = await fetch("data.json?after-pressure=1", {
              signal: AbortSignal.timeout(5000),
            });
            return response.ok && (await response.json()).notes === 3;
          } catch {
            return false;
          }
        }),
      );
      pressureEvidence.freshReadAfterCancellation = 200;
      expect(
        result.healthy,
        "Eight retained native readers must start without response errors or circuit closure",
      ).toBe(true);
    }
    if (mediaExpected && !faultsOnly && !slowLinkProbe) {
      log(
        "Checking twenty local images, a 96 MiB movie prefix, seeking and paused resume",
      );
      evidence.checks.push({
        name: "large-native-media",
        ...(await qualifyLargeMedia(artifact(), mediaExpected)),
      });
      await artifact().locator("#local-movie").scrollIntoViewIfNeeded();
      const path = join(output, "large-native-media.png");
      if (native)
        writeFileSync(
          path,
          execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"]),
        );
      else await page.screenshot({ path });
      screenshots.push({
        name: "large-native-media",
        ...(await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }))),
        path,
      });
    }
    if (localFaults && !slowLinkProbe) {
      log(
        "Exercising native socket interruption, refusal and silent stalls on the owned encrypted relay",
      );
      evidence.checks.push({
        name: "native-network-faults",
        ...(await qualifyNativeFaults({
          page,
          artifact,
          gate: networkGate,
          record: recordFault,
          until,
          seed: 156202610,
          images: mediaExpected.images,
          appendUpdate: (text) =>
            appendFileSync(
              transcript,
              JSON.stringify(
                row(500 + faultTimeline.length, "assistant", text),
              ) + "\n",
            ),
        })),
      });
    }
    const composerArtifactIdentity = nativeManaged
      ? await artifact().evaluate(() => performance.timeOrigin)
      : null;
    if (nativeManaged) {
      // A covering phone viewer can correctly intercept composer taps. Use its
      // real minimize control, retaining the loaded frame while typing against
      // the live transcript; restore that same document afterward.
      await page
        .getByRole("button", { name: "Minimize file viewer", exact: true })
        .click();
    }
    await composer.fill("");
    // fill has already focused the native composer and opened the IME. A
    // redundant CDP mouse click races that viewport resize on physical WebView.
    if (!nativeManaged) await composer.click();
    await expect(composer).toBeFocused();
    if (physical)
      await page.screenshot({
        path: join(output, "composer-before-typing.png"),
      });
    await beginTypingMetrics(composer);
    await page.evaluate(() => {
      window.__artifactMutations = 0;
      window.__artifactObserver = new MutationObserver(
        (records) => (window.__artifactMutations += records.length),
      );
      window.__artifactObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    let updates = 0;
    const ticker = setInterval(
      () =>
        appendFileSync(
          transcript,
          JSON.stringify(
            row(
              300 + updates++,
              "assistant",
              `Concurrent review update ${updates}`,
            ),
          ) + "\n",
        ),
      70,
    );
    const composerText = "Review this local report with me.";
    let expected = "";
    const composerLatencies = [];
    try {
      for (const character of composerText) {
        const start = Date.now();
        await page.keyboard.type(character);
        expected += character;
        await expect(composer).toHaveValue(expected, { timeout: 100 });
        composerLatencies.push(Date.now() - start);
        // Deliberate key cadence keeps real transcript updates overlapping typing.
        await page.waitForTimeout(20);
      }
    } finally {
      clearInterval(ticker);
    }
    const mutations = await page.evaluate(() => {
      window.__artifactObserver.disconnect();
      return window.__artifactMutations;
    });
    evidence.checks.push({
      name: "composer-input-paint-clocks",
      ...(await finishTypingMetrics(composer, composerText, composerLatencies)),
    });
    if (!android)
      expect(Math.max(...composerLatencies)).toBeLessThanOrEqual(100);
    expect(updates).toBeGreaterThan(0);
    expect(mutations).toBeGreaterThan(0);
    evidence.checks.push({
      name: "composer-sequential-typing",
      characters: composerText.length,
      maxMs: Math.max(...composerLatencies),
      updates,
      mutations,
      viewerParked: nativeManaged,
    });
    if (nativeManaged) {
      if (physical) {
        // Keep OS-level proof of the typed result and native keyboard alongside
        // CDP captures made around the physical IME resize.
        const path = join(output, "native-composer-typed.png");
        const png = execFileSync(
          "adb",
          ["-s", serial, "exec-out", "screencap", "-p"],
          { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
        );
        writeFileSync(path, png);
        screenshots.push({
          name: "native-composer-typed",
          path,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        });
        evidence.nativeComposerViewport = await composer.evaluate((element) => {
          const rect = element.getBoundingClientRect(),
            viewport = window.visualViewport;
          return {
            top: rect.top,
            bottom: rect.bottom,
            viewportTop: viewport?.offsetTop,
            viewportHeight: viewport?.height,
            focused: document.activeElement === element,
          };
        });
      }
      // Read only the current flag: a phone's full IME dump can include a large
      // input history that neither this check nor its receipt should collect.
      const ime = adb(
        "shell",
        "dumpsys input_method | sed -n '/mInputShown=/p'",
      );
      const imeShown = /mInputShown=true/.test(ime);
      evidence.composerImeDismissed = imeShown;
      if (imeShown) adb("shell", "input", "keyevent", "KEYCODE_BACK");
      await page.screenshot({
        path: join(output, "composer-before-restore.png"),
      });
      evidence.composerRestoreControls = await page
        .getByRole("button", { includeHidden: true })
        .evaluateAll((buttons) =>
          buttons
            .map((b) => b.getAttribute("aria-label"))
            .filter((label) => /viewer/i.test(label ?? "")),
        );
      await page
        .getByRole("button", { name: /^Restore file viewer:.*index\.html$/ })
        .click();
      expect(await artifact().evaluate(() => performance.timeOrigin)).toBe(
        composerArtifactIdentity,
      );
    }

    if (nativeResume) {
      const rootIdentity = await page.evaluate(() => performance.timeOrigin);
      const frameIdentity = await artifact().evaluate(
        () => (window.__yaWarmIdentity = Math.random()),
      );
      const draft = await composer.inputValue();
      const cycles = [];
      log("Checking three real launcher resumes with the artifact retained");
      for (const sleepMs of [1000, 2500, 1000]) {
        await page.evaluate(() => {
          window.__yaResumeEdges = [];
          let previous;
          const sample = () => {
            const state =
              document
                .querySelector("[data-connection-status]")
                ?.getAttribute("data-connection-status") ?? "ready";
            if (state === previous) return;
            previous = state;
            window.__yaResumeEdges.push({ at: performance.now(), state });
            if (window.__yaResumeEdges.length > 128)
              window.__yaResumeEdges.shift();
          };
          window.__yaResumeObserver = new MutationObserver(sample);
          window.__yaResumeObserver.observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ["data-connection-status"],
          });
          sample();
        });
        adb("shell", "input", "keyevent", "KEYCODE_HOME");
        await until("native app left the resumed activity", () => {
          const activities = adb("shell", "dumpsys", "activity", "activities");
          const resumed = activities.match(
            /^.*(?:mResumedActivity|topResumedActivity|ResumedActivity)[:=].*$/gm,
          );
          return (
            Boolean(resumed?.length) &&
            resumed.every(
              (line) => !line.includes("com.yepanywhere.mobile.artifacttest"),
            )
          );
        });
        const visibility = await page.evaluate(() => document.visibilityState);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        adb(
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          appActivity,
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
        );
        await until("resumed native artifact", async () => {
          if (await page.evaluate(() => document.hidden)) return false;
          return artifact()?.evaluate(async () => {
            try {
              const response = await fetch("data.json?warm=1");
              return response.ok && (await response.json()).notes === 3;
            } catch {
              return false;
            }
          });
        });
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(
          rootIdentity,
        );
        expect(await artifact().evaluate(() => window.__yaWarmIdentity)).toBe(
          frameIdentity,
        );
        await expect(composer).toHaveValue(draft);
        await until("warm resume connection ready", () =>
          page
            .locator("[data-connection-status]")
            .count()
            .then((count) => count === 0),
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const edges = await page.evaluate(() => {
          window.__yaResumeObserver.disconnect();
          return window.__yaResumeEdges;
        });
        expect(edges.some((edge) => edge.state === "disconnected")).toBe(false);
        expect(
          edges.filter((edge) => edge.state === "connecting").length,
        ).toBeLessThanOrEqual(1);
        cycles.push({
          sleepMs,
          edges,
          visibility,
          freshRead: 200,
          documentRetained: true,
          draftRetained: true,
        });
      }
      evidence.checks.push({ name: "native-artifact-launcher-resume", cycles });
    }
    await artifact().evaluate(() =>
      localStorage.setItem("viewer-only", "first"),
    );
    if (!nativeManaged) {
      const second = await context.newPage();
      await second.goto(
        `${origin}/login/relay#u=${username}&p=${password}&r=${encodeURIComponent(relayUrl)}`,
      );
      await second.waitForURL("**/-/relay/**");
      await second.goto(
        `${base}/projects/${projectId}/file?${new URLSearchParams({ path: join(project, "index.html") })}`,
      );
      const secondFrame = await until("second viewer", () =>
        second
          .frames()
          .find((f) => /\/v\/[a-f0-9]{32}\/index.html/.test(f.url())),
      );
      await expect(secondFrame.locator("#modules")).toContainText(
        "JSON: 3 notes",
      );
      expect(new URL(secondFrame.url()).origin).not.toBe(
        new URL(artifact().url()).origin,
      );
      expect(
        await secondFrame.evaluate(() => localStorage.getItem("viewer-only")),
      ).toBeNull();
      await second.close();
      evidence.checks.push({ name: "concurrent-viewer-origins", passed: true });
    }

    evidence.documentUrl = artifact().url();
    evidence.networkFallback = (await fetch(evidence.documentUrl)).status;
    expect(evidence.networkFallback).toBe(404);
    const documentUrl = artifact().url();
    const artifactOrigin = new URL(documentUrl).origin;
    if (!nativeManaged) {
      const orphan = await context.newPage();
      const otherViewer = randomUUID().replaceAll("-", "");
      await orphan.goto(
        `${artifactOrigin}/__ya/1/bootstrap.html?${new URLSearchParams({ viewer: otherViewer, parent: origin })}`,
      );
      await orphan.evaluate((url) => {
        const frame = document.createElement("iframe");
        frame.src = url;
        document.body.append(frame);
      }, documentUrl);
      const orphanDocument = await until("controlled survivor", () =>
        orphan.frames().find((f) => f.url() === documentUrl),
      );
      await expect(orphanDocument.locator("#modules")).toContainText(
        "JSON: 3 notes",
      );
      await page.locator('.file-viewer-action[aria-label="Back"]').click();
      await until(
        "worker unregister",
        async () =>
          (await orphan.evaluate(() =>
            navigator.serviceWorker.getRegistrations().then((r) => r.length),
          )) === 0,
      );
      const afterClose = await orphanDocument.evaluate(
        async () => (await fetch("data.json?afterClose=1")).status,
      );
      expect(afterClose).toBe(503);
      await orphan.close();
      evidence.checks.push({
        name: "teardown-and-survivor-refusal",
        registrations: 0,
        afterClose,
      });
    } else {
      await page.locator('.file-viewer-action[aria-label="Back"]').click();
      await expect(
        page.locator(`iframe[src^="${artifactOrigin}"]`),
      ).toHaveCount(0);
      const unregistered = async (viewerOrigin) => {
        const matching = [...registrations.values()].filter((r) =>
          r.scopeURL.startsWith(`${viewerOrigin}/`),
        );
        return matching.length > 0 && matching.every((r) => r.isDeleted);
      };
      await until("closed native worker registration", () =>
        unregistered(artifactOrigin),
      );
      // More than the server's 16-per-principal admission bound. Every new
      // fragment must receive a fresh origin and the old worker must disappear.
      // This exercises the actual native pane, without unsupported newPage().
      const origins = new Set([artifactOrigin]);
      // Live updates can move the original link out of the virtual transcript.
      appendFileSync(
        transcript,
        JSON.stringify(
          row(
            900,
            "assistant",
            `[Reopen fragment](${join(project, "fragment.html")})`,
          ),
        ) + "\n",
      );
      log(
        "Checking eighteen fresh native viewer admissions and worker removals",
      );
      for (let cycle = 0; cycle < 18; cycle++) {
        await page
          .getByRole("link", { name: "Reopen fragment", exact: true })
          .click();
        const reopened = await until("fresh fragment", () =>
          page
            .frames()
            .find((f) => /\/v\/[a-f0-9]{32}\/fragment.html/.test(f.url())),
        );
        await expect(reopened.locator("#widget")).toBeVisible();
        const nextOrigin = new URL(reopened.url()).origin;
        expect(origins.has(nextOrigin)).toBe(false);
        expect(
          await reopened.evaluate(() => localStorage.getItem("viewer-only")),
        ).toBeNull();
        origins.add(nextOrigin);
        await until("native worker registration", () =>
          [...registrations.values()].some(
            (r) => r.scopeURL.startsWith(`${nextOrigin}/`) && !r.isDeleted,
          ),
        );
        await page.locator('.file-viewer-action[aria-label="Back"]').click();
        await until("native worker unregister after close", () =>
          unregistered(nextOrigin),
        );
      }
      evidence.checks.push({
        name: "native-pane-teardown",
        cycles: 18,
        freshOrigins: origins.size,
        registrationsRemoved: true,
      });
      if (nativeTabCycle) {
        const processBefore = adb("shell", "pidof", appPackage).trim();
        const draft = await page
          .locator("textarea.message-input, textarea[placeholder]")
          .first()
          .inputValue();
        const sourcePath = new URL(page.url()).pathname;
        const tap = async (attribute, value) => {
          const point = await until(`native ${attribute}: ${value}`, () => {
            adb("shell", "uiautomator", "dump", hierarchyFile);
            const xml = adb("shell", "cat", hierarchyFile);
            const points = [];
            for (const [tag] of xml.matchAll(/<node\b[^>]*>/g)) {
              const actual = tag
                .match(new RegExp(`${attribute}="([^"]*)"`))?.[1]
                ?.replaceAll("&amp;", "&")
                .replaceAll("&quot;", '"');
              if (actual !== value || tag.includes('enabled="false"')) continue;
              const bounds = tag.match(
                /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
              );
              if (bounds)
                points.push([
                  Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2),
                  Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2),
                ]);
            }
            return points.length === 1 && points[0];
          });
          adb("shell", "input", "tap", ...point.map(String));
        };
        const attachReplacement = async (previous) => {
          await until("discarded native WebView", () => previous.isClosed());
          page = await until("replacement native WebView", async () => {
            if (!androidBrowser.isConnected())
              androidBrowser = await chromium.connectOverCDP(
                nativeDevtoolsEndpoint,
                { noDefaults: true },
              );
            context = androidBrowser.contexts()[0];
            return context
              ?.pages()
              .find(
                (candidate) => candidate !== previous && !candidate.isClosed(),
              );
          });
          observePage(page);
          await bindWorkerEvents();
        };
        appendFileSync(
          transcript,
          JSON.stringify(
            row(
              975,
              "assistant",
              `[Tab artifact](${join(project, "index.html")})`,
            ),
          ) + "\n",
        );
        await page
          .getByRole("link", { name: "Tab artifact", exact: true })
          .click();
        await until("artifact before native tab switch", artifact);
        await expect(artifact().locator("#modules")).toContainText(
          "JSON: 3 notes",
        );
        const result = { name: "native-tab-document-disposal", cycles: [] };
        evidence.checks.push(result);
        log(
          "Checking eighteen native tab round trips with an admitted artifact",
        );
        for (let cycle = 0; cycle < 18; cycle++) {
          const previousTime = await page.evaluate(
            () => performance.timeOrigin,
          );
          const previousOrigin = new URL(artifact().url()).origin;
          const oldPage = page;
          if (cycle === 0) {
            await tap("content-desc", "New tab");
            await tap("text", username);
          } else {
            await tap("content-desc", "Tabs, 2 open");
            await tap("content-desc", `Switch to tab: ${username}, /projects`);
          }
          await attachReplacement(oldPage);
          await expect(
            page.getByText("bundle", { exact: true }).first(),
          ).toBeVisible({ timeout: 45000 });
          expect(new URL(page.url()).pathname).toBe("/projects");
          const priorWorkerReported = [...registrations.values()].some(
            (registration) =>
              registration.scopeURL.startsWith(`${previousOrigin}/`) &&
              !registration.isDeleted,
          );
          const peer = page;
          await tap("content-desc", "Tabs, 2 open");
          await tap(
            "content-desc",
            `Switch to tab: ${username}, ${sourcePath}`,
          );
          await attachReplacement(peer);
          const reopen = page.getByRole("link", {
            name: "Tab artifact",
            exact: true,
          });
          await until(
            "restored tab navigation",
            async () => Boolean(artifact()) || (await reopen.isVisible()),
          );
          const filePaneRestoredAutomatically = Boolean(artifact());
          if (!filePaneRestoredAutomatically) await reopen.click();
          await until("reopened tab artifact", artifact);
          await expect(artifact().locator("#modules")).toContainText(
            "JSON: 3 notes",
          );
          expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
            previousTime,
          );
          expect(new URL(artifact().url()).origin).not.toBe(previousOrigin);
          await expect(
            page
              .locator("textarea.message-input, textarea[placeholder]")
              .first(),
          ).toHaveValue(draft);
          expect(adb("shell", "pidof", appPackage).trim()).toBe(processBefore);
          const fresh = await artifact().evaluate(
            async () => (await fetch("data.json?native-tab=1")).status,
          );
          expect(fresh).toBe(200);
          result.cycles.push({
            cycle,
            discardedBothDocuments: true,
            filePaneRestoredAutomatically,
            priorWorkerReported,
            freshArtifactOrigin: true,
            draftRetained: true,
            processRetained: true,
            freshRead: fresh,
          });
          log(`Native tab round trip ${cycle + 1}/18 reopened the artifact`);
        }
        await page.locator('.file-viewer-action[aria-label="Back"]').click();
        await expect(
          page.getByRole("link", { name: "Tab artifact", exact: true }),
        ).toBeVisible({ timeout: 45000 });
      }
      if (nativeProcessRestart) {
        appendFileSync(
          transcript,
          JSON.stringify(
            row(
              990,
              "assistant",
              `[Restart artifact](${join(project, "index.html")})`,
            ),
          ) + "\n",
        );
        await page
          .getByRole("link", { name: "Restart artifact", exact: true })
          .click();
        await until("artifact before process restart", artifact);
        await expect(artifact().locator("#modules")).toContainText(
          "JSON: 3 notes",
        );
        const previous = {
          pid: adb("shell", "pidof", appPackage).trim(),
          parent: await page.evaluate(() => performance.timeOrigin),
          origin: new URL(artifact().url()).origin,
          path: new URL(page.url()).pathname,
          draft: await page
            .locator("textarea.message-input, textarea[placeholder]")
            .first()
            .inputValue(),
        };
        const partial = await artifact().evaluate(async () => {
          const response = await fetch("range.bin?process-cut=1");
          const reader = response.body.getReader();
          window.__yaProcessReader = reader;
          const first = await reader.read();
          return {
            status: response.status,
            firstBytes: first.value?.length ?? 0,
          };
        });
        expect(partial.status).toBe(200);
        expect(partial.firstBytes).toBeGreaterThan(0);
        expect(partial.firstBytes).toBeLessThan(64 * 1024 * 1024);
        const oldPage = page;
        log(
          "Force-stopping the owned app with an unread 64 MiB response, then cold-launching without credentials",
        );
        adb("shell", "am", "force-stop", appPackage);
        await until("killed process DevTools page", () => oldPage.isClosed());
        adb(
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          appActivity,
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
        );
        const pid = await until("new app process", () =>
          adb("shell", "pidof", appPackage).trim(),
        );
        expect(pid).not.toBe(previous.pid);
        const port = adb(
          "forward",
          "tcp:0",
          `localabstract:webview_devtools_remote_${pid}`,
        ).trim();
        forwards.push(port);
        nativeDevtoolsEndpoint = `http://127.0.0.1:${port}`;
        await until(
          "cold native WebView DevTools",
          async () =>
            (
              await fetch(`${nativeDevtoolsEndpoint}/json/version`, {
                signal: AbortSignal.timeout(2000),
              })
            ).ok,
        );
        androidBrowser = await chromium.connectOverCDP(nativeDevtoolsEndpoint, {
          noDefaults: true,
        });
        context = androidBrowser.contexts()[0];
        page = await until("cold native page", () => context.pages()[0]);
        observePage(page);
        await bindWorkerEvents();
        const reopen = page.getByRole("link", {
          name: "Restart artifact",
          exact: true,
        });
        await until(
          "cold session navigation",
          async () => Boolean(artifact()) || (await reopen.isVisible()),
        );
        expect(new URL(page.url()).pathname).toBe(previous.path);
        await expect(
          page.locator("textarea.message-input, textarea[placeholder]").first(),
        ).toHaveValue(previous.draft);
        const filePaneRestoredAutomatically = Boolean(artifact());
        if (!filePaneRestoredAutomatically) await reopen.click();
        await until("cold artifact reopening", artifact);
        await expect(artifact().locator("#modules")).toContainText(
          "JSON: 3 notes",
        );
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
          previous.parent,
        );
        expect(new URL(artifact().url()).origin).not.toBe(previous.origin);
        const fresh = await artifact().evaluate(async () => {
          const response = await fetch("data.json?after-process-restart=1");
          return {
            status: response.status,
            notes: (await response.json()).notes,
          };
        });
        expect(fresh).toEqual({ status: 200, notes: 3 });
        evidence.checks.push({
          name: "native-process-restart",
          bodyBytes: 64 * 1024 * 1024,
          ...partial,
          processReplaced: true,
          parentReplaced: true,
          nativeCredentialsReused: true,
          routeRetained: true,
          draftRetained: true,
          filePaneRestoredAutomatically,
          freshArtifactOrigin: true,
          freshRead: fresh.status,
        });
        await page.locator('.file-viewer-action[aria-label="Back"]').click();
        await expect(reopen).toBeVisible({ timeout: 45000 });
      }
      if (nativeDocumentReload) {
        appendFileSync(
          transcript,
          JSON.stringify(
            row(
              950,
              "assistant",
              `[Reload artifact](${join(project, "index.html")})`,
            ),
          ) + "\n",
        );
        const reloads = {
          name: "native-parent-document-reload",
          cycles: [],
          webLocks: await page.evaluate(() => typeof navigator.locks?.request),
        };
        evidence.checks.push(reloads);
        log(
          "Checking eighteen parent document reloads with an admitted artifact",
        );
        await page
          .getByRole("link", { name: "Reload artifact", exact: true })
          .click();
        for (let cycle = 0; cycle < 18; cycle++) {
          await until("artifact before parent reload", artifact);
          await expect(artifact().locator("#modules")).toContainText(
            "JSON: 3 notes",
          );
          const previousOrigin = new URL(artifact().url()).origin;
          const previousDocument = await page.evaluate(
            () => performance.timeOrigin,
          );
          await page.reload({ waitUntil: "load" });
          try {
            await until("restored artifact after parent reload", artifact);
          } catch (error) {
            const response = await api(
              "/sessions/artifact-demo/artifact-previews",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: join(project, "index.html") }),
              },
            );
            const body = await response.json();
            reloads.admissionProbe = {
              status: response.status,
              error: body.error ?? null,
            };
            if (response.ok && typeof body.id === "string")
              await api(
                `/sessions/artifact-demo/artifact-previews/${encodeURIComponent(body.id)}`,
                { method: "DELETE" },
              );
            throw error;
          }
          await expect(artifact().locator("#modules")).toContainText(
            "JSON: 3 notes",
          );
          expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
            previousDocument,
          );
          const restoredOrigin = new URL(artifact().url()).origin;
          expect(restoredOrigin).not.toBe(previousOrigin);
          reloads.cycles.push({
            cycle,
            newParentDocument: true,
            newArtifactOrigin: true,
            previousWorkerRemoved: await unregistered(previousOrigin),
          });
          log(`Parent reload ${cycle + 1}/18 restored a fresh artifact`);
        }
        await page.locator('.file-viewer-action[aria-label="Back"]').click();
        await expect(
          page.getByRole("link", { name: "Reload artifact", exact: true }),
        ).toBeVisible({ timeout: 45000 });
      }
    }
    await cdp.detach();
    expect(evidence.errors).toEqual([]);
  }
  if (process.argv.includes("--smoke")) log("Smoke assertions complete");
  emitCapturePreview(
    await writeCapturePreview({
      input: nativeManaged
        ? `Bundled Android YA: packaged artifact shell, native transport and encrypted ${localFaults ? "owned fault-controlled" : "public"} relay${faultsOnly ? " (focused faults/typing; full media matrix omitted)" : ""}`
        : native
          ? "Bundled Android YA: scriptless fallback over the encrypted public relay"
          : "Managed artifact viewer: actual YA, encrypted relay and deployed HTTPS content host",
      out: join(output, "capture"),
      screenshots,
      warnings: evidence.expectedBrowserPolicyRefusals?.length
        ? [
            "Native WebView video controls attempted orientation sensing; the viewer denied it. Exact browser policy diagnostics are recorded separately.",
          ]
        : [],
    }),
  );
  evidence.passed = true;
  log(
    `PASS: ${nativeManaged ? "bundled app interactive artifact" : native ? "bundled app scriptless fallback" : "actual pane and local assets"} over encrypted relay. Evidence: ${output}`,
  );
} catch (error) {
  evidence.failure = String(error);
  if (error?.typingEvidence) evidence.typingFailure = error.typingEvidence;
  process.exitCode = 1;
  log(error.stack ?? String(error));
  if (page) {
    evidence.url = page.url();
    evidence.body = await page.locator("body").innerText().catch(String);
    evidence.frames = await Promise.all(
      page.frames().map(async (frame) => ({
        url: frame.url(),
        body: (await frame.locator("body").innerText().catch(String)).slice(
          0,
          2500,
        ),
      })),
    );
  }
} finally {
  if (android) {
    if (physical && !native) await context?.close();
    await androidBrowser?.close().catch(() => {});
    for (const port of reversePorts) {
      try {
        adb("reverse", "--remove", `tcp:${port}`);
      } catch {}
    }
    for (const port of forwards) {
      try {
        adb("forward", "--remove", `tcp:${port}`);
      } catch {}
    }
    try {
      if (physical) {
        if (native && installedPhonePackage) {
          adb("uninstall", appPackage);
          evidence.phoneTestPackageRemoved = true;
        }
        if (native) adb("shell", "rm", "-f", hierarchyFile);
      } else {
        adb("shell", "rm", "-f", "/data/local/tmp/chrome-command-line");
        adb(
          "shell",
          "am",
          "force-stop",
          native ? appPackage : "com.android.chrome",
        );
        if (native && installedPhonePackage) {
          adb("uninstall", appPackage);
          evidence.testPackageRemoved = true;
          adb("shell", "rm", "-f", hierarchyFile);
        }
        if (androidPreferences)
          execFileSync(
            "adb",
            ["-s", serial, "shell", "su", "0", "tee", chromePreferences],
            {
              input: androidPreferences,
              stdio: ["pipe", "ignore", "pipe"],
              timeout: 30000,
            },
          );
      }
    } catch (error) {
      evidence.cleanupError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    }
  } else await context?.close();
  for (const child of children.reverse()) {
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    if (child.exitCode === null)
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
  }
  for (const resource of [networkGate, localRelay]) {
    try {
      await resource?.close();
    } catch (error) {
      evidence.cleanupError = String(error);
      evidence.passed = false;
      process.exitCode = 1;
    }
  }
  writeFileSync(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  log(`Owned browser/server/relay stopped. Results: ${output}`);
}
