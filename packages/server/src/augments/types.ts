/**
 * Shared types for augmentation processing.
 * Used by streaming transports (SSE, WebSocket) and batch processing (GET sessions).
 */

import type { EditInput } from "./edit-augments.js";
import type { WriteInput } from "./write-augments.js";

/** ExitPlanMode tool_use input with rendered HTML */
export interface ExitPlanModeInput {
  plan?: string;
  _renderedHtml?: string;
}

/** ExitPlanMode tool_result structured data */
export interface ExitPlanModeResult {
  plan?: string;
  _renderedHtml?: string;
}

/** Read tool_result structured data with augment fields */
export interface ReadResultWithAugment {
  type?: "text" | "image";
  file?: {
    filePath?: string;
    content?: string;
    numLines?: number;
    startLine?: number;
    totalLines?: number;
  };
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

/** Edit tool_use input with embedded augment data */
export interface EditInputWithAugment extends EditInput {
  _structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  _diffHtml?: string;
}

/** Write tool_use input with embedded augment data */
export interface WriteInputWithAugment extends WriteInput {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

/** Generic SDK message structure for type-safe access */
export interface SDKMessageLike {
  type?: string;
  uuid?: string;
  message?: {
    id?: string;
    content?: unknown;
  };
  content?: unknown;
  tool_use_result?: unknown;
  event?: {
    type?: string;
    message?: {
      id?: string;
    };
    delta?: {
      type?: string;
      text?: string;
    };
  };
  parent_tool_use_id?: string | null;
}
