import {
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type RecapMode,
  SERVER_CAPABILITIES,
  type SessionSandboxLevel,
  type ShowThinking,
  type ThinkingMode,
  type ThinkingOption,
  type EffortLevel,
  type TurnEffort,
  isTurnEffort,
  serverHasCapability,
} from "@yep-anywhere/shared";
import type { SessionOptions } from "../api/client";
import type { MessageKey } from "../i18n";
import { requiresAttachmentOnlyServerUpdate } from "./attachmentSubmission";
import {
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "./effortLevels";
import { type LaunchLock, launchLockOverrides } from "./limitedLaunchLock";
import { toThinkingOption } from "./newSessionOptions";
import { selectableServiceTiers } from "./serviceTiers";
import { parseComposerSlashCommand } from "./slashCommands";
import { prependSpeechMessagePrefix } from "./speechMessagePrefix";
import type { PermissionMode } from "../types";

type ServerVersion = Parameters<typeof serverHasCapability>[0];
type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

const TURN_EFFORT_PROVIDERS = [
  "codex",
  "claude",
  "claude-gateway",
  "claude-ollama",
];

export type NewSessionStartPlan =
  | {
      kind: "refuse";
      toastKey:
        | "routerLaunchUnsupported"
        | "turnEffortUnavailable"
        | "turnEffortNeedsMessage"
        | "attachmentOnlyRequiresServerUpdate";
    }
  /** Not ready to start; a memo start throws `composerMemoCannotStart`. */
  | { kind: "silent"; throwCannotStart: boolean }
  | {
      kind: "proceed";
      /** The submitted text with its speech prefix and without a command. */
      text: string;
      hasCommand: boolean;
      metadata?: {
        deliveryIntent: "direct";
        turnEffort: TurnEffort;
      };
    };

/**
 * What a start does with the draft, after a pending dictation had its
 * chance to defer it: refuse with a toast, return without one, or go on with
 * the text to send. The refusals keep today's order.
 */
export function planNewSessionStart(input: {
  /** The draft or override, end-trimmed. */
  finalMessage: string;
  /** Files counted for content (the ref the start reads). */
  submissionFileCount: number;
  /** Files counted for the attachment-only refusal (the render's state). */
  pendingFileCount: number;
  speechPrefix: string | null;
  propagateFailure: boolean;
  routedSourceKey: string | null;
  sourceKey: string;
  routerCapable: boolean;
  launchLimited: boolean;
  effectiveSandboxLevel: SessionSandboxLevel;
  hasLaunch: boolean;
  composerMuted: boolean;
  creatingTemplateProject: boolean;
  templateProjectBusy: boolean;
  isStarting: boolean;
  displayDefaultsPending: boolean;
  hasSelectedProviderModel: boolean;
  projectPending: boolean;
  serverCapabilitiesPending: boolean;
  selectedProvider: ProviderName | null;
  version: ServerVersion;
}): NewSessionStartPlan {
  if (
    input.routedSourceKey !== null &&
    (input.routedSourceKey !== input.sourceKey ||
      !input.routerCapable ||
      input.launchLimited ||
      input.effectiveSandboxLevel !== "none" ||
      input.hasLaunch)
  ) {
    return { kind: "refuse", toastKey: "routerLaunchUnsupported" };
  }
  const { finalMessage } = input;
  const hasContent = finalMessage.trim() || input.submissionFileCount > 0;
  // A muted composer composes its own first turn, so an empty message is
  // not a reason to refuse the start.
  if (
    (!hasContent && !input.composerMuted) ||
    input.creatingTemplateProject ||
    input.templateProjectBusy ||
    input.isStarting ||
    input.displayDefaultsPending ||
    !input.hasSelectedProviderModel ||
    input.projectPending ||
    input.serverCapabilitiesPending
  ) {
    return { kind: "silent", throwCannotStart: input.propagateFailure };
  }
  let text =
    input.speechPrefix && hasContent
      ? prependSpeechMessagePrefix(finalMessage, input.speechPrefix)
      : finalMessage.trim();
  const command = parseComposerSlashCommand(text);
  const turnEffort =
    command && isTurnEffort(command.kind) ? command.kind : undefined;
  if (
    turnEffort &&
    (!serverHasCapability(
      input.version,
      SERVER_CAPABILITIES.turnEffortModifiers.name,
    ) ||
      input.hasLaunch ||
      !TURN_EFFORT_PROVIDERS.includes(input.selectedProvider ?? ""))
  ) {
    return { kind: "refuse", toastKey: "turnEffortUnavailable" };
  }
  if (turnEffort && command) {
    if (!command.argument.trim()) {
      return { kind: "refuse", toastKey: "turnEffortNeedsMessage" };
    }
    text = command.argument;
  }
  if (
    requiresAttachmentOnlyServerUpdate({
      version: input.version,
      text: finalMessage,
      attachmentCount: input.pendingFileCount,
    })
  ) {
    return { kind: "refuse", toastKey: "attachmentOnlyRequiresServerUpdate" };
  }
  return {
    kind: "proceed",
    text,
    hasCommand: Boolean(command),
    ...(turnEffort
      ? { metadata: { deliveryIntent: "direct" as const, turnEffort } }
      : {}),
  };
}

/** The router selection a start or a queued start sends. */
export function routerLaunchFields(input: {
  routed: { poolId?: string } | null;
  routerAccountId: string | undefined;
  routerPolicy: string | undefined;
  routerClaudeAiConnectors: boolean;
}): {
  routerAccountId?: string;
  routerPoolId?: string;
  routerPolicy?: string;
  routerClaudeAiConnectors?: true;
} {
  const { routed } = input;
  if (!routed) return {};
  return {
    ...(input.routerAccountId
      ? { routerAccountId: input.routerAccountId }
      : {}),
    ...(routed.poolId
      ? {
          routerPoolId: routed.poolId,
          ...(input.routerPolicy ? { routerPolicy: input.routerPolicy } : {}),
        }
      : {}),
    ...(input.routerClaudeAiConnectors
      ? { routerClaudeAiConnectors: true as const }
      : {}),
  };
}

/** The session options a start sends, with the lock's overrides last. */
export function buildNewSessionStartOptions(input: {
  creationProvenance: SessionOptions["creationProvenance"];
  supportsInstalledMachineControl: boolean;
  machineControlSelected: boolean;
  machineControlEligible: boolean;
  mode: PermissionMode;
  routed: { poolId?: string } | null;
  routedModel: string | undefined;
  selectedModel: string | null;
  routerCapable: boolean;
  routerAccountId: string | undefined;
  routerPolicy: string | undefined;
  routerClaudeAiConnectors: boolean;
  routerThinking: ThinkingOption;
  thinking: ThinkingOption;
  showThinking: ShowThinking;
  effectiveServiceTier: string | null;
  selectedProvider: ProviderName | null;
  supportsSessionSandboxing: boolean;
  effectiveSandboxLevel: SessionSandboxLevel;
  effectiveSandboxNetworkFirewall: boolean;
  recapMode: RecapMode;
  recapAfterSeconds: number;
  promptSuggestionMode: PromptSuggestionMode;
  helperSideModel: string;
  launchLock: LaunchLock;
}) {
  const { routed } = input;
  return {
    creationProvenance: input.creationProvenance,
    ...(input.supportsInstalledMachineControl
      ? {
          machineControl:
            input.machineControlSelected && input.machineControlEligible,
        }
      : {}),

    mode: input.mode,
    model: routed ? input.routedModel : input.selectedModel || undefined,
    ...(routed && input.routerCapable ? routerLaunchFields(input) : {}),
    thinking: routed ? input.routerThinking : input.thinking,
    showThinking: input.showThinking,
    ...(input.effectiveServiceTier
      ? { serviceTier: input.effectiveServiceTier }
      : {}),
    provider: input.selectedProvider ?? undefined,
    ...(input.supportsSessionSandboxing
      ? {
          sandboxLevel: input.effectiveSandboxLevel,
          ...(input.effectiveSandboxLevel === "project-write"
            ? {
                sandboxNetworkFirewall: input.effectiveSandboxNetworkFirewall,
              }
            : {}),
        }
      : {}),
    recapMode: input.recapMode,
    recapAfterSeconds: input.recapAfterSeconds,
    promptSuggestionMode: input.promptSuggestionMode,
    helperSideModel: input.helperSideModel,
    // Last word, so a submit that raced the acting-principal request
    // still launches inside the lock instead of being refused.
    ...launchLockOverrides(input.launchLock),
  };
}

/**
 * Project Queue's refusals before a pending dictation can defer the press: a
 * pool or account the server cannot queue or launch (never dropped, so the
 * item cannot run on the direct login), machine control (immediate launches
 * only), and a template being made.
 */
export function projectQueueRefusalBeforeDefer(input: {
  /** The shown router selection's source, restored or chosen; null for Direct. */
  routedSourceKey: string | null;
  sourceKey: string;
  routerCapable: boolean;
  queueRouterCapable: boolean;
  launchLimited: boolean;
  effectiveSandboxLevel: SessionSandboxLevel;
  machineControlSelected: boolean;
  machineControlEligible: boolean;
  creatingTemplateProject: boolean;
  templateProjectBusy: boolean;
}):
  | {
      kind: "refuse";
      toastKey: "routerQueueUnsupported" | "routerLaunchUnsupported";
    }
  | { kind: "silent" }
  | null {
  if (input.routedSourceKey !== null) {
    if (!input.queueRouterCapable) {
      return { kind: "refuse", toastKey: "routerQueueUnsupported" };
    }
    if (
      input.routedSourceKey !== input.sourceKey ||
      !input.routerCapable ||
      input.launchLimited ||
      input.effectiveSandboxLevel !== "none"
    ) {
      return { kind: "refuse", toastKey: "routerLaunchUnsupported" };
    }
  }
  if (input.machineControlSelected && input.machineControlEligible) {
    return { kind: "silent" };
  }
  if (input.creatingTemplateProject || input.templateProjectBusy) {
    return { kind: "silent" };
  }
  return null;
}

/**
 * Project Queue's text and readiness after the defer: the speech-prefixed
 * text, or null when the press returns without a toast.
 */
export function planNewSessionProjectQueue(input: {
  finalMessage: string;
  speechPrefix: string | null;
  submissionFileCount: number;
  stagedFileCount: number;
  isStarting: boolean;
  displayDefaultsPending: boolean;
  projectPending: boolean;
  /** The selected model is ready: direct, or routed once the pool restored. */
  hasSelectedProviderModel: boolean;
}): { text: string } | null {
  const rawTrimmedMessage = input.finalMessage.trim();
  const text = rawTrimmedMessage
    ? prependSpeechMessagePrefix(rawTrimmedMessage, input.speechPrefix)
    : rawTrimmedMessage;
  const canQueueAttachments =
    input.stagedFileCount === input.submissionFileCount;
  if (
    !text ||
    !canQueueAttachments ||
    input.isStarting ||
    input.displayDefaultsPending ||
    input.projectPending ||
    !input.hasSelectedProviderModel
  ) {
    return null;
  }
  return { text };
}

/**
 * The queued session's settings. A routed selection queues like a routed
 * start: its pool or account, with model, thinking and tier resolved against
 * the routed catalog; the router allocates the pin when the item dispatches.
 * Otherwise thinking, effort and tier resolve against the selected provider's
 * direct catalog.
 */
export function buildProjectQueueNewSessionTarget(input: {
  providerInfo: ProviderInfo | undefined;
  selectedProvider: ProviderName | null;
  selectedModel: string | null;
  selectedThinkingMode: ThinkingMode;
  selectedEffortLevel: EffortLevel;
  selectedServiceTier: string | null;
  mode: PermissionMode;
  showThinking: ShowThinking;
  supportsSessionSandboxing: boolean;
  effectiveSandboxLevel: SessionSandboxLevel;
  effectiveSandboxNetworkFirewall: boolean;
  launchLock: LaunchLock;
  title: string;
  t: Translate;
  routed?: { poolId?: string } | null;
  routedModel?: string;
  routerAccountId?: string;
  routerPolicy?: string;
  routerClaudeAiConnectors?: boolean;
  routerThinking?: ThinkingOption;
  /** The tier resolved against the routed catalog. */
  routedServiceTier?: string | null;
}) {
  const sandbox = input.supportsSessionSandboxing
    ? {
        sandboxLevel: input.effectiveSandboxLevel,
        ...(input.effectiveSandboxLevel === "project-write"
          ? {
              sandboxNetworkFirewall: input.effectiveSandboxNetworkFirewall,
            }
          : {}),
      }
    : {};
  if (input.routed && input.routerThinking) {
    const thinking = input.routerThinking;
    return {
      thinking,
      target: {
        type: "new-session" as const,
        mode: input.mode,
        model: input.routedModel,
        ...(input.routedServiceTier
          ? { serviceTier: input.routedServiceTier }
          : {}),
        thinking,
        showThinking: input.showThinking,
        provider: input.selectedProvider ?? undefined,
        ...routerLaunchFields({
          routed: input.routed,
          routerAccountId: input.routerAccountId,
          routerPolicy: input.routerPolicy,
          routerClaudeAiConnectors: input.routerClaudeAiConnectors === true,
        }),
        ...sandbox,
        title: input.title,
      },
    };
  }
  const directModel = input.providerInfo?.models?.find(
    (model) => model.id === input.selectedModel,
  );
  const directEffortOptions = getEffortLevelOptions({
    provider: input.providerInfo,
    model: directModel,
    translate: input.t,
  });
  const thinking = toThinkingOption(
    resolveSupportedThinkingMode(
      input.selectedThinkingMode,
      getThinkingModeOptions({
        provider: input.providerInfo,
        model: directModel,
        effortOptions: directEffortOptions,
      }),
    ),
    resolveSupportedEffortLevel(input.selectedEffortLevel, directEffortOptions),
  );
  const directServiceTier = selectableServiceTiers(
    directModel?.serviceTiers,
  ).find((tier) => tier.id === input.selectedServiceTier)?.id;
  return {
    thinking,
    target: {
      type: "new-session" as const,
      mode: input.mode,
      model: input.selectedModel ?? undefined,
      ...(directServiceTier ? { serviceTier: directServiceTier } : {}),
      thinking,
      showThinking: input.showThinking,
      provider: input.selectedProvider ?? undefined,
      ...sandbox,
      ...launchLockOverrides(input.launchLock),
      title: input.title,
    },
  };
}

/** The toast for a start that failed after it began. */
export function newSessionStartErrorMessage(
  err: unknown,
  selectedProvider: ProviderName | null,
  providerDisplayName: string | undefined,
  t: Translate,
): string {
  if (!(err instanceof Error)) return t("newSessionStartError");
  const displayName = providerDisplayName ?? selectedProvider ?? "Provider";
  const lowerMessage = err.message.toLowerCase();
  const status = (err as Error & { status?: number }).status;
  if (err.message.includes("Queue is full")) {
    return t("newSessionServerBusy");
  }
  if (
    lowerMessage.includes("invalid authentication credentials") ||
    lowerMessage.includes("authentication_error") ||
    lowerMessage.includes("please run /login") ||
    (status === 401 &&
      (selectedProvider === "claude" ||
        selectedProvider === "gemini" ||
        selectedProvider === "codex"))
  ) {
    return t("newSessionProviderAuthError", { provider: displayName });
  }
  if (err.message.includes("503")) return t("newSessionServerCapacity");
  if (err.message.includes("404")) return t("newSessionProjectNotFound");
  if (err.message.includes("fetch") || err.message.includes("network")) {
    return t("newSessionNetworkError");
  }
  return err.message;
}
