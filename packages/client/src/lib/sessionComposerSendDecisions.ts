import {
  type ProviderName,
  type ServerCapabilitySource,
  startsWithSlashCommand,
  type TurnEffort,
} from "@yep-anywhere/shared";
import {
  isStaleSessionRedirect,
  requiresHandoffAfterClaudeResumeError,
} from "../api/refusal";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import { requiresAttachmentOnlyServerUpdate } from "./attachmentSubmission";
import { buildCorrectionText } from "./correctionText";
import {
  hasComposerDraftContent,
  type PreparedComposerSubmission,
} from "./sessionComposerSubmission";
import {
  resolveComposerSessionOperation,
  resolveComposerSlashTurn,
} from "./slashCommands";

/**
 * The session page's sending decisions, as plain functions of their inputs
 * (docs/tactical/179-session-composer-send-decisions.md). The page performs
 * what they return, in today's order.
 */

/** The message keys these decisions use. */
export type ComposerSendMessageKey =
  | "sessionCorrectionNoChanges"
  | "queuedCompactRequiresUpdate"
  | "queuedCompactSeparateAttachments"
  | "turnEffortUnavailable"
  | "routedSessionHandoffRequired"
  | "sessionSendFailed"
  | "sessionQueueFailed";

type Translate = (
  key: ComposerSendMessageKey,
  vars?: Record<string, string>,
) => string;

/** What preparing a composer submission reads from the session page. */
export interface ComposerSubmissionContext {
  /** The original text of the turn being corrected, when correcting. */
  correctionOriginalText: string | null;
  rewindSupported: boolean;
  manualCompactSupported: boolean;
  queuedCompactionSupported: boolean;
  syntheticDoneEnabled: boolean;
  syntheticDoneSupported: boolean;
  syntheticArchiveSupported: boolean;
  syntheticTerminateSupported: boolean;
  fileViewCommandSupported: boolean;
  btwAsidesSupported: boolean;
  turnEffortSupported: boolean;
  attachmentCount: number;
  pendingUploadCount: number;
  t: Translate;
}

/** Restore `restoreText` to the composer and show `message`. */
export interface ComposerSubmissionRefusal {
  kind: "refuse";
  message: string;
  severity: "error" | "info";
  restoreText: string;
}

export type ComposerLocalOperation =
  | { kind: "session-boundary"; command: "done" | "archive" | "terminate" }
  | { kind: "title"; title: string | null }
  | { kind: "view"; argument: string };

export type ComposerSubmissionFallback =
  | ComposerSubmissionRefusal
  | { kind: "drop" }
  | { kind: "submit"; prepared: PreparedComposerSubmission };

export type ComposerSubmissionDecision =
  | ComposerSubmissionRefusal
  /** A command YA runs itself. Correction mode ends first when it is set. */
  | {
      kind: "local";
      operation: ComposerLocalOperation;
      endCorrectionFirst: boolean;
    }
  /**
   * Try the page's custom command handler; when it handles the command,
   * correction mode ends afterwards (when set), else `fallback` applies.
   */
  | {
      kind: "custom";
      command: string;
      argument: string;
      endCorrectionIfHandled: boolean;
      fallback: ComposerSubmissionFallback;
    }
  /** Nothing to send, and nothing to say. */
  | { kind: "drop" }
  | { kind: "submit"; prepared: PreparedComposerSubmission };

/**
 * Decides what a composer submission becomes: a refusal, a local command, a
 * custom command, nothing, or a prepared submission.
 */
export function resolveComposerSubmission(
  text: string,
  queueIntent: boolean,
  context: ComposerSubmissionContext,
): ComposerSubmissionDecision {
  const { t } = context;
  const refuse = (
    message: string,
    severity: "error" | "info" = "error",
    restoreText = text,
  ): ComposerSubmissionRefusal => ({
    kind: "refuse",
    message,
    severity,
    restoreText,
  });
  // Recalling a turn and editing its slash command means "issue this command
  // again", not "correct my last sentence". Correction framing prepends a
  // line, which pushes `/goal ...` off offset 0 so the provider sends the
  // command through as prose, and a stripping command like `/fast ...` would
  // diff its bare argument against the unstripped original. So the whole
  // submission below behaves as a fresh invocation, including re-issuing an
  // unedited command the way shell history does. The decision reads the raw
  // composer text because `resolveComposerSlashTurn` has already consumed the
  // leading token by the time the outgoing text is built.
  const issuesSlashCommand =
    context.correctionOriginalText !== null && startsWithSlashCommand(text);
  // The outgoing text for a candidate, or the "no changes" refusal when a
  // correction would send its original unchanged.
  const frame = (
    candidate: string,
  ): { text: string } | ComposerSubmissionRefusal => {
    if (issuesSlashCommand || context.correctionOriginalText === null) {
      return { text: candidate };
    }
    const correctionText = buildCorrectionText(
      context.correctionOriginalText,
      candidate,
    );
    return correctionText
      ? { text: correctionText }
      : refuse(t("sessionCorrectionNoChanges"), "info", candidate);
  };
  const hasAttachments =
    context.attachmentCount > 0 || context.pendingUploadCount > 0;

  const slashTurn = resolveComposerSlashTurn(text, {
    rewindSupported: context.rewindSupported,
  });
  if (slashTurn.kind === "custom") {
    if (
      queueIntent &&
      slashTurn.command === "compact" &&
      context.manualCompactSupported
    ) {
      if (!context.queuedCompactionSupported) {
        return refuse(t("queuedCompactRequiresUpdate"));
      }
      if (hasAttachments) {
        return refuse(t("queuedCompactSeparateAttachments"));
      }
      return {
        kind: "submit",
        prepared: { outgoingText: text, queuedCompact: true },
      };
    }
    const sessionOperation = resolveComposerSessionOperation({
      text,
      routesToFocusedAside: false,
      syntheticDoneEnabled: context.syntheticDoneEnabled,
      syntheticDoneSupported: context.syntheticDoneSupported,
      syntheticArchiveSupported: context.syntheticArchiveSupported,
      syntheticTerminateSupported: context.syntheticTerminateSupported,
      hasAttachments,
    });
    if (sessionOperation.kind === "blocked") {
      return refuse(sessionOperation.message);
    }
    // Commands YA runs itself never reach the send path that ends correction
    // mode, so they end it here or the banner would outlive the command and
    // wrap the next ordinary message.
    if (sessionOperation.kind === "session-boundary") {
      return {
        kind: "local",
        operation: {
          kind: "session-boundary",
          command: sessionOperation.command,
        },
        endCorrectionFirst: issuesSlashCommand,
      };
    }
    if (sessionOperation.kind === "title") {
      return {
        kind: "local",
        operation: { kind: "title", title: sessionOperation.title },
        endCorrectionFirst: issuesSlashCommand,
      };
    }
    if (slashTurn.command === "view" && context.fileViewCommandSupported) {
      return {
        kind: "local",
        operation: { kind: "view", argument: slashTurn.argument },
        endCorrectionFirst: issuesSlashCommand,
      };
    }
    if (slashTurn.command === "btw" && !context.btwAsidesSupported) {
      return refuse(
        "/btw asides are available only for providers with a wired fork path.",
      );
    }
    // Unhandled custom commands send their text as typed: no thinking, slash
    // command or turn effort, and only a non-empty check.
    const framed = frame(text);
    return {
      kind: "custom",
      command: slashTurn.command,
      argument: slashTurn.argument,
      endCorrectionIfHandled: issuesSlashCommand,
      fallback:
        "kind" in framed
          ? framed
          : framed.text
            ? { kind: "submit", prepared: { outgoingText: framed.text } }
            : { kind: "drop" },
    };
  }

  if (slashTurn.kind === "error") {
    return refuse(slashTurn.message);
  }

  if (slashTurn.turnEffort && !context.turnEffortSupported) {
    return refuse(t("turnEffortUnavailable"));
  }

  const framed = frame(slashTurn.text);
  if ("kind" in framed) return framed;
  if (!hasComposerDraftContent(framed.text, context.attachmentCount)) {
    return { kind: "drop" };
  }
  return {
    kind: "submit",
    prepared: {
      outgoingText: framed.text,
      thinking: slashTurn.thinking,
      slashCommand: slashTurn.command,
      turnEffort: slashTurn.turnEffort,
    },
  };
}

/**
 * Turn-effort metadata (plan 179 S7). `send` defaults to direct delivery,
 * keeps the caller's intent and `steerNow`; `deferred` forces deferred
 * delivery and clears `steerNow`.
 */
export function mergeTurnEffortMetadata(
  metadata: MessageSubmissionMetadata | undefined,
  turnEffort: TurnEffort,
  variant: "send" | "deferred",
): MessageSubmissionMetadata {
  return variant === "send"
    ? {
        composition: {},
        deliveryIntent: "direct",
        ...metadata,
        turnEffort,
      }
    : {
        composition: {},
        ...metadata,
        deliveryIntent: "deferred",
        turnEffort,
        steerNow: undefined,
      };
}

export type SendPlan =
  /** A turn-effort turn while busy goes to the deferred queue instead. */
  | { kind: "queue-instead" }
  /** An attachment-only message to an old server: toast, keep nothing. */
  | { kind: "refuse-attachment-only" }
  | {
      kind: "send";
      metadata: MessageSubmissionMetadata | undefined;
      /** A local control command: no in-turn or idle state change. */
      localControl: boolean;
    };

/** What `handleSend` does with a prepared submission before any effect. */
export function planSend({
  prepared,
  metadata,
  processState,
  goalActive,
  preserveComposer,
  localControlRequested,
  version,
  attachmentCount,
}: {
  prepared: PreparedComposerSubmission;
  metadata: MessageSubmissionMetadata | undefined;
  processState: string;
  goalActive: boolean;
  preserveComposer: boolean;
  localControlRequested: boolean;
  version: ServerCapabilitySource | null | undefined;
  attachmentCount: number;
}): SendPlan {
  if (
    prepared.turnEffort &&
    (processState === "in-turn" || processState === "waiting-input")
  ) {
    return { kind: "queue-instead" };
  }
  const sendMetadata = prepared.turnEffort
    ? mergeTurnEffortMetadata(metadata, prepared.turnEffort, "send")
    : metadata;
  const localControl =
    localControlRequested ||
    (goalActive && /^\/goal(?:\s|$)/i.test(prepared.outgoingText));
  if (
    !preserveComposer &&
    requiresAttachmentOnlyServerUpdate({
      version,
      text: prepared.outgoingText,
      attachmentCount,
    })
  ) {
    return { kind: "refuse-attachment-only" };
  }
  return { kind: "send", metadata: sendMetadata, localControl };
}

export type QueuePlan =
  | { kind: "refuse-attachment-only" }
  | { kind: "queue"; metadata: MessageSubmissionMetadata | undefined };

/** What `handleQueue` does with a prepared submission before any effect. */
export function planQueue({
  prepared,
  metadata,
  version,
  attachmentCount,
}: {
  prepared: PreparedComposerSubmission;
  metadata: MessageSubmissionMetadata | undefined;
  version: ServerCapabilitySource | null | undefined;
  attachmentCount: number;
}): QueuePlan {
  const queueMetadata = prepared.turnEffort
    ? mergeTurnEffortMetadata(metadata, prepared.turnEffort, "deferred")
    : metadata;
  if (
    requiresAttachmentOnlyServerUpdate({
      version,
      text: prepared.outgoingText,
      attachmentCount,
    })
  ) {
    return { kind: "refuse-attachment-only" };
  }
  return { kind: "queue", metadata: queueMetadata };
}

/**
 * The resume request's settings. A first attempt carries `showThinking`; a
 * retried resume leaves it out (plan 179 S4).
 */
export function buildResumeOptions<
  Settings extends object,
  ShowThinking,
  Provider,
  Executor,
>(
  resumeSettings: Settings,
  {
    showThinking,
    includeShowThinking,
    provider,
    executor,
  }: {
    showThinking: ShowThinking;
    includeShowThinking: boolean;
    provider: Provider;
    executor: Executor;
  },
) {
  return includeShowThinking
    ? { ...resumeSettings, showThinking, provider, executor }
    : { ...resumeSettings, provider, executor };
}

/**
 * The first step after a send fails: a send already observed as delivered
 * confirms; a stale-session redirect hands off; anything else continues to
 * the retry and the final notice.
 */
export function firstSendFailureStep(
  error: unknown,
  delivered: boolean,
): "delivered" | "stale-redirect" | "continue" {
  if (delivered) return "delivered";
  if (isStaleSessionRedirect(error)) return "stale-redirect";
  return "continue";
}

/** Send retries with a resume when the process is gone (plan 179 S3). */
export function shouldRetrySendWithResume(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("404") ||
      error.message.includes("No active process"))
  );
}

/** Queue retries with a resume when the process is unavailable (S3). */
export function shouldRetryQueueWithResume(
  error: unknown,
  queuedCompact: boolean,
): boolean {
  const status = (error as { status?: number } | null)?.status;
  const unavailable =
    error instanceof Error &&
    (status === 404 ||
      status === 410 ||
      error.message.includes("No active process") ||
      error.message.includes("Process terminated"));
  return unavailable && !queuedCompact;
}

export const CLAUDE_HANDOFF_REQUIRED_MESSAGE =
  "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.";

/**
 * The notice after a send or queue finally fails: a resume that needs a
 * handoff offers the handoff dialog (unless the session is routed, which
 * cannot hand off yet) and explains; anything else is the path's generic
 * failure toast.
 */
export function finalFailureNotice({
  finalError,
  provider,
  routedSession,
  path,
  t,
}: {
  finalError: unknown;
  provider: ProviderName | undefined;
  routedSession: boolean;
  path: "send" | "queue";
  t: Translate;
}): { openHandoffDialog: boolean; message: string } {
  const errorMsg =
    finalError instanceof Error ? finalError.message : String(finalError);
  if (requiresHandoffAfterClaudeResumeError(finalError, provider)) {
    return {
      openHandoffDialog: !routedSession,
      message: routedSession
        ? t("routedSessionHandoffRequired")
        : errorMsg.includes("API error: 409")
          ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
          : errorMsg,
    };
  }
  return {
    openHandoffDialog: false,
    message: t(path === "send" ? "sessionSendFailed" : "sessionQueueFailed", {
      message: errorMsg,
    }),
  };
}
