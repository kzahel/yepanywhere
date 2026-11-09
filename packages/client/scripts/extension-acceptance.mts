/**
 * End-to-end acceptance for the Chrome extension's side panel, settings pane
 * and background badge (docs/tactical/151 steps 7-10).
 *
 * Starts a local relay and an isolated YA server in a temporary home, seeds
 * Claude transcripts that mention a PR, enables Issues & PRs, configures
 * Remote Access through the CLI, then drives the unpacked extension in
 * Playwright's Chromium under its store id. Nothing touches the operator's
 * YA, ~/.claude or browser profile.
 *
 * Build the extension first:
 *   pnpm --filter @yep-anywhere/browser-extension build:extension
 *   pnpm --filter @yep-anywhere/client exec tsx --conditions source scripts/extension-acceptance.mts
 *
 * Optional host access cannot be granted from automation, so a copy of the
 * build gains a required host permission for the local page server; the key
 * and id are unchanged.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { InstallService } from "../../server/src/services/InstallService.ts";
import { emitCapturePreview, writeCapturePreview } from "./artifact-capture";

const githubStatus = process.argv.includes("--github-status");
const storeAssets = process.argv.includes("--store-assets");
const headed = process.argv.includes("--headed");
const ownerRepo = storeAssets ? "kzahel/yepanywhere" : "TomFitAG/tomfit-api";
const issueNumber = storeAssets ? "123" : "482";
const itemPath = storeAssets ? "issues" : "pull";
const reference = `https://github.com/${ownerRepo}/${itemPath}/${issueNumber}`;
const implementationTitle = storeAssets
  ? "Demo: Review SQLite session storage"
  : "Implement the sync retry budget";
const EXTENSION_ID = "dgeameddpnggdeenoekpiaacfghdodch";
const USERNAME = "ext-accept";
const PASSWORD = "acceptance-password-1";
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(clientRoot, "../..");
const dist = resolve(
  process.env.YA_EXTENSION_DIST ??
    resolve(repoRoot, "packages/browser-extension/dist"),
);
if (!existsSync(join(dist, "manifest.json")))
  throw new Error("Build the extension first (build:extension)");

const temp = mkdtempSync(join(tmpdir(), "ya-ext-accept-"));
const children: ChildProcess[] = [];
const log = (message: string) => console.error(`[acceptance] ${message}`);

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false)
        return value;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

function start(label: string, cwd: string, args: string[], env: object) {
  const child = spawn("pnpm", ["exec", "tsx", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    if (code) log(`${label} exited ${code}:\n${output}`);
  });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// A page server standing in for GitHub: any /owner/repo/pull/N path is a PR
// page to the extension, so its own URL can carry a seeded mention.
const pages = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>PR</title><h1>Pull request</h1>");
});
await new Promise<void>((done) => pages.listen(0, "127.0.0.1", done));
const pagePort = (pages.address() as { port: number }).port;
const localPr = `http://127.0.0.1:${pagePort}/${ownerRepo}/${itemPath}/${issueNumber}`;

try {
  // --- Seed an isolated home -------------------------------------------
  const home = join(temp, "home");
  const dataDir = join(temp, "data");
  const claudeDir = join(temp, "claude", "projects");
  const runtimeDir = join(temp, "run");
  for (const dir of [home, dataDir, claudeDir, runtimeDir])
    mkdirSync(dir, { recursive: true });
  const install = new InstallService({ dataDir });
  await install.initialize();
  await install.recordSuccessfulProviders(["claude"]);
  writeFileSync(
    join(dataDir, "server-settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        codexUpdatePolicy: "off",
        issueAssociations: {
          enabled: true,
          scope: "recent",
          recentDays: 7,
          ...(githubStatus
            ? {
                githubStatusEnabled: true,
                githubCli: { enabled: false, account: "" },
              }
            : {}),
        },
      },
    }),
  );
  const project = join(
    temp,
    "projects",
    storeAssets ? "yepanywhere" : "tomfit-api",
  );
  mkdirSync(project, { recursive: true });
  const sessionDir = join(claudeDir, hostname(), project.replace(/\//g, "-"));
  mkdirSync(sessionDir, { recursive: true });
  const now = Date.now();
  const transcript = (id: string, user: string, reply: string, ago: number) =>
    writeFileSync(
      join(sessionDir, `${id}.jsonl`),
      [
        {
          type: "user",
          uuid: `${id}-u`,
          sessionId: id,
          cwd: project,
          timestamp: new Date(now - ago).toISOString(),
          message: { role: "user", content: user },
        },
        {
          type: "assistant",
          uuid: `${id}-a`,
          parentUuid: `${id}-u`,
          sessionId: id,
          cwd: project,
          timestamp: new Date(now - ago + 1000).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: reply }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
  transcript(
    "accept-impl",
    implementationTitle,
    storeAssets
      ? `This is a sample session about ${reference}.

## A storage boundary for session discovery

SQLite lets the discovery catalog retain session identity, titles and archive state while provider transcripts remain the source of conversation history.

### Implementation review

- Keep the YA session id stable across providers.
- Reuse prepared statements for catalog reads.
- Preserve a rebuild path from provider transcripts.
- Keep the database in the configured app-data directory.

\`\`\`typescript
const session = catalog.findSession(sessionId);
if (session) {
  return { id: session.id, title: session.title };
}
\`\`\`

### Verification

Review restart persistence, provider-native resume and archive behavior on supported platforms. The public issue supplies context; this conversation is demonstration content.`
      : "Opened " +
          reference +
          " and the local preview " +
          localPr +
          (githubStatus
            ? "\n" +
              Array.from(
                { length: 48 },
                (_, i) => `https://github.com/${ownerRepo}/pull/${500 + i}`,
              ).join("\n")
            : ""),
    60_000,
  );
  transcript(
    "accept-review",
    storeAssets
      ? "Demo: Verify catalog persistence"
      : `Review feedback on ${reference}/files`,
    storeAssets
      ? `Sample review for ${reference}: test catalog persistence across restart and rebuild.`
      : "Capping backoff at 30 s as the reviewer asked.",
    120_000,
  );
  transcript(
    "accept-other",
    storeAssets
      ? "Demo: Inspect relay downloads — https://github.com/kzahel/yepanywhere/issues/121"
      : `Look at ${reference}1`,
    storeAssets
      ? "Sample review of the Markdown download issue. Keep binary framing consistent through the relay."
      : "That PR is unrelated.",
    180_000,
  );

  // --- Relay, Remote Access and server -----------------------------------
  const relayPortFile = join(temp, "relay.port");
  start(
    "relay",
    join(repoRoot, "packages/relay"),
    ["--conditions", "source", "src/index.ts"],
    {
      RELAY_PORT: "0",
      RELAY_PORT_FILE: relayPortFile,
      RELAY_DATA_DIR: join(temp, "relay"),
      RELAY_LOG_TO_FILE: "false",
      RELAY_LOG_LEVEL: "warn",
    },
  );
  const relayPort = await waitFor("relay port", () =>
    existsSync(relayPortFile)
      ? readFileSync(relayPortFile, "utf8").trim() || undefined
      : undefined,
  );
  const relayUrl = `ws://localhost:${relayPort}/ws`;
  log(`relay ${relayUrl}`);
  const statusRequests = join(temp, "github-requests.jsonl");
  const preload = join(temp, "github-fixture.mjs");
  if (githubStatus)
    writeFileSync(
      preload,
      `
    import { appendFileSync } from "node:fs";
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) !== "https://api.github.com/graphql") return original(url, options);
      const query = JSON.parse(options.body).query;
      appendFileSync(${JSON.stringify(statusRequests)}, JSON.stringify({ query }) + "\\n");
      const data = {}; let repository;
      for (const field of query.matchAll(/(r\\d+): repository\\([^)]*\\)|(i\\d+): issueOrPullRequest\\(number: (\\d+)\\)/g)) {
        if (field[1]) { repository = {}; data[field[1]] = repository; }
        else {
          const number = Number(field[3]);
          const merged = number === Number(${JSON.stringify(issueNumber)}) || number % 3 === 0;
          repository[field[2]] = { __typename: "PullRequest", id: "PR_" + number,
            state: merged ? "MERGED" : number % 3 === 1 ? "OPEN" : "CLOSED", isDraft: false,
            mergedAt: merged ? "2026-10-15T12:30:00Z" : null,
            mergeCommit: merged ? { oid: "abc1234567890" + number } : null };
        }
      }
      return new Response(JSON.stringify({ data }));
    };
  `,
    );
  const serverEnv = {
    HOME: home,
    USERPROFILE: home,
    YEP_DATA_DIR: dataDir,
    CLAUDE_SESSIONS_DIR: claudeDir,
    CODEX_SESSIONS_DIR: join(temp, "codex"),
    GEMINI_SESSIONS_DIR: join(temp, "gemini"),
    YEP_PROVIDER_HOST_RUNTIME_DIR: runtimeDir,
    YEP_PROVIDER_HOST_ENABLED: "false",
    ...(githubStatus
      ? {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
          YEP_GITHUB_TOKEN: "acceptance-fixture-token",
        }
      : {}),
  };
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions",
      "source",
      "src/cli.ts",
      "--setup-remote-access",
      "--username",
      USERNAME,
      "--password",
      PASSWORD,
      "--relay",
      relayUrl,
    ],
    {
      cwd: join(repoRoot, "packages/server"),
      env: { ...process.env, ...serverEnv },
      stdio: "inherit",
    },
  );
  const portFile = join(temp, "server.port");
  let serverProcess = start(
    "server",
    join(repoRoot, "packages/server"),
    ["--conditions", "source", "src/index.ts"],
    {
      ...serverEnv,
      PORT: "0",
      PORT_FILE: portFile,
      MAINTENANCE_PORT: "-1",
      MAINTENANCE_PORT_FILE: join(temp, "maintenance.port"),
      AUTH_DISABLED: "true",
      HTTPS_SELF_SIGNED: "",
      NODE_ENV: "production",
      SERVE_FRONTEND: "false",
      LOG_LEVEL: "warn",
    },
  );
  const serverPort = await waitFor(
    "server port",
    () =>
      existsSync(portFile)
        ? readFileSync(portFile, "utf8").trim() || undefined
        : undefined,
    120_000,
  );
  const api = (path: string) =>
    fetch(`http://127.0.0.1:${serverPort}/api${path}`, {
      headers: { "X-Yep-Anywhere": "true" },
    });
  await waitFor("relay registration", async () => {
    const status = await (await api("/remote-access/relay/status")).json();
    return status.status === "waiting" || undefined;
  });
  await waitFor(
    "indexed PR mentions",
    async () => {
      const result = await (
        await api(`/issues?ref=${encodeURIComponent(reference)}`)
      ).json();
      return result.items?.[0]?.sessionCount === 2 || undefined;
    },
    120_000,
  );
  log(`server indexed both sessions for ${reference}`);
  if (githubStatus) {
    await waitFor("merged GitHub fact", async () => {
      const result = await (
        await api(`/issues?ref=${encodeURIComponent(reference)}`)
      ).json();
      return result.items?.[0]?.trackerStatus?.mergedAt || undefined;
    });
    const beforeRestart = readFileSync(statusRequests, "utf8");
    await new Promise<void>((done) => {
      serverProcess.once("exit", () => done());
      process.kill(-serverProcess.pid!, "SIGTERM");
    });
    serverProcess = start(
      "server-restarted",
      join(repoRoot, "packages/server"),
      ["--conditions", "source", "src/index.ts"],
      {
        ...serverEnv,
        PORT: serverPort,
        PORT_FILE: portFile,
        MAINTENANCE_PORT: "-1",
        AUTH_DISABLED: "true",
        HTTPS_SELF_SIGNED: "",
        NODE_ENV: "production",
        SERVE_FRONTEND: "false",
        LOG_LEVEL: "warn",
      },
    );
    await waitFor(
      "restarted server",
      async () => (await api("/version")).ok || undefined,
    );
    const result = await (
      await api(`/issues?ref=${encodeURIComponent(reference)}`)
    ).json();
    expect(result.items[0].trackerStatus).toMatchObject({
      state: "merged",
      mergedAt: "2026-10-15T12:30:00Z",
      mergeCommitSha: expect.stringContaining("abc123"),
    });
    expect(result.statusRefreshing).toBeUndefined();
    expect(readFileSync(statusRequests, "utf8")).toBe(beforeRestart);
    log(
      "standalone server restart retained merge facts without another GitHub request",
    );
  }

  // --- Chromium with the unpacked extension ------------------------------
  const extension = join(temp, "extension");
  cpSync(dist, extension, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(extension, "manifest.json"), "utf8"),
  );
  if (!storeAssets) manifest.host_permissions = ["http://127.0.0.1/*"];
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(temp, "chrome"), {
    channel: "chromium",
    headless: !headed,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: storeAssets ? 1280 : 1000, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...(headed
        ? ["--window-size=1280,800", "--force-device-scale-factor=1"]
        : []),
    ],
  });
  const consoleErrors: string[] = [];
  try {
    if (existsSync(join(dist, "dev-build.json"))) {
      // Match Load unpacked before testing runtime.reload, as in the dev harness.
      const prefs = await context.newPage();
      await prefs.goto("chrome://extensions");
      const developerMode = prefs.locator("#devMode");
      if ((await developerMode.getAttribute("aria-pressed")) !== "true")
        await developerMode.click();
      await prefs.close();
    }
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
    const origin = `chrome-extension://${EXTENSION_ID}`;

    // Sign in through the local relay from the extension origin.
    const app = await context.newPage();
    app.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    // A fresh profile's first navigation can precede the worker that serves
    // app paths; the packaged entry file needs no worker.
    await app.goto(`${origin}/index.html`);
    await app.goto(
      `${origin}/login/relay#u=${USERNAME}&p=${PASSWORD}&r=${encodeURIComponent(relayUrl)}`,
    );
    await app.waitForURL(`**/-/relay/${USERNAME}/**`, { timeout: 60_000 });
    log(`signed in: ${app.url()}`);
    const mirrored = await waitFor("saved-host mirror", () =>
      app.evaluate(async () => {
        const stored = await (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: { get(key: string): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome.storage.local.get("ya.savedHosts");
        const hosts = stored["ya.savedHosts"] as { session?: unknown }[];
        return hosts?.length && hosts[0]?.session ? hosts.length : undefined;
      }),
    );
    expect(mirrored).toBe(1);

    // Side panel on the PR: both sessions, never #4821.
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.goto(
      `${origin}/sidepanel.html?url=${encodeURIComponent(storeAssets ? reference : `${reference}/files`)}`,
    );
    // The session groups below can list the same sessions, so scope to the
    // PR's own list.
    const prSessions = panel.getByRole("list", {
      name: /^Sessions mentioning /,
    });
    const rows = prSessions.getByRole("button", { name: /^Open / });
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(prSessions.getByText(implementationTitle)).toBeVisible();
    await expect(prSessions.getByText(/Look at/)).toHaveCount(0);
    await expect(panel.getByText("2 sessions")).toBeVisible();
    const shots = storeAssets
      ? join(repoRoot, "docs/distribution/chrome-extension/screenshots")
      : join(repoRoot, ".artifacts/extension-acceptance");
    mkdirSync(shots, { recursive: true });
    const rawShots = join(
      repoRoot,
      ".artifacts/extension-acceptance",
      storeAssets ? "store" : "smoke",
    );
    mkdirSync(rawShots, { recursive: true });
    const prShot = join(rawShots, "panel-pr.png");
    await panel.screenshot({ path: prShot });

    // Opening a row navigates the existing app tab in place.
    const before = await app.evaluate(() => performance.timeOrigin);
    await prSessions
      .getByRole("button", { name: `Open ${implementationTitle}` })
      .click();
    await app.waitForURL(`**/sessions/accept-impl`, { timeout: 30_000 });
    expect(await app.evaluate(() => performance.timeOrigin)).toBe(before);
    log("row opened the session in the existing app tab without a reload");

    // With the popup preference, a new app page is a popup window that
    // registers as an app tab and saves its size for the next popup.
    if (!storeAssets) {
      await panel.evaluate(async () => {
        const local = (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  get(key: string): Promise<Record<string, unknown>>;
                  set(items: Record<string, unknown>): Promise<void>;
                };
              };
            };
          }
        ).chrome.storage.local;
        const key = "ya.extension.settings";
        const current = (await local.get(key))[key] as object | undefined;
        await local.set({ [key]: { ...current, appWindow: "popup" } });
      });
      const opened = context.waitForEvent("page");
      await prSessions
        .getByRole("button", { name: `Open ${implementationTitle}` })
        .click({ modifiers: ["ControlOrMeta"] });
      const popup = await opened;
      await popup.waitForURL(`**/sessions/accept-impl`, { timeout: 30_000 });
      const popupState = () =>
        popup.evaluate(async () => {
          const chrome = (
            globalThis as unknown as {
              chrome: {
                windows: { getCurrent(): Promise<{ type?: string }> };
                storage: {
                  local: { get(key: string): Promise<Record<string, unknown>> };
                };
              };
            }
          ).chrome;
          return {
            type: (await chrome.windows.getCurrent()).type,
            bounds: (await chrome.storage.local.get("ya.popupBounds"))[
              "ya.popupBounds"
            ],
          };
        });
      expect((await popupState()).type).toBe("popup");
      // The popup opens at its final URL, before the app's bridge loads.
      await expect
        .poll(
          async () => {
            await popup.evaluate(() =>
              window.dispatchEvent(new Event("resize")),
            );
            return (await popupState()).bounds;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({ width: expect.any(Number) });
      await popup.close();
      await panel.evaluate(async () => {
        const local = (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  get(key: string): Promise<Record<string, unknown>>;
                  set(items: Record<string, unknown>): Promise<void>;
                };
              };
            };
          }
        ).chrome.storage.local;
        const key = "ya.extension.settings";
        const current = (await local.get(key))[key] as object | undefined;
        await local.set({ [key]: { ...current, appWindow: "tab" } });
      });
      log("new-page click opened the session in a popup window");

      // The panel's open button brings the app tab forward unchanged.
      const pages = context.pages().length;
      await panel.getByRole("button", { name: "Open Yep Anywhere" }).click();
      await expect
        .poll(() =>
          app.evaluate(
            async () =>
              (
                await (
                  globalThis as unknown as {
                    chrome: {
                      tabs: {
                        getCurrent(): Promise<{ active: boolean } | undefined>;
                      };
                    };
                  }
                ).chrome.tabs.getCurrent()
              )?.active,
          ),
        )
        .toBe(true);
      expect(context.pages()).toHaveLength(pages);
      expect(app.url()).toMatch(/\/sessions\/accept-impl$/);
      expect(await app.evaluate(() => performance.timeOrigin)).toBe(before);

      // The toolbar button's right-click menu exists; Chrome offers no way
      // to open it from automation, so only its items are checked.
      await expect
        .poll(() =>
          worker
            .evaluate(async () => {
              const menus = (
                globalThis as unknown as {
                  chrome: {
                    contextMenus: {
                      update(id: string, properties: object): Promise<void>;
                    };
                  };
                }
              ).chrome.contextMenus;
              const ids = ["open-app", "open-popup", "open-side-panel"];
              for (const id of ids) await menus.update(id, {});
              return ids.length;
            })
            .catch(() => 0),
        )
        .toBe(3);
      log("panel open button focused the app tab; toolbar menu items exist");
    }

    // The app tab publishes its route for the panel, which cannot read the
    // tab's address; on that route the panel lists the session's PR.
    const sessionRoute = new URL(app.url()).pathname;
    const published = await waitFor("published app tab route", () =>
      app.evaluate(async (expectedRoute) => {
        const chrome = (
          globalThis as unknown as {
            chrome: {
              tabs: { getCurrent(): Promise<{ id?: number } | undefined> };
              storage: {
                session: {
                  get(key: string): Promise<Record<string, unknown>>;
                };
              };
            };
          }
        ).chrome;
        const key = `ya.appTabRoute.${(await chrome.tabs.getCurrent())?.id}`;
        const route = (await chrome.storage.session.get(key))[key] as
          | string
          | undefined;
        // Storage can still hold the projects route while AppBridge publishes
        // the session navigation. Wait for that navigation, not any old route.
        return route === expectedRoute ? route : undefined;
      }, sessionRoute),
    );
    expect(published).toBe(sessionRoute);
    for (const sessionUrl of [
      `${origin}${sessionRoute}`,
      `https://yepanywhere.com/remote${sessionRoute}`,
    ]) {
      await panel.goto(
        `${origin}/sidepanel.html?url=${encodeURIComponent(sessionUrl)}`,
      );
      await expect(
        panel
          .getByRole("button", { name: `Open ${ownerRepo}#${issueNumber}` })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText(/ in this session$/)).toBeVisible();
      // The session groups follow the page's own context.
      await expect(
        panel.getByRole("region", { name: "Recent" }).getByRole("listitem"),
      ).not.toHaveCount(0, { timeout: 30_000 });
    }
    const sessionShot = join(rawShots, "panel-session.png");
    await panel.screenshot({ path: sessionShot });
    log("panel listed the PR on the extension and hosted session pages");
    const githubShots: Array<{
      name: string;
      width: number;
      height: number;
      path: string;
    }> = [];
    if (githubStatus) {
      await app.goto(`${origin}/-/relay/${USERNAME}/settings/issues`);
      await expect(
        app.getByLabel("Check GitHub issue and PR status"),
      ).toBeChecked();
      await expect(
        app.getByLabel("Allow GitHub CLI credentials"),
      ).not.toBeChecked();
      for (const viewport of [
        { width: 1000, height: 600 },
        { width: 375, height: 812 },
      ]) {
        await app.setViewportSize(viewport);
        await app
          .locator('[data-settings-item="issue-github-status"]')
          .evaluate((element) => {
            element.scrollIntoView({ block: "start" });
            for (
              let parent = element.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              if (parent.scrollTop > 0) {
                parent.scrollTop = Math.max(0, parent.scrollTop - 64);
                break;
              }
            }
          });
        const path = join(rawShots, `github-settings-${viewport.width}.png`);
        await app.screenshot({ path });
        githubShots.push({
          name: `github-settings-${viewport.width}`,
          ...viewport,
          path,
        });
      }
      await panel.evaluate(async () => {
        const local = (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  get(key: string): Promise<Record<string, object>>;
                  set(value: object): Promise<void>;
                };
              };
            };
          }
        ).chrome.storage.local;
        const key = "ya.extension.settings";
        await local.set({
          [key]: { ...(await local.get(key))[key], collapseMergedPrs: true },
        });
      });
      await panel.goto(
        `${origin}/sidepanel.html?url=${encodeURIComponent(`${origin}${sessionRoute}`)}`,
      );
      const mergedToggle = panel.getByRole("button", { name: /^Merged PRs/ });
      await expect(mergedToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: 30_000,
      });
      // The local preview has the same key on a different host and remains
      // visible as unknown; only the actual GitHub merged group is hidden.
      await expect(panel.locator("#panel-merged-prs")).toBeHidden();
      await expect(
        panel.getByText("Open", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        panel.getByText("Closed", { exact: true }).first(),
      ).toBeVisible();
      await mergedToggle.click();
      await expect(
        panel.getByText("Merge commit abc1234").first(),
      ).toBeVisible();
      await panel.getByRole("button", { name: "Refresh" }).click();
      await expect(mergedToggle).toHaveAttribute("aria-expanded", "true");
      for (const viewport of [
        { width: 1000, height: 600 },
        { width: 375, height: 812 },
      ]) {
        await panel.setViewportSize(viewport);
        await mergedToggle.scrollIntoViewIfNeeded();
        const path = join(rawShots, `github-panel-${viewport.width}.png`);
        await panel.screenshot({ path });
        githubShots.push({
          name: `github-panel-${viewport.width}`,
          ...viewport,
          path,
        });
      }
      log(
        "49 GitHub items plus an unknown local-host reference grouped merged PRs, kept closed/open visible and retained manual expansion on refresh",
      );
      const requestsBeforeDisable = readFileSync(statusRequests, "utf8");
      await app.getByLabel("Check GitHub issue and PR status").click();
      await expect
        .poll(
          async () =>
            (await (await api("/issues/settings")).json()).settings
              .githubStatusEnabled,
        )
        .toBe(false);
      await panel.getByRole("button", { name: "Refresh" }).click();
      await expect(mergedToggle).toBeVisible();
      expect(readFileSync(statusRequests, "utf8")).toBe(requestsBeforeDisable);
      await app
        .getByRole("button", { name: "Clear cached status", exact: true })
        .click();
      await expect
        .poll(async () => {
          const result = await (
            await api(`/issues?sessionId=accept-impl&limit=100`)
          ).json();
          return result.items.some(
            (item: { trackerStatus?: unknown }) => item.trackerStatus,
          );
        })
        .toBe(false);
      await panel.getByRole("button", { name: "Refresh" }).click();
      await expect(mergedToggle).toHaveCount(0);
      await expect(
        panel
          .getByRole("button", {
            name: `Open ${ownerRepo.toLowerCase()}#${issueNumber}`,
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await app.getByLabel("Check GitHub issue and PR status").click();
      await expect
        .poll(
          async () =>
            (await (await api("/issues/settings")).json()).settings
              .githubStatusEnabled,
        )
        .toBe(true);
      await panel.getByRole("button", { name: "Refresh" }).click();
      await expect(mergedToggle).toBeVisible({ timeout: 15_000 });
      log(
        "checks off retained cached facts without requests; cache clear preserved items; re-enable reacquired status",
      );

      await app.goto(`${origin}${sessionRoute}`);
    }

    if (storeAssets) {
      await expect(
        app.getByText("A storage boundary for session discovery", {
          exact: true,
        }),
      ).toBeVisible();
      await app.screenshot({ path: join(shots, "01-session.png") });
      await app.reload();
      await expect(
        app.getByText("A storage boundary for session discovery", {
          exact: true,
        }),
      ).toBeVisible();
      await app.goto(`${origin}/-/relay/${USERNAME}/issues`);
      await expect(
        app.getByText("kzahel/yepanywhere#123", { exact: false }).first(),
      ).toBeVisible();
      await app.screenshot({ path: join(shots, "02-issues.png") });
    }

    // Any other page: the attention view.
    await panel.goto(
      `${origin}/sidepanel.html?url=${encodeURIComponent("https://example.com/")}`,
    );
    await expect(panel.getByText("No issue or PR on this page.")).toBeVisible();
    const recent = panel.getByRole("region", { name: "Recent" });
    await expect(recent.getByRole("listitem")).toHaveCount(3, {
      timeout: 30_000,
    });
    const otherShot = join(rawShots, "panel-other.png");
    await panel.screenshot({ path: otherShot });

    // A collapsed group stays collapsed when the panel reopens.
    const recentToggle = recent.getByRole("button", { name: /^Recent/ });
    await recentToggle.click();
    await expect(recentToggle).toHaveAttribute("aria-expanded", "false");
    await expect(recent.getByRole("listitem")).toHaveCount(0);
    await panel.reload();
    await expect(recentToggle).toHaveAttribute("aria-expanded", "false", {
      timeout: 30_000,
    });
    await expect(recent.getByRole("listitem")).toHaveCount(0);
    await recentToggle.click();
    await expect(recent.getByRole("listitem")).toHaveCount(3);
    log("panel remembered a collapsed group");

    // The new-session button opens the default host's new-session page in
    // its own popup window, which it reuses and session links leave alone.
    const newSessionPath = `/-/relay/${USERNAME}/new-session`;
    const composeOpened = context.waitForEvent("page");
    await panel.getByRole("button", { name: "+ New session" }).click();
    const compose = await composeOpened;
    await compose.waitForURL(`**${newSessionPath}`, { timeout: 30_000 });
    expect(
      await compose.evaluate(
        async () =>
          (
            await (
              globalThis as unknown as {
                chrome: {
                  windows: { getCurrent(): Promise<{ type?: string }> };
                };
              }
            ).chrome.windows.getCurrent()
          ).type,
      ),
    ).toBe("popup");
    await compose.setViewportSize({ width: 480, height: 760 });
    await expect(compose.getByRole("textbox").first()).toBeVisible({
      timeout: 30_000,
    });
    const composeShot = join(rawShots, "compose-popup.png");
    await compose.screenshot({ path: composeShot });
    const pageCount = context.pages().length;
    await compose.goto(`${origin}/-/relay/${USERNAME}/sessions/accept-impl`);
    await panel.getByRole("button", { name: "+ New session" }).click();
    await compose.waitForURL(`**${newSessionPath}`, { timeout: 30_000 });
    await panel
      .getByRole("button", { name: `Open ${implementationTitle}` })
      .click();
    await expect
      .poll(
        () =>
          context
            .pages()
            .some((page) => page.url().endsWith("/sessions/accept-impl")),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(new URL(compose.url()).pathname).toBe(newSessionPath);
    expect(context.pages()).toHaveLength(pageCount);
    // "About this" reaches the already-open form with the page's address in
    // its composer and the matching project chosen.
    await panel.goto(
      `${origin}/sidepanel.html?url=${encodeURIComponent(reference)}`,
    );
    await panel
      .getByRole("button", { name: "+ New session about this" })
      .click();
    await expect(
      compose.getByPlaceholder("Describe what you'd like help with..."),
    ).toHaveValue(`${reference.toLowerCase()}\n\n`, { timeout: 30_000 });
    expect(new URL(compose.url()).searchParams.get("projectId")).toBeTruthy();
    expect(context.pages()).toHaveLength(pageCount);
    await compose.close();
    log("new-session popup opened, was reused, and kept out of session links");

    // Settings pane: values land in chrome.storage.local.
    await app.goto(`${origin}/-/relay/${USERNAME}/settings/browser-extension`);
    await expect(
      app.getByRole("heading", { name: "Issue and PR lookup" }),
    ).toBeVisible({ timeout: 30_000 });
    const allowlist = app.getByRole("textbox", {
      name: /Only look up these repositories/,
    });
    let typed = "";
    for (const character of storeAssets ? "kzahel/*" : "tomfitag/*") {
      await allowlist.press(character);
      typed += character;
      await expect(allowlist).toHaveValue(typed, { timeout: 100 });
    }
    await allowlist.blur();
    const storedSettings = () =>
      app.evaluate(async () => {
        const stored = await (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: { get(key: string): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome.storage.local.get("ya.extension.settings");
        return stored["ya.extension.settings"] as {
          lookupAllowlist?: string[];
          badge?: string;
        };
      });
    await expect
      .poll(async () => (await storedSettings())?.lookupAllowlist)
      .toEqual([storeAssets ? "kzahel/*" : "tomfitag/*"]);
    // The app's own dropdown, not a native select: pick Off, then back.
    const badgeChoice = app.getByRole("button", { name: "Toolbar badge" });
    await badgeChoice.click();
    await app.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect.poll(async () => (await storedSettings())?.badge).toBe("off");
    await badgeChoice.click();
    const settingsShot = join(
      shots,
      storeAssets ? "03-settings.png" : "settings.png",
    );
    if (!storeAssets)
      await app.screenshot({ path: settingsShot, fullPage: true });
    await app
      .getByRole("menuitemradio", {
        name: "Sessions for this page",
        exact: true,
      })
      .click();
    await expect.poll(async () => (await storedSettings())?.badge).toBe("page");

    if (storeAssets) {
      await app
        .getByRole("heading", { name: "Issue and PR lookup" })
        .evaluate((element) => {
          element.scrollIntoView({ block: "start" });
          for (
            let parent = element.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            if (parent.scrollTop > 0) {
              parent.scrollTop -= 48;
              break;
            }
          }
        });
      await app.screenshot({ path: settingsShot });
      await app.reload();
      await expect(
        app.getByRole("heading", { name: "Issue and PR lookup" }),
      ).toBeVisible();
      if (headed) {
        // Keep the dedicated browser alive while MC drives its actual toolbar
        // and captures the native side panel beside this public issue page.
        const publicPage = await context.newPage();
        await publicPage.goto(reference);
        await publicPage.bringToFront();
        writeFileSync(
          join(repoRoot, "tasks/extension-publication/headed-ready.json"),
          JSON.stringify({ reference, profile: join(temp, "chrome") }),
        );
        await waitFor(
          "native store capture complete",
          () =>
            existsSync(
              join(repoRoot, "tasks/extension-publication/headed-done"),
            ) || undefined,
          600_000,
        );
      }
    } else {
      // Background badge: a granted PR page gets its session count with no
      // extension page involved beyond the worker.
      await panel.close();
      const page = await context.newPage();
      await page.goto(localPr);
      const badge = await waitFor(
        "badge count",
        () =>
          worker.evaluate(async (url: string) => {
            const api = (
              globalThis as unknown as {
                chrome: {
                  tabs: {
                    query(q: object): Promise<{ id: number; url: string }[]>;
                  };
                  action: { getBadgeText(d: object): Promise<string> };
                };
              }
            ).chrome;
            const [tab] = await api.tabs.query({ url });
            return tab
              ? (await api.action.getBadgeText({ tabId: tab.id })) || undefined
              : undefined;
          }, localPr),
        60_000,
      );
      expect(badge).toBe("1");
      log(`badge on the granted PR page: ${badge}`);
    }

    await app.goto(
      `${origin}/-/relay/${USERNAME}/projects/${Buffer.from(project).toString("base64url")}/sessions/accept-impl`,
    );
    // The badge scenario opened a site tab. Input acceptance is a foreground
    // interaction; hidden tabs deliberately throttle requestAnimationFrame.
    await app.bringToFront();
    expect(await app.evaluate(() => document.visibilityState)).toBe("visible");
    await expect(app.locator("[data-composer-input]")).toBeVisible();
    // Exercise real sequential input while filesystem-backed transcript
    // updates travel through the server and encrypted relay into this page.
    const transcriptFile = join(sessionDir, "accept-impl.jsonl");
    const originalTranscript = readFileSync(transcriptFile, "utf8");
    const updateRow = (index: number) =>
      JSON.stringify({
        type: "assistant",
        uuid: `extension-live-${index}`,
        parentUuid: index ? `extension-live-${index - 1}` : "accept-impl-a",
        sessionId: "accept-impl",
        cwd: project,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Concurrent extension transcript update ${index}. **Catalog review**: retain session identity, reuse prepared statements and verify resume after restart.`,
            },
          ],
        },
      });
    const composer = app.locator("[data-composer-input]");
    try {
      appendFileSync(
        transcriptFile,
        `\n${Array.from({ length: 100 }, (_, index) => updateRow(index)).join("\n")}\n`,
      );
      await expect(
        app.getByText(/Concurrent extension transcript update 99\./),
      ).toBeVisible({ timeout: 15_000 });
      await composer.evaluate((element) => {
        const measurements: number[] = [];
        (
          globalThis as unknown as { extensionInputLatency: number[] }
        ).extensionInputLatency = measurements;
        let pressedAt = 0;
        element.addEventListener(
          "keydown",
          () => {
            pressedAt = performance.now();
          },
          { capture: true },
        );
        element.addEventListener("input", () => {
          const start = pressedAt;
          requestAnimationFrame(() =>
            measurements.push(performance.now() - start),
          );
        });
      });
      const typingPanel = githubStatus ? await context.newPage() : undefined;
      if (typingPanel) {
        await typingPanel.goto(
          `${origin}/sidepanel.html?url=${encodeURIComponent(`${origin}${sessionRoute}`)}`,
        );
        await app.bringToFront();
      }
      let typed = "";
      let update = 100;
      for (const character of "Review catalog identity and resume.") {
        appendFileSync(transcriptFile, `${updateRow(update++)}\n`);
        if (typingPanel && typed.length % 7 === 0) {
          await typingPanel.getByRole("button", { name: "Refresh" }).click();
          await app.bringToFront();
        }
        await composer.press(character === " " ? "Space" : character);
        typed += character;
        await expect(composer).toHaveValue(typed, { timeout: 100 });
        await app.waitForFunction(
          (count) =>
            (globalThis as unknown as { extensionInputLatency: number[] })
              .extensionInputLatency.length >= count,
          typed.length,
          { timeout: 100 },
        );
      }
      await expect(
        app.getByText(
          new RegExp(`Concurrent extension transcript update ${update - 1}\\.`),
        ),
      ).toBeVisible({ timeout: 15_000 });
      const latency = await app.evaluate(
        () =>
          (globalThis as unknown as { extensionInputLatency: number[] })
            .extensionInputLatency,
      );
      expect(latency).toHaveLength(typed.length);
      expect(Math.max(...latency)).toBeLessThanOrEqual(100);
      log(
        `sequential composer input: ${typed.length} keys, ${Math.max(...latency).toFixed(1)} ms maximum, concurrent relay transcript updates`,
      );
    } finally {
      await composer.clear();
      writeFileSync(transcriptFile, originalTranscript);
      await app.reload();
    }
    expect(consoleErrors.filter((text) => !/favicon/.test(text))).toEqual([]);
    if (!storeAssets && existsSync(join(dist, "dev-build.json"))) {
      // Runtime reload closes extension tabs. Restore the real authenticated
      // session, its locally saved draft, and the inactive panel without any
      // manual navigation or new page to wake the replacement worker.
      const sessionUrl = `${origin}/-/relay/${USERNAME}/projects/${Buffer.from(project).toString("base64url")}/sessions/accept-impl?restore=1#reload-proof`;
      await app.goto(sessionUrl);
      const draft = app.locator("[data-composer-input]");
      await expect(draft).toBeVisible();
      await draft.pressSequentially("Draft kept across extension reload");
      const restorePanel = await context.newPage();
      const panelUrl = `${origin}/sidepanel.html`;
      await restorePanel.goto(panelUrl);
      await expect(
        restorePanel.getByRole("button", {
          name: "Reload extension",
          exact: true,
        }),
      ).toBeVisible();
      await app.bringToFront();
      const stopped = worker.waitForEvent("close");
      await restorePanel
        .getByRole("button", { name: "Reload extension", exact: true })
        .evaluate((button: HTMLButtonElement) => button.click());
      await stopped;
      await expect
        .poll(
          () =>
            context
              .pages()
              .find((page) => page !== app && page.url() === sessionUrl),
          { timeout: 30_000 },
        )
        .toBeTruthy();
      const restoredApp = context
        .pages()
        .find((page) => page !== app && page.url() === sessionUrl)!;
      try {
        await expect(restoredApp.locator("[data-composer-input]")).toHaveValue(
          "Draft kept across extension reload",
          { timeout: 30_000 },
        );
      } catch (error) {
        log(
          JSON.stringify({
            restoredUrl: restoredApp.url(),
            body: await restoredApp
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          }),
        );
        throw error;
      }
      await expect(restoredApp.getByText(/^Opened /).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(
          () =>
            context
              .pages()
              .find((page) => page !== restorePanel && page.url() === panelUrl),
          { timeout: 30_000 },
        )
        .toBeTruthy();
      const restoredPanel = context
        .pages()
        .find((page) => page !== restorePanel && page.url() === panelUrl)!;
      await expect(
        restoredPanel.getByText(
          /^\d+ (?:issues and PRs|issue or PR) in this session$/,
        ),
      ).toBeVisible({ timeout: 30_000 });
      const active = await restoredApp.evaluate(async () => {
        const chrome = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                getCurrent(): Promise<{ id: number }>;
                query(options: object): Promise<{ id: number }[]>;
              };
            };
          }
        ).chrome;
        return {
          own: (await chrome.tabs.getCurrent()).id,
          active: (
            await chrome.tabs.query({ active: true, currentWindow: true })
          )[0]?.id,
        };
      });
      expect(active.own).toBe(active.active);
      expect(
        context.pages().filter((page) => page.url() === sessionUrl),
      ).toHaveLength(1);
      for (const viewport of [
        { width: 1000, height: 600 },
        { width: 375, height: 812 },
      ]) {
        await restoredApp.setViewportSize(viewport);
        const path = join(rawShots, `restored-session-${viewport.width}.png`);
        await restoredApp.screenshot({ path });
        githubShots.push({
          name: `restored-session-${viewport.width}`,
          ...viewport,
          path,
        });
      }
      log(
        "runtime reload restored the exact session URL, unsent draft, active tab and session panel without manual recovery",
      );
    }
    if (storeAssets) {
      await app.setViewportSize({ width: 375, height: 812 });
      await app.goto(
        `${origin}/-/relay/${USERNAME}/projects/${Buffer.from(project).toString("base64url")}/sessions/accept-impl`,
      );
      await expect(composer).toBeVisible();
      await app.screenshot({ path: join(rawShots, "phone-app.png") });
      await context.close();
      const restarted = await chromium.launchPersistentContext(
        join(temp, "chrome"),
        {
          channel: "chromium",
          headless: true,
          viewport: { width: 1280, height: 800 },
          args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
          ],
        },
      );
      try {
        if (!restarted.serviceWorkers().length)
          await restarted.waitForEvent("serviceworker");
        const restored = await restarted.newPage();
        await restored.goto(`${origin}/index.html`);
        await restored.goto(
          `${origin}/-/relay/${USERNAME}/projects/${Buffer.from(project).toString("base64url")}/sessions/accept-impl`,
        );
        await expect(
          restored.getByText("A storage boundary for session discovery", {
            exact: true,
          }),
        ).toBeVisible({ timeout: 30_000 });
        log("saved login resumed after a complete browser restart");
      } finally {
        await restarted.close();
      }
    }
    emitCapturePreview(
      await writeCapturePreview({
        input: "Chrome extension acceptance",
        out: join(
          repoRoot,
          `.artifacts/extension-acceptance/preview-${Date.now()}`,
        ),
        screenshots: [
          ...(storeAssets
            ? [
                {
                  name: "session",
                  width: 1280,
                  height: 800,
                  path: join(shots, "01-session.png"),
                },
                {
                  name: "issues",
                  width: 1280,
                  height: 800,
                  path: join(shots, "02-issues.png"),
                },
                {
                  name: "phone-app",
                  width: 375,
                  height: 812,
                  path: join(rawShots, "phone-app.png"),
                },
              ]
            : []),
          ...githubShots,
          { name: "panel-pr", width: 400, height: 760, path: prShot },
          { name: "panel-session", width: 400, height: 760, path: sessionShot },
          { name: "panel-other", width: 400, height: 760, path: otherShot },
          { name: "compose-popup", width: 480, height: 760, path: composeShot },
          {
            name: "settings",
            width: storeAssets ? 1280 : 1000,
            height: 800,
            path: settingsShot,
          },
        ],
        warnings: [],
      }),
    );
    log("PASS");
  } finally {
    await context.close();
  }
} finally {
  stopAll();
  pages.close();
  rmSync(temp, { recursive: true, force: true });
}
