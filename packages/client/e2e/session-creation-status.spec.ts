import { expect, test } from "@playwright/test";
import { createCodexCreationFixture } from "./support/codex-creation-fixture.js";
import { recordUiCapture } from "./support/ui-capture.js";

// Real activity delivery, a held REST reply and sequential typing share one
// standalone profile. Local case work takes about 8s; timer variants stay in
// the component suite instead of adding a 30s browser polling wait.
test.setTimeout(30000);
test.skip(
  process.platform === "win32",
  "Controlled app-server peer uses a POSIX executable",
);

test("committed input confirmation unlocks typing before a stale startup snapshot returns", async ({
  browser,
}) => {
  const owned = await createCodexCreationFixture(
    false,
    false,
    {
      YEP_E2E_CREATION_PERSIST_BEFORE_ACK: "true",
      YEP_E2E_CREATION_HOLD_BINDING: "true",
    },
    { serveBuiltClient: true },
  );
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  let releaseMetadata!: () => void,
    metadataReady!: () => void,
    releaseTail!: () => void;
  const metadataGate = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  const tailGate = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const held = new Promise<void>((resolve) => {
    metadataReady = resolve;
  });
  let blockTail = false,
    posts = 0;
  let metadataCaptured = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/session-creations")
    )
      posts++;
  });
  await page.route("**/api/projects/*/sessions/*/metadata", async (route) => {
    if (route.request().method() !== "GET" || metadataCaptured)
      return route.continue();
    metadataCaptured = true;
    const sessionId = new URL(route.request().url()).pathname
      .split("/")
      .at(-2)!;
    expect(
      (
        await page.request.put(
          `${owned.server.baseUrl}/api/sessions/${sessionId}/metadata`,
          {
            headers: { "X-Yep-Anywhere": "true" },
            data: { title: "Snapshot title" },
          },
        )
      ).status(),
    ).toBe(200);
    const response = await route.fetch();
    expect((await response.json()).session.creation.delivery).not.toBe(
      "consumed",
    );
    metadataReady();
    await metadataGate;
    await route.fulfill({ response });
  });
  await page.route("**/api/projects/*/sessions/*", async (route) => {
    if (!blockTail || route.request().method() !== "GET")
      return route.continue();
    await tailGate;
    await route.continue();
  });
  const capture = async (name: string) => {
    for (const [suffix, viewport] of [
      ["desktop", { width: 1000, height: 600 }],
      ["wide", { width: 1200, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await recordUiCapture(page, `${name}-${suffix}`);
    }
    await page.setViewportSize({ width: 1000, height: 600 });
  };
  await page.addInitScript(() => {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('section[aria-label="Session startup"]') ||
              node.querySelector('section[aria-label="Session startup"]'))
          )
            sessionStorage.setItem("creation-notice-seen", "true");
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  try {
    await page.goto(
      `${owned.server.baseUrl}/new-session?projectId=${owned.projectId}&provider=codex&model=gpt-6.1-sol`,
    );
    await page
      .locator("textarea.new-session-form-textarea")
      .pressSequentially("Confirm this initial request exactly once");
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await expect(
      page.locator(".sidebar-actions").getByText("Draft", { exact: true }),
    ).toHaveCount(1);
    await page.locator("button.sidebar-close").click();
    const acceptance = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/session-creations"),
    );
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    const response = await acceptance;
    expect(response.status()).toBe(202);
    const receipt = await response.json();
    await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`));
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Saved prompt", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Copy prompt", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("textarea[data-composer-input]")).toBeVisible();
    await expect(
      page.locator("textarea[data-composer-input]"),
    ).not.toBeEditable();
    await capture("creation-quiet-startup");
    await held;
    const historyLength = await page.evaluate(() => history.length);
    await page.locator("textarea[data-composer-input]").evaluate((element) => {
      element.dataset.bindingSentinel = "same-composer";
    });
    await owned.releaseBinding();
    await expect(page).toHaveURL(
      new RegExp(
        `/sessions/019a0000-cccc-7ccc-8ccc-cccccccccccc\\?yaSessionId=${receipt.sessionId}$`,
      ),
    );
    const source = await (
      await owned.request(`/sessions/${receipt.sessionId}/native-source`)
    ).json();
    expect(source).toMatchObject({
      provider: "codex",
      status: "available",
      native: { id: "019a0000-cccc-7ccc-8ccc-cccccccccccc" },
    });
    expect(source.transcriptPath).toContain(source.native.id);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await expect(page.locator("textarea[data-composer-input]")).toHaveAttribute(
      "data-binding-sentinel",
      "same-composer",
    );
    blockTail = true;
    await owned.releaseAck();
    await expect
      .poll(
        async () =>
          (
            await (
              await owned.request(
                `/projects/${owned.projectId}/sessions/${receipt.sessionId}/metadata`,
              )
            ).json()
          ).session.creation.delivery,
      )
      .toBe("consumed");
    const input = page.locator("textarea[data-composer-input]");
    await expect(input).toBeEditable();
    await expect(
      page.getByRole("region", { name: "Session startup" }),
    ).toHaveCount(0);
    await input.evaluate((element) => {
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
    const text = "Continue with these newer notes";
    let typed = "";
    for (const [index, character] of [...text].entries()) {
      await Promise.all([
        input.pressSequentially(character),
        page.request
          .put(
            `${owned.server.baseUrl}/api/sessions/${receipt.sessionId}/metadata`,
            {
              headers: { "X-Yep-Anywhere": "true" },
              data: { title: `Live update ${index}` },
            },
          )
          .then((response) => expect(response.status()).toBe(200)),
      ]);
      typed += character;
      await expect(input).toHaveValue(typed);
      await expect
        .poll(() =>
          input.evaluate(
            (element) =>
              (
                element as HTMLTextAreaElement & { acks: { value: string }[] }
              ).acks.at(-1)?.value,
          ),
        )
        .toBe(typed);
    }
    const acks = await input.evaluate(
      (element) =>
        (element as HTMLTextAreaElement & { acks: { latency: number }[] }).acks,
    );
    expect(acks).toHaveLength(text.length);
    expect(Math.max(...acks.map((ack) => ack.latency))).toBeLessThanOrEqual(
      100,
    );
    const currentTitle = `Live update ${text.length - 1}`;
    await expect(page.locator(".session-title-text")).toHaveText(currentTitle);
    const staleReply = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.endsWith("/metadata"),
    );
    releaseMetadata();
    await (await staleReply).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(input).toBeEditable();
    await expect(input).toHaveValue(text);
    await expect(page.locator(".session-title-text")).toHaveText(currentTitle);
    await capture("creation-confirmed-with-newer-draft");
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await expect(
      page.locator(".sidebar-actions").getByText("Draft", { exact: true }),
    ).toHaveCount(0);
    await page.locator("button.sidebar-close").click();
    releaseTail();
    await owned.releaseReply();
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("creation-notice-seen")),
    ).toBeNull();
    expect(posts).toBe(1);
    expect(
      (await owned.requests()).filter(
        (request) => request.method === "turn/start",
      ),
    ).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.reload();
    await expect(page.locator(".session-title-text")).toHaveText(currentTitle);
    await expect(
      page.getByText("OWNED_CODEX_CREATION_REPLY", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    releaseMetadata();
    releaseTail();
    await context.close();
    await owned.close();
  }
});
