import type { AntigravityCursorAlias } from "../sdk/providers/antigravity-live-projection.js";
import type {
  AntigravityLogBoundary,
  AntigravityOwnerView,
} from "../sdk/providers/antigravity-owners.js";
import { antigravityStepMessageId } from "./antigravity-log-projection.js";
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
 * 195 steps 5 and 6). An owner holds only what it produced since its
 * boundary that the log does not serve yet; the log holds everything
 * through the boundary. Log rows and live rows have different IDs, and each
 * row has one: the log's rows end at the boundary and the owner's start
 * after it, so no step is served twice or left out. Message IDs say which
 * side a cursor names (`antigravityMessageStep` recognizes the log's); a
 * live ID whose row moved to the log resolves through the owner's alias.
 */
export type AntigravityJoinPlan =
  /** The log alone, through the boundary: a page before a log message. */
  | { kind: "log"; request: AntigravityLogWindowRequest }
  /** The live rows alone: a catch-up from a message the owner holds. */
  | { kind: "live" }
  /**
   * The log through the boundary, then every live row. `anchor`: the read
   * starts after a cursor whose row moved to the log and holds only what
   * follows it (`resolved`), or it is a deliberate miss (`missed`): a
   * replacement window even where it holds the cursor's row.
   */
  | {
      kind: "join";
      request: AntigravityLogWindowRequest;
      anchor?: "resolved" | "missed";
    }
  /**
   * For a client that streamed the turn the last advance moved: the log
   * through the boundary before it, then that turn's rows under the live
   * IDs the client holds (`all`, those after a cursor among them, or those
   * before it), then, unless before, every live row. `anchor: resolved`:
   * the read holds only what follows the cursor. `unmovedOnly`: the log
   * part after the cursor must hold nothing an earlier advance moved, or
   * the client may hold that under live IDs too and the read is a miss.
   */
  | {
      kind: "moved";
      request: AntigravityLogWindowRequest;
      rows: "all" | { after: string } | { before: string };
      anchor?: "resolved";
      unmovedOnly?: true;
    };

/** What a plan needs of an open owner. */
export interface AntigravityJoinOwner {
  boundary?: AntigravityLogBoundary;
  moved?: { before: AntigravityLogBoundary; held: boolean };
  has(messageId: string): boolean;
  alias(messageId: string): AntigravityCursorAlias | undefined;
  movedIndex(messageId: string): number;
}

export function planAntigravityJoin(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  owner: AntigravityJoinOwner,
): AntigravityJoinPlan {
  const latest = (compactions: number) =>
    ({ kind: "join", request: { kind: "latest", compactions } }) as const;
  const missed = (compactions: number) =>
    ({
      kind: "join",
      request: { kind: "latest", compactions },
      anchor: "missed",
    }) as const;
  const moved = owner.moved;
  switch (request.kind) {
    case "complete":
    case "latest":
    case "since":
      return { kind: "join", request };
    case "before": {
      if (
        antigravityMessageStep(conversationId, request.messageId) !== undefined
      )
        return { kind: "log", request };
      // Older than a live row: the route cuts the joined latest page before
      // it, as it cuts an owner's whole projection.
      if (owner.has(request.messageId)) return latest(request.compactions);
      // A row of the moved turn: the log's latest page before that turn,
      // then the turn's rows before the cursor.
      if (moved && owner.movedIndex(request.messageId) >= 0)
        return {
          kind: "moved",
          request: { kind: "latest", compactions: request.compactions },
          rows: { before: request.messageId },
        };
      // An older moved prompt or compaction: the page before its step.
      const before = owner.alias(request.messageId)?.before;
      return before === undefined
        ? latest(request.compactions)
        : {
            kind: "log",
            request: {
              kind: "before",
              messageId: antigravityStepMessageId(conversationId, before),
              compactions: request.compactions,
            },
          };
    }
    case "after": {
      const step = antigravityMessageStep(conversationId, request.messageId);
      if (step !== undefined) {
        // A client whose last row predates the moved turn may hold that
        // turn under live IDs: serve those, never its records as well.
        if (!moved || step > moved.before.step)
          return { kind: "join", request };
        return moved.held
          ? { kind: "moved", request, rows: "all", unmovedOnly: true }
          : missed(request.compactions);
      }
      if (owner.has(request.messageId)) return { kind: "live" };
      if (moved?.held && owner.movedIndex(request.messageId) >= 0)
        return {
          kind: "moved",
          request: { kind: "head" },
          rows: { after: request.messageId },
          anchor: "resolved",
        };
      // An older moved row: only where nothing moved after its step that
      // the client could hold under live IDs.
      const after = owner.alias(request.messageId)?.after;
      if (after !== undefined && after === owner.boundary?.step)
        return {
          kind: "join",
          request: {
            kind: "since",
            step: after,
            compactions: request.compactions,
          },
          anchor: "resolved",
        };
      if (after !== undefined && moved?.held && after === moved.before.step)
        return {
          kind: "moved",
          request: { kind: "head" },
          rows: "all",
          anchor: "resolved",
        };
      // Unknown, or past a turn the client may hold: the latest page as a
      // miss.
      return after === undefined
        ? latest(request.compactions)
        : missed(request.compactions);
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
  const open = view?.state === "open" ? view : undefined;
  switch (plan.kind) {
    case "live":
      // Reads no records, but checks the log through the boundary and takes
      // the title from it.
      return { request: { kind: "head" }, boundary: open?.boundary };
    case "moved":
      return { request: plan.request, boundary: open?.moved?.before };
    default:
      return { request: plan.request, boundary: open?.boundary };
  }
}

type OpenView = Extract<AntigravityOwnerView, { state: "open" }>;

/**
 * An open owner's answer from a window read under `plan` (taken while the
 * view was `settled`, or, at the end of retries, under another split).
 * "miss": the read must be answered as a deliberate miss instead.
 */
export function joinAntigravityOwnerRead(
  conversationId: string,
  request: AntigravityLogWindowRequest,
  plan: AntigravityJoinPlan,
  window: AntigravityLogWindow,
  view: OpenView,
  settled: boolean,
): Extract<AntigravitySessionRead, { kind: "log" }> | "miss" {
  // History before the boundary that the log cannot supply now, or rows
  // the owner's cap dropped before the log served them.
  const incomplete = window.status !== "known" || !settled || view.incomplete;
  if (settled && plan.kind === "moved") {
    const rows = view.movedRows();
    if (window.status === "known" && rows) {
      const index = (id: string) => rows.findIndex((row) => row.uuid === id);
      const part =
        plan.rows === "all"
          ? rows
          : "after" in plan.rows
            ? rows.slice(index(plan.rows.after) + 1)
            : rows.slice(0, Math.max(0, index(plan.rows.before)));
      if (plan.unmovedOnly && request.kind === "after") {
        // Log rows after the cursor that an earlier advance moved may be
        // held under live IDs as well.
        const at = window.messages.findIndex(
          (message) => message.uuid === request.messageId,
        );
        const opened = view.opened?.step ?? -1;
        if (
          window.anchor !== "found" ||
          at < 0 ||
          window.messages
            .slice(at + 1)
            .some(
              (message) =>
                (antigravityMessageStep(conversationId, String(message.uuid)) ??
                  -1) > opened,
            )
        )
          return "miss";
      }
      const before = typeof plan.rows === "object" && "before" in plan.rows;
      return {
        kind: "log",
        window,
        moved: part as Message[],
        ...(before ? {} : { live: view.history() as Message[] }),
        paged: true,
        ...(plan.anchor ? { anchor: plan.anchor } : {}),
        incomplete,
      };
    }
  }
  // Whether this request's answer holds live rows, by the owner now.
  const joined =
    settled ||
    planAntigravityJoin(conversationId, request, view).kind !== "log";
  const anchor = settled && plan.kind === "join" ? plan.anchor : undefined;
  return {
    kind: "log",
    window:
      settled && plan.kind !== "moved"
        ? window
        : throughAntigravityBoundary(conversationId, window, view.boundary!),
    ...(plan.kind !== "log" || (!settled && joined)
      ? { live: view.history() as Message[] }
      : {}),
    paged: plan.kind !== "live",
    ...(anchor === "missed" ||
    (anchor === "resolved" &&
      window.status === "known" &&
      window.anchor === "found")
      ? { anchor }
      : {}),
    incomplete: incomplete || plan.kind === "moved",
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
 * opened, closed, advanced or dropped rows makes the read describe a
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
   * cap dropped the oldest rows.
   */
  | { kind: "owner"; messages: SDKMessage[]; incomplete?: boolean }
  /** The log (through an owner's boundary), then that owner's rows. */
  | {
      kind: "log";
      window: AntigravityLogWindow;
      /** The moved turn's rows a client streamed, after the log's. */
      moved?: Message[];
      /** An open owner's rows, after the log's. */
      live?: Message[];
      /** Whether the log was read as a page of this request. */
      paged: boolean;
      /**
       * For an `afterMessageId` read: it holds only what follows a cursor
       * whose row moved to the log, or it is a deliberate miss.
       */
      anchor?: "resolved" | "missed";
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
  const owned = [...(read.moved ?? []), ...(live ?? [])];
  const messages = [...(known?.messages ?? []), ...owned];
  // The conversation's first prompt, from the log: a resumed owner's own
  // prompt never titles it. A log that holds nothing yet (a new session's)
  // leaves the first prompt to the owner's rows.
  const title =
    known?.firstPrompt ??
    (known && !known.omittedPrefix && !known.messages.length
      ? firstUserText(owned)
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
    ...(live && paged ? { liveRowsHeld: true as const } : {}),
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
  loaded: { model?: string; complete: boolean; owner?: boolean },
): LoadedSession {
  const title = firstUserText(messages);
  summary.title = title?.slice(0, 120) ?? null;
  summary.fullTitle = title ?? null;
  summary.messageCount = messages.length;
  summary.model = loaded.model ?? lastModel(messages);
  return {
    summary,
    ...(!loaded.complete ? { transcriptComplete: false as const } : {}),
    ...(loaded.owner ? { liveRowsHeld: true as const } : {}),
    transcriptSnapshotUpdatedAt: mtime.toISOString(),
    data: { provider: "antigravity", session: { messages } },
  };
}
