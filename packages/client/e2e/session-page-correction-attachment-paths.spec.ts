import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  json,
  openSessionPage,
  sessionId,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page's correction draft and composer attachment
 * state do today, before docs/tactical/187-session-page-draft-hooks.md
 * moves them out of SessionPage.tsx into hooks: a correction sets the
 * draft and its attachments aside and Cancel brings both back, a finished
 * correction forgets what it set aside, an upload in flight guards
 * leaving, and a staged attachment comes back from the saved draft after a
 * reload and in a sibling tab.
 */

test.use({ serviceWorkers: "block" });

// An 8x8 PNG, so the chip shows a preview from its object URL.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4Y2yMFTEMLQkACspMgdVP2G4AAAAASUVORK5CYII=",
  "base64",
);

const attach = (page: Page, name: string) =>
  page
    .locator(".message-input-wrapper input[type=file]")
    .first()
    .setInputFiles(
      name.endsWith(".png")
        ? { name, mimeType: "image/png", buffer: png }
        : {
            name,
            mimeType: "text/plain",
            buffer: Buffer.from(`contents of ${name}`),
          },
    );

const chip = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`Remove ${name}`) });

// Whether `url` loads into a new image. A revoked object URL fails to load
// there, though an image already showing it may still draw it from the
// image cache. (A fetch of an object URL fails in these tests whether it is
// revoked or not.)
const urlLoads = (page: Page, url: string) =>
  page.evaluate(
    (src) =>
      new Promise<boolean>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth > 0);
        image.onerror = () => resolve(false);
        image.src = src;
      }),
    url,
  );

const chipPreviewUrl = (page: Page) =>
  page
    .locator(".attachment-list img")
    .first()
    .evaluate((image) => (image as HTMLImageElement).src);

// Loads the chip's preview URL into a new image.
const previewLoads = (page: Page) =>
  expect
    .poll(() =>
      chipPreviewUrl(page)
        .then((url) => urlLoads(page, url))
        .catch(() => false),
    )
    .toBe(true);

const editLatest = (page: Page) =>
  page
    .getByRole("button", { name: "Edit latest message" })
    .click({ force: true });

const correcting = (page: Page) => page.getByText("Correcting latest message");

const validatePath = /\/api\/attachments\/staging\/drafts\/[^/]+\/validate$/;

test("a correction sets the draft and its attachment aside, and Cancel brings both back", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  await session.composer.pressSequentially("Half-written note");
  await attach(page, "pin-aside.png");
  await expect(chip(page, "pin-aside.png")).toBeVisible();
  await previewLoads(page);

  await editLatest(page);
  await expect(session.composer).toHaveValue("Previous message");
  await expect(correcting(page)).toBeVisible();
  await expect(chip(page, "pin-aside.png")).toHaveCount(0);

  // A second correction keeps the first set-aside draft.
  await session.composer.fill("Previous message, half corrected");
  await editLatest(page);
  await expect(session.composer).toHaveValue("Previous message");

  await page.getByRole("button", { name: "Cancel correction" }).click();
  await expect(correcting(page)).toHaveCount(0);
  await expect(session.composer).toHaveValue("Half-written note");
  await expect(chip(page, "pin-aside.png")).toBeVisible();
  // The set-aside preview was kept, not revoked.
  await previewLoads(page);
});

test("a second correction discards the composer's attachment and revokes its preview, and keeps the set-aside one", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  await attach(page, "pin-aside.png");
  await expect(chip(page, "pin-aside.png")).toBeVisible();
  await editLatest(page);
  await expect(correcting(page)).toBeVisible();

  await attach(page, "pin-discarded.png");
  await expect(chip(page, "pin-discarded.png")).toBeVisible();
  await previewLoads(page);
  const discarded = await chipPreviewUrl(page);

  await editLatest(page);
  await expect(chip(page, "pin-discarded.png")).toHaveCount(0);
  await expect.poll(() => urlLoads(page, discarded)).toBe(false);

  await page.getByRole("button", { name: "Cancel correction" }).click();
  await expect(session.composer).toHaveValue("");
  await expect(chip(page, "pin-aside.png")).toBeVisible();
  await previewLoads(page);
});

test("a correction that is sent forgets the draft it set aside", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  await session.answer("POST", `/sessions/${sessionId}/messages`, (route) =>
    json(route, 200, { queued: true, serverTimestamp: Date.now() }),
  );
  await session.composer.pressSequentially("Draft before the edit");
  await editLatest(page);
  await expect(session.composer).toHaveValue("Previous message");
  await session.composer.fill("Previous message, corrected");
  await session.composer.press("Enter");
  await expect
    .poll(session.requests)
    .toEqual([`POST /sessions/${sessionId}/messages`]);
  await expect(correcting(page)).toHaveCount(0);
  await expect(session.composer).toHaveValue("");

  // Had the first draft been kept, Cancel would bring it back here.
  await editLatest(page);
  await expect(session.composer).toHaveValue("Previous message");
  await page.getByRole("button", { name: "Cancel correction" }).click();
  await expect(correcting(page)).toHaveCount(0);
  await expect(session.composer).toHaveValue("");
});

test("an upload in flight asks before the page is left", async ({
  page,
  baseURL,
}) => {
  // Closed by the case, so not the fixture's own page.
  const leaving = await page.context().newPage();
  // The upload socket never answers, so the upload stays in flight.
  await leaving.routeWebSocket(/\/upload\/ws/, () => {});
  const session = await openSessionPage(leaving, baseURL, { owner: "none" });
  // A page the user has not touched may leave without asking.
  await session.composer.click();
  await attach(leaving, "pin-held.txt");
  await expect(leaving.locator(".attachment-list")).toBeVisible();

  const dialog = leaving.waitForEvent("dialog");
  await leaving.close({ runBeforeUnload: true });
  const asked = await dialog;
  expect(asked.type()).toBe("beforeunload");
  await asked.accept();
});

// The test server offers draft sync, so these are the draft-sync rules: the
// chip shows from the saved draft, and a file the server no longer holds
// keeps its chip with a notice. (Plan 187 pinned a quiet drop here, which
// was the page checking before the server's capabilities had loaded; see
// docs/tactical/188-shared-composer-draft-attachments.md item 26.)
test("a staged attachment comes back after a reload; a failed check or a missing file keeps it with one notice", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await attach(page, "pin-reload.txt");
  await expect(chip(page, "pin-reload.txt")).toBeVisible();
  const reload = async () => {
    await page.reload();
    await expect(session.composer).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".message-list").getByText("Previous message").first(),
    ).toBeVisible();
  };
  // Whether the saved draft still records the staged file.
  const savedDraftNamesFile = () =>
    page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        localStorage.getItem(key)?.includes("pin-reload.txt"),
      ),
    );
  await expect.poll(savedDraftNamesFile).toBe(true);

  await reload();
  await expect(chip(page, "pin-reload.txt")).toBeVisible();

  // The check itself fails: say so, and keep the chip.
  await page.route(validatePath, (route) =>
    json(route, 500, { error: "pin failure" }),
  );
  await reload();
  // The page checks once on load, so it says so once.
  const failed = page.getByRole("alert").filter({
    hasText: "Could not check draft attachments. Your draft has been kept.",
  });
  await expect(failed).toBeVisible();
  await expect(chip(page, "pin-reload.txt")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(failed).toHaveCount(1);
  expect(await savedDraftNamesFile()).toBe(true);

  // The server no longer holds it: under draft sync the chip and the saved
  // draft keep it, and the page says so once.
  await page.unroute(validatePath);
  await page.route(validatePath, (route) => json(route, 200, { refs: [] }));
  await reload();
  const gone = page
    .getByRole("alert")
    .filter({ hasText: "Draft attachments were no longer available." });
  await expect(gone).toBeVisible();
  await expect(chip(page, "pin-reload.txt")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(gone).toHaveCount(1);
  expect(await savedDraftNamesFile()).toBe(true);
});

test("a staged attachment added or removed in one tab follows in a sibling tab", async ({
  page,
  baseURL,
}) => {
  await openSessionPage(page, baseURL, { owner: "none" });
  const sibling = await page.context().newPage();
  await openSessionPage(sibling, baseURL, { owner: "none" });

  await attach(page, "pin-sibling.txt");
  await expect(chip(page, "pin-sibling.txt")).toBeVisible();
  await expect(chip(sibling, "pin-sibling.txt")).toBeVisible();

  await chip(page, "pin-sibling.txt").click();
  await expect(chip(page, "pin-sibling.txt")).toHaveCount(0);
  await expect(chip(sibling, "pin-sibling.txt")).toHaveCount(0);
  await sibling.close();
});
