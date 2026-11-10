export interface DiffSelectionSnapshot {
  end: number;
  renderMode: "rendered" | "source";
  start: number;
  text: string;
}

function findTransferredSelection(
  fullText: string,
  snapshot: DiffSelectionSnapshot,
): { start: number; end: number } | null {
  if (fullText.slice(snapshot.start, snapshot.end) === snapshot.text) {
    return { start: snapshot.start, end: snapshot.end };
  }

  let bestStart = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let candidate = fullText.indexOf(snapshot.text);
  while (candidate >= 0) {
    const distance = Math.abs(candidate - snapshot.start);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStart = candidate;
    }
    candidate = fullText.indexOf(snapshot.text, candidate + 1);
  }

  return bestStart >= 0
    ? { start: bestStart, end: bestStart + snapshot.text.length }
    : null;
}

function getTextBoundary(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let traversed = 0;
  let lastTextNode: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    lastTextNode = node;
    const length = node.textContent?.length ?? 0;
    if (targetOffset <= traversed + length) {
      return { node, offset: targetOffset - traversed };
    }
    traversed += length;
  }

  return lastTextNode
    ? { node: lastTextNode, offset: lastTextNode.textContent?.length ?? 0 }
    : null;
}

export function captureDiffSelection(
  element: HTMLElement,
): DiffSelectionSnapshot | null {
  const root = element.querySelector<HTMLElement>(
    "[data-fixed-font-render-toggle]",
  );
  const renderMode = root?.dataset.renderMode;
  const selection = element.ownerDocument.getSelection();
  if (
    !root ||
    (renderMode !== "rendered" && renderMode !== "source") ||
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }

  const precedingRange = root.ownerDocument.createRange();
  precedingRange.selectNodeContents(root);
  precedingRange.setEnd(range.startContainer, range.startOffset);
  const start = precedingRange.cloneContents().textContent?.length ?? 0;
  const text = range.cloneContents().textContent ?? "";
  if (!text) return null;

  return {
    start,
    end: start + text.length,
    renderMode,
    text,
  };
}

export function restoreDiffSelection(
  container: HTMLElement,
  snapshot: DiffSelectionSnapshot,
): boolean {
  const root = container.querySelector<HTMLElement>(
    "[data-fixed-font-render-toggle]",
  );
  if (!root) return false;

  const offsets = findTransferredSelection(root.textContent ?? "", snapshot);
  if (!offsets) return false;
  const start = getTextBoundary(root, offsets.start);
  const end = getTextBoundary(root, offsets.end);
  if (!start || !end) return false;

  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = root.ownerDocument.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
