import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import { holdNewSessionBootstrap } from "./support/bootstrap.js";

// These cases own no seeded session draft; the fixture still clears the
// worker's shared new-session draft before each one.
test.use({ draftSessionIds: [] });
test.use({ serviceWorkers: "block" });

/** Hold every script request until released, so only inline code runs. */
async function holdScripts(page: Page): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let releasing = false;
  await page.route("**/*", (route) => {
    if (releasing || route.request().resourceType() !== "script") {
      return route.continue();
    }
    held.push(route);
  });
  return async () => {
    releasing = true;
    await Promise.all(held.splice(0).map((route) => route.continue()));
  };
}

test("keys typed before the app loads reach the new-session composer", async ({
  page,
  baseURL,
}) => {
  // Wide enough for the saved desktop sidebar, which stays expanded.
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "draft-new-session:local",
      JSON.stringify({ version: 1, text: "Saved prompt: " }),
    );
    localStorage.setItem("yep-anywhere-sidebar-expanded", "true");
    localStorage.setItem("yep-anywhere-sidebar-width", "360");
    const samples: number[] = [];
    const moduleFallbacks: number[] = [];
    new MutationObserver(() => {
      if (document.querySelector('[data-startup-phase="module"]')) {
        moduleFallbacks.push(performance.now());
      }
    }).observe(document, { childList: true, subtree: true });
    let keyAt = 0;
    document.addEventListener(
      "keydown",
      () => {
        keyAt = performance.now();
      },
      true,
    );
    document.addEventListener(
      "input",
      () => {
        samples.push(performance.now() - keyAt);
      },
      true,
    );
    Object.assign(window, { typingSamples: samples, moduleFallbacks });
  });
  const release = await holdScripts(page);
  // DOMContentLoaded waits for the held module scripts, so only commit.
  await page.goto(`${baseURL}/new-session`, { waitUntil: "commit" });

  const preboot = page.locator("#yep-preboot-composer textarea");
  await expect(preboot).toBeFocused();
  await expect(preboot).toHaveValue("Saved prompt: ");
  // Route chunks must be discovered from HTML while all modules are held.
  await expect(
    page.locator('link[rel="modulepreload"][href*="/NewSessionPage-"]'),
  ).toHaveCount(1);
  await page.keyboard.type("typed before boot", { delay: 10 });
  // Enter sends in the app; it must not become a newline in the meantime.
  await page.keyboard.press("Enter");
  await expect(preboot).toHaveValue("Saved prompt: typed before boot");

  const earlyBox = await preboot.boundingBox();
  await release();

  const composer = page.locator("textarea[data-new-session-form-textarea]");
  await expect(composer).toBeFocused({ timeout: 30_000 });
  await expect(page.locator("#yep-preboot-composer")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { moduleFallbacks: number[] }).moduleFallbacks,
    ),
  ).toEqual([]);
  await page.keyboard.type(" and after", { delay: 10 });
  await expect(composer).toHaveValue(
    "Saved prompt: typed before boot and after",
  );

  await expect(page.locator("[data-sidebar-desktop]")).toBeVisible();
  await expect(page.locator("[data-sidebar-desktop]")).not.toHaveAttribute(
    "data-sidebar-collapsed",
  );
  await expect(page.locator("[data-sidebar-floating-restore]")).toHaveCount(0);
  const adoptedBox = await page
    .locator("[data-new-session-form] [data-speech-draft-field]")
    .boundingBox();
  expect(Math.abs(adoptedBox!.x - earlyBox!.x)).toBeLessThan(2);
  expect(Math.abs(adoptedBox!.width - earlyBox!.width)).toBeLessThan(2);
  const samples = await page.evaluate(
    () => (window as unknown as { typingSamples: number[] }).typingSamples,
  );
  expect(samples).toHaveLength("typed before boot and after".length);
  expect(Math.max(...samples)).toBeLessThan(100);
  // Let project/provider discovery settle before reviewing the final form.
  await page.waitForURL((url) => url.searchParams.has("projectId"));
  await expect(page.locator("[data-new-session-provider-slot]")).toContainText(
    "Claude",
  );
  await expect(
    page.locator('a[title="Show project app while composing"]'),
  ).toHaveCount(0);
  await recordUiCapture(page, "new-session-expanded-1400");
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `new-session-default-${viewport.width}`);
  }
});

test("a reload before the app adopts the composer keeps what was typed", async ({
  page,
  baseURL,
}) => {
  const release = await holdScripts(page);
  await page.goto(`${baseURL}/new-session`, { waitUntil: "commit" });
  const preboot = page.locator("#yep-preboot-composer textarea");
  await expect(preboot).toBeFocused();
  await page.keyboard.type("typed before", { delay: 10 });

  // What a development source-version check or applied defaults do mid-boot.
  await page.reload({ waitUntil: "commit" });
  await expect(preboot).toBeFocused();
  await expect(preboot).toHaveValue("typed before");
  await page.keyboard.type(" a reload", { delay: 10 });

  await release();
  const composer = page.locator("textarea[data-new-session-form-textarea]");
  await expect(composer).toBeFocused({ timeout: 30_000 });
  await expect(composer).toHaveValue("typed before a reload");
  // Adopted once: the stash is spent, so a later reload does not add it again.
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("yep-preboot-composer-text"),
    ),
  ).toBeNull();
});

test("New Session route data arrives before the UI runtime executes", async ({
  page,
  baseURL,
}) => {
  const held: Route[] = [];
  let releasing = false;
  await page.route("**/assets/react-runtime-*.js", (route) => {
    if (releasing) return route.continue();
    held.push(route);
  });
  const response = page.waitForResponse(
    (response) =>
      response.url().includes("bootstrap=new-session-v1") && response.ok(),
  );
  try {
    await page.goto(`${baseURL}/new-session`, { waitUntil: "commit" });
    const bundle = await response;
    expect(bundle.headers()["content-type"]).toContain("text/event-stream");
    const parts = (await bundle.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)).part);
    expect(parts.sort()).toEqual([
      "projects",
      "provider",
      "recents",
      "settings",
      "version",
    ]);
    expect(held.length).toBeGreaterThan(0);
    await expect(page.locator("[data-new-session-form] textarea")).toHaveCount(
      0,
    );
  } finally {
    releasing = true;
    await Promise.all(held.map((route) => route.continue()));
  }
  const composer = page.locator("textarea[data-new-session-form-textarea]");
  await expect(composer).toBeVisible();
  await composer.focus();
  let typed = "";
  for (const character of "early data") {
    await page.keyboard.type(character);
    typed += character;
    await expect(composer).toHaveValue(typed, { timeout: 100 });
  }
});

test("Settings acquires settings and version before the UI runtime executes", async ({
  page,
  baseURL,
}) => {
  const held: Route[] = [];
  let releasing = false;
  await page.route("**/assets/react-runtime-*.js", (route) => {
    if (releasing) return route.continue();
    held.push(route);
  });
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/providers")) {
      providerRequests.push(request.url());
    }
  });
  const responses = ["/api/settings", "/api/version"].map((path) =>
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === path && response.ok(),
      { timeout: 5000 },
    ),
  );
  try {
    await page.goto(`${baseURL}/settings`, { waitUntil: "commit" });
    await Promise.all(responses);
    expect(held.length).toBeGreaterThan(0);
    expect(providerRequests).toEqual([]);
  } finally {
    releasing = true;
    await Promise.all(held.map((route) => route.continue()));
  }
  await expect(
    page.locator("[data-settings-content-panel] [data-settings-item]").first(),
  ).toBeVisible();
});

test("route data arrives before the New Session module executes", async ({
  page,
  baseURL,
}) => {
  const mathRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/katex-[^/]+\.js$/.test(new URL(request.url()).pathname)) {
      mathRequests.push(request.url());
    }
  });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const input = document.querySelector<HTMLInputElement>(
        "[data-new-session-project-input]",
      );
      if (!input) return;
      Object.assign(window, { firstNewSessionProjectValue: input.value });
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  const held: Route[] = [];
  const expectedProjectPath = join(e2ePaths.tempDir, "mockproject");
  const projectId = Buffer.from(expectedProjectPath).toString("base64url");
  const projectDetailRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/projects/${projectId}`) {
      projectDetailRequests.push(request.url());
    }
  });
  let releasing = false;
  await page.route("**/assets/NewSessionPage-*.js", (route) => {
    if (releasing) return route.continue();
    held.push(route);
  });
  const response = page.waitForResponse(
    (response) =>
      response.url().includes("bootstrap=new-session-v1") && response.ok(),
  );
  try {
    await page.goto(`${baseURL}/new-session?projectId=${projectId}`, {
      waitUntil: "commit",
    });
    const frames = (await (await response).text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const { projects } = frames.find((frame) => frame.part === "projects").body;
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expectedProjectPath }),
      ]),
    );
    expect(held.length).toBeGreaterThan(0);
    await expect(page.locator("[data-new-session-form] textarea")).toHaveCount(
      0,
    );
  } finally {
    releasing = true;
    await Promise.all(held.map((route) => route.continue()));
  }
  await expect(page.locator("[data-new-session-form] textarea")).toBeVisible();
  await page
    .locator("[data-new-session-form] textarea")
    .pressSequentially("ready");
  expect(projectDetailRequests).toEqual([]);
  expect(mathRequests).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { firstNewSessionProjectValue: string })
          .firstNewSessionProjectValue,
    ),
  ).toBe(expectedProjectPath);
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `initial-project-${viewport.width}`);
  }
});

test("other routes never show the pre-boot composer", async ({
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/projects`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#yep-preboot-composer")).toHaveCount(0);
});

for (const viewport of [
  { width: 1000, height: 600 },
  { width: 375, height: 812 },
]) {
  test(`startup controls keep their positions as data arrives at ${viewport.width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const bundledParts = new Map([
      ["/api/settings", "settings"],
      ["/api/projects", "projects"],
      ["/api/recents", "recents"],
      ["/api/providers/claude", "provider"],
    ]);
    const bundle = await holdNewSessionBootstrap(page, [
      ...bundledParts.values(),
    ]);
    const releases = new Map<string, () => void>();
    for (const path of [
      "/api/settings",
      "/api/projects",
      "/api/recents",
      "/api/providers/descriptors",
      "/api/providers/claude",
      "/api/providers",
    ]) {
      const gate = new Promise<void>((resolve) => releases.set(path, resolve));
      if (bundledParts.has(path)) continue;
      await page.route(
        (url) => url.pathname === path,
        async (route) => {
          await gate;
          await route.continue();
        },
      );
    }
    const positions = () =>
      page.evaluate(() => {
        const selectors = [
          "[data-new-session-provider-section]",
          "[data-new-session-model-section]",
          "[data-new-session-provider-slot] > [data-new-session-helper-section]",
          '[aria-controls="new-session-advanced-options"]',
        ];
        return selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing option slot: ${selector}`);
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        });
      });
    try {
      await page.goto(`${baseURL}/new-session`, { waitUntil: "commit" });
      await expect(
        page.locator("[data-new-session-provider-slot]"),
      ).toBeAttached();
      const before = await positions();
      const composer = page.locator("textarea[data-new-session-form-textarea]");
      let draft = await composer.inputValue();
      await composer.press("ControlOrMeta+End");
      for (const path of releases.keys()) {
        // Unrelated provider discovery stays held throughout first render.
        if (path === "/api/providers") continue;
        const part = bundledParts.get(path);
        const response = part
          ? bundle.wait(part)
          : page.waitForResponse(
              (result) => new URL(result.url()).pathname === path,
            );
        releases.get(path)!();
        if (part) await bundle.release(part);
        for (const character of "abc") {
          await page.keyboard.type(character);
          draft += character;
          await expect(composer).toHaveValue(draft, { timeout: 100 });
        }
        await response;
        // Allow the response's React update and resulting layout to paint.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const after = await positions();
        for (let index = 0; index < before.length; index++) {
          expect(
            Math.abs(after[index]!.x - before[index]!.x),
            `${path} slot ${index} x`,
          ).toBeLessThan(2);
          expect(
            Math.abs(after[index]!.y - before[index]!.y),
            `${path} slot ${index} y`,
          ).toBeLessThan(2);
        }
      }
      await expect(
        page.locator("[data-new-session-model-field] button").first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Refresh", exact: true }),
      ).toBeVisible();
      await recordUiCapture(page, `stable-startup-controls-${viewport.width}`);
    } finally {
      for (const release of releases.values()) release();
      await bundle.release();
    }
  });
}

test("refresh preserves saved sidebar modes on New Session", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  for (const mode of ["expanded", "collapsed", "minimized"]) {
    await page.goto(`${baseURL}/projects`);
    await page.evaluate((mode) => {
      localStorage.setItem(
        "yep-anywhere-sidebar-expanded",
        String(mode === "expanded"),
      );
      localStorage.setItem(
        "yep-anywhere-sidebar-minimized",
        String(mode === "minimized"),
      );
    }, mode);
    await page.goto(`${baseURL}/new-session`);
    await expect(
      page.locator("textarea[data-new-session-form-textarea]"),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator("textarea[data-new-session-form-textarea]"),
    ).toBeVisible();
    if (mode === "minimized") {
      await expect(
        page.locator("[data-sidebar-floating-restore]"),
      ).toBeVisible();
    } else {
      await expect(page.locator("[data-sidebar-desktop]")).toBeVisible();
      if (mode === "collapsed")
        await expect(page.locator("[data-sidebar-desktop]")).toHaveAttribute(
          "data-sidebar-collapsed",
        );
      else
        await expect(
          page.locator("[data-sidebar-desktop]"),
        ).not.toHaveAttribute("data-sidebar-collapsed");
    }
  }
  await page.goto(`${baseURL}/new-session?sidebar=expanded`);
  await expect(page.locator("[data-sidebar-desktop]")).toBeVisible();
  await expect(page.locator("[data-sidebar-desktop]")).not.toHaveAttribute(
    "data-sidebar-collapsed",
  );
});

test("a sibling tab shows projects while version and catalog requests are held", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const projects = await (await request.get(`${baseURL}/api/projects`)).json();
  const project = projects.projects.find((row: { path: string }) =>
    row.path.endsWith("/mockproject"),
  );
  expect(project).toBeTruthy();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sibling = await context.newPage();
  const bundle = await holdNewSessionBootstrap(sibling, [
    "projects",
    "recents",
    "version",
  ]);
  const attempts: string[] = [];
  sibling.on("request", (req) => {
    if (req.method() === "POST" && /sessions|project-queue/.test(req.url()))
      attempts.push(req.url());
  });
  try {
    // The existing tab need not have visited New Session: the shared sidebar
    // keeps its accepted project display rows available to sibling tabs.
    await page.goto(`${baseURL}/projects`);
    await page.waitForFunction(
      () =>
        localStorage.getItem('ya:new-session-projects:["local",null]') !== null,
    );
    await sibling.route(
      /\/api\/(?:projects|recents|version)(?:[/?]|$)/,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    await sibling.addInitScript(() => {
      const samples: number[] = [];
      let keyAt = 0;
      document.addEventListener(
        "keydown",
        () => {
          keyAt = performance.now();
        },
        true,
      );
      document.addEventListener(
        "input",
        () => {
          samples.push(performance.now() - keyAt);
        },
        true,
      );
      Object.assign(window, { projectSnapshotTypingSamples: samples });
    });
    await sibling.goto(
      `${baseURL}/new-session?projectId=${encodeURIComponent(project.id)}`,
      { waitUntil: "commit" },
    );
    await expect(
      sibling.locator("[data-new-session-project-input]"),
    ).toHaveValue(project.path);
    await expect(
      sibling.getByText("Refreshing project…", { exact: false }),
    ).toBeVisible();
    await expect(
      sibling.locator("[data-new-session-model-field] button").first(),
    ).toBeVisible();
    const composer = sibling.locator(
      "textarea[data-new-session-form-textarea]",
    );
    await composer.fill("");
    await composer.pressSequentially("project snapshot typing", { delay: 10 });
    await expect(composer).toHaveValue("project snapshot typing");
    await composer.press("Enter");
    await composer.press("ControlOrMeta+Enter");
    expect(attempts).toEqual([]);
    const samples = await sibling.evaluate(() =>
      (
        window as unknown as { projectSnapshotTypingSamples: number[] }
      ).projectSnapshotTypingSamples.slice(1),
    );
    expect(samples.length).toBeGreaterThan(10);
    expect(Math.max(...samples)).toBeLessThan(100);
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await sibling.setViewportSize(viewport);
      await recordUiCapture(
        sibling,
        `new-session-project-snapshot-${viewport.width}`,
      );
    }
    release();
    await bundle.release();
    await expect(
      sibling.getByText("Refreshing project…", { exact: false }),
    ).toHaveCount(0);
    await expect(
      sibling.locator("[data-new-session-project-input]"),
    ).toHaveValue(project.path);
    await expect(composer).toHaveValue("project snapshot typing");
    expect(attempts).toEqual([]);
  } finally {
    release();
    await bundle.release();
    await sibling.close();
  }
});

test("a sibling tab shows saved model and effort before settings or catalogs arrive", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const before = await (await request.get(`${baseURL}/api/settings`)).json();
  const headers = { "X-Yep-Anywhere": "true" };
  const update = await request.put(`${baseURL}/api/settings`, {
    headers,
    data: {
      newSessionDefaults: {
        provider: "claude",
        providers: {
          claude: { model: "sonnet", thinkingMode: "on", effortLevel: "high" },
        },
      },
    },
  });
  expect(update.ok()).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sibling = await context.newPage();
  const bundle = await holdNewSessionBootstrap(sibling, [
    "settings",
    "provider",
  ]);
  try {
    await context.route(/\/api\/providers(?:\?.*)?$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(`${baseURL}/new-session`);
    await expect(
      page.locator("[data-new-session-model-field] button").first(),
    ).toContainText("Sonnet");
    await page.waitForFunction(
      () => localStorage.getItem('ya:provider-row:["local","claude"]') !== null,
    );
    expect(
      await page.evaluate(() => localStorage.getItem("ya:providers:local")),
    ).toBeNull();
    await sibling.route("**/api/settings", async (route) => {
      await gate;
      await route.continue();
    });
    await sibling.route(/\/api\/providers\/claude(?:\?.*)?$/, async (route) => {
      await gate;
      await route.continue();
    });
    await sibling.goto(page.url(), { waitUntil: "commit" });
    await expect(
      sibling.locator("[data-new-session-model-field] button").first(),
    ).toContainText("Sonnet");
    await expect(
      sibling.locator(
        '[data-new-session-helper-section] button[aria-label*="Thinking"]',
      ),
    ).toContainText("High");
    await expect(
      sibling.locator("[data-model-switch-indicator-dot]"),
    ).toHaveCSS("width", "10px");
    await expect(
      sibling.locator("[data-model-switch-indicator-dot]"),
    ).toHaveCSS("height", "10px");
    await expect(
      sibling.locator("[data-new-session-provider-section] button"),
    ).toContainText("Claude");
    const composer = sibling.locator(
      "textarea[data-new-session-form-textarea]",
    );
    const originalDraft = await composer.inputValue();
    await composer.press("ControlOrMeta+End");
    await composer.pressSequentially("cached choices, live typing", {
      delay: 10,
    });
    await expect(composer).toHaveValue(
      `${originalDraft}cached choices, live typing`,
    );
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await sibling.setViewportSize(viewport);
      await recordUiCapture(
        sibling,
        `new-session-retained-defaults-${viewport.width}`,
      );
    }
  } finally {
    release();
    await bundle.release();
    await sibling.close();
    const restored = await request.put(`${baseURL}/api/settings`, {
      headers,
      data: { newSessionDefaults: before.settings.newSessionDefaults ?? {} },
    });
    expect(restored.ok()).toBe(true);
  }
});
