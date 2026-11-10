// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

describe("shared source-code typography", () => {
  it("drives source views from the fixed-font Appearance metrics", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readClientStyles("tokens", "index"),
      readClientStyles(
        "generated",
        "../components/renderers/DiffOutput.module",
        "../components/FileViewer.module",
      ),
    ]);

    expect(indexCss).toMatch(
      /--source-code-font-size:\s*max\([\s\S]*?var\(--fixed-font-size-base-raw\)[\s\S]*?var\(--source-font-size-offset,\s*0px\)[\s\S]*?\);/,
    );
    expect(indexCss).toMatch(
      /--source-code-line-height:\s*calc\([\s\S]*?var\(--output-prose-line-height-offset\)[\s\S]*?var\(--source-vspace-offset,\s*0px\)[\s\S]*?\);/,
    );
    expect(rendererCss).toMatch(
      /\.diffView\s*\{[\s\S]*?font-family:\s*var\(--font-mono\);[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
  });

  it("keeps blame source metrics with its local root", async () => {
    const css = await readClientStyles("../pages/BlameView.module");
    expect(css).toMatch(
      /\.root\s*\{[^}]*font-family:\s*var\(--font-mono\);[^}]*font-size:\s*var\(--source-code-font-size\);[^}]*line-height:\s*var\(--source-code-line-height\);/s,
    );
  });

  it("restores shared metrics inside zero-sized highlighted wrappers", async () => {
    const rendererCss = await readClientStyles(
      "generated",
      "../components/renderers/DiffOutput.module",
      "../components/FileViewer.module",
    );

    expect(rendererCss).toMatch(
      /\[data-highlighted-diff\] code\s*\{[\s\S]*?font-size:\s*0;[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /\[data-highlighted-diff\] \.line\s*\{[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /\.diffContent > div\s*\{[\s\S]*?line-height:\s*inherit;[\s\S]*?\}/,
    );
    expect(rendererCss).toMatch(
      /--file-viewer-code-line-box:\s*var\(--source-code-line-height\);/,
    );
    expect(
      await readFile(
        new URL(
          "../../pages/settings/AppearanceSettings.module.css",
          import.meta.url,
        ),
        "utf8",
      ),
    ).toMatch(
      /\.outputPreviewFixed\s*\{[\s\S]*?font-size:\s*var\(--source-code-font-size\);[\s\S]*?line-height:\s*var\(--source-code-line-height\);[\s\S]*?\}/,
    );
    const previewCss = await readFile(
      new URL("../../pages/GitStatusDiffPreview.module.css", import.meta.url),
      "utf8",
    );
    // The React pane must inherit the source metric from its generated child.
    expect(previewCss).not.toMatch(/\.sourceDiffPane\s*\{[^}]*font-size:/);
  });
});
