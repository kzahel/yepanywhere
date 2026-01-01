import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  isStreaming?: boolean;
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
}: Props) {
  return (
    <div
      className={`text-block timeline-item${isStreaming ? " streaming" : ""}`}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
});
