import { memo, useEffect, useRef } from "react";
import type { Message } from "../types";

interface Props {
  messages: Message[];
}

// Memoize individual message to prevent re-renders
const MessageItem = memo(function MessageItem({ msg }: { msg: Message }) {
  return (
    <div className={`message message-${msg.role}`}>
      <div className="message-role">{msg.role}</div>
      <div className="message-content">
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    </div>
  );
});

export const MessageList = memo(function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes is intentional
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="message-list">
      {messages.map((msg) => (
        <MessageItem key={msg.id} msg={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
});
