import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { createTestViteServer as createViteServer } from "./support/vite-server";

/**
 * Chrome keeps every live Blob in one browser-wide store whose budget all
 * tabs share (topics/media-rendering-and-routing.md § Known sharp edges).
 * Only `chrome://blob-internals` shows that store, and only for the default
 * browser context, so this spec drives its own persistent profile rather than
 * the suite's incognito-like contexts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;
const GENERATIONS = 8;
const SURFACES = [
  { surface: "modal-image", selector: 'img[src^="blob:"]', count: 1 },
  { surface: "modal-video", selector: 'video[src^="blob:"]', count: 1 },
  { surface: "inline-images", selector: 'img[src^="blob:"]', count: 3 },
  { surface: "viewer-image", selector: 'img[src^="blob:"]', count: 1 },
  { surface: "viewer-video", selector: 'video[src^="blob:"]', count: 1 },
] as const;

/** The controls `fixtures/blob-retention.tsx` installs on its window. */
interface RetentionWindow {
  blobRetention: {
    show(surface: string, generation: number): void;
    hide(): void;
    fetchedBytes(): number;
  };
}

let vite: Awaited<ReturnType<typeof createViteServer>>;
let listener: ReturnType<typeof createServer>;
let base: string;
let profileDir: string;
let context: BrowserContext;

test.beforeAll(async () => {
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: false },
    appType: "mpa",
  });
  listener = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end('{"error":"Not served by this fixture"}');
      return;
    }
    vite.middlewares(req, res);
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server has no port");
  }
  base = `http://127.0.0.1:${address.port}`;
  profileDir = await mkdtemp(join(tmpdir(), "ya-blob-retention-"));
  context = await chromium.launchPersistentContext(profileDir, {
    chromiumSandbox: true,
  });
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => listener?.close(resolve));
  await vite?.close();
  if (profileDir) await rm(profileDir, { recursive: true });
});

/** Total bytes of every Blob the browser's Blob registry currently holds. */
async function blobStoreBytes(): Promise<number> {
  const internals = await context.newPage();
  try {
    await internals.goto("chrome://blob-internals");
    const text = await internals.evaluate(() => document.body.innerText);
    let total = 0;
    for (const match of text.matchAll(/^Length:\s*([\d,]+)/gm)) {
      total += Number(match[1]!.replaceAll(",", ""));
    }
    return total;
  } finally {
    await internals.close();
  }
}

async function collectGarbage(page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    for (let i = 0; i < 3; i++) {
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(100);
    }
  } finally {
    await cdp.detach();
  }
}

test("closing relayed media surfaces releases their Blobs", async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await page.goto(`${base}/e2e/fixtures/blob-retention.html`);
  await page.waitForFunction(() =>
    Boolean((window as unknown as RetentionWindow).blobRetention),
  );
  await collectGarbage(page);
  const baseline = await blobStoreBytes();

  let generation = 0;
  for (const { surface, selector, count } of SURFACES) {
    for (let round = 0; round < GENERATIONS; round++) {
      generation += 1;
      await page.evaluate(
        ([name, value]) =>
          (window as unknown as RetentionWindow).blobRetention.show(
            name,
            value,
          ),
        [surface, generation] as const,
      );
      await expect(page.locator(selector)).toHaveCount(count);
      if (round === 0) {
        // The measurement must see what an open surface holds, or a
        // passing total below would prove nothing.
        expect(await blobStoreBytes()).toBeGreaterThanOrEqual(
          baseline + count * MIB,
        );
      }
      await page.evaluate(() =>
        (window as unknown as RetentionWindow).blobRetention.hide(),
      );
      await expect(page.locator(selector)).toHaveCount(0);
    }
  }

  const fetched = await page.evaluate(() =>
    (window as unknown as RetentionWindow).blobRetention.fetchedBytes(),
  );
  expect(fetched).toBeGreaterThanOrEqual(GENERATIONS * SURFACES.length * MIB);
  await collectGarbage(page);
  await expect
    .poll(blobStoreBytes, { timeout: 10_000 })
    .toBeLessThan(baseline + MIB);
  await page.close();
});
