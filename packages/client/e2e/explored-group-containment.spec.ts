import type { Page } from "@playwright/test";
import {
  type PublicSessionShareResponse,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

/**
 * An explored entry occupies one line and stays inside it.
 *
 * A tool result that misses its display contract makes the renderer answer
 * with its raw fallback: a heading, a "rich preview unavailable" notice and
 * pretty-printed JSON. Dropped into an entry's single-line cell that block used
 * to paint over the neighbouring entries. See topics/collapse-expand-mode.md.
 */

const projectId = toUrlProjectId("/project");
const timestamp = "2026-09-07T00:00:00.000Z";

/**
 * A real image read whose envelope does not match the Read display contract:
 * the top-level discriminator is the media type rather than `image`, and no
 * base64 payload is present.
 */
function imageReadResult(index: number) {
  return {
    type: "image/png",
    file: {
      filePath: `/project/docs/diagram-${index}.png`,
      type: "image/png",
      originalSize: 120112,
      dimensions: { originalWidth: 497, originalHeight: 196 },
    },
  };
}

function read(index: number) {
  return [
    {
      id: `assistant-read-${index}`,
      type: "assistant",
      timestamp,
      content: [
        {
          type: "tool_use",
          id: `read-${index}`,
          name: "Read",
          input: { file_path: `/project/docs/diagram-${index}.png` },
        },
      ],
    },
    {
      id: `read-result-${index}`,
      type: "user",
      timestamp,
      // The provider's structured envelope, which is what reaches the display
      // contract; the text content is only its fallback.
      toolUseResult: imageReadResult(index),
      content: [
        {
          type: "tool_result",
          tool_use_id: `read-${index}`,
          content: JSON.stringify(imageReadResult(index)),
        },
      ],
    },
  ];
}

function shareResponse(): PublicSessionShareResponse {
  const messages = [
    {
      id: "user-1",
      type: "user",
      timestamp,
      content: "Please look at the diagrams.",
    },
    ...[1, 2, 3].flatMap((index) => read(index)),
    {
      id: "answer",
      type: "assistant",
      timestamp,
      content: "All three diagrams are in place.",
    },
  ];
  return {
    share: {
      mode: "live",
      title: "Diagram review",
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
      title: "Diagram review",
      fullTitle: "Diagram review",
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

async function openShare(page: Page, remoteClientURL: string) {
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
          body: shareResponse(),
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
  await page.goto(`${remoteClientURL}/remote.html`);
  // The share opens in Conversation view, which folds the reads into the turn's
  // activity summary; the explored group is inside that.
  const summary = page.locator("[data-conversation-activity-summary]");
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(page.locator("[data-explored-entry]")).toHaveCount(3);
}

test("explored entries stay on their own line instead of overlapping", async ({
  page,
  remoteClientURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openShare(page, remoteClientURL);

  const geometry = await page.evaluate(() => {
    const entries = [
      ...document.querySelectorAll<HTMLElement>("[data-explored-entry]"),
    ];
    const oneLine = Number.parseFloat(
      getComputedStyle(entries[0] as HTMLElement).lineHeight,
    );
    return {
      rows: entries.map((entry) => {
        const rect = entry.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
      oneLine: Number.isFinite(oneLine) ? oneLine : 0,
      rawBlocks: document.querySelectorAll(
        '[data-explored-entry-summary] [data-tool-display="raw"]',
      ).length,
    };
  });

  // The renderer has no rich summary for this envelope, so the group must use
  // its own compact fallback rather than embedding the raw block.
  expect(geometry.rawBlocks).toBe(0);
  expect(geometry.rows).toHaveLength(3);
  // No entry starts before its predecessor ends: that overlap is the defect.
  for (let index = 1; index < geometry.rows.length; index += 1) {
    const previous = geometry.rows[index - 1];
    const current = geometry.rows[index];
    if (!previous || !current) throw new Error("Expected three entry rows");
    expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1);
  }
  // And each stays the single line an entry is contracted to occupy.
  const tallest = Math.max(...geometry.rows.map((row) => row.height));
  expect(tallest).toBeLessThan(3 * Math.max(geometry.oneLine, 16));

  await recordUiCapture(page, "explored-entries");
});
