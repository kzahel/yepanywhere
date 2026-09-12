// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  collectTurnInlineImages,
  findTurnInlineImageAnchor,
  getTurnInlineImageTargetForTarget,
  packTurnGalleryRows,
} from "../turnInlineMedia";

function textItem(id: string, augmentHtml: string): RenderItem {
  return {
    augmentHtml,
    id,
    sourceMessages: [],
    text: "media",
    type: "text",
  };
}

function mediaHtml(
  label: string,
  path: string,
  mediaType: "image" | "video" = "image",
): string {
  return `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${path}" data-media-type="${mediaType}">+</button><a href="/api/local-image?path=${encodeURIComponent(path)}" class="local-media-link" data-media-type="${mediaType}" data-ya-path="${path}" data-ya-media-type="${mediaType}">${label}<span class="local-media-type">(${mediaType})</span></a></span><span class="local-media-inline-preview" data-media-path="${path}" data-media-type="${mediaType}"></span>`;
}

describe("turn inline media model", () => {
  it("collects stable image occurrences across a turn and preserves link labels", () => {
    const images = collectTurnInlineImages([
      textItem(
        "answer-a",
        `<p>${mediaHtml("Desktop result", "/repo/desktop.png")} ${mediaHtml("clip", "/repo/demo.mp4", "video")}</p>`,
      ),
      textItem(
        "answer-b",
        `<p>${mediaHtml("Phone result", "/repo/phone.png")}</p>`,
      ),
    ]);

    expect(images).toEqual([
      {
        basename: "desktop.png",
        id: "answer-a:inline-image:0",
        label: "Desktop result",
        originalIndex: 0,
        path: "/repo/desktop.png",
        sourceIndex: 0,
        sourceItemId: "answer-a",
      },
      {
        basename: "phone.png",
        id: "answer-b:inline-image:0",
        label: "Phone result",
        originalIndex: 1,
        path: "/repo/phone.png",
        sourceIndex: 0,
        sourceItemId: "answer-b",
      },
    ]);
  });

  it("maps both the original link and its plus control to one gallery identity", () => {
    const root = document.createElement("div");
    root.innerHTML = mediaHtml("Result", "/repo/result.png");
    const link = root.querySelector("a");
    const toggle = root.querySelector("button");

    expect(getTurnInlineImageTargetForTarget(root, "answer", link)).toEqual({
      id: "answer:inline-image:0",
      kind: "link",
    });
    expect(getTurnInlineImageTargetForTarget(root, "answer", toggle)).toEqual({
      id: "answer:inline-image:0",
      kind: "toggle",
    });
    expect(findTurnInlineImageAnchor(root, 0)).toBe(link);
  });

  it("packs deterministic balanced rows without resize-dependent reordering", () => {
    const images = ["a", "b", "c", "d"].map((id, originalIndex) => ({
      id,
      originalIndex,
    }));
    const dimensions = new Map([
      ["a", { height: 100, width: 400 }],
      ["b", { height: 200, width: 100 }],
      ["c", { height: 100, width: 200 }],
      ["d", { height: 100, width: 100 }],
    ]);

    const narrow = packTurnGalleryRows(images, dimensions, 600, 280);
    const wide = packTurnGalleryRows(images, dimensions, 900, 280);
    const ids = (rows: typeof narrow) =>
      rows.flatMap((row) => row.items.map((item) => item.id));

    expect(ids(narrow)).toEqual(["a", "c", "d", "b"]);
    expect(ids(wide)).toEqual(ids(narrow));
    expect(narrow).toHaveLength(2);
    expect(
      narrow.reduce((height, row) => height + row.height, 8),
    ).toBeLessThanOrEqual(280);
  });

  it("keeps four screenshots in one row when splitting would shrink them", () => {
    const images = ["desktop-a", "phone-a", "desktop-b", "phone-b"].map(
      (id, originalIndex) => ({ id, originalIndex }),
    );
    const dimensions = new Map([
      ["desktop-a", { height: 1080, width: 1920 }],
      ["phone-a", { height: 1920, width: 1080 }],
      ["desktop-b", { height: 1080, width: 1920 }],
      ["phone-b", { height: 1920, width: 1080 }],
    ]);

    const rows = packTurnGalleryRows(images, dimensions, 1000, 120);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.height).toBe(120);
    expect(
      rows[0]?.items.reduce((width, item) => width + item.width, 24),
    ).toBeLessThanOrEqual(1000);
  });

  it("never upscales a thumbnail beyond its natural image height", () => {
    const images = ["small", "large"].map((id, originalIndex) => ({
      id,
      originalIndex,
    }));
    const dimensions = new Map([
      ["small", { height: 40, width: 160 }],
      ["large", { height: 600, width: 800 }],
    ]);

    const rows = packTurnGalleryRows(images, dimensions, 1000, 120);
    const itemById = new Map(
      rows.flatMap((row) => row.items.map((item) => [item.id, item])),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.height).toBe(120);
    expect(itemById.get("small")).toMatchObject({
      height: 40,
      naturalHeight: 40,
      naturalWidth: 160,
      width: 160,
    });
    expect(itemById.get("large")).toMatchObject({
      height: 120,
      naturalHeight: 600,
      naturalWidth: 800,
      width: 160,
    });
  });
});
