import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { createPiCreationFixture } from "./support/pi-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Owned native fixture is a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
for (const hosted of [false, true])
  test(`Pi ${hosted ? "hosted" : "local"} preserves public identity through native preflight, history and cold continuation`, async ({
    browser,
  }) => {
    const owned = await createPiCreationFixture(hosted);
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1000, height: 600 },
    });
    const page = await context.newPage();
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
        throw Error("Missing owned Vite listener");
      const origin = `http://127.0.0.1:${address.port}`;
      await page.goto(
        `${origin}/new-session?projectId=${owned.projectId}&provider=pi&model=owned%2Ffixture`,
      );
      await page
        .locator("textarea.new-session-form-textarea")
        .pressSequentially("OWNED_PI_CREATION_INPUT");
      const accepted = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname.endsWith("/session-creations"),
      );
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      const response = await accepted;
      expect(response.status()).toBe(202);
      const receipt = await response.json(),
        path = `/projects/${owned.projectId}/sessions/${receipt.sessionId}`;
      await expect(page).toHaveURL(origin + path);
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.type === "prompt").length,
        )
        .toBe(1);
      const detail = async () => (await owned.request(path)).json();
      const native = (await owned.requests()).find(
        (r) => r.type === "prompt",
      )!.nativeId;
      expect(native).not.toBe(receipt.sessionId);
      expect((await detail()).session.creation.delivery).not.toBe("consumed");
      await owned.releaseAck();
      await expect
        .poll(async () => (await detail()).session.creation.delivery)
        .toBe("consumed");
      await owned.releaseReply();
      await expect(
        page.getByText("OWNED_PI_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("OWNED_PI_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      await owned.restart();
      await page.reload();
      await expect(
        page.getByText("OWNED_PI_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      const input = page.locator("textarea[data-composer-input]").first();
      await input.pressSequentially("OWNED_PI_CONTINUATION_INPUT");
      await input.press("Enter");
      await expect(
        page.getByText("OWNED_PI_CONTINUED_REPLY", { exact: true }).first(),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("OWNED_PI_CONTINUED_REPLY", { exact: true }).first(),
      ).toBeVisible();
      await expect(page).toHaveURL(origin + path);
      await expect(
        page.getByText("OWNED_PI_CREATION_REPLY", { exact: true }).first(),
      ).toBeVisible();
      const rows = await owned.requests();
      const launches = rows.filter((r) => r.op === "launch" && !r.noSession);
      expect(launches.filter((r) => !r.resumed)).toHaveLength(1);
      expect(launches.every((r) => r.nativeId === native)).toBe(true);
      expect(rows.filter((r) => r.type === "prompt")).toHaveLength(2);
      expect(
        (await owned.request(`/projects/${owned.projectId}/sessions/${native}`))
          .status,
      ).toBe(404);
      const ids = (
        await (
          await owned.request(`/projects/${owned.projectId}/sessions`)
        ).json()
      ).sessions.map((s: { id: string }) => s.id);
      expect(ids.filter((id: string) => id === receipt.sessionId)).toHaveLength(
        1,
      );
      expect(ids).not.toContain(native);
      if (!hosted) {
        await recordUiCapture(page, "pi-creation-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await expect(
          page.getByText("OWNED_PI_CONTINUED_REPLY", { exact: true }).first(),
        ).toBeVisible();
        await recordUiCapture(page, "pi-creation-phone");
      }
    } finally {
      await context.close();
      await vite?.close();
      await owned.close();
    }
  });

for (const refusal of [false, true])
  test(`Pi ${refusal ? "preflight refusal" : "owner loss before preflight"} preserves input without replay`, async () => {
    const owned = await createPiCreationFixture(
      false,
      refusal ? { YEP_E2E_PI_REFUSE: "1" } : {},
    );
    try {
      const body = {
        requestId: "owned-pi-unconfirmed",
        provider: "pi",
        model: "owned/fixture",
        message: "OWNED_UNCONFIRMED_PI",
      };
      const endpoint = `/projects/${owned.projectId}/session-creations`;
      const response = await owned.request(endpoint, body);
      expect(response.status).toBe(202);
      const receipt = await response.json(),
        path = `/projects/${owned.projectId}/sessions/${receipt.sessionId}`;
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter((r) => r.type === "prompt").length,
        )
        .toBe(1);
      expect(
        (await (await owned.request(path)).json()).session.creation.delivery,
      ).not.toBe("consumed");
      await owned.crashServer();
      await owned.restart();
      const d = await (await owned.request(path)).json();
      expect(d.session.id).toBe(receipt.sessionId);
      expect(d.session.initialPrompt).toBe(body.message);
      expect(d.session.creation.delivery).toBe("uncertain");
      expect(
        (await owned.request(path + "/resume", { message: "must refuse" }))
          .status,
      ).toBe(409);
      expect(
        (await (await owned.request(endpoint, body)).json()).sessionId,
      ).toBe(receipt.sessionId);
      expect(
        (await owned.requests()).filter((r) => r.type === "prompt"),
      ).toHaveLength(1);
    } finally {
      await owned.close();
    }
  });

for (const layout of ["outside", "root", "deep"])
  test(`Pi native ${layout} file refuses before prompt delivery`, async () => {
    const owned = await createPiCreationFixture(false, {
      YEP_E2E_PI_OUTSIDE_FILE: layout === "outside" ? "1" : "0",
      YEP_E2E_PI_LAYOUT: layout,
    });
    try {
      const body = {
        requestId: "owned-pi-outside",
        provider: "pi",
        model: "owned/fixture",
        message: "OWNED_PI_OUTSIDE_INPUT",
      };
      const endpoint = `/projects/${owned.projectId}/session-creations`;
      const response = await owned.request(endpoint, body);
      expect(response.status).toBe(202);
      const receipt = await response.json();
      const detail = async () =>
        (
          await owned.request(
            `/projects/${owned.projectId}/sessions/${receipt.sessionId}`,
          )
        ).json();
      await expect
        .poll(async () => (await detail()).session.creation.state)
        .toMatch(/failed|uncertain/);
      const saved = (await detail()).session;
      expect(saved.initialPrompt).toBe(body.message);
      expect(saved.creation.delivery).not.toBe("consumed");
      expect(
        (await owned.requests()).filter((r) => r.type === "prompt"),
      ).toHaveLength(0);
    } finally {
      await owned.close();
    }
  });
