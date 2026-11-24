import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import type {} from "./fixtures/preview-cleanup";

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let url: string;
const journal = "yep-artifact-preview-cleanup-v1";
let pageErrors: string[];
test.beforeEach(async ({ context }) => {
  pageErrors = [];
  const observe = (page: Page) =>
    page.on("pageerror", (error) => pageErrors.push(error.message));
  context.pages().forEach(observe);
  context.on("page", observe);
});
test.afterEach(() => expect(pageErrors).toEqual([]));
test.beforeAll(async () => {
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}e2e/fixtures/preview-cleanup.html`;
});
test.afterAll(async () => {
  await server?.close();
});
async function ready(page: Page) {
  await page.waitForFunction(() => !!window.previewCleanupProbe);
}

test("reload cleanup preserves a concurrent live owner and serializes journal updates", async ({
  page,
  context,
}) => {
  const removed: string[] = [];
  await context.route("**/cleanup-api/**", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    removed.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: { success: true } });
  });
  const peer = await context.newPage();
  await Promise.all([page.goto(url), peer.goto(url)]);
  await Promise.all([ready(page), ready(peer)]);
  await Promise.all([
    page.evaluate(() => window.previewCleanupProbe.open("source-a", "live")),
    peer.evaluate(() => window.previewCleanupProbe.open("source-a", "peer-0")),
  ]);
  // The peer's write can return before Chromium updates this tab's snapshot.
  const journalIds = () =>
    page.evaluate(
      (key) =>
        (JSON.parse(localStorage.getItem(key) ?? "[]") as { id: string }[])
          .map((row) => row.id)
          .sort(),
      journal,
    );
  await expect.poll(journalIds).toEqual(["live", "peer-0"]);
  for (let index = 1; index <= 18; index++) {
    await peer.reload();
    await ready(peer);
    await peer.evaluate(
      (id) => window.previewCleanupProbe.open("source-a", id),
      `peer-${index}`,
    );
    expect(removed).toEqual(
      Array.from(
        { length: index },
        (_, previous) => `/cleanup-api/artifact-previews/peer-${previous}`,
      ),
    );
    await expect.poll(journalIds).toEqual(["live", `peer-${index}`]);
  }
  await peer.evaluate(() => window.previewCleanupProbe.close("peer-18"));
  await page.evaluate(() => window.previewCleanupProbe.close("live"));
  expect(
    await page.evaluate((key) => localStorage.getItem(key), journal),
  ).toBeNull();
});

test("recovery respects source identity, retains failed deletes and rejects arbitrary cleanup paths", async ({
  page,
  context,
}) => {
  let status = 503;
  const calls: { path: string; source: string | undefined }[] = [];
  await context.route("**/cleanup-api/**", async (route) => {
    calls.push({
      path: new URL(route.request().url()).pathname,
      source: route.request().headers()["x-probe-source"],
    });
    await route.fulfill({
      status,
      json: { error: "deliberate fixture refusal" },
    });
  });
  await page.goto(url);
  await ready(page);
  await page.evaluate(() =>
    window.previewCleanupProbe.open("source-b", "orphan"),
  );
  await page.reload();
  await ready(page);
  await page.evaluate(() =>
    window.previewCleanupProbe.open("source-a", "live"),
  );
  const peer = await context.newPage();
  await peer.goto(url);
  await ready(peer);
  await peer.evaluate(() => window.previewCleanupProbe.reclaim("source-a"));
  expect(calls).toEqual([]);
  await peer.evaluate(() => window.previewCleanupProbe.reclaim("source-b"));
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).length,
      journal,
    ),
  ).toBe(2);
  status = 404;
  await peer.evaluate(() => window.previewCleanupProbe.reclaim("source-b"));
  expect(calls).toEqual([
    { path: "/cleanup-api/artifact-previews/orphan", source: "source-b" },
    { path: "/cleanup-api/artifact-previews/orphan", source: "source-b" },
  ]);
  await page.evaluate((key) => {
    const rows = JSON.parse(localStorage.getItem(key)!);
    rows.push({
      key: crypto.randomUUID(),
      source: "source-a",
      base: "/settings",
      id: "invalid",
      expiresAt: Date.now() + 60000,
    });
    localStorage.setItem(key, JSON.stringify(rows));
  }, journal);
  await peer.evaluate(() => window.previewCleanupProbe.reclaim("source-a"));
  expect(calls).toHaveLength(2);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).length,
      journal,
    ),
  ).toBe(1);
});
