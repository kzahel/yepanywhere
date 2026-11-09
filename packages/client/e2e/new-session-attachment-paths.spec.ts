import { join } from "node:path";
import type { Page, Request } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

/**
 * Pins what New Session's draft attachments do today, before
 * docs/tactical/188-shared-composer-draft-attachments.md moves them onto
 * the hook the session page uses: a staged file comes back after a reload
 * and follows in a sibling tab, a file removed while it uploads is dropped
 * and deleted from staging, and an upload in flight guards leaving.
 */

// These cases own the worker's new-session draft, which the fixture clears
// before each one.
test.use({ draftSessionIds: [], serviceWorkers: "block" });

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);

const composer = (page: Page) =>
  page.locator("textarea.new-session-form-textarea");

const open = async (page: Page, baseURL: string | undefined) => {
  await page.goto(`${baseURL}/new-session?projectId=${projectId}`);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
};

const attach = (page: Page, name: string) =>
  page.locator(".new-session-form-toolbar input[type=file]").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`contents of ${name}`),
  });

const chip = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`Remove ${name}`) });

const validatePath = /\/api\/attachments\/staging\/drafts\/[^/]+\/validate$/;

const json = (
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  status: number,
  body: unknown,
) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

test("a staged file comes back after a reload, and a failed check keeps it with a notice", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await attach(page, "pin-new-reload.txt");
  await expect(chip(page, "pin-new-reload.txt")).toBeVisible();
  // Whether the saved draft still records the staged file.
  const savedDraftNamesFile = () =>
    page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        localStorage.getItem(key)?.includes("pin-new-reload.txt"),
      ),
    );
  await expect.poll(savedDraftNamesFile).toBe(true);
  const reload = async () => {
    await page.reload();
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  };

  await reload();
  await expect(chip(page, "pin-new-reload.txt")).toBeVisible();

  // The check itself fails: say so, and keep the chip.
  await page.route(validatePath, (route) =>
    json(route, 500, { error: "pin failure" }),
  );
  await reload();
  await expect(
    page
      .getByRole("alert")
      .filter({
        hasText: "Could not check draft attachments. Your draft has been kept.",
      })
      .first(),
  ).toBeVisible();
  await expect(chip(page, "pin-new-reload.txt")).toBeVisible();
  expect(await savedDraftNamesFile()).toBe(true);

  // A file the server no longer holds is not pinned here: today the
  // outcome depends on whether the server's capabilities have loaded
  // before the first check (plan 188, item 26).
});

test("a staged file added or removed in one tab follows in a sibling tab", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  const sibling = await page.context().newPage();
  await open(sibling, baseURL);

  await attach(page, "pin-new-sibling.txt");
  await expect(chip(page, "pin-new-sibling.txt")).toBeVisible();
  await expect(chip(sibling, "pin-new-sibling.txt")).toBeVisible();

  await chip(page, "pin-new-sibling.txt").click();
  await expect(chip(page, "pin-new-sibling.txt")).toHaveCount(0);
  await expect(chip(sibling, "pin-new-sibling.txt")).toHaveCount(0);
  await sibling.close();
});

test("a file removed while it uploads is dropped and deleted from staging", async ({
  page,
  baseURL,
}) => {
  // Hold the server's replies on the upload socket until the chip is
  // removed, so the upload finishes after the remove.
  let release = () => {};
  await page.routeWebSocket(/\/upload\/ws/, (ws) => {
    const server = ws.connectToServer();
    const held: (string | Buffer)[] = [];
    let holding = true;
    release = () => {
      holding = false;
      for (const message of held.splice(0)) ws.send(message);
    };
    server.onMessage((message) => {
      if (holding) held.push(message);
      else ws.send(message);
    });
  });
  const deletes: string[] = [];
  page.on("request", (request: Request) => {
    if (
      request.method() === "DELETE" &&
      /\/api\/attachments\/staging\/drafts\//.test(request.url())
    )
      deletes.push(request.url());
  });
  await open(page, baseURL);
  await attach(page, "pin-new-cancel.txt");
  await expect(chip(page, "pin-new-cancel.txt")).toBeVisible();
  await chip(page, "pin-new-cancel.txt").click();
  await expect(chip(page, "pin-new-cancel.txt")).toHaveCount(0);

  release();
  await expect.poll(() => deletes.length).toBe(1);
  await expect(chip(page, "pin-new-cancel.txt")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an upload in flight asks before the page is left", async ({
  page,
  baseURL,
}) => {
  // Closed by the case, so not the fixture's own page.
  const leaving = await page.context().newPage();
  // The upload socket never answers, so the upload stays in flight.
  await leaving.routeWebSocket(/\/upload\/ws/, () => {});
  await open(leaving, baseURL);
  // A page the user has not touched may leave without asking.
  await composer(leaving).click();
  await attach(leaving, "pin-new-held.txt");
  await expect(chip(leaving, "pin-new-held.txt")).toBeVisible();

  const dialog = leaving.waitForEvent("dialog");
  await leaving.close({ runBeforeUnload: true });
  const asked = await dialog;
  expect(asked.type()).toBe("beforeunload");
  await asked.accept();
});
