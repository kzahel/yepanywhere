import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BROWSER_SETTINGS_BACKUP_VERSION } from "@yep-anywhere/shared";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";
import { createApp } from "../../server/test/setup/create-app";
import { createFrontendProxy } from "../../server/src/frontend/proxy";
import { ScriptedClaudeProvider } from "../../server/test/support/scripted-provider.js";
import { ServerSettingsService } from "../../server/src/services/ServerSettingsService";
import { BrowserSettingsBackupService } from "../../server/src/services/BrowserSettingsBackupService";
import { LimitedUsersService } from "../../server/src/auth/LimitedUsersService";
import { AuthService } from "../../server/src/auth/AuthService";
import { SESSION_COOKIE_NAME } from "../../server/src/auth/routes";

// Each test file boots its own cold server; on CI the first page can take
// over 10 s to load, leaving little of the 15 s default for the test itself.
test.setTimeout(60_000);

const clientRoot = resolve(import.meta.dirname, "..");
const require = createRequire(join(clientRoot, "../server/package.json"));
const { getRequestListener } = require("@hono/node-server");
let vite: Awaited<ReturnType<typeof createTestViteServer>>;
let instance: ReturnType<typeof createApp>;
let listener: ReturnType<typeof createServer>;
let directory: string;
let base: string;
let superuserCookie: string;
let aliceCookie: string;
let users: LimitedUsersService;
let defaults: BrowserSettingsBackupService;

test.beforeAll(async () => {
  const scratch = resolve(
    clientRoot,
    "../../.artifacts/limited-browser-defaults-browser",
  );
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "run-"));
  const settings = new ServerSettingsService({ dataDir: directory });
  users = new LimitedUsersService({ dataDir: directory });
  const auth = new AuthService({
    dataDir: directory,
    cookieSecret: "browser-defaults-test-secret",
  });
  const backup = new BrowserSettingsBackupService({ dataDir: directory });
  defaults = new BrowserSettingsBackupService({
    dataDir: directory,
    fileName: "limited-user-browser-defaults.json",
  });
  await Promise.all([
    settings.initialize(),
    users.initialize(),
    auth.initialize(),
    backup.initialize(),
    defaults.initialize(),
  ]);
  await auth.enableAuth("test-superuser-password");
  superuserCookie = await auth.createSession("test");
  await users.create({ username: "alice", password: "test-password" });
  aliceCookie = await auth.createSession("test", "alice");
  await settings.updateSettings({ limitedUsersEnabled: true });
  // The superuser's own saved settings, including a key that is not a
  // portable preference and must not be offered to limited users.
  await backup.saveBackup({
    version: BROWSER_SETTINGS_BACKUP_VERSION,
    values: {
      "yep-anywhere-theme": "light",
      "yep-anywhere-font-size": "large",
      "not-a-portable-setting": "secret",
    },
  });
  vite = await createTestViteServer({
    root: clientRoot,
    server: { port: 0, host: "127.0.0.1" },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string")
    throw new Error("Missing Vite address");
  instance = createApp({
    provider: new ScriptedClaudeProvider(),
    dataDir: directory,
    projectsDir: join(directory, "sessions"),
    authService: auth,
    authDisabled: false,
    limitedUsersService: users,
    serverSettingsService: settings,
    browserSettingsBackupService: backup,
    limitedUserBrowserDefaultsService: defaults,
    frontendProxy: createFrontendProxy({
      vitePort: address.port,
      viteHost: "127.0.0.1",
    }),
  });
  listener = createServer(getRequestListener(instance.app.fetch));
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const bound = listener.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing YA address");
  base = `http://127.0.0.1:${bound.port}`;
});

test.afterAll(async () => {
  await presentUiCaptures();
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (instance) await instance.disposeSessionReaders();
  if (users) await users.flushPendingWrites();
  if (vite) await vite.close();
  if (directory) await rm(directory, { recursive: true });
});

test("superuser publishes defaults that a limited user's browser takes once", async ({
  browser,
}) => {
  const admin = await browser.newContext({
    viewport: { width: 1200, height: 600 },
  });
  await admin.addCookies([
    { name: SESSION_COOKIE_NAME, value: superuserCookie, url: base },
  ]);
  const page = await admin.newPage();
  await page.goto(`${base}/e2e/fixtures/limited-browser-defaults.html`);
  const panel = page.getByRole("region", {
    name: "Browser defaults for limited users",
  });
  await expect(panel.getByRole("status")).toHaveText(
    "No limited user settings saved",
  );
  await panel
    .getByRole("button", { name: "Load from my saved settings" })
    .click();
  // The loaded values sit in a collapsed outline that counts them.
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await panel.getByText("(2 settings)", { exact: true }).click();
  await expect(panel.getByRole("textbox")).toHaveCount(2);
  const theme = panel.getByRole("textbox", { name: "theme" });
  await expect(theme).toHaveValue("light");
  await panel.getByRole("button", { name: "Remove font-size" }).click();
  await theme.fill("");
  let typed = "";
  for (const character of "light") {
    await theme.pressSequentially(character);
    typed += character;
    await expect(theme).toHaveValue(typed, { timeout: 100 });
  }
  await panel.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "browser-defaults-desktop", {
    width: 1200,
    height: 600,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await panel.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "browser-defaults-phone", {
    width: 375,
    height: 812,
  });
  await panel
    .getByRole("button", { name: "Save to limited user settings" })
    .click();
  await expect(panel.getByRole("status")).toContainText("1 settings");
  expect(defaults.getBackup()?.values).toEqual({
    "yep-anywhere-theme": "light",
  });
  // The superuser's own browser is not a limited user's and takes nothing.
  await page.reload();
  await expect(page.getByRole("status", { name: "Theme" })).toHaveText("unset");
  await admin.close();

  const limited = await browser.newContext();
  await limited.addCookies([
    { name: SESSION_COOKIE_NAME, value: aliceCookie, url: base },
  ]);
  const alice = await limited.newPage();
  await alice.goto(`${base}/e2e/fixtures/limited-browser-defaults.html`);
  const probe = alice.getByRole("status", { name: "Theme" });
  // Applying reloads the page once so every setting reader sees it.
  await expect(probe).toHaveText("light");
  await expect(probe).toHaveAttribute("data-loads", "2");
  await alice.evaluate(() =>
    localStorage.setItem("yep-anywhere-theme", "dark"),
  );
  await alice.reload();
  await expect(probe).toHaveAttribute("data-loads", "3");
  await expect(probe).toHaveText("dark");
  await limited.close();
});
