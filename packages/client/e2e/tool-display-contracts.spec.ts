import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
// Each test file boots its own cold server; on CI the first page can take
// over 10 s to load, leaving little of the 15 s default for the test itself.
test.setTimeout(60_000);

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
test.beforeAll(async () => {
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? "";
});
test.afterAll(async () => {
  await server?.close();
});
for (const width of [1000, 375])
  test(`rich, partial, nested fallback and recovery at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        errors.push(message.text());
    });
    await page.setViewportSize({ width, height: width === 1000 ? 600 : 812 });
    await page.goto(`${base}e2e/fixtures/tool-display-contracts.html`);
    await expect(
      page.getByText("export const checked = true;", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-tool-display="raw"]')).toHaveCount(2);
    await expect(
      page.getByText("Plain text remains readable without file metadata."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Correct record" }).click();
    await expect(page.locator('[data-tool-display="raw"]')).toHaveCount(1);
    await expect(
      page.getByText("Recovered content", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Complete pending call" }).click();
    await expect(
      page.getByText("contract output", { exact: true }),
    ).toBeVisible();
    await page.getByText("Subagent tools", { exact: true }).click();
    await page.getByText("Subagent tools", { exact: true }).click();
    const fallback = page.locator('[data-tool-display="raw"]');
    const rejection = page.getByText("Missing file_path in subagent Write", {
      exact: true,
    });
    await expect(rejection).toBeHidden();
    await expect(fallback.getByText("Failed", { exact: true })).toBeVisible();
    const disclosure = fallback.locator("summary");
    await disclosure.click();
    await expect(rejection).toBeVisible();
    await disclosure.click();
    await expect(rejection).toBeHidden();
    await expect(page.getByTestId("catches")).toHaveText("0");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });

for (const width of [1000, 375])
  test(`preserves reviewed provider semantics at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        errors.push(message.text());
    });
    await page.setViewportSize({ width, height: width === 1000 ? 600 : 812 });
    await page.goto(`${base}e2e/fixtures/tool-display-contracts.html?review`);
    await expect(
      page.getByRole("link", { name: "Contract reference" }),
    ).toBeVisible();
    await expect(
      page.getByText("reference.pdf", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Declined", { exact: true })).toBeVisible();
    await expect(page.getByText("+checked", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Preserve provider output and verify each display operation.",
      ),
    ).toBeVisible();
    await expect(page.locator('[data-tool-display="raw"]')).toHaveCount(0);
    await expect(page.getByTestId("catches")).toHaveText("0");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
