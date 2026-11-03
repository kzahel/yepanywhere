// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, resolveConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import { reloadNotify } from "../../../vite-plugin-reload-notify";

describe("Vite dependency cache isolation", () => {
  it("requires an explicit reload before importing changed source in manual mode", async () => {
    // Vite canonicalizes module IDs. Keep manually emitted watcher paths in
    // the same namespace on hosts where tmpdir() traverses a symlink (macOS).
    const directory = await realpath(
      await mkdtemp(resolve(tmpdir(), "ya-vite-generation-")),
    );
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await writeFile(
        resolve(directory, "index.html"),
        '<button id="open">Open page</button><output></output><script type="module" src="/main.js"></script>',
      );
      await writeFile(
        resolve(directory, "registry.js"),
        'export const capabilities = { old: { name: "old" } };',
      );
      await writeFile(
        resolve(directory, "page.js"),
        'import { capabilities } from "./registry.js"; export const name = capabilities.old.name;',
      );
      await writeFile(
        resolve(directory, "main.js"),
        `import { capabilities } from "./registry.js";
document.querySelector('output').textContent = capabilities.old.name;
document.querySelector('button').onclick = async () => {
  history.pushState({}, '', '/page?keep=1#turn');
  try { document.querySelector('output').textContent = (await import('./page.js')).name; }
  catch (error) { document.querySelector('output').textContent = error.message; }
};
if (location.pathname === '/page') document.querySelector('button').click();`,
      );
      server = await createServer({
        root: directory,
        configFile: false,
        plugins: [reloadNotify({ endpoint: "/notify" })],
        server: { host: "127.0.0.1", port: 0, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      const notify = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response());
      await server.listen();
      browser = await chromium.launch({
        chromiumSandbox: true,
        headless: true,
      });
      const page = await browser.newPage();
      await page.addInitScript(() => {
        sessionStorage.setItem(
          "documents",
          String(Number(sessionStorage.getItem("documents")) + 1),
        );
      });
      await page.goto(server.resolvedUrls!.local[0]!);
      await expect.poll(() => page.locator("output").textContent()).toBe("old");
      await page.evaluate(() =>
        localStorage.setItem("draft", "unsent message"),
      );
      await writeFile(
        resolve(directory, "registry.js"),
        'export const capabilities = { old: { name: "old" }, added: { name: "new" } };',
      );
      await writeFile(
        resolve(directory, "page.js"),
        'import { capabilities } from "./registry.js"; export const name = capabilities.added.name;',
      );
      server.watcher.emit("change", resolve(directory, "registry.js"));
      server.watcher.emit("change", resolve(directory, "page.js"));
      await expect.poll(() => notify.mock.calls.length).toBe(2);
      expect(await page.locator("output").textContent()).toBe("old");
      expect(
        await page.evaluate(() => sessionStorage.getItem("documents")),
      ).toBe("1");
      await page.locator("button").click();
      await expect
        .poll(() => page.locator("output").textContent())
        .not.toBe("old");
      expect(
        await page.evaluate(() => sessionStorage.getItem("documents")),
      ).toBe("1");
      expect(await page.locator("output").textContent()).toBe(
        "Frontend source changed. Reload this tab when ready to load the updated page.",
      );
      expect(await page.evaluate(() => localStorage.getItem("draft"))).toBe(
        "unsent message",
      );
      // Only the user's refresh admits a new document and a coherent graph.
      await page.reload();
      await expect.poll(() => page.locator("output").textContent()).toBe("new");
      expect(
        new URL(page.url()).pathname +
          new URL(page.url()).search +
          new URL(page.url()).hash,
      ).toBe("/page?keep=1#turn");
      expect(
        await page.evaluate(() => sessionStorage.getItem("documents")),
      ).toBe("2");
      expect(await page.evaluate(() => localStorage.getItem("draft"))).toBe(
        "unsent message",
      );
      await page.locator("button").click();
      expect(
        await page.evaluate(() => sessionStorage.getItem("documents")),
      ).toBe("2");
    } finally {
      await browser?.close();
      await server?.close();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true });
    }
  });

  it("keeps local and remote dependency graphs in separate directories", async () => {
    const root = process.cwd();
    const local = await resolveConfig(
      { root, configFile: resolve(root, "vite.config.ts") },
      "serve",
    );
    const remote = await resolveConfig(
      { root, configFile: resolve(root, "vite.config.remote.ts") },
      "serve",
    );

    expect(local.cacheDir).not.toBe(remote.cacheDir);
    expect(local.server.strictPort).toBe(true);
  });

  it("notifies about source changes in manual reload mode", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ya-vite-notify-"));
    vi.stubEnv("NO_FRONTEND_RELOAD", "true");
    vi.stubEnv("PORT", "4999");
    vi.stubEnv("VITE_API_PORT", undefined);
    const notify = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response());
    const root = process.cwd();
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({
        root,
        configFile: resolve(root, "vite.config.ts"),
        cacheDir: resolve(directory, "node_modules/.vite"),
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      const send = vi.spyOn(server.hot, "send");
      const entry = await server.transformRequest("/src/main.tsx");
      expect(entry?.code).toContain("__yaImportFresh(() => import(");
      // A file no page loaded cannot leave one stale, so it is not a change.
      server.watcher.emit(
        "change",
        resolve(root, "e2e/new-session-preboot-composer.spec.ts"),
      );
      await server.transformRequest("/src/lib/clientSummaryStore.ts");
      server.watcher.emit(
        "change",
        resolve(root, "src/lib/clientSummaryStore.ts"),
      );
      await expect.poll(() => notify.mock.calls.length).toBe(1);
      expect(notify).toHaveBeenCalledWith(
        "http://localhost:4999/api/dev/frontend-changed",
        expect.objectContaining({ method: "POST" }),
      );
      expect(
        notify.mock.calls.map(([, init]) => String(init?.body ?? "")),
      ).toEqual([expect.stringContaining("src/lib/clientSummaryStore.ts")]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server?.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true });
    }
  });
});
