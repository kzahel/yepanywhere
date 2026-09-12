import type { RenderItem, SystemItem } from "./items.js";

function isCompactBoundaryItem(
  item: RenderItem,
): item is SystemItem & { subtype: "compact_boundary" } {
  return item.type === "system" && item.subtype === "compact_boundary";
}

function hasSystemCompactBoundarySource(item: SystemItem): boolean {
  return item.sourceMessages.some(
    (source) =>
      source.type === "system" &&
      (source as { subtype?: string }).subtype === "compact_boundary",
  );
}

function orderCompactDetails(
  details: NonNullable<SystemItem["details"]>,
): NonNullable<SystemItem["details"]> {
  // Prefer human summary bodies before compactMetadata JSON dumps.
  const meta: NonNullable<SystemItem["details"]> = [];
  const rest: NonNullable<SystemItem["details"]> = [];
  for (const detail of details) {
    if (typeof detail === "string" && detail.startsWith("compactMetadata:")) {
      meta.push(detail);
    } else {
      rest.push(detail);
    }
  }
  return [...rest, ...meta];
}

function mergeCompactBoundaryRun(
  run: Array<SystemItem & { subtype: "compact_boundary" }>,
): SystemItem {
  const first = run[0];
  if (!first) {
    throw new Error("Cannot merge an empty compact boundary run");
  }
  const preferred = run.find(hasSystemCompactBoundarySource) ?? first;
  const sourceMessages = run.flatMap((item) => item.sourceMessages);
  const details = orderCompactDetails(
    run.flatMap((item) => item.details ?? []),
  );
  return {
    type: "system",
    id: preferred.id,
    subtype: "compact_boundary",
    content: preferred.content,
    status: preferred.status,
    configChanged: preferred.configChanged,
    isSubagent: preferred.isSubagent,
    sourceMessages,
    details: details.length > 0 ? details : undefined,
  };
}

export function coalesceCompactBoundaryItems(
  items: RenderItem[],
): RenderItem[] {
  const coalesced: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (!item || !isCompactBoundaryItem(item)) {
      if (item) {
        coalesced.push(item);
      }
      index += 1;
      continue;
    }

    const run: Array<SystemItem & { subtype: "compact_boundary" }> = [item];
    let runIndex = index + 1;
    while (runIndex < items.length) {
      const runItem = items[runIndex];
      if (!runItem || !isCompactBoundaryItem(runItem)) {
        break;
      }
      run.push(runItem);
      runIndex += 1;
    }
    coalesced.push(mergeCompactBoundaryRun(run));
    index = runIndex;
  }

  return coalesced;
}
