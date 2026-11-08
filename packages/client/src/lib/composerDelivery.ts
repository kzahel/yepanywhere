import type {
  PatientQueueSource,
  UserMessageDeliveryIntent,
} from "@yep-anywhere/shared";
import type { ChosenNewSessionQueueTarget } from "../components/NewSessionQueueOptions";
import { resolveComposerBangDraft } from "./bangCommands";
import { hasComposerDraftContent } from "./sessionComposerSubmission";

/**
 * Where one press of the message box sends its draft
 * (docs/tactical/184-message-box-send-routes.md). Send's action is left
 * unset for the main action, so it resolves when the draft is delivered.
 */
export type ComposerDeliveryRoute =
  | { kind: "send"; action?: "send" | "steer" }
  | { kind: "queue"; topicShift?: boolean }
  | {
      kind: "project-queue";
      newSession: boolean;
      newSessionTarget?: ChosenNewSessionQueueTarget;
    }
  | { kind: "fork-summary" }
  | { kind: "fork-without-summary" };

export type ComposerActionKind = "send" | "steer" | "queue";

/** The main action's route (Enter, Send, voice auto-send), fixed at the press. */
export function resolvePrimaryDeliveryRoute(state: {
  forkMode: boolean;
  primaryActionKind: ComposerActionKind;
}): ComposerDeliveryRoute {
  if (state.forkMode) return { kind: "fork-summary" };
  if (state.primaryActionKind === "queue") return { kind: "queue" };
  return { kind: "send" };
}

export interface ComposerDeliveryAvailability {
  disabled: boolean;
  forkMode: boolean;
  /** A fork already on its way; its buttons are disabled too. */
  forkSubmitting: boolean;
  forkWithoutSummary: boolean;
  /** Attachments plus uploads in progress. */
  nonTextContentCount: number;
  canQueue: boolean;
  canProjectQueue: boolean;
  canProjectQueueNewSession: boolean;
}

/**
 * Whether a route can deliver at all. Checked before a dictated draft is
 * set aside, so a press that cannot deliver changes nothing.
 */
export function canDeliverOnRoute(
  route: ComposerDeliveryRoute,
  state: ComposerDeliveryAvailability,
): boolean {
  if (state.disabled) return false;
  switch (route.kind) {
    case "fork-summary":
      return (
        state.forkMode &&
        !state.forkSubmitting &&
        state.nonTextContentCount === 0
      );
    case "fork-without-summary":
      return (
        state.forkWithoutSummary &&
        !state.forkSubmitting &&
        state.nonTextContentCount === 0
      );
    case "send":
      return !state.forkMode;
    case "queue":
      return !state.forkMode && state.canQueue;
    case "project-queue":
      return (
        !state.forkMode &&
        (route.newSession
          ? state.canProjectQueueNewSession
          : state.canProjectQueue)
      );
  }
}

/**
 * The question aside takes a `?` draft from the main send and from queue,
 * never from an explicit action, Project Queue or a fork.
 */
export function routeTriesQuestionAside(route: ComposerDeliveryRoute): boolean {
  return (
    (route.kind === "send" && route.action === undefined) ||
    route.kind === "queue"
  );
}

export interface ComposerDeliveryContext {
  attachmentCount: number;
  uploadCount: number;
  doneAvailable: boolean;
  bangAvailable: boolean;
  /** The main action now, for a send route without an explicit action. */
  primaryActionKind: ComposerActionKind;
  patientQueueEnabled: boolean;
  topicShiftSupported: boolean;
  topicShiftCompactPercent: number | undefined;
  patientQueueCompactPercent: number | undefined;
}

export type ComposerDeliveryPlan =
  | { kind: "ignore" }
  | { kind: "done" }
  | { kind: "bang"; command: string }
  | {
      kind: "deliver";
      /**
       * Without the speech prefix; trimmed, except for the no-summary
       * fork's verbatim turn.
       */
      text: string;
      /** Absent for the forks, which carry no metadata. */
      intent?: UserMessageDeliveryIntent;
      patientSource?: PatientQueueSource;
      compactAboveContextPercent?: number;
    };

function sendIntent(action: ComposerActionKind): UserMessageDeliveryIntent {
  if (action === "steer") return "steer";
  if (action === "queue") return "deferred";
  return "direct";
}

/** What one delivery does with the draft text, after availability. */
export function planComposerDelivery(
  route: ComposerDeliveryRoute,
  rawText: string,
  context: ComposerDeliveryContext,
): ComposerDeliveryPlan {
  if (route.kind === "fork-summary") {
    return { kind: "deliver", text: rawText.trim() };
  }
  // The fork topic sends the no-summary fork's next turn verbatim.
  if (route.kind === "fork-without-summary") {
    return { kind: "deliver", text: rawText };
  }

  let text = rawText.trimEnd();
  if (
    context.doneAvailable &&
    text.trim() === "/done" &&
    context.attachmentCount === 0 &&
    context.uploadCount === 0
  ) {
    return { kind: "done" };
  }
  if (context.bangAvailable) {
    const bang = resolveComposerBangDraft(text);
    if (bang.kind === "bang") return { kind: "bang", command: bang.command };
    // The bang commands topic: a bare `!!` is a silent no-op.
    if (bang.kind === "empty") return { kind: "ignore" };
    if (bang.kind === "escaped") text = bang.text;
  }
  if (!hasComposerDraftContent(text, context.attachmentCount)) {
    return { kind: "ignore" };
  }
  text = text.trim();

  if (route.kind === "send") {
    return {
      kind: "deliver",
      text,
      intent: sendIntent(route.action ?? context.primaryActionKind),
    };
  }
  if (route.kind === "project-queue") {
    return { kind: "deliver", text, intent: "deferred" };
  }
  const patientSource: PatientQueueSource | null = route.topicShift
    ? "topic-shift"
    : context.patientQueueEnabled
      ? "patient-default"
      : null;
  if (!patientSource) return { kind: "deliver", text, intent: "deferred" };
  if (!context.topicShiftSupported) {
    return { kind: "deliver", text, intent: "patient" };
  }
  const compactAboveContextPercent =
    patientSource === "topic-shift"
      ? context.topicShiftCompactPercent
      : context.patientQueueCompactPercent;
  return {
    kind: "deliver",
    text,
    intent: "patient",
    patientSource,
    ...(compactAboveContextPercent !== undefined
      ? { compactAboveContextPercent }
      : {}),
  };
}
