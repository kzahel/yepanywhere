/**
 * Edit augment service - computes structuredPatch and highlighted diff HTML
 * for Edit tool_use blocks.
 *
 * This enables consistent unified diff display for both pending (tool_use)
 * and completed (tool_result) edits.
 */

import type { EditAugment, PatchHunk } from "@yep-anywhere/shared";
import { structuredPatch } from "diff";
import { highlightCode } from "../highlighting/index.js";

/** Number of context lines to include in the diff */
const CONTEXT_LINES = 3;

/**
 * Input for computing an edit augment.
 */
export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

/**
 * Convert jsdiff patch hunks to our PatchHunk format.
 * jsdiff hunks have the same structure but we need to add line prefixes.
 */
function convertHunks(
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>,
): PatchHunk[] {
  return hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}

/**
 * Convert structured patch hunks to unified diff text for highlighting.
 */
function patchToUnifiedText(hunks: PatchHunk[]): string {
  const lines: string[] = [];

  for (const hunk of hunks) {
    // Add hunk header
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    // Add diff lines (already prefixed with ' ', '-', or '+')
    lines.push(...hunk.lines);
  }

  return lines.join("\n");
}

/**
 * Compute an edit augment for an Edit tool_use.
 *
 * @param toolUseId - The tool_use ID to associate with this augment
 * @param input - The Edit tool input containing file_path, old_string, new_string
 * @returns EditAugment with structuredPatch and highlighted diff HTML
 */
export async function computeEditAugment(
  toolUseId: string,
  input: EditInput,
): Promise<EditAugment> {
  const { file_path, old_string, new_string } = input;

  // Compute structured patch using jsdiff
  const patch = structuredPatch(
    file_path,
    file_path,
    old_string,
    new_string,
    "", // oldHeader
    "", // newHeader
    { context: CONTEXT_LINES },
  );

  // Convert hunks to our format
  const structuredPatchResult = convertHunks(patch.hunks);

  // Convert to unified diff text for highlighting
  const diffText = patchToUnifiedText(structuredPatchResult);

  // Highlight with shiki using diff language
  let diffHtml: string;
  const highlightResult = await highlightCode(diffText, "diff");
  if (highlightResult) {
    // Post-process to add line type classes for background colors
    diffHtml = addDiffLineClasses(highlightResult.html);
  } else {
    // Fallback to plain text wrapped in pre/code
    diffHtml = `<pre class="shiki"><code class="language-diff">${escapeHtml(diffText)}</code></pre>`;
  }

  return {
    toolUseId,
    type: "edit",
    structuredPatch: structuredPatchResult,
    diffHtml,
    filePath: file_path,
  };
}

/**
 * Add diff line type classes to shiki HTML output.
 * Detects line content and adds classes like "line-deleted", "line-inserted", "line-context", "line-hunk".
 * This enables CSS background colors for traditional diff styling.
 */
function addDiffLineClasses(html: string): string {
  // Match each <span class="line">...</span> and inspect content
  return html.replace(
    /<span class="line">([\s\S]*?)<\/span>/g,
    (_match, content: string) => {
      // Decode HTML entities to check the actual first character
      const decoded = content
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

      // Get the visible text (strip HTML tags)
      const textContent = decoded.replace(/<[^>]*>/g, "");
      const firstChar = textContent[0];

      let lineClass = "line";
      if (firstChar === "-") {
        lineClass = "line line-deleted";
      } else if (firstChar === "+") {
        lineClass = "line line-inserted";
      } else if (firstChar === "@") {
        lineClass = "line line-hunk";
      } else if (firstChar === " ") {
        lineClass = "line line-context";
      }

      return `<span class="${lineClass}">${content}</span>`;
    },
  );
}

/**
 * Escape HTML special characters for fallback rendering.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
