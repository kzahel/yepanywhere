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
  boundary?: AntigravityLogBoundary;
  opened?: AntigravityLogBoundary;
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
        return owner.boundary &&
          owner.opened &&
          owner.boundary.step > owner.opened.step &&
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
  const boundary = view?.state === "open" ? view.boundary : undefined;
  // A live-only catch-up reads no records, but checks the log through the
  // boundary and takes the title from it.
  return plan.kind === "live"
    ? { request: { kind: "head" }, boundary }
    : { request: plan.request, boundary };
}

type OpenView = Extract<AntigravityOwnerView, { state: "open" }>;

/**
 * An open owner's answer from a window read under `plan` (taken while the
 * view was `settled`, or, at the end of retries, under another split).
 */
export function joinAntigravityOwnerRead(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  plan: AntigravityJoinPlan,
  window: AntigravityLogWindow,
  view: OpenView,
  settled: boolean,
): Extract<AntigravitySessionRead, { kind: "log" }> {
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
    kind: "log",
    window: settled
      ? window
      : throughAntigravityBoundary(conversationId, window, view.boundary!),
    ...(plan.kind !== "log" || (!settled && joined)
      ? { live: view.history() as Message[] }
      : {}),
    paged: plan.kind !== "live",
    ...(anchor ? { anchor } : {}),
    ...(view.firstPrompt !== undefined
      ? { firstPrompt: view.firstPrompt }
      : {}),
    // History before the boundary that the log cannot supply now, or rows
    // the owner's cap evicted before the log served them.
    incomplete: window.status !== "known" || !settled || view.incomplete,
  };
}

/** An open owner's boundary, or none for a cold read or a starting owner. */
export function ownerBoundary(
  view: AntigravityOwnerView | undefined,
): AntigravityLogBoundary | undefined {
  return view?.state === "open" ? view.boundary : undefined;
}

/**
 * Whether a read taken under `before` still describes the conversation once
 * it returns under `after`: the same open owner at the same generation (no
 * boundary move, no row left memory), or no open owner either time. An
 * owner that only started meanwhile has written nothing (it writes only
 * after it opens and is prompted), so a cold read stays valid; one that
 * opened, closed, moved its boundary or evicted rows makes the read describe a
 * different split.
 */
export function sameAntigravitySplit(
  before: AntigravityOwnerView | undefined,
  after: AntigravityOwnerView | undefined,
): boolean {
  return before?.state === "open"
    ? after?.state === "open" &&
        after.owner === before.owner &&
        after.generation === before.generation
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

/** One read of a conversation, divided between the log and an owner. */
export type AntigravitySessionRead =
  /**
   * An owner whose projection is the whole history; `incomplete` once its
   * cap evicted the oldest rows.
   */
  | {
      kind: "owner";
      messages: SDKMessage[];
      incomplete?: boolean;
      firstPrompt?: string;
    }
  /** The log (through an owner's boundary), then that owner's rows. */
  | {
      kind: "log";
      window: AntigravityLogWindow;
      /** An open owner's rows, after the log's. */
      live?: Message[];
      /** Whether the log was read as a page of this request. */
      paged: boolean;
      /** For an `afterMessageId` read: a deliberate miss. */
      anchor?: "missed";
      /** The owner's first prompt, when the log cannot title the conversation. */
      firstPrompt?: string;
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
  // prompt never titles it. A log that holds nothing yet (a new session's)
  // leaves it to the owner's first prompt, kept even once evicted.
  const title =
    known?.firstPrompt ??
    (known && !known.omittedPrefix && !known.messages.length
      ? (read.firstPrompt ?? firstUserText(live ?? []))
      : undefined);
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

/** A whole history: an owner's projection, or the ACP fallback's replay. */
export function antigravityWholeSession(
  summary: SessionSummary,
  mtime: Date,
  messages: Message[],
  loaded: { model?: string; complete: boolean; firstPrompt?: string },
): LoadedSession {
  const title = loaded.firstPrompt ?? firstUserText(messages);
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
