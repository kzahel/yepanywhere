import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/types";
import {
  asCodeMode,
  simulatedInline,
  simulatedNestedTool,
  simulatedPublish,
  publishSchema,
  assistant,
} from "../test-fixtures/workflow";
import { e2ePaths, expect, test } from "./fixtures.js";

async function saveTranscript(
  baseURL: string,
  sessionId: string,
  messages: Message[],
) {
  const projectPath = join(e2ePaths.tempDir, "mockproject");
  const directory = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    projectPath.replace(/[/\\]/g, "-"),
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${sessionId}.jsonl`),
    `${messages
      .map((message, index) =>
        JSON.stringify({
          type: message.role,
          uuid: message.id,
          parentUuid: index ? messages[index - 1]?.id : null,
          cwd: projectPath,
          sessionId,
          timestamp: new Date(Date.UTC(2026, 8, 7, 0, 0, index)).toISOString(),
          message: { role: message.role, content: message.content },
        }),
      )
      .join("\n")}\n`,
  );
  // This suite tests schema rendering, not provider discovery. Wait for its
  // owned session to be usable by the composer before opening the browser;
  // native file discovery and the access resolver update asynchronously.
  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/drafts/read`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ slot: { kind: "session", sessionId } }),
        });
        return response.status;
      },
      { intervals: [25, 50, 100, 250] },
    )
    .toBe(200);
  return Buffer.from(projectPath).toString("base64url");
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`publish progress stays visible with source collapsed at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-workflow-tags-enabled", "true");
      localStorage.setItem("yep-anywhere-conversation-view-enabled", "false");
    });
    const schemaPath = join(
      e2ePaths.tempDir,
      "mockproject",
      "publish-lede.json",
    );
    writeFileSync(schemaPath, JSON.stringify(publishSchema));
    const declaration = `@@visualization-schema/1 ${schemaPath}#ya-publish/1`;
    const progress =
      "Checking completed commits, active work, and the publication checkout.";
    const reportPath = join(
      e2ePaths.tempDir,
      "mockproject",
      "publish-report.md",
    );
    writeFileSync(reportPath, "# Publication checks\n\nReady to publish.");
    const sessionId = `workflow-lede-${viewport.name}`;
    const projectId = await saveTranscript(baseURL, sessionId, [
      assistant(
        "publish-lede",
        `${declaration}\n[workflow][start] id=publish-test schema=ya-publish/1\n[publish][prepare] ${progress} Read [the report](<${reportPath}>).`,
      ),
    ]);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    const output = page.locator("[data-workflow-output]");
    const toggle = output.getByRole("button", {
      name: "Expand original output",
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(output.getByText(progress, { exact: false })).toBeVisible();
    await expect(
      output.getByText("Workflow schema · Publish YA", { exact: true }),
    ).toBeVisible();
    await expect(output).not.toContainText("@@visualization-schema/1");
    await expect(
      output.getByRole("link", { name: "the report", exact: true }),
    ).toBeVisible();
    await expect(output).not.toContainText("[the report](");
    await toggle.click();
    await expect(output.locator("[data-workflow-original]")).toContainText(
      declaration,
    );
    await output
      .getByRole("button", { name: "Collapse original output" })
      .click();
    await expect(output.getByText(progress, { exact: false })).toBeVisible();
    await output.getByRole("link", { name: "the report", exact: true }).click();
    await expect(page.locator("[data-file-viewer-modal]")).toBeVisible();
    await expect(page.locator("[data-file-viewer-modal]")).toContainText(
      "Publication checks",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-file-viewer-modal]")).not.toBeVisible();
    const captureDir =
      process.env.YEP_E2E_UI_CAPTURE_DIR ?? testInfo.outputPath("captures");
    mkdirSync(captureDir, { recursive: true });
    await page.mouse.move(0, 0);
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);
    await page.screenshot({
      path: join(captureDir, `publish-lede-${viewport.name}.png`),
    });
    const schemaLink = output.getByRole("link", {
      name: "Workflow schema · Publish YA",
      exact: true,
    });
    await schemaLink.click();
    await expect(page.locator("[data-file-viewer-modal]")).toBeVisible();
    await expect(page.locator("[data-file-viewer-modal]")).toContainText(
      "ya-publish/1",
    );
  });

  test(`file-reference, inline and nested schemas at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(60000);
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error")
        failures.push(message.text());
    });
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-conversation-view-enabled", "false");
      const now = Date.now;
      Date.now = () =>
        now() +
        Number(sessionStorage.getItem("workflow-test-time-offset") ?? 0);
    });
    const sessionId = `workflow-publish-${viewport.name}`;
    const schemaPath = join(
      e2ePaths.tempDir,
      "mockproject",
      `workflow schema [${viewport.name}].${viewport.name === "desktop" ? "json" : "md"}`,
    );
    const json = JSON.stringify(publishSchema, null, 2);
    const schemaContent =
      viewport.name === "desktop"
        ? json
        : `# Publish schema\n\n\`\`\`json\n${json}\n\`\`\`\n`;
    writeFileSync(schemaPath, schemaContent);
    const reference = `${schemaPath}#ya-publish/1`;
    const messages = simulatedPublish(reference);
    expect(messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "schema",
        content: `@@visualization-schema/1 ${reference}\n`,
      },
    ]);
    const codeModeFormat = viewport.name === "desktop" ? "command" : "settled";
    const projectId = await saveTranscript(
      baseURL,
      sessionId,
      asCodeMode(messages, codeModeFormat),
    );
    const fileRequests: string[] = [];
    page.on("request", (request) => {
      const requested = new URL(request.url());
      if (requested.pathname === `/api/projects/${projectId}/files/raw`)
        fileRequests.push(requested.searchParams.get("path") ?? "");
    });
    const url = `${baseURL}/projects/${projectId}/sessions/${sessionId}`;
    await page.goto(url);
    await expect(
      page.locator('[data-render-id="publish-client-0"]'),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-workflow-boundary]")).toHaveCount(0);
    expect(fileRequests).toEqual([]);

    await page.goto(`${baseURL}/settings/appearance`);
    const setting = page.getByRole("switch", {
      name: "Workflow tag highlighting",
    });
    await expect(setting).not.toBeChecked();
    await setting.locator("..").click();
    await expect(setting).toBeChecked();
    const fileResponse = page.waitForResponse((response) => {
      const requested = new URL(response.url());
      return (
        requested.pathname === `/api/projects/${projectId}/files/raw` &&
        requested.searchParams.get("path") === schemaPath
      );
    });
    await page.goto(url);
    const response = await fileResponse;
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe(schemaContent);
    const etag = response.headers().etag;
    expect(etag).toBeTruthy();
    const client = page.locator('[data-workflow-path="[publish][client]"]');
    await expect(client).toBeVisible({ timeout: 10000 });
    await expect(client).toContainText("Publish the hosted client");
    await expect(
      page.locator('[data-workflow-schema="activation"]'),
    ).toHaveText("Workflow schema · Publish YA");
    const pages = page.locator('[data-render-id="pages"]');
    await expect(pages.locator("[data-workflow-parent]")).toHaveAttribute(
      "data-workflow-parent",
      "[publish][client]",
    );
    await expect(pages.locator("[data-workflow-boundary]")).toHaveCount(0);
    await expect(page.locator('[data-workflow-boundary="end"]')).toContainText(
      "completed",
    );
    await expect(
      page
        .getByText("Nothing merged, pushed, or deployed.", { exact: false })
        .first(),
    ).toBeVisible();
    await client.scrollIntoViewIfNeeded();
    const captureDir =
      process.env.YEP_E2E_UI_CAPTURE_DIR ?? testInfo.outputPath("captures");
    mkdirSync(captureDir, { recursive: true });
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: join(captureDir, `publish-${viewport.name}.png`),
      animations: "disabled",
    });
    // Fresh cache survives reload without another read.
    await page.reload();
    await expect(client).toContainText("Publish the hosted client");
    expect(fileRequests).toEqual([schemaPath]);

    const cachedSchemas = await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith("ya:workflow-schema-files:"))
        .map(([key, value]) => ({ key, ...JSON.parse(value) })),
    );
    expect(cachedSchemas).toEqual([expect.objectContaining({ etag })]);

    // Advance the client's cache clock; the real server must answer 304.
    const unchangedResponse = page.waitForResponse(
      (reply) => reply.url() === response.url(),
    );
    await page.evaluate(() => {
      sessionStorage.setItem(
        "workflow-test-time-offset",
        String(5 * 60 * 1000),
      );
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const unchanged = await unchangedResponse;
    expect((await unchanged.request().allHeaders())["if-none-match"]).toBe(
      etag,
    );
    expect(unchanged.status()).toBe(304);
    await expect(client).toContainText("Publish the hosted client");

    // A new generation is fetched after the renewed TTL and updates labels.
    writeFileSync(
      schemaPath,
      schemaContent.replace(
        '"title": "Publish YA"',
        '"title": "Updated publish"',
      ),
    );
    const changedResponse = page.waitForResponse(
      (reply) => reply.url() === response.url(),
    );
    await page.evaluate(() => {
      sessionStorage.setItem(
        "workflow-test-time-offset",
        String(10 * 60 * 1000),
      );
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const changed = await changedResponse;
    expect((await changed.request().allHeaders())["if-none-match"]).toBe(etag);
    expect(changed.status()).toBe(200);
    expect(changed.headers().etag).not.toBe(etag);
    await expect(
      page.locator('[data-workflow-schema="activation"]'),
    ).toHaveText("Workflow schema · Updated publish");
    expect(fileRequests).toEqual([schemaPath, schemaPath, schemaPath]);

    // Expire only as the next document starts, without cancelling a demand
    // revalidation launched in the old page between a clock jump and reload.
    await page.addInitScript(() =>
      sessionStorage.setItem(
        "workflow-test-time-offset",
        String(15 * 60 * 1000),
      ),
    );
    const reloadedResponse = page.waitForResponse(
      (reply) => reply.url() === response.url(),
    );
    await page.reload();
    const reloaded = await reloadedResponse;
    expect(reloaded.status()).toBe(304);
    expect((await reloaded.request().allHeaders())["if-none-match"]).toBe(
      changed.headers().etag,
    );
    await expect(
      page.locator('[data-workflow-schema="activation"]'),
    ).toHaveText("Workflow schema · Updated publish");

    const inlineSessionId = `workflow-inline-${viewport.name}`;
    await saveTranscript(
      baseURL,
      inlineSessionId,
      asCodeMode(simulatedInline(), codeModeFormat),
    );
    const inlineUrl = `${baseURL}/projects/${projectId}/sessions/${inlineSessionId}`;
    await page.goto(inlineUrl);
    const tool = page.locator('[data-render-id="inline-tool"]');
    await expect(
      tool.locator('[data-workflow-path="[build][check][types]"]'),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      tool.locator('[data-workflow-path="[build][report]"]'),
    ).toBeVisible();
    await expect(tool).toContainText(
      "Ordinary diagnostic remains in this span.",
    );
    await expect(
      tool.locator('[data-workflow-path="[build][build][extra]"]'),
    ).toHaveCount(0);
    await tool.scrollIntoViewIfNeeded();
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: join(captureDir, `inline-${viewport.name}.png`),
      animations: "disabled",
    });
    const before = await page
      .locator("[data-workflow-boundary]")
      .allTextContents();
    await page.reload();
    await expect(page.locator("[data-workflow-boundary]")).toHaveCount(
      before.length,
    );
    expect(
      await page.locator("[data-workflow-boundary]").allTextContents(),
    ).toEqual(before);
    await tool.getByRole("button", { name: "Expand original output" }).click();
    await expect(
      tool.getByRole("button", { name: "Collapse original output" }),
    ).toHaveText("−");
    await expect(tool.locator("[data-workflow-original]")).toContainText(
      "[build][extra] Not whitelisted.",
    );
    for (const mode of [
      "inherited",
      "self-announced",
      "matching-lines",
    ] as const) {
      const nestedId = `workflow-nested-${mode}-${viewport.name}`;
      await saveTranscript(
        baseURL,
        nestedId,
        asCodeMode(simulatedNestedTool(mode), codeModeFormat),
      );
      await page.goto(`${baseURL}/projects/${projectId}/sessions/${nestedId}`);
      const script = page.locator('[data-render-id="nested-script"]');
      await expect(
        script.locator(
          '[data-workflow-path="[publish][client][build][types]"]',
        ),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        script.locator('[data-workflow-boundary="stage"]'),
      ).toHaveCount(2);
      await expect(
        page.locator('[data-render-id="after-script"] [data-workflow-parent]'),
      ).toHaveAttribute("data-workflow-parent", "[publish][source]");
      await expect(
        page.locator('[data-workflow-boundary="end"]'),
      ).toContainText("completed");
      const preview = script.locator("[data-workflow-output] > pre");
      await expect(preview).toContainText("Diagnostic after activation.");
      if (mode === "self-announced") {
        await expect(
          script.locator('[data-workflow-schema="activation"]'),
        ).toHaveCount(0);
        await expect(
          script.locator('[data-workflow-boundary="activation"]'),
        ).toHaveCount(1);
        await expect(preview).toContainText("Before activation.");
        await script.scrollIntoViewIfNeeded();
        await expect(
          page.getByText("Server changed", { exact: false }),
        ).toHaveCount(0);
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: join(captureDir, `nested-${viewport.name}.png`),
          animations: "disabled",
        });
      } else if (mode === "matching-lines") {
        await expect(preview).not.toContainText("Before activation.");
        await script
          .getByRole("button", { name: "Expand original output" })
          .click();
        await expect(script.locator("[data-workflow-original]")).toContainText(
          "Before activation.",
        );
      }
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    // Inline declarations must not cause schema-file requests.
    expect(fileRequests).toEqual([
      schemaPath,
      schemaPath,
      schemaPath,
      schemaPath,
    ]);
    expect(failures).toEqual([]);
  });
}
