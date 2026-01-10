export function truncateText(text: string, maxLength = 60): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Shorten path by replacing home directory with ~
 */
export function shortenPath(path: string): string {
  // Try common home patterns
  const homePatterns = [
    /^\/home\/[^/]+/, // Linux: /home/username
    /^\/Users\/[^/]+/, // macOS: /Users/username
  ];

  for (const pattern of homePatterns) {
    if (pattern.test(path)) {
      return path.replace(pattern, "~");
    }
  }

  return path;
}
