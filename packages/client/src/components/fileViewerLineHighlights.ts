import viewerStyles from "./FileViewer.module.css";

export function getHighlightRange(
  lineNumber?: number,
  lineEnd?: number,
): { end: number; start: number } | null {
  if (lineNumber === undefined) {
    return null;
  }
  return {
    end: Math.max(lineNumber, lineEnd ?? lineNumber),
    start: lineNumber,
  };
}

export function annotateHighlightedHtmlLines(
  html: string | undefined,
  contentStartLine: number,
  lineNumber?: number,
  lineEnd?: number,
): string | undefined {
  if (!html) {
    return html;
  }
  const range = getHighlightRange(lineNumber, lineEnd);
  const singleLine = range?.start === range?.end;
  let currentLine = 0;
  return html.replace(/<span class="([^"]*)">/g, (match, className: string) => {
    if (!className.split(/\s+/).includes("line")) {
      return match;
    }
    currentLine += 1;
    const actualLine = contentStartLine + currentLine - 1;
    const inRange =
      range !== null && actualLine >= range.start && actualLine <= range.end;
    const classes = [
      className,
      singleLine && inRange ? viewerStyles.highlightedLine : "",
      actualLine === range?.start ? viewerStyles.highlightedLineStart : "",
      actualLine === range?.end ? viewerStyles.highlightedLineEnd : "",
    ]
      .filter(Boolean)
      .join(" ");
    const marks = `${singleLine && inRange ? " data-highlighted-line" : ""}${actualLine === range?.start ? " data-highlighted-line-start" : ""}${actualLine === range?.end ? " data-highlighted-line-end" : ""}`;
    return `<span class="${classes}" data-line="${actualLine}"${marks}>`;
  });
}

function getTargetTopWithinContainer(
  container: HTMLElement,
  target: HTMLElement,
): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - containerRect.top + container.scrollTop;
}

export function getFileViewerTargetScrollTop(
  container: HTMLElement,
  target: HTMLElement,
): number {
  if (container.scrollHeight <= container.clientHeight) {
    return 0;
  }
  const targetTop = getTargetTopWithinContainer(container, target);
  const leadIn = container.clientHeight * 0.1;
  const maxScrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight,
  );
  return Math.max(0, Math.min(maxScrollTop, targetTop - leadIn));
}
