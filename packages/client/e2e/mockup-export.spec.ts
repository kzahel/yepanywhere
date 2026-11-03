import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build, preview } from "vite";
import { createTestViteServer as createServer } from "./support/vite-server";
import {
  clientRoot,
  exportDirectory,
  manifest,
  states,
  viewports,
} from "../mockups/export";
import { createApp } from "../../server/test/setup/create-app";
import { createFrontendProxy } from "../../server/src/frontend/proxy";
import { ScriptedClaudeProvider } from "../../server/test/support/scripted-provider.js";
import { ServerSettingsService } from "../../server/src/services/ServerSettingsService";
import { initFileAccess } from "../../server/src/middleware/file-access";
import { checkMockup } from "./fixtures/mockup-checks";

const serverRequire = createRequire(join(clientRoot, "../server/package.json"));
const { getRequestListener } = serverRequire("@hono/node-server");
const configFile = join(clientRoot, "vite.config.mockup.ts");
const captures = resolve(exportDirectory, "../captures/projects");

test("exports matching source states, a complete bundle, and a working direct YA preview", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // An exported mockup is a production artifact. Vite treats an ambient
  // NODE_ENV as authoritative over the build mode, so a build started from
  // Playwright's `test` environment resolves libraries' development exports
  // and ships their dev branches. Every other build this suite starts is a
  // subprocess that already pins this; only this one runs in-process.
  const runnerNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ configFile });
  } finally {
    process.env.NODE_ENV = runnerNodeEnv;
  }
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      problems.push(message.text());
  });
  await mkdir(captures, { recursive: true });
  const screenshots: {
    state: string;
    viewport: string;
    path: string;
    document: string;
  }[] = [];
  const source = await createServer({
    configFile,
    server: { host: "127.0.0.1", port: 0 },
  });
  const sourceImages = new Map<string, Buffer>();
  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing source port");
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const state of states) {
        await page.goto(`http://127.0.0.1:${address.port}/${state.entry}`);
        try {
          await checkMockup(page, state.name);
        } catch (error) {
          throw new Error(
            `Source preview browser errors: ${problems.join("\n")}`,
            {
              cause: error,
            },
          );
        }
        const name = `${state.name}-${viewport.name}.png`;
        sourceImages.set(
          name,
          await page.screenshot({
            path: join(captures, `source-${name}`),
            animations: "disabled",
          }),
        );
      }
    }
  } finally {
    await page.goto("about:blank");
    await source.close();
  }

  // Move the build before viewing so accidental dependencies on its build path fail.
  const directory = await mkdtemp(join(captures, "run-"));
  try {
    const relocated = join(directory, "relocated");
    await cp(exportDirectory, relocated, { recursive: true });
    const exported = await preview({
      configFile,
      build: { outDir: relocated },
      preview: { host: "127.0.0.1", port: 0 },
    });
    try {
      const address = exported.httpServer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing export port");
      const origin = `http://127.0.0.1:${address.port}`;
      const inventory = JSON.parse(
        await readFile(join(relocated, "ya-mockup.json"), "utf8"),
      );
      expect(
        (
          await readdir(relocated, { recursive: true, withFileTypes: true })
        ).filter((entry) => entry.isFile()).length,
      ).toBe(inventory.files.length);
      for (const file of inventory.files) {
        const expected = await readFile(join(relocated, file));
        const response = await page.request.get(`${origin}/${file}`);
        expect(response.status(), file).toBe(200);
        expect((await response.body()).equals(expected), file).toBe(true);
      }
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        expect(url.origin).toBe(origin);
        expect(inventory.files).toContain(
          decodeURIComponent(url.pathname.slice(1)),
        );
        await route.continue();
      });
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const state of states) {
          await page.goto(`${origin}/${state.entry}`);
          await checkMockup(page, state.name);
          const name = `${state.name}-${viewport.name}.png`;
          const capture = await page.screenshot({
            path: join(exportDirectory, name),
            animations: "disabled",
          });
          expect(capture.equals(sourceImages.get(name)!)).toBe(true);
          screenshots.push({
            state: state.name,
            viewport: viewport.name,
            path: name,
            document: state.entry,
          });
        }
      }
      await page.unrouteAll({ behavior: "wait" });
      const files = [
        ...new Set([
          ...inventory.files,
          ...screenshots.map((item) => item.path),
          "review.html",
        ]),
      ].sort();
      await writeFile(
        join(exportDirectory, "review.html"),
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${manifest.title} — captures</title><h1>${manifest.title}</h1><p>Regenerate: <code>${manifest.regenerate}</code></p>${screenshots.map((item) => `<figure><a href="${item.document}"><img src="${item.path}" style="max-width:100%;height:auto" alt="${item.state}, ${item.viewport}"></a><figcaption><a href="${item.document}">${item.state}, ${item.viewport}: open interactive document</a></figcaption></figure>`).join("")}</html>`,
      );
      await writeFile(
        join(exportDirectory, "ya-mockup.json"),
        `${JSON.stringify({ ...inventory, files, screenshots }, null, 2)}\n`,
      );
    } finally {
      if ("closeAllConnections" in exported.httpServer)
        exported.httpServer.closeAllConnections();
      await new Promise<void>((done, reject) =>
        exported.httpServer.close((error) => (error ? reject(error) : done())),
      );
    }

    let instance: ReturnType<typeof createApp> | undefined;
    let listener: ReturnType<typeof createHttpServer> | undefined;
    const viewer = await createServer({
      root: clientRoot,
      configFile: join(clientRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await viewer.listen();
      const viteAddress = viewer.httpServer?.address();
      if (!viteAddress || typeof viteAddress === "string")
        throw new Error("Missing viewer port");
      const dataDir = join(directory, "data");
      const settings = new ServerSettingsService({ dataDir });
      await settings.initialize();
      initFileAccess({
        uploadsDir: directory,
        homeDir: directory,
        tempPaths: [directory],
        envPaths: [directory],
      });
      const frontendProxy = createFrontendProxy({
        vitePort: viteAddress.port,
        viteHost: "127.0.0.1",
      });
      instance = createApp({
        provider: new ScriptedClaudeProvider(),
        dataDir,
        projectsDir: join(directory, "sessions"),
        serverSettingsService: settings,
        frontendProxy,
      });
      listener = createHttpServer(getRequestListener(instance.app.fetch));
      listener.on("upgrade", frontendProxy.ws);
      await new Promise<void>((ready) =>
        listener!.listen(0, "127.0.0.1", ready),
      );
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("Missing YA port");
      await instance.artifactServer.configure({
        port: 4402,
        localOrigin: `http://artifacts.localhost:${address.port}`,
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/e2e/fixtures/artifact-viewer.html?path=${encodeURIComponent(join(relocated, "index.html"))}`,
      );
      await page
        .getByRole("button", { name: "Run full HTML/CSS/JavaScript preview" })
        .click();
      await expect(
        page
          .frameLocator("iframe")
          .getByRole("heading", { name: "Project review", exact: true }),
      ).toBeVisible();
      const child = page.frames().find((frame) => frame.url().includes("/a/"));
      if (!child) throw new Error("Missing artifact frame");
      await checkMockup(child, "default");
      await child
        .getByText("End of sample projects.", { exact: false })
        .scrollIntoViewIfNeeded();
      expect(await child.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await child.evaluate(() => window.scrollTo(0, 0));
      await child
        .getByRole("button", { name: "Open project settings", exact: true })
        .first()
        .click();
      await expect(child.getByRole("status")).toHaveText(
        "Settings selected: Yep Anywhere",
      );
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await page.screenshot({
          path: join(captures, `direct-${viewport.name}.png`),
        });
      }
      await page
        .getByRole("button", { name: "Stop interactive preview" })
        .click();
      expect(problems).toEqual([]);
    } finally {
      await page.goto("about:blank");
      if (listener) {
        listener.closeAllConnections();
        await new Promise<void>((done, reject) =>
          listener!.close((error) => (error ? reject(error) : done())),
        );
      }
      if (instance) await instance.disposeSessionReaders();
      await viewer.close();
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
