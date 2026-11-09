import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  json,
  liveUpdate,
  openSessionPage,
  projectId,
  sessionId,
  typeEachKeyWithin100ms,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page header, its actions, the project move menu and
 * the header's pop-ups do today, before
 * docs/tactical/182-session-page-header-and-footer.md moves them out of
 * SessionPage.tsx. Writes are answered here so the shared fixture session
 * keeps its metadata; each case checks the request, the toast and the
 * header.
 */

test.use({ serviceWorkers: "block", viewport: { width: 1600, height: 900 } });

const metadataPath = `/sessions/${sessionId}/metadata`;
const abortPath = "/processes/pin-process/abort";
const reactivatePath = `/projects/${projectId}/sessions/${sessionId}/reactivate`;
const movePath = `/projects/${projectId}/sessions/${sessionId}/project`;
const saved = (route: Parameters<typeof json>[0]) =>
  json(route, 200, { updated: true });
const refused = (route: Parameters<typeof json>[0]) =>
  json(route, 500, { error: "Refused by pin" });

async function menuItem(page: Page, name: string) {
  await page
    .locator(".session-header")
    .getByRole("button", { name: "Session options" })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("Archive and Unarchive send the flag, toast and show the badge", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, saved);
  const badge = session.header.locator(".archived-badge");
  await expect(badge).toHaveCount(0);

  await menuItem(page, "Archive");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ archived: true });
  await expect(session.toast("Session archived")).toBeVisible();
  await expect(badge).toHaveText("Archived");

  await menuItem(page, "Unarchive");
  await expect.poll(() => session.calls.length).toBe(2);
  expect(session.calls[1]?.body).toEqual({ archived: false });
  await expect(session.toast("Session unarchived")).toBeVisible();
  await expect(badge).toHaveCount(0);
});

test("a failed archive says so and shows no badge", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer("PUT", metadataPath, refused);
  await menuItem(page, "Archive");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  await expect(session.toast("Failed to update archive status")).toBeVisible();
  await expect(session.header.locator(".archived-badge")).toHaveCount(0);
});

test("Star sends the flag, toasts and marks the title; a failure says so", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  let fail = true;
  await session.answer("PUT", metadataPath, (route) =>
    fail ? refused(route) : saved(route),
  );
  const mark = session.header.getByRole("img", { name: "Starred" });

  await menuItem(page, "Star");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ starred: true });
  await expect(session.toast("Failed to update star status")).toBeVisible();
  await expect(mark).toHaveCount(0);

  fail = false;
  await menuItem(page, "Star");
  await expect.poll(() => session.calls.length).toBe(2);
  expect(session.calls[1]?.body).toEqual({ starred: true });
  await expect(session.toast("Session starred")).toBeVisible();
  await expect(mark).toBeVisible();
});

test("Suggestions turns on; a failure puts the menu label back", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  let fail = false;
  await session.answer("PUT", metadataPath, (route) =>
    fail ? refused(route) : saved(route),
  );

  await menuItem(page, "Suggestions: Off");
  await expect.poll(session.requests).toEqual([`PUT ${metadataPath}`]);
  expect(session.calls[0]?.body).toEqual({ promptSuggestionMode: "native" });
  await expect(session.toast("Suggestions enabled")).toBeVisible();

  fail = true;
  await menuItem(page, "Suggestions: On");
  await expect.poll(() => session.calls.length).toBe(2);
  expect(session.calls[1]?.body).toEqual({ promptSuggestionMode: "off" });
  await expect(session.toast("Failed to update suggestions")).toBeVisible();
  await session.header.getByRole("button", { name: "Session options" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Suggestions: On", exact: true }),
  ).toBeVisible();
});

test("Terminate aborts the process and blocks resume; a failure says why", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  let fail = true;
  await session.answer("POST", abortPath, (route) =>
    fail
      ? json(route, 500, { error: "Abort refused by pin" })
      : json(route, 200, { success: true }),
  );

  await menuItem(page, "Terminate");
  await expect.poll(session.requests).toEqual([`POST ${abortPath}`]);
  expect(session.calls[0]?.body).toEqual({ blockResume: true });
  await expect(session.toast("Failed to terminate")).toBeVisible();

  fail = false;
  await menuItem(page, "Terminate");
  await expect.poll(() => session.calls.length).toBe(2);
  await expect(session.toast("Session terminated")).toBeVisible();
});

test("Restart provider aborts, reactivates and reloads; a failure says why", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  await session.answer("POST", abortPath, (route) =>
    json(route, 200, { success: true }),
  );
  let fail = true;
  await session.answer("POST", reactivatePath, (route) =>
    fail
      ? json(route, 500, { error: "Reactivate refused by pin" })
      : json(route, 200, {
          processId: "pin-process",
          permissionMode: "default",
        }),
  );

  await menuItem(page, "Restart provider");
  await expect
    .poll(session.requests)
    .toEqual([`POST ${abortPath}`, `POST ${reactivatePath}`]);
  expect(session.calls[0]?.body).toBeUndefined();
  await expect(session.toast("Could not restart provider")).toBeVisible();

  fail = false;
  session.setOwner("pin-process", "idle");
  // Restoring ownership needs the next read; reload to get the menu item.
  await page.reload();
  await expect(session.composer).toBeVisible({ timeout: 30_000 });
  const reloaded = page.waitForEvent("load");
  await menuItem(page, "Restart provider");
  await reloaded;
  expect(session.requests().slice(2)).toEqual([
    `POST ${abortPath}`,
    `POST ${reactivatePath}`,
  ]);
});

test("the breadcrumb's move menu lists other projects and moves the session", async ({
  page,
  baseURL,
}) => {
  await page.route(
    (url) => url.pathname === "/api/projects",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      const extra = [
        { name: "Zulu pin project", id: "zulu-pin" },
        { name: "Alpha pin project", id: "alpha-pin" },
      ].map(({ name, id }) => ({
        ...body.projects[0],
        id,
        name,
        path: `/tmp/${id}`,
      }));
      await route.fulfill({
        response,
        json: { ...body, projects: [...body.projects, ...extra] },
      });
    },
  );
  // Arrive with a search and router state of its own, so the move can be
  // checked to carry both over.
  const path = `/projects/${projectId}/sessions/${sessionId}`;
  await page.addInitScript((sessionPath) => {
    if (window.location.pathname === sessionPath && !history.state?.usr)
      history.replaceState(
        { usr: { pinSeed: "kept" }, key: "pinseed", idx: 0 },
        "",
      );
    // Record each replace: the session reads still name the fixture's
    // project, so the canonical-project redirect moves the URL back after.
    // The move's own replace runs inside its handler while the menu is
    // still open; route sync's replace runs after the menu has closed.
    const replaces: { url: string; seed: unknown; menuOpen: boolean }[] = [];
    (window as unknown as { pinReplaces: typeof replaces }).pinReplaces =
      replaces;
    const replace = history.replaceState.bind(history);
    history.replaceState = (state, unused, url) => {
      replaces.push({
        url: String(url ?? ""),
        seed: state?.usr?.pinSeed,
        menuOpen: !!document.querySelector(
          '[role="menu"][aria-label="Move session to project"]',
        ),
      });
      replace(state, unused, url);
    };
  }, path);
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    arrive: (page) => page.goto(`${baseURL}${path}?pin=1`),
  });
  let fail = true;
  await session.answer("PUT", movePath, (route) =>
    fail
      ? refused(route)
      : json(route, 200, {
          projectId: "alpha-pin",
          transcriptProjectId: projectId,
        }),
  );
  const breadcrumb = session.header.locator(".project-breadcrumb");
  await expect(breadcrumb).toHaveAttribute(
    "href",
    `/sessions?project=${projectId}`,
  );
  const menu = page.getByRole("menu", { name: "Move session to project" });

  await breadcrumb.click({ button: "right" });
  await expect(menu).toBeVisible();
  // Each item reads its project name, then its path.
  const items = await menu.getByRole("menuitem").allTextContents();
  const at = (name: string) => items.findIndex((text) => text.startsWith(name));
  expect(at("Alpha pin project")).toBeGreaterThanOrEqual(0);
  expect(at("Alpha pin project")).toBeLessThan(at("Zulu pin project"));
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await breadcrumb.click({ button: "right" });
  await expect(menu).toBeVisible();
  await session.composer.click();
  await expect(menu).toHaveCount(0);

  await breadcrumb.click({ button: "right" });
  await menu.getByRole("menuitem", { name: /Alpha pin project/ }).click();
  await expect.poll(session.requests).toEqual([`PUT ${movePath}`]);
  expect(session.calls[0]?.body).toEqual({ projectId: "alpha-pin" });
  await expect(session.toast("Failed to move session")).toBeVisible();
  await expect(menu).toBeVisible();

  fail = false;
  const before = await page.evaluate(() => history.length);
  await menu.getByRole("menuitem", { name: /Alpha pin project/ }).click();
  await expect(
    session.toast("Moved session to Alpha pin project"),
  ).toBeVisible();
  await expect(menu).toHaveCount(0);
  const replaces = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            pinReplaces: { url: string; seed: unknown; menuOpen: boolean }[];
          }
        ).pinReplaces,
    );
  await expect.poll(replaces).toContainEqual({
    url: `/projects/alpha-pin/sessions/${sessionId}?pin=1`,
    seed: "kept",
    menuOpen: true,
  });
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("the model badge opens the Model tab, a right click and Session info the Info tab", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  const badge = session.header.locator(".provider-badge-button");
  const dialog = page.getByRole("dialog");
  const tab = (name: string) => dialog.getByRole("tab", { name, exact: true });

  // The tooltip layer moves `title` into `data-tooltip`.
  await expect(badge).toHaveAttribute(
    "data-tooltip",
    "Configure model, thinking, and effort",
  );
  await badge.click();
  await expect(tab("Model")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await badge.click({ button: "right" });
  await expect(tab("Session Info")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await menuItem(page, "Session info");
  await expect(tab("Session Info")).toHaveAttribute("aria-selected", "true");
});

test("Recaps opens the recap settings and saving them toasts", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  await session.answer("GET", "/processes/pin-process/recap-config", (route) =>
    json(route, 200, {
      processId: "pin-process",
      recapMode: "off",
      recapAfterSeconds: 300,
      helperSideModel: "cheapest",
      supportedModes: ["off", "native", "fork", "side-session"],
    }),
  );
  await session.answer("POST", "/processes/pin-process/recap-config", (route) =>
    json(route, 200, {
      success: true,
      processId: "pin-process",
      recapMode: "off",
      recapAfterSeconds: 300,
      helperSideModel: "cheapest",
    }),
  );

  await menuItem(page, "Recaps...");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Session Recaps")).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(session.requests)
    .toContain("POST /processes/pin-process/recap-config");
  await expect(session.toast("Session recap settings updated")).toBeVisible();
});

test("Project settings opens the project's defaults", async ({
  page,
  baseURL,
}) => {
  await openSessionPage(page, baseURL, { owner: "none" });
  await menuItem(page, "Project settings");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("mockproject Settings")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("Handoff opens the handoff pop-up; starting it toasts and opens the new session", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  await session.answer(
    "POST",
    `/projects/${projectId}/sessions/${sessionId}/restart`,
    (route) =>
      json(route, 200, {
        sessionId: "pin-handoff-session",
        processId: "pin-handoff-process",
        projectId,
        permissionMode: "default",
        modeVersion: 1,
        title: "Handoff pin",
      }),
  );

  await menuItem(page, "Handoff");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Handoff Session")).toBeVisible();
  await dialog.getByRole("button", { name: "Start handoff" }).click();
  await expect(session.toast("Handoff session started")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/sessions/pin-handoff-session$`),
  );
});

test("the title and chevron toggle recent sessions, and the session menu closes them", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "none" });
  const title = session.header.locator(".session-title-recent-trigger");
  const chevron = session.header.locator(".session-title-chevron-trigger");
  const dropdown = page.getByRole("dialog", { name: "Recent sessions" });

  await expect(dropdown).toHaveCount(0);
  await expect(title).toHaveAttribute("aria-haspopup", "dialog");
  await expect(chevron).toHaveAttribute("aria-haspopup", "dialog");
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await expect(chevron).toHaveAttribute("aria-label", "Close recent sessions");
  await expect(dropdown).toBeVisible();
  await chevron.click();
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveAttribute("aria-label", "Recent sessions");
  await expect(dropdown).toHaveCount(0);

  await chevron.click();
  await expect(dropdown).toBeVisible();
  await session.header.getByRole("button", { name: "Session options" }).click();
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await expect(dropdown).toHaveCount(0);
});

test("Clear opens a new session for the project and provider", async ({
  page,
  baseURL,
}) => {
  await openSessionPage(page, baseURL, { owner: "none" });
  await menuItem(page, "Clear (new session)");
  await expect(page).toHaveURL(/\/new-session\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get("projectId")).toBe(projectId);
  expect(params.get("provider")).toBe("claude");
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the header's sidebar button opens the sidebar", async ({
    page,
    baseURL,
  }) => {
    const session = await openSessionPage(page, baseURL, { owner: "none" });
    const opener = session.header.getByRole("button", {
      name: "Open sidebar",
      exact: true,
    });
    await opener.click();
    await expect(
      page.locator(".sidebar.open, .sidebar-overlay"),
    ).not.toHaveCount(0);
  });
});

// The retitle field holds page state, so each key re-renders the page; the
// rename editor's own typing is pinned by session-header-responsive.
test("keys typed into the retitle field each show within 100 ms during live updates", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, { owner: "self" });
  const retitlePath = `/projects/${projectId}/sessions/${sessionId}/retitle`;
  await session.answer("POST", retitlePath, (route) =>
    json(route, 500, { error: "Retitle refused by pin" }),
  );
  await session.answer("PUT", metadataPath, saved);
  await menuItem(page, "Generate Title (uses tokens)");
  const field = session.header.locator("input.session-title-input");
  await expect(field).toBeEditable();
  await field.fill("");
  await typeEachKeyWithin100ms(field, "parser notes", (typed) =>
    session.emit("message", liveUpdate(typed.length)),
  );
  await expect(
    page.locator(".message-list").getByText("Live update 11.", { exact: true }),
  ).toBeVisible();
  await field.press("Control+Enter");
  await expect
    .poll(session.requests)
    .toEqual([`POST ${retitlePath}`, `PUT ${metadataPath}`]);
  expect(session.calls[1]?.body).toEqual({ title: "parser notes" });
});

test("a routed session's account chip opens the Info tab", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    session: {
      routerBinding: {
        id: "pin-binding",
        routerId: "pin-router",
        accountId: "pin-account",
        accountDisplayName: "Pin account",
        poolName: "Pin pool",
        provider: "claude",
      },
    },
  });
  const chip = session.header.getByRole("button", {
    name: /Pin account/,
  });
  await expect(chip).toHaveText("Pin pool · Pin account");
  await chip.click();
  await expect(
    page.getByRole("dialog").getByRole("tab", { name: "Session Info" }),
  ).toHaveAttribute("aria-selected", "true");
});
