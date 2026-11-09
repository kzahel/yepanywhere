import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDraftBrowserServer } from "../../server/test/drafts/browserServer";
import { RendezDraftDelivery } from "../../server/src/services/RendezDraftDelivery";
import { createUploadRoutes } from "../../server/src/routes/upload";
import type { ProjectScanner } from "../../server/src/projects/scanner";
import { ProjectStoragePolicy } from "../../server/src/projects/projectStoragePolicy";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";

let api: Awaited<ReturnType<typeof startDraftBrowserServer>>;
let server: Awaited<ReturnType<typeof createTestViteServer>>;
let delivery: RendezDraftDelivery;
let base: string;
let sends = 0;
const slot = { kind: "session", sessionId: "draft-history-1" } as const;
test.beforeAll(async () => {
  api = await startDraftBrowserServer();
  delivery = new RendezDraftDelivery(api.store, api.staging);
  api.app.route(
    "/api",
    createUploadRoutes({
      scanner: {
        getOrCreateProject: async (id: string) =>
          id === "history" ? { id, path: join(api.dir, "project") } : null,
      } as unknown as ProjectScanner,
      upgradeWebSocket: () => () => {
        throw new Error("WebSocket uploads are outside this fixture");
      },
      attachmentStagingService: api.staging,
      rendezDraftDelivery: delivery,
      storagePolicy: new ProjectStoragePolicy({
        dataDir: api.dir,
        getMode: () => "app-data",
      }),
    }),
  );
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1", proxy: { "/api": { target: api.url } } },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
  await delivery?.close();
  await api?.close();
  await presentUiCaptures();
});
async function upload() {
  const id = randomUUID();
  const path = join(api.dir, `${id}.txt`);
  await writeFile(path, "screenshot bytes");
  const result = await delivery.stage(
    slot.sessionId,
    id,
    "upload",
    {
      version: 1,
      id,
      route: slot.sessionId,
      target: {
        harness: "codex",
        providerSessionId: slot.sessionId,
        yaSessionId: slot.sessionId,
      },
      state: "pending",
      createdAt: Date.now(),
      originalName: "screenshot.txt",
      path,
      size: 16,
      mimeType: "text/plain",
    },
    async () => {
      sends++;
      return { accepted: true };
    },
  );
  expect(result.accepted).toBe(true);
  return api.store.read("", slot).snapshot.payload.attachments.at(-1)!;
}
test("uploads join begun drafts and typing holds the countdown without losing keys", async ({
  page,
}) => {
  // CI 40528845817 exhausted 15s on all three attempts during typing, before
  // the required 10.5s no-auto-send observation (local full case: 29.4s).
  // Allow 4x that CI limit and 2x the local completion;
  // the browser-measured per-keystroke acknowledgement still must stay <100ms.
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${base}e2e/fixtures/rendez-composer.html`);
  const input = page.locator("textarea").first();
  await expect(input).toBeVisible();
  await input.pressSequentially("Explain this screenshot", { delay: 20 });
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.fields.text, {
      timeout: 10000,
    })
    .toBe("Explain this screenshot");
  await upload();
  await expect(
    page.getByText("Ready with your message", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(input).toHaveValue("Explain this screenshot");
  await recordUiCapture(page, "rendez-existing-draft-desktop");
  await input.press("Enter");
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.attachments.length, {
      timeout: 10000,
    })
    .toBe(0);
  await upload();
  // Focus revalidation uses the same real draft HTTP path as an arriving upload.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/Sends in \d+s/)).toBeVisible({ timeout: 10000 });
  await upload();
  await expect(page.getByText("screenshot.txt", { exact: true })).toHaveCount(
    2,
  );
  await expect(page.getByText(/Sends in \d+s/)).toHaveCount(1);
  await page.setViewportSize({ width: 1200, height: 600 });
  await recordUiCapture(page, "rendez-countdown-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "rendez-countdown-phone");
  // Measure event-to-render in the browser, excluding runner/IPC scheduling.
  // Keep the 100 ms gate under real sequential input and concurrent updates.
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    let keyAt = 0;
    textarea.dataset.typingCount = "0";
    textarea.dataset.typingMax = "0";
    textarea.addEventListener("keydown", (event) => {
      keyAt = event.timeStamp;
    });
    textarea.addEventListener("input", () => {
      const start = keyAt;
      requestAnimationFrame(() => {
        textarea.dataset.typingCount = String(
          Number(textarea.dataset.typingCount) + 1,
        );
        textarea.dataset.typingMax = String(
          Math.max(
            Number(textarea.dataset.typingMax),
            performance.now() - start,
          ),
        );
      });
    });
  });
  let text = "";
  const continuation =
    "Please compare these captures while I keep typing without a pause. ".repeat(
      2,
    );
  for (const key of continuation) {
    if (text.length === 4) await upload();
    await input.pressSequentially(key);
    text += key;
    expect(await input.inputValue()).toBe(text);
    await page.waitForTimeout(20);
  }
  await expect
    .poll(() => input.getAttribute("data-typing-count"))
    .toBe(String(continuation.length));
  expect(Number(await input.getAttribute("data-typing-max"))).toBeLessThan(100);
  await expect(page.getByText("screenshot.txt", { exact: true })).toHaveCount(
    3,
    {
      timeout: 1500,
    },
  );
  await expect
    .poll(() =>
      api.store
        .read("", slot)
        .snapshot.payload.attachments.every(
          (ref) => ref.rendezAutoSendAt === null,
        ),
    )
    .toBe(true);
  // Clearing the field must not re-arm the held countdown. The timer itself
  // is covered with fake time in RendezDraftDelivery.test.ts; here the cleared
  // field must reach the server and leave every upload held.
  await input.fill("");
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.fields.text ?? "")
    .toBe("");
  expect(
    api.store
      .read("", slot)
      .snapshot.payload.attachments.every(
        (ref) => ref.rendezAutoSendAt === null,
      ),
  ).toBe(true);
  await expect(page.getByText(/Sends in \d+s/)).toHaveCount(0);
  expect(sends).toBe(0);
  expect(api.store.read("", slot).snapshot.payload.attachments).toHaveLength(3);
  const firstSendIds = api.store
    .read("", slot)
    .snapshot.payload.attachments.map((ref) => ref.id);
  await input.press("Enter");
  await expect(page.getByTestId("sent-attachments")).toHaveText(
    firstSendIds.join(","),
  );
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.attachments.length)
    .toBe(0);

  // Keep change-index replies stale: Send must still collect a received file
  // whose preview hasn't made it through background reconciliation yet.
  await input.pressSequentially("Another pair", { delay: 20 });
  const visible = await upload();
  await expect(page.getByText("screenshot.txt", { exact: true })).toHaveCount(
    1,
    {
      timeout: 10000,
    },
  );
  const index = await page.request.get(`${base}api/drafts/index`);
  const staleIndex = await index.text();
  await page.route("**/api/drafts/index**", (route) =>
    route.fulfill({ contentType: "application/json", body: staleIndex }),
  );
  const hidden = await upload();
  await input.press("Enter");
  await expect(page.getByTestId("sent-attachments")).toHaveText(
    `${visible.id},${hidden.id}`,
  );
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.attachments.length)
    .toBe(0);
  await page.unroute("**/api/drafts/index**");
  await input.pressSequentially("Keep only the new capture", { delay: 20 });
  await upload();
  await expect(page.getByText("screenshot.txt", { exact: true })).toHaveCount(
    1,
    { timeout: 10000 },
  );
  const removalIndex = await page.request.get(`${base}api/drafts/index`);
  const removalBody = await removalIndex.text();
  await page.route("**/api/drafts/index**", (route) =>
    route.fulfill({ contentType: "application/json", body: removalBody }),
  );
  await page
    .getByRole("button", { name: "Remove screenshot.txt", exact: true })
    .click();
  const kept = await upload();
  await input.press("Enter");
  await expect(page.getByTestId("sent-attachments")).toHaveText(kept.id);
  await expect
    .poll(() => api.store.read("", slot).snapshot.payload.attachments.length)
    .toBe(0);
  expect(errors).toEqual([]);
});
