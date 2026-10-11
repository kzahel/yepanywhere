import { createRequire } from "node:module";
import { createServer as createHttpServer, request } from "node:http";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createTestViteServer as createViteServer } from "./support/vite-server";
import { createApp } from "../../server/test/setup/create-app";
import { createFrontendProxy } from "../../server/src/frontend/proxy";
import { MockClaudeSDK } from "../../server/src/sdk/mock";
import { ServerSettingsService } from "../../server/src/services/ServerSettingsService";
import { initFileAccess } from "../../server/src/middleware/file-access";
import { recordUiCapture } from "./support/ui-capture";
import { presentUiCaptures } from "./support/ui-capture";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(join(clientRoot, "../server/package.json"));
const { getRequestListener } = serverRequire("@hono/node-server");
let vite: Awaited<ReturnType<typeof createViteServer>>;
let instance: ReturnType<typeof createApp>;
let listener: ReturnType<typeof createHttpServer>;
let directory: string;
let base: string;
let entry: string;
const oauthEnvironment = new Map<string, string>();

test.beforeAll(async () => {
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("YEP_VHOST_OAUTH_") && value !== undefined) {
      oauthEnvironment.set(name, value);
      delete process.env[name];
    }
  }
  const scratch = resolve(clientRoot, "../../.artifacts/artifact-browser");
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "run-"));
  const bundle = join(directory, "bundle");
  await cp(resolve(clientRoot, "../server/test/fixtures/artifact"), bundle, {
    recursive: true,
  });
  await copyFile(
    join(
      dirname(serverRequire.resolve("katex/package.json")),
      "dist/fonts/KaTeX_Main-Regular.woff2",
    ),
    join(bundle, "font.woff2"),
  );
  entry = join(bundle, "index.html");
  const settings = new ServerSettingsService({
    dataDir: join(directory, "data"),
  });
  await settings.initialize();
  initFileAccess({
    uploadsDir: directory,
    homeDir: directory,
    tempPaths: [directory],
    envPaths: [directory],
  });
  process.env.VITE_DISABLE_ONBOARDING = "true";
  process.env.VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS = "true";
  vite = await createViteServer({
    root: clientRoot,
    // The Edit-link test opens the full app at /file-view. A dependency the
    // scan misses is optimized mid-load, and the forced reload strands a page
    // on a second React copy.
    optimizeDeps: {
      entries: ["e2e/fixtures/artifact-viewer.html", "index.html"],
    },
    server: { port: 0, host: "127.0.0.1" },
  });
  await vite.listen();
  const viteAddress = vite.httpServer?.address();
  if (!viteAddress || typeof viteAddress === "string")
    throw new Error("Missing Vite port");
  instance = createApp({
    sdk: new MockClaudeSDK(),
    dataDir: join(directory, "data"),
    projectsDir: join(directory, "sessions"),
    serverSettingsService: settings,
    frontendProxy: createFrontendProxy({
      vitePort: viteAddress.port,
      viteHost: "127.0.0.1",
    }),
  });
  listener = createHttpServer(getRequestListener(instance.app.fetch));
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing YA port");
  base = `http://localhost:${address.port}`;
  const reservation = createHttpServer();
  await new Promise<void>((ready) => reservation.listen(0, "127.0.0.1", ready));
  const artifactAddress = reservation.address();
  if (!artifactAddress || typeof artifactAddress === "string")
    throw new Error("Missing artifact port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  await instance.artifactServer.configure({
    port: artifactAddress.port,
    localOrigin: `http://artifacts.localhost:${address.port}`,
  });
});

test.afterEach(async ({ page }) => {
  // Saving settings refreshes version metadata. Let intercepted responses
  // finish before Playwright closes the browser context.
  await page.unrouteAll({ behavior: "wait" });
});

test.afterAll(async () => {
  await presentUiCaptures();
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (instance) {
    instance.stopNotifications();
    await instance.disposeSessionReaders();
  }
  if (vite) await vite.close();
  if (directory) await rm(directory, { recursive: true });
  for (const [name, value] of oauthEnvironment) process.env[name] = value;
});

test("replaces the derived file address and acknowledges sequential manual typing during updates", async ({
  page,
}) => {
  const report = join(directory, "bundle", "report.html");
  await copyFile(entry, report);
  const oldPath = entry;
  const response = await page.request.post(
    `${base}/api/artifacts/vhost-sites`,
    {
      headers: { "X-Yep-Anywhere": "true" },
      data: { name: "report", path: oldPath, public: true },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?file-vhost&path=${encodeURIComponent(report)}`,
  );
  const name = page.getByRole("textbox", { name: "Address name" });
  await expect(name).toHaveValue("report");
  const replace = page.getByRole("checkbox", {
    name: "Replace an existing mapping with this name",
  });
  await expect(replace).not.toBeChecked();
  await replace.check();
  await expect(name).toHaveValue("report");
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(
      page,
      `file-vhost-replace-${viewport.width}`,
      viewport,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "Serve here", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /report.localhost/ }),
  ).toBeVisible();
  const current = await page.request.get(
    `${base}/api/artifacts/vhost-sites?path=${encodeURIComponent(report)}`,
  );
  expect((await current.json()).sites).toHaveLength(1);
  await name.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  const before = await page
    .getByTestId("background-updates")
    .getAttribute("data-updates");
  let expected = "";
  for (const character of "manual-report") {
    expected += character;
    await page.keyboard.type(character);
    await expect(name).toHaveValue(expected, { timeout: 100 });
  }
  await expect(page.getByTestId("background-updates")).not.toHaveAttribute(
    "data-updates",
    before!,
  );
  await page.getByRole("button", { name: "Serve here", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /manual-report.localhost/ }),
  ).toBeVisible();
});

test("sorts app tables by full paths and elides their paths responsively", async ({
  page,
}) => {
  const roots = [
    "/home/graehl/projects/a-very-long-workspace-name/research/alpha/site/report.html",
    "/home/graehl/projects/a-very-long-workspace-name/research/zeta/site/index.html",
  ];
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.current = "0.9.4";
    body.artifactViewer.vhostSites = [
      { name: "zeta", path: roots[1], public: true },
      { name: "alpha", path: roots[0], public: true },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/artifacts/vhost-sites", (route) =>
    route.fulfill({ json: { sites: [] } }),
  );
  await page.route("**/api/project-apps", (route) =>
    route.fulfill({
      json: {
        projects: [
          ...roots.map((path, index) => ({
            projectId: `project-${index}`,
            name: index ? "Zeta" : "Alpha",
            path: dirname(path),
            info: { state: "ready" },
          })),
          {
            projectId: "short-home",
            name: "Short home",
            path: "/home/graehl/archer/scooter-parkour",
            info: { state: "ready" },
          },
          {
            projectId: "short-root",
            name: "Short absolute",
            path: "/tmp/compact-probe",
            info: { state: "ready" },
          },
        ],
        reservations: roots.map((_, index) => ({
          projectId: `project-${index}`,
          name: index ? "zeta" : "alpha",
          namespace: "apps.test",
          owner: "superuser",
        })),
      },
    }),
  );
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  const vhosts = page.getByRole("table", { name: "Hosted apps" });
  const projects = page.getByRole("table", { name: "Project apps" });
  await vhosts.getByRole("button", { name: "Serves", exact: true }).click();
  await expect(vhosts.locator("tbody tr").first()).toContainText("alpha");
  await vhosts.getByRole("button", { name: "Serves", exact: true }).click();
  await expect(vhosts.locator("tbody tr").first()).toContainText("zeta");
  await projects
    .getByRole("button", { name: "Project folder", exact: true })
    .click();
  await expect(projects.locator("tbody tr").first()).toContainText(
    "Short home",
  );
  await projects
    .getByRole("button", { name: "Project folder", exact: true })
    .click();
  await expect(projects.locator("tbody tr").first()).toContainText(
    "Short absolute",
  );
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of [
      "/home/graehl/archer/scooter-parkour",
      "/tmp/compact-probe",
    ]) {
      const gap = await projects.getByTitle(path).evaluate((element) => {
        const prefix = element.firstElementChild!;
        const tail = prefix.nextElementSibling!;
        const ink = document.createRange();
        ink.selectNodeContents(prefix);
        return (
          tail.getBoundingClientRect().left - ink.getBoundingClientRect().right
        );
      });
      expect(gap).toBeLessThanOrEqual(0.5);
    }
    for (const [table, name] of [
      [vhosts, "vhosts"],
      [projects, "project-apps"],
    ] as const) {
      await table.scrollIntoViewIfNeeded();
      await recordUiCapture(page, `${name}-paths-${viewport.width}`, viewport);
      const bounds = await table
        .locator("[title]")
        .first()
        .evaluate((element) => ({
          width: element.clientWidth,
          childWidth: [...element.children].reduce(
            (sum, child) => sum + child.getBoundingClientRect().width,
            0,
          ),
        }));
      expect(bounds.childWidth).toBeLessThanOrEqual(bounds.width + 1);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("minimizes app details and confirms distinct app and project deletions", async ({
  page,
}) => {
  const projects = [
    {
      projectId: "canvas",
      name: "Canvas",
      path: "/home/graehl/archer/scooter-parkour",
      info: { state: "ready" },
    },
    {
      projectId: "probe",
      name: "Probe",
      path: "/tmp/compact-probe",
      info: { state: "ready" },
    },
  ];
  const deletedApps: string[] = [];
  const deletedProjects: string[] = [];
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.current = "0.9.4";
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/project-apps", (route) =>
    route.fulfill({
      json: {
        projects: projects.filter(
          (row) => !deletedApps.includes(row.projectId),
        ),
        reservations: [],
      },
    }),
  );
  await page.route("**/api/projects/*/app", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    if (route.request().method() === "DELETE") {
      deletedApps.push(id);
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({
      json: {
        projectId: id,
        state: "ready",
        declaration: null,
        latestArtifact: null,
        canExecute: true,
        removedFrom: [],
      },
    });
  });
  await page.route("**/api/projects/*/app/address", (route) =>
    route.fulfill({ json: { enabled: false, reservations: [] } }),
  );
  await page.route("**/api/projects/*", (route) => {
    expect(route.request().method()).toBe("DELETE");
    deletedProjects.push(
      new URL(route.request().url()).pathname.split("/")[3]!,
    );
    return route.fulfill({ json: { removed: true } });
  });
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  const inventory = page.getByRole("region", { name: "Project apps" });
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    const trigger = inventory.getByRole("button", {
      name: "Canvas",
      exact: true,
    });
    await trigger.click();
    await expect(
      inventory.getByRole("button", { name: "Delete app", exact: true }),
    ).toBeVisible();
    const minimize = inventory.getByRole("button", {
      name: "Minimize details",
      exact: true,
    });
    await expect(minimize).toHaveText("_");
    await minimize.scrollIntoViewIfNeeded();
    await recordUiCapture(
      page,
      `app-delete-controls-${viewport.width}`,
      viewport,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await minimize.click();
    await expect(trigger).toBeFocused();
  }
  await inventory.getByRole("button", { name: "Canvas", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await inventory
    .getByRole("button", { name: "Delete app", exact: true })
    .click();
  expect(deletedApps).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await inventory
    .getByRole("button", { name: "Delete app", exact: true })
    .click();
  await expect(
    inventory.getByRole("button", { name: "Canvas", exact: true }),
  ).toHaveCount(0);
  expect(deletedApps).toEqual(["canvas"]);
  expect(deletedProjects).toEqual([]);
  await inventory.getByRole("button", { name: "Probe", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await inventory
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(
    inventory.getByRole("button", { name: "Probe", exact: true }),
  ).toHaveCount(0);
  // App removal can invalidate the row before the subsequent project DELETE
  // arrives. Join that operation rather than using row disappearance as its
  // acknowledgement.
  await expect.poll(() => deletedApps).toEqual(["canvas", "probe"]);
  await expect.poll(() => deletedProjects).toEqual(["probe"]);
});

test("edits mapped source from default sanitized HTML and preserves a stale preview", async ({
  page,
}) => {
  const sourcePath = join(directory, "bundle", "section.qmd");
  const htmlPath = join(directory, "bundle", "editable.html");
  const original = `# Title\n\nThe original paragraph.\n${"Context line\n".repeat(3000)}`;
  await writeFile(sourcePath, original);
  await writeFile(
    htmlPath,
    `<!doctype html><html><head><style>body{font:20px Georgia;padding:32px;line-height:1.5}</style></head><body><h1>Field notes</h1><!-- ya-source-target:v1 {"id":"intro","source":"section.qmd","sourceRange":[[2,0],[3,0]]} --><p>The original paragraph.</p><!-- /ya-source-target:v1 intro --></body></html>`,
  );
  await page.setViewportSize({ width: 1200, height: 600 });
  let unsupportedRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/artifacts")
      unsupportedRequests++;
  });
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?editor&path=${encodeURIComponent(htmlPath)}`,
  );
  await expect(
    page
      .frameLocator(`iframe[title="editable.html"]`)
      .getByRole("heading", { name: "Field notes" }),
  ).toBeVisible();
  expect(unsupportedRequests).toBe(0);
  await page.getByRole("button", { name: "Edit mode", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit source" });
  await expect(dialog).toBeVisible();
  const preview = page.frameLocator('iframe[title="Preview"]');
  await preview.getByText("The original paragraph.").click();
  const textarea = dialog.getByRole("textbox", { name: "Source", exact: true });
  await expect(textarea).toHaveValue(original);
  expect(
    await textarea.evaluate(
      (input: HTMLTextAreaElement) => input.selectionStart,
    ),
  ).toBe(9);
  let typed = "";
  const updatesBefore = Number(
    await page.getByTestId("background-updates").getAttribute("data-updates"),
  );
  for (const character of "New text. ") {
    typed += character;
    await textarea.pressSequentially(character);
    await expect(textarea).toHaveValue(
      original.slice(0, 9) + typed + original.slice(9),
      { timeout: 100 },
    );
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Source saved");
  expect(
    Number(
      await page.getByTestId("background-updates").getAttribute("data-updates"),
    ),
  ).toBeGreaterThan(updatesBefore);
  expect(await readFile(sourcePath, "utf8")).toBe(
    original.replace("The original", "New text. The original"),
  );
  await expect(preview.getByText("The original paragraph.")).toBeVisible();
  await expect(
    dialog.getByText(/line references may now be stale/),
  ).toBeVisible();
  await recordUiCapture(page, "source-editor-desktop", {
    width: 1200,
    height: 600,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(textarea).toBeVisible();
  await recordUiCapture(page, "source-editor-phone", {
    width: 375,
    height: 812,
  });
  await textarea.pressSequentially("Keep draft");
  await writeFile(sourcePath, "External writer\n");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("file changed");
  await expect(textarea).toHaveValue(/Keep draft/);
  expect(await readFile(sourcePath, "utf8")).toBe("External writer\n");
});

test("viewer icon modes toggle locally and open through Shift and middle clicks", async ({
  page,
  context,
}) => {
  // CI 36665933364: cold fixture 6.6s + first popup 5.7s exhausted 15s
  // during the second gesture. Keep two full mode boots and use the verified
  // URL for each duplicate gesture; 30s is twice the observed deadline.
  test.setTimeout(30_000);
  // CI 36972149383 missed the 5s edit-dialog deadline; its retry needed
  // 4.869s for that assertion and 18.6s overall. The earlier cold popup
  // measured 5.7s (CI 36665933364). Give each first mode boot 15s (~2.6x
  // that observed maximum), retaining the 30s case and all gesture checks.
  const modeBootTimeout = 15_000;
  const htmlPath = join(directory, "bundle", "mode-controls.html");
  await writeFile(htmlPath, "<!doctype html><h1>Viewer mode controls</h1>");
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?editor&path=${encodeURIComponent(htmlPath)}`,
  );
  const edit = page.getByRole("button", { name: "Edit mode", exact: true });
  const run = page.getByRole("button", {
    name: "Run full HTML/CSS/JavaScript preview (current view is sanitized)",
    exact: true,
  });
  await expect(edit).toHaveAttribute("aria-pressed", "false");
  await expect(run).toHaveAttribute("aria-pressed", "false");
  for (const control of [edit, run]) {
    const box = await control.boundingBox();
    expect(box?.width).toBe(36);
    expect(box?.height).toBe(36);
    expect(await control.locator("svg").count()).toBe(1);
    let verifiedModeUrl: string | undefined;
    for (const gesture of ["shift", "middle"]) {
      const opened = context.waitForEvent("page");
      await control.click(
        gesture === "shift" ? { modifiers: ["Shift"] } : { button: "middle" },
      );
      const tab = await opened;
      if (verifiedModeUrl) {
        // Both real gestures must open the same mode without toggling the
        // source viewer. The first tab already verifies that mode end to end.
        await tab.waitForURL(verifiedModeUrl, { waitUntil: "commit" });
      } else if (control === edit) {
        await tab.waitForURL("**/file-view?**");
        await expect(
          tab.getByRole("dialog", { name: "Edit source", exact: true }),
        ).toBeVisible({ timeout: modeBootTimeout });
        await expect(
          tab.getByRole("button", { name: "Exit edit mode" }),
        ).toHaveAttribute("aria-pressed", "true");
      } else {
        await tab.waitForURL("**/file-view?**");
        await expect(
          tab.getByRole("button", { name: "Stop interactive preview" }),
        ).toHaveAttribute("aria-pressed", "true", { timeout: modeBootTimeout });
      }
      verifiedModeUrl ??= tab.url();
      await expect(control).toHaveAttribute("aria-pressed", "false");
      await tab.close();
    }
  }
  await run.click();
  const stop = page.getByRole("button", { name: "Stop interactive preview" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await stop.click();
  await expect(run).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.locator('iframe[title="mode-controls.html"]'),
  ).toHaveAttribute("sandbox", "allow-same-origin");
});

test("finds within a running artifact frame only, from its own Ctrl+F", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "findable.html");
  await writeFile(
    htmlPath,
    `<!doctype html><title>Findable</title><p>alpha beta</p><p>beta gamma</p><div style="height:3000px"></div><p id="last">last beta</p>`,
  );
  const grant = await instance.artifactServer.createGrant(htmlPath, "local");
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(
    `${base}/file-view?mode=interactive&artifactUrl=${encodeURIComponent(grant.url)}`,
  );
  const findBox = page.getByRole("searchbox", { name: "Find in this view" });
  // The agent announced itself, and a desktop header has room for the field.
  await expect(findBox).toBeVisible();
  const frame = page.frameLocator('iframe[title="findable.html"]');
  await frame.getByText("alpha beta").click();
  await page.keyboard.press("Control+f");
  await expect(findBox).toBeFocused();
  await page.keyboard.type("beta");
  const count = page.getByRole("search").getByText("1/3");
  await expect(count).toBeVisible();
  // The viewer page's own URL names the file too, so match the frame's origin.
  const child = page
    .frames()
    .find((f) => new URL(f.url()).hostname === "artifacts.localhost");
  if (!child) throw new Error("Missing artifact frame");
  expect(await child.evaluate(() => CSS.highlights.get("yep-find")?.size)).toBe(
    3,
  );
  // The YA page's own text is not searched.
  expect(
    await page.evaluate(() => CSS.highlights.get("yep-find")?.size ?? 0),
  ).toBe(0);
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByRole("search").getByText("3/3")).toBeVisible();
  await expect(frame.locator("#last")).toBeInViewport();
  await recordUiCapture(page, "viewer-find-artifact-1200");
  await page.keyboard.press("Escape");
  await expect(findBox).toHaveValue("");
  // The frame clears on a posted message, so its highlights drop a moment
  // after the field empties.
  await expect
    .poll(() => child.evaluate(() => CSS.highlights.get("yep-find")?.size ?? 0))
    .toBe(0);
  // Focus is back in the frame, so its Ctrl+F reopens the field.
  await page.keyboard.press("Control+f");
  await expect(findBox).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.keyboard.type("gamma");
  await expect(page.getByRole("search").getByText("1/1")).toBeVisible();
  await recordUiCapture(page, "viewer-find-artifact-375");
});

test("hands a framed PDF to a new tab through the viewer, never a popup", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "handoff.html");
  await writeFile(
    htmlPath,
    `<!doctype html><title>Handoff</title><a href="paper.pdf">Paper</a>`,
  );
  await writeFile(join(directory, "bundle", "paper.pdf"), "%PDF-1.4 stub");
  const grant = await instance.artifactServer.createGrant(htmlPath, "local");
  await page.goto(
    `${base}/file-view?mode=interactive&artifactUrl=${encodeURIComponent(grant.url)}`,
  );
  const element = page.locator('iframe[title="handoff.html"]');
  await expect(element).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-downloads",
  );
  const frame = page.frameLocator('iframe[title="handoff.html"]');
  await frame.getByRole("link", { name: "Paper" }).click();
  const open = frame.getByRole("button", { name: "Open PDF in a new tab" });
  await expect(open).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 600 });
  await recordUiCapture(page, "artifact-pdf-handoff-1000");
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "artifact-pdf-handoff-375");
  // The frame itself cannot open a window, so it holds no route to the
  // YA tab through a popup's opener.
  const child = page
    .frames()
    .find((f) => new URL(f.url()).hostname === "artifacts.localhost");
  if (!child) throw new Error("Missing artifact frame");
  expect(
    await child.evaluate(() => window.open("paper.pdf", "_blank") === null),
  ).toBe(true);
  // Headless Chromium reports no URL for a PDF tab, so match its request.
  const pdfUrl = new URL("paper.pdf", grant.url).href;
  const opened = page.context().waitForEvent("page");
  const requested = page
    .context()
    .waitForEvent("request", (request) => request.url() === pdfUrl);
  await open.click();
  const tab = await opened;
  expect((await requested).frame().page()).toBe(tab);
  // Playwright's opener() names the initiating page even for noopener, so
  // ask the tab itself.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
});

test("saves a file the framed artifact builds in the page", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "blob-download.html");
  await writeFile(
    htmlPath,
    `<!doctype html><title>Blob download</title>
<button id="save">Download</button>
<script>
document.getElementById("save").addEventListener("click", () => {
  const blob = new Blob(["saved by the artifact"], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "notes.txt";
  document.body.append(link);
  link.click();
  link.remove();
});
</script>`,
  );
  const grant = await instance.artifactServer.createGrant(htmlPath, "local");
  await page.goto(
    `${base}/file-view?mode=interactive&artifactUrl=${encodeURIComponent(grant.url)}`,
  );
  const frame = page.frameLocator('iframe[title="blob-download.html"]');
  const downloaded = page.waitForEvent("download");
  await frame.getByRole("button", { name: "Download" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("notes.txt");
  const path = await download.path();
  expect(await readFile(path, "utf8")).toBe("saved by the artifact");
});

test("finds within the scriptless preview without giving it scripts", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "static-find.html");
  await writeFile(
    htmlPath,
    "<!doctype html><h1>Static find</h1><p>needle one</p><p>needle two</p>",
  );
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?editor&path=${encodeURIComponent(htmlPath)}`,
  );
  const preview = page.locator('iframe[title="static-find.html"]');
  await expect(preview).toHaveAttribute("sandbox", "allow-same-origin");
  const frame = page.frameLocator('iframe[title="static-find.html"]');
  await expect(frame.getByText("needle one")).toBeVisible();
  await recordUiCapture(page, "viewer-find-local-idle-1200");
  await frame.getByText("needle one").click();
  await page.keyboard.press("Control+f");
  const findBox = page.getByRole("searchbox", { name: "Find in this view" });
  await expect(findBox).toBeFocused();
  // Typed into the field while the fixture re-renders every 25ms.
  await page.keyboard.type("needle", { delay: 20 });
  await expect(findBox).toHaveValue("needle");
  await expect(page.getByRole("search").getByText("1/2")).toBeVisible();
  await recordUiCapture(page, "viewer-find-local-1200");
  const child = page
    .frames()
    .find((candidate) => candidate.url().startsWith("about:srcdoc"));
  if (!child) throw new Error("Missing preview frame");
  expect(
    await preview.evaluate(
      (element: HTMLIFrameElement) =>
        (element.contentWindow as typeof globalThis | null)?.CSS.highlights.get(
          "yep-find",
        )?.size,
    ),
  ).toBe(2);
  // Same-origin grants the viewer access, not the preview any scripts: a
  // script element added to the document does not run.
  expect(
    await child.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.title = 'ran'";
      document.body.append(script);
      return document.title;
    }),
  ).toBe("");
});

test("sanitized preview section links scroll within the document", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "sections.html");
  await writeFile(
    htmlPath,
    '<!doctype html><base href="https://example.invalid/"><p><a href="#far">Jump to far section</a></p><div style="height:4000px"></div><h2 id="far">Far section</h2><div style="height:1000px"></div>',
  );
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?editor&path=${encodeURIComponent(htmlPath)}`,
  );
  const preview = page.frameLocator('iframe[title="sections.html"]');
  await preview.getByRole("link", { name: "Jump to far section" }).click();
  // Resolving against the embedding page would navigate the frame to YA.
  await expect(
    preview.getByRole("heading", { name: "Far section" }),
  ).toBeInViewport();
  const frame = page
    .frames()
    .find((candidate) => candidate.url().startsWith("about:srcdoc"));
  expect(frame?.url()).toBe("about:srcdoc#far");
});

test("sanitized preview relative links open the neighboring file in the viewer", async ({
  page,
}) => {
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?links&path=${encodeURIComponent("/docs/cv/index.html")}`,
  );
  const preview = page.frameLocator('iframe[title="Linked notes"]');
  const link = preview.getByRole("link", { name: "Paper PDF" });
  // Resolved on the file, not on the embedding page's route.
  await expect(link).toHaveAttribute(
    "href",
    `/api/local-file?path=${encodeURIComponent("/docs/cv/paper.pdf")}`,
  );
  await expect(
    preview.getByRole("link", { name: "Elsewhere" }),
  ).toHaveAttribute("href", "https://example.invalid/");
  await link.click();
  await expect(page.getByTestId("opened-path")).toHaveText(
    "/docs/cv/paper.pdf",
  );
  // The viewer took the click, so the frame stayed on the preview.
  expect(
    page.frames().some((frame) => frame.url().startsWith("about:srcdoc")),
  ).toBe(true);
});

test("artifact Edit links open an authenticated editor tab and preserve the original view", async ({
  page,
  context,
}) => {
  const grant = await instance.artifactServer.createGrant(entry, "local");
  await page.goto(
    `${base}/file-view?mode=edit&artifactUrl=${encodeURIComponent(grant.url)}`,
  );
  await page.getByRole("button", { name: "Exit edit mode" }).click();
  const edit = page.getByRole("button", { name: "Edit mode", exact: true });
  for (const gesture of ["shift", "middle"]) {
    const opened = context.waitForEvent("page");
    await edit.click(
      gesture === "shift" ? { modifiers: ["Shift"] } : { button: "middle" },
    );
    const tab = await opened;
    await expect(
      tab.getByRole("dialog", { name: "Edit source", exact: true }),
    ).toBeVisible();
    await expect(
      tab.getByRole("textbox", { name: "Source", exact: true }),
    ).toHaveValue(/<!doctype html>/i);
    await expect(edit).toHaveAttribute("aria-pressed", "false");
    await tab.close();
  }
});

test("edits ordinary HTML without source maps and hides Edit on older servers", async ({
  page,
}) => {
  const htmlPath = join(directory, "bundle", "plain.html");
  await writeFile(htmlPath, "<!doctype html><p>Plain HTML</p>");
  const url = `${base}/e2e/fixtures/artifact-viewer.html?editor&path=${encodeURIComponent(htmlPath)}`;
  await page.goto(url);
  await page.getByRole("button", { name: "Edit mode", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit source" });
  const text = dialog.getByRole("textbox", { name: "Source", exact: true });
  await expect(text).toHaveValue("<!doctype html><p>Plain HTML</p>");
  await text.press("End");
  await text.pressSequentially("<!-- saved -->");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => readFile(htmlPath, "utf8"))
    .toContain("<!-- saved -->");
  await dialog.getByRole("button", { name: "Exit edit mode" }).click();
  await page.route("**/api/version*", (route) =>
    route.fulfill({
      json: { current: "0.9.0", capabilityEncoding: 1, capabilityBits: [] },
    }),
  );
  let newRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/file-edit") newRequests++;
  });
  await page.goto(url);
  await expect(
    page.frameLocator('iframe[title="plain.html"]').getByText("Plain HTML"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit mode", exact: true }),
  ).toHaveCount(0);
  expect(newRequests).toBe(0);
});

test("loads the bundle through the same port, preserves scripts, and denies YA access", async ({
  page,
}, testInfo) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(
    `${base}/e2e/fixtures/artifact-viewer.html?path=${encodeURIComponent(entry)}`,
  );
  await page
    .getByRole("button", { name: "Run full HTML/CSS/JavaScript preview" })
    .click();
  const frame = page.frameLocator("iframe");
  await expect(frame.getByRole("status")).toHaveText("3 sample notes");
  await frame.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(
    frame.getByRole("link", { name: "Project details" }),
  ).toBeVisible();
  await frame.getByPlaceholder("Write something").fill("A saved idea");
  await frame.getByRole("button", { name: "Save note" }).click();
  await expect(frame.getByRole("status")).toHaveText("Note saved");
  const child = page.frames().find((frame) => frame.url().includes("/a/"));
  if (!child) throw new Error("Missing artifact frame");
  expect(
    await child.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check("17px ArtifactFont");
    }),
  ).toBe(true);
  expect(
    await child.evaluate(() => localStorage.getItem("artifact-note")),
  ).toBe("A saved idea");
  expect(
    await child.evaluate(() => {
      try {
        return parent.document.title;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  expect(
    await child.evaluate(async () => (await fetch("/api/version")).status),
  ).toBe(404);
  const artifacts = resolve(
    clientRoot,
    "../../.artifacts/ui-testing/2026-09-07-artifact-viewer",
  );
  await mkdir(artifacts, { recursive: true });
  await child.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(artifacts, `${testInfo.project.name}-desktop.png`),
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await child.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(artifacts, `${testInfo.project.name}-phone.png`),
  });
  await frame.getByRole("link", { name: "Project details" }).click();
  await expect(
    frame.getByRole("heading", { name: "Project details" }),
  ).toBeVisible();
  expect(problems).toEqual([]);
  const url = child.url();
  await page.getByRole("button", { name: "Stop interactive preview" }).click();
  await expect(
    page.getByRole("button", { name: "Run full HTML/CSS/JavaScript preview" }),
  ).toBeVisible();
  await expect(
    frame.getByRole("heading", { name: "Static preview" }),
  ).toBeVisible();
  // Stopping this view preserves a borrowed URL already opened in another tab.
  expect((await instance.artifactServer.app.request(url)).status).toBe(200);
});

test("saves artifact expiry without revoking links, alongside addresses and port", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  await expect(
    page.getByRole("heading", { name: "Interactive HTML artifacts" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Local artifact address", { exact: true }),
  ).toHaveValue(instance.artifactServer.config.localOrigin!);
  const original = await instance.artifactServer.createGrant(entry, "local");
  const slider = page.getByRole("slider", { name: "Link expiry (days)" });
  await expect(slider).toHaveValue("7");
  await slider.focus();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  const numeric = page.getByRole("spinbutton", { name: "Link expiry (days)" });
  await expect(numeric).toHaveValue("2");
  await numeric.fill("12");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/artifacts/config") &&
      response.request().method() === "PUT" &&
      response.request().postDataJSON().expiryDays === 12,
  );
  await numeric.press("Tab");
  await expect(slider).toHaveValue("12");
  expect((await saved).ok()).toBe(true);
  await expect.poll(() => instance.artifactServer.config.expiryDays).toBe(12);
  const persisted = new ServerSettingsService({
    dataDir: join(directory, "data"),
  });
  await persisted.initialize();
  expect(persisted.getSetting("artifactViewer")?.expiryDays).toBe(12);
  expect(
    (
      await instance.artifactServer.app.request(original.url, {
        method: "HEAD",
      })
    ).status,
  ).toBe(200);
  // The original link still has over half the new lifetime left, so reopening
  // its file reuses it; a file with no live link gets the new lifetime.
  const reopened = await instance.artifactServer.createGrant(entry, "local");
  expect(reopened).toMatchObject({ id: original.id, reused: true });
  const later = join(dirname(entry), "later.html");
  await writeFile(later, "<!doctype html><p>Later</p>");
  const start = Date.now();
  const longer = await instance.artifactServer.createGrant(later, "local");
  const twelveDays = 12 * 24 * 3600_000;
  expect(longer.expiresAt).toBeGreaterThanOrEqual(start + twelveDays);
  expect(longer.expiresAt).toBeLessThanOrEqual(Date.now() + twelveDays);
  await page
    .getByLabel("Public artifact address (optional)")
    .fill("https://artifacts.example.test");
  await page.getByLabel("Public artifact address (optional)").press("Tab");
  await expect
    .poll(() => instance.artifactServer.config.publicOrigin)
    .toBe("https://artifacts.example.test");
  const health = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: instance.artifactServer.config.port,
          path: "/health",
          headers: { Host: "artifacts.example.test" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  expect(health).toEqual({ status: 200, body: '{"artifactViewer":1}' });
  await page
    .getByLabel("Public vhost root (optional)")
    .fill("apps.example.test");
  await page.getByLabel("Public vhost root (optional)").press("Tab");
  await page.getByLabel("Always rewrite *.localhost app links").check();
  await expect
    .poll(() => instance.artifactServer.config)
    .toMatchObject({
      vhostPublicRoot: "apps.example.test",
      alwaysRewriteVhostLinks: true,
    });
  await page
    .getByLabel("Always rewrite *.localhost app links")
    .scrollIntoViewIfNeeded();
  await recordUiCapture(page, `${testInfo.project.name}-settings-desktop`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByLabel("Always rewrite *.localhost app links")
    .scrollIntoViewIfNeeded();
  await recordUiCapture(page, `${testInfo.project.name}-settings-phone`);
  await page.getByLabel("Public artifact address (optional)").fill("");
  await page.getByLabel("Enable local artifact access").uncheck();
  await expect.poll(() => instance.artifactServer.available).toBe(false);
});

test("shows the public-copy action in the artifact link menu", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?menu`);
  await expect(page.getByRole("menuitem")).toHaveText([
    "Open",
    "Download",
    "Copy public URL",
  ]);
  await recordUiCapture(page, `${testInfo.project.name}-public-menu-desktop`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await recordUiCapture(page, `${testInfo.project.name}-public-menu-phone`);
});

test("omits expiry controls and writes when older metadata lacks the field", async ({
  page,
}) => {
  await instance.artifactServer.configure({
    ...instance.artifactServer.config,
    expiryDays: 2,
  });
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // An older server advertises neither unit, so no expiry control appears.
    delete body.artifactViewer.expiryHours;
    delete body.artifactViewer.expiryDays;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  await expect(
    page.getByRole("heading", { name: "Interactive HTML artifacts" }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "Link expiry (days)" }),
  ).toHaveCount(0);
  const write = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/artifacts/config") &&
      request.method() === "PUT",
  );
  await page.getByLabel("Public artifact address (optional)").focus();
  await page.getByLabel("Public artifact address (optional)").press("Tab");
  expect((await write).postDataJSON()).not.toHaveProperty("expiryDays");
  await expect(page.getByRole("status")).toHaveText("Artifact settings saved");
  expect(instance.artifactServer.config.expiryDays).toBe(2);
});

test("edits OAuth email rows without losing sequential input during updates", async ({
  page,
}) => {
  await instance.artifactServer.configure({
    ...instance.artifactServer.config,
    publicOrigin: "https://files.example.net",
    vhostPublicRoot: "example.net",
    vhosts: [{ name: "memo", port: 19432 }],
    vhostSites: [],
  });
  await instance.artifactServer.vhostOauth.configure({
    provider: {
      kind: "entra",
      tenantId: "common",
      issuer: "",
      clientId: "test-client",
      callbackUrl: "https://auth.example.net/callback",
      visitorIp: "peer",
    },
    secret: "test-only",
  });
  await instance.artifactServer.vhostOauth.setPolicy("memo", ["*@*"]);
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  const providerSection = page
    .locator("summary")
    .filter({ hasText: "Hosted sign-in provider" });
  await providerSection.click();
  const enabled = page.getByRole("checkbox", {
    name: "Enable hosted sign-in",
    exact: true,
  });
  await expect(enabled).toBeChecked();
  await page.getByText("Provider settings", { exact: true }).click();
  const secret = page.getByLabel(
    "Client secret value (leave blank to keep existing)",
    { exact: true },
  );
  await expect(secret).toHaveAttribute("type", "password");
  let typedSecret = "";
  await secret.focus();
  for (const character of "new-test-secret-abcd") {
    typedSecret += character;
    await page.keyboard.type(character);
    await expect(secret).toHaveValue(typedSecret, { timeout: 100 });
  }
  await expect(secret).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Save sign-in provider", exact: true })
    .click();
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("placeholder", "••••abcd");
  const provider = page.getByRole("combobox", {
    name: "Hosted sign-in provider (OAuth)",
    exact: true,
  });
  await provider.selectOption("google");
  await expect(page.getByLabel("OpenID Connect issuer URL")).toHaveValue(
    "https://accounts.google.com",
  );
  await expect(secret).toHaveAttribute("placeholder", "");
  await secret.fill("google-test-secret-abcd");
  await page.getByRole("button", { name: "Save sign-in provider" }).click();
  await expect
    .poll(() => instance.artifactServer.vhostOauth.status().provider.kind)
    .toBe("oidc");
  expect(instance.artifactServer.vhostOauth.status().provider.issuer).toBe(
    "https://accounts.google.com",
  );
  await provider.selectOption("entra");
  await secret.fill("new-test-secret-abcd");
  await page.getByRole("button", { name: "Save sign-in provider" }).click();
  await expect
    .poll(() => instance.artifactServer.vhostOauth.status().provider.kind)
    .toBe("entra");
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await secret.evaluate((input) =>
      input.closest("label")!.scrollIntoView({ block: "start" }),
    );
    await recordUiCapture(page, `vhost-provider-${viewport.width}`, viewport);
  }
  await providerSection.click();
  await page
    .getByRole("button", { name: "Sign-in required", exact: true })
    .click();
  const email = page.getByRole("textbox", {
    name: "Allowed email or domain 1",
    exact: true,
  });
  await expect(email).toBeFocused();
  expect(
    await email.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, 3]);
  const before = await page
    .getByTestId("background-updates")
    .getAttribute("data-updates");
  let expected = "";
  for (const character of "*@rws.com") {
    expected += character;
    await page.keyboard.type(character);
    await expect(email).toHaveValue(expected, { timeout: 100 });
  }
  await expect(page.getByTestId("background-updates")).not.toHaveAttribute(
    "data-updates",
    before!,
  );
  await email.press("Tab");
  await expect
    .poll(() => instance.artifactServer.vhostOauth.status().policies.memo)
    .toEqual(["*@rws.com"]);
  await page
    .getByRole("button", {
      name: "+ Allow another email or domain",
      exact: true,
    })
    .click();
  const second = page.getByRole("textbox", {
    name: "Allowed email or domain 2",
    exact: true,
  });
  await second.pressSequentially("person@rws.com");
  await second.press("Tab");
  await expect(page.getByText("Already allowed by *@rws.com")).toBeVisible();
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .getByText("Already allowed by *@rws.com")
      .scrollIntoViewIfNeeded();
    await recordUiCapture(page, `vhost-oauth-${viewport.width}`, viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole("button", { name: "All access logs", exact: true })
    .click();
  await expect(page.getByText("No sign-in checks recorded yet.")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Minimize details", exact: true })
    .click();
  await providerSection.click();
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await providerSection.click();
  const blocked = page.getByText(
    "Blocked: hosted sign-in is disabled or unconfigured.",
    { exact: true },
  );
  await expect(blocked).toBeVisible();
  expect(instance.artifactServer.vhostOauth.status().policies.memo).toEqual([
    "*@rws.com",
    "person@rws.com",
  ]);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await blocked.scrollIntoViewIfNeeded();
    await recordUiCapture(page, `vhost-blocked-${viewport.width}`, viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await providerSection.click();
  await enabled.check();
  await expect(blocked).toHaveCount(0);
  expect(instance.artifactServer.vhostOauth.status().secretSuffix).toBe("abcd");
  await page.route("**/api/artifacts/vhosts/oauth", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        locked: true,
        providers: body.providers.map((entry: { id: string }) => ({
          ...entry,
          locked: entry.id === "default",
        })),
      },
    });
  });
  await page.reload();
  await providerSection.click();
  await page.getByText("Provider settings", { exact: true }).click();
  await expect(provider).toBeDisabled();
  await expect(secret).toBeDisabled();
  await expect(secret).toHaveAttribute("placeholder", "••••abcd");
  await expect(page.getByText(/Managed by environment/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save sign-in provider" }),
  ).toHaveCount(0);
  await page.getByText("Provider settings", { exact: true }).click();
  await page.getByRole("button", { name: "Add sign-in provider" }).click();
  const newProvider = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) });
  await expect(
    newProvider.getByRole("combobox", {
      name: "Hosted sign-in provider (OAuth)",
      exact: true,
    }),
  ).toHaveValue("google");
  await newProvider
    .getByLabel("Application (client) ID", { exact: true })
    .fill("google-client");
  await newProvider
    .getByLabel("Client secret value (leave blank to keep existing)", {
      exact: true,
    })
    .pressSequentially("google-secret-1234");
  await newProvider
    .getByRole("button", { name: "Save sign-in provider" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Google", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Microsoft", exact: true }),
  ).toBeChecked();
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await providerSection.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await recordUiCapture(
      page,
      `vhost-provider-list-${viewport.width}`,
      viewport,
    );
  }
  const google = instance.artifactServer.vhostOauth
    .status()
    .providers!.find(
      (entry) => entry.provider.issuer === "https://accounts.google.com",
    )!;
  await page
    .getByRole("checkbox", { name: "Microsoft", exact: true })
    .uncheck();
  await expect
    .poll(
      () => instance.artifactServer.vhostOauth.status().providers![0]!.enabled,
    )
    .toBe(false);
  await page.getByRole("checkbox", { name: "Microsoft", exact: true }).check();
  await expect
    .poll(
      () => instance.artifactServer.vhostOauth.status().providers![0]!.enabled,
    )
    .toBe(true);
  await page.route("https://memo.example.net/**", async (route) => {
    const response = await instance.artifactServer.vhostOauth.admit(
      new Request(route.request().url()),
      { name: "memo", port: 19432 },
    );
    if (!(response instanceof Response))
      throw new Error("Expected app sign-in response");
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  await page.goto("https://memo.example.net/");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toHaveAttribute("href", new RegExp(`provider=${google.id}`));
  await expect(
    page.getByRole("link", { name: "Continue with Microsoft" }),
  ).toBeVisible();
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `vhost-sign-in-${viewport.width}`, viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .getByRole("link", { name: "Continue with Google" })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(48);
  }
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        current: "0.9.3",
        capabilities: ["vhost-oauth-access"],
        capabilityExtensions: [],
        capabilityBits: [],
        optionalCapabilityBits: [],
      },
    });
  });
  const unsupportedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/oauth/providers/"))
      unsupportedRequests.push(request.url());
  });
  await page.goto(`${base}/e2e/fixtures/artifact-viewer.html?settings`);
  await providerSection.click();
  await expect(
    page.getByRole("button", { name: "Add sign-in provider" }),
  ).toHaveCount(0);
  await expect(provider).toBeVisible();
  expect(unsupportedRequests).toEqual([]);
});
