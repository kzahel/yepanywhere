import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  agentReply,
  openSessionPage,
  projectId,
  sessionId,
  userTurn,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page does on arrival and with its URL today, before
 * docs/tactical/181-session-page-feature-hooks.md moves it out of
 * SessionPage.tsx into hooks: navigation-state actions from the Bang history
 * page (with keys typed before the session loads), go-to-turn from the recall
 * drawer, and the URL replacements for a canonical project, a native id and
 * a temporary id.
 */

test.use({ serviceWorkers: "block", viewport: { width: 1200, height: 800 } });

const composerSelector = `[data-composer-input][data-draft-key="draft-message-${sessionId}"]`;

/** Enough turns that the earliest ones sit far above the opening scroll. */
const longTranscript = Array.from({ length: 30 }, (_, index) => {
  const reply = Array.from(
    { length: 6 },
    (_, line) => `Reply ${index + 1}, paragraph ${line + 1}.`,
  ).join("\n\n");
  return [
    userTurn(
      `turn-${index + 1}`,
      `Request number ${index + 1}`,
      index * 2,
      index ? `reply-${index}` : null,
    ),
    agentReply(`reply-${index + 1}`, reply, index * 2 + 1, `turn-${index + 1}`),
  ];
}).flat();
const lastReplyText = "Reply 30, paragraph 6.";

const bangObject = {
  id: "pin-bang",
  kind: "bang-command",
  createdAt: new Date().toISOString(),
  placementAfterMessageId: "1",
  command: "ls -la",
  cwd: join(e2ePaths.tempDir, "mockproject"),
  status: "done",
  exitCode: 0,
  durationMs: 12,
  stdoutPreview: "pin-bang-output.txt",
};

async function routeBangHistory(page: Page, object: object = bangObject) {
  await page.route("**/api/bang-commands", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: { entries: [{ sessionId, projectId, object }] },
        })
      : route.fallback(),
  );
}

/**
 * Records, per frame, when the session's transcript has loaded and when the
 * composer first holds the expected text, so a case can bound the gap. The
 * composer is already visible while the session loads; keys typed then are
 * held until the transcript arrives.
 */
async function probeComposer(page: Page) {
  await page.addInitScript((selector) => {
    const probe: { loaded?: number; matched?: number; expect?: string } = {};
    (window as unknown as { pinProbe: typeof probe }).pinProbe = probe;
    const tick = () => {
      const transcript = document.querySelector("[data-message-list]");
      if (transcript?.textContent?.includes("Previous message"))
        probe.loaded ??= performance.now();
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      if (probe.expect !== undefined && input?.value === probe.expect)
        probe.matched ??= performance.now();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, composerSelector);
}

const probeResult = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { pinProbe: { loaded?: number; matched?: number } })
        .pinProbe,
  );

/**
 * Opens the Bang history page, takes one entry action, and types while the
 * session it opens is still loading.
 */
async function arriveFromBangHistory(
  page: Page,
  baseURL: string,
  action: string,
  typed: string,
  expected: string,
  release: () => void,
) {
  await page.goto(`${baseURL}/bang-commands`);
  await page.getByRole("button", { name: action }).click();
  await expect(page.locator(".session-title-skeleton")).toBeVisible();
  await page.evaluate((text) => {
    (window as unknown as { pinProbe: { expect?: string } }).pinProbe.expect =
      text;
  }, expected);
  await page.keyboard.type(typed, { delay: 20 });
  release();
}

test("Edit from Bang history prefills the composer ahead of keys typed while loading, then clears the action from history", async ({
  page,
  baseURL,
}) => {
  await routeBangHistory(page);
  await probeComposer(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    holdSessionRead: held,
    arrive: (page) =>
      arriveFromBangHistory(
        page,
        baseURL,
        "Edit / re-issue command",
        " | wc",
        "!!ls -la | wc",
        release,
      ),
  });

  await expect(session.composer).toHaveValue("!!ls -la | wc");
  await expect(session.composer).toBeFocused();
  const probe = await probeResult(page);
  // Held keys land within 100 ms of the session loading.
  expect(
    (probe.matched ?? Number.POSITIVE_INFINITY) - (probe.loaded ?? 0),
  ).toBeLessThan(100);
  await expect
    .poll(() => page.evaluate(() => history.state?.usr ?? {}))
    .not.toHaveProperty("composerPrefill");
});

test("New from Bang history focuses the composer and keeps keys typed while loading", async ({
  page,
  baseURL,
}) => {
  await routeBangHistory(page);
  await probeComposer(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    holdSessionRead: held,
    arrive: (page) =>
      arriveFromBangHistory(
        page,
        baseURL,
        "New command in session",
        "!!pwd",
        "!!pwd",
        release,
      ),
  });

  await expect(session.composer).toHaveValue("!!pwd");
  await expect(session.composer).toBeFocused();
  const probe = await probeResult(page);
  // Held keys land within 100 ms of the session loading.
  expect(
    (probe.matched ?? Number.POSITIVE_INFINITY) - (probe.loaded ?? 0),
  ).toBeLessThan(100);
  await expect
    .poll(() => page.evaluate(() => history.state?.usr ?? {}))
    .not.toHaveProperty("focusComposer");
});

// The block sits after an early turn of a long transcript, so the page
// opens at the bottom and only the jump brings the block into view.
test("Jump from Bang history scrolls to the command's row and clears the request from history", async ({
  page,
  baseURL,
}) => {
  const earlyBang = { ...bangObject, placementAfterMessageId: "reply-3" };
  await routeBangHistory(page, earlyBang);
  await openSessionPage(page, baseURL, {
    owner: "none",
    messages: longTranscript,
    session: { transcriptDisplayObjects: [earlyBang] },
    ready: "Request number 2",
    arrive: async (page) => {
      await page.goto(`${baseURL}/bang-commands`);
      await page
        .getByRole("button", { name: "Jump to command in session" })
        .click();
    },
  });
  await expect(page.locator('[data-render-id="pin-bang"]')).toBeInViewport();
  await expect(
    page.locator('[data-render-id="reply-30"]'),
  ).not.toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => history.state?.usr ?? {}))
    .not.toHaveProperty("scrollToRenderId");
});

test("Go to this turn in the recall drawer scrolls to that turn", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: longTranscript,
    ready: lastReplyText,
  });
  const target = page.locator('[data-render-id="turn-24"]');
  await expect(target).not.toBeInViewport();
  await session.composer.press("Control+ArrowUp");
  await page
    .locator(".composer-recall-row")
    .filter({ hasText: "Request number 24" })
    .getByRole("button", { name: "Go to this turn" })
    .click();

  await expect(target).toBeInViewport();
  await expect(session.composer).toHaveValue("");
});

/** Holds the session read so the page's history can be measured first. */
async function openMeasuringHistory(
  page: Page,
  baseURL: string,
  options: Omit<Parameters<typeof openSessionPage>[2], "arrive">,
) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let historyLength = 0;
  // The page arrives with router state of its own, so each replace can be
  // checked to carry it over.
  const path = `/projects/${projectId}/sessions/${sessionId}`;
  await page.addInitScript((sessionPath) => {
    if (window.location.pathname === sessionPath && !history.state?.usr) {
      history.replaceState(
        { usr: { pinSeed: "kept" }, key: "pinseed", idx: 0 },
        "",
      );
    }
  }, path);
  const session = await openSessionPage(page, baseURL, {
    ...options,
    holdSessionRead: held,
    arrive: async (page) => {
      await page.goto(`${baseURL}${path}`);
      historyLength = await page.evaluate(() => history.length);
      release();
    },
  });
  return { session, historyLength };
}

/** The router state the page arrived with, after a replace. */
const keptState = (page: Page) =>
  page.evaluate(() => history.state?.usr?.pinSeed ?? null);

test("opening records the visit, and a session in another project replaces the URL with that project", async ({
  page,
  baseURL,
}) => {
  const visits: unknown[] = [];
  await page.route("**/api/recents/visit", (route) => {
    visits.push(route.request().postDataJSON());
    return route.fulfill({ json: { recorded: true } });
  });
  const canonicalProjectId = Buffer.from(
    join(e2ePaths.tempDir, "idle-queue-project"),
  ).toString("base64url");
  const { historyLength } = await openMeasuringHistory(page, baseURL, {
    owner: "none",
    session: { projectId: canonicalProjectId },
  });

  await expect(page).toHaveURL(
    new RegExp(`/projects/${canonicalProjectId}/sessions/${sessionId}$`),
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await keptState(page)).toBe("kept");
  await expect
    .poll(() => visits)
    .toEqual([
      { sessionId, projectId },
      { sessionId, projectId: canonicalProjectId },
    ]);
});

test("a native id with its family becomes the URL path, keeping the page", async ({
  page,
  baseURL,
}) => {
  const { historyLength } = await openMeasuringHistory(page, baseURL, {
    owner: "none",
    session: {
      nativeSessionId: "pin-native-thread",
      nativeSessionFamily: "codex",
    },
  });

  await expect(page).toHaveURL(
    (url) =>
      url.pathname ===
        `/projects/${projectId}/sessions/codex/pin-native-thread` &&
      url.search === "",
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await keptState(page)).toBe("kept");
});

test("an older server's native id without a family keeps the YA id query", async ({
  page,
  baseURL,
}) => {
  const { historyLength } = await openMeasuringHistory(page, baseURL, {
    owner: "none",
    // The detail is the real server's, so drop the family it now sends.
    session: {
      nativeSessionId: "pin-native-thread",
      nativeSessionFamily: undefined,
    },
  });

  await expect(page).toHaveURL(
    (url) =>
      url.pathname === `/projects/${projectId}/sessions/pin-native-thread` &&
      url.searchParams.get("yaSessionId") === sessionId,
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await keptState(page)).toBe("kept");
});

test("a stream that replaces the temporary id moves the URL to the real id in place", async ({
  page,
  baseURL,
}) => {
  const { session, historyLength } = await openMeasuringHistory(page, baseURL, {
    owner: "self",
  });
  session.emit("session-id-changed", {
    oldSessionId: sessionId,
    newSessionId: "pin-real-id",
  });

  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/sessions/pin-real-id$`),
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await keptState(page)).toBe("kept");
});
