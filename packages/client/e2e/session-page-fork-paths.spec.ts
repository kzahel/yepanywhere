import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  agentReply,
  json,
  openSessionPage,
  projectId,
  sessionId,
  twoTurns,
} from "./support/session-page-harness.js";

/**
 * Pins what the session page's fork, clone, copy and handoff actions do
 * today, before docs/tactical/181-session-page-feature-hooks.md moves them
 * out of SessionPage.tsx into hooks. Each case routes the session and the
 * endpoints the action calls, then checks the exact request, the toast and
 * where the page ends up.
 */

test.use({ serviceWorkers: "block", viewport: { width: 1200, height: 800 } });

const forkPath = `/projects/${projectId}/sessions/${sessionId}/fork`;
const forked = (newSessionId: string, forkKind: string) => ({
  sessionId: newSessionId,
  projectId,
  provider: "claude",
  forkedFrom: sessionId,
  forkKind,
});

async function openForkMenu(page: Page, turnText: string) {
  const row = page
    .locator("[data-message-list] [data-render-id]")
    .filter({ hasText: turnText });
  await row.hover();
  await row.getByRole("button", { name: /^Fork from this turn/ }).click();
}

test("Clone from the session menu forks the latest complete turn and opens it", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", forkPath, (route) =>
    json(route, 200, forked("pin-clone", "clone-latest-complete")),
  );
  await session.header.getByRole("button", { name: "Session options" }).click();
  await page.getByRole("menuitem", { name: "Clone", exact: true }).click();

  await expect.poll(session.requests).toEqual([`POST ${forkPath}`]);
  const body = session.calls[0]?.body as Record<string, unknown>;
  expect(body).toMatchObject({
    forkKind: "clone-latest-complete",
    creationProvenance: {
      surface: "web",
      clientOrigin: new URL(baseURL).origin,
    },
  });
  expect(body).not.toHaveProperty("sourceMessageId");
  await expect(session.toast("Cloned session created")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/sessions/pin-clone$`),
  );
});

test("a failed Clone shows the server's error and stays on the session", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", forkPath, (route) =>
    json(route, 500, { error: "Transcript is locked for cloning" }),
  );
  await session.header.getByRole("button", { name: "Session options" }).click();
  await page.getByRole("menuitem", { name: "Clone", exact: true }).click();

  await expect(session.toast("Transcript is locked for cloning")).toBeVisible();
  expect(session.requests()).toEqual([`POST ${forkPath}`]);
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
});

test("Fork before a later turn forks before that turn and opens the fork", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", forkPath, (route) =>
    json(route, 200, forked("pin-fork-before", "before-user-turn")),
  );
  await openForkMenu(page, "Second request about the lexer");
  await page.getByRole("menuitem", { name: "Before this turn" }).click();

  await expect.poll(session.requests).toEqual([`POST ${forkPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    forkKind: "before-user-turn",
    sourceMessageId: "turn-2",
    creationProvenance: { surface: "web" },
  });
  await expect(session.toast("Forked session created")).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/pin-fork-before$/);
});

test("Fork after the first turn forks after it and opens the fork", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", forkPath, (route) =>
    json(route, 200, forked("pin-fork-after", "after-user-turn")),
  );
  await openForkMenu(page, "First request about the parser");
  // The first turn has nothing before it to fork from.
  await expect(
    page.getByRole("menuitem", { name: "Before this turn" }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "After this turn", exact: true })
    .click();

  await expect.poll(session.requests).toEqual([`POST ${forkPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    forkKind: "after-user-turn",
    sourceMessageId: "turn-1",
  });
  await expect(session.toast("Forked session created")).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/pin-fork-after$/);
});

const summaryPath = `/projects/${projectId}/sessions/${sessionId}/fork-summary`;
const generating = {
  id: "pin-fork-summary",
  kind: "fork-summary",
  createdAt: new Date().toISOString(),
  placementAfterMessageId: "reply-1",
  sourceMessageId: "turn-1",
  retainedThroughMessageId: "reply-1",
  status: "generating",
};

async function startForkAfterSummary(page: Page) {
  await openForkMenu(page, "First request about the parser");
  await page.getByRole("menuitem", { name: "After with summary…" }).click();
}

test("Fork with summary posts the instructions, shows progress, and cancels from the transcript", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", summaryPath, (route) =>
    json(route, 200, { displayObject: generating }),
  );
  const cancelPath = `${summaryPath}/${generating.id}/cancel`;
  await session.answer("POST", cancelPath, (route) =>
    json(route, 200, {
      transcriptDisplayObjects: [
        { ...generating, status: "error", error: "Cancelled by pin" },
      ],
    }),
  );
  await startForkAfterSummary(page);
  await expect(page.getByText("Fork after selected turn")).toBeVisible();
  await session.composer.fill("Keep the parser notes");
  await page.getByRole("button", { name: "Fork with summary" }).click();

  await expect.poll(session.requests).toEqual([`POST ${summaryPath}`]);
  expect(session.calls[0]?.body).toEqual({
    sourceMessageId: "turn-1",
    instructions: "Keep the parser notes",
    mode: "default",
    autoOpenWhenReady: false,
  });
  await expect(session.toast("Forking in the background…")).toBeVisible();
  await expect(session.composer).toHaveValue("");
  await expect(page.getByText("Fork after selected turn")).toHaveCount(0);
  const progress = page.locator(".fork-summary-display-object-generating");
  await expect(progress).toContainText("Forking…");

  await progress.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(session.requests)
    .toEqual([`POST ${summaryPath}`, `POST ${cancelPath}`]);
  await expect(progress).toHaveCount(0);
  await expect(
    page.getByText("Failed to fork with summary: Cancelled by pin"),
  ).toBeVisible();
});

test("the fork shortcut opens the fork composer; without summary it forks, queues the next turn on the fork, and opens it", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", forkPath, (route) =>
    json(route, 200, forked("pin-fork-next", "after-user-turn")),
  );
  await session.answer("POST", "/sessions/pin-fork-next/messages", (route) =>
    json(route, 200, { queued: true, serverTimestamp: Date.now() }),
  );
  await session.forksOffered();
  // The composer's fork shortcut on an empty draft opens the fork composer
  // after the first turn.
  await session.composer.press("Control+Alt+Enter");
  await expect(page.getByText("Fork after selected turn")).toBeVisible();
  expect(session.requests()).toEqual([]);
  await session.composer.fill("Continue with the lexer");
  await session.composer.press("Control+Enter");

  await expect
    .poll(session.requests)
    .toEqual([`POST ${forkPath}`, "POST /sessions/pin-fork-next/messages"]);
  expect(session.calls[0]?.body).toMatchObject({
    forkKind: "after-user-turn",
    sourceMessageId: "turn-1",
    creationProvenance: { surface: "web" },
  });
  expect(session.calls[1]?.body).toMatchObject({
    message: "Continue with the lexer",
    mode: "default",
  });
  await expect(session.toast("Forked session created")).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/pin-fork-next$/);
});

test("a staged attachment refuses Fork with summary before the fork composer opens", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await page
    .locator(".message-input-wrapper input[type=file]")
    .first()
    .setInputFiles({
      name: "pin-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("notes for the fork"),
    });
  await expect(page.getByText("pin-notes.txt").first()).toBeVisible();
  await startForkAfterSummary(page);

  await expect(
    session.toast("Fork summary instructions cannot include attachments."),
  ).toBeVisible();
  await expect(page.getByText("Fork after selected turn")).toHaveCount(0);
  expect(session.requests()).toEqual([]);
});

/** Reveals the turn rail at the transcript's right edge and opens a notch's menu. */
async function openTurnNotchMenu(page: Page, preview: string) {
  const box = await page.locator("[data-session-messages]").boundingBox();
  if (!box) throw new Error("Transcript scroll area is not laid out");
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
  // The turn's "load from here" dot sits over its notch and opens the same
  // menu.
  await page
    .getByRole("button", {
      name: `Load client transcript from turn: ${preview}`,
    })
    .click({ button: "right" });
}

test("Copy on a turn notch copies the trimmed turn text", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { pinCopied: string[] }).pinCopied = copied;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
        readText: async () => copied.at(-1) ?? "",
      },
    });
  });
  const messages = twoTurns.map((message) =>
    message.uuid === "turn-2"
      ? {
          ...message,
          message: {
            role: "user",
            content: "  Second request about the lexer\n\n",
          },
        }
      : message,
  );
  await openSessionPage(page, baseURL, { owner: "none", messages });
  await openTurnNotchMenu(page, "Second request about the lexer");
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { pinCopied: string[] }).pinCopied,
      ),
    )
    .toEqual(["Second request about the lexer"]);
});

test("Handoff from a turn notch opens New Session prefilled from that turn on", async ({
  page,
  baseURL,
}) => {
  await openSessionPage(page, baseURL, { owner: "none", messages: twoTurns });
  await openTurnNotchMenu(page, "Second request about the lexer");
  await page.getByRole("menuitem", { name: "Handoff from…" }).click();

  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/new-session" &&
      url.searchParams.get("projectId") === projectId &&
      url.searchParams.get("provider") === "claude",
  );
  const composer = page.locator("textarea.new-session-form-textarea");
  await expect(composer).toBeVisible();
  const prefill = await composer.inputValue();
  expect(prefill).toContain("You are taking over for a stopped session.");
  expect(prefill).toContain(`claude session ${sessionId}`);
  expect(prefill).toContain(
    "user: Second request about the lexer\n\nThe lexer splits words.",
  );
  expect(prefill).not.toContain("First request about the parser");
});

test("toggling auto-open on a started fork summary opens the fork when ready, and following it records the click", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const opened: string[][] = [];
    (window as unknown as { pinOpened: string[][] }).pinOpened = opened;
    window.open = ((url?: string | URL, target?: string) => {
      opened.push([String(url), String(target)]);
      return {} as Window;
    }) as typeof window.open;
    // Following the ready link must not open a real tab.
    document.addEventListener(
      "click",
      (event) => {
        if ((event.target as Element).closest?.("a[target=_blank]"))
          event.preventDefault();
      },
      true,
    );
  });
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  const objectPath = `${summaryPath}/${generating.id}`;
  const ready = {
    ...generating,
    status: "ready",
    targetSessionId: "pin-summary-fork",
    title: "Parser fork",
    autoOpenWhenReady: true,
  };
  await session.answer("POST", summaryPath, (route) =>
    json(route, 200, { displayObject: generating }),
  );
  await session.answer("PATCH", objectPath, (route, body) => {
    const action = (body as { action?: string }).action;
    const object =
      action === "opened"
        ? { ...ready, openedAt: new Date().toISOString() }
        : action === "clicked"
          ? { ...ready, clickedAt: new Date().toISOString() }
          : ready;
    return json(route, 200, {
      displayObject: object,
      transcriptDisplayObjects: [object],
    });
  });
  await startForkAfterSummary(page);
  await session.composer.press("Enter");
  const progress = page.locator(".fork-summary-display-object-generating");
  await progress
    .getByRole("checkbox", { name: "Open in new tab when ready" })
    .check();

  await expect
    .poll(session.requests)
    .toEqual([
      `POST ${summaryPath}`,
      `PATCH ${objectPath}`,
      `PATCH ${objectPath}`,
    ]);
  expect(session.calls[0]?.body).toMatchObject({ autoOpenWhenReady: false });
  expect(session.calls[1]?.body).toEqual({ autoOpenWhenReady: true });
  expect(session.calls[2]?.body).toEqual({ action: "opened" });
  expect(
    await page.evaluate(
      () => (window as unknown as { pinOpened: string[][] }).pinOpened,
    ),
  ).toEqual([
    [
      `${new URL(baseURL).origin}/projects/${projectId}/sessions/pin-summary-fork`,
      "_blank",
    ],
  ]);
  await expect(page.getByText("(tab opened)")).toBeVisible();

  // Following the ready link records the click.
  await page.getByRole("link", { name: "Parser fork ↗" }).click();
  await expect.poll(() => session.calls.length).toBe(4);
  expect(session.calls[3]).toMatchObject({
    method: "PATCH",
    path: objectPath,
    body: { action: "clicked" },
  });
  await expect(page.getByText("(clicked)")).toBeVisible();
});

test("the fork shortcut with instructions starts the summary fork after the first turn", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  await session.answer("POST", summaryPath, (route) =>
    json(route, 200, { displayObject: generating }),
  );
  await session.forksOffered();
  await session.composer.fill("Summarize the lexer work");
  await session.composer.press("Control+Alt+Enter");

  await expect.poll(session.requests).toEqual([`POST ${summaryPath}`]);
  expect(session.calls[0]?.body).toEqual({
    sourceMessageId: "turn-1",
    instructions: "Summarize the lexer work",
    mode: "default",
    autoOpenWhenReady: false,
  });
  await expect(page.getByText("Fork after selected turn")).toHaveCount(0);
  await expect(session.composer).toHaveValue("");
  await expect(
    page.locator(".fork-summary-display-object-generating"),
  ).toBeVisible();
});

test("the fork shortcut with no user turn loaded explains there is no anchor", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: [agentReply("reply-only", "A reply with no request.", 0, "none")],
    ready: "A reply with no request.",
  });
  await session.composer.fill("Summarize this");
  // No turn notch shows forks here, so press until forks are offered: a
  // press before then does nothing.
  await expect(async () => {
    await session.composer.press("Control+Alt+Enter");
    // Toasts are not deduplicated, so a slow first toast and a retry can
    // show two; either proves the press was handled.
    await expect(
      session
        .toast("No completed turn boundary is loaded for this fork.")
        .first(),
    ).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(session.composer).toHaveValue("Summarize this");
  expect(session.requests()).toEqual([]);
});

test("a turn in progress refuses fork-after", async ({ page, baseURL }) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "self",
    processState: "in-turn",
    messages: twoTurns,
  });
  await openForkMenu(page, "First request about the parser");
  await expect(
    page.getByRole("menuitem", { name: "After this turn", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");

  await session.composer.press("Control+Alt+Enter");
  await expect(
    session.toast(
      "Wait for the agent response to finish before forking after this turn.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Fork after selected turn")).toHaveCount(0);
  expect(session.requests()).toEqual([]);
});

test("/fork N forks after turn N and is recalled like a sent command", async ({
  page,
  baseURL,
}) => {
  const session = await openSessionPage(page, baseURL, {
    owner: "none",
    messages: twoTurns,
  });
  // A refused fork keeps the page here, where the command can be recalled.
  await session.answer("POST", forkPath, (route) =>
    json(route, 409, { error: "Fork refused by pin" }),
  );
  await session.forksOffered();
  await session.composer.fill("/fork 2");
  await session.composer.press("Enter");

  await expect.poll(session.requests).toEqual([`POST ${forkPath}`]);
  expect(session.calls[0]?.body).toMatchObject({
    forkKind: "after-user-turn",
    sourceMessageId: "turn-2",
  });
  await expect(session.toast("Fork refused by pin")).toBeVisible();
  await expect(session.composer).toHaveValue("");
  // Accepted commands lead the recall drawer, ahead of the turns.
  await session.composer.press("Control+ArrowUp");
  await expect(
    page.locator(".composer-recall-menu .slash-command-item").first(),
  ).toContainText("/fork 2");
});
