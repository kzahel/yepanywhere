import { startsWithSlashCommand } from "@yep-anywhere/shared";
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
  | "turnEffortUnavailable";

type Translate = (key: ComposerSendMessageKey) => string;

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
