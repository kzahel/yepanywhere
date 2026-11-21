import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ draftSessionIds: [], serviceWorkers: "block" });

test("provider selector is usable before aggregate discovery finishes", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aggregateStarted = false;
  await page.route(/\/api\/providers(?:\?.*)?$/, async (route) => {
    aggregateStarted = true;
    await held;
    await route.continue();
  });
  try {
    await page.goto("/new-session");
    const selector = page.locator("[data-new-session-provider-section] button");
    await expect(selector).toContainText("Claude");
    expect(aggregateStarted).toBe(true);
    await selector.click();
    await expect(
      page.getByRole("menu").getByRole("menuitemradio", { name: /^pi\b/i }),
    ).toBeVisible();
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitemradio", { name: /^Antigravity\b/ }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitemradio", { name: /^Gemini\b/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    const field = page.locator("[data-new-session-form] textarea");
    // Worker-owned services retain earlier cases' server drafts. This case
    // measures discovery/input independence, not draft recovery.
    await field.fill("");
    await field.click();
    let typed = "";
    for (const character of "provider discovery is pending") {
      typed += character;
      await field.pressSequentially(character);
      await expect(field).toHaveValue(typed, { timeout: 100 });
    }
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await recordUiCapture(page, `provider-descriptors-${viewport.width}`);
    }
  } finally {
    release();
  }
});

test("keeps retired Gemini history readable without a composer or setup row", async ({
  page,
}) => {
  const projectPath = join(e2ePaths.tempDir, "mockproject");
  const projectId = Buffer.from(projectPath).toString("base64url");
  const projectHash = createHash("sha256").update(projectPath).digest("hex");
  const chatsPath = join(e2ePaths.geminiSessionsDir, projectHash, "chats");
  const sessionId = "retired-gemini-history";
  const timestamp = "2026-11-01T12:00:00Z";
  const prompt = "Find the configuration entry for this project.";
  await mkdir(chatsPath, { recursive: true });
  await writeFile(
    join(chatsPath, `session-${sessionId}.json`),
    JSON.stringify({
      sessionId,
      projectHash,
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [
        { id: "saved-gemini-prompt", type: "user", timestamp, content: prompt },
      ],
    }),
  );

  await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
  await expect(
    page.getByRole("main").getByText(prompt, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Gemini CLI sessions are read-only.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("[data-session-input] textarea")).toHaveCount(0);
  await expect(page.locator("[data-user-prompt-correctable]")).toHaveCount(0);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `retired-gemini-history-${viewport.width}`);
  }

  await page.goto("/settings/providers");
  const antigravityRow = page.locator(
    '[data-settings-item="provider-antigravity"]',
  );
  await expect(antigravityRow).toBeVisible();
  await expect(
    page.locator('[data-settings-item^="provider-gemini"]'),
  ).toHaveCount(0);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await antigravityRow.scrollIntoViewIfNeeded();
    await recordUiCapture(page, `retired-gemini-providers-${viewport.width}`);
  }
});
