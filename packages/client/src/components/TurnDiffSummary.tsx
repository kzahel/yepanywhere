import { memo, useMemo, useState } from "react";
import { useSessionMetadata } from "../contexts/SessionMetadataContext";
import type { RenderItem, ToolCallItem } from "../types/renderItems";
import type { PatchHunk } from "./renderers/tools/types";
import { Modal } from "./ui/Modal";

interface EditInputWithAugment {
  file_path?: string;
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
  _rawPatch?: string;
}

interface EditStructuredResult {
  filePath?: string;
  structuredPatch?: PatchHunk[];
}

export interface TurnDiffEntry {
  id: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  diffHtml?: string;
  additions: number;
  deletions: number;
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

export function collectTurnDiffEntries(items: RenderItem[]): TurnDiffEntry[] {
  const entries: TurnDiffEntry[] = [];

  for (const item of items) {
    if (!isEditToolCall(item) || item.status !== "complete") {
      continue;
    }

    const input = (item.toolInput ?? {}) as EditInputWithAugment;
    const structured = (item.toolResult?.structured ??
      {}) as EditStructuredResult;
    const structuredPatch =
      structured.structuredPatch ?? input._structuredPatch ?? [];
    if (structuredPatch.length === 0) {
      continue;
    }

    const filePath =
      structured.filePath ??
      input.file_path ??
      extractFilePathFromRawPatch(input._rawPatch);
    if (!filePath) {
      continue;
    }

    const { additions, deletions } = countPatchChanges(structuredPatch);
    entries.push({
      id: item.id,
      filePath,
      structuredPatch,
      diffHtml: input._diffHtml,
      additions,
      deletions,
    });
  }

  return entries;
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
