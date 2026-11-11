import {
  routeWithDrain,
  drainManagedRoutes,
  readCollectionsOverRest,
} from "./support/managed-routes.js";
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const createdFiles: string[] = [];
for (const viewport of [
  { name: "desktop", width: 1200, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`All Sessions CSV filters keep first-term scanning and detail uses the right pane (${viewport.name})`, async ({
    page,
    baseURL,
  }) => {
    saveSession(
      `csv-${viewport.name}-alpha`,
      "alpha",
      true,
      Date.now() - 60000,
    );
    saveSession(`csv-${viewport.name}-beta`, "beta", true);
    await page.setViewportSize(viewport);
    await page.addInitScript(() =>
      localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true"),
    );
    const requests: Array<{ sessionId: string; query: string }> = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/content-search"))
        requests.push(request.postDataJSON());
    });
    await page.goto(`${baseURL}/sessions?q=quasarneedle`);
    const search = page.getByRole("searchbox", { name: "Search sessions..." });
    await expect(page.getByRole("checkbox", { name: "CSV AND" })).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Last activity", exact: true }),
    ).toBeChecked();
    await page.getByRole("checkbox", { name: /^User/ }).check();
    const rows = page.locator("[data-session-list-item--card]");
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(0);
    const ownOrder = [
      ...new Set(
        requests
          .filter((request) =>
            request.sessionId.startsWith(`csv-${viewport.name}`),
          )
          .map((request) => request.sessionId),
      ),
    ];
    expect(ownOrder).toEqual([
      `csv-${viewport.name}-beta`,
      `csv-${viewport.name}-alpha`,
    ]);
    await search.press("End");
    await search.pressSequentially(", alpha", { delay: 10 });
    await expect(search).toHaveValue("quasarneedle, alpha");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("alpha");
    expect(requests.every((request) => request.query === "quasarneedle")).toBe(
      true,
    );
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: /^Maximum age/ }),
    ).toHaveValue("7d");
    await recordUiCapture(page, `csv-results-${viewport.name}`, viewport);
    const expand = rows.getByRole("button", {
      name: "Show all retained matches in this session",
    });
    const sessionMenu = rows.locator("[data-session-menu]");
    const a = (await expand.boundingBox())!;
    const b = (await sessionMenu.boundingBox())!;
    expect(
      a.x + a.width <= b.x || a.y >= b.y + b.height || b.y >= a.y + a.height,
    ).toBe(true);
    await expand.click();
    const expandedDetail = page.getByRole("dialog");
    await expect(expandedDetail).toContainText("quasarneedle");
    await expandedDetail.locator('a[href*="searchMatch="]').first().click();
    const detail = page.getByRole("dialog");
    await expect(detail).toContainText("quasarneedle");
    await expect(page.locator("[data-modal-overlay]")).toHaveCount(0);
    const link = detail.getByRole("link", { name: "Open turn in session" });
    await expect(link).toBeVisible();
    await recordUiCapture(page, `csv-detail-${viewport.name}`, viewport);
    await link.click();
    await expect(page).toHaveURL(/searchMatch=/);
    await expect(
      page
        .locator("[data-render-id]")
        .filter({ hasText: "quasarneedle" })
        .first(),
    ).toBeVisible();
    await page.goto(`${baseURL}/settings/performance`);
    const concurrency = page.getByRole("slider", {
      name: "Concurrent session file reads",
    });
    await expect(concurrency).toHaveValue("4");
    await concurrency.scrollIntoViewIfNeeded();
    await recordUiCapture(
      page,
      `search-concurrency-${viewport.name}`,
      viewport,
    );
  });
}
test.afterEach(() => {
  for (const file of createdFiles.splice(0)) unlinkSync(file);
});

function saveSession(
  id: string,
  name: string,
  manyMatches = false,
  now = Date.now(),
) {
  const cwd = join(e2ePaths.tempDir, "mockproject");
  const dir = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    cwd.replace(/[/\\]/g, "-"),
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const entries = Array.from({ length: 262 }, (_, i) => ({
    type: i % 2 ? "assistant" : "user",
    uuid: `${id}-${i}`,
    parentUuid: i ? `${id}-${i - 1}` : null,
    cwd,
    sessionId: id,
    timestamp: new Date(now - (262 - i) * 60000).toISOString(),
    message: {
      role: i % 2 ? "assistant" : "user",
      content:
        i === 0
          ? `Search fixture ${name}`
          : manyMatches && i >= 250 && i < 258
            ? `quasarneedle ${name} additional match ${i}`
            : i === 258
              ? `quasarneedle ${name} original request`
              : i === 259
                ? `quasarneedle ${name} matching answer`
                : `Ordinary turn ${i}`,
    },
  }));
  writeFileSync(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  createdFiles.push(file);
}

/**
 * Wait until the server catalog lists freshly saved sessions. Tests that
 * derive fixture rows from a saved seed pass the real response through while
 * the seed is missing, and a worker shared with many earlier specs can take
 * well past the default expect timeout to discover a new transcript.
 */
async function awaitCatalogSessions(
  baseURL: string | undefined,
  ids: string[],
) {
  await expect
    .poll(
      async () => {
        const response = await fetch(
          `${baseURL}/api/sessions?summaryMode=retained&limit=500&includeArchived=true`,
          { headers: { "X-Yep-Anywhere": "true" } },
        );
        if (!response.ok) return [];
        const data = (await response.json()) as {
          sessions: Array<{ id: string }>;
        };
        return ids.filter((id) =>
          data.sessions.some((session) => session.id === id),
        );
      },
      { timeout: 30_000 },
    )
    .toEqual(ids);
}

test("All Sessions keeps every typed character with a large title catalog", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60000);
  saveSession("typing-fixture", "typing");
  await awaitCatalogSessions(baseURL, ["typing-fixture"]);
  await readCollectionsOverRest(page);
  await routeWithDrain(page, /\/api\/sessions\?/, async (route) => {
    // Inflate the page catalog, retaining the sidebar's actual bounded feed.
    if (new URL(route.request().url()).searchParams.get("limit") !== "500")
      return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.sessions?.find(
      (s: { id: string }) => s.id === "typing-fixture",
    );
    if (!seed) return route.fulfill({ response });
    await route.fulfill({
      response,
      json: {
        ...data,
        hasMore: false,
        sessions: Array.from({ length: 1000 }, (_, i) => ({
          ...seed,
          id: `typing-${i}`,
          title: `Search fixture typing ${i}`,
          fullTitle: `Search fixture typing ${i}`,
          initialPrompt: `Search fixture typing ${i}`,
        })),
      },
    });
  });
  await page.goto(`${baseURL}/sessions`);
  const search = page.getByRole("searchbox", { name: "Search sessions..." });
  await expect(search).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Select all 100\d$/ }),
  ).toBeVisible();
  await search.evaluate((node) => {
    const samples: Array<{
      latency: number;
      expected: string;
      actual: string;
    }> = [];
    let expected = "";
    Object.assign(window, { typingSamples: samples });
    node.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key.length !== 1) return;
      expected += key;
      const prefix = expected;
      const start = event.timeStamp;
      requestAnimationFrame(() =>
        samples.push({
          latency: performance.now() - start,
          expected: prefix,
          actual: (node as HTMLInputElement).value,
        }),
      );
    });
  });
  const text = "Search fixture typing 987";
  await search.pressSequentially(text, { delay: 10 });
  expect(await search.inputValue()).toBe(text);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          typingSamples: Array<{
            latency: number;
            expected: string;
            actual: string;
          }>;
        }
      ).typingSamples,
  );
  expect(samples).toHaveLength(text.length);
  expect(
    samples.every((sample) => sample.actual.startsWith(sample.expected)),
  ).toBe(true);
  console.log(
    "[search-typing]",
    JSON.stringify({
      characters: text.length,
      maxKeyToFrameMs: Math.max(...samples.map((sample) => sample.latency)),
      slowKeys: samples.filter((sample) => sample.latency > 100),
    }),
  );
  expect(
    Math.max(...samples.map((sample) => sample.latency)),
  ).toBeLessThanOrEqual(100);
  await expect(page.locator("[data-session-list-item--card]")).toHaveCount(1);
});

test("All Sessions preserves copying and returns to the query end only when typing", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1000, height: 600 });
  saveSession("soft-focus", "soft focus");
  await page.goto(`${baseURL}/sessions`);
  const search = page.getByRole("searchbox", { name: "Search sessions..." });
  const query = "Search fixture soft focus";
  await search.fill(query);
  // A triple-click selection ends at the boundary of the following block, so
  // rows still arriving move it. Select only once the list has settled: the
  // fixture listed and no scan running.
  await expect(
    page.getByRole("checkbox", { name: "Select Search fixture soft focus" }),
  ).toBeVisible();
  await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(0);
  await search.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(0, 0),
  );
  const help = page
    .locator("p:visible")
    .filter({ hasText: "count includes selections the search hides;" });
  await help.click({ clickCount: 3 });
  const selection = await page.evaluate(() =>
    window.getSelection()!.toString(),
  );
  expect(selection).toContain("count includes selections the search hides");
  await expect(search).not.toBeFocused();
  await help.click({ button: "right" });
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(
    selection,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    selection,
  );
  await page.keyboard.type("z");
  await expect(search).toHaveValue(`${query}z`);
  await expect(search).toBeFocused();
  expect(
    await search.evaluate((node: HTMLInputElement) => node.selectionStart),
  ).toBe(query.length + 1);
  const age = page.getByRole("textbox", { name: /^Minimum age/ });
  await age.fill("1");
  await page.keyboard.type("2");
  await expect(age).toHaveValue("12");
  await expect(search).toHaveValue(`${query}z`);
  await page.getByRole("radio", { name: "Turns", exact: true }).click();
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(search).toHaveValue(query);
});

test("All Sessions follows appended turns and newly discovered sessions without restarting the catalog", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60000);
  saveSession("live-search-alpha", "live alpha");
  const file = createdFiles.at(-1)!;
  const requests: Array<{ sessionId: string; cursor?: string }> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/sessions/content-search"))
      requests.push(JSON.parse(request.postData()!));
  });
  await page.goto(`${baseURL}/sessions`);
  const search = page.getByRole("searchbox", { name: "Search sessions..." });
  await search.fill("quasarneedle");
  await search.press("Control+r");
  await expect(
    page
      .getByText("quasarneedle live alpha original request", { exact: false })
      .first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(0, {
    timeout: 30000,
  });
  const before = requests.length;
  appendFileSync(
    file,
    `${JSON.stringify({ type: "user", uuid: "live-appended", parentUuid: "live-search-alpha-261", sessionId: "live-search-alpha", cwd: join(e2ePaths.tempDir, "mockproject"), timestamp: new Date().toISOString(), message: { role: "user", content: "quasarneedle live appended user" } })}\n`,
  );
  await expect(
    page.getByText("quasarneedle live appended user", { exact: false }).first(),
  ).toBeVisible({ timeout: 30000 });
  expect(
    requests
      .slice(before)
      .filter((request) => request.sessionId === "live-search-alpha")
      .every((request) => !!request.cursor),
  ).toBe(true);
  const afterAppend = requests.length;
  saveSession("live-search-beta", "live beta");
  await expect(
    page
      .getByText("quasarneedle live beta original request", { exact: false })
      .first(),
  ).toBeVisible({ timeout: 30000 });
  expect(
    requests
      .slice(afterAppend)
      .filter(
        (request) =>
          request.sessionId === "live-search-alpha" && !request.cursor,
      ),
  ).toHaveLength(0);
});

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`All Sessions filters creation provenance on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    saveSession(`provenance-${viewport.name}`, `provenance ${viewport.name}`);
    await awaitCatalogSessions(baseURL, [`provenance-${viewport.name}`]);
    await page.setViewportSize(viewport);
    await readCollectionsOverRest(page);
    await routeWithDrain(page, /\/api\/sessions\?/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const seed = data.sessions?.find(
        (session: { id: string }) =>
          session.id === `provenance-${viewport.name}`,
      );
      if (!seed) return route.fulfill({ response });
      await route.fulfill({
        response,
        json: {
          ...data,
          hasMore: false,
          sessions: [
            {
              ...seed,
              id: `provenance-web-${viewport.name}`,
              title: "Web provenance fixture",
              fullTitle: "Web provenance fixture",
              creationProvenance: { surface: "web" },
            },
            {
              ...seed,
              id: `provenance-desktop-${viewport.name}`,
              title: "Desktop provenance fixture",
              fullTitle: "Desktop provenance fixture",
              creationProvenance: { surface: "desktop" },
            },
            {
              ...seed,
              id: `provenance-unmarked-${viewport.name}`,
              title: "Unmarked provenance fixture",
              fullTitle: "Unmarked provenance fixture",
            },
          ],
        },
      });
    });
    await page.goto(`${baseURL}/sessions?status=&created=web`);
    await expect(page.getByText("Web provenance fixture")).toBeVisible();
    await expect(page.getByText("Desktop provenance fixture")).toHaveCount(0);
    await expect(page.getByText("Unmarked provenance fixture")).toHaveCount(0);
    await page.getByRole("button", { name: "Filter by Created from" }).click();
    await expect(page.getByText("Desktop app", { exact: true })).toBeVisible();
    await expect(page.getByText("Unspecified", { exact: true })).toBeVisible();
    await recordUiCapture(
      page,
      `session-creation-provenance-${viewport.name}`,
      viewport,
    );
  });

  test(`All Sessions fans out, retains both roles, and refines cached turns on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60000);
    // Titles carry the viewport, not just the session ids. Both viewports run
    // against one server, and the previous run's entries can still be in the
    // catalog when this one searches; with a shared title the "6 matching"
    // button is satisfied by either set, so the test could select six sessions
    // whose files this file's afterEach had already deleted and then find no
    // matches at all.
    const fixture = `cached ${viewport.name}`;
    for (let i = 0; i < 6; i++)
      saveSession(`cached-${viewport.name}-${i}`, `${fixture} ${i}`, true);
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/sessions`);
    const search = page.getByRole("searchbox", { name: "Search sessions..." });
    await search.fill(`Search fixture ${fixture}`);
    await page
      .getByRole("button", { name: "Select all 6", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Only selected", exact: true })
      .click();
    const requests: Array<{
      sessionId: string;
      query: string;
      cursor?: string;
    }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the first wave so responses land after the needle and roles have
    // already changed, which is what the cached-refinement assertions below
    // exercise. Releasing also on the count, not only on four distinct
    // sessions, is what keeps this from deadlocking: the client runs four
    // concurrent acquisitions, so once four requests are held no further one
    // can arrive, and a wave that spends two slots on the same session would
    // otherwise wait for a fourth distinct id that can never come.
    await routeWithDrain(
      page,
      "**/api/sessions/content-search",
      async (route) => {
        requests.push(route.request().postDataJSON());
        const distinct = new Set(requests.map((request) => request.sessionId));
        if (distinct.size >= 4 || requests.length >= 4) release();
        await gate;
        await route.continue();
      },
    );
    try {
      await search.fill("quasarneedle");
      await page.getByRole("checkbox", { name: /^User/ }).check();
      await page.getByRole("checkbox", { name: /^Ass\./ }).check();
      const limit = page.getByRole("textbox", {
        name: "Turns/session",
        exact: true,
      });
      await limit.fill("1");
      const rows = page.locator("[data-session-list-item--card]");
      await expect(rows).toHaveCount(6, { timeout: 30000 });
      await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(
        0,
        {
          timeout: 30000,
        },
      );
      await expect(
        rows.first().getByRole("button", { name: "Match menu" }),
      ).toHaveCount(2);
      await expect(rows.first()).toContainText("User·");
      await expect(rows.first()).toContainText("Ass.·");
      const count = requests.length;
      const anchor = rows.nth(2).locator("[data-search-previews]");
      await anchor.scrollIntoViewIfNeeded();
      await anchor.evaluate((node: HTMLElement) => {
        node.addEventListener(
          "click",
          () => {
            // Playwright may scroll the limit button into view after the
            // previews root is visible. Anchor the actual disclosure click.
            node.dataset.beforeLimitTop = String(
              node.getBoundingClientRect().top,
            );
          },
          { once: true, capture: true },
        );
      });
      await rows
        .nth(2)
        .getByRole("button", {
          name: "Show one more turn per session",
          exact: true,
        })
        .click();
      const before = Number(await anchor.getAttribute("data-before-limit-top"));
      await expect(limit).toHaveValue("2");
      await expect(
        rows.first().getByRole("button", { name: "Match menu" }),
      ).toHaveCount(4);
      expect(
        Math.abs((await anchor.boundingBox())!.y - before),
      ).toBeLessThanOrEqual(3);
      await page.getByRole("checkbox", { name: /^Ass\./ }).uncheck();
      await page.getByRole("checkbox", { name: /^Ass\./ }).check();
      await search.fill(`quasarneedle ${fixture} 2`);
      await expect(rows).toHaveCount(1);
      await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(
        0,
        {
          timeout: 30000,
        },
      );
      expect(
        requests
          .slice(count)
          .filter(
            (request) => !request.cursor || request.query !== "quasarneedle",
          )
          .map(({ sessionId, query, cursor }) => ({
            sessionId,
            query,
            continuation: !!cursor,
          })),
      ).toEqual([]);
      await expect(
        rows.first().getByRole("button", { name: "Match menu" }),
      ).toHaveCount(4);
      await recordUiCapture(
        page,
        `all-sessions-cache-${viewport.name}`,
        viewport,
      );
    } finally {
      release();
    }
  });

  test(`All Sessions skips unsupported providers and places quoted diagnostics after matches on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    // Catalog discovery has reached the 30s fixture wait on CI; leave twice
    // that observed ceiling for discovery and the browser assertions.
    test.setTimeout(60_000);
    saveSession(`coverage-valid-${viewport.name}`, "coverage valid");
    saveSession(
      `coverage-error-${viewport.name}`,
      "A transcript with a malformed record",
    );
    await awaitCatalogSessions(baseURL, [
      `coverage-valid-${viewport.name}`,
      `coverage-error-${viewport.name}`,
    ]);
    const requested = new Set<string>();
    await readCollectionsOverRest(page);
    await routeWithDrain(page, /\/api\/sessions\?/, async (route) => {
      // The sidebar's starred feed uses this endpoint too. It has no seed
      // session and does not need the injected unsupported-provider row.
      if (
        new URL(route.request().url()).searchParams.get("starred") === "true"
      ) {
        return route.continue();
      }
      const response = await route.fetch();
      const data = await response.json();
      const seed = data.sessions?.find(
        (s: { id: string }) => s.id === `coverage-valid-${viewport.name}`,
      );
      if (!seed) return route.fulfill({ response });
      await route.fulfill({
        response,
        json: {
          ...data,
          sessions: [
            ...data.sessions,
            {
              ...seed,
              id: "unsupported-grok",
              provider: "grok",
              title: "quasarneedle — available through title search",
              fullTitle: "quasarneedle — available through title search",
            },
          ],
        },
      });
    });
    await routeWithDrain(
      page,
      "**/api/sessions/content-search",
      async (route) => {
        const { sessionId } = route.request().postDataJSON();
        requested.add(sessionId);
        if (sessionId === `coverage-error-${viewport.name}`) {
          return route.fulfill({
            json: {
              matches: [],
              done: true,
              partial: true,
              bytesRead: 0,
              unavailable:
                "Malformed transcript record; remaining records unavailable",
              diagnostics: [
                {
                  id: "broken.jsonl:1048577",
                  sourcePath: "/fixture/broken.jsonl",
                  byteOffset: 1048577,
                  messageId: "nearby-turn",
                  message:
                    "broken.jsonl at byte 1048577: Malformed transcript record",
                },
              ],
            },
          });
        }
        await route.continue();
      },
    );
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/sessions`);
    await page
      .getByRole("searchbox", { name: "Search sessions..." })
      .fill("quasarneedle");
    await page.getByRole("checkbox", { name: /^User/ }).check();
    const rows = page.locator("[data-session-list-item--card]");
    await expect(rows).toHaveCount(2);
    const diagnostic = page.locator("q", {
      hasText: "A transcript with a malformed record",
    });
    const coverage = page
      .locator("summary")
      .filter({ hasText: "Incomplete turn coverage" });
    await expect(coverage).toBeVisible();
    await expect(diagnostic).not.toBeVisible();
    if (viewport.name === "desktop")
      await page.setViewportSize({ width: 1200, height: 600 });
    await recordUiCapture(
      page,
      `all-sessions-defaults-${viewport.name}`,
      viewport.name === "desktop" ? { width: 1200, height: 600 } : viewport,
    );
    await page.setViewportSize(viewport);
    await coverage.click();
    await expect(diagnostic).toBeVisible();
    const location = page.getByRole("link", {
      name: "broken.jsonl",
      exact: true,
    });
    await expect(location).toHaveAttribute("href", /searchMatch=nearby-turn/);
    await coverage.click();
    await expect(diagnostic).not.toBeVisible();
    await expect(coverage).toBeVisible();
    await coverage.click();
    await expect(diagnostic).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Malformed transcript record/ }),
    ).toHaveCount(0);
    const help = page
      .locator("p:visible")
      .filter({ hasText: "count includes selections the search hides;" });
    expect((await help.boundingBox())!.y).toBeLessThan(
      (await diagnostic.boundingBox())!.y,
    );
    await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(0, {
      timeout: 30000,
    });
    expect(requested.has("unsupported-grok")).toBe(false);
    expect((await diagnostic.boundingBox())!.y).toBeGreaterThan(
      (await rows.last().boundingBox())!.y +
        (await rows.last().boundingBox())!.height,
    );
    await page.getByRole("button", { name: "0", exact: true }).click();
    const manager = page.getByRole("region", {
      name: "Selection — selected and turn-searchable sessions",
    });
    await expect(manager).toBeVisible();
    await expect(manager).not.toContainText("grok");
    expect((await manager.boundingBox())!.y).toBeGreaterThan(
      (await rows.last().boundingBox())!.y,
    );
    if (viewport.name === "desktop")
      await page.setViewportSize({ width: 1200, height: 600 });
    await expect
      .poll(async () => {
        const help = page
          .locator("p:visible")
          .filter({ hasText: "count includes selections the search hides;" });
        return help.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return box.right <= document.documentElement.clientWidth;
        });
      })
      .toBe(true);
    await recordUiCapture(
      page,
      `all-sessions-coverage-${viewport.name}`,
      viewport.name === "desktop" ? { width: 1200, height: 600 } : viewport,
    );
    await page.setViewportSize(viewport);
    await page
      .getByRole("button", { name: "Filter by Providers", exact: true })
      .click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: /^grok Title only/ }),
    ).toBeVisible();
    await recordUiCapture(
      page,
      `all-sessions-provider-support-${viewport.name}`,
      viewport,
    );
    // The session list keeps polling. Let intercepted requests finish before
    // Playwright closes the page, or a route can be fulfilled after teardown.
    await drainManagedRoutes(page);
    await page.unrouteAll({ behavior: "wait" });
  });

  test(`All Sessions expands retained matches through scanning and live updates on ${viewport.name}`, async ({
    page,
    baseURL,
    request,
  }) => {
    test.setTimeout(60000);
    const id = `expanded-${viewport.name}`;
    saveSession(id, "expanded", true);
    const file = createdFiles.at(-1)!;
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${baseURL}/api/sessions?limit=500`,
          );
          const data = await response.json();
          return (
            data.sessions?.some(
              (session: { id: string }) => session.id === id,
            ) ?? false
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    await page.setViewportSize(
      viewport.name === "desktop" ? { width: 1200, height: 600 } : viewport,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    let heldFinalRequests = 0;
    await routeWithDrain(
      page,
      "**/api/sessions/content-search",
      async (route) => {
        const input = route.request().postDataJSON();
        const ownSearch =
          input.sessionId === id &&
          input.query === "quasarneedle" &&
          input.roles?.includes("user") &&
          input.roles?.includes("assistant");
        if (ownSearch) requests++;
        const response = await route.fetch();
        const batch = await response.json();
        if (ownSearch && batch.diagnostics?.length)
          console.log(
            "expanded-search-diagnostics",
            JSON.stringify({
              id,
              done: batch.done,
              diagnostics: batch.diagnostics,
            }),
          );
        if (ownSearch && batch.done) {
          heldFinalRequests++;
          await gate;
        }
        await route.fulfill({ response });
      },
    );
    try {
      await page.goto(`${baseURL}/sessions?q=quasarneedle`);
      await page.getByRole("checkbox", { name: /^User/ }).check();
      await page.getByRole("checkbox", { name: /^Ass\./ }).check();
      await page
        .getByRole("textbox", { name: "Turns/session", exact: true })
        .fill("1");
      const row = page
        .locator("[data-session-list-item--card]")
        .filter({ hasText: "Search fixture expanded" });
      await expect(row.getByRole("button", { name: "Match menu" })).toHaveCount(
        2,
      );
      const plus = row.getByRole("button", {
        name: "Show one more turn per session",
        exact: true,
      });
      const checkbox = row.getByRole("checkbox");
      const chip = row.locator("[data-search-previews] a span").first();
      const plusRect = (await plus.boundingBox())!;
      const checkRect = (await checkbox.boundingBox())!;
      const chipRect = (await chip.boundingBox())!;
      expect(plusRect.y).toBeGreaterThanOrEqual(checkRect.y + checkRect.height);
      expect(plusRect.y + plusRect.height).toBeLessThanOrEqual(chipRect.y);
      expect(plusRect.x + plusRect.width).toBeLessThanOrEqual(
        chipRect.x + chipRect.width + 3,
      );
      await expect(
        row.getByRole("button", { name: /^Show one fewer/ }),
      ).toHaveCount(0);
      await plus.hover();
      await page.waitForTimeout(700);
      await expect(page.locator("[data-session-hovercard-id]")).toHaveCount(0);
      await expect.poll(() => heldFinalRequests).toBeGreaterThan(0);
      const before = requests;
      await row
        .getByRole("button", {
          name: "Show all retained matches in this session",
        })
        .click();
      const expanded = page.getByRole("dialog");
      await expect(expanded).toContainText("6 retained matches");
      await expect(
        expanded.getByRole("button", { name: "Match menu" }),
      ).toHaveCount(6);
      expect(requests).toBe(before);
      release();
      await expect(expanded).toContainText("10 retained matches");
      await expect(
        expanded.getByText("Search in progress", { exact: true }),
      ).toHaveCount(0);
      appendFileSync(
        file,
        `${JSON.stringify({ type: "user", uuid: "expanded-live", parentUuid: `${id}-261`, sessionId: id, cwd: join(e2ePaths.tempDir, "mockproject"), timestamp: new Date().toISOString(), message: { role: "user", content: `${"Context before the match.\n".repeat(100)}quasarneedle fresh expanded turn` } })}\n`,
      );
      await expect(expanded).toContainText("11 retained matches", {
        timeout: 30000,
      });
      const menus = expanded.getByRole("button", { name: "Match menu" });
      // Menus open in a popover outside the dialog's DOM, which may cover
      // the next row's trigger, so close one before opening another.
      await menus.first().click();
      await expect(page.getByRole("menu")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await menus.nth(3).click();
      await expect(page.getByRole("menu")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(expanded).toBeVisible();
      await expanded.locator('a[href*="searchMatch="]').last().click();
      const zoom = page.getByRole("dialog").last();
      const mark = zoom.locator("p mark").first();
      await expect(mark).toHaveText("quasarneedle");
      await expect(mark).toBeInViewport();
      const position = await mark.evaluate((element) => {
        const scroller = element.closest("[data-modal-content]")!;
        return (
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          scroller.clientHeight / 3
        );
      });
      expect(Math.abs(position)).toBeLessThan(2);
      await zoom.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await recordUiCapture(
        page,
        `all-sessions-expanded-${viewport.name}`,
        viewport.name === "desktop" ? { width: 1200, height: 600 } : viewport,
      );
      await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Match menu" })).toHaveCount(
        2,
      );
      await expect(row).not.toContainText("fresh expanded turn");
      await plus.click();
      const bothPosition = (await plus.boundingBox())!.x;
      await row.getByRole("button", { name: /^Show one fewer/ }).click();
      expect((await plus.boundingBox())!.x).toBe(bothPosition);
      await expect(
        row.getByRole("button", { name: /^Show one fewer/ }),
      ).toHaveCount(0);
      await recordUiCapture(
        page,
        `all-sessions-controls-${viewport.name}`,
        viewport.name === "desktop" ? { width: 1200, height: 600 } : viewport,
      );
      await page
        .getByRole("textbox", { name: "Turns/session", exact: true })
        .fill("20");
      await expect(
        row.getByRole("button", { name: /^Show one (more|fewer)/ }),
      ).toHaveCount(0);
    } finally {
      release();
    }
  });

  test(`All Sessions reserves arriving matches and fits long titles on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    // The inner waits below already declare 30s, which the 15s default test
    // budget cannot deliver; the siblings in this file set the same 60s.
    test.setTimeout(60000);
    const id = `reservation-${viewport.name}`;
    saveSession(
      id,
      `${"Context before ".repeat(30)}quasarneedle ${"context after ".repeat(30)}`,
    );
    await page.setViewportSize(viewport);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await routeWithDrain(
      page,
      "**/api/sessions/content-search",
      async (route) => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      },
    );
    try {
      await page.clock.install();
      await page.goto(`${baseURL}/sessions`);
      const search = page.getByRole("searchbox", {
        name: "Search sessions...",
      });
      // Catalog discovery of a just-written file is its own asynchronous step,
      // and in a full-suite run it can outlast the needle's own wait. Waiting
      // for the fixture to be listed keeps a discovery delay from being
      // reported as a search or layout failure.
      await expect(page.locator(`a[href*="${id}"]`).first()).toBeVisible({
        timeout: 30000,
      });
      await search.fill("quasarneedle");
      // An earlier viewport case can leave another matching transcript on
      // this worker. Measure the fixture this case owns after turn search too.
      const row = page.locator("[data-session-list-item--card]").filter({
        has: page.locator(`a[href*="${id}"]`),
      });
      await expect(row).toHaveCount(1, { timeout: 30000 });
      const title = row.locator("strong mark").locator("..");
      await expect(title).toHaveText(/^….*quasarneedle.*…$/);
      const narrow = await title.evaluate((node) => ({
        text: node.textContent!,
        width: node.clientWidth,
      }));
      await page.setViewportSize({ ...viewport, width: viewport.width + 100 });
      await expect
        .poll(() => title.evaluate((node) => node.clientWidth))
        .not.toBe(narrow.width);
      // A wider viewport may open the sidebar and reduce the title's space.
      // Its first changed width can precede that layout update: compare text
      // and width together, rather than freezing the transient width.
      await expect
        .poll(async () =>
          title.evaluate(
            (node, before) =>
              (node.textContent!.length - before.text.length) *
              (node.clientWidth - before.width),
            narrow,
          ),
        )
        .toBeGreaterThan(0);
      await page.setViewportSize(viewport);
      // Let title-only layout settle before enabling turn acquisition.
      await page.waitForTimeout(600);
      const request = page.waitForRequest("**/api/sessions/content-search");
      await page.getByRole("checkbox", { name: /^Ass\./ }).check();
      await request;
      // The contract reserves space until 500 ms of quiet after completion.
      // CI's locator round trips can exceed that window (run 36799408077).
      // Hold browser time while the response arrives, then resume the actual
      // settling timer; host assertion latency is not the subject.
      await page.clock.pauseAt(Date.now() + 1000);
      const reservedHeight = await row.evaluate(
        (node) => node.getBoundingClientRect().height,
      );
      release();
      await expect
        .poll(async () => {
          // Response delivery schedules scan work on the browser clock. Advance
          // in small steps until that work renders, keeping the final step well
          // inside the reservation window regardless of network latency.
          await page.clock.runFor(50);
          return row.getByRole("button", { name: "Match menu" }).count();
        })
        .toBe(1);
      expect(
        await row.evaluate((node) => node.getBoundingClientRect().height),
      ).toBe(reservedHeight);
      // Other sessions can still be acquiring when the first match mounts.
      // Resume their scheduling as well as the completion/quiet-period timer.
      await page.clock.resume();
      await expect
        .poll(() => row.evaluate((node) => node.getBoundingClientRect().height))
        .toBeLessThan(reservedHeight);
      await recordUiCapture(
        page,
        `all-sessions-fitted-title-${viewport.name}`,
        viewport,
      );
    } finally {
      release();
    }
  });

  test(`All Sessions streams matches and preserves explicit selection on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60000);
    saveSession(`search-${viewport.name}-alpha`, "alpha");
    saveSession(`search-${viewport.name}-beta`, "beta");
    await page.setViewportSize(viewport);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/sessions/content-search"))
        requests.push(request.postData() ?? "");
    });
    await page.goto(`${baseURL}/sessions`);
    const search = page.getByRole("searchbox", { name: "Search sessions..." });
    await expect(search).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Title", exact: true }),
    ).toBeChecked();
    const assistant = page.getByRole("checkbox", { name: /^Ass\./ });
    await expect(assistant).not.toBeChecked();
    if (viewport.name === "desktop") await expect(search).toBeFocused();
    else await expect(search).not.toBeFocused();
    const title = page.getByRole("checkbox", { name: "Title", exact: true });
    const user = page.getByRole("checkbox", { name: /^User/ });
    await search.press("Control+r");
    await assistant.check();
    await user.uncheck();
    await expect(title).not.toBeChecked();
    await assistant.uncheck();
    await expect(title).toBeChecked();
    await search.press("Control+r");
    await user.uncheck();
    await expect(title).toBeChecked();
    await search.fill("quasarneedle");
    await expect(
      page.getByText("No sessions found", { exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(0);
    const rows = page.locator("[data-session-list-item--card]");
    await search.press("Control+r");
    await expect(page.getByRole("checkbox", { name: /^User/ })).toBeChecked();
    await expect(assistant).not.toBeChecked();
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await rows.first().getByRole("button", { name: "Match menu" }).click();
    await page
      .getByRole("menuitem", { name: "Zoom preview", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("original request");
    await expect(page.getByRole("dialog")).toContainText("matching answer");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await search.press("Control+s");
    await expect(assistant).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Title", exact: true }),
    ).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Title", exact: true }).check();
    await expect(
      page.getByRole("checkbox", { name: /^User/ }),
    ).not.toBeChecked();
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator('[data-search-scanning="true"]')).toHaveCount(0, {
      timeout: 30000,
    });
    expect(requests.length).toBeGreaterThan(2);
    await page
      .getByRole("button", { name: "Select all 2", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Only selected", exact: true })
      .click();
    await search.fill("quasarneedle alpha");
    await expect(rows).toHaveCount(1, { timeout: 30000 });
    await expect(
      page.getByRole("button", { name: "Clear 2 selected", exact: true }),
    ).toBeVisible();
    // Narrow by clearing, then selecting what is shown; Only selected stays on.
    await page
      .getByRole("button", { name: "Clear 2 selected", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select all 1", exact: true })
      .click();
    await search.fill("matching answer");
    await expect(rows).toHaveCount(1, { timeout: 30000 });
    await expect(rows.first()).toContainText("alpha");
    await expect(page.locator("[data-search-scope]")).toHaveText(
      "in 1 sessions",
    );
    await search.fill("beta");
    await expect(rows).toHaveCount(0, { timeout: 30000 });
    await expect(
      page.getByRole("button", { name: "Clear 1 selected", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear 1 selected", exact: true })
      .click();
    await search.fill("quasarneedle");
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await page
      .getByRole("button", { name: "Select all 2", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Filter: Unarchived", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // Actions live in the selection bar, offering only what applies.
    await expect(
      page.getByRole("button", { name: "Archive", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Unarchive", exact: true }),
    ).toHaveCount(0);
    const from = page.getByRole("textbox", { name: /^Minimum age/ });
    const initialWidth = await from.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await from.fill("12345h");
    expect(
      await from.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(initialWidth);
    await from.fill("");
    expect(
      await from.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(initialWidth);
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await recordUiCapture(
      page,
      `all-sessions-search-${viewport.name}`,
      viewport,
    );
    await search.fill("Search fixture");
    await expect(rows.first().locator("strong mark")).toBeVisible();
    await expect(rows.getByText("Title", { exact: true })).toHaveCount(0);
    await recordUiCapture(
      page,
      `all-sessions-title-${viewport.name}`,
      viewport,
    );
    await search.fill("quasarneedle");
    await expect(
      rows.first().getByRole("button", { name: "Match menu" }).first(),
    ).toBeVisible();
    await rows.first().getByRole("button", { name: "Match menu" }).click();
    await page
      .getByRole("menuitem", { name: "Zoom preview", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("matching answer");
    await expect(page.getByRole("dialog")).toContainText("original request");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const target = rows.first().locator('a[href*="searchMatch="]').last();
    await target.click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: "Open turn in session" })
      .click();
    await expect(page).toHaveURL(/searchMatch=/);
    await expect(
      page
        .locator("[data-render-id]")
        .filter({ hasText: "matching answer" })
        .first(),
    ).toBeVisible();
    await page.goBack();
    await expect(search).toHaveValue("quasarneedle");
    await expect(assistant).toBeChecked();
    await expect(
      page.getByRole("button", { name: "Clear 2 selected", exact: true }),
    ).toBeVisible();
  });
}
