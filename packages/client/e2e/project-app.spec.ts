import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { e2ePaths } from "./fixtures";
import { createApp } from "../../server/test/setup/create-app";
import { createStaticRoutes } from "../../server/src/frontend/static";
import { MockServerClaudeProvider } from "../../server/src/sdk/mock";
import { ProjectMetadataService } from "../../server/src/metadata/ProjectMetadataService";
import { SessionMetadataService } from "../../server/src/metadata/SessionMetadataService";
import { DiscoverySqliteService } from "../../server/src/storage/discovery-sqlite";
import { LimitedUsersService } from "../../server/src/auth/LimitedUsersService";
import { AuthService } from "../../server/src/auth/AuthService";
import { ServerSettingsService } from "../../server/src/services/ServerSettingsService";
import { ProjectQueueService } from "../../server/src/services/ProjectQueueService";
import { initFileAccess } from "../../server/src/middleware/file-access";
import { recordUiCapture } from "./support/ui-capture";

const clientRoot = resolve(import.meta.dirname, "..");
const requireServer = createRequire(join(clientRoot, "../server/package.json"));
const requireClient = createRequire(join(clientRoot, "package.json"));
const { getRequestListener } = requireServer("@hono/node-server");
let instance: ReturnType<typeof createApp>;
let discovery: DiscoverySqliteService | undefined;
let listener: ReturnType<typeof createServer>;
let directory: string;
let base: string;
let projectId: string;
let serverAppId: string;

test.beforeAll(async () => {
  // CI36630063508 paid 2.57s of sandbox/version readiness. Setup owns it.
  test.setTimeout(30_000);
  const scratch = resolve(clientRoot, "../../.artifacts/project-app-browser");
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "run-"));
  const project = join(directory, "canvas");
  await mkdir(join(project, ".project-template"), { recursive: true });
  await mkdir(join(project, "dist"));
  await writeFile(
    join(project, ".project-template/app.json"),
    JSON.stringify({ kind: "static", dir: "dist" }),
  );
  await writeFile(
    join(project, "dist/index.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0}body{font:16px system-ui;background:#eff5fa;color:#21394f;display:grid;place-items:center}main{text-align:center;padding:24px}h1{font-size:clamp(28px,5vw,48px);font-weight:550}button{font:inherit;border:1px solid #587da0;background:white;border-radius:8px;padding:12px 18px;color:inherit}#size{position:fixed;bottom:16px;left:16px;font-size:12px;color:#587087}</style></head><body><main><h1>Sketch garden</h1><p>A canvas for your next idea.</p><button id="counter">0 ideas</button></main><output id="size"></output><script>let n=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent=(++n)+' ideas';new ResizeObserver(()=>document.querySelector('#size').textContent=innerWidth+' × '+innerHeight).observe(document.body);</script></body></html>`,
  );
  projectId = toUrlProjectId(project);
  const dataDir = join(directory, "data");
  const metadata = new ProjectMetadataService({ dataDir });
  await metadata.initialize();
  await metadata.addProject(projectId, project, "archer");
  // A process app, for serving that must start it first.
  const serverApp = join(directory, "server-app");
  await mkdir(join(serverApp, ".project-template"), { recursive: true });
  await writeFile(
    join(serverApp, "server.cjs"),
    `require("node:http").createServer((_, res) => res.end("server app")).listen(Number(process.env.PORT), "127.0.0.1");`,
  );
  await writeFile(
    join(serverApp, ".project-template/app.json"),
    JSON.stringify({
      service: {
        version: 1,
        where: { kind: "process", cwd: ".", entry: "/" },
        start: { argv: [process.execPath, "server.cjs"], portEnv: "PORT" },
        status: {
          probe: "http",
          path: "/",
          readyStatus: 200,
          startupTimeoutMs: 20000,
        },
        stop: { signal: "SIGTERM", graceMs: 2000 },
        serving: { target: "sandbox-loopback", protocol: "http" },
      },
    }),
  );
  serverAppId = toUrlProjectId(serverApp);
  await metadata.addProject(serverAppId, serverApp, "archer");
  discovery = new DiscoverySqliteService({ dataDir });
  const sessionMetadata = new SessionMetadataService({
    dataDir,
    database: discovery.getDatabase(),
  });
  await sessionMetadata.initialize();
  const limitedUsers = new LimitedUsersService({ dataDir });
  await limitedUsers.initialize();
  const settings = new ServerSettingsService({ dataDir });
  await settings.initialize();
  const projectQueue = new ProjectQueueService({ dataDir });
  await projectQueue.initialize();
  const auth = new AuthService({ dataDir });
  await auth.initialize();
  initFileAccess({
    uploadsDir: directory,
    homeDir: directory,
    tempPaths: [directory],
    envPaths: [directory],
  });
  instance = createApp({
    provider: new MockServerClaudeProvider(),
    sessionMetadataService: sessionMetadata,
    limitedUsersService: limitedUsers,
    serverSettingsService: settings,
    projectQueueService: projectQueue,
    authService: auth,
    dataDir,
    discoverySqlite: discovery,
    projectsDir: join(directory, "sessions"),
    projectMetadataService: metadata,
  });
  // Exercise the app with the invocation's built client. Cold source transforms
  // consumed the handoff assertion in CI38129869711; only the garden's own
  // live-preview server needs Vite/HMR. Missing APIs must not return SPA HTML.
  instance.app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  instance.app.route(
    "/",
    createStaticRoutes({ distPath: e2ePaths.clientDist }),
  );
  listener = createServer(getRequestListener(instance.app.fetch));
  listener.on("upgrade", (req, socket, head) =>
    instance.artifactServer.handleUpgrade(req, socket, head),
  );
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing YA port");
  base = `http://127.0.0.1:${address.port}`;
  await instance.artifactServer.configure({
    port: address.port,
    localOrigin: `http://artifacts.localhost:${address.port}`,
  });
  if (process.platform === "linux") {
    const response = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    const version = await response.json();
    expect(
      version.sessionSandboxing,
      JSON.stringify(version.sessionSandboxing),
    ).toMatchObject({ state: "available", backend: "bubblewrap" });
  }
});
test.afterAll(async () => {
  if (instance) {
    for (const process of instance.supervisor.getAllProcesses())
      await instance.supervisor.abortProcess(process.id);
    instance.stopNotifications();
    await instance.disposeSessionReaders();
    await instance.artifactServer.close();
  }
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>((ready, reject) =>
      listener.close((error) => (error ? reject(error) : ready())),
    );
  }
  discovery?.close();
  if (directory) await rm(directory, { recursive: true });
});

test("Live preview reloads Vite changes through the sandbox app proxy", async ({
  page,
}) => {
  test.skip(
    process.platform !== "linux",
    "Project-write sandbox requires Linux and Bubblewrap",
  );
  test.setTimeout(60_000);
  const project = join(directory, "canvas");
  const manifest = join(project, ".project-template/app.json");
  // Vite's config bundler chooses the nearest node_modules for its scratch;
  // keep that write inside the same project boundary as an installed template.
  await mkdir(join(project, "node_modules"), { recursive: true });
  await writeFile(
    join(project, "index.html"),
    '<html><body><h1>Live garden</h1><script type="module" src="./main.js"></script></body></html>',
  );
  await writeFile(
    join(project, "main.js"),
    'document.querySelector("h1").textContent = "Live garden one";',
  );
  await writeFile(
    join(project, "vite.config.mjs"),
    `export default { base: process.env.BASE_PATH, cacheDir: '.vite', server: { host: '127.0.0.1', port: Number(process.env.PORT), strictPort: true, allowedHosts: true, cors: true } };`,
  );
  await writeFile(
    manifest,
    JSON.stringify({
      kind: "static",
      dir: "dist",
      livePreview: {
        version: 1,
        where: { kind: "process", cwd: ".", entry: "/" },
        start: {
          argv: [
            process.execPath,
            join(
              dirname(requireClient.resolve("vite/package.json")),
              "bin/vite.js",
            ),
            "--config",
            "vite.config.mjs",
          ],
          portEnv: "PORT",
        },
        status: {
          probe: "http",
          path: "/",
          readyStatus: 200,
          startupTimeoutMs: 30000,
        },
        stop: { signal: "SIGTERM", graceMs: 5000 },
        serving: {
          target: "sandbox-loopback",
          protocol: "http",
          basePathEnv: "BASE_PATH",
        },
      },
    }),
  );
  try {
    await page.goto(`${base}/projects/${projectId}/app`);
    const app = page.getByRole("region", { name: "Project App" });
    // The failed CI trace rendered this first frame just after the 5s bound.
    // Keep a bounded cold-page allowance; HMR and later frame checks retain
    // their own deadlines and the Linux sandbox remains a required case.
    await expect(app.locator("iframe")).toBeVisible({ timeout: 15_000 });
    let connected = false;
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        if (String(payload) === '{"type":"connected"}') connected = true;
      }),
    );
    // /app/start waits for process readiness, not just request acceptance.
    // The 2026-10-26 full run exceeded 5s; allow 4x that observed bound.
    const started = page.waitForResponse(
      (response) => response.url().endsWith("/app/start"),
      { timeout: 20_000 },
    );
    await app
      .getByRole("button", { name: "Live preview", exact: true })
      .click();
    const startResponse = await started;
    expect(startResponse.ok(), await startResponse.text()).toBe(true);
    const frame = page.frameLocator('iframe[title="Project app"]');
    await expect(
      frame.getByRole("heading", { name: "Live garden one" }),
    ).toBeVisible({ timeout: 30000 });
    // Wait for the real proxied HMR connection before writing; no manual reload.
    await expect.poll(() => connected).toBe(true);
    await writeFile(
      join(project, "main.js"),
      'document.querySelector("h1").textContent = "Live garden two";',
    );
    await expect(
      frame.getByRole("heading", { name: "Live garden two" }),
    ).toBeVisible({ timeout: 10000 });
    for (const size of [
      { width: 1200, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(size);
      await expect(
        app.getByRole("button", { name: "Live preview", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await recordUiCapture(page, `project-live-preview-${size.width}`);
    }
    await app
      .getByRole("button", { name: "Live preview", exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="index.html"]')
        .getByRole("heading", { name: "Sketch garden" }),
    ).toBeVisible();
  } finally {
    await writeFile(manifest, JSON.stringify({ kind: "static", dir: "dist" }));
  }
});

test("app inventory sits below port forwards and manages addresses inline", async ({
  page,
}) => {
  test.setTimeout(60_000);
  instance.artifactServer.config.vhostPublicRoot = "apps.example";
  instance.artifactServer.config.vhosts = [
    { name: "plannotator", port: 19432 },
  ];
  for (const size of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`${base}/settings/apps`);
    const inventory = page.getByRole("region", {
      name: "Project apps",
      exact: true,
    });
    // Each app is a collection row whose name opens its options pane.
    const app = inventory.getByRole("button", { name: "canvas", exact: true });
    await expect(app).toHaveAttribute("aria-expanded", "false");
    await app.click();
    const pane = inventory.getByRole("region", { name: "canvas", exact: true });
    await expect(pane).toBeVisible();
    await expect(pane.getByText("App: ready").first()).toBeVisible();
    await expect(inventory.locator("iframe")).toHaveCount(0);
    await expect(
      inventory.getByRole("button", { name: "Start app" }),
    ).toHaveCount(0);
    const name = inventory.getByRole("textbox", {
      name: "App name",
      exact: true,
    });
    let typed = "";
    for (const character of `garden-${size.width}`) {
      typed += character;
      await name.pressSequentially(character);
      await expect(name).toHaveValue(typed, { timeout: 100 });
    }
    await inventory
      .getByRole("button", { name: "Reserve address", exact: true })
      .click();
    await expect(
      inventory.getByRole("button", { name: "Copy viewer link" }),
    ).toBeVisible();
    await inventory
      .getByRole("button", { name: "Serve at this address", exact: true })
      .click();
    await expect(
      inventory.getByRole("button", {
        name: "Stop serving at this address",
        exact: true,
      }),
    ).toBeVisible();
    await inventory.scrollIntoViewIfNeeded();
    expect(
      await inventory.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `project-app-inventory-${size.width}`);
    page.once("dialog", (dialog) => dialog.accept());
    await inventory
      .getByRole("button", { name: "Release address", exact: true })
      .click();
    await expect(name).toBeVisible();
  }
  instance.artifactServer.config.vhostPublicRoot = undefined;
  instance.artifactServer.config.vhosts = [];
});

test("serving a stopped process app starts it first, and a served stopped app warns", async ({
  page,
}) => {
  test.skip(
    process.platform !== "linux",
    "Process apps require the Linux project-write sandbox",
  );
  test.setTimeout(60_000);
  instance.artifactServer.config.vhostPublicRoot = "apps.example";
  const warning = /visitors to server-garden\.apps\.example see/;
  const inventory = page.getByRole("region", {
    name: "Project apps",
    exact: true,
  });
  const pane = inventory.getByRole("region", {
    name: "server-app",
    exact: true,
  });
  // Changing width can reflow the settings collection, so each width opens
  // the row afresh.
  async function openAt(size: { width: number; height: number }) {
    await page.setViewportSize(size);
    await page.goto(`${base}/settings/apps`);
    await inventory
      .getByRole("button", { name: "server-app", exact: true })
      .click();
    await expect(pane).toBeVisible();
  }
  try {
    await openAt({ width: 1200, height: 600 });
    await pane
      .getByRole("textbox", { name: "App name", exact: true })
      .fill("server-garden");
    await pane
      .getByRole("button", { name: "Reserve address", exact: true })
      .click();
    await pane
      .getByRole("button", { name: "Start app and serve here", exact: true })
      .click();
    const unserve = pane.getByRole("button", {
      name: "Stop serving at this address",
      exact: true,
    });
    await expect(unserve).toBeVisible({ timeout: 25_000 });
    await expect(pane.getByText("App: running")).toBeVisible();
    await expect(pane.getByText(warning)).toHaveCount(0);
    await unserve.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-start-and-serve-1200");

    await pane.getByRole("button", { name: "Stop app", exact: true }).click();
    await expect(pane.getByText(warning)).toBeVisible({ timeout: 15_000 });
    await pane.getByText(warning).scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-served-stopped-1200");

    // Opted in, an authorized visit to the stopped address starts the app.
    const autoStart = pane.getByRole("checkbox", {
      name: /Start the app when a visitor finds it stopped/,
    });
    await autoStart.check();
    await expect(autoStart).toBeChecked();
    await expect(
      pane.getByText(/next visit to server-garden\.apps\.example starts it/),
    ).toBeVisible();
    await expect(pane.getByText(warning)).toHaveCount(0);
    await autoStart.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-auto-start-1200");
    const token = instance.artifactServer.vhostAccess.token({
      name: "server-garden",
      projectId: serverAppId,
    });
    const visit = await instance.artifactServer.dispatchHost(
      new Request(`http://server-garden.apps.example/?ya_access=${token}`),
    );
    expect(visit?.status).toBe(200);
    expect(await visit!.text()).toBe("server app");

    await openAt({ width: 375, height: 812 });
    await expect(pane.getByText("App: running")).toBeVisible();
    await expect(autoStart).toBeChecked();
    await autoStart.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-auto-start-375");
    await autoStart.uncheck();
    await expect(autoStart).not.toBeChecked();
    await pane.getByRole("button", { name: "Stop app", exact: true }).click();
    await expect(pane.getByText(warning)).toBeVisible({ timeout: 15_000 });
    await pane.getByText(warning).scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-served-stopped-375");
    await pane.getByRole("button", { name: "Start app", exact: true }).click();
    await expect(pane.getByText("App: running")).toBeVisible({
      timeout: 25_000,
    });
    await expect(pane.getByText(warning)).toHaveCount(0);
    await unserve.scrollIntoViewIfNeeded();
    await recordUiCapture(page, "project-app-start-and-serve-375");
    await pane.getByRole("button", { name: "Stop app", exact: true }).click();
    await expect(pane.getByText(warning)).toBeVisible({ timeout: 15_000 });
    page.once("dialog", (dialog) => dialog.accept());
    await pane
      .getByRole("button", { name: "Release address", exact: true })
      .click();
  } finally {
    instance.artifactServer.config.vhostPublicRoot = undefined;
  }
});
test("New Session keeps launch options and restores project selection after closing App", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(`${base}/new-session?projectId=${projectId}`);
  await page.evaluate(() => {
    localStorage.setItem("yep-anywhere-project-app-composing-enabled", "true");
  });
  await page.reload();
  for (const size of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    const composer = page.locator("textarea:visible").first();
    await expect(composer).toBeVisible();
    await composer.fill("");
    let typed = "";
    for (const character of "Keep my launch options") {
      typed += character;
      await composer.pressSequentially(character);
      await expect(composer).toHaveValue(typed, { timeout: 100 });
    }
    const form = page.locator(".new-session-form");
    await form.evaluate((element) => {
      element.dataset.kept = "yes";
    });
    const advanced = page.getByRole("button", {
      name: "Show advanced options",
      exact: true,
    });
    if (await advanced.isVisible()) await advanced.click();
    const options = page.locator("[data-new-session-secondary-options]");
    await expect(options).toBeVisible();
    const before = await page.locator(".new-session-provider-slot").innerText();
    const appButton = page.getByRole("button", { name: "App", exact: true });
    await appButton.click();
    const app = page.getByRole("region", { name: "Project App" });
    await expect(app.locator("iframe")).toBeVisible();
    await expect(
      page
        .frameLocator('iframe[title="index.html"]')
        .getByRole("heading", { name: "Sketch garden" }),
    ).toBeVisible();
    if (size.width >= 1100) {
      await expect(page.locator(".new-session-provider-slot")).toBeVisible();
      await expect(options).toBeVisible();
      await expect(composer).toHaveValue(typed);
    }
    await recordUiCapture(page, `new-session-app-open-${size.width}`);
    await app.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator(".new-session-project-chooser")).toBeVisible();
    await expect
      .poll(() => page.locator(".new-session-provider-slot").innerText())
      .toBe(before);
    await expect(options).toBeVisible();
    await expect(
      page.locator('.new-session-form[data-kept="yes"]'),
    ).toBeVisible();
    await expect(composer).toHaveValue(typed);
    await composer.scrollIntoViewIfNeeded();
    await recordUiCapture(page, `new-session-app-closed-${size.width}`);
  }
});

// Real browser layout, iframe retention and key-by-key acknowledgement cannot
// be established by the route/component tests of the same API contracts.
test("project App fills the pane and retains canvas and composer across phone switches", async ({
  page,
}) => {
  // Three viewports, a session start, full view and app addresses outgrow
  // the default 15s; the first transcript fetch alone has taken 5s.
  test.setTimeout(60_000);
  for (const size of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`${base}/projects/${projectId}/app`);
    const app = page.getByRole("region", { name: "Project App" });
    const frame = app.locator("iframe");
    // CI36867518685's trace still transformed the lazy route's dependencies
    // when the old 5s frame assertion expired. Route readiness is separate
    // from iframe layout/retention; 20s is 4x that observed startup limit.
    await expect(app).toBeVisible({ timeout: 20_000 });
    await expect(frame).toBeVisible();
    const canvas = page.frameLocator('iframe[title="index.html"]');
    await canvas.getByRole("button", { name: "0 ideas" }).click();
    await expect(canvas.getByRole("button", { name: "1 ideas" })).toBeVisible();
    const bounds = await frame.boundingBox();
    expect(bounds!.height).toBeGreaterThan(size.height * 0.65);
    await recordUiCapture(page, `project-app-${size.width}`);
    const header = app.locator("header");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(33);
    await app.getByRole("button", { name: /^Collapse app toolbar/ }).click();
    expect((await header.boundingBox())!.width).toBeLessThanOrEqual(34);
    expect((await frame.boundingBox())!.height).toBeGreaterThan(
      bounds!.height + 25,
    );
    await expect(canvas.getByRole("button", { name: "1 ideas" })).toBeVisible();
    await recordUiCapture(page, `project-app-corner-${size.width}`);
    await app.getByRole("button", { name: "Show app toolbar" }).click();
    if (size.width === 1200) {
      await app
        .getByRole("button", { name: "Enter browser fullscreen" })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(true);
      await expect(
        canvas.getByRole("button", { name: "1 ideas" }),
      ).toBeVisible();
      await app
        .getByRole("button", { name: "Exit browser fullscreen" })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(false);
    }
    await app.getByRole("button", { name: "App settings" }).click();
    await expect(app.getByRole("group", { name: "App address" })).toHaveCount(
      0,
    );
    await app.getByRole("button", { name: "Back" }).click();
    await expect(canvas.getByRole("button", { name: "1 ideas" })).toBeVisible();
    await app
      .getByRole("button", { name: "New session in this project" })
      .click();
    const composer = page.locator("textarea:visible").first();
    await expect(composer).toBeVisible();
    await composer.fill("");
    let typed = "";
    for (const character of "Make the garden green") {
      typed += character;
      await composer.pressSequentially(character);
      await expect(composer).toHaveValue(typed, { timeout: 100 });
    }
    await recordUiCapture(page, `project-app-compose-${size.width}`);
    if (size.width >= 1100) {
      const composedBounds = await frame.boundingBox();
      expect(composedBounds!.height).toBeGreaterThan(size.height * 0.65);
      expect(composedBounds!.x).toBeGreaterThan(
        (await composer.boundingBox())!.x,
      );
      await composer.focus();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, "height", {
          configurable: true,
          value: innerHeight - 200,
        });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await expect
        .poll(async () => (await frame.boundingBox())!.height)
        .toBeLessThan(composedBounds!.height - 150);
      await expect(
        canvas.getByRole("button", { name: "1 ideas" }),
      ).toBeVisible();
      await page.evaluate(() => {
        Reflect.deleteProperty(window.visualViewport!, "height");
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
    }
    if (size.width < 1100) {
      await page.getByRole("button", { name: "App", exact: true }).click();
      await expect(
        canvas.getByRole("button", { name: "1 ideas" }),
      ).toBeVisible();
      await app.getByRole("button", { name: "Back" }).click();
      await expect(composer).toHaveValue(typed);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.evaluate(() =>
    localStorage.setItem("yep-anywhere-session-right-pane-enabled", "false"),
  );
  await page.goto(`${base}/projects/${projectId}/app?compose=1`);
  await expect(
    page.getByRole("region", { name: "Project App" }).locator("iframe"),
  ).toBeVisible();
  await page
    .locator("textarea:visible")
    .first()
    .fill("Help me refine this canvas");
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/session-creations"),
  );
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const receipt = await (await accepted).json();
  await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
  const sessionApp = page.getByRole("region", { name: "Project App" });
  await expect(sessionApp.locator("iframe")).toBeVisible();
  await expect(
    // Not exact: the transcript renders the reply inside list markup.
    page.getByText("Mock response (no scenario)").first(),
    // The first transcript fetch took at least 5s on the isolated fixture.
  ).toBeVisible({ timeout: 15000 });
  await page.mouse.move(10, 10);
  expect(
    (await sessionApp.locator("iframe").boundingBox())!.height,
  ).toBeGreaterThan(390);
  await recordUiCapture(page, "project-app-session-1200");
  // Full view covers the session and sidebar with the same live frame, and
  // Back returns to the session with the app still beside it.
  await sessionApp.locator("iframe").evaluate((frame) => {
    frame.dataset.kept = "yes";
  });
  await sessionApp.getByRole("button", { name: "Full view" }).click();
  await expect
    .poll(async () => (await sessionApp.boundingBox())!.width)
    .toBeGreaterThan(1190);
  expect((await sessionApp.boundingBox())!.x).toBeLessThan(1);
  await expect(sessionApp.locator("iframe[data-kept=yes]")).toBeVisible();
  await recordUiCapture(page, "project-app-full-1200");
  await sessionApp.getByRole("button", { name: "Back" }).click();
  await expect
    .poll(async () => (await sessionApp.boundingBox())!.width)
    .toBeLessThan(900);
  await expect(sessionApp.locator("iframe[data-kept=yes]")).toBeVisible();
  // Holding the header's App button opens full view directly.
  await sessionApp.getByRole("button", { name: "Back" }).click();
  await expect(sessionApp.locator("iframe")).toBeHidden();
  const appButton = page.getByRole("button", { name: "App", exact: true });
  await appButton.hover();
  await page.mouse.down();
  // Observe the browser's hold action before releasing. A delay in the test
  // runner does not establish that the browser has serviced its hold timer.
  try {
    await expect
      .poll(async () => (await sessionApp.boundingBox())!.width)
      .toBeGreaterThan(1190);
  } finally {
    await page.mouse.up();
  }
  // The click ending the hold must not close or collapse the app.
  await expect
    .poll(async () => (await sessionApp.boundingBox())!.width)
    .toBeGreaterThan(1190);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await sessionApp.boundingBox())!.width)
    .toBeLessThan(900);
  // Only the app-address configuration changes; the server and app stay live.
  instance.artifactServer.config.vhostPublicRoot = "apps.example";
  await page.goto(`${base}/projects/${projectId}/app?settings=1`);
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("archer-garden");
  await page
    .getByRole("button", { name: "Reserve address", exact: true })
    .click();
  await expect(
    page.getByText("archer-garden.apps.example", { exact: true }),
  ).toBeVisible();
  await recordUiCapture(page, "project-app-address-1200");
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "project-app-address-375");
  for (const size of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`${base}/projects`);
    await page
      .getByRole("listitem")
      .filter({ hasText: /\bcanvas\b/ })
      .getByRole("button", { name: "Open project settings" })
      .click();
    const settings = page.getByRole("dialog");
    await expect(
      settings.getByRole("group", { name: "App address" }),
    ).toBeVisible();
    await expect(settings.locator("iframe")).toHaveCount(0);
    await expect(
      settings.getByText("archer-garden.apps.example", { exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Copy viewer link" }),
    ).toBeVisible();
    // The superuser may make any app public, whatever its owner may do.
    await expect(
      settings.getByRole("checkbox", { name: "Public — no link required" }),
    ).toBeVisible();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    expect(
      await settings.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `project-settings-inline-${size.width}`);
  }
});
