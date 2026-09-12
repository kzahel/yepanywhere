import type { ContentBlock, Message } from "./message.js";
import type { RenderItem, SystemItem, UserPromptItem } from "./items.js";
import { getMessageId } from "./message.js";

export function contentBlocksText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function isLocalCommandItem(
  item: RenderItem,
): item is SystemItem & { subtype: "local_command" } {
  return item.type === "system" && item.subtype === "local_command";
}

function isSlashCommandSkillBodyItem(item: RenderItem): item is UserPromptItem {
  if (item.type !== "user_prompt") {
    return false;
  }
  if (!item.sourceMessages.some((message) => message.isMeta === true)) {
    return false;
  }
  return contentBlocksText(item.content)
    .trimStart()
    .startsWith("Base directory for this skill:");
}

function messagePromptId(message: Message): string | null {
  const promptId = (message as { promptId?: unknown }).promptId;
  return typeof promptId === "string" && promptId ? promptId : null;
}

function isLinkedSlashCommandSkillBody(
  commandItem: SystemItem,
  skillItem: UserPromptItem,
): boolean {
  const commandIds = new Set(
    commandItem.sourceMessages.map(getMessageId).filter(Boolean),
  );
  const skillParentUuids = skillItem.sourceMessages
    .map((message) =>
      typeof message.parentUuid === "string" ? message.parentUuid : null,
    )
    .filter((parentUuid): parentUuid is string => parentUuid !== null);
  if (skillParentUuids.length > 0 && commandIds.size > 0) {
    return skillParentUuids.some((parentUuid) => commandIds.has(parentUuid));
  }

  const commandPromptIds = new Set(
    commandItem.sourceMessages
      .map(messagePromptId)
      .filter((promptId): promptId is string => promptId !== null),
  );
  const skillPromptIds = skillItem.sourceMessages
    .map(messagePromptId)
    .filter((promptId): promptId is string => promptId !== null);
  if (skillPromptIds.length > 0 && commandPromptIds.size > 0) {
    return skillPromptIds.some((promptId) => commandPromptIds.has(promptId));
  }

  return true;
}

function mergeSlashCommandSkillBody(
  commandItem: SystemItem & { subtype: "local_command" },
  skillItem: UserPromptItem,
): SystemItem {
  return {
    ...commandItem,
    sourceMessages: [
      ...commandItem.sourceMessages,
      ...skillItem.sourceMessages,
    ],
    details: [...(commandItem.details ?? []), skillItem.content],
  };
}

export function coalesceSlashCommandSkillBodies(
  items: RenderItem[],
): RenderItem[] {
  const coalesced: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    const nextItem = items[index + 1];
    if (
      item &&
      nextItem &&
      isLocalCommandItem(item) &&
      isSlashCommandSkillBodyItem(nextItem) &&
      isLinkedSlashCommandSkillBody(item, nextItem)
    ) {
      coalesced.push(mergeSlashCommandSkillBody(item, nextItem));
      index += 2;
      continue;
    }

    if (item) {
      coalesced.push(item);
    }
    index += 1;
  }

  return coalesced;
}
