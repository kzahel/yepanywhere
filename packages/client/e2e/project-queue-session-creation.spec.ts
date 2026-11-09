import { unlink } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Owned native fixture is a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
for (const hosted of [false, true])
  test(`Project Queue ${hosted ? "hosted" : "local"} creation hands off stable identity and cold history`, async () => {
    const owned = await createCodexCreationFixture(hosted);
    try {
      const enqueue = await owned.request(
        `/projects/${owned.projectId}/queue`,
        {
          target: {
            type: "new-session",
            provider: "codex",
            model: "gpt-6.1-sol",
          },
          message: { text: "OWNED_DURABLE_PROJECT_QUEUE" },
        },
      );
      expect(enqueue.status).toBe(201);
      const item = (await enqueue.json()).item;
      const promoted = await owned.request(
        `/project-queue/${owned.projectId}/promote-now`,
        { itemId: item.id, force: true },
      );
      expect(promoted.status).toBe(200);
      const result = (await promoted.json()).promoteResult;
      expect(result.promoted).toBe(true);
      expect(result.sessionId).toBeTruthy();
      const path = `/projects/${owned.projectId}/sessions/${result.sessionId}`;
      const detail = async () => await (await owned.request(path)).json();
      expect((await detail()).session.initialPrompt).toBe(
        "OWNED_DURABLE_PROJECT_QUEUE",
      );
      expect((await detail()).session.creation.delivery).not.toBe("consumed");
      await owned.releaseAck();
      await owned.releaseReply();
      await expect
        .poll(async () => (await detail()).session.creation.delivery)
        .toBe("consumed");
      await expect
        .poll(async () => JSON.stringify((await detail()).messages))
        .toContain("OWNED_CODEX_CREATION_REPLY");
      await owned.restart();
      expect(JSON.stringify((await detail()).messages)).toContain(
        "OWNED_CODEX_CREATION_REPLY",
      );
      const rows = await owned.requests();
      expect(rows.filter((r) => r.method === "thread/start")).toHaveLength(1);
      expect(rows.filter((r) => r.method === "turn/start")).toHaveLength(1);
      expect(
        (
          await (
            await owned.request(`/projects/${owned.projectId}/queue`)
          ).json()
        ).items,
      ).toHaveLength(0);
    } finally {
      await owned.close();
    }
  });

test("failed Queue creation links to its saved session and does not expose an edit that would change admitted input", async ({
  browser,
}) => {
  const owned = await createCodexCreationFixture(
    false,
    false,
    {},
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  try {
    await unlink(owned.server.restartEnv.YEP_DESKTOP_CODEX_CLI_PATH!);
    const enqueue = await owned.request(`/projects/${owned.projectId}/queue`, {
      target: { type: "new-session", provider: "codex", model: "gpt-6.1-sol" },
      message: { text: "OWNED_FAILED_QUEUE_INPUT" },
    });
    expect(enqueue.status).toBe(201);
    const item = (await enqueue.json()).item;
    const promoted = (
      await (
        await owned.request(`/project-queue/${owned.projectId}/promote-now`, {
          itemId: item.id,
          force: true,
        })
      ).json()
    ).promoteResult;
    expect(promoted.promoted).toBe(false);
    const failed = (
      await (await owned.request(`/projects/${owned.projectId}/queue`)).json()
    ).items[0];
    expect(failed.creationSessionId).toBeTruthy();
    const origin = owned.server.baseUrl;
    await page.goto(origin + `/projects?queueItem=${item.id}`);
    const row = page.locator(`[data-project-queue-item-id="${item.id}"]`);
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("link", { name: "Open saved session" }),
    ).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await recordUiCapture(page, "queue-saved-creation-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      row.getByRole("link", { name: "Open saved session" }),
    ).toBeVisible();
    await recordUiCapture(page, "queue-saved-creation-phone");
    await row.getByRole("link", { name: "Open saved session" }).click();
    await expect(page).toHaveURL(
      origin +
        `/projects/${owned.projectId}/sessions/${failed.creationSessionId}`,
    );
    await expect(
      page.getByText("OWNED_FAILED_QUEUE_INPUT", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await context.close();
    await owned.close();
  }
});
