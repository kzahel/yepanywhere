import { memo, useMemo, useState } from "react";
import { useSessionMetadata } from "../contexts/SessionMetadataContext";
import type { RenderItem, ToolCallItem } from "../types/renderItems";
import type { PatchHunk } from "./renderers/tools/types";
import { Modal } from "./ui/Modal";

interface EditInputWithAugment {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
  _rawPatch?: string;
}

interface EditStructuredResult {
  filePath?: string;
  structuredPatch?: PatchHunk[];
  oldString?: string;
  newString?: string;
  originalFile?: string;
  replaceAll?: boolean;
}

export interface TurnDiffEntry {
  id: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  diffHtml?: string;
  additions: number;
  deletions: number;
}

interface AggregatedTurnDiffEntry extends TurnDiffEntry {
  baseOriginalFile?: string;
  currentContent?: string;
  canRebuildFinalDiff: boolean;
}

function isEditToolCall(item: RenderItem): item is ToolCallItem {
  return item.type === "tool_call" && item.toolName === "Edit";
}

function extractFilePathFromRawPatch(rawPatch?: string): string | undefined {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    return undefined;
  }

  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function countPatchChanges(structuredPatch: PatchHunk[]) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
}

function applyEditToContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null {
  if (oldString === "") {
    return `${newString}${content}`;
  }

  if (!content.includes(oldString)) {
    return null;
  }

  if (replaceAll) {
    return content.split(oldString).join(newString);
  }

  return content.replace(oldString, newString);
}

function buildStructuredPatchFromContents(
  oldContent: string,
  newContent: string,
): PatchHunk[] {
  if (oldContent === newContent) {
    return [];
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const dp: number[][] = Array.from({ length: oldLen + 1 }, () =>
    Array<number>(newLen + 1).fill(0),
  );

  for (let i = oldLen - 1; i >= 0; i -= 1) {
    for (let j = newLen - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i]}`);
      i += 1;
      j += 1;
      continue;
    }

    if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      lines.push(`-${oldLines[i]}`);
      i += 1;
    } else {
      lines.push(`+${newLines[j]}`);
      j += 1;
    }
  }

  while (i < oldLen) {
    lines.push(`-${oldLines[i]}`);
    i += 1;
  }

  while (j < newLen) {
    lines.push(`+${newLines[j]}`);
    j += 1;
  }

  return [
    {
      oldStart: 1,
      oldLines: oldLen,
      newStart: 1,
      newLines: newLen,
      lines,
    },
  ];
}

export function collectTurnDiffEntries(items: RenderItem[]): TurnDiffEntry[] {
  const entriesByFilePath = new Map<string, AggregatedTurnDiffEntry>();
  const entryOrder: string[] = [];

  for (const item of items) {
    if (!isEditToolCall(item) || item.status !== "complete") {
      continue;
    }

    const input = (item.toolInput ?? {}) as EditInputWithAugment;
    const structured = (item.toolResult?.structured ??
      {}) as EditStructuredResult;
    const structuredPatch =
      structured.structuredPatch ?? input._structuredPatch ?? [];

    const filePath =
      structured.filePath ??
      input.file_path ??
      extractFilePathFromRawPatch(input._rawPatch);
    if (!filePath) {
      continue;
    }

    const oldString = structured.oldString ?? input.old_string;
    const newString = structured.newString ?? input.new_string;
    const originalFile = structured.originalFile;
    const replaceAll = structured.replaceAll ?? input.replace_all ?? false;
    const canRebuildFromContent =
      typeof originalFile === "string" &&
      typeof oldString === "string" &&
      typeof newString === "string";

    if (structuredPatch.length === 0 && !canRebuildFromContent) {
      continue;
    }
    const existingEntry = entriesByFilePath.get(filePath);
    if (existingEntry) {
      existingEntry.id = item.id;

      if (
        existingEntry.canRebuildFinalDiff &&
        existingEntry.currentContent !== undefined &&
        typeof oldString === "string" &&
        typeof newString === "string"
      ) {
        const nextContent = applyEditToContent(
          existingEntry.currentContent,
          oldString,
          newString,
          replaceAll,
        );

        if (nextContent !== null) {
          const diffBase =
            existingEntry.baseOriginalFile ?? existingEntry.currentContent;
          existingEntry.currentContent = nextContent;
          existingEntry.structuredPatch = buildStructuredPatchFromContents(
            diffBase,
            nextContent,
          );
          const counts = countPatchChanges(existingEntry.structuredPatch);
          existingEntry.additions = counts.additions;
          existingEntry.deletions = counts.deletions;
          existingEntry.diffHtml = undefined;
          continue;
        }
      }

      // Rebuild path failed — try using this edit's originalFile as a new base
      if (canRebuildFromContent && typeof originalFile === "string") {
        const nextContent = applyEditToContent(
          originalFile,
          oldString as string,
          newString as string,
          replaceAll,
        );
        if (nextContent !== null) {
          const base = existingEntry.baseOriginalFile ?? originalFile;
          existingEntry.baseOriginalFile = base;
          existingEntry.currentContent = nextContent;
          existingEntry.canRebuildFinalDiff = true;
          existingEntry.structuredPatch = buildStructuredPatchFromContents(
            base,
            nextContent,
          );
          const counts = countPatchChanges(existingEntry.structuredPatch);
          existingEntry.additions = counts.additions;
          existingEntry.deletions = counts.deletions;
          existingEntry.diffHtml = undefined;
          continue;
        }
      }

      existingEntry.canRebuildFinalDiff = false;
      if (structuredPatch.length > 0) {
        existingEntry.structuredPatch.push(...structuredPatch);
        const mergedCounts = countPatchChanges(existingEntry.structuredPatch);
        existingEntry.additions = mergedCounts.additions;
        existingEntry.deletions = mergedCounts.deletions;
        existingEntry.diffHtml = undefined;
      }
      continue;
    }

    const initialEntry: AggregatedTurnDiffEntry = {
      id: item.id,
      filePath,
      structuredPatch: [...structuredPatch],
      diffHtml: input._diffHtml,
      additions: 0,
      deletions: 0,
      baseOriginalFile: originalFile,
      currentContent: undefined,
      canRebuildFinalDiff: false,
    };

    if (
      typeof originalFile === "string" &&
      typeof oldString === "string" &&
      typeof newString === "string"
    ) {
      const nextContent = applyEditToContent(
        originalFile,
        oldString,
        newString,
        replaceAll,
      );
      if (nextContent !== null) {
        initialEntry.baseOriginalFile = originalFile;
        initialEntry.currentContent = nextContent;
        initialEntry.canRebuildFinalDiff = true;
        initialEntry.structuredPatch = buildStructuredPatchFromContents(
          originalFile,
          nextContent,
        );
        initialEntry.diffHtml = undefined;
      }
    }

    const initialCounts = countPatchChanges(initialEntry.structuredPatch);
    initialEntry.additions = initialCounts.additions;
    initialEntry.deletions = initialCounts.deletions;

    entriesByFilePath.set(filePath, initialEntry);
    entryOrder.push(filePath);
  }

  return entryOrder
    .map((filePath) => entriesByFilePath.get(filePath))
    .filter((entry): entry is AggregatedTurnDiffEntry => entry !== undefined)
    .map(({ id, filePath, structuredPatch, diffHtml, additions, deletions }) => ({
      id,
      filePath,
      structuredPatch,
      diffHtml,
      additions,
      deletions,
    }));
}

function getRelativePath(filePath: string, projectPath: string | null): string {
  if (projectPath && filePath.startsWith(projectPath)) {
    const relative = filePath.slice(projectPath.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return filePath;
}

function splitDisplayPath(filePath: string): {
  directory: string;
  fileName: string;
} {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return { directory: "", fileName: normalized };
  }

  return {
    directory: normalized.slice(0, lastSlash + 1),
    fileName: normalized.slice(lastSlash + 1),
  };
}

const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${i}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

export const TurnDiffSummary = memo(function TurnDiffSummary({
  items,
}: {
  items: RenderItem[];
}) {
  const { projectPath } = useSessionMetadata();
  const entries = useMemo(() => collectTurnDiffEntries(items), [items]);
  const [selectedEntry, setSelectedEntry] = useState<TurnDiffEntry | null>(
    null,
  );

  if (entries.length === 0) {
    return null;
  }

  const totalAdditions = entries.reduce(
    (sum, entry) => sum + entry.additions,
    0,
  );
  const totalDeletions = entries.reduce(
    (sum, entry) => sum + entry.deletions,
    0,
  );

  return (
    <>
      <div className="turn-diff-summary timeline-item">
        <div className="turn-diff-summary-header">
          <div className="turn-diff-summary-heading">
            <span className="turn-diff-summary-title">Changes</span>
            <span className="turn-diff-summary-count">
              {entries.length} files
            </span>
          </div>
          <span className="git-line-counts turn-diff-total-counts">
            <span className="git-lines-added">+{totalAdditions}</span>
            <span className="git-lines-deleted">-{totalDeletions}</span>
          </span>
        </div>
        <ul className="git-file-list turn-diff-file-list">
          {entries.map((entry) => {
            const displayPath = getRelativePath(entry.filePath, projectPath);
            const { directory, fileName } = splitDisplayPath(displayPath);

            return (
              <li key={entry.id} className="git-file-item turn-diff-file-item">
                <button
                  type="button"
                  className="turn-diff-file-button"
                  onClick={() => setSelectedEntry(entry)}
                >
                  <span className="turn-diff-path">
                    {directory ? (
                      <span className="turn-diff-path-directory">
                        {directory}
                      </span>
                    ) : null}
                    <span className="turn-diff-path-filename">{fileName}</span>
                  </span>
                  <span className="git-line-counts turn-diff-line-counts">
                    <span className="git-lines-added">+{entry.additions}</span>
                    <span className="git-lines-deleted">
                      -{entry.deletions}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {selectedEntry && (
        <Modal
          title={getRelativePath(selectedEntry.filePath, projectPath)}
          onClose={() => setSelectedEntry(null)}
        >
          <div className="diff-modal-content">
            <div className="diff-context-controls">
              <span className="diff-context-path">
                {getRelativePath(selectedEntry.filePath, projectPath)}
              </span>
            </div>
            {selectedEntry.diffHtml ? (
              <HighlightedDiff diffHtml={selectedEntry.diffHtml} />
            ) : (
              <DiffLines
                lines={selectedEntry.structuredPatch.flatMap((h) => h.lines)}
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
});
