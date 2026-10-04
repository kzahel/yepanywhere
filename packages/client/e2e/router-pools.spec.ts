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
  await selector
    .getByRole("combobox", { name: "Pool", exact: true })
    .selectOption("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  await expect(selector.getByLabel("Selected route")).toContainText(
    '"poolId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"',
  );
  await expect(selector.getByRole("combobox")).toHaveCount(1);
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
      "Manage accounts, pools and access grants in Agent Auth Router.",
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
