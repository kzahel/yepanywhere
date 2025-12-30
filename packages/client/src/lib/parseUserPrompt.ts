import {
  parseOpenedFiles,
  getFilename as sharedGetFilename,
  stripIdeMetadata,
} from "@claude-anywhere/shared";

/**
 * Parsed user prompt with metadata extracted
 */
export interface ParsedUserPrompt {
  /** The actual user message text (without metadata tags) */
  text: string;
  /** Full paths of files the user had open in their IDE */
  openedFiles: string[];
}

/**
 * Extracts the filename from a full file path.
 * Re-exported from shared for backward compatibility.
 */
export const getFilename = sharedGetFilename;

/**
 * Parses user prompt content, extracting ide_opened_file metadata tags.
 * Returns the cleaned text and list of opened file paths.
 *
 * Also handles <ide_selection> tags by stripping them from the text.
 */
export function parseUserPrompt(content: string): ParsedUserPrompt {
  return {
    text: stripIdeMetadata(content),
    openedFiles: parseOpenedFiles(content),
  };
}
