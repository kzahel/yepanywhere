import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";
let vite: Awaited<ReturnType<typeof createTestViteServer>>;
let origin: string;
test.beforeAll(async () => {
  vite = await createTestViteServer({
    root: resolve(import.meta.dirname, ".."),
    server: { port: 0, host: "127.0.0.1" },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  try {
    await presentUiCaptures();
  } finally {
    await vite?.close();
  }
});
test("pool overview, editor and policy selection retain typing under 48-account updates", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("pageerror", (e) => warnings.push(e.message));
  page.on("console", (m) => {
    if (["warning", "error"].includes(m.type())) warnings.push(m.text());
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${origin}/e2e/fixtures/router-pools.html`);
  const overview = page.getByRole("region", {
    name: "Pools and usage",
    exact: true,
  });
  await overview
    .getByRole("combobox", { name: "Pool", exact: true })
    .selectOption({ label: "Personal Codex · codex" });
  await expect(overview).toHaveAttribute("aria-busy", "false");
  await overview
    .getByRole("combobox", { name: "Router model", exact: true })
    .selectOption("fixture-model");
  await expect(
    overview.getByText("Applicable quota window exhausted"),
  ).toBeVisible();
  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await overview
        .getByRole("button", { name: "Create pool", exact: true })
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(38);
    await recordUiCapture(page, `router-pools-${size.width}`, size);
  }
  await page.setViewportSize({ width: 1000, height: 600 });
  await overview
    .getByRole("button", { name: "Edit pool", exact: true })
    .click();
  const input = overview.getByRole("textbox", {
    name: "Pool name",
    exact: true,
  });
  await input.clear();
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    const samples: { latency: number; retained: boolean }[] = [];
    (window as unknown as { typing: typeof samples }).typing = samples;
    field.addEventListener("input", () => {
      const start = performance.now(),
        expected = field.value;
      requestAnimationFrame(() =>
        samples.push({
          latency: performance.now() - start,
          retained: field.value.startsWith(expected),
        }),
      );
    });
  });
  await overview.getByRole("button", { name: "Reload overview" }).click();
  const name = "Personal Codex daily coding pool";
  await input.pressSequentially(name, { delay: 20 });
  await expect(input).toHaveValue(name);
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          typing: { latency: number; retained: boolean }[];
        }
      ).typing,
  );
  expect(samples).toHaveLength(name.length);
  expect(samples.every((s) => s.retained && s.latency < 100)).toBe(true);
  console.log(
    `Pool editor typing: ${samples.length} keys, maximum ${Math.max(...samples.map((s) => s.latency)).toFixed(1)} ms`,
  );
  await overview
    .getByRole("button", { name: "Save pool", exact: true })
    .click();
  await expect(input).toHaveCount(0);
  await expect(
    overview.getByRole("combobox", { name: "Pool", exact: true }),
  ).toContainText(name);
  const selector = page.getByRole("region", {
    name: "New session",
    exact: true,
  });
  const poolTrigger = selector.getByRole("button", {
    name: "Filter by Pool",
    exact: true,
  });
  await expect(poolTrigger).toContainText("Direct provider login");
  await poolTrigger.click();
  const poolPanel = page.getByRole("dialog", { name: "Filter by Pool" });
  await expect(poolPanel.getByRole("button")).toHaveText([
    /^Direct provider login/,
    /^Personal Codex.*Round robin · 15 of 16 accounts offer Fixture model · best 45% left/,
    /^Hand-picked Codex.*Manual · 3 of 4 accounts offer Fixture model · best 45% left/,
  ]);
  await recordUiCapture(page, "router-unified-selection-open-1000", {
    width: 1000,
    height: 600,
  });
  await poolPanel.getByRole("button", { name: /^Personal Codex/ }).click();
  await expect(poolPanel).toHaveCount(0);
  await expect(poolTrigger).toContainText("Personal Codex");
  await expect(selector.getByLabel("Selected route")).toContainText(
    '"poolId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"',
  );
  // An automatic pool offers its default, the router's other policies and
  // each account; choosing a policy overrides the default for this session.
  const accountTrigger = selector.getByRole("button", {
    name: "Filter by Router account",
    exact: true,
  });
  await expect(accountTrigger).toContainText("Round robin");
  await accountTrigger.click();
  const accountPanel = page.getByRole("dialog", {
    name: "Filter by Router account",
  });
  await expect(accountPanel.getByRole("button").nth(0)).toHaveText(
    /^Round robin.*Pool default/,
  );
  await expect(accountPanel.getByRole("button").nth(2)).toHaveText(
    /^Weekly pace/,
  );
  await expect(accountPanel.getByRole("button")).toHaveCount(3 + 16);
  await accountPanel.getByRole("button", { name: /^Weekly pace/ }).click();
  await expect(selector.getByLabel("Selected route")).toContainText(
    '"policy":"weekly-pace"',
  );
  await poolTrigger.click();
  await poolPanel.getByRole("button", { name: /^Hand-picked Codex/ }).click();
  await expect(accountTrigger).toContainText("Choose an account");
  await accountTrigger.click();
  // Every pool account is listed with its reason, both cached windows and
  // the observation state; only catalog facts disable a row.
  await expect(accountPanel.getByRole("button")).toHaveText([
    /^Round robin/,
    /^Most remaining/,
    /^Weekly pace/,
    /Account 1.*Quota exhausted when last checked.*5h 0% left.*7d 45% left.*checked Oct 3/,
    /Account 2.*5h 68% left.*7d 45% left.*from a request Oct 3.*last refresh failed/,
    /Account 3.*Disabled in AAR.*5h 68% left.*7d 45% left.*checked Oct 3/,
    /Account 4.*no quota observed/,
  ]);
  await expect(
    accountPanel.getByRole("button", { name: /Account 3/ }),
  ).toBeDisabled();
  await expect(
    accountPanel.getByRole("button", { name: /Account 1/ }),
  ).toBeEnabled();
  await recordUiCapture(page, "router-account-quota-open-1000", {
    width: 1000,
    height: 600,
  });
  await accountPanel.getByRole("button", { name: /Account 2/ }).click();
  await expect(selector.getByLabel("Selected route")).toContainText(
    '"accountId":"account-2"',
  );
  // The phone sheet must hold both quota lines without clipping the row.
  await page.setViewportSize({ width: 375, height: 812 });
  await accountTrigger.click();
  const accountSheet = page.getByRole("dialog", {
    name: "Filter by Router account",
  });
  await expect(accountSheet.getByRole("button")).toHaveCount(7);
  expect(
    await accountSheet
      .getByRole("button", { name: /Account 2/ })
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await recordUiCapture(page, "router-account-quota-open-375", {
    width: 375,
    height: 812,
  });
  await page.keyboard.press("Escape");
  await expect(accountSheet).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 600 });
  const prompt = selector.getByRole("textbox", { name: "Prompt" });
  await prompt.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    const samples: { latency: number; retained: boolean }[] = [];
    (window as unknown as { typing: typeof samples }).typing = samples;
    field.addEventListener("input", () => {
      const start = performance.now(),
        expected = field.value;
      requestAnimationFrame(() =>
        samples.push({
          latency: performance.now() - start,
          retained: field.value.startsWith(expected),
        }),
      );
    });
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("router-connection-changed")),
  );
  await prompt.pressSequentially(name, { delay: 20 });
  await expect(prompt).toHaveValue(name);
  const promptSamples = await page.evaluate(
    () =>
      (
        window as unknown as {
          typing: { latency: number; retained: boolean }[];
        }
      ).typing,
  );
  expect(promptSamples).toHaveLength(name.length);
  expect(promptSamples.every((s) => s.retained && s.latency < 100)).toBe(true);
  console.log(
    `Prompt during discovery: maximum ${Math.max(...promptSamples.map((s) => s.latency)).toFixed(1)} ms`,
  );
  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await selector.evaluate((el) => el.scrollIntoView({ block: "start" }));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `router-unified-selection-${size.width}`, size);
  }
  expect(warnings).toEqual([]);
});

test("router-owned pools expose selection and usage without integration administration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/e2e/fixtures/router-pools.html?owner=1`);
  const overview = page.getByRole("region", {
    name: "Pools and usage",
    exact: true,
  });
  await expect(
    overview.getByText(
      "Accounts, pools and access grants are managed in Agent Auth Router.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    overview.getByRole("button", { name: "Create pool" }),
  ).toHaveCount(0);
  await overview
    .getByRole("combobox", { name: "Pool", exact: true })
    .selectOption({ label: "Personal Codex · codex" });
  await expect(overview).toHaveAttribute("aria-busy", "false");
  await expect(overview.getByRole("button", { name: "Edit pool" })).toHaveCount(
    0,
  );
  await expect(
    overview.getByRole("button", { name: "Refresh usage" }).first(),
  ).toBeVisible();
  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recordUiCapture(page, `router-owned-pools-${size.width}`, size);
  }
  expect(errors).toEqual([]);
});
