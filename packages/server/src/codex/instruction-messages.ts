import {
  AGENT_API_BOOTSTRAP_NOTICE,
  findAgentApiBootstrapInstructions,
  stripAgentApiBootstrapPrefix,
} from "@yep-anywhere/shared/agent-api-bootstrap";
import {
  MACHINE_CONTROL_INSTRUCTIONS_NOTICE,
  findMachineControlInstructions,
  splitMachineControlPrompt,
} from "@yep-anywhere/shared/machine-control-instructions";
import type { CodexMessagePayload } from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";
import {
  CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
  codexContentFilterGuidance,
} from "./contentFilterBlock.js";

export function codexMessageText(payload: CodexMessagePayload): string {
  const text = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
  return payload.role === "user" ? stripAgentApiBootstrapPrefix(text) : text;
}

/** Only recognized instructions become notices; other developer context stays hidden. */
export function developerMessages(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
): Message[] {
  const text = codexMessageText(payload);
  const api = findAgentApiBootstrapInstructions(text);
  const machineControl = findMachineControlInstructions(text);
  const notices: Message[] = [];
  if (api)
    notices.push(
      instructionNotice(uuid, timestamp, AGENT_API_BOOTSTRAP_NOTICE, api),
    );
  if (machineControl)
    notices.push(
      instructionNotice(
        api ? `${uuid}-machine-control` : uuid,
        timestamp,
        MACHINE_CONTROL_INSTRUCTIONS_NOTICE,
        machineControl,
      ),
    );
  if (notices.length) return notices;
  const guidance = codexContentFilterGuidance(payload);
  return guidance === null
    ? []
    : [
        {
          uuid,
          type: "system",
          subtype: CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
          content: guidance,
          timestamp,
        },
      ];
}

function instructionNotice(
  uuid: string,
  timestamp: string | undefined,
  content: string,
  instructions: string,
): Message {
  return {
    uuid,
    type: "system",
    subtype: "informational",
    content,
    details: [instructions],
    timestamp,
  };
}

/** Keep the same projection for paired response items and event-only history. */
export function codexInstructionMessages(
  message: Message | Message[] | null,
): Message[] {
  if (!message) return [];
  if (Array.isArray(message)) return message;
  if (message.type !== "user" || !message.message) return [message];
  const content = message.message.content;
  if (!content) return [message];
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof content === "string"
      ? content
      : first?.type === "text"
        ? first.text
        : undefined;
  if (typeof text !== "string") return [message];
  const split = splitMachineControlPrompt(text);
  if (!split) return [message];
  const notice = instructionNotice(
    `${message.uuid}-machine-control`,
    message.timestamp,
    MACHINE_CONTROL_INSTRUCTIONS_NOTICE,
    split.context,
  );
  const user = {
    ...message,
    message: {
      ...message.message,
      content:
        typeof content === "string"
          ? split.prompt
          : [{ ...first!, text: split.prompt }, ...content.slice(1)],
    },
  };
  return [notice, user];
}
