import { type RefObject, useCallback, useEffect } from "react";
import { useI18n } from "../i18n";
import { IconButton } from "./ui/Button";

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function shortcutBelongsToViewer(root: HTMLElement): boolean {
  if (!root.isConnected || root.closest('[aria-hidden="true"]')) return false;
  const surface =
    root.closest<HTMLElement>('[role="dialog"]') ??
    root.closest<HTMLElement>("[data-file-viewer]") ??
    root;
  const activeElement = root.ownerDocument.activeElement;
  return (
    !activeElement ||
    activeElement === root.ownerDocument.body ||
    surface.contains(activeElement)
  );
}

export function selectAllViewerContent(root: HTMLElement | null): boolean {
  const selection = root?.ownerDocument.getSelection();
  if (!root || !selection) return false;
  const range = root.ownerDocument.createRange();
  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter ?? NodeFilter;
  const walker = root.ownerDocument.createTreeWalker(
    root,
    nodeFilter.SHOW_TEXT,
  );
  const first = walker.nextNode();
  if (first) {
    let last = first;
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      last = next;
    }
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length ?? 0);
  } else {
    range.selectNodeContents(root);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  const EventConstructor = root.ownerDocument.defaultView?.Event ?? Event;
  const dispatchSelectionChange = () =>
    root.ownerDocument.dispatchEvent(new EventConstructor("selectionchange"));
  dispatchSelectionChange();
  return true;
}

export function ViewerSelectAllButton({
  className,
  contentRef,
}: {
  className?: string;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const selectAll = useCallback(
    () => selectAllViewerContent(contentRef.current),
    [contentRef],
  );

  useEffect(() => {
    const doc = contentRef.current?.ownerDocument ?? document;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = contentRef.current;
      if (
        !root ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "a" ||
        isEditableTarget(event.target) ||
        !shortcutBelongsToViewer(root)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      selectAll();
    };
    doc.addEventListener("keydown", handleKeyDown, true);
    return () => doc.removeEventListener("keydown", handleKeyDown, true);
  }, [contentRef, selectAll]);

  const label = t("viewerSelectAll" as never);
  // The tooltip names the shortcut too; the accessible name stays short.
  return (
    <IconButton
      className={className}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={selectAll}
      label={label}
      tooltip={t("viewerSelectAllTitle" as never)}
    >
      <SelectAllIcon />
    </IconButton>
  );
}

function SelectAllIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
      <rect x="5" y="5" width="6" height="6" rx="1" />
    </svg>
  );
}
