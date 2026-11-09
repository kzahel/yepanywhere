import { useCallback, useMemo, useState } from "react";
import { useRecentProjectPathLinks } from "../../../hooks/useRecentProjectPathLinks";
import { getCachedWebTranscriptProjection } from "../../../lib/webTranscriptProjection";
import type { Message } from "../../../types";
import { RenderItemComponent } from "../../RenderItemComponent";

export function TaskNestedContent({
  messages,
  isStreaming,
}: {
  messages: Message[];
  isStreaming: boolean;
}) {
  const { recentProjectPathLinksEnabled } = useRecentProjectPathLinks();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const renderItems = useMemo(
    () =>
      getCachedWebTranscriptProjection(
        messages,
        undefined,
        recentProjectPathLinksEnabled,
      ),
    [messages, recentProjectPathLinksEnabled],
  );

  return (
    <div className="task-nested-content">
      {renderItems.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
          thinkingExpanded={thinkingExpanded}
          toggleThinkingExpanded={toggleThinkingExpanded}
        />
      ))}
    </div>
  );
}
