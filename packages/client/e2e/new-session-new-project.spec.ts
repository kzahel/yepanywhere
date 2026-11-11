import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ draftSessionIds: [] });
test.use({ serviceWorkers: "block" });

// New project is the one entry point for a folder YA has not seen
// (topics/project-names.md): Empty folder by default, Git optional, and an
// unmatched typed path opens the same panel.
test("New project starts a session in a fresh folder without Git", async ({
  page,
  baseURL,
}) => {
  const folder = join(e2ePaths.tempDir, `plain-${randomUUID().slice(0, 8)}`);
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${baseURL}/new-session`);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const panel = page.getByRole("region", { name: "New project", exact: true });
  const entry = panel.getByRole("textbox", { name: "Name or path" });
  await expect(entry).toBeFocused();
  await entry.fill(folder);
  await expect(
    panel.getByRole("radio", { name: /Empty folder/ }),
  ).toBeChecked();
  const git = panel.getByRole("checkbox", {
    name: "Initialize Git repository",
  });
  await expect(git).toBeChecked();
  await git.uncheck();
  await page
    .locator("textarea[data-new-session-form-textarea]")
    .fill("Say hello from the new folder");
  await page
    .locator("[data-new-session-project-chooser]")
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await recordUiCapture(page, "new-project-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .locator("[data-new-session-project-chooser]")
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await recordUiCapture(page, "new-project-phone");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1200, height: 600 });

  await page.locator("[data-new-session-submit-button]").click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+$/, {
    timeout: 30_000,
  });
  expect((await stat(folder)).isDirectory()).toBe(true);
  await expect(stat(join(folder, ".git"))).rejects.toThrow();
});

test("an unmatched typed path opens the same New project panel", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${baseURL}/new-session`);
  const search = page.getByRole("combobox", { name: "Project path" });
  await search.fill("~/no-such-project-yet");
  const panel = page.getByRole("region", { name: "New project", exact: true });
  const missingFolder = panel.getByText(/No folder at .* yet/);
  await expect(missingFolder).toBeVisible();
  // The search box is the path field: no second box repeats it.
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(
    page.locator("[data-new-session-project-summary-title]"),
  ).toHaveText("no-such-project-yet");
  // The suggestion list drops below the search; clicking away closes it and
  // leaves the panel.
  await expect(page.locator("#new-session-project-panel")).toBeVisible();
  await page.locator("textarea[data-new-session-form-textarea]").click();
  await expect(page.locator("#new-session-project-panel")).toBeHidden();
  await expect(missingFolder).toBeVisible();
  await page
    .locator("[data-new-session-project-chooser]")
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await recordUiCapture(page, "new-project-typed-path-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .locator("[data-new-session-project-chooser]")
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await recordUiCapture(page, "new-project-typed-path-phone");
});
