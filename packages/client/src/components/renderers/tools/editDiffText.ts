export function diffTextToNewSide(diffText: string): string {
  const lines = diffText.split("\n");
  const newSideLines: string[] = [];
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === "-") {
      continue;
    }
    if (prefix === "+" || prefix === " ") {
      newSideLines.push(line.slice(1));
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith("@@")) {
      newSideLines.push(line);
    }
  }
  return newSideLines.join("\n");
}

export function truncateByLines(
  text: string,
  maxLines: number,
): { hiddenLineCount: number; text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { hiddenLineCount: 0, text, truncated: false };
  }
  return {
    hiddenLineCount: lines.length - maxLines,
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}
