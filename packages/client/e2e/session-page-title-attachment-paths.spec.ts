import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  json,
  openSessionPage,
  projectId,
  sessionId,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page's title editing and composer attachments do
 * today, before docs/tactical/181-session-page-feature-hooks.md moves them
 * out of SessionPage.tsx into hooks. Title saves are answered here so the
 * shared fixture session keeps its title; each case checks the request, the
 * toast and the header or composer.
 */

// Wide enough that Rename edits inline in the header rather than in a dialog.
test.use({ serviceWorkers: "block", viewport: { width: 1600, height: 900 } });

const metadataPath = `/sessions/${sessionId}/metadata`;
const retitlePath = `/projects/${projectId}/sessions/${sessionId}/retitle`;
const saved = (route: Parameters<typeof json>[0]) =>
  json(route, 200, { updated: true });

async function startRename(page: Page) {
  await page
    .locator(".session-header")
    .getByRole("button", { name: "Session options" })
    .click();
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  return page.getByLabel("Session title");
}

test("Rename saves the typed title on Enter, and Escape cancels without a request", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, saved);
  const title = session.header.locator(".session-title-text");
  const original = (await title.textContent()) ?? "";

  let input = await startRename(page);
  await input.fill("Discarded title");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(title).toHaveText(original);
  expect(session.requests()).toEqual([]);

  input = await startRename(page);
  await input.fill("Pinned new title");
  await input.press("Enter");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ title: "Pinned new title" });
  await expect(session.toast("Session renamed")).toBeVisible();
  await expect(title).toHaveText("Pinned new title");
});

test("a failed rename says so and keeps the editor open", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, (route) =>
    json(route, 500, { error: "Metadata store unavailable" }),
  );
  const input = await startRename(page);
  await input.fill("Title that will not save");
  await input.press("Enter");

  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  await expect(session.toast("Failed to rename session").first()).toBeVisible();
  await expect(input).toHaveValue("Title that will not save");
});

test("leaving the inline rename field saves a changed title and cancels an unchanged one", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, saved);
  const elsewhere = page.locator(".message-list").getByText("Previous message");

  let input = await startRename(page);
  await elsewhere.click();
  await expect(input).toHaveCount(0);
  expect(session.requests()).toEqual([]);

  input = await startRename(page);
  await input.fill("Saved on blur");
  await elsewhere.click();
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ title: "Saved on blur" });
  await expect(session.header.locator(".session-title-text")).toHaveText(
    "Saved on blur",
  );
});

test("Generate Title proposes from the current title, then saves the proposal", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("POST", retitlePath, (route) =>
    json(route, 200, {
      title: "Generated pin title",
      generatorSessionId: "pin-generator",
    }),
  );
  await session.answer("PUT", metadataPath, saved);
  const title = session.header.locator(".session-title-text");
  const original = (await title.textContent()) ?? "";
  await session.header.getByRole("button", { name: "Session options" }).click();
  await page
    .getByRole("menuitem", { name: "Generate Title (uses tokens)" })
    .click();

  await expect
    .poll(session.requests)
    .toEqual([`POST ${retitlePath}`, `PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    currentTitle: original,
    lengthTarget: expect.any(Number),
  });
  expect(session.calls[1]?.body).toEqual({ title: "Generated pin title" });
  await expect(session.toast("Session renamed")).toBeVisible();
  await expect(title).toHaveText("Generated pin title");
});

// A failed proposal leaves the field editable in retitle mode: Enter
// accepts nothing (there is no proposal), and Ctrl+Enter saves the typed
// title.
test("after Generate Title fails, Enter does nothing and Ctrl+Enter saves the typed title", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("POST", retitlePath, (route) =>
    json(route, 500, { error: "Retitle refused by pin" }),
  );
  await session.answer("PUT", metadataPath, saved);
  const title = session.header.locator(".session-title-text");
  const original = (await title.textContent()) ?? "";
  await session.header.getByRole("button", { name: "Session options" }).click();
  await page
    .getByRole("menuitem", { name: "Generate Title (uses tokens)" })
    .click();

  await expect.poll(session.requests).toEqual([`POST ${retitlePath}`]);
  await expect(page.getByText("Retitle refused by pin")).toBeVisible();
  // The retitle field, not the rename editor (which manual Rename opens).
  const field = session.header.locator("input.session-title-input");
  await expect(field).toBeEditable();
  await expect(field).toHaveValue(original);
  await field.press("Enter");
  await expect(field).toBeVisible();
  expect(session.requests()).toEqual([`POST ${retitlePath}`]);

  await field.fill("Typed after a failed proposal");
  await field.press("Control+Enter");
  await expect
    .poll(session.requests)
    .toEqual([`POST ${retitlePath}`, `PUT ${metadataPath}`]);
  expect(session.calls[1]?.body).toEqual({
    title: "Typed after a failed proposal",
  });
  await expect(title).toHaveText("Typed after a failed proposal");
});

test("/title saves a typed title, and bare /title generates and applies one", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, saved);
  await session.answer("POST", retitlePath, (route) =>
    json(route, 200, {
      title: "Generated from command",
      generatorSessionId: "pin-generator",
    }),
  );
  const title = session.header.locator(".session-title-text");
  // Bare /title generates only once forks (and so title generation) are
  // offered.
  await session.forksOffered();

  await session.composer.fill("/title Typed command title");
  await session.composer.press("Enter");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ title: "Typed command title" });
  await expect(session.composer).toHaveValue("");
  await expect(title).toHaveText("Typed command title");

  await session.composer.fill("/title");
  await session.composer.press("Enter");
  await expect
    .poll(session.requests)
    .toEqual([
      `PUT ${metadataPath}`,
      `POST ${retitlePath}`,
      `PUT ${metadataPath}`,
    ]);
  expect(session.calls[1]?.body).toMatchObject({
    currentTitle: "Typed command title",
  });
  expect(session.calls[2]?.body).toEqual({ title: "Generated from command" });
  await expect(session.composer).toHaveValue("");
  await expect(title).toHaveText("Generated from command");
});

const attach = (page: Page, name: string) =>
  page
    .locator(".message-input-wrapper input[type=file]")
    .first()
    .setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(`contents of ${name}`),
    });

test("a failed upload names the file in its toast", async ({
  page,
  baseURL,
}) => {
  // Uploads stream over their own socket; this one refuses the file.
  await page.routeWebSocket(/\/upload\/ws/, (socket) => {
    socket.onMessage(() => {
      socket.send(
        JSON.stringify({
          type: "error",
          message: "Disk full by pin",
          code: "PIN",
        }),
      );
    });
  });
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await attach(page, "pin-refused.txt");

  await expect(
    session.toast("Failed to upload pin-refused.txt: Disk full by pin"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Remove pin-refused\.txt/ }),
  ).toHaveCount(0);
});

test("removing a staged attachment deletes its staged copy", async ({
  page,
  baseURL,
}) => {
  const deletes: string[] = [];
  await page.route(
    /\/api\/attachments\/staging\/drafts\/[^/]+\/[^/]+$/,
    (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes.push(new URL(route.request().url()).pathname);
      return json(route, 200, { deleted: true });
    },
  );
  await openSessionPage(page, baseURL, { owner: "none" });
  await attach(page, "pin-staged.txt");
  const remove = page.getByRole("button", { name: /Remove pin-staged\.txt/ });
  await expect(remove).toBeVisible();
  await remove.click();

  await expect(remove).toHaveCount(0);
  await expect.poll(() => deletes.length).toBe(1);
  expect(deletes[0]).toMatch(
    /^\/api\/attachments\/staging\/drafts\/[^/]+\/[^/]+$/,
  );
});

test("an incoming share attaches its file to the composer and drops the share parameter", async ({
  page,
  baseURL,
}) => {
  // The service worker stores a share in IndexedDB; store one the same way.
  await page.goto(`${baseURL}/api/version`);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("ya-incoming-shares", 1);
        open.onupgradeneeded = () =>
          open.result.createObjectStore("shares", { keyPath: "id" });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction("shares", "readwrite");
          transaction.objectStore("shares").put({
            id: "pin-share",
            createdAt: Date.now(),
            files: [
              {
                blob: new Blob(["shared notes"], { type: "text/plain" }),
                name: "pin-shared.txt",
                type: "text/plain",
                lastModified: Date.now(),
              },
            ],
          });
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await openSessionPage(page, baseURL, {
    owner: "none",
    arrive: (page) =>
      page.goto(
        `${baseURL}/projects/${projectId}/sessions/${sessionId}?__ya_share=pin-share`,
      ),
  });

  await expect(
    page.getByRole("button", { name: /Remove pin-shared\.txt/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname.endsWith(`/sessions/${sessionId}`) &&
      !url.searchParams.has("__ya_share"),
  );
});
