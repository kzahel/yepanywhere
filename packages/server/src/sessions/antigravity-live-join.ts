import type {
  AntigravityHistoryGap,
  AntigravityLogBoundary,
  AntigravityOwnerView,
} from "../sdk/providers/antigravity-owners.js";
import { getModelContextWindow } from "@yep-anywhere/shared";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import { antigravityHistoryNotice } from "./antigravity-history-notice.js";
import type { AntigravityStepUsage } from "./antigravity-log-projection.js";
import {
  type AntigravityLogWindow,
  type AntigravityLogWindowRequest,
  antigravityMessageStep,
} from "./antigravity-log-window.js";
import type { LoadedSession } from "./types.js";

/**
 * How a read divides between `agy`'s brain log and an owner's memory (plan
 * 195 steps 5 and 6). An owner holds what it produced since its boundary;
 * the log holds everything through the boundary. Log rows and live rows
 * have different IDs: the log's rows end at the boundary and the owner's
 * start after it, so no step is served twice, except output that arrives
 * after a split it belongs before (`antigravity-live-advance.ts`); rows
 * the cap evicted are left out until a move covers them (the read is
 * incomplete). Message IDs say which side a cursor names
 * (`antigravityMessageStep` recognizes the log's). Once the owner has moved
 * its boundary, a client may hold rows before it under live IDs, so a
 * cursor that would cross them is a miss: a replacement window.
 */
export type AntigravityJoinPlan =
  /** The log alone, through the boundary: a page before a log message. */
  | { kind: "log"; request: AntigravityLogWindowRequest }
  /** The live rows alone: a catch-up from a message the owner holds. */
  | { kind: "live" }
  /**
   * The log through the boundary, then every live row. `anchor: missed`: a
   * deliberate miss, a replacement window.
   */
  | {
      kind: "join";
      request: AntigravityLogWindowRequest;
      anchor?: "missed";
    };

/** What a plan needs of an open owner. */
export interface AntigravityJoinOwner {
  boundary: AntigravityLogBoundary;
  opened: AntigravityLogBoundary;
  has(messageId: string): boolean;
}

export function planAntigravityJoin(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  owner: AntigravityJoinOwner,
): AntigravityJoinPlan {
  const latest = (compactions: number) =>
    ({ kind: "join", request: { kind: "latest", compactions } }) as const;
  switch (request.kind) {
    case "complete":
    case "latest":
      return { kind: "join", request };
    case "before":
      // Older than a live row: the route cuts the joined latest page before
      // it, as it cuts an owner's whole projection. A row that left memory
      // is not in that page, so the answer is an empty page, which the
      // browser recovers from by taking the tail again.
      return antigravityMessageStep(conversationId, request.messageId) ===
        undefined
        ? latest(request.compactions)
        : { kind: "log", request };
    case "after": {
      const step = antigravityMessageStep(conversationId, request.messageId);
      // A log row before a moved boundary: the log after it holds rows that
      // were live once (past where the owner opened), which this client may
      // hold under live IDs. Decided from the steps alone, conservatively.
      if (step !== undefined)
        return owner.boundary.step > owner.opened.step &&
          step < owner.boundary.step
          ? { ...latest(request.compactions), anchor: "missed" }
          : { kind: "join", request };
      // The owner's (its rows follow the anchor), or one that left memory
      // or never existed, which the latest page answers as a miss.
      return owner.has(request.messageId)
        ? { kind: "live" }
        : latest(request.compactions);
    }
    case "head":
      return { kind: "log", request };
  }
}

/** The window a plan reads, and the boundary it reads through. */
export function antigravityPlanWindow(
  plan: AntigravityJoinPlan,
  view: AntigravityOwnerView | undefined,
): { request: AntigravityLogWindowRequest; boundary?: AntigravityLogBoundary } {
  const boundary = view?.boundary;
  // A live-only catch-up reads no records, but checks the log through the
  // boundary and takes the title from it.
  return plan.kind === "live"
    ? { request: { kind: "head" }, boundary }
    : { request: plan.request, boundary };
}

/**
 * An open owner's answer from a window read under `plan` (taken while the
 * view was `settled`, or, at the end of retries, under another split).
 */
export function joinAntigravityOwnerRead(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  plan: AntigravityJoinPlan,
  window: AntigravityLogWindow,
  view: AntigravityOwnerView,
  settled: boolean,
): AntigravitySessionRead {
  // This request's plan by the owner now: whether it holds live rows, and
  // whether a move since makes it a miss.
  const now = settled
    ? plan
    : planAntigravityJoin(conversationId, request, view);
  const joined = settled || now.kind !== "log";
  const anchor =
    (plan.kind === "join" && plan.anchor) ||
    (now.kind === "join" && now.anchor);
  return {
    window: settled
      ? window
      : throughAntigravityBoundary(conversationId, window, view.boundary),
    ...(plan.kind !== "log" || (!settled && joined)
      ? { live: view.history() as Message[] }
      : {}),
    paged: plan.kind !== "live",
    ...(anchor ? { anchor } : {}),
    ...(view.firstPrompt !== undefined
      ? { firstPrompt: view.firstPrompt }
      : {}),
    ...(view.earlier ? { earlier: view.earlier } : {}),
    ...(view.model !== undefined ? { model: view.model } : {}),
    ...(view.contextUsage ? { contextUsage: { ...view.contextUsage } } : {}),
    // History before the boundary that the log cannot supply now, or rows
    // the owner's cap evicted before the log served them.
    incomplete: window.status !== "known" || !settled || view.incomplete,
  };
}

/**
 * Whether a read taken under `before` still describes the conversation once
 * it returns under `after`: the same open owner at the same generation (no
 * boundary move, no row left memory), or no open owner either time. An
 * owner that is only starting has written nothing (it writes only after it
 * opens and is prompted), so a cold read stays valid; one that opened,
 * closed, moved its boundary or evicted rows makes the read describe a
 * different split.
 */
export function sameAntigravitySplit(
  before: AntigravityOwnerView | undefined,
  after: AntigravityOwnerView | undefined,
): boolean {
  return before
    ? after?.owner === before.owner && after.generation === before.generation
    : !after;
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
    (window.source?.dev !== boundary.dev || window.source?.ino !== boundary.ino)
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

/** One read of a conversation: the log (through an open owner's boundary), then that owner's rows. */
export interface AntigravitySessionRead {
  window: AntigravityLogWindow;
  /** An open owner's rows, after the log's. */
  live?: Message[];
  /** Whether the log was read as a page of this request. */
  paged: boolean;
  /** For an `afterMessageId` read: a deliberate miss. */
  anchor?: "missed";
  /** The owner's first prompt, when the log cannot title the conversation. */
  firstPrompt?: string;
  /** The owner resumed with no readable log: history before it is not shown. */
  earlier?: AntigravityHistoryGap;
  /**
   * The model of the owner's newest assistant row, for an answer that
   * carries only its rows from an anchor on.
   */
  model?: string;
  /** Latest live context meter reading observed by the owner. */
  contextUsage?: ContextUsage;
  /**
   * Earlier history the answer cannot supply: an open owner's log is
   * missing or unknown through its boundary, or the owner kept changing
   * during every read.
   */
  incomplete?: boolean;
}

function firstUserText(messages: readonly Message[]): string | undefined {
  for (const message of messages)
    if (message.type === "user" && typeof message.message?.content === "string")
      return message.message.content;
  return undefined;
}

/**
 * The context the last logged model call filled, from its step's tokens.
 * Live owner rows carry none; once the owner observes `usage_update`,
 * `read.contextUsage` takes precedence over pre-boundary log steps.
 */
function lastContextUsage(
  messages: readonly Message[],
): ContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]?.message;
    const usage = message?.usage as AntigravityStepUsage | undefined;
    if (!usage) continue;
    const inputTokens = usage.input_tokens + usage.cache_read_input_tokens;
    const model = typeof message?.model === "string" ? message.model : "";
    const contextWindow = getModelContextWindow(model, "antigravity");
    return {
      inputTokens,
      percentage: Math.min(
        100,
        Math.round((inputTokens / contextWindow) * 100),
      ),
      contextWindow,
      ...(usage.output_tokens ? { outputTokens: usage.output_tokens } : {}),
      ...(usage.cache_read_input_tokens
        ? { cacheReadTokens: usage.cache_read_input_tokens }
        : {}),
    };
  }
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
 * Which history before the window's rows cannot be shown: a log YA cannot
 * read; no log for a conversation that was prompted (one never prompted
 * has no history to show); or, at the log's start, history before an
 * owner's resume point that had no readable log then, or records a log
 * that starts after step 0 lacks.
 */
function antigravityHistoryGap(
  window: AntigravityLogWindow,
  read: AntigravitySessionRead,
  neverPrompted: boolean,
): AntigravityHistoryGap | undefined {
  if (window.status === "unknown") return "unknown";
  if (window.status === "missing") return neverPrompted ? undefined : "missing";
  if (window.omittedPrefix) return undefined;
  return read.earlier ?? (window.firstStep ? "missing" : undefined);
}

/**
 * A detail response for a read: the window, then an open owner's rows. A
 * log that is missing or unknown, or history an owner resumed without, is
 * one informational row where that history would be, and the transcript is
 * incomplete; an owner whose log is unreadable now still serves its rows.
 */
export function antigravityJoinedSession(
  conversationId: string,
  summary: SessionSummary,
  mtime: Date,
  request: AntigravityLogWindowRequest,
  read: AntigravitySessionRead,
  /** No log and `agy`'s step count is 0: there is nothing to show. */
  neverPrompted: boolean,
): LoadedSession {
  const { window, live, paged } = read;
  const known = window.status === "known" ? window : undefined;
  const gap = antigravityHistoryGap(window, read, neverPrompted);
  const messages = [
    ...(gap
      ? [
          antigravityHistoryNotice(
            conversationId,
            gap,
            window.status === "unknown" ? window.reason : undefined,
          ),
        ]
      : []),
    ...(known?.messages ?? []),
    ...(live ?? []),
  ];
  // The conversation's first prompt, from the log: a resumed owner's own
  // prompt never titles it. A log that holds nothing yet (a new session's)
  // leaves it to the owner's first prompt, kept even once evicted.
  const title =
    known?.firstPrompt ??
    (known && !known.omittedPrefix && !known.messages.length && !read.earlier
      ? (read.firstPrompt ?? firstUserText(live ?? []))
      : undefined);
  if (title !== undefined) {
    summary.title = title.slice(0, 120);
    summary.fullTitle = title;
  }
  summary.messageCount = messages.length;
  summary.model = lastModel(messages) ?? read.model;
  const contextUsage = read.contextUsage ?? lastContextUsage(messages);
  if (contextUsage) summary.contextUsage = contextUsage;
  return {
    summary,
    ...(read.incomplete || gap ? { transcriptComplete: false as const } : {}),
    ...(read.anchor ? { afterAnchor: read.anchor } : {}),
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
