import { expect, test, type Response } from "@playwright/test";
import { EMPTY_DRAFT } from "@yep-anywhere/shared";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";
import { startDraftBrowserServer } from "../../server/test/drafts/browserServer";
let api: Awaited<ReturnType<typeof startDraftBrowserServer>>;
let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
// The handoff test exercises multiple real debounce windows.
test.setTimeout(60_000);
test.beforeAll(async () => {
  // CI 36921363093 spent 74.6s seeding before its first browser API call.
  // Budget fixture preparation at 4x that measurement; interactions stay at 60s.
  test.setTimeout(300_000);
  api = await startDraftBrowserServer();
  const seededAt = performance.now();
  // Thirty days at 100 distinct session drafts/day, using real cleared rows.
  for (let i = 0; i < 3000; i++) {
    const slot = { kind: "session" as const, sessionId: `draft-history-${i}` };
    const initial = api.store.read("", slot);
    const saved = api.store.write("", {
      slot,
      baseRevision: initial.snapshot.revision,
      ticket: initial.ticket,
      operationId: `history-${i}-save`,
      payload: { fields: { text: "sent" }, attachments: [] },
    });
    api.store.write("", {
      slot,
      baseRevision: saved.snapshot.revision,
      ticket: saved.ticket,
      operationId: `history-${i}-clear`,
      payload: EMPTY_DRAFT,
    });
    if (i % 100 === 99) await new Promise<void>((done) => setImmediate(done));
  }
  console.info(
    `[draft-sync] seeded 3,000 cleared drafts in ${Math.ceil(performance.now() - seededAt)}ms`,
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
  await api?.close();
  await presentUiCaptures();
});
test("two-device handoff and sequential typing with 3,000 cleared drafts, offline reload and send clear", async ({
  browser,
}) => {
  const desktop = await browser.newContext({
    viewport: { width: 1000, height: 600 },
  });
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const a = await desktop.newPage(),
    b = await phone.newPage();
  const errors: string[] = [];
  const deltaSizes: number[] = [];
  const recordDelta = async (response: Response) => {
    const url = new URL(response.url());
    if (
      !url.pathname.endsWith("/drafts/index") ||
      !url.searchParams.has("since")
    )
      return;
    try {
      const page = await response.json();
      deltaSizes.push(page.entries.length);
    } catch {
      // A response may be aborted when its owned browser context closes.
    }
  };
  a.on("response", (response) => void recordDelta(response));
  b.on("response", (response) => void recordDelta(response));
  a.on("pageerror", (e) => errors.push(e.message));
  b.on("pageerror", (e) => errors.push(e.message));
  try {
    await a.goto(`${base}e2e/fixtures/draft-sync.html`);
    await b.goto(`${base}e2e/fixtures/draft-sync.html`);
    const inputA = a.getByRole("textbox", { name: "Prompt" }),
      inputB = b.getByRole("textbox", { name: "Prompt" });
    await inputA.pressSequentially("Draft from desktop", { delay: 20 });
    await expect(inputB).toHaveValue("Draft from desktop", { timeout: 10000 });
    await inputB.focus();
    await inputB.press("End");
    await inputB.pressSequentially(" on phone", { delay: 20 });
    // A remote revision arrives while actual key events continue under 1,000-row activity.
    await inputA.evaluate((node) => {
      node.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent) || event.key.length !== 1) return;
        const start = performance.now();
        node.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() => {
              const w = window as typeof window & { latencies?: number[] };
              w.latencies ??= [];
              w.latencies.push(performance.now() - start);
            }),
          { once: true },
        );
      });
    });
    await inputA.press("End");
    await inputA.pressSequentially(" and more typing", { delay: 20 });
    await expect(inputA).toHaveValue("Draft from desktop and more typing");
    const latencies = await a.evaluate(
      () =>
        (window as typeof window & { latencies?: number[] }).latencies ?? [],
    );
    expect(latencies.length).toBe(16);
    expect(Math.max(...latencies)).toBeLessThan(100);
    await expect(
      a.getByRole("button", { name: "Review draft changes" }),
    ).toBeVisible({ timeout: 10000 });
    await a.getByRole("button", { name: "Review draft changes" }).click();
    await a.getByRole("status").scrollIntoViewIfNeeded();
    await recordUiCapture(a, "draft-sync-desktop-review");
    await a.setViewportSize({ width: 375, height: 812 });
    await expect(
      a.getByRole("button", { name: "Use other version" }),
    ).toBeVisible();
    await recordUiCapture(a, "draft-sync-phone-review");
    await a.setViewportSize({ width: 1000, height: 600 });
    await a.getByRole("button", { name: "Combine drafts" }).click();
    await expect(inputA).toHaveValue(
      "Draft from desktop on phone\n\nDraft from desktop and more typing",
    );
    await b.getByRole("heading", { name: "New session", exact: true }).click();
    await expect(inputB).toHaveValue(await inputA.inputValue(), {
      timeout: 10000,
    });
    await expect(b.getByRole("status")).toHaveCount(0);
    // Keep the already installed app reachable while its server is unavailable.
    await b.route("**/api/**", (route) =>
      new URL(route.request().url()).pathname.startsWith("/api/")
        ? route.abort()
        : route.continue(),
    );
    await inputB.press("End");
    await inputB.pressSequentially(" offline", { delay: 20 });
    const offline = await inputB.inputValue();
    await b.reload();
    await expect(inputB).toHaveValue(offline);
    await b.unroute("**/api/**");
    await b.reload();
    await expect(inputB).toHaveValue(offline);
    await expect
      .poll(
        () =>
          api.store.read("", { kind: "new-session" }).snapshot.payload.fields
            .text,
      )
      .toBe(offline);
    await b.getByRole("button", { name: "Send", exact: true }).click();
    await inputB.pressSequentially("Next draft", { delay: 10 });
    await expect(inputB).toHaveValue("Next draft");
    await expect
      .poll(
        () =>
          api.store.read("", { kind: "new-session" }).snapshot.payload.fields
            .text,
        { timeout: 10000 },
      )
      .toBe("Next draft");
    expect(errors).toEqual([]);
    expect(deltaSizes.length).toBeGreaterThan(0);
    // Only the active prompt changed; the 3,000 old clears are not retransmitted.
    expect(Math.max(...deltaSizes)).toBeLessThanOrEqual(1);
  } finally {
    await desktop.close();
    await phone.close();
  }
});
test("older servers keep local drafts and receive no draft-sync requests", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/drafts/")) requests++;
  });
  await page.route("**/api/version**", (route) =>
    route.fulfill({ json: { version: "0.9.2", capabilities: [] } }),
  );
  await page.goto(`${base}e2e/fixtures/draft-sync.html`);
  await page
    .getByRole("textbox")
    .pressSequentially("Local only", { delay: 15 });
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("Local only");
  expect(requests).toBe(0);
});

test("a waiting-sync notice dismisses and reviews without touching the composer", async ({
  page,
}) => {
  api.store.deleteOwner("");
  await page.route("**/api/drafts/read", (route) => route.abort());
  await page.goto(`${base}e2e/fixtures/draft-sync.html`);
  const input = page.getByRole("textbox", { name: "Prompt" });
  await input.pressSequentially("Keep this paragraph", { delay: 20 });
  await expect(page.getByRole("status")).toContainText("Sync is waiting");
  await page.getByRole("button", { name: "Review draft changes" }).click();
  // The preview follows typing; it once read "Empty draft" over typed text.
  await expect(page.getByRole("status")).toContainText("Keep this paragraph");
  await expect(page.getByRole("button", { name: /discard/i })).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 600 });
  await recordUiCapture(page, "draft-sync-waiting-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "draft-sync-waiting-phone");
  await page.getByRole("button", { name: "Dismiss draft notice" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(input).toHaveValue("Keep this paragraph");
  await page.unroute("**/api/drafts/read");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(
      () =>
        api.store.read("", { kind: "new-session" }).snapshot.payload.fields
          .text,
      { timeout: 15000 },
    )
    .toBe("Keep this paragraph");
  await expect(input).toHaveValue("Keep this paragraph");
});

test("discarding a recovery copy keeps the composer in sibling tabs and after reload", async ({
  page,
  context,
}) => {
  api.store.deleteOwner("");
  await page.goto(`${base}e2e/fixtures/draft-sync.html`);
  await page.evaluate(() => {
    const key = "draft-new-session:local";
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, text: "Stale crash draft" }),
    );
    localStorage.setItem(
      `draft-sync-v1:local::${encodeURIComponent(key)}`,
      JSON.stringify({
        raw: null,
        base: null,
        submitted: {
          revision: null,
          payload: { fields: { text: "Stale crash draft" }, attachments: [] },
        },
      }),
    );
  });
  await page.reload();
  const sibling = await context.newPage();
  await sibling.goto(`${base}e2e/fixtures/draft-sync.html`);
  await expect(page.getByRole("status")).toContainText("needs recovery");
  await expect(sibling.getByRole("status")).toContainText("needs recovery");
  await page.getByRole("button", { name: "Review draft changes" }).click();
  await page.getByRole("button", { name: "Discard recovery copy" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("Stale crash draft");
  await expect(sibling.getByRole("textbox")).toHaveValue("Stale crash draft");
  await page.reload();
  await sibling.reload();
  await expect(page.getByRole("textbox")).toHaveValue("Stale crash draft");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(sibling.getByRole("status")).toHaveCount(0);
});

test("reload exposes unresolved submission recovery without losing the next draft", async ({
  page,
}) => {
  api.store.deleteOwner("");
  await page.addInitScript(() => {
    const key = "draft-new-session:local";
    const raw = JSON.stringify({ version: 1, text: "The next draft" });
    localStorage.setItem(key, raw);
    localStorage.setItem(
      `draft-sync-v1:local::${encodeURIComponent(key)}`,
      JSON.stringify({
        raw,
        base: null,
        submitted: {
          revision: null,
          payload: {
            fields: { text: "Unresolved submission" },
            attachments: [],
          },
        },
      }),
    );
  });
  await page.goto(`${base}e2e/fixtures/draft-sync.html`);
  await expect(page.getByRole("status")).toContainText(
    "A saved draft needs recovery",
  );
  await expect(page.getByRole("textbox")).toHaveValue("The next draft");
  await page.getByRole("button", { name: "Review draft changes" }).click();
  await page
    .getByRole("button", { name: "Recover draft", exact: true })
    .click();
  await expect(page.getByRole("textbox")).toHaveValue(
    "Unresolved submission\n\nThe next draft",
  );
});

test("phone send clears an unchanged desktop draft quietly after focus leaves", async ({
  browser,
}) => {
  api.store.deleteOwner("");
  const desktop = await browser.newContext({
    viewport: { width: 1000, height: 600 },
  });
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const a = await desktop.newPage(),
    b = await phone.newPage();
  try {
    const sessionId = "draft-history-0";
    const slot = { kind: "session" as const, sessionId };
    await a.goto(`${base}e2e/fixtures/draft-sync.html?session=${sessionId}`);
    await b.goto(`${base}e2e/fixtures/draft-sync.html?session=${sessionId}`);
    const inputA = a.getByRole("textbox", { name: "Prompt" });
    const inputB = b.getByRole("textbox", { name: "Prompt" });
    await inputA.evaluate((node) => {
      node.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent) || event.key.length !== 1) return;
        const start = performance.now();
        node.addEventListener(
          "input",
          () =>
            requestAnimationFrame(() => {
              const w = window as typeof window & { latencies?: number[] };
              w.latencies ??= [];
              w.latencies.push(performance.now() - start);
            }),
          { once: true },
        );
      });
    });
    await inputA.pressSequentially("Send from phone", { delay: 20 });
    const latencies = await a.evaluate(
      () =>
        (window as typeof window & { latencies?: number[] }).latencies ?? [],
    );
    expect(latencies).toHaveLength(15);
    expect(Math.max(...latencies)).toBeLessThan(100);
    await expect(inputB).toHaveValue("Send from phone", { timeout: 10000 });
    const navigation = a.getByRole("navigation", { name: "Sessions" });
    await expect(navigation.getByText("Draft", { exact: true })).toBeVisible();
    await b.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() => api.store.read("", slot).snapshot.payload.fields.text)
      .toBeUndefined();
    await a.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(a.getByRole("status")).toHaveCount(0);
    await expect(inputA).toHaveValue("Send from phone");
    await expect(navigation.getByText("Draft", { exact: true })).toBeVisible();
    await a
      .getByRole("heading", { name: "Session draft", exact: true })
      .click();
    await expect(inputA).toHaveValue("", { timeout: 10000 });
    await expect(a.getByRole("status")).toHaveCount(0);
    await expect(navigation.getByText("Draft", { exact: true })).toHaveCount(0);
    await recordUiCapture(a, "draft-cleared-desktop");
    await a.setViewportSize({ width: 375, height: 812 });
    await expect(navigation.getByText("Draft", { exact: true })).toHaveCount(0);
    await recordUiCapture(a, "draft-cleared-phone");
    await a.reload();
    await expect(inputA).toHaveValue("");
  } finally {
    await desktop.close();
    await phone.close();
  }
});
