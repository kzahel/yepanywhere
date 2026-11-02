import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Owned native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());

for (const hosted of [false, true])
  test(`staged ${hosted ? "hosted" : "local"} creation retains input and newer typing before native acknowledgement`, async ({
    browser,
  }) => {
    const owned = await createCodexCreationFixture(hosted);
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1000, height: 600 },
    });
    let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
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
      const requests: string[] = [];
      page.on("request", (req) => {
        if (req.method() === "POST") requests.push(new URL(req.url()).pathname);
      });
      await page.goto(
        `${origin}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
      );
      const composer = page.locator("textarea.new-session-form-textarea");
      const original = hosted ? "" : "OWNED_ATTACHMENT_CREATION";
      if (original) await composer.pressSequentially(original);
      await page.locator('input[type="file"]').setInputFiles({
        name: "accepted.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("OWNED_ATTACHMENT_BYTES"),
      });
      await expect(
        page.getByText("accepted.txt", { exact: true }).first(),
      ).toBeVisible();
      await expect
        .poll(() =>
          page
            .getByRole("button", { name: "Start session", exact: true })
            .isEnabled(),
        )
        .toBe(true);
      let receipt: { sessionId: string; projectId: string } | undefined;
      let resolveAccepted!: () => void;
      const accepted = new Promise<void>((yes) => {
        resolveAccepted = yes;
      });
      await page.route("**/session-creations", async (route) => {
        const body = route.request().postDataJSON();
        expect(body.stagedAttachments).toHaveLength(1);
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        receipt = await response.json();
        resolveAccepted();
        await held;
        await route.fulfill({ response });
      });
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await accepted;
      await expect(composer).toBeEditable();
      const finishUpload = hosted
        ? await page.evaluateHandle(() => {
            const original = window.createImageBitmap.bind(window);
            let release!: () => void;
            const held = new Promise<void>((yes) => {
              release = yes;
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
          })
        : undefined;
      if (hosted) {
        await composer.evaluate((node) => {
          const transfer = new DataTransfer();
          const bytes = Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
            ),
            (c) => c.charCodeAt(0),
          );
          transfer.items.add(
            new File([bytes], "newer.png", { type: "image/png" }),
          );
          node.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
            }),
          );
        });
        await expect(
          page.getByText("newer.png", { exact: true }).first(),
        ).toBeVisible();
      }
      let expected = original;
      for (const character of hosted ? "" : " newer work") {
        await composer.pressSequentially(character);
        expected += character;
        await expect(composer).toHaveValue(expected, { timeout: 100 });
      }
      release();
      await expect(
        page.getByRole("button", { name: "Open saved session", exact: true }),
      ).toBeVisible();
      await expect(composer).toHaveValue(expected);
      if (hosted) {
        await expect(
          page.getByText("newer.png", { exact: true }).first(),
        ).toBeVisible();
        await finishUpload!.evaluate((release) => release());
        await expect(
          page.getByRole("button", { name: "Start session", exact: true }),
        ).toBeEnabled();
        await expect(composer).toHaveValue(original);
      }
      if (!hosted) {
        await recordUiCapture(page, "attachment-creation-newer-draft-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await recordUiCapture(page, "attachment-creation-newer-draft-phone");
      }
      const path = `/projects/${receipt!.projectId}/sessions/${receipt!.sessionId}`;
      await page
        .getByRole("button", { name: "Open saved session", exact: true })
        .click();
      await expect(page).toHaveURL(origin + path);
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.method === "turn/start")
              .length,
        )
        .toBe(1);
      const turn = (await owned.requests()).find(
        (r) => r.method === "turn/start",
      );
      const text = turn.params.input
        .filter((i: { type: string }) => i.type === "text")
        .map((i: { text: string }) => i.text)
        .join("\n");
      expect(text).toContain("accepted.txt");
      expect(text).toContain(receipt!.sessionId);
      expect(text).not.toContain("newer work");
      // The native text prompt names the immutable materialized file.
      const attachmentPath = text.match(/(?:\/[\w. -]+)+accepted\.txt/)?.[0];
      expect(attachmentPath).toBeTruthy();
      expect(await readFile(attachmentPath!, "utf8")).toBe(
        "OWNED_ATTACHMENT_BYTES",
      );
      expect(
        requests.filter((p) =>
          /\/sessions\/(?:create|[^/]+\/messages)$/.test(p),
        ),
      ).toHaveLength(0);
      await owned.releaseAck();
      await owned.releaseReply();
      await expect
        .poll(
          async () =>
            (await (await owned.request(path)).json()).session.creation
              .delivery,
        )
        .toBe("consumed");
      await context.close();
      await owned.restart();
      expect(
        JSON.stringify((await (await owned.request(path)).json()).messages),
      ).toContain("OWNED_CODEX_CREATION_REPLY");
      expect(
        (await owned.requests()).filter((r) => r.method === "thread/start"),
      ).toHaveLength(1);
    } finally {
      release();
      await context.close();
      await vite?.close();
      await owned.close();
    }
  });

test("definitive attachment refusals preserve the draft and allow corrected input with a fresh operation", async ({
  browser,
}) => {
  const owned = await createCodexCreationFixture(false);
  const context = await browser.newContext({ serviceWorkers: "block" });
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
    await page.goto(
      `${origin}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
    );
    const composer = page.locator("textarea.new-session-form-textarea");
    await composer.pressSequentially("OWNED_CORRECTED_ATTACHMENT");
    await page.locator('input[type="file"]').setInputFiles({
      name: "retained.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retained"),
    });
    const start = page.getByRole("button", {
      name: "Start session",
      exact: true,
    });
    await expect(start).toBeEnabled();
    const keys: string[] = [];
    await page.route("**/session-creations", async (route) => {
      const body = route.request().postDataJSON();
      keys.push(body.requestId);
      if (keys.length === 1)
        body.stagedAttachments = Array.from(
          { length: 65 },
          () => body.stagedAttachments[0],
        );
      if (keys.length === 2)
        body.stagedAttachments = [
          { ...body.stagedAttachments[0], id: "owned-missing-staged-ref" },
        ];
      const response = await route.fetch({ postData: JSON.stringify(body) });
      if (keys.length <= 2) {
        expect(response.status()).toBe(400);
        expect((await response.json()).reason).toBe("creation-not-accepted");
      }
      await route.fulfill({ response });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/session-creations"),
      );
      await start.click();
      expect((await refused).status()).toBe(400);
      await expect(start).toBeEnabled();
      await expect(composer).toHaveValue("OWNED_CORRECTED_ATTACHMENT");
      await expect(
        page.getByText("retained.txt", { exact: true }).first(),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.startsWith("ya-text-creation:"),
            ).length,
        ),
      ).toBe(0);
      expect(
        (await owned.requests()).filter((r) => r.method === "thread/start"),
      ).toHaveLength(0);
    }
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await start.click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    const receipt = await response.json();
    await expect(page).toHaveURL(
      `${origin}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
    );
    expect(new Set(keys).size).toBe(3);
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter((r) => r.method === "turn/start")
            .length,
      )
      .toBe(1);
    expect(
      (await owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(1);
  } finally {
    await context.close();
    await vite?.close();
    await owned.close();
  }
});
