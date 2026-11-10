import thinkingStyles from "../../blocks/ThinkingBlock.module.css";
import { useState } from "react";
import { ThinkingText } from "../../ThinkingText";
import { ButtonBase } from "../../ui/Button";
import type { ContentBlock, ContentRenderer, RenderContext } from "../types";

interface ThinkingBlock extends ContentBlock {
  type: "thinking" | "reasoning" | "reasoning_text" | "summary_text";
  thinking?: string;
  text?: string;
  summary?: Array<string | { type?: string; text?: string }>;
  signature?: string; // Never rendered
}

function extractThinkingText(block: ThinkingBlock): string {
  if (typeof block.thinking === "string") {
    return block.thinking;
  }
  const summaryText = block.summary
    ?.map((entry) => (typeof entry === "string" ? entry : entry.text))
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
  if (summaryText) {
    return summaryText;
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  return "";
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
  const [localExpanded, setLocalExpanded] = useState(false);
  const thinking = extractThinkingText(block);
  const isExpanded = context.thinkingExpanded ?? localExpanded;
  const toggleThinkingExpanded =
    context.toggleThinkingExpanded ?? (() => setLocalExpanded((prev) => !prev));

  if (isExpanded) {
    return (
      <div
        className={`${thinkingStyles.thinkingBlock} ${thinkingStyles.thinkingBlockExpanded}`}
        data-thinking-block
        data-thinking-block-expanded
      >
        <ButtonBase
          className={thinkingStyles.thinkingToggleExpanded}
          data-thinking-toggle-expanded
          onClick={toggleThinkingExpanded}
          aria-expanded={true}
        >
          <span className={thinkingStyles.thinkingLabel} data-thinking-label>
            Thinking
          </span>
          <span className={thinkingStyles.thinkingIcon} data-thinking-icon>
            ▲
          </span>
        </ButtonBase>
        <div className={thinkingStyles.thinkingContent} data-thinking-content>
          <ThinkingText text={thinking} isStreaming={context.isStreaming} />
        </div>
      </div>
    );
  }

  // Collapsed: small inline button with pulsing when streaming
  const collapsedClass = context.isStreaming
    ? `${thinkingStyles.thinkingBlock} ${thinkingStyles.thinkingStreamingCollapsed}`
    : thinkingStyles.thinkingBlock;

  return (
    <div
      className={collapsedClass}
      data-thinking-block={
        context.isStreaming || !context.isStreaming || undefined
      }
      data-thinking-streaming-collapsed={context.isStreaming || undefined}
    >
      <ButtonBase
        className={thinkingStyles.thinkingToggleCollapsed}
        data-thinking-toggle-collapsed
        onClick={toggleThinkingExpanded}
        aria-expanded={false}
      >
        <span className={thinkingStyles.thinkingLabel} data-thinking-label>
          {context.isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <span className={thinkingStyles.thinkingIcon} data-thinking-icon>
          ▼
        </span>
      </ButtonBase>
    </div>
  );
}

export const thinkingRenderer: ContentRenderer<ThinkingBlock> = {
  type: ["thinking", "reasoning", "reasoning_text", "summary_text"],
  render(block, context) {
    return (
      <ThinkingRendererComponent
        block={block as ThinkingBlock}
        context={context}
      />
    );
  },
  getSummary(block) {
    const thinking = extractThinkingText(block as ThinkingBlock);
    const firstLine = thinking.split("\n")[0] || "";
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  },
};
