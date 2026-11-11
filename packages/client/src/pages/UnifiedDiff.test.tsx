import type { PatchHunk } from "@yep-anywhere/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnifiedDiff } from "./UnifiedDiff";

const HUNKS: PatchHunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [" before", "-old", "+new", " after"],
  },
];

describe("UnifiedDiff", () => {
  it("renders plain after-side text without patch syntax", () => {
    const { container } = render(
      <UnifiedDiff
        diffHtml=""
        structuredPatch={HUNKS}
        plain
        hideRemovedLines
      />,
    );

    const plain = container.querySelector('[data-diff-rendering="plain"]');
    expect(plain?.textContent).toBe("before\nnew\nafter");
    expect(
      plain?.querySelector("[data-diff-hunk-header], .line-hunk"),
    ).toBeNull();
  });
});
