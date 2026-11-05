import type { PatchHunk } from "@yep-anywhere/shared";
import { memo, type ReactNode, useMemo } from "react";
import {
  buildSideBySideRows,
  parseDiffLineFragments,
} from "../lib/diffSideBySide";
import { ReviewCommentSplitLayout } from "./ReviewCommentSplitLayout";
import { DiffHunks } from "./DiffHunk";

/**
 * Side-by-side diff (topic: source-review-to-session, P8). The server already
 * highlighted every line once; this arranges those per-line fragments into two
 * columns from `structuredPatch` — old (`-`) on the left, new (`+`) on the
 * right — rather than asking the server to render a second time. Each cell
 * keeps the line's `data-diff-line` (so the comment click/tint contract holds)
 * and carries `data-diff-col`, so a left-column click anchors the old side and
 * a right-column click the new side.
 */
export const SideBySideDiff = memo(function SideBySideDiff({
  diffHtml,
  structuredPatch,
  splitAfterLine,
  editor = null,
}: {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  splitAfterLine?: number;
  editor?: ReactNode;
}) {
  const fragments = useMemo(() => parseDiffLineFragments(diffHtml), [diffHtml]);
  const rows = useMemo(
    () => buildSideBySideRows(structuredPatch),
    [structuredPatch],
  );

  const splitIndex =
    splitAfterLine === undefined
      ? -1
      : rows.findIndex(
          (row) =>
            row.type === "line" &&
            (row.left === splitAfterLine || row.right === splitAfterLine),
        );

  if (splitIndex < 0 || !editor) {
    return <SideBySideRows rows={rows} fragments={fragments} />;
  }

  return (
    <ReviewCommentSplitLayout
      before={
        <SideBySideRows
          rows={rows.slice(0, splitIndex + 1)}
          fragments={fragments}
        />
      }
      editor={editor}
      after={
        <SideBySideRows
          rows={rows.slice(splitIndex + 1)}
          fragments={fragments}
        />
      }
    />
  );
});

function SideBySideRows({
  rows,
  fragments,
}: {
  rows: ReturnType<typeof buildSideBySideRows>;
  fragments: Map<number, string>;
}) {
  return (
    <DiffHunks
      rows={rows.map((row) =>
        row.type === "header"
          ? row
          : {
              type: "line",
              cells: [
                cellHtml(fragments, row.left),
                cellHtml(fragments, row.right),
              ],
            },
      )}
    />
  );
}

function cellHtml(
  fragments: Map<number, string>,
  index: number | null,
): string | null {
  if (index === null) return null;
  return fragments.get(index) ?? null;
}
