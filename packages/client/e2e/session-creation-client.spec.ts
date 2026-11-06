import { expect, test, type Browser } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture.js";

test.setTimeout(90000);
test.skip(
  process.platform === "win32",
  "Controlled native peer uses a POSIX executable",
);
test.afterAll(() => presentUiCaptures());
async function fixture(browser: Browser) {
  const owned = await createCodexCreationFixture(
    false,
    false,
    {},
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  return {
    ...owned,
    owned,
    context,
    origin: owned.server.baseUrl,
    async dispose() {
      await context.close();
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
    // Hold the real router's native-label replacement until creation is pending.
    await page.addInitScript(() => {
      const replace = history.replaceState.bind(history);
      history.replaceState = (data, unused, url) => {
        if (String(url).includes("yaSessionId=")) {
          (
            window as unknown as { publishNativeLabel: () => void }
          ).publishNativeLabel = () => replace(data, unused, url);
        } else replace(data, unused, url);
      };
    });
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
    // Publish the parent's native label while creation still owns this view.
    await page.waitForFunction(() => "publishNativeLabel" in window);
    await page.evaluate(() =>
      (
        window as unknown as { publishNativeLabel: () => void }
      ).publishNativeLabel(),
    );
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("yaSessionId") === parent.sessionId,
    );
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
      (url) =>
        url.pathname.endsWith(`/sessions/${receipt!.sessionId}`) ||
        url.searchParams.get("yaSessionId") === receipt!.sessionId,
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
      (url) =>
        url.pathname.endsWith(`/sessions/${receipt.sessionId}`) ||
        url.searchParams.get("yaSessionId") === receipt.sessionId,
    );
    await f.page.goto(f.path);
    await expect(f.input).toBeEditable();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await f.owned.requests()).filter((r) => r.method === "thread/start")
            .length,
      )
      .toBe(2);
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
  let sessionId: string;
  try {
    await f.page.route("**/api/session-creations/*", async (route) => {
      if (lost) return route.abort("failed");
      await route.continue();
    });
    await f.page.route("**/session-creations", async (route) => {
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      sessionId = (await response.json()).sessionId;
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
    await expect(f.page).toHaveURL(
      (url) =>
        url.pathname.endsWith(`/sessions/${sessionId}`) ||
        url.searchParams.get("yaSessionId") === sessionId,
    );
    await f.page.goto(f.path);
    await expect(f.input).toBeEditable();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove request.txt", exact: true }),
    ).toHaveCount(0);
    expect(posts).toBe(1);
    await expect
      .poll(
        async () =>
          (await f.owned.requests()).filter((r) => r.method === "thread/start")
            .length,
      )
      .toBe(2);
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
    await page.addInitScript(() =>
      localStorage.setItem(
        "yep-anywhere-session-toolbar-presence",
        JSON.stringify({ shortcutsHelp: "pin", projectQueue: "pin" }),
      ),
    );
    const formUrl = `${f.origin}/new-session?projectId=${f.projectId}&provider=codex&model=gpt-6.1-sol`;
    await page.goto(formUrl);
    await expect(
      page.getByLabel("New session keyboard shortcuts", { exact: true }),
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
    const help = page.getByLabel("New session keyboard shortcuts", {
      exact: true,
    });
    await help.click();
    await expect(page.getByText("⌘ Enter", { exact: true })).toBeVisible();
    await help.press("Escape");
    await expect(page.getByText("⌘ Enter", { exact: true })).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create in background", exact: true }),
    ).toHaveCount(0);
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
    await input.press("Meta+Enter");
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
    await expect(
      page.locator("button.new-session-project-queue-button"),
    ).toBeVisible();
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
      await recordUiCapture(page, `background-shortcut-${name}`);
      await help.click();
      await expect(page.getByText("⌘ Enter", { exact: true })).toBeVisible();
      const panel = await page
        .getByText("New session keyboard shortcuts", { exact: true })
        .locator("..")
        .boundingBox();
      const keys = await page
        .getByText("⌘ Enter", { exact: true })
        .boundingBox();
      for (const bounds of [panel, keys]) {
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      }
      await recordUiCapture(page, `background-shortcut-help-${name}`);
      await help.press("Escape");
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
    ).toHaveCount(0);
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
    await expect(
      page.getByLabel("New session keyboard shortcuts", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeEnabled();
    await input.press("Meta+Enter");
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

async function queueDraftFixture(browser: Browser) {
  const f = await fixture(browser);
  try {
    await f.context.addInitScript(() =>
      localStorage.setItem(
        "yep-anywhere-session-toolbar-presence",
        JSON.stringify({ projectQueue: "pin" }),
      ),
    );
    const blocker = await (
      await f.owned.request(`/projects/${f.projectId}/session-creations`, {
        requestId: "queue_draft_blocker",
        provider: "codex",
        model: "gpt-6.1-sol",
        message: "OWNED_QUEUE_DRAFT_BLOCKER",
      })
    ).json();
    await expect
      .poll(
        async () =>
          (await f.owned.requests()).filter(
            (request) => request.method === "turn/start",
          ).length,
      )
      .toBe(1);
    const page = await f.context.newPage();
    const formUrl = `${f.origin}/new-session?projectId=${f.projectId}&provider=codex&model=gpt-6.1-sol`;
    await page.goto(formUrl);
    const input = page.locator("textarea.new-session-form-textarea");
    const queue = page.locator("button.new-session-project-queue-button");
    await expect(input).toBeEditable();
    await expect(queue).toBeVisible();
    return { ...f, page, input, queue, formUrl, blocker };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
const queueDraftFile = (name: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(`Owned ${name}`),
});

test("Project Queue acknowledges captured files and preserves typing during a delayed acceptance", async ({
  browser,
}) => {
  const f = await queueDraftFixture(browser);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.input.pressSequentially("First queued request");
    await f.page
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("first.txt"));
    await expect(f.queue).toBeEnabled();
    await f.queue.click();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove first.txt", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await (
              await f.owned.request("/drafts/read", {
                slot: { kind: "new-session" },
              })
            ).json()
          ).snapshot.payload.fields.text ?? "",
      )
      .toBe("");
    await f.page.reload();
    await expect(f.input).toHaveValue("");
    await expect(
      f.page.getByRole("button", { name: "Remove first.txt", exact: true }),
    ).toHaveCount(0);

    await f.input.pressSequentially("Captured queue request");
    await f.page
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("captured.txt"));
    await expect(f.queue).toBeEnabled();
    let saved!: () => void;
    const accepted = new Promise<void>((resolve) => {
      saved = resolve;
    });
    let request!: {
      message: {
        text: string;
        stagedAttachments: { refs: { originalName: string }[] };
      };
    };
    await f.page.route(
      `**/api/projects/${f.projectId}/queue`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        request = route.request().postDataJSON();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        saved();
        await held;
        await route.fulfill({ response });
      },
    );
    await f.queue.click();
    await accepted;
    await expect(f.input).toBeEditable();
    await f.page
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("newer.txt"));
    await expect(
      f.page.getByText("newer.txt", { exact: true }).first(),
    ).toBeVisible();
    await f.input.evaluate((element) => {
      const input = element as HTMLTextAreaElement & {
        acks: { latency: number; value: string }[];
      };
      input.acks = [];
      input.addEventListener("keydown", (event) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            input.acks.push({
              latency: performance.now() - event.timeStamp,
              value: input.value,
            }),
          ),
        ),
      );
    });
    let typed = "Captured queue request";
    for (const [index, character] of [..." with newer work"].entries()) {
      if (index === 3) release();
      await Promise.all([
        f.input.pressSequentially(character),
        f.page.request
          .put(`${f.origin}/api/sessions/${f.blocker.sessionId}/metadata`, {
            data: { title: `Queue typing ${index}` },
            headers: { "X-Yep-Anywhere": "true" },
          })
          .then((response) => expect(response.status()).toBe(200)),
      ]);
      typed += character;
      await expect(f.input).toHaveValue(typed);
      await expect
        .poll(() =>
          f.input.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(typed);
    }
    const acks = await f.input.evaluate(
      (element) =>
        (element as HTMLTextAreaElement & { acks: { latency: number }[] }).acks,
    );
    expect(acks).toHaveLength(" with newer work".length);
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThanOrEqual(
      100,
    );
    expect(request.message.text).toBe("Captured queue request");
    expect(
      request.message.stagedAttachments.refs.map((ref) => ref.originalName),
    ).toEqual(["captured.txt"]);
    await expect(f.queue).toBeEnabled();
    await f.input.blur();
    await expect
      .poll(
        async () =>
          (
            await (
              await f.owned.request("/drafts/read", {
                slot: { kind: "new-session" },
              })
            ).json()
          ).snapshot.payload.fields.text,
      )
      .toBe(typed);
    for (const [name, viewport] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await f.page.setViewportSize(viewport);
      await recordUiCapture(f.page, `queue-draft-newer-${name}`);
    }
    await f.page.reload();
    await expect(f.input).toHaveValue(typed);
    await expect(
      f.page.getByRole("button", { name: "Remove newer.txt", exact: true }),
    ).toBeVisible();
    const collection = await (
      await f.owned.request(`/projects/${f.projectId}/queue`)
    ).json();
    expect(collection.items).toHaveLength(2);
  } finally {
    release();
    await f.dispose();
  }
});

test("Project Queue acceptance preserves a sibling attachment-only edit across reload", async ({
  browser,
}) => {
  const f = await queueDraftFixture(browser);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.input.pressSequentially("Sibling queue request");
    await f.page
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("submitted.txt"));
    await expect(f.queue).toBeEnabled();
    const sibling = await f.context.newPage();
    await sibling.goto(f.formUrl);
    const other = sibling.locator("textarea.new-session-form-textarea");
    await expect(other).toHaveValue("Sibling queue request");
    let saved!: () => void;
    const accepted = new Promise<void>((resolve) => {
      saved = resolve;
    });
    await f.page.route(
      `**/api/projects/${f.projectId}/queue`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        saved();
        await held;
        await route.fulfill({ response });
      },
    );
    await f.queue.click();
    await accepted;
    await sibling.bringToFront();
    await sibling
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("sibling.txt"));
    await expect(
      sibling.getByRole("button", { name: "Remove sibling.txt", exact: true }),
    ).toBeVisible();
    // A visible chip can still be uploading. Establish the sibling's durable
    // edit before releasing the acknowledgement that conditionally clears it.
    await expect
      .poll(async () => {
        const { snapshot } = await (
          await f.owned.request("/drafts/read", {
            slot: { kind: "new-session" },
          })
        ).json();
        return snapshot.payload.attachments.some(
          (file: { originalName: string }) =>
            file.originalName === "sibling.txt",
        );
      })
      .toBe(true);
    release();
    await expect(
      f.page.getByText("Queued new session for Project Queue.", {
        exact: true,
      }),
    ).toBeVisible();
    await sibling.reload();
    await expect(other).toHaveValue("Sibling queue request");
    await expect(
      sibling.getByRole("button", { name: "Remove sibling.txt", exact: true }),
    ).toBeVisible();
    await f.page.reload();
    await expect(f.input).toHaveValue("Sibling queue request");
    await expect(
      f.page.getByRole("button", { name: "Remove sibling.txt", exact: true }),
    ).toBeVisible();
  } finally {
    release();
    await f.dispose();
  }
});

test("Project Queue refusal preserves captured input and newer sibling work for reload recovery", async ({
  browser,
}) => {
  const f = await queueDraftFixture(browser);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.input.pressSequentially("Refused queue request");
    await f.page
      .locator('input[type="file"]')
      .setInputFiles(queueDraftFile("recover.txt"));
    await expect(f.queue).toBeEnabled();
    let received!: () => void;
    const sent = new Promise<void>((resolve) => {
      received = resolve;
    });
    await f.page.route(
      `**/api/projects/${f.projectId}/queue`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        received();
        await held;
        await route.fulfill({
          status: 503,
          json: { error: "Owned enqueue refusal" },
        });
      },
    );
    await f.queue.click();
    await sent;
    const sibling = await f.context.newPage();
    await sibling.goto(f.formUrl);
    const other = sibling.locator("textarea.new-session-form-textarea");
    await expect(other).toHaveValue("Refused queue request");
    await other.pressSequentially(" with sibling recovery notes");
    release();
    await expect(f.queue).toBeEnabled();
    await sibling.reload();
    await expect(other).toHaveValue(
      "Refused queue request with sibling recovery notes",
    );
    await expect(
      sibling.getByRole("button", { name: "Remove recover.txt", exact: true }),
    ).toBeVisible();
    await f.page.reload();
    await expect(f.input).toHaveValue(
      "Refused queue request with sibling recovery notes",
    );
    const collection = await (
      await f.owned.request(`/projects/${f.projectId}/queue`)
    ).json();
    expect(collection.items).toHaveLength(0);
  } finally {
    release();
    await f.dispose();
  }
});
