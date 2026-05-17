import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "../../src/augments/safe-markdown.js";

describe("renderSafeMarkdown local file links", () => {
  it("renders local non-media file links as file links", () => {
    const html = renderSafeMarkdown("[summary](./tmp/summary.txt)");

    expect(html).toContain('class="file-link local-file-link"');
    expect(html).toContain('data-file-path="./tmp/summary.txt"');
    expect(html).not.toContain("/api/local-image");
  });

  it("keeps local media links pointed at the local-image API", () => {
    const html = renderSafeMarkdown("[preview](/tmp/screenshot.png)");

    expect(html).toContain('class="local-media-link"');
    expect(html).toContain("/api/local-image?path=%2Ftmp%2Fscreenshot.png");
  });
});
