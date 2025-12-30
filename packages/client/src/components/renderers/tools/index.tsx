import type { ReactNode } from "react";
import type { RenderContext } from "../types";
import type { ToolRenderer } from "./types";

/**
 * Registry for tool-specific renderers
 */
class ToolRendererRegistry {
  private tools = new Map<string, ToolRenderer>();
  private fallback: ToolRenderer;

  constructor(fallback: ToolRenderer) {
    this.fallback = fallback;
  }

  register(renderer: ToolRenderer): void {
    this.tools.set(renderer.tool, renderer);
  }

  get(toolName: string): ToolRenderer {
    return this.tools.get(toolName) || this.fallback;
  }

  renderToolUse(
    toolName: string,
    input: unknown,
    context: RenderContext,
  ): ReactNode {
    return this.get(toolName).renderToolUse(input, context);
  }

  renderToolResult(
    toolName: string,
    result: unknown,
    isError: boolean,
    context: RenderContext,
    input?: unknown,
  ): ReactNode {
    return this.get(toolName).renderToolResult(result, isError, context, input);
  }

  hasInteractiveSummary(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderInteractiveSummary === "function";
  }

  hasCollapsedPreview(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderCollapsedPreview === "function";
  }

  renderCollapsedPreview(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderCollapsedPreview) {
      return renderer.renderCollapsedPreview(input, result, isError, context);
    }
    return null;
  }

  renderInteractiveSummary(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderInteractiveSummary) {
      return renderer.renderInteractiveSummary(input, result, isError, context);
    }
    return null;
  }

  getDisplayName(toolName: string): string {
    const renderer = this.get(toolName);
    return renderer.displayName || toolName;
  }
}

/**
 * Fallback tool renderer - shows raw JSON
 */
const fallbackToolRenderer: ToolRenderer = {
  tool: "__fallback__",
  renderToolUse(input, _context) {
    return (
      <pre className="tool-fallback">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    );
  },
  renderToolResult(result, isError, _context) {
    return (
      <pre className={`tool-fallback ${isError ? "tool-fallback-error" : ""}`}>
        <code>{JSON.stringify(result, null, 2)}</code>
      </pre>
    );
  },
};

// Create and export the tool registry
export const toolRegistry = new ToolRendererRegistry(fallbackToolRenderer);

// Import and register tool renderers
import { askUserQuestionRenderer } from "./AskUserQuestionRenderer";
import { bashOutputRenderer } from "./BashOutputRenderer";
import { bashRenderer } from "./BashRenderer";
import { editRenderer } from "./EditRenderer";
import { exitPlanModeRenderer } from "./ExitPlanModeRenderer";
import { globRenderer } from "./GlobRenderer";
import { grepRenderer } from "./GrepRenderer";
import { killShellRenderer } from "./KillShellRenderer";
import { readRenderer } from "./ReadRenderer";
import { taskOutputRenderer } from "./TaskOutputRenderer";
import { taskRenderer } from "./TaskRenderer";
import { todoWriteRenderer } from "./TodoWriteRenderer";
import { webFetchRenderer } from "./WebFetchRenderer";
import { webSearchRenderer } from "./WebSearchRenderer";
import { writeRenderer } from "./WriteRenderer";

// Tier 1 & 2: Core tools
toolRegistry.register(bashRenderer);
toolRegistry.register(readRenderer);
toolRegistry.register(editRenderer);
toolRegistry.register(writeRenderer);
toolRegistry.register(globRenderer);
toolRegistry.register(grepRenderer);
toolRegistry.register(todoWriteRenderer);

// Tier 3: Less common tools
toolRegistry.register(taskRenderer);
toolRegistry.register(webSearchRenderer);
toolRegistry.register(webFetchRenderer);
toolRegistry.register(askUserQuestionRenderer);
toolRegistry.register(exitPlanModeRenderer);

// Tier 4: Background/async tools
toolRegistry.register(bashOutputRenderer);
toolRegistry.register(taskOutputRenderer);
toolRegistry.register(killShellRenderer);
