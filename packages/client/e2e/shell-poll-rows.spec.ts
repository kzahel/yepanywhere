import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";

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
  await presentUiCaptures();
});

for (const width of [1200, 375]) {
  test(`compact polls and aligned labels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1200 ? 600 : 812 });
    await page.goto(`${base}e2e/fixtures/shell-poll-rows.html`);
    await page.evaluate(() => {
      document.documentElement.style.setProperty(
        "--output-prose-font-family",
        "Georgia, serif",
      );
      document.documentElement.style.setProperty(
        "--output-prose-font-size",
        "16px",
      );
    });
    const poll = page.getByRole("region", { name: "Simple poll" });
    await expect(poll.getByText("rc=1")).toHaveCount(0);
    await expect(poll.getByRole("button")).toHaveCount(0);
    await expect(poll.getByText("Waiting", { exact: true })).toBeVisible();
    const colors = await poll.locator("[data-tool-row]").evaluate((row) => ({
      dot: getComputedStyle(row, "::before").backgroundColor,
      text: getComputedStyle(
        row.querySelector("[data-tool-row-header] > span:last-child")!,
      ).color,
    }));
    expect(colors.dot).toBe(colors.text);
    await poll.locator("[data-tool-row-header]").hover();
    await expect(poll.locator("[data-tool-row-header]")).toHaveCSS(
      "cursor",
      "default",
    );
    const failure = page.getByRole("region", { name: "Long failure" });
    await failure.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(failure.getByText(/first diagnostic/)).toBeVisible();
    await failure
      .getByRole("button", { name: "Collapse", exact: true })
      .click();
    const alignment = await failure
      .locator("[data-tool-row-header]")
      .evaluate((header) => {
        const name = header.querySelector<HTMLElement>("[data-tool-name]")!;
        const summary = header.querySelector<HTMLElement>(
          "[data-tool-summary]",
        )!;
        const baseline = (element: HTMLElement) => {
          const probe = document.createElement("span");
          probe.style.cssText =
            "display:inline-block;width:0;height:0;vertical-align:baseline";
          element.append(probe);
          const y = probe.getBoundingClientRect().top;
          probe.remove();
          return y;
        };
        const nameBaseline = baseline(name);
        const font = getComputedStyle(name);
        const canvas = document.createElement("canvas").getContext("2d")!;
        canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        const cap = canvas.measureText("H").actualBoundingBoxAscent;
        const ink = name
          .querySelector("button > span")!
          .getBoundingClientRect();
        return {
          baselineGap: Math.abs(nameBaseline - baseline(summary)),
          markerGap: Math.abs(
            ink.top + ink.height / 2 - (nameBaseline - cap / 2),
          ),
        };
      });
    expect(alignment.baselineGap).toBeLessThanOrEqual(1);
    expect(alignment.markerGap).toBeLessThanOrEqual(1.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.mouse.move(0, 0);
    await page.locator("h2").click();
    await recordUiCapture(page, `shell-polls-${width}`);
  });
}
