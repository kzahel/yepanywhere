import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const sessionId = "file-line-links";
test.use({ serviceWorkers: "block", draftSessionIds: [sessionId] });

test("a cited line links separately from its path", async ({
  page,
  baseURL,
}) => {
  const cwd = join(e2ePaths.tempDir, "mockproject");
  const projectId = Buffer.from(cwd).toString("base64url");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(
    join(cwd, "src/cited.ts"),
    Array.from({ length: 60 }, (_, index) => `const line${index + 1} = 0;`)
      .join("\n")
      .concat("\n"),
  );
  const messages = [
    { role: "user", text: "Why does src/cited.ts:42 fail?" },
    {
      role: "assistant",
      text: "The check at `src/cited.ts:42` runs first; src/cited.ts:44 repeats it.",
    },
  ];
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

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const pathLinks = page.getByRole("link", {
    name: "src/cited.ts",
    exact: true,
  });
  await expect(
    page.getByRole("link", { name: ":44", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  // The user prompt and the assistant's inline code and prose each cite a line.
  await expect(pathLinks).toHaveCount(3);
  await expect(
    page.getByRole("link", { name: ":42", exact: true }),
  ).toHaveCount(2);
  await recordUiCapture(page, "file-line-links-desktop");

  await page.getByRole("link", { name: ":44", exact: true }).click();
  await expect(page.locator("[data-highlighted-line-start]")).toContainText(
    "const line44",
  );
  await page.keyboard.press("Escape");
  await pathLinks.last().click();
  await expect(page.getByText("const line1 = 0;")).toBeVisible();
  await expect(page.locator("[data-highlighted-line-start]")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 375, height: 812 });
  // Show resting state, not the focus that closing the viewer returns.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await recordUiCapture(page, "file-line-links-phone");
});
