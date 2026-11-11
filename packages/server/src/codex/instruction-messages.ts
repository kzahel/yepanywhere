import type { CodexMessagePayload } from "@yep-anywhere/shared";
import type { Message } from "../supervisor/types.js";
import {
  CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
  codexContentFilterGuidance,
} from "./contentFilterBlock.js";

export function codexMessageText(payload: CodexMessagePayload): string {
  return payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

export function codexDeveloperMessage(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
): Message | null {
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
