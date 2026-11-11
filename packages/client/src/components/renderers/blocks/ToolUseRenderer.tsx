import styles from "./ToolUseRenderer.module.css";
import toolLabelStyles from "../../ToolLabel.module.css";
import { toolRegistry } from "../tools";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ToolUseBlock extends ContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * Tool use renderer - dispatches to tool-specific renderer
 */
function ToolUseRendererComponent({
  block,
  context,
}: {
  block: ToolUseBlock;
  context: RenderContext;
}) {
  return (
    <div className={styles.toolBlock} data-tool-block>
      <div className={styles.toolHeader} data-tool-header>
        <span className={styles.toolIcon} data-tool-icon>
          {">"}
        </span>
        <span className={toolLabelStyles.toolName} data-tool-name>
          {block.name}
        </span>
      </div>
      <div className={styles.toolContent} data-tool-content>
        {toolRegistry.renderToolUse(block.name, block.input, context)}
      </div>
    </div>
  );
}

export const toolUseRenderer: ContentRenderer<ToolUseBlock> = {
  type: "tool_use",
  render(block, context) {
    return (
      <ToolUseRendererComponent
        block={block as ToolUseBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const toolBlock = block as ToolUseBlock;
    return (
      toolRegistry
        .prepare(toolBlock.name, { input: toolBlock.input, status: "pending" })
        .getUseSummary() || toolBlock.name
    );
  },
};
