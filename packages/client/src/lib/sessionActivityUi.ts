import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import type { Message } from "../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";

export type SessionActivityOwner = "self" | "external" | "none";
export type SessionActivityProcessState = "idle" | "in-turn" | "waiting-input";

interface SessionActivityUiInput {
  owner: SessionActivityOwner;
  processState: SessionActivityProcessState;
  items: RenderItem[];
  messages?: readonly Message[];
  sessionLiveness?: SessionLivenessSnapshot | null;
  hasSessionUpdateStream?: boolean;
  sessionUpdatesConnected?: boolean;
}

export interface SessionActivityUiState {
  hasPendingToolCalls: boolean;
  hasPendingToolCallsInLatestTurn: boolean;
  /** Tip-most pending tool_use in the latest turn (id, name, input), if any. */
  pendingToolCallInLatestTurn: {
    id: string;
    toolName: string;
    toolInput: unknown;
  } | null;
  latestTurnSettled: boolean;
  latestTurnCompleted: boolean;
  canStopOwnedProcess: boolean;
  shouldDeferMessages: boolean;
  showProcessingIndicator: boolean;
  shouldSuppressCurrentTurnOrphans: boolean;
}

function latestTurnStartIndex(items: RenderItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "user_prompt" || item?.type === "session_setup") {
      return index;
    }
  }
  return -1;
}

function latestSubstantiveItem(items: RenderItem[]): RenderItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (item.type === "system" && item.subtype === "config_ack") {
      continue;
    }
    return item;
  }
  return undefined;
}

function isTerminalAssistantItem(item: RenderItem | undefined): boolean {
  if (!item) {
    return false;
  }
  if (item.type === "text") {
    return item.isStreaming !== true;
  }
  if (item.type === "system") {
    return item.subtype === "turn_aborted" || item.subtype === "error";
  }
  return false;
}

function isTurnCompletionMessage(message: Message): boolean {
  if (message.type !== "system") {
    return false;
  }
  if (message.subtype === "turn_complete") {
    return true;
  }
  return (
    message.subtype === "stop_hook_summary" &&
    message.preventedContinuation === false
  );
}

function latestTurnHasCompletionMessage(
  items: RenderItem[],
  messages: readonly Message[] | undefined,
): boolean {
  if (!messages) {
    return false;
  }
  const turnStartIndex = latestTurnStartIndex(items);
  const turnStart = turnStartIndex >= 0 ? items[turnStartIndex] : undefined;
  if (!turnStart) {
    return false;
  }

  const sourceMessages = new Set(turnStart.sourceMessages);
  const sourceIds = new Set(
    turnStart.sourceMessages.flatMap((message) => {
      const id = message.uuid ?? message.id;
      return id ? [id] : [];
    }),
  );
  let sourceIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const id = message.uuid ?? message.id;
    if (
      sourceMessages.has(message) ||
      (id !== undefined && sourceIds.has(id))
    ) {
      sourceIndex = index;
    }
  }
  if (sourceIndex < 0) {
    return false;
  }

  let completed = false;
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.type === "user") {
      return false;
    }
    if (message && isTurnCompletionMessage(message)) {
      completed = true;
    }
  }
  return completed;
}

export function getSessionActivityUiState({
  owner,
  processState,
  items,
  messages,
  sessionLiveness = null,
  hasSessionUpdateStream = false,
  sessionUpdatesConnected = true,
}: SessionActivityUiInput): SessionActivityUiState {
  const turnStartIndex = latestTurnStartIndex(items);
  const latestTurnItems =
    turnStartIndex >= 0 ? items.slice(turnStartIndex + 1) : items;
  const hasPendingToolCalls = items.some(
    (item) => item.type === "tool_call" && item.status === "pending",
  );
  const hasPendingToolCallsInLatestTurn = latestTurnItems.some(
    (item) => item.type === "tool_call" && item.status === "pending",
  );
  // The dangling tool call the "waiting elsewhere" banner is about: the
  // tip-most pending tool_use in the latest turn. Used to name the tool and to
  // re-arm a per-tool dismissal when a *different* call goes pending.
  let pendingToolCallInLatestTurn: SessionActivityUiState["pendingToolCallInLatestTurn"] =
    null;
  for (let index = latestTurnItems.length - 1; index >= 0; index -= 1) {
    const item = latestTurnItems[index];
    if (item?.type === "tool_call" && item.status === "pending") {
      pendingToolCallInLatestTurn = {
        id: item.id,
        toolName: item.toolName,
        toolInput: item.toolInput,
      };
      break;
    }
  }
  const latestTurnSettled = isTerminalAssistantItem(
    latestSubstantiveItem(latestTurnItems),
  );
  const latestTurnCompleted = latestTurnHasCompletionMessage(items, messages);

  const ownsTurn = owner === "self";
  const providerRetained =
    sessionLiveness?.derivedStatus === "verified-waiting-provider";
  const staleStreamMayHideCurrentTurn =
    hasSessionUpdateStream && !sessionUpdatesConnected;
  const processStateIsActive =
    providerRetained || (!latestTurnCompleted && processState !== "idle");
  const latestTurnFallbackActive =
    !latestTurnCompleted &&
    !latestTurnSettled &&
    (hasPendingToolCallsInLatestTurn || staleStreamMayHideCurrentTurn);
  const latestTurnMayStillBeActive =
    ownsTurn && (processStateIsActive || latestTurnFallbackActive);
  const canStopOwnedProcess =
    ownsTurn &&
    (providerRetained ||
      (!latestTurnCompleted &&
        (processState === "in-turn" ||
          (!latestTurnSettled && hasPendingToolCallsInLatestTurn))));

  return {
    hasPendingToolCalls,
    hasPendingToolCallsInLatestTurn,
    pendingToolCallInLatestTurn,
    latestTurnSettled,
    latestTurnCompleted,
    canStopOwnedProcess,
    shouldDeferMessages: latestTurnMayStillBeActive,
    showProcessingIndicator: canStopOwnedProcess,
    shouldSuppressCurrentTurnOrphans:
      latestTurnMayStillBeActive &&
      (processState === "in-turn" ||
        processState === "waiting-input" ||
        providerRetained ||
        latestTurnFallbackActive),
  };
}
