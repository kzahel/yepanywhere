import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&state=e2e";

function provider(name: "claude" | "codex", authenticated: boolean) {
  return {
    name,
    displayName: name === "claude" ? "Claude" : "Codex",
    installed: true,
    authenticated,
    enabled: authenticated,
    loginCommand: authenticated
      ? undefined
      : name === "claude"
        ? "C:\\Users\\me\\AppData\\Local\\yep\\claude.exe auth login --claudeai"
        : "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe login",
    supportsInAppLogin: true,
    supportsHostTerminalLogin: true,
    models: [{ id: "default", name: "Default" }],
  };
}

function flow(name: "claude" | "codex", fields: Record<string, unknown> = {}) {
  return {
    id: `${name}-flow`,
    provider: name,
    state: "running",
    acceptsCode: name === "claude",
    codeSubmitted: false,
    output: "",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...(name === "claude"
      ? { url: CLAUDE_URL }
      : {
          url: "https://auth.openai.com/codex/device",
          userCode: "IXHO-DHC63",
        }),
    ...fields,
  };
}

test("signs Claude and Codex in through server-run login flows", async ({
  page,
  baseURL,
}) => {
  let claudeSignedIn = false;
  const submittedCodes: string[] = [];
  let claudeFlow: Record<string, unknown> | null = null;
  let codexFlow: Record<string, unknown> | null = null;

  await page.route(
    (url) => url.pathname === "/api/providers",
    async (route) => {
      await route.fulfill({
        json: {
          providers: [
            provider("claude", claudeSignedIn),
            provider("codex", false),
          ],
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/subscription-usage"),
    (route) => route.fulfill({ json: { usage: null } }),
  );
  await page.route(
    (url) => /^\/api\/providers\/(claude|codex)\/login/.test(url.pathname),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const name = path.includes("/claude/") ? "claude" : "codex";
      if (path.endsWith("/login") && request.method() === "POST") {
        if (name === "claude") claudeFlow = flow("claude");
        else codexFlow = flow("codex");
      } else if (path.endsWith("/login/code")) {
        const body = request.postDataJSON() as { code: string };
        submittedCodes.push(body.code);
        claudeFlow = { ...flow("claude"), codeSubmitted: true };
      } else if (
        path.endsWith("/login") &&
        request.method() === "GET" &&
        name === "claude" &&
        claudeFlow?.codeSubmitted
      ) {
        claudeSignedIn = true;
        claudeFlow = { ...claudeFlow, state: "succeeded" };
      }
      await route.fulfill({
        json: { flow: name === "claude" ? claudeFlow : codexFlow },
      });
    },
  );

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/settings/providers`);
  await dismissOnboardingIfVisible(page);

  const codex = page.locator('[data-settings-item="provider-codex"]');
  await codex.getByRole("button", { name: "Sign in to Codex" }).click();
  await expect(codex.getByText("IXHO-DHC63")).toBeVisible();
  await expect(
    codex.getByRole("link", { name: "Open Codex sign-in page" }),
  ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await expect(
    codex.getByRole("button", { name: "Open in a terminal on the server" }),
  ).toHaveCount(0);

  const claude = page.locator('[data-settings-item="provider-claude"]');
  await expect(
    claude.getByText(
      "C:\\Users\\me\\AppData\\Local\\yep\\claude.exe auth login --claudeai",
    ),
  ).toBeVisible();
  await claude.getByRole("button", { name: "Sign in to Claude" }).click();
  await expect(
    claude.getByRole("link", { name: "Open Claude sign-in page" }),
  ).toHaveAttribute("href", CLAUDE_URL);
  const codeInput = claude.getByLabel("Authorization code");
  await codeInput.pressSequentially("abc#123");
  await expect(codeInput).toHaveValue("abc#123");

  await claude.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "provider-sign-in-desktop");
  // The settings pane stays mounted across the phone breakpoint, so the
  // running flow and the code typed so far are both still there.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(async () => {
    await claude.scrollIntoViewIfNeeded();
    await expect(
      claude.getByRole("link", { name: "Open Claude sign-in page" }),
    ).toBeVisible();
  }).toPass();
  await expect(codeInput).toHaveValue("abc#123");
  await recordUiCapture(page, "provider-sign-in-phone");

  await claude.getByRole("button", { name: "Submit code" }).click();
  await expect.poll(() => submittedCodes).toEqual(["abc#123"]);
  await expect(
    claude.getByText("Authentication: Not authenticated"),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(
    claude.getByRole("button", { name: "Sign in to Claude" }),
  ).toHaveCount(0);
});

test("focused sign-in keeps startup failures visible and preserves typing during CLI updates", async ({
  page,
  baseURL,
}) => {
  let current: ReturnType<typeof flow> | null = null;
  let starts = 0;
  let reads = 0;
  // The page keeps whichever of the provider row and the provider list was
  // requested later, and the app requests the list only after its auth or
  // settings load, which is after the row, so both say Claude is signed
  // out. Otherwise the test server's own list reports it signed in and
  // closes the panel.
  await page.route(
    (url) => url.pathname === "/api/providers",
    (route) =>
      route.fulfill({ json: { providers: [provider("claude", false)] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/providers/claude",
    (route) => route.fulfill({ json: { provider: provider("claude", false) } }),
  );
  await page.route(
    (url) => url.pathname === "/api/providers/claude/login",
    async (route) => {
      if (route.request().method() === "POST") {
        starts++;
        if (starts === 1)
          return route.fulfill({
            status: 503,
            json: { error: "Network unavailable; retry sign-in" },
          });
        current = flow("claude", {
          output: "Official CLI is preparing authorization",
        });
      } else if (current) {
        reads++;
        current = { ...current, output: `Official CLI update ${reads}` };
      }
      await route.fulfill({ json: { flow: current } });
    },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/provider-sign-in/claude`);
  await dismissOnboardingIfVisible(page);
  const signIn = page.getByRole("button", {
    name: "Sign in to Claude",
    exact: true,
  });
  await expect(signIn).toBeVisible();
  expect(starts).toBe(0); // Navigating a link alone never starts/replaces a login.
  await signIn.click();
  await expect(
    page.getByTestId("provider-sign-in-claude").getByRole("alert"),
  ).toContainText("Network unavailable");
  await signIn.click();
  await expect(page.getByLabel("Provider CLI output")).toContainText(
    "Official CLI",
  );
  const input = page.getByRole("textbox", { name: "Authorization code" });
  let text = "";
  for (const character of "abc#123") {
    await input.pressSequentially(character);
    text += character;
    await expect(input).toHaveValue(text, { timeout: 100 });
    if (text.length === 3) await expect.poll(() => reads).toBeGreaterThan(0);
  }
  await expect(input).toHaveValue(text);
  await recordUiCapture(page, "focused-provider-sign-in-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(input).toBeVisible();
  await recordUiCapture(page, "focused-provider-sign-in-phone");
});
