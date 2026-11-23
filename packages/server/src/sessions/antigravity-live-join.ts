import type {
  AntigravityLogBoundary,
  AntigravityOwnerView,
} from "../sdk/providers/antigravity-owners.js";
import type { SDKMessage } from "../sdk/types.js";
import type { Message, SessionSummary } from "../supervisor/types.js";
import {
  type AntigravityLogWindow,
  type AntigravityLogWindowRequest,
  antigravityMessageStep,
} from "./antigravity-log-window.js";
import type { LoadedSession } from "./types.js";

/**
 * How a read divides between `agy`'s brain log and an owner's memory (plan
 * 195 step 5). An owner that resumed from the log holds only what it
 * produced since its boundary; the log holds everything through it. Log
 * rows and live rows have different IDs, and each row has one: the log's
 * rows end at the boundary and the owner's start after it, so no step is
 * served twice or left out. Message IDs say which side a cursor names
 * (`antigravityMessageStep` recognizes the log's).
 */
export type AntigravityJoinPlan =
  /** The log alone, through the boundary: a page before a log message. */
  | { kind: "log"; request: AntigravityLogWindowRequest }
  /** The live rows alone: a catch-up from a message the owner holds. */
  | { kind: "live" }
  /** The log through the boundary, then every live row. */
  | { kind: "join"; request: AntigravityLogWindowRequest };

export function planAntigravityJoin(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  ownerHas: (messageId: string) => boolean,
): AntigravityJoinPlan {
  switch (request.kind) {
    case "complete":
    case "latest":
      return { kind: "join", request };
    case "before":
      // Older than a live row: the route cuts the joined latest page before
      // it, as it cuts an owner's whole projection.
      return antigravityMessageStep(conversationId, request.messageId) ===
        undefined
        ? {
            kind: "join",
            request: { kind: "latest", compactions: request.compactions },
          }
        : { kind: "log", request };
    case "after":
      if (
        antigravityMessageStep(conversationId, request.messageId) !== undefined
      )
        return { kind: "join", request };
      // Not a log ID: either the owner's (its rows follow the anchor) or
      // unknown, which the route answers with the latest page as a miss.
      return ownerHas(request.messageId)
        ? { kind: "live" }
        : {
            kind: "join",
            request: { kind: "latest", compactions: request.compactions },
          };
    case "head":
      return { kind: "log", request };
  }
}

/** An open owner's boundary, or none for a cold read or a starting owner. */
export function ownerBoundary(
  view: AntigravityOwnerView | undefined,
): AntigravityLogBoundary | undefined {
  return view?.state === "open" ? view.boundary : undefined;
}

/**
 * Whether a read taken under `before` still describes the conversation once
 * it returns under `after`: the same open owner at the same boundary, or no
 * open owner either time. An owner that only started meanwhile has written
 * nothing (it writes only after it opens and is prompted), so a cold read
 * stays valid; one that opened, closed or moved its boundary makes the read
 * describe a different split.
 */
export function sameAntigravitySplit(
  before: AntigravityOwnerView | undefined,
  after: AntigravityOwnerView | undefined,
): boolean {
  return before?.state === "open"
    ? after?.state === "open" &&
        after.owner === before.owner &&
        after.boundary?.end === before.boundary?.end
    : after?.state !== "open";
}

/**
 * A window cut to an owner's boundary: a read taken under another split
 * keeps no log row past the history the owner's rows begin after. A window
 * read from a file other than the one the boundary pins is no part of that
 * owner's history, so none of it is kept.
 */
export function throughAntigravityBoundary(
  conversationId: string,
  window: AntigravityLogWindow,
  boundary: AntigravityLogBoundary,
): AntigravityLogWindow {
  if (window.status !== "known") return window;
  if (
    boundary.ino !== undefined &&
    (window.source.dev !== boundary.dev || window.source.ino !== boundary.ino)
  )
    return {
      status: "unknown",
      reason: "the read came from a log the owner's resume point does not pin",
      bytesRead: window.bytesRead,
    };
  return {
    ...window,
    messages: window.messages.filter((message) => {
      const step = antigravityMessageStep(conversationId, String(message.uuid));
      return step === undefined || step <= boundary.step;
    }),
  };
}

/** One read of a conversation, divided between the log and an owner. */
export type AntigravitySessionRead =
  /** An owner whose projection is the whole history. */
  | { kind: "owner"; messages: SDKMessage[] }
  /** The log (through an owner's boundary), then that owner's rows. */
  | {
      kind: "log";
      window: AntigravityLogWindow;
      /** An open owner's rows, after the log's. */
      live?: Message[];
      /** Whether the log was read as a page of this request. */
      paged: boolean;
      /**
       * Earlier history the answer cannot supply: an open owner's log is
       * missing or unknown through its boundary, or the owner kept
       * changing during every read.
       */
      incomplete?: boolean;
    }
  /** The log is missing or unknown and no owner holds the conversation. */
  | { kind: "fallback" };

function firstUserText(messages: readonly Message[]): string | undefined {
  for (const message of messages)
    if (message.type === "user" && typeof message.message?.content === "string")
      return message.message.content;
  return undefined;
}

function lastModel(messages: readonly Message[]): string | undefined {
  const model = [...messages]
    .reverse()
    .find((message) => message.type === "assistant" && message.message?.model)
    ?.message?.model;
  return typeof model === "string" ? model : undefined;
}

/**
 * A detail response for a log read: the window, then an open owner's rows.
 * An owner whose log is unreadable now still serves its own rows, as an
 * incomplete transcript.
 */
export function antigravityJoinedSession(
  summary: SessionSummary,
  mtime: Date,
  request: AntigravityLogWindowRequest,
  read: Extract<AntigravitySessionRead, { kind: "log" }>,
): LoadedSession {
  const { window, live, paged } = read;
  const known = window.status === "known" ? window : undefined;
  const messages = [...(known?.messages ?? []), ...(live ?? [])];
  // The conversation's first prompt, from the log: a resumed owner's own
  // prompt never titles it.
  const title = known?.firstPrompt;
  if (title !== undefined) {
    summary.title = title.slice(0, 120);
    summary.fullTitle = title;
  }
  summary.messageCount = messages.length;
  summary.model = lastModel(messages);
  return {
    summary,
    ...(read.incomplete || window.status === "unknown"
      ? { transcriptComplete: false as const }
      : {}),
    transcriptSnapshotUpdatedAt: mtime.toISOString(),
    ...(request.kind === "complete" || !known || !paged
      ? {}
      : {
          readWindow: {
            kind: "log-page" as const,
            omittedPrefix: known.omittedPrefix,
            // The route cuts a joined page before a live row itself.
            before: request.kind === "before" && !live,
            ...(known.cut ? { cut: known.cut } : {}),
          },
        }),
    data: { provider: "antigravity", session: { messages } },
  };
}

/** A whole history: an owner's projection, or the ACP fallback's replay. */
export function antigravityWholeSession(
  summary: SessionSummary,
  mtime: Date,
  messages: Message[],
  loaded: { model?: string; complete: boolean },
): LoadedSession {
  const title = firstUserText(messages);
  summary.title = title?.slice(0, 120) ?? null;
  summary.fullTitle = title ?? null;
  summary.messageCount = messages.length;
  summary.model = loaded.model ?? lastModel(messages);
  return {
    summary,
    ...(!loaded.complete ? { transcriptComplete: false as const } : {}),
    transcriptSnapshotUpdatedAt: mtime.toISOString(),
    data: { provider: "antigravity", session: { messages } },
  };
}
