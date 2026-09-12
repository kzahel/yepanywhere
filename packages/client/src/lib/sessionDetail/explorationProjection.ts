import type { ToolDisplayAction } from "@yep-anywhere/shared";
import { getExplorationKind } from "../toolNames";
import type {
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import { getLatestMessageTimestampMs } from "../messageAge";
import { getPathBasename } from "../text";

export const EXPLORATION_GROUP_MAX_GAP_MS = 5 * 60 * 1000;

export interface ExplorationEntry {
  id: string;
  parentId: string;
  sourceIndex: number;
  kind: "read" | "search" | "list";
  path?: string;
  absolutePath?: string;
  name?: string;
  query?: string;
  startLine?: number;
  endLine?: number;
}

export interface ExplorationParent {
  item: ToolCallItem;
  entries: ExplorationEntry[];
}

export interface ExplorationProjection {
  id: string;
  disclosureOwnerId: string;
  parents: ExplorationParent[];
  entries: ExplorationEntry[];
}

export type ExplorationProjectionSegment =
  | { kind: "item"; item: RenderItem }
  | { kind: "explored"; projection: ExplorationProjection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: unknown, fields: readonly string[]): string {
  if (!isRecord(input)) return "";
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function positiveIntegerField(
  input: unknown,
  fields: readonly string[],
): number | undefined {
  if (!isRecord(input)) return undefined;
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function entryId(parentId: string, sourceIndex: number): string {
  return `${parentId}:${sourceIndex}`;
}

function displayActionEntry(
  parentId: string,
  action: ToolDisplayAction,
  sourceIndex: number,
): ExplorationEntry | null {
  const base = {
    id: entryId(parentId, sourceIndex),
    parentId,
    sourceIndex,
  };

  switch (action.kind) {
    case "read":
      if (!action.path || !action.name) return null;
      return {
        ...base,
        kind: "read",
        path: action.path,
        ...(action.absolutePath ? { absolutePath: action.absolutePath } : {}),
        name: action.name,
        ...(action.startLine !== undefined
          ? { startLine: action.startLine }
          : {}),
        ...(action.endLine !== undefined ? { endLine: action.endLine } : {}),
      };
    case "search":
      if (!action.query) return null;
      return {
        ...base,
        kind: "search",
        query: action.query,
        ...(action.path ? { path: action.path } : {}),
      };
    case "list":
      return {
        ...base,
        kind: "list",
        ...(action.path ? { path: action.path } : {}),
      };
    default:
      return null;
  }
}

function entriesFromDisplayActions(
  item: ToolCallItem,
): ExplorationEntry[] | null {
  if (!item.displayActions || item.displayActions.length === 0) return null;
  const entries = item.displayActions.map((action, sourceIndex) =>
    displayActionEntry(item.id, action, sourceIndex),
  );
  if (!entries.every((entry): entry is ExplorationEntry => entry !== null)) {
    return null;
  }
  return entries;
}

function canonicalExplorationEntry(
  item: ToolCallItem,
): ExplorationEntry | null {
  const kind = getExplorationKind(item.toolName);
  if (!kind) return null;

  const base = {
    id: entryId(item.id, 0),
    parentId: item.id,
    sourceIndex: 0,
    kind,
  };
  if (kind === "read") {
    const path = stringField(item.toolInput, [
      "file_path",
      "target_file",
      "path",
    ]);
    const startLine = positiveIntegerField(item.toolInput, [
      "start_line",
      "startLine",
      "offset",
    ]);
    const explicitEndLine = positiveIntegerField(item.toolInput, [
      "end_line",
      "endLine",
    ]);
    const limit = positiveIntegerField(item.toolInput, ["limit"]);
    const endLine =
      explicitEndLine ??
      (startLine !== undefined && limit !== undefined
        ? startLine + limit - 1
        : undefined);
    return {
      ...base,
      ...(path ? { path, name: getPathBasename(path) } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    };
  }

  if (kind === "search") {
    const query = stringField(item.toolInput, ["pattern", "query"]);
    const path = stringField(item.toolInput, [
      "path",
      "target_directory",
      "directory",
      "glob",
    ]);
    return {
      ...base,
      ...(query ? { query } : {}),
      ...(path ? { path } : {}),
    };
  }

  const path = stringField(item.toolInput, [
    "path",
    "target_directory",
    "directory",
  ]);
  return { ...base, ...(path ? { path } : {}) };
}

/** Project one provider-neutral tool parent into ordered semantic entries. */
export function projectExplorationParent(
  item: ToolCallItem,
): ExplorationParent | null {
  const displayEntries = entriesFromDisplayActions(item);
  if (displayEntries) {
    return { item, entries: displayEntries };
  }
  const canonicalEntry = canonicalExplorationEntry(item);
  return canonicalEntry ? { item, entries: [canonicalEntry] } : null;
}

export function explorationParentsAreTooFarApart(
  previous: ExplorationParent,
  next: ExplorationParent,
): boolean {
  const previousTimestampMs = getLatestMessageTimestampMs(
    previous.item.sourceMessages,
  );
  const nextTimestampMs = getLatestMessageTimestampMs(next.item.sourceMessages);
  if (previousTimestampMs === null || nextTimestampMs === null) return false;
  return (
    Math.abs(nextTimestampMs - previousTimestampMs) >
    EXPLORATION_GROUP_MAX_GAP_MS
  );
}

export function createExplorationProjection(
  parents: readonly ExplorationParent[],
): ExplorationProjection {
  const first = parents[0]?.item.id ?? "start";
  const last = parents[parents.length - 1]?.item.id ?? "end";
  return {
    id: `explored-${first}-${last}`,
    disclosureOwnerId: first,
    parents: [...parents],
    entries: parents.flatMap((parent) => parent.entries),
  };
}

/**
 * Build the semantic explored projection that S5 will render. A group needs
 * either several adjacent exploration parents or one parent with several
 * ordered entries. Unknown/mutating parents and the established time gap split
 * groups. Parent items retain all status, result, raw-detail, and debug data.
 */
export function buildExplorationProjectionSegments(
  items: readonly RenderItem[],
): ExplorationProjectionSegment[] {
  const segments: ExplorationProjectionSegment[] = [];
  let run: ExplorationParent[] = [];

  const flushRun = () => {
    if (
      run.length >= 2 ||
      (run.length === 1 && (run[0]?.entries.length ?? 0) >= 2)
    ) {
      segments.push({
        kind: "explored",
        projection: createExplorationProjection(run),
      });
    } else if (run[0]) {
      segments.push({ kind: "item", item: run[0].item });
    }
    run = [];
  };

  for (const item of items) {
    const parent =
      item.type === "tool_call" ? projectExplorationParent(item) : null;
    if (!parent) {
      flushRun();
      segments.push({ kind: "item", item });
      continue;
    }

    const previous = run[run.length - 1];
    if (previous && explorationParentsAreTooFarApart(previous, parent)) {
      flushRun();
    }
    run.push(parent);
  }

  flushRun();
  return segments;
}
