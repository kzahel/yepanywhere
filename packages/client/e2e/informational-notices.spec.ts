import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`shows provider notices without conversation turns at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const projectPath = join(e2ePaths.tempDir, "mockproject");
    const directory = join(
      e2ePaths.claudeSessionsDir,
      hostname(),
      projectPath.replace(/[/\\]/g, "-"),
    );
    mkdirSync(directory, { recursive: true });
    const sessionId = `informational-${viewport.name}`;
    const warning =
      "Remote Control disconnected — Claude.ai login expired — run /login to restore Remote Control";
    writeFileSync(
      join(directory, `${sessionId}.jsonl`),
      [
        { type: "mode", mode: "normal", sessionId },
        {
          type: "system",
          subtype: "informational",
          level: "warning",
          content: warning,
          uuid: "warning",
          parentUuid: null,
          timestamp: "2026-09-13T15:57:25.295Z",
          cwd: projectPath,
          sessionId,
        },
        {
          type: "system",
          subtype: "informational",
          level: "info",
          content: "Remote Control is available",
          uuid: "info",
          parentUuid: "warning",
          timestamp: "2026-09-13T15:58:25.295Z",
          cwd: projectPath,
          sessionId,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const projectId = Buffer.from(projectPath).toString("base64url");
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await expect(page.locator("[data-system-message-warning]")).toHaveText(
      `!${warning}`,
    );
    await expect(
      page.getByText("Remote Control is available", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Session not found", { exact: true }),
    ).toHaveCount(0);
    const notice = page.locator('[data-render-id="warning"]');
    await expect(notice).toBeVisible();
    const box = await notice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    await recordUiCapture(page, `informational-${viewport.name}`, viewport);
  });
}
