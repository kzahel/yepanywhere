import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.setTimeout(90_000);
test.skip(
  process.platform === "win32",
  "Owned native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());

// A real browser is needed for DataTransfer, nested drag events, viewport
// geometry and sequential input during asynchronous attachment preparation.
test("file drops stage draft attachments in new and existing sessions", async ({
  browser,
}) => {
  const owned = await createCodexCreationFixture(false);
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
    colorScheme: "dark",
  });
  let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
  try {
    vite = await createTestViteServer({
      configFile: resolve("vite.config.ts"),
      root: process.cwd(),
      server: {
        host: "127.0.0.1",
        hmr: false,
        proxy: { "/api": { target: owned.server.baseUrl, ws: true } },
      },
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string")
      throw Error("Missing owned listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const creationRequests: unknown[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/session-creations")
      )
        creationRequests.push(request.postDataJSON());
    });
    await page.goto(
      `${origin}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
    );
    const composer = page.locator("textarea.new-session-form-textarea");
    await expect(composer).toBeVisible();
    await composer.pressSequentially("Use the attached references.");
    const surface = page.locator("[data-file-drop-surface]");
    const transfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["first reference"], "reference.txt", { type: "text/plain" }),
      );
      transfer.items.add(
        new File(["second reference"], "notes.md", { type: "text/markdown" }),
      );
      return transfer;
    });
    const overlay = page
      .getByRole("status")
      .filter({ hasText: "Drop files to attach" });
    await surface.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(overlay).toBeVisible();
    // Crossing descendants must not flicker or dismiss the target.
    await composer.dispatchEvent("dragenter", { dataTransfer: transfer });
    await surface.dispatchEvent("dragleave", { dataTransfer: transfer });
    await expect(overlay).toBeVisible();
    await expect(composer).toBeFocused();
    await recordUiCapture(page, "attachment-drop-new-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await recordUiCapture(page, "attachment-drop-new-phone");
    const box = await overlay.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBeTruthy();
    await composer.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(overlay).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove reference.txt", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove notes.md", exact: true }),
    ).toBeVisible();
    await expect(composer).toHaveValue("Use the attached references.");
    expect(creationRequests).toHaveLength(0);
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeEnabled();
    await recordUiCapture(page, "attachment-drop-added-phone");
    await page.setViewportSize({ width: 1000, height: 600 });
    await recordUiCapture(page, "attachment-drop-added-desktop");

    const textUntouched = await composer.evaluate((node) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "ordinary text");
      const event = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      node.dispatchEvent(event);
      return !event.defaultPrevented;
    });
    expect(textUntouched).toBe(true);
    await surface.dispatchEvent("dragenter", { dataTransfer: transfer });
    await composer.press("Escape");
    await expect(overlay).toHaveCount(0);

    await owned.releaseAck();
    await owned.releaseReply();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page).toHaveURL(/\/sessions\//);
    await expect.poll(() => creationRequests.length).toBe(1);
    const input = page.locator("textarea[data-composer-input]").first();
    await expect(input).toBeEnabled();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }),
    ).toBeVisible();
    const sessionSurface = page.locator("[data-file-drop-surface]");
    // Hold real image preparation while keys and attachment updates arrive.
    const release = await page.evaluateHandle(() => {
      const original = window.createImageBitmap.bind(window);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      window.createImageBitmap = (async (
        source: ImageBitmapSource,
        options?: ImageBitmapOptions,
      ) => {
        await held;
        return original(source, options);
      }) as typeof createImageBitmap;
      return () => {
        window.createImageBitmap = original;
        release();
      };
    });
    const imageTransfer = await page.evaluateHandle(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(Error("PNG encoding failed")),
          "image/png",
        ),
      );
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([blob], "dropped.png", { type: "image/png" }),
      );
      return transfer;
    });
    await input.click();
    await sessionSurface.dispatchEvent("dragenter", {
      dataTransfer: imageTransfer,
    });
    await expect(overlay).toBeVisible();
    await recordUiCapture(page, "attachment-drop-session-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await recordUiCapture(page, "attachment-drop-session-phone");
    await input.dispatchEvent("drop", { dataTransfer: imageTransfer });
    await expect(overlay).toHaveCount(0);
    let text = "";
    for (const character of "Keep every key while the attachment uploads.") {
      await input.pressSequentially(character);
      text += character;
      await expect(input).toHaveValue(text, { timeout: 100 });
      if (text.length === 10) await release.evaluate((release) => release());
    }
    await expect(
      page.getByRole("button", { name: "Remove dropped.png", exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue(text);
    expect(creationRequests).toHaveLength(1);
    expect(errors).toEqual([]);
    await transfer.dispose();
    await imageTransfer.dispose();
    await release.dispose();
  } finally {
    await context.close();
    await vite?.close();
    await owned.close();
  }
});
