import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");

async function textPoint(locator: Locator, offset: number) {
  return locator.evaluate((element, textOffset) => {
    const text = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null;
    if (!text) throw new Error("Expected selectable text");
    const range = document.createRange();
    range.setStart(text, textOffset);
    range.setEnd(text, Math.min(textOffset + 1, text.data.length));
    const rect = range.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, offset);
}

async function openSessionFile(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${projectId}/sessions/source-selection-001`);
  const sourceLink = page.locator(
    'a[data-ya-private-project-file-link="true"]',
  );
  await expect(sourceLink).toBeVisible();
  await sourceLink.click();
  await expect(
    page.locator("[data-file-viewer-code-highlighted]"),
  ).toBeVisible();
  await expect(
    page.locator('[data-file-viewer-body][data-markdown-copy-source="true"]'),
  ).toBeVisible();
}

async function selectSourceRange(
  page: Page,
  options: {
    direction: "forward" | "reverse";
    startLine: number;
    startMarker: string;
    endLine: number;
    endMarker: string;
  },
) {
  return page
    .locator("[data-file-viewer-code-highlighted]")
    .evaluate((viewer, selectionOptions) => {
      const lines = viewer.querySelectorAll<HTMLElement>(".line");
      const boundary = (line: HTMLElement, marker: string, atEnd: boolean) => {
        const lineText = line.textContent ?? "";
        const markerIndex = lineText.indexOf(marker);
        if (markerIndex < 0) throw new Error(`Marker not found: ${marker}`);
        const target = markerIndex + (atEnd ? marker.length : 0);
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const textNode = node as Text;
          if (target <= consumed + textNode.data.length) {
            return { node: textNode, offset: target - consumed };
          }
          consumed += textNode.data.length;
        }
        throw new Error(`Text boundary not found: ${marker}`);
      };
      const startLine = lines[selectionOptions.startLine];
      const endLine = lines[selectionOptions.endLine];
      if (!startLine || !endLine) throw new Error("Source line not found");
      const start = boundary(startLine, selectionOptions.startMarker, false);
      const end = boundary(endLine, selectionOptions.endMarker, true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      if (selectionOptions.direction === "reverse") {
        selection?.setBaseAndExtent(
          end.node,
          end.offset,
          start.node,
          start.offset,
        );
      } else {
        selection?.setBaseAndExtent(
          start.node,
          start.offset,
          end.node,
          end.offset,
        );
      }
      document.dispatchEvent(new Event("selectionchange"));
      const range = selection?.getRangeAt(0);
      return {
        rangeRectCount: range ? range.getClientRects().length : 0,
        selectedText: selection?.toString() ?? "",
        startOffset: startLine.dataset.yaSourceStart,
        endOffset: endLine.dataset.yaSourceEnd,
      };
    }, options);
}

async function quoteSelectionAndReadTint(page: Page) {
  const quote = page
    .locator("[data-file-viewer-modal]")
    .getByRole("button", { name: "Quote reply" });
  await expect(quote).toBeVisible();
  await quote.click();
  return page.evaluate(() => {
    const highlight = CSS.highlights.get("comment-tint");
    const ranges = highlight ? Array.from(highlight.values()) : [];
    const range = ranges[0] as Range | undefined;
    const startElement = range?.startContainer.parentElement;
    const endElement = range?.endContainer.parentElement;
    return {
      highlightCount: ranges.length,
      highlightRectCount: range?.getClientRects().length ?? 0,
      nativeSelectionCollapsed: document.getSelection()?.isCollapsed ?? false,
      startLineOffset: startElement
        ?.closest<HTMLElement>(".line")
        ?.getAttribute("data-ya-source-start"),
      endLineOffset: endElement
        ?.closest<HTMLElement>(".line")
        ?.getAttribute("data-ya-source-start"),
      tintBackground: startElement
        ? getComputedStyle(startElement, "::highlight(comment-tint)")
            .backgroundColor
        : "",
    };
  });
}

test("starts a new transcript selection inside previously selected text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`/projects/${projectId}/sessions/source-selection-001`);
  const text = "Review the formatted source";
  const prompt = page
    .locator("[data-message-list]")
    .getByText(text, { exact: true });
  await expect(prompt).toBeVisible();
  await prompt.evaluate((element) => {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const start = await textPoint(prompt, 14);
  const end = await textPoint(prompt, 2);
  await page.evaluate(() => {
    document.documentElement.dataset.selectionDragStarts = "0";
    document.documentElement.dataset.selectionPointerCancels = "0";
    document.addEventListener(
      "dragstart",
      () => {
        document.documentElement.dataset.selectionDragStarts = "1";
      },
      { once: true },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        document.documentElement.dataset.selectionPointerCancels = "1";
      },
      { once: true },
    );
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();

  const outcome = await page.evaluate(() => ({
    dragStarts: Number(document.documentElement.dataset.selectionDragStarts),
    pointerCancels: Number(
      document.documentElement.dataset.selectionPointerCancels,
    ),
    selection: document.getSelection()?.toString() ?? "",
  }));
  expect(outcome.dragStarts).toBe(0);
  expect(outcome.pointerCancels).toBe(0);
  expect(outcome.selection).not.toBe(text);
  expect(outcome.selection.length).toBeGreaterThan(5);
});

async function enableAllSelectionActions(page: Page) {
  await page.addInitScript(() => {
    for (const action of [
      "quote",
      "text-copy",
      "source-copy",
      "rich-copy",
      "new-session",
    ]) {
      localStorage.setItem(
        `yep-anywhere-selection-${action}-action-enabled`,
        "true",
      );
    }
  });
}

async function markerPoint(page: Page, marker: string) {
  return page.locator("[data-message-list]").evaluate((list, text) => {
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node as Text;
      const index = textNode.data.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`Marker not found: ${text}`);
  }, marker);
}

async function dragSelectAndCopy(
  page: Page,
  startMarker: string,
  endMarker: string,
) {
  const start = await markerPoint(page, startMarker);
  const end = await markerPoint(page, endMarker);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.locator('[data-selection-action-cluster="true"]'),
  ).toBeVisible();
  // Let deferred measurement, follow-state, and viewport updates settle.
  await page.waitForTimeout(500);
  const selected = await page.evaluate(
    () => document.getSelection()?.toString() ?? "",
  );
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("ControlOrMeta+c");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  return { copied, selected };
}

test("keeps a dragged transcript selection copyable after its actions appear", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await enableAllSelectionActions(page);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(`/projects/${projectId}/sessions/source-selection-001`);
  await expect(
    page.locator("[data-message-list]").getByText("and quote the exact", {
      exact: false,
    }),
  ).toBeVisible();

  const { copied, selected } = await dragSelectAndCopy(
    page,
    "quote the",
    "range.",
  );
  expect(selected).toContain("quote the exact");
  expect(copied).toContain("quote the exact");
});

test("keeps a dragged selection in a windowed transcript", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await enableAllSelectionActions(page);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(`/projects/${projectId}/sessions/windowed-selection-001`);
  const lastReply = page
    .locator("[data-message-list]")
    .getByText("Windowed reply 29 part 11", { exact: false });
  await expect(lastReply).toBeVisible();
  expect(
    Number(
      await page
        .locator("[data-message-list]")
        .getAttribute("data-transcript-render-weight"),
    ),
  ).toBeGreaterThanOrEqual(200);

  // The first marker is above the clipped transcript at the initial bottom
  // position. Reveal both endpoints before starting the native pointer drag.
  await page.locator(".session-messages").hover();
  await page.mouse.wheel(0, -180);
  await expect
    .poll(async () => (await markerPoint(page, "Windowed reply 28 part 10")).y)
    .toBeGreaterThan(80);

  const { copied, selected } = await dragSelectAndCopy(
    page,
    "Windowed reply 28 part 10",
    "Windowed reply 29 part 1 ",
  );
  expect(selected).toContain("reply 28 part 11");
  expect(selected).toContain("Windowed selection request 29");
  expect(copied).toContain("reply 28 part 11");
});

test("keeps a dragged selection while a windowed transcript grows", async ({
  context,
  page,
}) => {
  const sessionDir = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    mockProjectPath.replace(/\//g, "-"),
  );
  const liveFile = join(sessionDir, "windowed-selection-live-001.jsonl");
  writeFileSync(
    liveFile,
    `${readFileSync(join(sessionDir, "windowed-selection-001.jsonl"), "utf8")}\n`,
  );
  let parentUuid = "windowed-selection-assistant-29-11";
  let appended = 0;
  const appendReply = () => {
    const uuid = `windowed-selection-live-${appended}`;
    appendFileSync(
      liveFile,
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Live reply ${appended} arrives while the user selects older prose.`,
            },
          ],
        },
        timestamp: new Date().toISOString(),
        uuid,
        parentUuid,
      })}\n`,
    );
    parentUuid = uuid;
    appended += 1;
  };

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await enableAllSelectionActions(page);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(
    `/projects/${projectId}/sessions/windowed-selection-live-001`,
  );
  await expect(
    page
      .locator("[data-message-list]")
      .getByText("Windowed reply 29 part 11", { exact: false }),
  ).toBeVisible();
  appendReply();
  await expect(
    page
      .locator("[data-message-list]")
      .getByText("Live reply 0", { exact: false }),
  ).toBeVisible();

  const timer = setInterval(appendReply, 200);
  try {
    const { copied, selected } = await dragSelectAndCopy(
      page,
      "Windowed reply 29 part 3",
      "Windowed reply 29 part 6",
    );
    expect(appended).toBeGreaterThan(3);
    expect(selected).toContain("reply 29 part 5");
    expect(copied).toContain("reply 29 part 5");
  } finally {
    clearInterval(timer);
  }
});

for (const direction of ["forward", "reverse"] as const) {
  test(`keeps ${direction} highlighted-file selection ordered and tinted`, async ({
    page,
  }) => {
    await openSessionFile(page);
    const geometry = await selectSourceRange(page, {
      direction,
      startLine: 0,
      startMarker: "alpha",
      endLine: 1,
      endMarker: "beta",
    });
    expect(geometry.startOffset).toBe("0");
    expect(Number(geometry.endOffset)).toBeGreaterThan(
      geometry.selectedText.length,
    );

    const tint = await quoteSelectionAndReadTint(page);
    await expect(page.locator("[data-composer-input]")).toHaveValue(
      `re: ${join(e2ePaths.tempDir, "file-browser-project", "src", "index.ts")}:1\n> alpha = "first highlighted line";\n> export const beta\n`,
    );
    expect(tint.nativeSelectionCollapsed).toBe(true);
    expect(tint.highlightCount).toBe(1);
    expect(tint.highlightRectCount).toBeGreaterThan(0);
    expect(tint.startLineOffset).toBe("0");
    expect(Number(tint.endLineOffset)).toBeGreaterThan(0);
    expect(tint.tintBackground).not.toBe("rgba(0, 0, 0, 0)");
    const captureDir = process.env.YEP_UI_CAPTURE_DIR;
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      const viewport =
        direction === "forward"
          ? { width: 1000, height: 600 }
          : { width: 375, height: 812 };
      await page.setViewportSize(viewport);
      await page.mouse.move(1, 1);
      await page.screenshot({
        animations: "disabled",
        path: join(captureDir, `quote-reply-${viewport.width}.png`),
      });
    }
  });
}

test("keeps a wrapped highlighted-file range narrow after quote reply", async ({
  page,
}) => {
  await openSessionFile(page);
  const geometry = await selectSourceRange(page, {
    direction: "forward",
    startLine: 2,
    startMarker: "wrapped-selection-start",
    endLine: 2,
    endMarker: "wrapped-selection-end",
  });
  expect(geometry.rangeRectCount).toBeGreaterThan(1);
  const selectedSource = `wrapped-selection-start ${"0123456789 ".repeat(24)}wrapped-selection-end`;

  const tint = await quoteSelectionAndReadTint(page);
  await expect(page.locator("[data-composer-input]")).toHaveValue(
    `re: ${join(e2ePaths.tempDir, "file-browser-project", "src", "index.ts")}:3\n> ${selectedSource}\n`,
  );
  expect(tint.highlightCount).toBe(1);
  expect(tint.highlightRectCount).toBeGreaterThan(1);
  expect(tint.nativeSelectionCollapsed).toBe(true);
});

test("places activity selection actions beside the selected range", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${projectId}/sessions/activity-selection-001`);
  await page.locator("[data-conversation-activity-summary]").click();
  await expect(page.locator("[data-bash-collapsed-preview]")).toBeVisible();
  await page.locator("[data-bash-collapsed-preview]").click();
  const modal = page.locator("[data-modal-frame]");
  await expect(modal).toBeVisible();

  const geometry = await modal.evaluate((modalElement) => {
    const source = Array.from(
      modalElement.querySelectorAll<HTMLElement>(
        '[data-markdown-copy-source="true"]',
      ),
    ).find((element) =>
      element.textContent?.includes("selection anchor near top"),
    );
    if (!source) throw new Error("Activity output source not found");
    const firstText = document
      .createTreeWalker(source, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null;
    if (!firstText) throw new Error("Activity output text not found");
    const firstLineEnd = firstText.data.indexOf("\n");
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(
      firstText,
      firstLineEnd >= 0 ? firstLineEnd : firstText.data.length,
    );
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const selectedRect = range.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    return {
      selectedBottom: selectedRect.bottom,
      sourceBottom: sourceRect.bottom,
    };
  });

  const cluster = modal.locator('[data-selection-action-cluster="true"]');
  await expect(cluster).toBeVisible();
  const clusterBox = await cluster.boundingBox();
  if (!clusterBox) throw new Error("Selection action cluster has no box");
  expect(clusterBox.y).toBeLessThanOrEqual(geometry.selectedBottom + 60);
  expect(geometry.sourceBottom - clusterBox.y).toBeGreaterThan(250);
});

test("keeps a backward drag selected in a collapsed activity preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`/projects/${projectId}/sessions/activity-selection-001`);
  await page.locator("[data-conversation-activity-summary]").click();
  const preview = page.locator("[data-bash-collapsed-preview]");
  await expect(preview).toBeVisible();
  const output = preview.locator("[data-bash-preview-output] pre").first();
  const { start, end } = await output.evaluate((element) => {
    const text = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null;
    if (!text) throw new Error("Collapsed activity output has no text");
    const point = (offset: number, horizontalBias: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.left + rect.width * horizontalBias,
        y: rect.top + rect.height / 2,
      };
    };
    const start = point(text.data.indexOf("near bottom") + 5, 0.8);
    const end = point(text.data.indexOf("anchor") + 2, 0.2);
    return {
      start,
      end,
    };
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * step) / 12,
      start.y + ((end.y - start.y) * step) / 12,
    );
    await page.waitForTimeout(30);
  }
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.isCollapsed))
    .toBe(false);
  await page.mouse.up();

  await expect(page.locator("[data-modal-frame]")).not.toBeVisible();
  await expect
    .poll(() =>
      output.evaluate((element) => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          return false;
        }
        const range = selection.getRangeAt(0);
        return (
          element.contains(range.startContainer) &&
          element.contains(range.endContainer)
        );
      }),
    )
    .toBe(true);
});
