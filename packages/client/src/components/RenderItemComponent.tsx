import { memo, useCallback } from "react";
import type { RenderItem } from "../types/renderItems";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";

interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
}: Props) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log("[DEBUG] RenderItem:", item);
        console.log("[DEBUG] Source JSONL entries:", item.sourceMessages);
      }
    },
    [item],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <TextBlock
            text={item.text}
            isStreaming={item.isStreaming}
            augmentHtml={item.augmentHtml}
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            status={item.status}
          />
        );

      case "user_prompt":
        return <UserPromptBlock content={item.content} />;

      case "system":
        return (
          <div className="system-message">
            <span className="system-message-icon">⟳</span>
            <span className="system-message-text">{item.content}</span>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, ctrl+click only
    <div
      className={item.isSubagent ? "subagent-item" : undefined}
      data-render-type={item.type}
      data-render-id={item.id}
      onClick={handleClick}
    >
      {renderContent()}
    </div>
  );
});
