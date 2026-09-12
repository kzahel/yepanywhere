import type {
  DurableRecapMessage,
  DurableLocalCommandMessage,
  DurableSyntheticDoneMessage,
} from "@yep-anywhere/shared";
import type { NotificationService } from "../notifications/index.js";
import type { SDKMessage } from "../sdk/types.js";
import type { Message, Session, SessionSummary } from "../supervisor/types.js";
import { formatAgentRecapExcerpt } from "./agent-excerpt.js";

const RECAP_DUPLICATE_WINDOW_MS = 5_000;

export function messageTimestampMs(message: {
  timestamp?: unknown;
}): number | null {
  if (typeof message.timestamp !== "string") {
    return null;
  }
  const ms = Date.parse(message.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

export function isAwaySummaryMessage(message: {
  type?: unknown;
  subtype?: unknown;
}): boolean {
  return message.type === "system" && message.subtype === "away_summary";
}

export function getSystemMessageText(message: {
  content?: unknown;
  message?: { content?: unknown };
}): string {
  const content = message.content ?? message.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string"
        ? typed.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function toDurableRecapMessage(
  message: SDKMessage,
  source: DurableRecapMessage["yaRecapSource"],
): DurableRecapMessage | null {
  if (!isAwaySummaryMessage(message)) {
    return null;
  }
  const content = getSystemMessageText(message).trim();
  if (!content) {
    return null;
  }
  const timestamp =
    typeof message.timestamp === "string"
      ? message.timestamp
      : new Date().toISOString();
  const uuid =
    typeof message.uuid === "string" && message.uuid
      ? message.uuid
      : `recap-${timestamp}-${content.slice(0, 32)}`;
  return {
    type: "system",
    subtype: "away_summary",
    content,
    timestamp,
    uuid,
    id: uuid,
    ...(typeof message.session_id === "string"
      ? { session_id: message.session_id }
      : {}),
    ...(typeof message.isMeta === "boolean" ? { isMeta: message.isMeta } : {}),
    ...(message.isSynthetic === true ? { isSynthetic: true } : {}),
    yaRecapSource: source,
  };
}

export function hasEquivalentRecapMessage(
  messages: readonly Message[],
  recap: DurableRecapMessage,
): boolean {
  const recapMs = messageTimestampMs(recap);
  return messages.some((message) => {
    if (message.uuid === recap.uuid || message.id === recap.uuid) {
      return true;
    }
    if (!isAwaySummaryMessage(message)) {
      return false;
    }
    if (getSystemMessageText(message).trim() !== recap.content) {
      return false;
    }
    const messageMs = messageTimestampMs(message);
    if (recapMs === null || messageMs === null) {
      return message.timestamp === recap.timestamp;
    }
    return Math.abs(messageMs - recapMs) <= RECAP_DUPLICATE_WINDOW_MS;
  });
}

export function mergeRecapMessages(
  messages: readonly Message[],
  recaps: readonly DurableRecapMessage[],
): Message[] {
  if (recaps.length === 0) {
    return [...messages];
  }

  const merged = [...messages];
  const sortedRecaps = [...recaps].sort(
    (a, b) => (messageTimestampMs(a) ?? 0) - (messageTimestampMs(b) ?? 0),
  );

  // Overlay recaps inserted by this merge, so a newer recap can supersede an
  // older overlay row that has no provider content after it. An older recap
  // only remains visible when real transcript content follows it (it then
  // reads as a milestone marker at the point it covered); provider-emitted
  // recap rows are never removed.
  const insertedOverlays = new Set<Message>();

  for (const recap of sortedRecaps) {
    if (hasEquivalentRecapMessage(merged, recap)) {
      continue;
    }
    const recapMs = messageTimestampMs(recap);
    let insertAt = merged.length;
    if (recapMs !== null) {
      const laterIndex = merged.findIndex((message) => {
        const messageMs = messageTimestampMs(message);
        return messageMs !== null && messageMs > recapMs;
      });
      if (laterIndex >= 0) {
        insertAt = laterIndex;
      }
    }
    const prior = insertAt > 0 ? merged[insertAt - 1] : undefined;
    if (prior !== undefined && insertedOverlays.has(prior)) {
      insertedOverlays.delete(prior);
      merged.splice(insertAt - 1, 1, recap as Message);
    } else {
      merged.splice(insertAt, 0, recap as Message);
    }
    insertedOverlays.add(recap as Message);
  }

  return merged;
}

export function mergeSyntheticDoneMessages(
  messages: readonly Message[],
  doneMessages: readonly DurableSyntheticDoneMessage[],
): Message[] {
  if (doneMessages.length === 0) {
    return [...messages];
  }

  const merged = [...messages];
  const sortedDoneMessages = [...doneMessages].sort(
    (a, b) => (messageTimestampMs(a) ?? 0) - (messageTimestampMs(b) ?? 0),
  );
  for (const doneMessage of sortedDoneMessages) {
    if (
      merged.some(
        (message) =>
          message.uuid === doneMessage.uuid || message.id === doneMessage.id,
      )
    ) {
      continue;
    }
    const doneMs = messageTimestampMs(doneMessage);
    let insertAt = merged.length;
    if (doneMs !== null) {
      const laterIndex = merged.findIndex((message) => {
        const messageMs = messageTimestampMs(message);
        return messageMs !== null && messageMs > doneMs;
      });
      if (laterIndex >= 0) {
        insertAt = laterIndex;
      }
    }
    merged.splice(insertAt, 0, doneMessage as Message);
  }
  return merged;
}

/** Keep command receipts within the requested provider history window. */
export function mergeLocalCommandMessages(
  messages: readonly Message[],
  commands: readonly DurableLocalCommandMessage[],
  window: { hasOlderMessages?: boolean; hasNewerMessages?: boolean } = {},
): Message[] {
  const merged = [...messages];
  const firstMs = messages.map(messageTimestampMs).find((ms) => ms !== null);
  const lastMs = messages
    .map(messageTimestampMs)
    .reverse()
    .find((ms) => ms !== null);
  for (const command of [...commands].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )) {
    if (
      merged.some(
        (message) => message.uuid === command.uuid || message.id === command.id,
      )
    )
      continue;
    const anchor = command.placementAfterMessageId;
    const anchorIndex = anchor
      ? merged.findIndex(
          (message) => message.uuid === anchor || message.id === anchor,
        )
      : -1;
    let insertAt: number;
    if (anchorIndex >= 0) {
      insertAt = anchorIndex + 1;
      while (
        insertAt < merged.length &&
        merged[insertAt]?.subtype === "local_command" &&
        merged[insertAt]?.placementAfterMessageId === anchor
      )
        insertAt++;
    } else {
      const ms = Date.parse(command.timestamp);
      if (window.hasOlderMessages && (firstMs === undefined || ms < firstMs))
        continue;
      if (window.hasNewerMessages && (lastMs === undefined || ms > lastMs))
        continue;
      const later = merged.findIndex((message) => {
        const timestamp = messageTimestampMs(message);
        return timestamp !== null && timestamp > ms;
      });
      insertAt = later < 0 ? merged.length : later;
    }
    merged.splice(insertAt, 0, command as Message);
  }
  return merged;
}

export function mergeSessionOverlayMessages(
  messages: readonly Message[],
  recaps: readonly DurableRecapMessage[],
  doneMessages: readonly DurableSyntheticDoneMessage[],
  localCommands: readonly DurableLocalCommandMessage[] = [],
): Message[] {
  // Insert user-visible done boundaries before recaps so recap supersession
  // recognizes `/done` as intervening transcript content.
  return mergeRecapMessages(
    mergeLocalCommandMessages(
      mergeSyntheticDoneMessages(messages, doneMessages),
      localCommands,
    ),
    recaps,
  );
}

export function latestRecapMessage(
  recaps: readonly DurableRecapMessage[],
): DurableRecapMessage | undefined {
  let latest: DurableRecapMessage | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const recap of recaps) {
    const recapMs = messageTimestampMs(recap);
    if (recapMs === null || recapMs < latestMs) {
      continue;
    }
    latest = recap;
    latestMs = recapMs;
  }
  return latest;
}

/**
 * Bump summary freshness (updatedAt/lastAgentText) to the latest recap.
 * The bump is display/order freshness only: unread computations must
 * compare lastSeen against the pre-overlay updatedAt, so a recap landing
 * never flips its session unread (recaps describe provider content, they
 * are not provider content).
 */
export function applyRecapOverlayToSummary<T extends SessionSummary>(
  summary: T,
  recaps: readonly DurableRecapMessage[],
): T {
  const latest = latestRecapMessage(recaps);
  if (!latest) {
    return summary;
  }
  const recapMs = messageTimestampMs(latest);
  const summaryMs = Date.parse(summary.updatedAt);
  if (
    recapMs === null ||
    (Number.isFinite(summaryMs) && recapMs <= summaryMs)
  ) {
    return summary;
  }

  const lastAgentText = formatAgentRecapExcerpt(latest.content);
  return {
    ...summary,
    updatedAt: latest.timestamp,
    ...(lastAgentText ? { lastAgentText } : {}),
  };
}

export function applyRecapOverlayToSession<T extends Session>(
  session: T,
  recaps: readonly DurableRecapMessage[],
): T {
  const summary = applyRecapOverlayToSummary(session, recaps);
  return {
    ...summary,
    messages: mergeRecapMessages(session.messages, recaps),
  };
}

export function applySessionOverlaysToSession<T extends Session>(
  session: T,
  recaps: readonly DurableRecapMessage[],
  doneMessages: readonly DurableSyntheticDoneMessage[],
  localCommands: readonly DurableLocalCommandMessage[] = [],
): T {
  const summary = applyRecapOverlayToSummary(session, recaps);
  return {
    ...summary,
    messages: mergeSessionOverlayMessages(
      session.messages,
      recaps,
      doneMessages,
      localCommands,
    ),
  };
}

/**
 * Unread tracks provider content only: recap overlays bump `updatedAt` for
 * list freshness (see applyRecapOverlayToSummary), so every unread
 * computation compares lastSeen against the pre-overlay provider-transcript
 * timestamp.
 */
export function hasUnreadProviderContent(
  notificationService: NotificationService | undefined,
  sessionId: string,
  preOverlayUpdatedAt: string,
): boolean | undefined {
  return notificationService
    ? notificationService.hasUnread(sessionId, preOverlayUpdatedAt)
    : undefined;
}

/**
 * A live YA process sees provider messages before every platform necessarily
 * publishes the rollout's final filesystem timestamp. Keep provider unread
 * state on the later real activity clock without letting recap-only overlays
 * participate in the comparison.
 */
export function getEffectiveProviderUpdatedAt(
  summaryUpdatedAt: string,
  process: { lastProviderContentTime?: Date | null } | undefined,
): string {
  const lastProviderContentTime = process?.lastProviderContentTime;
  if (!(lastProviderContentTime instanceof Date)) return summaryUpdatedAt;

  const processUpdatedAtMs = lastProviderContentTime.getTime();
  if (!Number.isFinite(processUpdatedAtMs)) return summaryUpdatedAt;

  const summaryUpdatedAtMs = Date.parse(summaryUpdatedAt);
  return !Number.isFinite(summaryUpdatedAtMs) ||
    processUpdatedAtMs > summaryUpdatedAtMs
    ? lastProviderContentTime.toISOString()
    : summaryUpdatedAt;
}
