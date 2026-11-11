import type { GitDiffPreviewSkipped, PatchHunk } from "@yep-anywhere/shared";

export function getDiffSourceText(hunks: PatchHunk[]): string {
  return hunks.flatMap((hunk) => hunk.lines).join("\n");
}

export function getPostChangeText(hunks: PatchHunk[]): string | null {
  if (hunks.length === 0) return null;
  return hunks
    .map((hunk) =>
      hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n"),
    )
    .join("\n");
}

export function getDiffScrollRoot(content: HTMLElement): HTMLElement {
  return (
    content.closest<HTMLElement>(
      "[data-source-preview-body], [data-modal-content]",
    ) ?? content
  );
}

export function getRelativeScrollRatio(element: HTMLElement): number {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScrollTop === 0) return 0;
  return Math.min(1, Math.max(0, element.scrollTop / maxScrollTop));
}

export function restoreRelativeScrollRatio(
  element: HTMLElement,
  ratio: number,
): void {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = maxScrollTop * Math.min(1, Math.max(0, ratio));
}

export function getBinaryPatchSkip(
  structuredPatch: PatchHunk[],
): GitDiffPreviewSkipped | null {
  let characters = 0;
  let suspiciousControls = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      for (const char of line) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) continue;
        if (codePoint === 0 || codePoint === 0xfffd) {
          return { reason: "binary" };
        }
        characters += 1;
        if (
          (codePoint < 0x20 &&
            codePoint !== 0x08 &&
            codePoint !== 0x09 &&
            codePoint !== 0x0a &&
            codePoint !== 0x0c &&
            codePoint !== 0x0d &&
            codePoint !== 0x1b) ||
          codePoint === 0x7f
        ) {
          suspiciousControls += 1;
        }
      }
    }
  }

  return suspiciousControls / Math.max(characters, 1) > 0.01
    ? { reason: "binary" }
    : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatFraction(bytes / 1024)} KB`;
  }
  return `${formatFraction(bytes / (1024 * 1024))} MB`;
}

function formatFraction(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/** Both React hunk headers and server-emitted Shiki hunk lines navigate here. */
export function collectDiffHunks(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-diff-hunk-header], .line-hunk",
    ),
  );
}
