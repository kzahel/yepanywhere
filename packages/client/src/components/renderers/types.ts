import type { ReactNode } from "react";

/**
 * Extended content block with all possible fields from Claude messages
 */
export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string; // Hidden from display
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

/**
 * Context passed to every renderer
 */
export interface RenderContext {
  /** True if message is still being streamed */
  isStreaming: boolean;
  /** Current theme */
  theme: "light" | "dark";
  /** Lookup tool_use by ID (for tool_result rendering) */
  getToolUse?: (id: string) => { name: string; input: unknown } | undefined;
  /** Structured tool result data (from message.toolUseResult) */
  toolUseResult?: unknown;
  /** Whether thinking blocks are expanded (shared state) */
  thinkingExpanded?: boolean;
  /** Toggle thinking blocks expanded state */
  toggleThinkingExpanded?: () => void;
}

/**
 * Content block renderer interface
 */
export interface ContentRenderer<T extends ContentBlock = ContentBlock> {
  /** Block type(s) this renderer handles */
  type: string | string[];
  /** Render the block */
  render(block: T, context: RenderContext): ReactNode;
  /** Optional summary for collapsed view */
  getSummary?(block: T): string;
}
