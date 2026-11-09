import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { routeWithDrain } from "./support/managed-routes.js";
import { recordUiCapture } from "./support/ui-capture.js";

const sessionId = "directory-context-links";
test.use({ serviceWorkers: "block", draftSessionIds: [sessionId] });

test("directory mentions resolve per occurrence and session controls stay local", async ({
  page,
  baseURL,
}) => {
  const cwd = join(e2ePaths.tempDir, "mockproject");
  const projectId = Buffer.from(cwd).toString("base64url");
  const directory = "directory-context/ar/raghda";
  mkdirSync(join(cwd, directory), { recursive: true });
  for (const path of [
    "context-readme.md",
    `${directory}/context-readme.md`,
    `${directory}/onboard.py`,
    `${directory}/score.sh`,
  ]) {
    writeFileSync(join(cwd, path), "Directory link fixture\n");
  }
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `Earlier discussion ${index}. Review the template and its scoring procedure.`,
  }));
  messages.push(
    { role: "user", text: "Show me the template files." },
    {
      role: "assistant",
      text: `Use \`${directory}/\` as the template; it already has its recording, intake (onboard.py) and scoring (score.sh).\n\nSee \`context-readme.md\` for the details.`,
    },
  );
  const sessionDirectory = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    cwd.replace(/[/\\]/g, "-"),
  );
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    join(sessionDirectory, `${sessionId}.jsonl`),
    messages
      .map((message, index) =>
        JSON.stringify({
          type: message.role,
          uuid: `${sessionId}-${index}`,
          parentUuid: index ? `${sessionId}-${index - 1}` : null,
          cwd,
          sessionId,
          timestamp: new Date(
            Date.now() - (messages.length - index) * 1000,
          ).toISOString(),
          message: { role: message.role, content: message.text },
        }),
      )
      .join("\n") + "\n",
  );

  await routeWithDrain(page, "**/api/version*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        clientDefaults: {
          ...body.clientDefaults,
          sessionToolbarPresence: {
            ...body.clientDefaults?.sessionToolbarPresence,
            renderMode: "first",
          },
        },
      },
    });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const contextualLink = page.locator(
    `a[data-ya-path="${directory}/context-readme.md"]`,
  );
  await expect(contextualLink).toHaveText(`${directory}/context-readme.md`, {
    timeout: 20000,
  });
  await expect(
    page.locator(`a[data-ya-path="${directory}/onboard.py"]`),
  ).toBeVisible();
  const control = page
    .locator('[data-session-toolbar-control="renderMode"]')
    .filter({ visible: true })
    .first();
  await control.click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Toolbar control actions" });
  const directories = menu.getByRole("combobox", {
    name: "Use Mentioned Directories",
  });
  const master = menu.getByRole("combobox", {
    name: "Link Project Paths",
    exact: true,
  });
  await expect(
    menu.getByRole("button", { name: "Hide", exact: true }),
  ).toBeVisible();
  await recordUiCapture(page, "directory-links-desktop");
  await directories.selectOption("false");
  await expect(contextualLink).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "context-readme.md", exact: true }),
  ).toBeVisible();
  await master.selectOption("false");
  await expect(directories).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "context-readme.md", exact: true }),
  ).toHaveCount(0);
  await master.selectOption("default");
  await directories.selectOption("default");
  await expect(contextualLink).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await control.click({ button: "right" });
  await expect(menu).toBeInViewport();
  await recordUiCapture(page, "directory-links-phone");
  // Link changes can scroll the transcript asynchronously. That sibling scroll
  // must not dismiss a menu anchored to the stationary composer toolbar.
  await page.locator(".session-messages").evaluate(async (transcript) => {
    const scrolled = new Promise<void>((resolve) => {
      transcript.addEventListener("scroll", () => resolve(), { once: true });
    });
    transcript.scrollTop -= 40;
    await scrolled;
  });
  await expect(menu).toBeVisible();
  const composer = page.locator("[data-composer-input]");
  let typed = "";
  for (const character of "Review the template") {
    // Update all rendered links while actual sequential keystrokes arrive.
    await directories.selectOption(typed.length % 2 ? "true" : "false");
    typed += character;
    await composer.pressSequentially(character);
    await expect(composer).toHaveValue(typed, { timeout: 100 });
    // Return to the toolbar for the next link update.
    await control.click({ button: "right" });
  }
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(contextualLink).toBeVisible();

  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/settings/appearance`);
    await page
      .getByRole("switch", { name: "Use Mentioned Directories" })
      .scrollIntoViewIfNeeded();
    await recordUiCapture(page, `directory-link-settings-${viewport.width}`);
  }
});
