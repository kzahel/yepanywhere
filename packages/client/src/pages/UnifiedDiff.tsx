import diffStyles from "../components/renderers/DiffOutput.module.css";
import type { PatchHunk } from "@yep-anywhere/shared";
import { Fragment, memo, type ReactNode, useMemo } from "react";
import { InnerHtml } from "../components/ui/InnerHtml";
import { parseDiffLineFragments } from "../lib/diffSideBySide";
import { ReviewCommentSplitLayout } from "./ReviewCommentSplitLayout";
import styles from "./UnifiedDiff.module.css";
import { DiffHunks } from "./DiffHunk";

type UnifiedRow =
  | { type: "header"; text: string }
  | { type: "line"; flatIndex: number; text: string };

export const CHANGED_DIFF_LINE_SELECTOR =
  ".line-deleted, .line-inserted, [data-diff-removed], [data-diff-added], .fixed-font-diff-removed, .fixed-font-diff-added";

export const UnifiedDiff = memo(function UnifiedDiff({
  diffHtml,
  structuredPatch,
  splitAfterLine,
  editor = null,
  plain = false,
  hideRemovedLines = false,
}: {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  splitAfterLine?: number;
  editor?: ReactNode;
  plain?: boolean;
  hideRemovedLines?: boolean;
}) {
  const fragments = useMemo(
    () =>
      plain
        ? new Map<number, string>()
        : parseDiffLineFragments(diffHtml, hideRemovedLines),
    [diffHtml, hideRemovedLines, plain],
  );
  const rows = useMemo(
    () => (plain ? [] : buildUnifiedRows(structuredPatch, hideRemovedLines)),
    [hideRemovedLines, plain, structuredPatch],
  );
  if (plain) {
    return (
      <PlainUnifiedRows
        hunks={structuredPatch}
        hideRemovedLines={hideRemovedLines}
      />
    );
  }

  const splitIndex =
    splitAfterLine === undefined
      ? -1
      : rows.findIndex(
          (row) => row.type === "line" && row.flatIndex === splitAfterLine,
        );

  if (splitIndex < 0 || !editor) {
    return (
      <UnifiedRows
        rows={rows}
        fragments={fragments}
        omitDiffPrefixes={hideRemovedLines}
      />
    );
  }

  return (
    <ReviewCommentSplitLayout
      before={
        <UnifiedRows
          rows={rows.slice(0, splitIndex + 1)}
          fragments={fragments}
          omitDiffPrefixes={hideRemovedLines}
        />
      }
      editor={editor}
      after={
        <UnifiedRows
          rows={rows.slice(splitIndex + 1)}
          fragments={fragments}
          omitDiffPrefixes={hideRemovedLines}
        />
      }
    />
  );
});

function PlainUnifiedRows({
  hunks,
  hideRemovedLines,
}: {
  hunks: PatchHunk[];
  hideRemovedLines: boolean;
}) {
  return (
    <div className={styles.plain} data-diff-rendering="plain">
      <pre>
        <code>
          {hunks.map((hunk, index) => (
            <Fragment key={`${hunk.oldStart}:${hunk.newStart}:${index}`}>
              {!hideRemovedLines && (
                <>
                  <span className={styles.hunkHeader} data-diff-hunk-header="">
                    {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                  </span>
                  {"\n"}
                </>
              )}
              {hunk.lines
                .filter((line) => !hideRemovedLines || !line.startsWith("-"))
                .map((line) => (hideRemovedLines ? line.slice(1) : line))
                .join("\n")}
              {index + 1 < hunks.length ? "\n" : ""}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

function buildUnifiedRows(
  hunks: PatchHunk[],
  hideRemovedLines: boolean,
): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  let flatIndex = 0;
  for (const hunk of hunks) {
    if (!hideRemovedLines) {
      rows.push({
        type: "header",
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      });
    }
    for (const line of hunk.lines) {
      if (!hideRemovedLines || !line.startsWith("-")) {
        rows.push({
          type: "line",
          flatIndex,
          text: line,
        });
      }
      flatIndex += 1;
    }
  }
  return rows;
}

function UnifiedRows({
  rows,
  fragments,
  omitDiffPrefixes,
}: {
  rows: UnifiedRow[];
  fragments: Map<number, string>;
  omitDiffPrefixes: boolean;
}) {
  const displayRows = rows.map((row) => {
    if (row.type === "header") {
      return row;
    }
    const html =
      fragments.get(row.flatIndex) ??
      `<span class="${fallbackClassName(row.text)}" data-diff-line="${row.flatIndex}">${omitDiffPrefixes ? "" : `<span class="${diffStyles.diffPrefix}">${escapeText(row.text[0] ?? " ")}</span>`}${escapeText(row.text.slice(1))}</span>`;
    return { type: "line" as const, cells: [html] };
  });
  // The after-side file projection has no hunk chrome or diff navigation.
  if (!omitDiffPrefixes) return <DiffHunks rows={displayRows} />;
  const html = displayRows
    .flatMap((row) => (row.type === "line" ? row.cells : []))
    .join("");
  // Server-highlighted diff rows.
  return (
    <InnerHtml
      className={diffStyles.highlightedDiff}
      data-highlighted-diff
      trustedHtml={`<pre class="shiki"><code>${html}</code></pre>`}
    />
  );
}

function fallbackClassName(line: string): string {
  return line[0] === "-"
    ? "line line-deleted"
    : line[0] === "+"
      ? "line line-inserted"
      : "line line-context";
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
