import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureRemoteAccess, e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

async function putJson(baseURL: string, pathname: string, body: unknown) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PUT ${pathname} failed: ${await response.text()}`);
  }
}

async function deleteResource(baseURL: string, pathname: string) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: "DELETE",
    headers: { "X-Yep-Anywhere": "true" },
  });
  if (!response.ok) {
    throw new Error(`DELETE ${pathname} failed: ${await response.text()}`);
  }
}

async function postJson(baseURL: string, pathname: string, body: unknown) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathname} failed: ${await response.text()}`);
  }
  return response;
}

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

test("left and right click open the same share manager", async ({
  page,
  baseURL,
}) => {
  await configureRemoteAccess(baseURL, {
    username: "public-share-e2e",
    password: "public-share-password-123",
    relayUrl: "ws://127.0.0.1:9/ws",
  });
  await putJson(baseURL, "/api/settings", { publicSharesEnabled: true });
  await deleteResource(
    baseURL,
    `/api/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
  );
  for (const mode of ["frozen", "live"] as const) {
    await postJson(baseURL, "/api/public-shares", {
      projectId,
      sessionId,
      mode,
      title: mode === "frozen" ? "Release snapshot" : "Live review",
    });
  }
  await page.route("**/api/public-shares/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, canCreate: false } });
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await expect(
    page.getByRole("main").getByText("Previous message"),
  ).toBeVisible({
    timeout: 10000,
  });
  const version = await (await fetch(`${baseURL}/api/version`)).json();
  expect(version.capabilities).toContain("public-share-management");
  expect(version.capabilities).toContain("public-share-management-freeze");
  await page.waitForTimeout(500);

  await page
    .locator("header[data-session-header]")
    .getByLabel("Session options")
    .click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Create and copy/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const indicator = page.getByRole("button", {
    name: /active viewer|Open public share controls/,
  });
  await expect(indicator).toBeVisible();
  const indicatorBox = await indicator.boundingBox();
  expect(indicatorBox).not.toBeNull();
  await indicator.click({ button: "right" });
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "This session", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Frozen", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Live", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Share This Session" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Review all Frozen share links in This session for revocation",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Review all Live share links in This session for revocation",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Review all Live share links in This session for freezing",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Review all share links in This project for revocation",
    }),
  ).toBeEnabled();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("img", { name: "Live" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Frozen" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Freeze at current state" }),
  ).toHaveCount(1);
  await expect(page.getByText("2 matching public link(s)")).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox?.x).toBeLessThanOrEqual(indicatorBox?.x ?? 0);
  expect(dialogBox?.y).toBeGreaterThan(indicatorBox?.y ?? 0);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await indicator.click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "This session", exact: true }),
  ).toBeChecked();

  const captureDirectory = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  await dialog
    .getByRole("button", {
      name: "Review all Live share links in This session for freezing",
    })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Confirm: freeze 1 Live share link(s) in This session (0 active client(s))",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByText(
      "Click again to freeze 1 Live share link(s) in This session (0 active client(s)). The links will retain the current snapshot but stop receiving updates.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /Click again to freeze 1 Live/,
    }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  if (captureDirectory) {
    mkdirSync(captureDirectory, { recursive: true });
    await page.screenshot({
      path: join(captureDirectory, "desktop-confirm-1920x1080.png"),
    });
  }

  await dialog.getByRole("button", { name: "Frozen", exact: true }).click();
  await expect(dialog.getByText(/Click again to freeze/)).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(2);

  if (captureDirectory) {
    await page.screenshot({
      path: join(captureDirectory, "desktop-1920x1080.png"),
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(dialog.getByRole("listitem")).toHaveCount(2);
    const mobileDialogBox = await dialog.boundingBox();
    const mobileIndicatorBox = await indicator.boundingBox();
    expect(mobileDialogBox).not.toBeNull();
    expect(mobileIndicatorBox).not.toBeNull();
    expect(mobileDialogBox?.x).toBeLessThanOrEqual(9);
    expect(mobileDialogBox?.width).toBeGreaterThanOrEqual(358);
    expect(mobileDialogBox?.y).toBeGreaterThan(mobileIndicatorBox?.y ?? 0);
    expect(mobileDialogBox?.y).toBeLessThan(100);
    await page.screenshot({
      path: join(captureDirectory, "mobile-375x812.png"),
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      localStorage.setItem("yep-anywhere-theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.screenshot({
      path: join(captureDirectory, "desktop-dark-1920x1080.png"),
    });
  }

  await dialog
    .getByRole("radio", { name: "All projects", exact: true })
    .click();
  await expect(
    dialog.getByRole("radio", { name: "All projects", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", {
      name: "Review all Live share links in All projects for revocation",
    }),
  ).toBeEnabled();

  const inventory = await fetch(
    `${baseURL}/api/public-shares?projectId=${projectId}&sessionId=${sessionId}`,
  );
  expect(inventory.ok).toBe(true);
  expect((await inventory.json()).totalCount).toBe(2);

  const finalIndicatorBox = await indicator.boundingBox();
  expect(finalIndicatorBox).not.toBeNull();
  if (finalIndicatorBox) {
    await page.mouse.click(
      finalIndicatorBox.x + finalIndicatorBox.width / 2,
      finalIndicatorBox.y + finalIndicatorBox.height / 2,
    );
  }
  await expect(dialog).not.toBeVisible();

  await page.goto(`${baseURL}/sessions`);
  const sessionRow = page
    .getByRole("main")
    .locator("li[data-session-list-item]")
    .filter({ hasText: "Previous message" })
    .first();
  await expect(sessionRow).toBeVisible();
  // Session menus close on ancestor scroll. Finish bringing a lower list
  // row into view before opening it, rather than letting click auto-scroll
  // race the newly installed menu scroll listener.
  await sessionRow.scrollIntoViewIfNeeded();
  await sessionRow.getByLabel("Session options").click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "This session", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByText("Public Read-Only Share")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`${baseURL}/settings/remote`);
  await page.getByRole("button", { name: "Manage Links" }).click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Create and copy/ }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Show" })).toHaveCount(0);
});

test("share type labels fit beside creation actions", async ({
  page,
  baseURL,
}) => {
  await configureRemoteAccess(baseURL, {
    username: "public-share-layout-e2e",
    password: "public-share-password-123",
    relayUrl: "ws://127.0.0.1:9/ws",
  });
  await putJson(baseURL, "/api/settings", { publicSharesEnabled: true });
  await page.route("**/api/public-shares/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, canCreate: true } });
  });

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await expect(
    page.getByRole("main").getByText("Previous message"),
  ).toBeVisible({ timeout: 10000 });
  await page
    .locator("header[data-session-header]")
    .getByLabel("Session options")
    .click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();

  const dialog = page.getByRole("dialog");
  const liveFilter = dialog.getByRole("button", {
    name: "Live",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Create and copy Live link" }),
  ).toBeVisible();
  await expect(liveFilter).toBeVisible();
  await expect
    .poll(() =>
      liveFilter.evaluate((button) => button.scrollWidth <= button.clientWidth),
    )
    .toBe(true);

  const captureDirectory = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  if (captureDirectory) {
    mkdirSync(captureDirectory, { recursive: true });
    await page.screenshot({
      path: join(captureDirectory, "desktop-1000x600.png"),
    });
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(liveFilter).toBeVisible();
  await expect
    .poll(() =>
      liveFilter.evaluate((button) => button.scrollWidth <= button.clientWidth),
    )
    .toBe(true);
  if (captureDirectory) {
    await page.screenshot({
      path: join(captureDirectory, "mobile-375x812.png"),
    });
  }
});

const fileName = "middle-click-share.html";
const middleClickFile = join(mockProjectPath, fileName);
test.afterAll(() => rmSync(middleClickFile, { force: true }));

test("middle click on a shared file's link opens its public play view", async ({
  page,
  baseURL,
}) => {
  await configureRemoteAccess(baseURL, {
    username: "public-file-play-e2e",
    password: "public-share-password-123",
    relayUrl: "ws://127.0.0.1:9/ws",
  });
  await putJson(baseURL, "/api/settings", { publicSharesEnabled: true });
  await page.route("**/api/public-shares/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, canCreate: true } });
  });
  writeFileSync(middleClickFile, "<h1>shared</h1>\n");
  const shareUrl = `https://share.example.test/share/play-secret/file?${new URLSearchParams(
    { h: "public-file-play-e2e", projectId, path: fileName },
  )}`;
  let shared = true;
  await page.route("**/api/public-file-shares?*", async (route) => {
    await route.fulfill({
      json: { items: shared ? [{ id: "share-1", url: shareUrl }] : [] },
    });
  });
  await page
    .context()
    .route("https://share.example.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "play" }),
    );

  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/file?path=${fileName}`);
  await dismissOnboardingIfVisible(page);
  const share = page
    .locator("[data-file-viewer]")
    .getByRole("button", { name: "Share file publicly" });

  // A shared file opens its play view in a new tab, with no dialog.
  const popup = page.context().waitForEvent("page");
  await share.click({ button: "middle" });
  const tab = await popup;
  await expect
    .poll(() => tab.url())
    .toBe(
      `https://share.example.test/play.html?${new URLSearchParams({
        h: "public-file-play-e2e",
        projectId,
        path: fileName,
      })}#share=play-secret`,
    );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tab.close();

  // An unshared file has no play view, so the middle click opens the dialog.
  shared = false;
  await page.mouse.move(0, 0);
  await share.click({ button: "middle" });
  await expect(page.getByRole("dialog")).toBeVisible();
});
