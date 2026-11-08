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

// Loads the chip's preview URL into a new image. A revoked object URL fails
// to load there, though the chip's own image may still show it. (A fetch of
// an object URL fails in these tests whether it is revoked or not.)
const previewLoads = (page: Page) =>
  expect
    .poll(() =>
      page
        .locator(".attachment-list img")
        .first()
        .evaluate(
          (chipImage) =>
            new Promise<boolean>((resolve) => {
              const image = new Image();
              image.onload = () => resolve(image.naturalWidth > 0);
              image.onerror = () => resolve(false);
              image.src = (chipImage as HTMLImageElement).src;
            }),
        )
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

// The test server does not offer draft sync, so these are the local-draft
// rules: the chip shows once the server confirms the staged file.
test("a staged attachment comes back after a reload; a failed check keeps it with a notice, and a missing file drops it", async ({
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
  // Each check that fails says so; the page can check twice on load.
  await expect(
    page
      .getByRole("alert")
      .filter({
        hasText: "Could not check draft attachments. Your draft has been kept.",
      })
      .first(),
  ).toBeVisible();
  await expect(chip(page, "pin-reload.txt")).toBeVisible();
  expect(await savedDraftNamesFile()).toBe(true);

  // The server no longer holds it: the saved draft forgets it, quietly.
  await page.unroute(validatePath);
  await page.route(validatePath, (route) => json(route, 200, { refs: [] }));
  await reload();
  await expect.poll(savedDraftNamesFile).toBe(false);
  await expect(chip(page, "pin-reload.txt")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
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
