import {
  AGENT_API_BOOTSTRAP_NOTICE,
  findAgentApiBootstrapInstructions,
  stripAgentApiBootstrapPrefix,
} from "@yep-anywhere/shared/agent-api-bootstrap";
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
export function codexDeveloperMessage(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
): Message | null {
  const instructions = findAgentApiBootstrapInstructions(
    codexMessageText(payload),
  );
  if (instructions) {
    return {
      uuid,
      type: "system",
      subtype: "informational",
      content: AGENT_API_BOOTSTRAP_NOTICE,
      details: [instructions],
      timestamp,
    };
  }
  const guidance = codexContentFilterGuidance(payload);
  return guidance === null
    ? null
    : {
        uuid,
        type: "system",
        subtype: CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
        content: guidance,
        timestamp,
      };
}
