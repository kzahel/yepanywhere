import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  DEFAULT_LIMITED_USER_INSTRUCTION,
  DEFAULT_LIMITED_USER_INSTRUCTION_BLOCKS,
} from "@yep-anywhere/shared";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";
import { createApp } from "../../server/test/setup/create-app";
import { createFrontendProxy } from "../../server/src/frontend/proxy";
import { ScriptedClaudeProvider } from "../../server/test/support/scripted-provider.js";
import { ServerSettingsService } from "../../server/src/services/ServerSettingsService";
import { LimitedUsersService } from "../../server/src/auth/LimitedUsersService";
import { AuthService } from "../../server/src/auth/AuthService";
import { SESSION_COOKIE_NAME } from "../../server/src/auth/routes";

const clientRoot = resolve(import.meta.dirname, "..");
const require = createRequire(join(clientRoot, "../server/package.json"));
const { getRequestListener } = require("@hono/node-server");
let vite: Awaited<ReturnType<typeof createTestViteServer>>;
let instance: ReturnType<typeof createApp>;
let listener: ReturnType<typeof createServer>;
let directory: string;
let base: string;
let cookie: string;
let settings: ServerSettingsService;
let users: LimitedUsersService;

test.beforeAll(async () => {
  const scratch = resolve(
    clientRoot,
    "../../.artifacts/limited-instructions-browser",
  );
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "run-"));
  settings = new ServerSettingsService({ dataDir: directory });
  users = new LimitedUsersService({ dataDir: directory });
  const auth = new AuthService({
    dataDir: directory,
    cookieSecret: "instructions-test-secret",
  });
  await settings.initialize();
  await users.initialize();
  await auth.initialize();
  await auth.enableAuth("test-superuser-password");
  cookie = await auth.createSession("test");
  await users.create({ username: "alice", password: "test-password" });
  await settings.updateSettings({ limitedUsersEnabled: true });
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

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: SESSION_COOKIE_NAME, value: cookie, url: base },
  ]);
});

test("edits and persists ordered instructions while concurrent updates retain every keystroke", async ({
  page,
}) => {
  // HTTP LAN pages lack randomUUID; block identity must work there too.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${base}/e2e/fixtures/limited-instructions.html`);
  const shared = page.getByRole("region", {
    name: "Instructions for all limited users",
  });
  const first = shared.getByRole("textbox", {
    name: "Instruction 1",
    exact: true,
  });
  await expect(first).toHaveValue(DEFAULT_LIMITED_USER_INSTRUCTION);
  await shared.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "instructions-shared-phone", {
    width: 375,
    height: 812,
  });
  await page.setViewportSize({ width: 1200, height: 600 });
  await shared.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "instructions-shared-desktop", {
    width: 1200,
    height: 600,
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await recordUiCapture(page, "instructions-shared-desktop-1000", {
    width: 1000,
    height: 600,
  });
  await shared.getByRole("checkbox", { name: "Start from default" }).uncheck();
  await shared.getByRole("button", { name: "+ Add block" }).click();
  // The defaults fill blocks 1–2, so the added block is 3.
  const added = shared.getByRole("textbox", {
    name: "Instruction 3",
    exact: true,
  });
  const before = Number(
    await page.getByTestId("background-updates").getAttribute("data-updates"),
  );
  let typed = "";
  for (const character of "Keep responses concise.") {
    await added.pressSequentially(character);
    typed += character;
    await expect(added).toHaveValue(typed, { timeout: 100 });
  }
  expect(
    Number(
      await page.getByTestId("background-updates").getAttribute("data-updates"),
    ),
  ).toBeGreaterThan(before);
  await shared.getByRole("button", { name: "Move instruction 3 up" }).click();
  await shared.getByRole("button", { name: "Move instruction 2 up" }).click();
  await expect(first).toHaveValue(typed);
  await shared
    .getByRole("button", { name: "Remove instruction 1", exact: true })
    .click();
  await expect(first).toHaveValue(DEFAULT_LIMITED_USER_INSTRUCTION);
  await shared
    .getByRole("button", { name: "Save shared instructions" })
    .click();
  await expect(shared.getByRole("status")).toHaveText("Saved");
  expect(settings.getSetting("limitedUserInstructions")).toEqual({
    startFromDefault: false,
    blocks: [...DEFAULT_LIMITED_USER_INSTRUCTION_BLOCKS],
  });
  await page.getByRole("button", { name: "alice", exact: true }).click();
  const personal = page.getByRole("region", {
    name: "Additional instructions for this user",
  });
  await expect(personal.getByRole("textbox")).toHaveCount(0);
  await page.setViewportSize({ width: 1200, height: 600 });
  await personal.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "instructions-user-desktop", {
    width: 1200,
    height: 600,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await personal.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "instructions-user-phone", {
    width: 375,
    height: 812,
  });
  await personal.getByRole("button", { name: "+ Add block" }).click();
  await personal
    .getByRole("textbox", { name: "Instruction 1", exact: true })
    .pressSequentially("Explain unfamiliar terms.");
  await personal
    .getByRole("button", { name: "Preview combined instructions" })
    .click();
  await expect(personal.locator("pre").last()).toHaveText(
    [
      ...DEFAULT_LIMITED_USER_INSTRUCTION_BLOCKS,
      "Explain unfamiliar terms.",
    ].join("\n\n"),
  );
  // Pressing Preview took focus from the typed block, which saved it.
  await expect
    .poll(() => users.get("alice")?.instructionBlocks)
    .toEqual(["Explain unfamiliar terms."]);
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Start from default" }),
  ).not.toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("older servers show no instruction controls and receive no new user fields", async ({
  page,
}) => {
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        current: "0.9.2",
        capabilities: [],
        capabilityBits: [],
      },
    });
  });
  await page.goto(`${base}/e2e/fixtures/limited-instructions.html`);
  const alice = page.getByRole("button", { name: "alice", exact: true });
  await expect(alice).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Start from default" }),
  ).toHaveCount(0);
  await alice.click();
  await expect(page.getByRole("button", { name: "+ Add block" })).toHaveCount(
    0,
  );
  const request = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      request.url().endsWith("/api/users/alice"),
  );
  // Any edit saves on blur; the join offset is one every server accepts.
  const offset = page.getByRole("spinbutton");
  await offset.fill("3");
  await offset.blur();
  expect((await request).postDataJSON()).not.toHaveProperty(
    "instructionBlocks",
  );
});
