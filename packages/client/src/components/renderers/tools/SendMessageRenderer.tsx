import { useState } from "react";
import { Button } from "../../ui/Button";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import styles from "./SendMessageRenderer.module.css";
import type { SendMessageInput, SendMessageResult } from "./types";

/** Long messages open collapsed to about this many characters. */
const PREVIEW_LENGTH = 280;

function MessageBody({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = message.length > PREVIEW_LENGTH;
  const shown =
    long && !expanded
      ? `${message.slice(0, PREVIEW_LENGTH).trimEnd()}…`
      : message;
  return (
    <div className={styles.body}>
      <div className={styles.message}>{shown}</div>
      {long ? (
        <Button
          variant="ghost"
          size="small"
          className={styles.toggle}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      ) : null}
    </div>
  );
}

// Delivery status lives in the row header's summary, not here.
function Envelope({ input }: { input: SendMessageInput }) {
  return (
    <div className={styles.envelope}>
      <div className={styles.header}>
        <span className={styles.label}>To</span>
        <code className={styles.recipient}>{input.to}</code>
        {input.summary ? (
          <span className={styles.summary}>{input.summary}</span>
        ) : null}
      </div>
      <MessageBody message={input.message} />
    </div>
  );
}

function addressLine(input: SendMessageInput): string {
  return input.summary ? `→ ${input.to}: ${input.summary}` : `→ ${input.to}`;
}

function deliveryLabel(result: SendMessageResult): string {
  return result.resumedAgentId ? "Resumed agent" : "Sent";
}

function failureText(result: SendMessageResult): string {
  return result.display || result.message || "Not sent";
}

export const sendMessageRenderer = defineTool(
  toolDisplayContracts.SendMessage,
  {
    tool: "SendMessage",
    displayName: "SendMessage",
    pendingDisplayName: "Sending message",

    renderToolUse(input, _context) {
      return <Envelope input={input} />;
    },

    renderToolResult(result, _isError, _context, input) {
      // A completed row shows only this result, so it carries the message too.
      if (!result.success) {
        return (
          <div className={styles.envelope}>
            {input ? <Envelope input={input} /> : null}
            <div className={styles.error}>{failureText(result)}</div>
          </div>
        );
      }
      if (!input) {
        return (
          <div className={styles.header}>
            <span className={styles.label}>{deliveryLabel(result)}</span>
            {result.resumedAgentId ? (
              <code className={styles.recipient}>{result.resumedAgentId}</code>
            ) : null}
          </div>
        );
      }
      return <Envelope input={input} />;
    },

    renderFailure(failure) {
      return (
        <div className={styles.error}>
          {failure.content || "SendMessage failed"}
        </div>
      );
    },

    getFailureSummary() {
      return "Error";
    },

    getUseSummary(input) {
      return addressLine(input);
    },

    // A plain send is the expected outcome, so only a resume or a refusal
    // spends header space on status ahead of the recipient and subject.
    getResultSummary(result, isError, input) {
      if (isError) return "Error";
      const address = input ? ` ${addressLine(input)}` : "";
      if (!result.success) return `Not sent${address}`;
      if (result.resumedAgentId) return `Resumed agent${address}`;
      return input ? addressLine(input) : deliveryLabel(result);
    },
  },
);
