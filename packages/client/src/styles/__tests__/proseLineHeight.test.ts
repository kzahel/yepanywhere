// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

describe("prose line height", () => {
  it("floors body prose so the tightest line spacing cannot overlap", async () => {
    const [indexCss, rendererCss] = await Promise.all([
      readClientStyles("tokens"),
      readClientStyles("generated", "renderers"),
    ]);

    expect(indexCss).toMatch(
      /--output-prose-line-height:\s*max\(\s*1\.1em,[\s\S]*?var\(--output-prose-line-height-offset\)[\s\S]*?\);/,
    );
    expect(indexCss).toMatch(
      /--thinking-prose-line-height:\s*max\(\s*1\.1em,[\s\S]*?var\(--thinking-prose-line-height-offset\)[\s\S]*?\);/,
    );
    expect(rendererCss).toMatch(
      /\.markdown-preview \.markdown-rendered\s*\{[\s\S]*?line-height:\s*max\(\s*1\.1em,[\s\S]*?\}/,
    );
  });

  it("resolves heading line height against the heading's own font size", async () => {
    const rendererCss = await readClientStyles("generated", "renderers");

    // An inherited em line height computes at body size, so a wrapped heading
    // would draw its second line on top of the first.
    expect(rendererCss).toMatch(
      /\.markdown-preview \.markdown-rendered :is\(h1, h2, h3, h4, h5, h6\),[\s\S]*?\.text-block :is\(h1, h2, h3, h4, h5, h6\),[\s\S]*?line-height:\s*max\(\s*1\.15em,[\s\S]*?\}/,
    );
  });
});
