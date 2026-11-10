import type { Page } from "@playwright/test";
import {
  type PublicSessionShareResponse,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

/**
 * Conversation view's two thinking previews at tablet heights, and the prose
 * that makes a thought too stale to preview at all.
 *
 * A tablet is wide enough to put the activity column beside the current
 * thinking card but not wide enough for the superseded one, so that card wraps
 * below and its height *adds* to the row. The current card comes first, so the
 * pair outgrowing the viewport pushes the card the reader is actually following
 * off the top. See topics/conversation-view.md.
 */

const projectId = toUrlProjectId("/project");
const timestamp = "2026-09-07T00:00:00.000Z";

function paragraph(sentence: string, times: number): string {
  return Array.from({ length: times }, () => sentence).join(" ");
}

const answer = paragraph(
  "The relay handshake now retries with a fresh token, so a stale resume no longer strands the client on the login form.",
  4,
);

function activity(index: number) {
  return [
    {
      id: `assistant-tool-${index}`,
      type: "assistant",
      timestamp,
      content: [
        {
          type: "tool_use",
          id: `tool-${index}`,
          name: "Bash",
          input: {
            command: `pnpm --filter @yep-anywhere/client exec vitest run src/lib/case-${index}.test.ts`,
          },
        },
      ],
    },
    {
      id: `result-${index}`,
      type: "user",
      timestamp,
      content: [
        {
          type: "tool_result",
          tool_use_id: `tool-${index}`,
          content: "Command completed successfully.",
        },
      ],
    },
  ];
}

function thinking(id: string, sentence: string, streaming: boolean) {
  return {
    id,
    type: "assistant",
    timestamp,
    ...(streaming ? { _isStreaming: true } : {}),
    content: [{ type: "thinking", thinking: paragraph(sentence, 8) }],
  };
}

const PREVIOUS_THOUGHT =
  "The saved host is rewritten on every successful login, so a blank advanced field silently adopts the compiled-in default.";
const CURRENT_THOUGHT =
  "So the fix belongs in the login form's default, not in the resume path: bake the intended relay host in and leave the saved value alone when the field is blank.";

/**
 * `working`: the turn answered first and is now mid-thought, so both previews
 * are live candidates. `spoke-and-resumed`: the turn thought, answered, and
 * then went back to work, which makes both thoughts stale.
 */
type Shape = "working" | "spoke-and-resumed";

function messagesFor(shape: Shape) {
  const prompt = {
    id: "user-1",
    type: "user",
    timestamp,
    content: "Please fix the stale relay resume token.",
  };
  const prose = { id: "answer", type: "assistant", timestamp, content: answer };
  if (shape === "working") {
    return [
      prompt,
      prose,
      ...Array.from({ length: 4 }, (_, i) => activity(i)).flat(),
      thinking("previous-thinking", PREVIOUS_THOUGHT, false),
      ...Array.from({ length: 4 }, (_, i) => activity(i + 4)).flat(),
      thinking("current-thinking", CURRENT_THOUGHT, true),
    ];
  }
  return [
    prompt,
    ...Array.from({ length: 4 }, (_, i) => activity(i)).flat(),
    thinking("previous-thinking", PREVIOUS_THOUGHT, false),
    thinking("current-thinking", CURRENT_THOUGHT, false),
    prose,
    ...Array.from({ length: 4 }, (_, i) => activity(i + 4)).flat(),
  ];
}

function shareResponse(shape: Shape): PublicSessionShareResponse {
  const messages = messagesFor(shape);
  return {
    share: {
      mode: "live",
      title: "Relay resume review",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: {
        projectId,
        sessionId: "shared-session",
        projectName: "Example project",
        provider: "claude",
      },
    },
    session: {
      id: "shared-session",
      projectId,
      provider: "claude",
      title: "Relay resume review",
      fullTitle: "Relay resume review",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: messages.length,
      ownership: { owner: "none" },
      messages: messages.map((message) => ({
        ...message,
        uuid: message.id,
        message: { role: message.type, content: message.content },
      })) as PublicSessionShareResponse["session"]["messages"],
    },
  };
}

async function openShare(page: Page, remotePreviewURL: string, shape: Shape) {
  await page.routeWebSocket("wss://share-relay.test/ws", (socket) => {
    socket.onMessage((wire) => {
      const message = JSON.parse(String(wire));
      if (message.type === "client_connect") {
        socket.send(JSON.stringify({ type: "client_connected" }));
        return;
      }
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: shareResponse(shape),
        }),
      );
    });
  });
  await page.addInitScript(() => {
    history.replaceState(
      null,
      "",
      "/share/public-secret?h=owner&r=wss%3A%2F%2Fshare-relay.test%2Fws",
    );
  });
  await page.goto(`${remotePreviewURL}/remote.html`);
  await expect(
    page.locator("[data-conversation-activity-summary]"),
  ).not.toHaveCount(0);
}

/** Row state plus the geometry the budget contract is stated in. */
async function readRowGeometry(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      "[data-conversation-activity-row]",
    );
    if (!row) return null;
    let viewport: HTMLElement | null = row.parentElement;
    while (viewport) {
      const { overflowY } = getComputedStyle(viewport);
      if (overflowY === "auto" || overflowY === "scroll") break;
      viewport = viewport.parentElement;
    }
    const rect = (selector: string) =>
      row.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
    const latest = rect(
      '[data-conversation-thinking-preview][data-preview-slot="latest"]',
    );
    const previous = rect(
      '[data-conversation-thinking-preview][data-preview-slot="previous"]',
    );
    const viewportRect = viewport?.getBoundingClientRect() ?? null;
    return {
      state: row.dataset.previousThinking ?? null,
      budget: row.style.getPropertyValue(
        "--conversation-previous-thinking-budget",
      ),
      rowHeight: row.getBoundingClientRect().height,
      viewportHeight: viewportRect?.height ?? 0,
      viewportTop: viewportRect?.top ?? 0,
      latestTop: latest?.top ?? null,
      latestHeight: latest?.height ?? null,
      previousHeight: previous?.height ?? null,
    };
  });
}

/**
 * Space left above the row at the live edge, against the prose line height the
 * two-line reserve is stated in.
 */
async function readLiveEdgeHeadroom(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      "[data-conversation-activity-row]",
    );
    if (!row) return null;
    let viewport: HTMLElement | null = row.parentElement;
    while (viewport) {
      const { overflowY } = getComputedStyle(viewport);
      if (overflowY === "auto" || overflowY === "scroll") break;
      viewport = viewport.parentElement;
    }
    if (!viewport) return null;
    viewport.scrollTop = viewport.scrollHeight;
    const prose = document.querySelector<HTMLElement>(
      "[data-conversation-thinking-preview-content] [data-thinking-text]",
    );
    return {
      headroomPx:
        row.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      proseLinePx: prose
        ? Number.parseFloat(getComputedStyle(prose).lineHeight)
        : 0,
    };
  });
}

const TABLET = { width: 820, height: 700 };
/** Wide enough to still wrap, too short for both cards at any useful height. */
const SHORT_WINDOW = { width: 820, height: 250 };
const DESKTOP = { width: 1000, height: 600 };
const PHONE = { width: 375, height: 812 };

test("a wrapped previous card takes only the room left in the viewport", async ({
  page,
  remotePreviewURL,
}) => {
  await page.setViewportSize(TABLET);
  await openShare(page, remotePreviewURL, "working");
  await expect(
    page.locator(
      '[data-conversation-thinking-preview][data-preview-slot="previous"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-conversation-activity-row]"),
  ).toHaveAttribute("data-previous-thinking", "stacked");

  const geometry = await readRowGeometry(page);
  expect(geometry).not.toBeNull();
  if (!geometry) return;
  // Both cards fit, and the row leaves room above itself for the tail of the
  // preceding paragraph rather than pushing the current card off the top.
  expect(geometry.previousHeight ?? 0).toBeGreaterThan(1);
  expect(geometry.rowHeight).toBeLessThan(geometry.viewportHeight);
  expect(geometry.latestTop ?? 0).toBeGreaterThanOrEqual(
    geometry.viewportTop - 1,
  );
  // The superseded card never claims more than the current one.
  expect(geometry.previousHeight ?? 0).toBeLessThanOrEqual(
    (geometry.latestHeight ?? 0) + 1,
  );
  // Scrolled to the live edge, the tail of the preceding paragraph is still on
  // screen above the row — the point of the reserve.
  const headroom = await readLiveEdgeHeadroom(page);
  expect(headroom).not.toBeNull();
  if (!headroom) return;
  expect(headroom.proseLinePx).toBeGreaterThan(0);
  expect(headroom.headroomPx).toBeGreaterThanOrEqual(
    2 * headroom.proseLinePx - 1,
  );
  await recordUiCapture(page, "tablet");

  await page.setViewportSize(DESKTOP);
  await expect(page.locator("[data-conversation-activity-row]")).toBeVisible();
  await recordUiCapture(page, "desktop");

  await page.setViewportSize(PHONE);
  await expect(page.locator("[data-conversation-activity-row]")).toBeVisible();
  await recordUiCapture(page, "phone");
});

test("a short window drops the previous card instead of clipping the current one", async ({
  page,
  remotePreviewURL,
}) => {
  await page.setViewportSize(SHORT_WINDOW);
  await openShare(page, remotePreviewURL, "working");
  await expect(
    page.locator("[data-conversation-activity-row]"),
  ).toHaveAttribute("data-previous-thinking", "dropped");

  const geometry = await readRowGeometry(page);
  expect(geometry).not.toBeNull();
  if (!geometry) return;
  expect(geometry.previousHeight ?? 0).toBeLessThanOrEqual(1);
  expect(geometry.latestTop ?? 0).toBeGreaterThanOrEqual(
    geometry.viewportTop - 1,
  );
  await recordUiCapture(page, "short-window");
});

test("thinking the turn spoke past and resumed work after is not previewed", async ({
  page,
  remotePreviewURL,
}) => {
  await page.setViewportSize(TABLET);
  await openShare(page, remotePreviewURL, "spoke-and-resumed");

  await expect(
    page.locator("[data-conversation-thinking-preview]"),
  ).toHaveCount(0);
  await expect(
    page.getByText("relay handshake", { exact: false }),
  ).toBeVisible();
});
