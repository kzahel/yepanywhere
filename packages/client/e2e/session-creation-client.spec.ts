import { resolve } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { createTestViteServer } from "./support/vite-server.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Controlled native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
async function fixture(browser: Browser) {
  const owned = await createCodexCreationFixture(false);
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const vite = await createTestViteServer({
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
    throw new Error("Missing owned listener");
  return {
    ...owned,
    owned,
    context,
    origin: `http://127.0.0.1:${address.port}`,
    async dispose() {
      await context.close();
      await vite.close();
      await owned.close();
    },
  };
}

test("limited New Session accepts prompt and staged files together before unavailable sandbox startup", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    expect(
      (
        await fetch(`${f.owned.server.baseUrl}/api/settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ limitedUsersEnabled: true }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.owned.request("/users", {
          username: "alice",
          password: "owned-creation-password",
          newSessionProjects: [f.projectId],
          lock: { provider: "codex", model: "gpt-6.1-sol" },
        })
      ).status,
    ).toBe(201);
    const page = await f.context.newPage();
    expect(
      (
        await page.request.post(`${f.origin}/api/users/switch`, {
          data: { username: "alice" },
          headers: { "X-Yep-Anywhere": "true" },
        })
      ).status(),
    ).toBe(200);
    const paths: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") paths.push(new URL(r.url()).pathname);
    });
    await page.goto(`${f.origin}/new-session?projectId=${f.projectId}`);
    const input = page.locator("textarea.new-session-form-textarea");
    await input.pressSequentially("OWNED_LIMITED_CREATION");
    await page.locator('input[type="file"]').setInputFiles({
      name: "limited.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("owned account file"),
    });
    const accepted = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname.endsWith("/session-creations"),
    );
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(202);
    const receipt = await response.json();
    const body = response.request().postDataJSON();
    expect(body.message).toBe("OWNED_LIMITED_CREATION");
    expect(body.stagedAttachments).toHaveLength(1);
    expect(body.sandboxLevel).toBe("project-write");
    await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
    expect(
      paths.filter((p) => /\/sessions(?:\/create|\/[^/]+\/messages)?$/.test(p)),
    ).toEqual([]);
    const detail = await (
      await page.request.get(
        `${f.origin}/api/projects/${f.projectId}/sessions/${receipt.sessionId}`,
      )
    ).json();
    expect(detail.session).toMatchObject({
      initialPrompt: "OWNED_LIMITED_CREATION",
    });
    expect(
      (
        await page.request.get(
          `${f.origin}/api/session-creations/${body.requestId}`,
        )
      ).status(),
    ).toBe(200);
    expect(
      (await f.owned.request(`/session-creations/${body.requestId}`)).status,
    ).toBe(404);
  } finally {
    await f.dispose();
  }
});

test("Session-page Start now uses one acceptance and keeps newer typing while its reply is held", async ({
  browser,
}) => {
  const f = await fixture(browser);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  try {
    expect(
      (
        await fetch(`${f.owned.server.baseUrl}/api/settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            clientDefaults: {
              sessionToolbarPresence: { projectQueueNewSessionShortcut: "pin" },
            },
          }),
        })
      ).status,
    ).toBe(200);
    await f.owned.releaseAck();
    await f.owned.releaseReply();
    const parent = await (
      await f.owned.request(`/projects/${f.projectId}/session-creations`, {
        requestId: "client_cleanup_parent",
        provider: "codex",
        model: "gpt-6.1-sol",
        message: "OWNED_CLIENT_PARENT",
      })
    ).json();
    const page = await f.context.newPage();
    await page.goto(
      `${f.origin}/projects/${f.projectId}/sessions/${parent.sessionId}`,
    );
    const input = page.locator("textarea[data-composer-input]").first();
    await expect(input).toBeEditable();
    await input.pressSequentially("OWNED_PAGE_CREATION");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "context.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("new session bytes"),
      });
    const paths: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") paths.push(new URL(r.url()).pathname);
    });
    let receipt: { sessionId: string; projectId: string } | undefined;
    let saved!: () => void;
    const accepted = new Promise<void>((r) => {
      saved = r;
    });
    await page.route("**/session-creations", async (route) => {
      expect(route.request().postDataJSON().stagedAttachments).toHaveLength(1);
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      receipt = await response.json();
      saved();
      await held;
      await route.fulfill({ response });
    });
    await expect(
      page.locator("button.project-queue-new-session-button"),
    ).toBeVisible();
    await page
      .locator("button.project-queue-new-session-button")
      .click({ button: "right" });
    await page
      .getByRole("button", { name: "Start new session now", exact: true })
      .click();
    await accepted;
    let text = "";
    for (const c of "NEWER_PAGE_DRAFT") {
      await input.pressSequentially(c);
      text += c;
      await expect(input).toHaveValue(text, { timeout: 100 });
    }
    release();
    await expect(
      page.getByRole("button", { name: "Open saved session", exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("NEWER_PAGE_DRAFT");
    expect(page.url()).toContain(parent.sessionId);
    await recordUiCapture(page, "current-client-creation-recovery-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await recordUiCapture(page, "current-client-creation-recovery-phone");
    expect(paths.filter((p) => p.endsWith("/session-creations"))).toHaveLength(
      1,
    );
    expect(
      paths.filter((p) => /\/sessions(?:\/create|\/[^/]+\/messages)?$/.test(p)),
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Open saved session", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/sessions/${receipt!.sessionId}$`),
    );
    await expect
      .poll(
        async () =>
          (await f.owned.requests()).filter((r) => r.method === "thread/start")
            .length,
      )
      .toBe(2);
  } finally {
    release?.();
    await f.dispose();
  }
});

async function originComposer(browser: Browser, linger = false) {
  const f = await fixture(browser);
  expect(
    (
      await fetch(`${f.owned.server.baseUrl}/api/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          clientDefaults: {
            sessionToolbarPresence: { projectQueueNewSessionShortcut: "pin" },
          },
        }),
      })
    ).status,
  ).toBe(200);
  await f.owned.releaseAck();
  await f.owned.releaseReply();
  const parent = await (
    await f.owned.request(`/projects/${f.projectId}/session-creations`, {
      requestId: "client_cleanup_parent",
      provider: "codex",
      model: "gpt-6.1-sol",
      message: "OWNED_CLIENT_PARENT",
    })
  ).json();
  const page = await f.context.newPage();
  if (linger)
    await page.addInitScript(() =>
      localStorage.setItem("yep-anywhere-session-dom-linger-enabled", "true"),
    );
  const path = `${f.origin}/projects/${f.projectId}/sessions/${parent.sessionId}`;
  await page.goto(path);
  const input = page.locator("textarea[data-composer-input]").first();
  await expect(input).toBeEditable();
  return {
    ...f,
    page,
    input,
    path,
    async start(files = true) {
      await input.pressSequentially("OWNED_PAGE_REQUEST");
      if (files)
        await page
          .locator('input[type="file"]')
          .first()
          .setInputFiles({
            name: "request.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("owned first input bytes"),
          });
      await page
        .locator("button.project-queue-new-session-button")
        .click({ button: "right" });
      await page
        .getByRole("button", { name: "Start new session now", exact: true })
        .click();
    },
  };
}

test("unchanged Session-page files are acknowledged once and stay cleared after return/reload", async ({
  browser,
}) => {
  const f = await originComposer(browser);
  try {
    const accepted = f.page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname.endsWith("/session-creations"),
    );
    await f.start();
    const receipt = await (await accepted).json();
    await expect(f.page).toHaveURL(
      new RegExp(`/sessions/${receipt.sessionId}$`),
    );
    await f.page.goto(f.path);
    await expect(f.input).toBeEditable();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toHaveCount(0);
    expect(
      (await f.owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("lost creation reply and recovery read reload into conditional read-only draft settlement", async ({
  browser,
}) => {
  const f = await originComposer(browser);
  let lost = true,
    posts = 0;
  try {
    await f.page.route("**/api/session-creations/*", async (route) => {
      if (lost) return route.abort("failed");
      await route.continue();
    });
    await f.page.route("**/session-creations", async (route) => {
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      await route.abort("failed");
    });
    await f.start();
    await expect(
      f.page.getByRole("button", { name: "Open saved session", exact: true }),
    ).toBeVisible();
    await expect(f.input).toHaveValue("OWNED_PAGE_REQUEST");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toBeVisible();
    lost = false;
    await f.page.reload();
    await expect(f.input).toHaveValue("OWNED_PAGE_REQUEST");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toBeVisible();
    await f.page
      .getByRole("button", { name: "Open saved session", exact: true })
      .click();
    await expect(f.page).not.toHaveURL(f.path);
    await f.page.goto(f.path);
    await expect(f.input).toBeEditable();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toHaveCount(0);
    expect(posts).toBe(1);
    expect(
      (await f.owned.requests()).filter((r) => r.method === "thread/start"),
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

for (const boundary of ["POST", "GET"] as const)
  test(`parked Session-page ${boundary} completion cannot replace the foreground route`, async ({
    browser,
  }) => {
    const f = await originComposer(browser, true);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      reached = r;
    });
    try {
      if (boundary === "POST") {
        await f.page.route("**/session-creations", async (route) => {
          const response = await route.fetch();
          reached();
          await held;
          await route.fulfill({ response }).catch(() => {});
        });
        await f.start(false);
      } else {
        let accepted!: () => void;
        const saved = new Promise<void>((r) => {
          accepted = r;
        });
        let send!: () => void;
        const reply = new Promise<void>((r) => {
          send = r;
        });
        await f.page.route("**/session-creations", async (route) => {
          const response = await route.fetch();
          accepted();
          await reply;
          await route.fulfill({ response }).catch(() => {});
        });
        await f.start(false);
        await saved;
        await f.input.pressSequentially("NEWER_FOREGROUND_DRAFT");
        send();
        await expect(
          f.page.getByRole("button", {
            name: "Open saved session",
            exact: true,
          }),
        ).toBeVisible();
        await f.page.route("**/api/session-creations/*", async (route) => {
          const response = await route.fetch();
          reached();
          await held;
          await route.fulfill({ response }).catch(() => {});
        });
        await f.page
          .getByRole("button", { name: "Open saved session", exact: true })
          .click();
      }
      await entered;
      await f.page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      await f.page.locator('a[href$="/settings"]').first().click();
      await expect(f.page).toHaveURL(/\/settings$/);
      await expect(
        f.page.locator('[data-session-dom-linger="parked"]'),
      ).toHaveCount(1);
      release();
      await f.page.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
      );
      await expect(f.page).toHaveURL(/\/settings$/);
      const pending = await f.page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("ya-session-creation:"))
          .map((key) => JSON.parse(localStorage.getItem(key)!)),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].requestId).toBeTruthy();
    } finally {
      release?.();
      await f.dispose();
    }
  });

test("background creation keeps options, clears captured files, and supports the next Command-Enter request", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    const page = await f.context.newPage();
    const formUrl = `${f.origin}/new-session?projectId=${f.projectId}&provider=codex&model=gpt-6.1-sol`;
    await page.goto(formUrl);
    await expect(
      page.getByRole("button", { name: "Create in background", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${f.origin}/settings/message-delivery`);
    await page
      .getByRole("checkbox", {
        name: "Create sessions in background",
        exact: true,
      })
      .check();
    await page.goto(formUrl);
    const input = page.locator("textarea.new-session-form-textarea");
    await input.pressSequentially("Review the session creation changes");
    await page.locator('input[type="file"]').setInputFiles({
      name: "context.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("owned background attachment"),
    });
    const posts: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/session-creations")
      )
        posts.push(request.postDataJSON());
    });
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await page
      .getByRole("button", { name: "Create in background", exact: true })
      .click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    const receipt = await response.json();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Remove context.txt", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "Session saved. Ready for your next draft. Open for startup status.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(page.url()).toBe(formUrl);
    expect(posts[0]).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      message: "Review the session creation changes",
      stagedAttachments: [
        expect.objectContaining({ originalName: "context.txt" }),
      ],
    });
    await input.pressSequentially("Check the draft recovery behavior next");
    // A composing Enter and a shortcut in a different control must not submit.
    await input.dispatchEvent("keydown", {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });
    expect(posts).toHaveLength(1);
    await page
      .getByRole("button", { name: "Open saved session", exact: true })
      .focus();
    await page.keyboard.press("Meta+Enter");
    expect(posts).toHaveLength(1);
    for (const [name, viewport] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await recordUiCapture(page, `background-creation-${name}`);
    }
    await input.focus();
    const second = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await input.press("Meta+Enter");
    const secondResponse = await second;
    expect(secondResponse.status()).toBe(202);
    const secondReceipt = await secondResponse.json();
    await expect(input).toHaveValue("");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      message: "Check the draft recovery behavior next",
    });
    expect(posts[1]!.requestId).not.toBe(posts[0]!.requestId);
    expect(page.url()).toBe(formUrl);
    // The first accepted attempt remains independently readable while startup is held.
    expect(
      (await f.owned.request(`/session-creations/${receipt.requestId}`)).status,
    ).toBe(200);
    await f.owned.releaseAck();
    await f.owned.releaseReply();
    for (const saved of [receipt, secondReceipt]) {
      await expect
        .poll(
          async () =>
            (
              await (
                await f.owned.request(`/session-creations/${saved.requestId}`)
              ).json()
            ).creation.delivery,
        )
        .toBe("consumed");
    }
    expect(page.url()).toBe(formUrl);
    await page.reload();
    await expect(input).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Create in background", exact: true }),
    ).toBeDisabled();
  } finally {
    await f.dispose();
  }
});

test("background lost acknowledgement reloads into explicit recovery without duplicate creation", async ({
  browser,
}) => {
  const f = await fixture(browser);
  let loseRead = true,
    posts = 0;
  try {
    const page = await f.context.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("yep-anywhere-background-session-creation", "true"),
    );
    const formUrl = `${f.origin}/new-session?projectId=${f.projectId}&provider=codex&model=gpt-6.1-sol`;
    await page.goto(formUrl);
    const input = page.locator("textarea.new-session-form-textarea");
    await input.pressSequentially("Keep my unconfirmed request recoverable");
    await page.route("**/api/session-creations/*", (route) =>
      loseRead ? route.abort("failed") : route.continue(),
    );
    await page.route("**/session-creations", async (route) => {
      posts++;
      expect((await route.fetch()).status()).toBe(202);
      await route.abort("failed");
    });
    await page
      .getByRole("button", { name: "Create in background", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Check saved session", exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("Keep my unconfirmed request recoverable");
    await page.reload();
    await expect(input).toHaveValue("Keep my unconfirmed request recoverable");
    await input.pressSequentially(" with newer notes");
    loseRead = false;
    await page
      .getByRole("button", { name: "Check saved session", exact: true })
      .click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
    await page.goto(formUrl);
    await expect(input).toHaveValue(
      "Keep my unconfirmed request recoverable with newer notes",
    );
    expect(posts).toBe(1);
  } finally {
    await f.dispose();
  }
});
