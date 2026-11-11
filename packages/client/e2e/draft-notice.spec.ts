import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import type { DraftRead, DraftWriteResult } from "@yep-anywhere/shared";

test.use({ serviceWorkers: "block" });

// This owns the actual page/layout boundary: background sync in Inbox must not
// produce a banner; opening that draft's session must expose its inline review.
test("draft review belongs to its session composer, never the Inbox", async ({
  page,
  baseURL,
}) => {
  const sessionId = "mock-session-001";
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const slot = { kind: "session" as const, sessionId };
  const headers = { "X-Yep-Anywhere": "true" };
  const readResponse = await page.request.post(`${baseURL}/api/drafts/read`, {
    headers,
    data: { slot },
  });
  expect(readResponse.ok(), await readResponse.text()).toBe(true);
  const read: DraftRead = await readResponse.json();
  const baseResponse = await page.request.post(`${baseURL}/api/drafts/write`, {
    headers,
    data: {
      slot,
      baseRevision: read.snapshot.revision,
      ticket: read.ticket,
      operationId: crypto.randomUUID(),
      payload: { fields: { text: "Base draft" }, attachments: [] },
    },
  });
  expect(baseResponse.ok()).toBe(true);
  const base: DraftWriteResult = await baseResponse.json();
  const remoteResponse = await page.request.post(
    `${baseURL}/api/drafts/write`,
    {
      headers,
      data: {
        slot,
        baseRevision: base.snapshot.revision,
        ticket: base.ticket,
        operationId: crypto.randomUUID(),
        payload: { fields: { text: "Draft edited on phone" }, attachments: [] },
      },
    },
  );
  expect(remoteResponse.ok(), await remoteResponse.text()).toBe(true);
  await page.addInitScript(
    ({ base, sessionId }) => {
      const key = `draft-message-${sessionId}`;
      if (localStorage.getItem(key)) return;
      const raw = JSON.stringify({
        version: 1,
        text: "Draft edited on desktop",
      });
      localStorage.setItem(key, raw);
      localStorage.setItem(
        `draft-sync-v1:local::${encodeURIComponent(key)}`,
        JSON.stringify({ raw, base }),
      );
    },
    { base: base.snapshot, sessionId },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/inbox`);
  await expect(
    page.getByRole("banner").getByText("Inbox", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Draft needs attention" }),
  ).toHaveCount(0);
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("[data-message-input-wrapper]");
  const notice = composer.getByRole("status", {
    name: "Draft needs attention",
  });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Review draft changes" }).click();
  await expect(
    notice.getByText("Draft edited on desktop", { exact: true }),
  ).toBeVisible();
  await expect(
    notice.getByText("Draft edited on phone", { exact: true }),
  ).toBeVisible();
  const input = composer.locator("[data-composer-input]");
  await expect(input).toHaveValue("Draft edited on desktop");
  await recordUiCapture(page, "session-draft-review-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(
    notice.getByRole("button", { name: "Use other version" }),
  ).toBeVisible();
  await expect(input).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await recordUiCapture(page, "session-draft-review-phone");
  await notice.getByRole("button", { name: "Close review" }).click();
  await expect(input).toHaveValue("Draft edited on desktop");
  await notice.getByRole("button", { name: "Review draft changes" }).click();
  await notice.getByRole("button", { name: "Keep mine" }).click();
  await expect(notice).toHaveCount(0);
  await expect(input).toHaveValue("Draft edited on desktop");
});
