import type { ContentBlock } from "./message.js";
import type { RenderItem, SessionSetupItem, UserPromptItem } from "./items.js";
import {
  isLegacyCodexEnvironmentContextText,
  isLegacyCodexSetupText,
} from "./codexLegacySetup.js";

const RESUME_ENVIRONMENT_CONTEXT_MAX_GAP_MS = 5_000;

function getPromptText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function isSessionSetupPrompt(item: UserPromptItem): boolean {
  const text = getPromptText(item.content).trimStart();
  return isLegacyCodexSetupText(text, item.sourceMessages);
}

function isEnvironmentContextSetupPrompt(item: UserPromptItem): boolean {
  return isLegacyCodexEnvironmentContextText(
    getPromptText(item.content),
    item.sourceMessages,
  );
}

function itemTimestampMs(item: RenderItem): number | null {
  const timestamp = item.sourceMessages
    .map((message) =>
      typeof message.timestamp === "string"
        ? Date.parse(message.timestamp)
        : NaN,
    )
    .find(Number.isFinite);
  return timestamp === undefined ? null : timestamp;
}

function isImmediateResumeEnvironmentContext(
  setupItem: UserPromptItem,
  nextItem: RenderItem | undefined,
): boolean {
  if (
    !isEnvironmentContextSetupPrompt(setupItem) ||
    nextItem?.type !== "user_prompt" ||
    isSessionSetupPrompt(nextItem)
  ) {
    return false;
  }

  const setupMs = itemTimestampMs(setupItem);
  const nextMs = itemTimestampMs(nextItem);
  if (setupMs === null || nextMs === null) {
    return false;
  }

  const gapMs = nextMs - setupMs;
  return gapMs >= 0 && gapMs <= RESUME_ENVIRONMENT_CONTEXT_MAX_GAP_MS;
}

export function collapseSessionSetupRuns(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (item?.type !== "user_prompt" || !isSessionSetupPrompt(item)) {
      result.push(item as RenderItem);
      index += 1;
      continue;
    }

    const setupItems: UserPromptItem[] = [];
    let runIndex = index;
    while (runIndex < items.length) {
      const runItem = items[runIndex];
      if (runItem?.type !== "user_prompt" || !isSessionSetupPrompt(runItem)) {
        break;
      }
      setupItems.push(runItem);
      runIndex += 1;
    }

    const singleSetupItem = setupItems.length === 1 ? setupItems[0] : undefined;
    const shouldSuppressSingleSetupItem =
      singleSetupItem !== undefined &&
      isImmediateResumeEnvironmentContext(singleSetupItem, items[runIndex]);

    if (shouldSuppressSingleSetupItem) {
      index = runIndex;
      continue;
    }

    // Preserve likely user-authored single setup-like messages mid-session.
    // Collapse runs at session start and multi-item resume preambles.
    if (setupItems.length > 1 || index === 0) {
      const firstSetupItem = setupItems[0];
      if (!firstSetupItem) {
        index = runIndex;
        continue;
      }

      const collapsedItem: SessionSetupItem = {
        type: "session_setup",
        id: `session-setup-${firstSetupItem.id}`,
        title: "Session setup",
        prompts: setupItems.map((setupItem) => setupItem.content),
        sourceMessages: setupItems.flatMap(
          (setupItem) => setupItem.sourceMessages,
        ),
      };
      result.push(collapsedItem);
    } else {
      const singleSetupItem = setupItems[0];
      if (singleSetupItem) {
        result.push(singleSetupItem);
      }
    }

    index = runIndex;
  }

  return result;
}
