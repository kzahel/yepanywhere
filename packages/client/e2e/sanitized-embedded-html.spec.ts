import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const projectPath = join(e2ePaths.tempDir, "file-browser-project");
const projectId = Buffer.from(projectPath).toString("base64url");

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

async function capture(page: Page, name: string) {
  const artifactDir = process.env.YEP_UI_CAPTURE_DIR;
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDir, `${name}.png`),
  });
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`renders joined Markdown table cells at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(
      `/projects/${projectId}/file?path=${encodeURIComponent("embedded-html.md")}`,
    );
    await dismissOnboardingIfVisible(page);

    const preview = page.locator(".markdown-preview");
    const table = preview.getByRole("table");
    await expect(table).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Latency" }),
    ).toHaveAttribute("colspan", "2");
    await expect(
      table.getByRole("columnheader", { name: "Runtime" }),
    ).toHaveAttribute("rowspan", "2");
    await expect(table.getByRole("cell", { name: "Phone" })).toHaveAttribute(
      "rowspan",
      "2",
    );
    await expect(
      table.getByRole("cell", { name: "Fits the narrow viewer" }),
    ).toHaveAttribute("colspan", "2");

    const [tableBox, previewBox] = await Promise.all([
      table.boundingBox(),
      preview.boundingBox(),
    ]);
    if (!tableBox || !previewBox) {
      throw new Error("Expected rendered table and Markdown preview bounds");
    }
    expect(tableBox.width).toBeLessThanOrEqual(previewBox.width + 1);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await capture(
      page,
      `${viewport.name}-sanitized-embedded-html-${viewport.width}x${viewport.height}`,
    );
  });
}
