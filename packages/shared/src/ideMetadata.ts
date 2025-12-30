/**
 * IDE metadata tag handling utilities.
 *
 * VSCode extension injects metadata tags like <ide_opened_file> and <ide_selection>
 * into user messages. These utilities help detect, extract, and strip that metadata.
 */

/** Pattern for all IDE metadata tags */
const IDE_TAG_PATTERN = /<ide_(opened_file|selection)>[\s\S]*?<\/ide_\1>/g;

/** Pattern specifically for ide_opened_file tags */
const OPENED_FILE_TAG_PATTERN =
  /<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g;

/**
 * Check if text block is purely IDE metadata (for skipping in title extraction).
 * Returns true if the trimmed text starts with an IDE metadata tag.
 */
export function isIdeMetadata(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<ide_opened_file>") ||
    trimmed.startsWith("<ide_selection>")
  );
}

/**
 * Strip all IDE metadata tags from text.
 * Returns the text with all <ide_opened_file> and <ide_selection> tags removed.
 */
export function stripIdeMetadata(text: string): string {
  return text.replace(IDE_TAG_PATTERN, "").trim();
}

/**
 * Extract file path from ide_opened_file tag content.
 * Example: "The user opened the file /path/to/file.ts in the IDE" -> "/path/to/file.ts"
 */
export function extractOpenedFilePath(tagContent: string): string | null {
  const match = tagContent.match(
    /(?:user opened the file|opened the file)\s+(.+?)\s+in the IDE/i,
  );
  return match?.[1] ?? null;
}

/**
 * Parse all opened file paths from content containing ide_opened_file tags.
 */
export function parseOpenedFiles(content: string): string[] {
  const files: string[] = [];
  for (const match of content.matchAll(OPENED_FILE_TAG_PATTERN)) {
    const tagContent = match[1];
    if (tagContent) {
      const filePath = extractOpenedFilePath(tagContent);
      if (filePath) {
        files.push(filePath);
      }
    }
  }
  return files;
}

/**
 * Extract the filename from a full file path.
 */
export function getFilename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
