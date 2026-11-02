import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { createOpenCodeCreationFixture } from "./support/opencode-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Owned native fixture is a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
for (const hosted of [false, true])
  test(`OpenCode ${hosted ? "hosted" : "local"} keeps public identity through streaming, native confirmation, reload and cold continuation`, async ({
    browser,
  }) => {
    const owned = await createOpenCodeCreationFixture(hosted);
    let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1000, height: 600 },
    });
    const page = await context.newPage();
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
        throw new Error("Missing fixture listener");
      const origin = `http://127.0.0.1:${address.port}`;
      await page.goto(
        `${origin}/new-session?projectId=${owned.projectId}&provider=opencode&model=opencode%2Ffixture`,
      );
      await page
        .locator("textarea.new-session-form-textarea")
        .pressSequentially("OWNED_OPENCODE_CREATION_INPUT");
      const acceptance = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname.endsWith("/session-creations"),
      );
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      const accepted = await acceptance;
      expect(accepted.status()).toBe(202);
      const receipt = await accepted.json();
      expect(receipt.provider).toBe("opencode");
      expect(receipt.sessionId.startsWith("ses_")).toBe(false);
      const path = `/projects/${owned.projectId}/sessions/${receipt.sessionId}`;
      await expect(page).toHaveURL(origin + path);
      await expect
        .poll(
          async () =>
            (await owned.requests()).filter(
              (r) =>
                r.method === "POST" &&
                /\/session\/ses_[^/]+\/message$/.test(r.path),
            ).length,
        )
        .toBe(1);
      const detail = async () => (await owned.request(path)).json();
      expect((await detail()).session.creation.delivery).not.toBe("consumed");
      const native = (await owned.requests())
        .find(
          (r) =>
            r.method === "POST" &&
            /\/session\/ses_[^/]+\/message$/.test(r.path),
        )!
        .path.split("/")[2];
      expect(native).not.toBe(receipt.sessionId);
      await owned.releaseStream();
      await expect(
        page
          .getByText("OWNED_OPENCODE_CREATION_REPLY", { exact: true })
          .first(),
      ).toBeVisible();
      expect((await detail()).session.creation.delivery).not.toBe("consumed");
      await owned.releaseReply();
      await expect
        .poll(async () => (await detail()).session.creation.delivery)
        .toBe("consumed");
      await page.reload();
      await expect(
        page
          .getByText("OWNED_OPENCODE_CREATION_REPLY", { exact: true })
          .first(),
      ).toBeVisible();
      await owned.restart();
      await page.reload();
      await expect(
        page
          .getByText("OWNED_OPENCODE_CREATION_REPLY", { exact: true })
          .first(),
      ).toBeVisible();
      const input = page.locator("textarea[data-composer-input]").first();
      await input.pressSequentially("OWNED_OPENCODE_CONTINUATION_INPUT");
      await input.press("Enter");
      await expect(
        page
          .getByText("OWNED_OPENCODE_CONTINUED_REPLY", { exact: true })
          .first(),
      ).toBeVisible();
      await expect(page).toHaveURL(origin + path);
      await page.reload();
      await expect(
        page
          .getByText("OWNED_OPENCODE_CONTINUED_REPLY", { exact: true })
          .first(),
      ).toBeVisible();
      const requests = await owned.requests();
      expect(
        requests.filter((r) => r.method === "POST" && r.path === "/session"),
      ).toHaveLength(1);
      expect(
        requests.filter(
          (r) => r.method === "POST" && r.path === `/session/${native}/message`,
        ),
      ).toHaveLength(2);
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
        await recordUiCapture(page, "opencode-creation-desktop");
        await page.setViewportSize({ width: 375, height: 812 });
        await expect(
          page
            .getByText("OWNED_OPENCODE_CONTINUED_REPLY", { exact: true })
            .first(),
        ).toBeVisible();
        await recordUiCapture(page, "opencode-creation-phone");
      }
    } finally {
      await context.close();
      await vite?.close();
      await owned.close();
    }
  });

test("OpenCode owner loss before native HTTP confirmation retains saved input without replay", async () => {
  const owned = await createOpenCodeCreationFixture(false);
  try {
    const body = {
      requestId: "owned-opencode-lost-owner",
      provider: "opencode",
      model: "opencode/fixture",
      message: "OWNED_UNCONFIRMED_OPENCODE",
    };
    const r = await owned.request(
      `/projects/${owned.projectId}/session-creations`,
      body,
    );
    expect(r.status).toBe(202);
    const receipt = await r.json();
    const path = `/projects/${owned.projectId}/sessions/${receipt.sessionId}`;
    await expect
      .poll(
        async () =>
          (await owned.requests()).filter(
            (r) => r.method === "POST" && r.path.endsWith("/message"),
          ).length,
      )
      .toBe(1);
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
      (
        await owned.request(
          `/projects/${owned.projectId}/session-creations`,
          body,
        )
      ).status,
    ).toBe(202);
    expect(
      (await owned.requests()).filter(
        (r) => r.method === "POST" && r.path.endsWith("/message"),
      ),
    ).toHaveLength(1);
  } finally {
    await owned.close();
  }
});

for (const fileless of [false, true])
  test(`OpenCode ${fileless ? "unobservable store" : "native HTTP refusal"} retains saved input without false confirmation`, async () => {
    const owned = await createOpenCodeCreationFixture(false, {
      [fileless ? "YEP_E2E_OPENCODE_FILELESS" : "YEP_E2E_OPENCODE_REFUSE"]: "1",
    });
    try {
      const body = {
        requestId: "owned-opencode-refused",
        provider: "opencode",
        model: "opencode/fixture",
        message: "OWNED_REFUSED_OPENCODE",
      };
      const path = `/projects/${owned.projectId}/session-creations`;
      const response = await owned.request(path, body);
      expect(response.status).toBe(202);
      const receipt = await response.json();
      const detail = async () =>
        (
          await owned.request(
            `/projects/${owned.projectId}/sessions/${receipt.sessionId}`,
          )
        ).json();
      if (fileless) {
        await expect
          .poll(async () => (await detail()).session.creation.state)
          .toMatch(/failed|uncertain/);
      } else {
        await expect
          .poll(
            async () =>
              (await owned.requests()).filter(
                (r) => r.method === "POST" && r.path.endsWith("/message"),
              ).length,
          )
          .toBe(1);
        // Native allocation is proved; a rejected turn is not input proof.
        expect((await detail()).session.creation.state).toBe("bound");
      }
      const saved = (await detail()).session;
      expect(saved.initialPrompt).toBe(body.message);
      expect(saved.creation.delivery).not.toBe("consumed");
      expect((await (await owned.request(path, body)).json()).sessionId).toBe(
        receipt.sessionId,
      );
      const requests = await owned.requests();
      expect(
        requests.filter((r) => r.method === "POST" && r.path === "/session"),
      ).toHaveLength(fileless ? 0 : 1);
      expect(
        requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/message"),
        ),
      ).toHaveLength(fileless ? 0 : 1);
    } finally {
      await owned.close();
    }
  });
