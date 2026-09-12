import { PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH } from "@yep-anywhere/shared";
import { messageContentToPlainText } from "./sessionMessageText";
import { isLegacyCodexSetupText } from "@yep-anywhere/shared/transcript/codexLegacySetup";

export { PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH } from "@yep-anywhere/shared";

export function normalizePublicShareInitialPrompt(
  value: string,
  sources: ReadonlyArray<{
    _source?: unknown;
    codexUserTurnProvenance?: unknown;
  }> = [],
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (isLegacyCodexSetupText(trimmed, sources)) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length > PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH
    ? `${normalized.slice(0, PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH - 3).trimEnd()}...`
    : normalized;
}

export function getPublicShareInitialPrompt(
  messages: unknown[],
): string | null {
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as {
      _source?: unknown;
      codexUserTurnProvenance?: unknown;
      content?: unknown;
      message?: { content?: unknown };
      type?: unknown;
    };
    if (entry.type !== "user") {
      continue;
    }
    const content =
      messageContentToPlainText(entry.content) ||
      messageContentToPlainText(entry.message?.content);
    const preview = normalizePublicShareInitialPrompt(content, [entry]);
    if (preview) {
      return preview;
    }
  }
  return null;
}
