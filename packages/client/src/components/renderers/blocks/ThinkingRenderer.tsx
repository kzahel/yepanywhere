import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ThinkingBlock extends ContentBlock {
  type: "thinking";
  thinking: string;
  signature?: string; // Never rendered
}

/**
 * Thinking renderer - collapsible block with shared expanded state across all blocks
 */
function ThinkingRendererComponent({
  block,
  context,
}: {
  block: ThinkingBlock;
  context: RenderContext;
}) {
  const thinking = block.thinking || "";
  const isExpanded = context.thinkingExpanded ?? false;

  if (isExpanded) {
    // Expanded: whole block is clickable to collapse
    return (
      <button
        type="button"
        className="thinking-block thinking-block-expanded"
        onClick={context.toggleThinkingExpanded}
        aria-expanded={true}
      >
        <div className="thinking-toggle-expanded">
          <span className="thinking-label">Thinking</span>
          <span className="thinking-icon">▲</span>
        </div>
        <div className="thinking-content">{thinking}</div>
      </button>
    );
  }

  // Collapsed: small inline button
  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-toggle-collapsed"
        onClick={context.toggleThinkingExpanded}
        aria-expanded={false}
      >
        <span className="thinking-label">Thinking</span>
        <span className="thinking-icon">▼</span>
      </button>
    </div>
  );
}

export const thinkingRenderer: ContentRenderer<ThinkingBlock> = {
  type: "thinking",
  render(block, context) {
    return (
      <ThinkingRendererComponent
        block={block as ThinkingBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const thinking = (block as ThinkingBlock).thinking || "";
    const firstLine = thinking.split("\n")[0] || "";
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  },
};
