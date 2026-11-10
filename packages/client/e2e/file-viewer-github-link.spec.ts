import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

test("Read diff shortcuts reveal once and open without leaving the session", async ({
  page,
  baseURL,
}) => {
  const projectPath = join(e2ePaths.tempDir, "source-control-qmd-project");
  const projectId = Buffer.from(projectPath).toString("base64url");
  const sessionUrl = `${baseURL}/projects/${projectId}/sessions/source-control-qmd-001`;
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(sessionUrl);
  // The completed turn folds its Read behind the activity summary.
  await page.getByRole("button", { name: /activity hidden/ }).click();
  // The expanded row can land under the pointer; reveal must be on demand.
  await page.mouse.move(0, 0);
  const diff = page.locator('[data-file-diff-links="inline"] a');
  await expect(diff).toHaveCount(1);
  await expect(diff).toBeHidden();
  await page.locator("[data-file-path-link]").first().hover();
  await expect(diff).toHaveText("Δ");
  await diff.click();
  const viewer = page.locator("[data-file-viewer]");
  await expect(viewer).toBeVisible();
  // The path breadcrumb's file-name link also carries aria-current.
  const activeDiff = '[aria-current="page"][aria-label^="View HEAD"]';
  await expect(viewer.locator(activeDiff)).toHaveText("Δ");
  await expect(viewer.locator("[data-diff-line]").first()).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  await page.reload();
  await expect(page.locator(`[data-file-viewer] ${activeDiff}`)).toHaveText(
    "Δ",
  );
  expect(page.url()).toBe(sessionUrl);
  await recordUiCapture(page, "inline-diff-in-session");
});

test("viewer copy and revision menus copy only pushed GitHub links", async ({
  page,
  context,
  baseURL,
}) => {
  const projectId = Buffer.from(
    join(e2ePaths.tempDir, "source-control-qmd-project"),
  ).toString("base64url");
  const hash = "1234567890abcdef1234567890abcdef12345678";
  const githubUrl = `https://github.com/example/project/blob/${hash}/report.qmd`;
  let pushed = true;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/git/file-revision?*", async (route) => {
    const rev = new URL(route.request().url()).searchParams.get("rev");
    await route.fulfill({
      json: {
        path: "report.qmd",
        isGitRepo: true,
        dirty: !rev,
        commit: {
          hash,
          shortHash: hash.slice(0, 9),
          authorName: "Example Author",
          authorDate: new Date().toISOString(),
          subject: "Update report",
          message: "Update report",
          messageTruncated: false,
        },
        githubLink: { url: githubUrl, pushed },
      },
    });
  });
  const viewerUrl = `${baseURL}/projects/${projectId}/file?path=report.qmd`;
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(viewerUrl);
  const viewer = page.locator("[data-file-viewer]");
  const copyLink = viewer.getByRole("button", { name: "Copy viewer link" });
  const revision = viewer.getByRole("link", { name: hash.slice(0, 9) });
  await expect(revision).toBeVisible();
  await copyLink.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(viewerUrl);

  await expect(
    viewer.getByRole("link", { name: "Source", exact: true }),
  ).toHaveCount(0);
  await viewer
    .getByRole("link", {
      name: "View HEAD to working tree diff for report.qmd",
    })
    .click();
  const rawSource = viewer.getByRole("button", {
    name: "Raw source",
    exact: true,
  });
  await expect(rawSource).toHaveAttribute("aria-pressed", "false");
  await rawSource.click();
  await expect(rawSource).toHaveAttribute("aria-pressed", "true");

  for (const control of [
    viewer.locator(".file-viewer-path"),
    copyLink,
    revision,
  ]) {
    await control.click({ button: "right" });
    const item = page.getByRole("menuitem", { name: /Copy GitHub link/ });
    await expect(item).toBeEnabled();
    await item.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(githubUrl);
  }

  await copyLink.click({ button: "right" });
  await expect(page.getByText("Local edits won’t be included")).toBeVisible();
  await recordUiCapture(page, "github-copy-link-desktop");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 375, height: 812 });
  await revision.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy GitHub link", exact: true }),
  ).toBeEnabled();
  await recordUiCapture(page, "github-revision-phone");
  await page.keyboard.press("Escape");

  pushed = false;
  for (const control of [copyLink, revision]) {
    await control.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: /Copy GitHub link/ }),
    ).toBeDisabled();
    await expect(page.getByText("Revision not pushed to GitHub")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await recordUiCapture(page, "viewer-toolbar-phone");
  await page.setViewportSize({ width: 1200, height: 600 });
  await recordUiCapture(page, "viewer-toolbar-desktop");
});
