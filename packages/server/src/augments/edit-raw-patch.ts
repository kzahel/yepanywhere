import type { PatchHunk } from "@yep-anywhere/shared";

const PATCH_START_MARKER = "*** Begin Patch";
const PATCH_END_MARKER = "*** End Patch";
const FILE_HEADER_PREFIXES = [
  "*** Update File:",
  "*** Add File:",
  "*** Delete File:",
] as const;
const MOVE_HEADER_PREFIX = "*** Move to:";
const HUNK_HEADER_REGEX =
  /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?)?(?: @@.*)?$/;

export interface ParsedRawEditPatch {
  structuredPatch: PatchHunk[];
  filePath?: string;
  rawPatch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFilePath(line: string): string | undefined {
  for (const prefix of FILE_HEADER_PREFIXES) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return undefined;
}

function extractFileHeader(
  line: string,
): { operation: "update" | "add" | "delete"; filePath: string } | undefined {
  if (line.startsWith("*** Update File:")) {
    return {
      operation: "update",
      filePath: line.slice("*** Update File:".length).trim(),
    };
  }
  if (line.startsWith("*** Add File:")) {
    return {
      operation: "add",
      filePath: line.slice("*** Add File:".length).trim(),
    };
  }
  if (line.startsWith("*** Delete File:")) {
    return {
      operation: "delete",
      filePath: line.slice("*** Delete File:".length).trim(),
    };
  }
  return undefined;
}

function countOldLines(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === " " || prefix === "-") {
      count++;
    }
  }
  return count;
}

function countNewLines(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === " " || prefix === "+") {
      count++;
    }
  }
  return count;
}

function changeKind(change: Record<string, unknown>): string | undefined {
  const kind = change.kind ?? change.type;
  if (typeof kind === "string") return kind;
  if (isRecord(kind) && typeof kind.type === "string") return kind.type;
  return undefined;
}

/**
 * Codex reports an added or deleted file's whole content in `diff`, not a
 * unified diff; render it as the single hunk that creates or removes it.
 */
function wholeFileHunk(content: string, kind: "add" | "delete"): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const marker = kind === "add" ? "+" : "-";
  const range =
    kind === "add" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
  return [`@@ ${range} @@`, ...lines.map((line) => marker + line)].join("\n");
}

function extractRawPatchFromChanges(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) {
    return undefined;
  }

  const diffs = changes
    .map((change) => {
      if (!isRecord(change)) return null;
      const diff = change.diff ?? change.unified_diff;
      if (typeof diff !== "string") return null;
      const kind = changeKind(change);
      if ((kind === "add" || kind === "delete") && diff) {
        return wholeFileHunk(diff, kind);
      }
      const trimmed = diff.trim();
      return trimmed ? trimmed : null;
    })
    .filter((diff): diff is string => typeof diff === "string");

  if (diffs.length === 0) {
    return undefined;
  }

  return diffs.join("\n\n");
}

export function extractRawPatchFromEditInput(
  input: unknown,
): string | undefined {
  if (typeof input === "string") {
    return input;
  }

  if (!isRecord(input)) {
    return undefined;
  }

  const directKeys = [
    "_rawPatch",
    "patch",
    "rawPatch",
    "raw_patch",
    "content",
    "text",
    "raw",
    "diff",
  ];
  for (const key of directKeys) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }

  const patchFromChanges = extractRawPatchFromChanges(input.changes);
  if (patchFromChanges) {
    return patchFromChanges;
  }

  const nestedInput = input.input;
  if (typeof nestedInput === "string") {
    return nestedInput;
  }
  if (isRecord(nestedInput)) {
    return extractRawPatchFromEditInput(nestedInput);
  }

  return undefined;
}

function normalizeUnifiedPath(pathToken: string): string | undefined {
  const token = pathToken.trim().split(/\s+/)[0] ?? "";
  if (!token || token === "/dev/null") {
    return undefined;
  }
  return token.replace(/^[ab]\//, "");
}

function extractUnifiedFilePath(line: string): string | undefined {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return normalizeUnifiedPath(line.slice(4));
  }

  if (line.startsWith("diff --git ")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4) {
      return normalizeUnifiedPath(parts[3] ?? parts[2] ?? "");
    }
  }

  return undefined;
}

/**
 * Return every file path named by an apply-patch or unified-diff payload.
 * Unlike the preview parser's singular `filePath`, attribution needs all
 * paths in a multi-file patch, including both sides of a move.
 */
export function extractRawPatchFilePaths(rawPatch: string): string[] {
  const paths = new Set<string>();
  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    const fileHeaderPath = extractFilePath(line);
    if (fileHeaderPath) {
      paths.add(fileHeaderPath);
      continue;
    }
    if (line.startsWith(MOVE_HEADER_PREFIX)) {
      const movedPath = line.slice(MOVE_HEADER_PREFIX.length).trim();
      if (movedPath) paths.add(movedPath);
      continue;
    }
    const unifiedPath = extractUnifiedFilePath(line);
    if (unifiedPath) paths.add(unifiedPath);
  }

  return [...paths];
}

function isUnifiedFileHeaderStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.startsWith("--- ")) {
    return false;
  }
  const next = lines[index + 1] ?? "";
  return next.startsWith("+++ ");
}

function parsePatchLines(
  lines: string[],
  requireApplyMarkers: boolean,
): { structuredPatch: PatchHunk[]; filePath?: string } {
  const structuredPatch: PatchHunk[] = [];

  let filePath: string | undefined;
  let inPatch = !requireApplyMarkers;
  let nextOldStart = 1;
  let nextNewStart = 1;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!inPatch) {
      if (line === PATCH_START_MARKER) {
        inPatch = true;
      }
      i++;
      continue;
    }

    if (requireApplyMarkers && line === PATCH_END_MARKER) {
      break;
    }

    const fileHeader = extractFileHeader(line);
    if (fileHeader) {
      if (!filePath) {
        filePath = fileHeader.filePath;
      }
      if (requireApplyMarkers && fileHeader.operation === "add") {
        const hunkLines: string[] = [];
        i++;
        while (i < lines.length) {
          const hunkLine = lines[i] ?? "";
          if (
            hunkLine === PATCH_END_MARKER ||
            hunkLine.startsWith("*** Update File:") ||
            hunkLine.startsWith("*** Add File:") ||
            hunkLine.startsWith("*** Delete File:")
          ) {
            break;
          }
          if (hunkLine.startsWith("+")) {
            hunkLines.push(hunkLine);
          }
          i++;
        }
        if (hunkLines.length > 0) {
          structuredPatch.push({
            oldStart: nextOldStart,
            oldLines: 0,
            newStart: nextNewStart,
            newLines: hunkLines.length,
            lines: hunkLines,
          });
          nextNewStart += hunkLines.length;
        }
        continue;
      }
      i++;
      continue;
    }

    if (!filePath) {
      const unifiedFilePath = extractUnifiedFilePath(line);
      if (unifiedFilePath) {
        filePath = unifiedFilePath;
      }
    }

    const headerMatch = line.match(HUNK_HEADER_REGEX);
    if (!headerMatch) {
      i++;
      continue;
    }

    const oldStartRaw = headerMatch[1];
    const oldLinesRaw = headerMatch[2];
    const newStartRaw = headerMatch[3];
    const newLinesRaw = headerMatch[4];
    const hasRanges = oldStartRaw !== undefined && newStartRaw !== undefined;

    const hunkLines: string[] = [];
    i++;

    while (i < lines.length) {
      const hunkLine = lines[i] ?? "";
      const isBoundary = requireApplyMarkers
        ? hunkLine === PATCH_END_MARKER ||
          hunkLine.startsWith("@@") ||
          !!extractFilePath(hunkLine)
        : hunkLine.startsWith("@@") ||
          hunkLine.startsWith("diff --git ") ||
          isUnifiedFileHeaderStart(lines, i);
      if (isBoundary) {
        break;
      }

      if (hunkLine === "\\ No newline at end of file") {
        i++;
        continue;
      }

      const prefix = hunkLine[0];
      if (prefix === " " || prefix === "-" || prefix === "+") {
        hunkLines.push(hunkLine);
      }

      i++;
    }

    if (hunkLines.length === 0) {
      continue;
    }

    const oldStart = hasRanges ? Number(oldStartRaw) : nextOldStart;
    const newStart = hasRanges ? Number(newStartRaw) : nextNewStart;
    const oldLines = hasRanges
      ? Number(oldLinesRaw ?? "1")
      : countOldLines(hunkLines);
    const newLines = hasRanges
      ? Number(newLinesRaw ?? "1")
      : countNewLines(hunkLines);

    structuredPatch.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: hunkLines,
    });

    nextOldStart = oldStart + oldLines;
    nextNewStart = newStart + newLines;
  }

  return { structuredPatch, filePath };
}

export function parseRawEditPatch(rawPatch: string): ParsedRawEditPatch | null {
  try {
    const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
    if (rawPatch.includes(PATCH_START_MARKER)) {
      const parsedApplyPatch = parsePatchLines(lines, true);
      return {
        structuredPatch: parsedApplyPatch.structuredPatch,
        filePath: parsedApplyPatch.filePath,
        rawPatch,
      };
    }

    const parsedUnifiedDiff = parsePatchLines(lines, false);
    if (parsedUnifiedDiff.structuredPatch.length === 0) {
      return null;
    }

    return {
      structuredPatch: parsedUnifiedDiff.structuredPatch,
      filePath: parsedUnifiedDiff.filePath,
      rawPatch,
    };
  } catch {
    return null;
  }
}
