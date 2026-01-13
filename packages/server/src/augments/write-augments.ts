/**
 * Write augment service - computes syntax-highlighted HTML for Write tool_use blocks.
 *
 * This enables consistent code highlighting for written file content,
 * matching the FileViewer's highlighting behavior.
 */

import { extname } from "node:path";
import { highlightFile } from "../highlighting/index.js";
import { renderMarkdownToHtml } from "./markdown-augments.js";

/**
 * Input for computing a write augment.
 */
export interface WriteInput {
  file_path: string;
  content: string;
}

/**
 * Result from computing a write augment.
 */
export interface WriteAugmentResult {
  /** Syntax-highlighted HTML */
  highlightedHtml: string;
  /** Language used for highlighting */
  language: string;
  /** Whether content was truncated for highlighting */
  truncated: boolean;
  /** Rendered markdown HTML (for .md files) */
  renderedMarkdownHtml?: string;
}

/**
 * Check if file is markdown based on extension.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

/**
 * Compute a write augment for a Write tool_use.
 *
 * @param input - The Write tool input containing file_path and content
 * @returns WriteAugmentResult with highlighted HTML, or null if language is unsupported
 */
export async function computeWriteAugment(
  input: WriteInput,
): Promise<WriteAugmentResult | null> {
  const { file_path, content } = input;

  // Use highlightFile which detects language from file extension
  const result = await highlightFile(content, file_path);
  if (!result) {
    return null;
  }

  const augmentResult: WriteAugmentResult = {
    highlightedHtml: result.html,
    language: result.language,
    truncated: result.truncated,
  };

  // Render markdown preview for .md files
  if (isMarkdownFile(file_path)) {
    try {
      augmentResult.renderedMarkdownHtml = await renderMarkdownToHtml(content);
    } catch {
      // Ignore markdown rendering errors
    }
  }

  return augmentResult;
}
