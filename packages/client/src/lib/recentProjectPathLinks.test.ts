// @vitest-environment jsdom

import type { ProjectPathLinkTarget } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import type {
  RenderItem,
  TextItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import { annotateProjectPathLinksHtml } from "./projectPathLinks";
import {
  applyRecentProjectPathLinks,
  recentProjectFileMentions,
} from "./recentProjectPathLinks";
import { canReuseRenderItem } from "./stableRenderItems";
import { compileWebTranscriptProjection } from "./webTranscriptProjection";

function commandItem(
  id: string,
  command: string,
  links?: ProjectPathLinkTarget[],
): ToolCallItem {
  return {
    type: "tool_call",
    id,
    toolName: "exec_command",
    toolInput: { cmd: command, _projectPathLinks: links },
    status: "complete",
    sourceMessages: [],
  };
}

function textItem(id: string, text: string, augmentHtml?: string): TextItem {
  return { type: "text", id, text, augmentHtml, sourceMessages: [] };
}

function projectedTextLink(
  items: RenderItem[],
  id: string,
): ProjectPathLinkTarget {
  const item = items.find((candidate) => candidate.id === id);
  if (item?.type !== "text") throw new Error(`missing text item ${id}`);
  const link = item.projectPathLinks?.[0];
  if (!link) throw new Error(`missing project path link for ${id}`);
  return link;
}

describe("applyRecentProjectPathLinks", () => {
  it("orders completion paths by mentions, including causal basename aliases, without losing collisions", () => {
    const items = [
      commandItem("a", "cat a/settings.json", [
        { text: "a/settings.json", filePath: "a/settings.json" },
      ]),
      commandItem("b", "cat b/settings.json", [
        { text: "b/settings.json", filePath: "b/settings.json" },
      ]),
      commandItem("c", "cat src/recent.ts", [
        { text: "src/recent.ts", filePath: "src/recent.ts" },
      ]),
      commandItem("d", "cat settings.json"),
    ];
    expect(recentProjectFileMentions(items)).toEqual([
      "b/settings.json",
      "src/recent.ts",
      "a/settings.json",
    ]);
  });
  it("keeps basename relinking off unless explicitly enabled", () => {
    const messages: Message[] = [
      {
        id: "full-path",
        type: "user",
        content: "Open src/settings.json",
        _projectPathLinks: [
          { text: "src/settings.json", filePath: "src/settings.json" },
        ],
      },
      {
        id: "basename",
        type: "user",
        content: "Then check settings.json",
      },
    ];

    const defaultProjection = compileWebTranscriptProjection(messages);
    const enabledProjection = compileWebTranscriptProjection(
      messages,
      undefined,
      true,
    );
    const defaultBasenameItem = defaultProjection.find(
      (item) => item.id === "basename",
    );

    expect(defaultBasenameItem?.type).toBe("user_prompt");
    if (defaultBasenameItem?.type !== "user_prompt") {
      throw new Error("Expected basename message to compile as a user prompt");
    }
    expect(defaultBasenameItem.projectPathLinks).toBeUndefined();
    expect(
      enabledProjection.find((item) => item.id === "basename"),
    ).toMatchObject({
      projectPathLinks: [
        { text: "settings.json", filePath: "src/settings.json" },
      ],
    });
  });

  it("uses only the most recent full path from the preceding replay prefix", () => {
    const first = commandItem("first", "open src/one/settings.json", [
      { text: "src/one/settings.json", filePath: "src/one/settings.json" },
    ]);
    const beforeReplacement = textItem("before", "Check settings.json.");
    const replacement = commandItem(
      "replacement",
      "open src/two/settings.json",
      [{ text: "src/two/settings.json", filePath: "src/two/settings.json" }],
    );
    const afterReplacement = textItem("after", "Check settings.json.");

    const projected = applyRecentProjectPathLinks([
      first,
      beforeReplacement,
      replacement,
      afterReplacement,
    ]);

    expect(projectedTextLink(projected, "before")).toEqual({
      text: "settings.json",
      filePath: "src/one/settings.json",
    });
    expect(projectedTextLink(projected, "after")).toEqual({
      text: "settings.json",
      filePath: "src/two/settings.json",
    });
  });

  it("does not let later transcript links retarget an earlier basename", () => {
    const prefix = [
      commandItem("first", "open src/one/settings.json", [
        { text: "src/one/settings.json", filePath: "src/one/settings.json" },
      ]),
      textItem("stable", "Check settings.json."),
    ];
    const before = applyRecentProjectPathLinks(prefix);
    const after = applyRecentProjectPathLinks([
      ...prefix,
      commandItem("later", "open src/two/settings.json", [
        { text: "src/two/settings.json", filePath: "src/two/settings.json" },
      ]),
    ]);

    expect(projectedTextLink(after, "stable")).toEqual(
      projectedTextLink(before, "stable"),
    );
  });

  it("does not refresh the table from a basename-expanded link", () => {
    const projected = applyRecentProjectPathLinks([
      commandItem("full", "open src/settings.json", [
        { text: "src/settings.json", filePath: "src/settings.json" },
      ]),
      commandItem("basename", "open settings.json", [
        { text: "settings.json", filePath: "settings.json" },
      ]),
      textItem("after", "Check settings.json."),
    ]);

    expect(projectedTextLink(projected, "after").filePath).toBe(
      "src/settings.json",
    );
  });

  it("notices full project-file anchors in assistant HTML", () => {
    const projected = applyRecentProjectPathLinks([
      textItem(
        "full",
        "See packages/client/src/main.tsx.",
        '<p>See <a data-ya-resource="project-file" data-ya-path="packages/client/src/main.tsx">packages/client/src/main.tsx</a>.</p>',
      ),
      textItem("basename", "Then main.tsx."),
    ]);

    expect(projectedTextLink(projected, "basename")).toEqual({
      text: "main.tsx",
      filePath: "packages/client/src/main.tsx",
    });
  });

  it("uses Windows-aware basenames without matching longer suffixes", () => {
    const projected = applyRecentProjectPathLinks([
      commandItem("full", "open C:\\repo\\src\\settings.json", [
        {
          text: "C:\\repo\\src\\settings.json",
          filePath: "C:\\repo\\src\\settings.json",
        },
      ]),
      textItem("basename", "Check settings.json and src/settings.json."),
    ]);

    const item = projected.find((candidate) => candidate.id === "basename");
    expect(item?.type === "text" ? item.projectPathLinks : undefined).toEqual([
      {
        text: "settings.json",
        filePath: "C:\\repo\\src\\settings.json",
      },
    ]);
  });

  it("prevents stabilization from hiding a newly available prefix alias", () => {
    const previous = textItem("basename", "Check settings.json.");
    const next = {
      ...previous,
      projectPathLinks: [
        { text: "settings.json", filePath: "src/settings.json" },
      ],
    };

    expect(canReuseRenderItem(previous, next)).toBe(false);
  });
});

describe("annotateProjectPathLinksHtml", () => {
  it("links basename text through the current session project", () => {
    const result = annotateProjectPathLinksHtml(
      "<p>Open <code>settings.json</code>.</p>",
      [{ text: "settings.json", filePath: "src/settings.json" }],
      "project-1",
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const anchor = template.content.querySelector("a");

    expect(result.changed).toBe(true);
    expect(anchor?.textContent).toBe("settings.json");
    expect(anchor?.getAttribute("data-ya-path")).toBe("src/settings.json");
    expect(anchor?.getAttribute("data-ya-project-id")).toBe("project-1");
    expect(anchor?.getAttribute("href")).toBe(
      "/projects/project-1/file?path=src%2Fsettings.json",
    );
  });

  it("retargets an exact bare-path anchor to the prefix-causal alias", () => {
    const result = annotateProjectPathLinksHtml(
      '<p><a data-ya-resource="project-file" data-ya-project-id="project-1" data-ya-path="settings.json" href="/old">settings.json</a></p>',
      [{ text: "settings.json", filePath: "src/settings.json" }],
      "project-1",
    );
    const template = document.createElement("template");
    template.innerHTML = result.html;

    expect(
      template.content.querySelector("a")?.getAttribute("data-ya-path"),
    ).toBe("src/settings.json");
  });
});
