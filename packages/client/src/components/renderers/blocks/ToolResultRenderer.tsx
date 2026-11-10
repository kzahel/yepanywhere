import toolStyles from "./ToolUseRenderer.module.css";
import toolLabelStyles from "../../ToolLabel.module.css";
import { Badge } from "../../ui/Badge";
import { toolRegistry } from "../tools";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ToolResultBlock extends ContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

/**
 * Tool result renderer - correlates with tool_use and dispatches to tool-specific renderer
 */
function ToolResultRendererComponent({
  block,
  context,
}: {
  block: ToolResultBlock;
  context: RenderContext;
}) {
  // Look up the corresponding tool_use to get the tool name
  const toolUse = context.getToolUse?.(block.tool_use_id);
  const toolName = toolUse?.name || "Unknown";
  const isError = block.is_error === true;

  // Prefer structured toolUseResult if available, otherwise try to parse content
  let result: unknown = context.toolUseResult;
  if (!result && block.content) {
    try {
      result = JSON.parse(block.content);
    } catch {
      // Content is not JSON, use as-is
      result = { content: block.content };
    }
  }

  return (
    <div
      className={`${toolStyles.toolBlock} tool-result ${isError ? toolStyles.toolError : ""}`}
      data-tool-block
      data-tool-error={isError || undefined}
    >
      <div className={toolStyles.toolHeader} data-tool-header>
        <span className={toolStyles.toolIcon} data-tool-icon>
          {"<"}
        </span>
        <span className={toolLabelStyles.toolName} data-tool-name>
          {toolName}
        </span>
        {isError && (
          <Badge tone="danger" size="small">
            Error
          </Badge>
        )}
      </div>
      <div className={toolStyles.toolContent} data-tool-content>
        {toolRegistry.renderToolResult(
          toolName,
          result,
          isError,
          context,
          toolUse?.input,
        )}
      </div>
    </div>
  );
}

export const toolResultRenderer: ContentRenderer<ToolResultBlock> = {
  type: "tool_result",
  render(block, context) {
    return (
      <ToolResultRendererComponent
        block={block as ToolResultBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const resultBlock = block as ToolResultBlock;
    if (resultBlock.is_error) return "Error";
    return "Result";
  },
};
